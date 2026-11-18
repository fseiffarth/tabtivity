import { create } from "zustand";

/**
 * Live connection state of a remote (SSH) project's two channels:
 *  - `off`        — not a remote project, or torn down / never opened
 *  - `connecting` — handshake in flight (orange lamp)
 *  - `connected`  — channel is up (green lamp)
 *  - `error`      — the attempt failed (red lamp)
 */
export type ConnState = "off" | "connecting" | "connected" | "error";

export interface HostConnState {
  ssh: ConnState;
  vpn: ConnState;
}

const OFF: HostConnState = { ssh: "off", vpn: "off" };

/** The backend id of a project's PRIMARY remote (`docs/multi_host_remote_plan.md`).
 *  Kept in step with `services::remote::PRIMARY_HOST`. */
export const PRIMARY_HOST = "primary";

interface RemoteStatusStore {
  /** PRIMARY-host status, keyed by project id. Kept as the flat, primary-only map
   *  it has always been so the ~300 file/git/sync readers that only ever care about
   *  the primary (the file UI stays Local | Remote(primary), plan §6) work
   *  unchanged. Keyed (not a single active slot) so an in-flight connect for a
   *  project the user just switched away from can never flip the now-active
   *  project's lamp — the header reads only the active id's entry. */
  byProject: Record<string, HostConnState>;
  /** Extra WORKER-host status (`docs/multi_host_remote_plan.md`), keyed
   *  `[projectId][hostId]`. The primary is NOT stored here — it lives in
   *  `byProject`; [`sshOf`]/[`vpnOf`] route `"primary"` to it. */
  byHost: Record<string, Record<string, HostConnState>>;
  /** Set a host's SSH lamp. `hostId` defaults to the primary. */
  setSsh: (projectId: string, state: ConnState, hostId?: string) => void;
  /** Set a host's VPN lamp. `hostId` defaults to the primary. */
  setVpn: (projectId: string, state: ConnState, hostId?: string) => void;
  /** Forget a project's status entirely — primary AND every worker host (on
   *  deactivation / switch-away). */
  clear: (projectId: string) => void;
  /** Forget one worker host's status (host removed / disconnected). */
  clearHost: (projectId: string, hostId: string) => void;
}

export const useRemoteStatusStore = create<RemoteStatusStore>((set) => ({
  byProject: {},
  byHost: {},
  setSsh: (projectId, state, hostId = PRIMARY_HOST) =>
    set((s) => setHostField(s, projectId, hostId, "ssh", state)),
  setVpn: (projectId, state, hostId = PRIMARY_HOST) =>
    set((s) => setHostField(s, projectId, hostId, "vpn", state)),
  clear: (projectId) =>
    set((s) => {
      const inProject = projectId in s.byProject;
      const inHost = projectId in s.byHost;
      if (!inProject && !inHost) return {};
      const byProject = { ...s.byProject };
      delete byProject[projectId];
      const byHost = { ...s.byHost };
      delete byHost[projectId];
      return { byProject, byHost };
    }),
  clearHost: (projectId, hostId) =>
    set((s) => {
      if (hostId === PRIMARY_HOST) {
        if (!(projectId in s.byProject)) return {};
        const byProject = { ...s.byProject };
        delete byProject[projectId];
        return { byProject };
      }
      const hosts = s.byHost[projectId];
      if (!hosts || !(hostId in hosts)) return {};
      const nextHosts = { ...hosts };
      delete nextHosts[hostId];
      const byHost = { ...s.byHost };
      if (Object.keys(nextHosts).length === 0) delete byHost[projectId];
      else byHost[projectId] = nextHosts;
      return { byHost };
    }),
}));

/** Immutably set one field of one host's lamp, routing the primary to `byProject`
 *  and any worker to `byHost[projectId][hostId]`. */
function setHostField(
  s: RemoteStatusStore,
  projectId: string,
  hostId: string,
  field: keyof HostConnState,
  value: ConnState,
): Partial<RemoteStatusStore> {
  if (hostId === PRIMARY_HOST) {
    const known = s.byProject[projectId];
    // A lamp already showing this is no news; a first "off" still is (it
    // settles a lamp nobody had read).
    if (known?.[field] === value) return {};
    const prev = known ?? OFF;
    return { byProject: { ...s.byProject, [projectId]: { ...prev, [field]: value } } };
  }
  const hosts = s.byHost[projectId] ?? {};
  if (hosts[hostId]?.[field] === value) return {};
  const prev = hosts[hostId] ?? OFF;
  return {
    byHost: {
      ...s.byHost,
      [projectId]: { ...hosts, [hostId]: { ...prev, [field]: value } },
    },
  };
}

/** Read a host's SSH lamp from a store snapshot (`"primary"` → `byProject`). */
export function sshOf(
  s: Pick<RemoteStatusStore, "byProject" | "byHost">,
  projectId: string,
  hostId: string = PRIMARY_HOST,
): ConnState {
  return hostStateOf(s, projectId, hostId).ssh;
}

/** Read a host's VPN lamp from a store snapshot (`"primary"` → `byProject`). */
export function vpnOf(
  s: Pick<RemoteStatusStore, "byProject" | "byHost">,
  projectId: string,
  hostId: string = PRIMARY_HOST,
): ConnState {
  return hostStateOf(s, projectId, hostId).vpn;
}

/** A host's full `{ssh, vpn}` from a store snapshot, or `{off, off}` when absent. */
export function hostStateOf(
  s: Pick<RemoteStatusStore, "byProject" | "byHost">,
  projectId: string,
  hostId: string = PRIMARY_HOST,
): HostConnState {
  if (hostId === PRIMARY_HOST) return s.byProject[projectId] ?? OFF;
  return s.byHost[projectId]?.[hostId] ?? OFF;
}
