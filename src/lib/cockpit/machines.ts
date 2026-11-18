import type { ConnState } from "../../stores/remote/remoteStatus";

/**
 * The Machines view's machine list model (`docs/cockpit_declutter_plan.md`): one
 * row per machine. A project's hosts (the primary and its compute hosts) and the
 * global machines merge, keyed by host name. Pure; the caller reads the stores
 * (the lamps are theirs, nothing is probed here).
 */

/** One host of one project, as the caller read it. */
export interface MachineProjectHost {
  projectId: string;
  projectName: string;
  /** `PRIMARY_HOST` or a compute host id. */
  hostId: string;
  /** The machine's network name (what merges with a global machine of the same name). */
  host: string;
  /** What to call it when no global machine names it: the host's label or name. */
  label: string;
  /** This project's own SSH state to it. */
  ssh: ConnState;
  /** Live tmux sessions the sessions store last read for this host. */
  sessions: number;
  /** Where the project's shells run, as a name — only on its primary host. */
  runHost?: string;
}

export interface GlobalMachineInput {
  id: string;
  host: string;
  label?: string;
  ssh: ConnState;
}

/** A project using a machine: a chip with a small dot for its own state. */
export interface MachineProject {
  projectId: string;
  name: string;
  hostId: string;
  ssh: ConnState;
  runHost?: string;
}

export interface MachineRow {
  /** The lower-cased host name the sources merged on. */
  key: string;
  name: string;
  /** The global machine behind it, if any. */
  globalId?: string;
  lamp: ConnState;
  sessions: number;
  projects: MachineProject[];
  /** The projects that are not connected to it: what Connect would open. */
  disconnected: MachineProject[];
}

const SEVERITY: Record<ConnState, number> = { error: 3, connecting: 2, off: 1, connected: 0 };

/** The merge key: a host name compared case-insensitively. */
export const machineKey = (host: string): string => host.trim().toLowerCase();

/**
 * The lamp a row shows: the global machine's own status when the host is a
 * global machine, else connected if any project session is connected, else the
 * worst state among them (error, then connecting, then off).
 */
export function machineLamp(global: ConnState | undefined, projectStates: readonly ConnState[]): ConnState {
  if (global) return global;
  if (projectStates.includes("connected")) return "connected";
  return projectStates.reduce<ConnState>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), "off");
}

/** The rows, ordered by name (so the list does not reshuffle as lamps change). */
export function buildMachineRows(hosts: readonly MachineProjectHost[], globals: readonly GlobalMachineInput[]): MachineRow[] {
  const rows = new Map<string, { name: string; globalId?: string; globalSsh?: ConnState; sessions: number; projects: MachineProject[] }>();
  const at = (key: string, name: string) => {
    let row = rows.get(key);
    if (!row) {
      row = { name, sessions: 0, projects: [] };
      rows.set(key, row);
    }
    return row;
  };
  for (const g of globals) {
    const row = at(machineKey(g.host), g.label || g.host);
    row.name = g.label || g.host;
    row.globalId = g.id;
    row.globalSsh = g.ssh;
  }
  for (const h of hosts) {
    const row = at(machineKey(h.host || h.label), h.label || h.host);
    row.sessions += h.sessions;
    // The same project can reach a machine as two hosts; one chip, the better state.
    const known = row.projects.find((p) => p.projectId === h.projectId);
    if (known) {
      if (SEVERITY[h.ssh] < SEVERITY[known.ssh]) known.ssh = h.ssh;
      known.runHost ??= h.runHost;
    } else {
      row.projects.push({ projectId: h.projectId, name: h.projectName, hostId: h.hostId, ssh: h.ssh, runHost: h.runHost });
    }
  }
  return [...rows.entries()]
    .map(([key, row]): MachineRow => ({
      key,
      name: row.name,
      globalId: row.globalId,
      lamp: machineLamp(row.globalSsh, row.projects.map((p) => p.ssh)),
      sessions: row.sessions,
      projects: row.projects,
      disconnected: row.projects.filter((p) => p.ssh !== "connected"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a row of the Machines view says about its machine: a session state
 * (`ConnState`) or, for a global machine, the honest read from both of its maps
 * (`header/MachinesIndicator`'s `RowState`: a probe answer is not a session).
 */
export type MachineState = ConnState | "stale" | "reachable" | "unreachable" | "unknown";

/** The view's groups, in the order they are listed. */
export type MachineGroup = "connected" | "connecting" | "failed" | "up" | "off";
export const MACHINE_GROUPS: readonly MachineGroup[] = ["connected", "connecting", "failed", "up", "off"];

const GROUP_OF: Record<MachineState, MachineGroup> = {
  connected: "connected",
  connecting: "connecting",
  error: "failed",
  // A session we opened on a host that stopped answering: it needs a look.
  stale: "failed",
  reachable: "up",
  unreachable: "off",
  unknown: "off",
  off: "off",
};

export const machineGroupOf = (state: MachineState): MachineGroup => GROUP_OF[state];

/** Sorted by state (`MACHINE_GROUPS`' order), then by name. */
export function sortByStateThenName<T extends { group: MachineGroup; name: string }>(rows: readonly T[]): T[] {
  const rank = (g: MachineGroup) => MACHINE_GROUPS.indexOf(g);
  return [...rows].sort((a, b) => rank(a.group) - rank(b.group) || a.name.localeCompare(b.name));
}

/** Idle: off, and no project uses it — folded into one strip of names. */
export const isIdleMachine = (row: { group: MachineGroup; projects: readonly unknown[] }): boolean =>
  row.group === "off" && row.projects.length === 0;

/** The view's filter box: a machine's name, its address, or a project using it. */
export function machineMatches(row: { name: string; target?: string; projects: readonly { name: string }[] }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.target ?? "", ...row.projects.map((p) => p.name)].some((s) => s.toLowerCase().includes(q));
}
