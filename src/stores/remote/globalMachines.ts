import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ConnState } from "./remoteStatus";
import type { GlobalMachine, MachineImportEntry } from "../../types";
import { syncGlobalDisconnected } from "../../lib/remote/machineSync";
import { useHostBusyStore } from "./hostBusy";
import { withHostKeyConfirm } from "../../lib/remote/hostKey";
import { mayAutoTouch } from "../../lib/remote/hpc/hpcHost";
import { useSettingsStore } from "../settings";

/** Per-machine outcome of a bulk import (`importMachines`): whether the shared
 *  credentials authenticated against that host. The machine is added to the list
 *  either way — a failed connect just leaves its lamp red to retry, mirroring
 *  `probeAll`, rather than silently dropping the row. */
export interface ImportResult {
  host: string;
  label?: string;
  ok: boolean;
}

/**
 * Globally connected worker machines — the VPN-tunnel pattern applied to SSH
 * hosts: authenticated once via the ordinary login mechanism
 * (`ssh_connect`), with no `remote_path`, so a machine is not tied to any one
 * project. Later dragged onto a project (`MachinesIndicator`'s rows are the
 * drag source) to become a `shared_fs` compute host there.
 *
 * Unlike `vpnStatus.ts`, there is no backend liveness registry to reconcile
 * against on focus: `ssh_connect` only *verifies* auth (it warms the shared
 * OpenSSH ControlMaster opportunistically but does not create/persist one —
 * see `ssh_common::ssh_base_args`'s `ControlMaster=no`), it doesn't leave a
 * pooled session running the way a project's `remote_connect` does. So
 * `status` here is set only by the explicit actions that open or end a session —
 * `add`/`register`/`connect`/`disconnect` — never polled, and pointedly **not**
 * by the `probeAll` sweep (see `reachable`).
 */
interface GlobalMachinesStore {
  machines: GlobalMachine[];
  /** Per-machine id; absent = "off". **"A session this app opened"**, never "the
   *  host answered" — that is `reachable`. The distinction is load-bearing:
   *  `lib/remote/machineSync` propagates a machine's `connected` onto the project that
   *  holds the same host and opens its pool, so a lamp lit by a mere probe would
   *  claim a session nothing ever opened. Written only by `add`/`register`/
   *  `connect`/`disconnect`. */
  status: Record<string, ConnState>;
  /** Per-machine id: the last `probeAll` answer — `true` = "the host answered and
   *  authenticated our credential" (not a session, and never to be mistaken for
   *  one), `false` = "genuinely off the network" (`ssh_probe.unreachable`). Absent
   *  = never probed **or** last probed a host that answered but rejected our
   *  credential-less probe — a password-only host we hold no key/saved password
   *  for is not "down", and scoring it `false` painted a connected session `stale`
   *  (red). Kept beside `status` rather than folded into it so the row can say
   *  "up, but not connected" instead of lying in either direction. */
  reachable: Record<string, boolean>;
  /** Per-machine id: the message from the last failed `connect`/`update`, so a
   *  red lamp is never just "error" with no way to tell why — an unknown host
   *  key, a rejected password, a network timeout, and a keychain that couldn't
   *  be read all fail differently and the backend already says which. Cleared
   *  on the next successful connect for that machine; left in place across a
   *  probe (`probeAll` only ever *reads* reachability, it never explains a
   *  failure) so it survives until the next real attempt. */
  errors: Record<string, string>;
  loaded: boolean;
  /** Why the last load failed; the machines shown are then the last good copy. */
  loadError: string | null;

