import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useSettingsStore } from "../../stores/settings";
import { mayAutoTouch } from "./hpc/hpcHost";
import {
  useRemoteStatusStore,
  hostStateOf,
  PRIMARY_HOST,
  type ConnState,
} from "../../stores/remote/remoteStatus";

/**
 * Keep a **global machine** (`stores/remote/globalMachines`, header "Machines") and the
 * **project host** it also is (a project's primary `remote` or a `compute_hosts`
 * worker) in step, so connecting/disconnecting one reflects on the other.
 *
 * The two are never linked by id — a global machine dropped onto a project is
 * copied by *value* — so the only bridge is the **SSH target** (`user@host:port`).
 * `sameTarget` is that bridge, and the whole module keys off it.
 *
 * The physical connection really *is* shared (one OpenSSH ControlMaster per host
 * target), so "sync" is mostly reconciling the two separate status stores rather
 * than opening a second socket. Two rules keep it from looping or lying:
 *
 *  - **Global → project** is driven from **one** place: a subscription on the
 *    global store's `status`, which by contract only ever moves on a *real
 *    session* (`add`/`register`/`connect`/`disconnect` — `probeAll` writes
 *    `reachable`, never `status`). It used to hang off two hand-placed calls in
 *    `add` and `connect`, which is why `register` and the probe sweep propagated
 *    nothing and a machine could sit green in the header while the project holding
 *    the very same host stayed unconnected. One subscription cannot forget a path.
 *    Only the **active** project's pool is opened; an inactive one is left alone
 *    entirely (see `syncGlobalConnected` for why a mirrored lamp is worse than no
 *    lamp). Disconnect stays imperative — it is a teardown with an ordering
 *    (mirror first, kill jobs after), not a state a subscriber can reconstruct.
 *  - **Project → global** is a *subscription* (`initMachineSync`) that only ever
 *    *upgrades* a matching machine's lamp to `connected` — a project deactivating
 *    (which clears its lamps) must never knock an independently-connected machine
 *    offline, so `off` is deliberately not propagated upward.
 *
 * No loop: the global store's `setStatus` never touches `remoteStatus`, so the
 * subscription can't re-enter the imperative path.
 */

export interface Target {
  user?: string;
  host: string;
  port?: number;
}

function norm(t: Target): { user: string | undefined; host: string; port: number } {
  return {
    user: t.user && t.user.trim() ? t.user.trim() : undefined,
    host: t.host.trim().toLowerCase(),
    // A host with no explicit port and one pinned to 22 are the same machine.
    port: t.port ?? 22,
  };
}

/** Whether two SSH targets are the same machine+login (host case-insensitive,
 *  default port 22, empty user ≡ absent). A different login on the same host is a
 *  *different* connection, so `user` is matched strictly. */
export function sameTarget(a: Target, b: Target): boolean {
  const x = norm(a);
  const y = norm(b);
  return x.host === y.host && x.port === y.port && x.user === y.user;
}

/** The canonical string form of an SSH target — `sameTarget` as a map key, so a
 *  store can index by machine identity without an id. Two targets share a key iff
 *  `sameTarget` holds for them, which is what lets a global machine and the
 *  project host that *is* it (copied by value, different ids) share one entry. */
export function targetKey(t: Target): string {
  const n = norm(t);
  return `${n.user ?? ""}@${n.host}:${n.port}`;
}

/**
 * Whether a global machine **armed** for auto-connect is this host — which makes
 * it count as the host's own `auto_connect` (gate 2 of
 * `docs/context/remote_autoconnect.md`) on every project path in `stores/projects`
 * (`autoConnectPrimary`/`autoConnectWorker`, `silentReconnectDeadHost`,
 * `retryAutoConnectAfterVpn`). Those paths stay the one route by which a project
 * host is reconnected; this only answers their opt-in question.
 *
 * Armed, not merely `connected`. The toggle is the machine-wide twin of
 * `RemoteSpec.auto_connect` — the same durable "connect this login without asking"
 * — so it can stand in for it. A machine's `connected` lamp is not an opt-in: it is
 * never polled, so it outlives the session it names, and treating it as one would
 * hand the dead-host reconciler exactly the endless re-dial of a host the user only
 * ever connected by hand that gate 2 exists to stop. A hand-connected machine still
 * reaches the active project on its own `→ connected` edge (`syncGlobalConnected`:
 * a fresh master, an event rather than a standing claim).
 *
 * Off while the Machines feature is off: a feature that is off connects nothing
 * (`remoteAutoReconnect`'s `machineSweep`), and an armed row the user can no longer
 * see must not keep dialling projects either. HPC tags are not checked here — every
 * caller applies `mayAutoTouch` to the host itself.
 */
export function machineArmsHost(target: Target): boolean {
  if (!useSettingsStore.getState().settings?.machines_enabled) return false;
  return useGlobalMachinesStore
    .getState()
    .machines.some((m) => m.auto_connect === true && sameTarget(m, target));
}

interface ProjectHostRef {
  projectId: string;
  hostId: string;
  target: Target;
}

/** Every project host (primary + workers) whose SSH target matches `target`. */
function projectHostsMatching(target: Target): ProjectHostRef[] {
  const { projects } = useProjectsStore.getState();
  const out: ProjectHostRef[] = [];
  for (const p of projects) {
    if (p.remote && sameTarget(p.remote, target)) {
      out.push({ projectId: p.id, hostId: PRIMARY_HOST, target: p.remote });
    }
    for (const h of p.compute_hosts ?? []) {
      if (sameTarget(h, target)) out.push({ projectId: p.id, hostId: h.id, target: h });
    }
  }
  return out;
}

