import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { targetKey, type Target } from "../../lib/remote/machineSync";
import { mayAutoTouch } from "../../lib/remote/hpc/hpcHost";
import { useSettingsStore } from "../settings";
import { PRIMARY_HOST } from "./remoteStatus";

/**
 * Which hosts are **actually being worked on**, as opposed to merely connected.
 *
 * A green `ConnLamp` says only that a host authenticates — with a fleet of
 * machines held open all day (one pooled ControlMaster apiece, kept alive by
 * `ServerAliveInterval` and nothing else) that is the *steady* state, so it can
 * no longer answer "where am I running something?". The busy reading answers
 * that, and the lamp pulses green for it.
 *
 * **Busy = the host has ≥1 live tmux session.** That is the right signal
 * precisely because of the tmux contract (TODO #85): a run is decoupled from the
 * ssh channel that started it, so a session outliving its tab, a Tabtivity
 * relaunch, or a VPN drop is exactly the work that would otherwise be invisible.
 * A *detached* session counts — a training run nobody is watching is still a
 * training run. A foreign session (one Tabtivity never started) counts too: the
 * question is what the machine is doing, not what Tabtivity launched.
 *
 * **Keyed by SSH target, never by id.** A global machine (`stores/remote/globalMachines`)
 * and the project host it also is (a primary `remote` or a `compute_hosts`
 * worker) are copies by value with different ids — `lib/remote/machineSync` already
 * establishes that `user@host:port` is the only bridge between them. Keying on
 * `targetKey` means one probe of a machine lights it in the header, on every
 * project pill that holds it, and in the Remote-machines hub, with no second
 * round trip and no chance of the three disagreeing.
 *
 * **Probed on demand only — never polled.** Each probe is one SSH round trip per
 * host, and a fleet of sixteen would otherwise mean sixteen `tmux ls`es a minute
 * forever, for a reading nobody is looking at. So a surface that *shows* the
 * pulse sweeps when it opens (`MachinesIndicator`'s menu, `RemoteMachinesWindow`)
 * and the always-visible pill lamps render the **cached** result of whichever
 * sweep last ran. The cache is therefore a last-known reading, not live truth —
 * which is why `staleAfterMs` exists and why a disconnect clears it: a lamp
 * pulsing for a machine that finished an hour ago is worse than one not pulsing.
 */

/** How long a reading stays trustworthy enough to pulse a lamp nobody re-probed.
 *  Past this, the cached count is ignored (the lamp goes back to steady green)
 *  rather than shown as current. Ten minutes matches `ControlPersist`. */
const STALE_AFTER_MS = 10 * 60 * 1000;

interface Reading {
  /** Number of live tmux sessions on the host at `at`. */
  sessions: number;
  /** Session names, for the lamp's tooltip. */
  names: string[];
  /** `Date.now()` of the probe. */
  at: number;
}

interface HostBusyStore {
  /** `targetKey(target)` → last reading. */
  readings: Record<string, Reading>;
  /** Targets with a probe in flight, so a re-open can't stack round trips. */
  inFlight: Record<string, true>;

  /** Probe one **global machine** (no project → ad-hoc auth). Skipped entirely on
   *  an HPC-tagged host — see the implementation. */
  probeGlobal: (target: Target) => Promise<void>;
  /** Probe one **project host**, riding that project's pooled ControlMaster. */
  probeProjectHost: (projectId: string, hostId: string, target: Target) => Promise<void>;
  /** Forget a host's reading — call on an explicit disconnect, whose whole point
   *  is that it ended every session. Leaving the stale count would keep the lamp
   *  pulsing for work that was just killed. */
  clear: (target: Target) => void;
}

/** Fold a probe result into the store, or drop the in-flight mark on failure.
 *  A failed probe deliberately leaves any previous reading alone: an unreachable
 *  host is an SSH-status problem, and the *connection* lamp already says so. */
function commit(
  set: (fn: (s: HostBusyStore) => Partial<HostBusyStore>) => void,
  key: string,
  names: string[] | null,
) {
  set((s) => {
    const inFlight = { ...s.inFlight };
    delete inFlight[key];
    if (!names) return { inFlight };
    return {
      inFlight,
      readings: { ...s.readings, [key]: { sessions: names.length, names, at: Date.now() } },
    };
  });
}

interface TmuxSessionRow {
  name: string;
  windows: number;
  created: number;
  attached: boolean;
}

export const useHostBusyStore = create<HostBusyStore>((set, get) => ({
  readings: {},
  inFlight: {},

  probeGlobal: async (target) => {
    // Not on a tagged cluster. Unlike `probeProjectHost`, which rides a pool the
    // user opened, this authenticates ad-hoc — and its caller is a sweep over the
    // whole machine list run from a menu that opens on *hover*. A `tmux ls` is
    // cheap; an unasked-for login on a shared login node, every time the pointer
    // crosses the header, is not. The cost is that a tagged machine never pulses;
    // the Sessions view is where its running work is read instead.
    if (!mayAutoTouch(useSettingsStore.getState().settings, target)) return;
    const key = targetKey(target);
    if (get().inFlight[key]) return;
    set((s) => ({ inFlight: { ...s.inFlight, [key]: true } }));
    const rows = await invoke<TmuxSessionRow[]>("global_machine_tmux_list", {
      user: target.user,
      host: target.host,
      port: target.port,
    }).catch(() => null);
    commit(set, key, rows ? rows.map((r) => r.name) : null);
  },

  probeProjectHost: async (projectId, hostId, target) => {
    const key = targetKey(target);
    if (get().inFlight[key]) return;
    set((s) => ({ inFlight: { ...s.inFlight, [key]: true } }));
    const rows = await invoke<TmuxSessionRow[]>("remote_tmux_list", {
      projectId,
      hostId: hostId === PRIMARY_HOST ? null : hostId,
    }).catch(() => null);
    commit(set, key, rows ? rows.map((r) => r.name) : null);
  },

  clear: (target) => {
    const key = targetKey(target);
    set((s) => {
      const readings = { ...s.readings };
      delete readings[key];
      return { readings };
    });
  },
}));

/** The live reading for a target, or `null` when there is none or it has gone
 *  stale. Read this rather than `readings[key]` directly — the staleness gate is
 *  what stops a lamp pulsing for a run that ended while nobody looked. */
export function busyReading(
  state: Pick<HostBusyStore, "readings">,
  target: Target | undefined,
  staleAfterMs = STALE_AFTER_MS,
): Reading | null {
  if (!target?.host) return null;
  const r = state.readings[targetKey(target)];
  if (!r || r.sessions === 0) return null;
  return Date.now() - r.at > staleAfterMs ? null : r;
}

/** Whether a host should pulse. A host that isn't `connected` never pulses: the
 *  reading is by definition from before it dropped. */
export function isBusy(
  state: Pick<HostBusyStore, "readings">,
  target: Target | undefined,
  connected: boolean,
): boolean {
  return connected && busyReading(state, target) !== null;
}

/** The lamp tooltip for a busy host — "2 sessions running: build, train". */
export function busyLabel(reading: Reading): string {
  const n = reading.sessions;
  return `${n} session${n === 1 ? "" : "s"} running: ${reading.names.join(", ")}`;
}