  load: () => Promise<void>;
  add: (m: {
    user?: string;
    host: string;
    port?: number;
    label?: string;
    password?: string;
    remember?: boolean;
  }) => Promise<GlobalMachine>;
  /** Surface an **already-connected** host in the list without re-authenticating
   *  — the caller (e.g. the HPC wizard) has just run `ssh_connect` itself, so
   *  this only persists the identity (`global_machine_add`, idempotent by target)
   *  and marks the lamp connected. The counterpart to `add`, which owns the
   *  connect. Returns the registered (or pre-existing) machine, or `undefined` on
   *  a persist failure — registration must never break the flow that connected. */
  register: (m: {
    user?: string;
    host: string;
    port?: number;
    label?: string;
  }) => Promise<GlobalMachine | undefined>;
  /**
   * Edit an existing machine's connection identity (`user`/`host`/`port`/`label`)
   * via `global_machine_update`, then — when `connect` is set — re-authenticate the
   * (possibly new) target with the given password, updating the lamp. The SSH
   * password isn't stored on the machine, so a password change is applied only by
   * that connect: `remember: true` saves it to the keychain, `undefined`/`null`
   * leaves any existing saved credential untouched. Never pass `false` from an
   * edit — that would *clear* a saved password the user didn't mean to drop
   * (`remote_credentials::Remember::Clear`). Throws if the update itself fails
   * (validation / address collision) so the form can surface it; a failed connect
   * only reddens the lamp.
   */
  update: (
    id: string,
    fields: { user?: string; host: string; port?: number; label?: string },
    opts?: { password?: string; remember?: boolean; connect?: boolean },
  ) => Promise<void>;
  /** Remove a machine from the list — **actively disconnecting it first** if it
   *  is live (see the implementation). Detaching it from any project it was also
   *  added to is deliberately NOT part of this: a project host is a copy by
   *  value, with its own path and its own lifetime. */
  remove: (id: string) => Promise<void>;
  /** Connect one machine. `background` marks the call as *unattended* (the launch /
   *  VPN-up sweep) rather than a row the user clicked — the backend's dial policy
   *  refuses an unattended dial to a host tagged HPC. Omitted = a gesture. */
  connect: (id: string, password?: string, opts?: { background?: boolean }) => Promise<void>;
  /** Actively disconnect a machine: **end every running tmux job** on it and
   *  close any live SSH master, then reset the lamp to "off". This is an
   *  explicit user action ONLY — persistent tmux sessions are meant to outlive a
   *  relaunch, and this is the one path that deliberately kills them (the
   *  backend `remote_kill_all_jobs` never runs on restart). Both backend steps
   *  are best-effort (a machine with nothing running / no master is a no-op);
   *  the lamp is cleared regardless. */
  disconnect: (id: string) => Promise<void>;
  /** Persist a new machine order given the desired id list — the reorder drag
   *  computes the live-preview order (drop can land before *or* after any row,
   *  including past the last one), this commits it. Applies client-side first
   *  (mirrors `stores::projects`' `reorderProjects`), then persists. There's no
   *  separate position field: array order in `global_machines.json` *is* the
   *  order. */
  reorder: (orderedIds: string[]) => Promise<void>;
  /** Read-only reachability sweep (`ssh_probe`, no keychain writes) — call when
   *  the header menu opens, mirroring `VpnIndicator`'s per-config silent check.
   *  Writes `reachable` (and `errors`) ONLY, never `status`: a probe is not a
   *  session. Skips HPC-tagged machines — this menu opens on hover and `ssh_probe`
   *  is a real authenticated login, not a ping. */
  probeAll: () => Promise<void>;
  /** Fleet-wide (re)connect: attempt `connect` on every machine not already
   *  connected/connecting, concurrently, each with any saved credential. A host
   *  that needs a password we don't hold just reddens its lamp to retry
   *  individually (no per-host prompt is possible from a bulk action) — mirroring
   *  `importMachines`. Idempotent for already-connected rows. */
  retryAll: () => Promise<void>;
  /** Fleet-wide active disconnect: `disconnect` (end tmux jobs + close master)
   *  every machine currently connected, concurrently. Off/error rows are skipped.
   *  Explicit user action only — same contract as the per-row `disconnect`. */
  disconnectAll: () => Promise<void>;
  /** Arm/disarm a machine for silent auto-connect on launch / VPN-up. */
  setAutoConnect: (id: string, enabled: boolean) => Promise<void>;
  /**
   * Silently connect every machine armed with `auto_connect` — the launch-time
   * and VPN-up sweep. Mirrors a project's `autoConnectPrimary`: it **probes
   * first** (`ssh_probe`, read-only) and only calls `connect` when the host is
   * reachable, so it never prompts and a machine that can't connect silently
   * (offline, or a saved password since forgotten) degrades to staying off
   * rather than turning red or opening a modal at startup. Idempotent: skips a
   * machine already connected or connecting.
   */
  autoConnect: () => Promise<void>;
  /** Write the given machines (by id, in the passed order) to a shareable JSON
   *  file at `path`. Thin pass-through to `global_machines_export` — host/port/
   *  label only, never a username or password (see `commands::global_machines`).
   *  The path comes from a native save dialog. */
  exportMachines: (ids: string[], path: string) => Promise<void>;
  /**
   * Connect + add a batch of imported machines with **one shared credential**.
   * For each entry: `ssh_connect` with the shared user/password (an entry may
   * pin its own `user`, which wins), then `global_machine_add` **regardless** of
   * whether that connect succeeded — a machine that fails to authenticate is
   * still registered with a red lamp to retry (mirrors `probeAll`), never
   * silently dropped. Runs sequentially so the concurrent `global_machine_add`
   * writes can't race `global_machines.json`. Returns a per-host outcome list.
   *
   * `autoConnect` arms every imported row for the launch/VPN-up sweep in the same
   * pass (`setAutoConnect`), so a bulk import doesn't leave the user ticking the
   * per-row toggle N times. Arming is safe regardless of how the connect went: the
   * sweep probes first, so a machine that can't connect silently (no saved
   * password, host away) just stays dark.
   */
  importMachines: (
    entries: MachineImportEntry[],
    opts: { user?: string; password?: string; remember?: boolean; autoConnect?: boolean },
  ) => Promise<ImportResult[]>;
  setStatus: (id: string, status: ConnState) => void;
}