// `viaLogin` is unconditional here and says what this function *is*: the machine was
// authenticated in the header's Machines list, and this connect only succeeds because
// it rides the master that left behind. Without it the backend reads the missing
// password as key/agent auth and stamps `key_auth: true` on a password host, which
// then advertises a promptless auto-connect it cannot deliver (`record_key_auth`).
function remoteConnectArgs(ref: ProjectHostRef): Record<string, unknown> {
  return ref.hostId === PRIMARY_HOST
    ? { projectId: ref.projectId, password: null, viaLogin: true }
    : { projectId: ref.projectId, hostId: ref.hostId, password: null, viaLogin: true };
}

/**
 * A global machine gained a **real session** — open the matching pool on the
 * ACTIVE project, if it holds the same host and is allowed to be reached.
 *
 * Two things it deliberately does *not* do.
 *
 * **It never mirrors a lamp onto an inactive project.** That used to write
 * `"connected"` with no pool behind it, and a green lamp with no session is worse
 * than no lamp twice over: the whole app reads it as "a pooled session is open"
 * (`useRemoteBlocked`, `holdRemoteTerminal`, the tmux/slurm/workspace probes all
 * un-gate on it and then dispatch at a session that isn't there), and it *blocks*
 * the connect that would have made it true — `autoConnectPrimary` only proceeds
 * from `"off"`, and this function skips anything already `"connected"`. An
 * inactive project is left at `off` and opens its pool on activation, exactly as
 * it always did.
 *
 * **It never opens a pool on a host tagged HPC.** `remote_connect` raises a
 * `ControlPersist=600` master — a standing presence on a shared login node — and
 * "because another surface authenticated the same host" is not a gesture against
 * *this* project. Connecting it by hand is one click away and untouched.
 *
 * This is the machine's *edge* only. Activation, a dead pool and the launch /
 * tunnel-up sweep reach a project host through the project path alone, where an
 * armed machine counts as the host's opt-in (`machineArmsHost`).
 */
export function syncGlobalConnected(target: Target): void {
  const { activeId } = useProjectsStore.getState();
  const settings = useSettingsStore.getState().settings;
  for (const ref of projectHostsMatching(target)) {
    if (ref.projectId !== activeId) continue;
    if (!mayAutoTouch(settings, ref.target)) continue;
    const status = useRemoteStatusStore.getState();
    const cur = hostStateOf(status, ref.projectId, ref.hostId).ssh;
    if (cur === "connected" || cur === "connecting") continue;
    status.setSsh(ref.projectId, "connecting", ref.hostId);
    void invoke("remote_connect", remoteConnectArgs(ref))
      .then(() => useRemoteStatusStore.getState().setSsh(ref.projectId, "connected", ref.hostId))
      .catch(() => useRemoteStatusStore.getState().setSsh(ref.projectId, "error", ref.hostId));
  }
}

/** A global machine actively disconnected (jobs ended, master closed) — tear the
 *  matching pool on the active project and drop every matching lamp to `off`. */
export function syncGlobalDisconnected(target: Target): void {
  const { activeId } = useProjectsStore.getState();
  for (const ref of projectHostsMatching(target)) {
    if (ref.projectId === activeId) {
      const t = ref.target;
      void invoke("remote_kill_all_jobs", { user: t.user, host: t.host, port: t.port }).catch(
        () => {},
      );
      void invoke("remote_disconnect", {
        projectId: ref.projectId,
        hostId: ref.hostId,
      }).catch(() => {});
    }
    useRemoteStatusStore.getState().setSsh(ref.projectId, "off", ref.hostId);
  }
}

/** Upgrade any global machine to `connected` when a project host with the same
 *  target is connected. Never downgrades — a machine's lamp is its own, and a
 *  project deactivating must not knock it offline. */
function reconcileGlobalsFromProjects(): void {
  const gm = useGlobalMachinesStore.getState();
  const status = useRemoteStatusStore.getState();
  for (const m of gm.machines) {
    const cur: ConnState = gm.status[m.id] ?? "off";
    if (cur === "connected") continue;
    const anyConnected = projectHostsMatching(m).some(
      (ref) => hostStateOf(status, ref.projectId, ref.hostId).ssh === "connected",
    );
    if (anyConnected) gm.setStatus(m.id, "connected");
  }
}

let inited = false;

/**
 * Install both lamp mirrors. Idempotent; call once at startup (`AppShell`).
 *
 * The global → project direction is a subscription rather than a call in each
 * action because "which action connected it" is not the question — *that a real
 * session now exists* is, and `status` in the global store means exactly that
 * (the probe sweep writes `reachable`). Every future path that opens a session
 * gets the propagation for free; the two hand-placed calls this replaces had
 * already missed `register` and the sweep.
 *
 * Still no loop. The chain global-status → `syncGlobalConnected` → `remoteStatus`
 * → `reconcileGlobalsFromProjects` → `setStatus("connected")` dead-ends twice
 * over: `setStatus` collapses a write of the value already there, and a second
 * pass of `syncGlobalConnected` finds the project lamp `connected` and returns
 * without touching anything.
 */
export function initMachineSync(): void {
  if (inited) return;
  inited = true;
  useRemoteStatusStore.subscribe(() => reconcileGlobalsFromProjects());
  useGlobalMachinesStore.subscribe((state, prev) => {
    for (const m of state.machines) {
      const now = state.status[m.id] ?? "off";
      if (now !== "connected" || (prev.status[m.id] ?? "off") === "connected") continue;
      syncGlobalConnected(m);
    }
  });
}
