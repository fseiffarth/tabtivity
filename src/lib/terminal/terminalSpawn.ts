import { effectiveTabLocation, remoteHostIdOf, type TabEntry } from "../../stores/tabs";

/** The inputs a terminal's spawn depends on — `TerminalView`'s spawn effect
 *  deps, which a change of respawns the PTY. */
export interface TerminalSpawnInputs {
  id: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  cwd: string;
  localOnly?: boolean;
  projectId?: string | null;
  remoteHostId?: string | null;
  sandbox?: boolean;
  tmuxSession?: string | null;
  tmuxAttach?: string | null;
  hostBoundUid?: string | null;
  hostSession?: boolean;
  kind?: string;
  scheduleTargetId?: string;
  relaunchSeq?: number;
  zoomable?: boolean;
}

/**
 * One string for a terminal's spawn identity, normalised the way
 * `TerminalView` defaults its props: equal keys mean a mounted pane would
 * have kept its PTY across the change, different keys mean it would have
 * respawned it. The pane layer compares it while a pane sleeps (a change
 * wakes it) and the waking view compares it with the parked one.
 */
export function terminalSpawnKey(p: TerminalSpawnInputs): string {
  return JSON.stringify([
    p.id,
    p.cmd,
    p.args ?? [],
    p.env ?? {},
    p.initialInput ?? null,
    p.cwd,
    !!p.localOnly,
    p.projectId ?? null,
    p.remoteHostId ?? null,
    !!p.sandbox,
    p.tmuxSession ?? null,
    p.tmuxAttach ?? null,
    p.hostBoundUid ?? null,
    !!p.hostSession,
    p.kind ?? null,
    p.scheduleTargetId ?? null,
    p.relaunchSeq ?? 0,
    !!p.zoomable,
  ]);
}

/**
 * The spawn inputs of a tab's `TerminalView`, as the shared pane switch
 * (`TabPane`) hands them over — one mapping, so the pane layer's sleep check
 * and the view compute the same {@link terminalSpawnKey}. `terminalCwd`,
 * `sandbox` and `tmuxSession` are the host window's derivation (`PaneSlot`);
 * a popout is attach-only and takes no initial input.
 */
export function tabTerminalSpawn(
  tab: TabEntry,
  scope: string,
  derived: {
    terminalCwd: string;
    sandbox?: boolean;
    tmuxSession?: string;
    vmProject?: boolean;
    attachOnly?: boolean;
  },
) {
  const location = effectiveTabLocation(tab, { vmProject: !!derived.vmProject });
  return {
    // PTY ids include the scope: tab keys alone collide across projects.
    id: `${scope}:${tab.key}`,
    cmd: tab.cmd,
    args: tab.args ?? [],
    env: tab.env ?? {},
    // A popout is attach-only and never spawns, and its `terminal-ready`
    // never fires, so it takes no initialInput (matches its old behavior).
    initialInput: derived.attachOnly ? undefined : tab.initialInput,
    cwd: derived.terminalCwd,
    localOnly: location === "local",
    projectId: scope === "root" ? null : scope,
    // Multi-host: the worker id (or "primary") this tab runs on, so the
    // backend resolves the right host's RemoteSpec (null for a local tab).
    remoteHostId: remoteHostIdOf(location),
    sandbox: !!derived.sandbox,
    // Persistent remote session (TODO #85). An explicit attach (opened from
    // the Sessions view) wins over the tab's own persistent session.
    tmuxSession: derived.tmuxSession ?? null,
    tmuxAttach: tab.tmuxAttach ?? null,
    hostBoundUid: tab.hostBoundUid ?? null,
    hostSession: !!tab.hostSession,
    kind: tab.kind,
    scheduleTargetId: tab.scheduleTargetId,
    relaunchSeq: tab.relaunchSeq ?? 0,
    zoomable: tab.kind === "agent" || tab.kind === "local_agent",
  };
}