/** Latest `load` — an answer from an older one is dropped. */
let loadSeq = 0;

export const useGlobalMachinesStore = create<GlobalMachinesStore>((set, get) => ({
  machines: [],
  status: {},
  reachable: {},
  errors: {},
  loaded: false,
  loadError: null,

  load: async () => {
    const seq = ++loadSeq;
    let list: GlobalMachine[];
    try {
      list = await invoke<GlobalMachine[]>("global_machines_list");
    } catch (error) {
      // A failed read is not "no machines": keep what is shown.
      if (seq === loadSeq) set({ loadError: String(error instanceof Error ? error.message : error) });
      return;
    }
    if (seq !== loadSeq) return;
    // A command that resolves to nothing must not leave `machines`
    // non-iterable, since every consumer maps over it.
    set({ machines: Array.isArray(list) ? list : [], loaded: true, loadError: null });
  },

  add: async ({ user, host, port, label, password, remember }) => {
    // First contact: show the host key's fingerprint before the password is sent.
    await withHostKeyConfirm(() =>
      invoke("ssh_connect", {
        user,
        host,
        port,
        password,
        // Adding a machine is a form the user filled in and submitted. Without
        // this the dial policy's background default refuses it outright on a host
        // they tagged HPC — i.e. a tagged cluster could not be added at all.
        background: false,
        // Only `true` (save) or `null` (leave alone) — the same rule `update` states
        // at length. A raw `false` is `Remember::Clear`, which DELETES the keychain
        // entry, and this call has just authenticated with it: an unticked box on an
        // ordinary add would destroy a password saved by an earlier one. Only an
        // explicit forget may clear a credential.
        remember: remember ? true : null,
      }),
    );
    const machine = await invoke<GlobalMachine>("global_machine_add", { user, host, port, label });
    // The lamp is the propagation trigger: `lib/remote/machineSync`'s subscription reflects
    // this onto any project that already holds the host. Nothing is called by hand
    // here — that is exactly how `register` and the probe sweep ended up propagating
    // nothing at all.
    set((s) => ({
      machines: [...s.machines, machine],
      status: { ...s.status, [machine.id]: "connected" },
    }));
    return machine;
  },

  register: async ({ user, host, port, label }) => {
    // No `ssh_connect` here — the caller already authenticated this host. Persist
    // is idempotent by target (backend `global_machine_add`), so a repeat call for
    // the same host returns the existing row; reconcile it into the list either
    // way and light the lamp.
    const machine = await invoke<GlobalMachine>("global_machine_add", { user, host, port, label }).catch(
      () => null,
    );
    if (!machine) return undefined;
    set((s) => ({
      machines: s.machines.some((m) => m.id === machine.id) ? s.machines : [...s.machines, machine],
      status: { ...s.status, [machine.id]: "connected" },
    }));
    return machine;
  },

  update: async (id, { user, host, port, label }, opts) => {
    // Let a failed update (validation / collision) propagate so the form shows it.
    const list = await invoke<GlobalMachine[]>("global_machine_update", {
      id,
      user,
      host,
      port,
      label,
    });
    set({ machines: list });
    if (!opts?.connect) return;
    set((s) => ({ status: { ...s.status, [id]: "connecting" } }));
    try {
      await withHostKeyConfirm(() =>
        invoke("ssh_connect", {
          user,
          host,
          port,
          password: opts.password || null,
          // Only `true` (save) or `null` (leave) — never `false`, which would clear
          // a credential the edit didn't intend to drop.
          remember: opts.remember ? true : null,
          // An edit-and-reconnect is a gesture, same as `add` above.
          background: false,
        }),
      );
      set((s) => {
        const errors = { ...s.errors };
        delete errors[id];
        return { status: { ...s.status, [id]: "connected" }, errors };
      });
    } catch (e) {
      set((s) => ({ status: { ...s.status, [id]: "error" }, errors: { ...s.errors, [id]: String(e) } }));
    }
  },

  remove: async (id) => {
    // Removing a machine ENDS it. Dropping the row while its SSH master (and any
    // tmux job under it) stayed up would leave a live connection nothing in the
    // UI still points at — unkillable, since the only handle on it was the row
    // being deleted. So a live machine gets the same active disconnect its own
    // ⏻ performs, and for the same reason its confirm names the jobs it kills.
    // Gated on the lamp: an `off`/`error` row has no session, and
    // `remote_kill_all_jobs` on it would dial the host just to find nothing.
    const live = get().status[id];
    if (live === "connected" || live === "connecting") await get().disconnect(id);
    const list = await invoke<GlobalMachine[]>("global_machine_remove", { id }).catch(() => null);
    if (!list) return;
    set((s) => {
      const status = { ...s.status };
      delete status[id];
      const reachable = { ...s.reachable };
      delete reachable[id];
      const errors = { ...s.errors };
      delete errors[id];
      return { machines: list, status, reachable, errors };
    });
  },

  connect: async (id, password, opts) => {
    const m = get().machines.find((x) => x.id === id);
    if (!m) return;
    set((s) => ({ status: { ...s.status, [id]: "connecting" } }));
    try {
      await withHostKeyConfirm(() =>
        invoke("ssh_connect", {
          user: m.user,
          host: m.host,
          port: m.port,
          password,
          remember: null,
          // A credential-less `ssh_connect` is ambiguous to the backend's dial policy
          // — it is either a row the user clicked or the launch sweep — so this path
          // has to say which. It defaults to the gesture, because that is the only
          // caller a tagged HPC machine has left: the sweep passes `background` and
          // is refused, by design, on both sides.
          background: opts?.background === true,
        }),
      );
      set((s) => {
        const errors = { ...s.errors };
        delete errors[id];
        // Propagation onto a project holding this host rides the lamp itself
        // (`lib/remote/machineSync`'s subscription), not a call from here.
        return { status: { ...s.status, [id]: "connected" }, errors };
      });
    } catch (e) {
      set((s) => ({ status: { ...s.status, [id]: "error" }, errors: { ...s.errors, [id]: String(e) } }));
    }
  },

  disconnect: async (id) => {
    const m = get().machines.find((x) => x.id === id);
    if (!m) return;
    // Clear the lamp first — the kill + master-close are best-effort and must
    // not leave the row stuck on "connected" if the host is momentarily away.
    set((s) => ({ status: { ...s.status, [id]: "off" } }));
    // Mirror onto any project holding this host: tear the active project's pool
    // and drop every matching lamp before the machine's own teardown runs.
    syncGlobalDisconnected(m);
    // This is the one path that deliberately ENDS every tmux session on the host,
    // so the cached busy reading is now a lie. Drop it, or the lamp would keep
    // pulsing for work this very call killed (the reading is only re-probed when
    // a menu opens, so nothing else would correct it).
    useHostBusyStore.getState().clear(m);
    const target = { user: m.user, host: m.host, port: m.port };
    await invoke("remote_kill_all_jobs", target).catch(() => {});
    await invoke("ssh_close_master", target).catch(() => {});
  },

  reorder: async (orderedIds) => {
    const before = get().machines;
    const byId = new Map(before.map((m) => [m.id, m]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as GlobalMachine[];
    // Guard against a stale/partial id list: only commit a full permutation.
    if (reordered.length !== before.length) return;
    if (reordered.every((m, i) => m.id === before[i].id)) return; // no-op drop
    set({ machines: reordered });
    const list = await invoke<GlobalMachine[]>("global_machine_reorder", {
      ids: orderedIds,
    }).catch(() => null);
    if (list) set({ machines: list });
  },

  probeAll: async () => {
    // Never sweep a tagged cluster. This menu opens on *hover*, and `ssh_probe` is
    // a real authenticated login rather than a ping — a fleet sweep that includes a
    // login node dials it every time the pointer crosses the header, which is the
    // unattended presence the tag exists to stop. Fail-closed while settings load.
    const settings = useSettingsStore.getState().settings;
    const machines = get().machines.filter((m) =>
      mayAutoTouch(settings, { user: m.user, host: m.host, port: m.port }),
    );
    const results = await Promise.all(
      machines.map((m) =>
        invoke<{ ok: boolean; unreachable: boolean; error: string }>("ssh_probe", {
          user: m.user,
          host: m.host,
          port: m.port,
        })
          .then((r) => [m.id, r.ok, r.unreachable, r.error] as const)
          // A rejected task is not the host telling us it is off the network, so
          // it is NOT `unreachable`: fall into the answered-but-unconfirmed lane
          // rather than scoring the host down.
          .catch((e) => [m.id, false, false, String(e)] as const),
      ),
    );
    // The sweep writes `reachable`, NEVER `status`. A probe says the host answered;
    // `status` says this app holds a session on it, and `lib/remote/machineSync` acts on
    // the second — opening the pool of a project that holds the same host. Folding
    // the first into the second is what lit a machine green off a hover while every
    // project holding it stayed unconnected, with nothing to propagate.
    set((s) => {
      // Three outcomes, not two — `ssh_probe`'s `unreachable` is the distinction the
      // old `reachable = ok` collapse threw away, and that collapse was a bug: a
      // password-only host that ANSWERS but rejects our credential-less probe
      // (nothing saved, no key, no ControlMaster to ride — the ordinary Raspberry-Pi
      // shape) failed the probe and was recorded identically to a host that is off
      // the network. That `reachable: false` then painted a *connected* session as
      // `stale` (red, `MachinesIndicator`'s `rowStateOf`) and a reachable host as
      // down — a machine you are logged into in a terminal, shown red.
      //
      //   ok           → reachable = true  (answered AND authenticated us)
      //   unreachable  → reachable = false (genuinely off the network)
      //   answered/!ok → leave `reachable` alone: a held session stays green, an
      //                  un-probed row stays "not checked", and no error is filed —
      //                  "we have no credential to probe with" is not a failure the
      //                  user can act on from this row, and pinning it under a green
      //                  lamp reads as a broken connection that is not broken.
      const reachable = { ...s.reachable };
      let changedReach = false;
      // `ssh_probe` carries the reason it could not reach a host — captured the same
      // way `connect` does, so a menu-open sweep explains a red lamp as well as a
      // manual retry would, instead of throwing the text away. Only for the genuinely
      // unreachable, per the lanes above.
      const errors = { ...s.errors };
      let changedErrors = false;
      for (const [id, ok, unreachable, err] of results) {
        if (ok) {
          if (reachable[id] !== true) {
            reachable[id] = true;
            changedReach = true;
          }
          if (errors[id] !== undefined) {
            delete errors[id];
            changedErrors = true;
          }
        } else if (unreachable) {
          if (reachable[id] !== false) {
            reachable[id] = false;
            changedReach = true;
          }
          if (err && errors[id] !== err) {
            errors[id] = err;
            changedErrors = true;
          }
        }
      }
      // Same idempotence rule as `setStatus`: a sweep that changed nothing must not
      // notify. This one writes EVERY machine at once, so on a fleet of N an
      // unchanged sweep used to invalidate the whole list and re-render the header
      // beneath it.
      if (!changedReach && !changedErrors) return s;
      return {
        reachable: changedReach ? reachable : s.reachable,
        errors: changedErrors ? errors : s.errors,
      };
    });
  },

  retryAll: async () => {
    const { machines, status, connect } = get();
    // "Retry everything" is a gesture at the fleet, not at any one login node: a
    // tagged cluster is left out and stays connectable from its own row's button,
    // which IS a gesture at it.
    const settings = useSettingsStore.getState().settings;
    await Promise.all(
      machines.map((m) => {
        if (!mayAutoTouch(settings, { user: m.user, host: m.host, port: m.port }))
          return Promise.resolve();
        const st = status[m.id] ?? "off";
        if (st === "connected" || st === "connecting") return Promise.resolve();
        return connect(m.id);
      }),
    );
  },

  disconnectAll: async () => {
    const { machines, status, disconnect } = get();
    await Promise.all(
      machines.map((m) =>
        (status[m.id] ?? "off") === "connected" ? disconnect(m.id) : Promise.resolve(),
      ),
    );
  },

  setAutoConnect: async (id, enabled) => {
    try {
      const list = await invoke<GlobalMachine[]>("global_machine_set_auto_connect", {
        id,
        enabled,
      });
      set({ machines: list });
    } catch (e) {
      // A swallowed persist failure is worse here than elsewhere: the toggle springs
      // back on the next render with nothing said, so the user believes a machine is
      // armed for launch when it isn't. Same `errors` map a failed connect writes, so
      // the row already has somewhere to show it.
      set((s) => ({ errors: { ...s.errors, [id]: `auto-connect not saved: ${String(e)}` } }));
    }
  },

  autoConnect: async () => {
    // A machine tagged HPC is never in the launch/VPN-up sweep, whatever its own
    // auto-connect toggle says (the toggle is disabled for one, but an older
    // settings file can carry both). An SSH master opened on a shared login node
    // because an app started is exactly the unattended presence the tag exists to
    // stop; connecting by hand is untouched. `mayAutoTouch` is the shared authority
    // for that question, and it also fails closed while settings are still loading —
    // the exact window this launch sweep runs in.
    const settings = useSettingsStore.getState().settings;
    const machines = get()
      .machines.filter((m) => m.auto_connect)
      .filter((m) => mayAutoTouch(settings, { user: m.user, host: m.host, port: m.port }));
    await Promise.all(
      machines.map(async (m) => {
        const st = get().status[m.id] ?? "off";
        if (st === "connected" || st === "connecting") return;
        // Probe is the silent-connect gate: an `ok` probe means `ssh_connect` will
        // succeed with no prompt (key/agent/saved-password). On anything else leave
        // the lamp untouched — a stale opt-in must stay dark, never flash red or ask.
        const reachable = await invoke<{ ok: boolean }>("ssh_probe", {
          user: m.user,
          host: m.host,
          port: m.port,
          background: true,
        })
          .then((r) => r.ok)
          .catch(() => false);
        if (!reachable) return;
        await get().connect(m.id, undefined, { background: true });
      }),
    );
  },

  exportMachines: async (ids, path) => {
    await invoke("global_machines_export", { ids, path });
  },

  importMachines: async (entries, { user, password, remember, autoConnect }) => {
    const results: ImportResult[] = [];
    // Sequential on purpose: each `global_machine_add` rewrites the whole
    // `global_machines.json`, so parallel adds would clobber each other's writes.
    for (const entry of entries) {
      const effUser = entry.user || user || undefined;
      let ok = true;
      try {
        // Deliberately NOT wrapped in `withHostKeyConfirm`: this is a bulk loop, and
        // one fingerprint modal per imported machine would be a wall of prompts. An
        // unknown host simply fails here and lands as a red row, whose Connect button
        // asks the question once, for the one machine the user actually wants.
        await invoke("ssh_connect", {
          user: effUser,
          host: entry.host,
          port: entry.port,
          password: password || null,
          // The user picked a file and pressed Import — a gesture, even though it is
          // a bulk one, so a tagged host in the file is still importable by hand.
          background: false,
          // `true` or `null`, never the raw flag: an unticked "Save password" on an
          // import used to arrive as `false` = `Remember::Clear` and DELETE whatever
          // was already saved for each host it walked — with the credential it had
          // just authenticated with. Only an explicit forget clears one.
          remember: remember ? true : null,
        });
      } catch {
        ok = false;
      }
      // Add even on a failed connect — the row stays with a red lamp to retry.
      const machine = await invoke<GlobalMachine>("global_machine_add", {
        user: effUser,
        host: entry.host,
        port: entry.port,
        label: entry.label,
      }).catch(() => null);
      if (machine) {
        set((s) => {
          const exists = s.machines.some((m) => m.id === machine.id);
          return {
            machines: exists
              ? s.machines.map((m) => (m.id === machine.id ? machine : m))
              : [...s.machines, machine],
            status: { ...s.status, [machine.id]: ok ? "connected" : "error" },
          };
        });
        // Arm the launch/VPN-up sweep in the same pass. Only ever *enables* —
        // a re-import of a host already in the list must not silently disarm a
        // toggle the user set by hand. Never on a tagged cluster: both by-hand add
        // paths already refuse to arm one, and a bulk import must not be the hole
        // that writes the flag the sweep then has to filter back out.
        if (
          autoConnect &&
          mayAutoTouch(useSettingsStore.getState().settings, {
            user: effUser,
            host: entry.host,
            port: entry.port,
          })
        )
          await get().setAutoConnect(machine.id, true);
      }
      results.push({ host: entry.host, label: entry.label, ok });
    }
    return results;
  },

  // Writing a lamp the value it already has must NOT notify. Rebuilding
  // `status` unconditionally allocated a new object every call, and zustand
  // notifies on identity — so a no-op write woke every subscriber of this store.
  // `MachinesIndicator` alone holds fourteen selectors against it, so one no-op
  // re-ran all fourteen and re-rendered the header, which re-rendered the pills,
  // the file panel and the tree beneath them. Measured: 64 `status` writes per
  // 10 s driving ~140 full commits per 10 s on an idle app, with the main thread
  // stalling ~300-400 ms in every window. Returning `s` unchanged makes zustand's
  // `Object.is` check collapse the write into nothing.
  setStatus: (id, status) =>
    set((s) => (s.status[id] === status ? s : { status: { ...s.status, [id]: status } })),
}));
