import { memo } from "react";
import { TabPane } from "../tabs/TabPane";
import {
  effectiveTabLocation,
  isRelaunchableLocalTab,
  isResumableAgentTab,
  isSavedWhileLive,
  isPtyTabKind,
  localTabCwd,
  remoteHostIdOf,
  type TabEntry,
} from "../../stores/tabs";
import type { HostConnState } from "../../stores/remote/remoteStatus";
import { shouldPersistTab, shouldPersistLocalTab } from "../../lib/terminal/tmuxSession";
import { resolveLocalMirror, resolveProjectDirectory, type ProjectBox, type ProjectEntry } from "../../types";
import { MOBILE_ACCESS_KEY } from "../../lib/brand";

export interface PaneSlotProps {
  tab: TabEntry;
  /** The owning scope key ("root", a project id or a box scope). */
  scopeKey: string;
  /** The current-scope group this tab sits in; undefined for another scope's tab. */
  groupId: string | undefined;
  visible: boolean;
  focused: boolean;
  /** The pane's own project (not the active one): panes stay mounted across
   *  scope switches, so every remote/mirror/sandbox decision keys off this. */
  paneProject: ProjectEntry | undefined;
  /** The pane's box, when the scope is a box scope. */
  paneBox: ProjectBox | undefined;
  /** The pane project's PRIMARY-host SSH lamp. */
  projectSsh: HostConnState["ssh"] | undefined;
  /** The pane project's WORKER-host lamps (multi-host remote), keyed by host id. */
  hostSsh: Record<string, HostConnState> | undefined;
  /** `persist_local_sessions` folded with the platform (no tmux on Windows). */
  localPersistEnabled: boolean;
  onConnect: () => void;
  /** Shared, mutable, keyed `<scope>/<tabKey>`: whether a local agent tab was
   *  first seen while Mobile access was on (see CenterPanel). Never replaced. */
  mobileAgentTmuxReady: Map<string, boolean>;
}

/**
 * One slot of CenterPanel's flat pane layer: the per-tab derivation that turns
 * a `TabEntry` plus its project's state into `TabPane`'s props. Memoised so the
 * layer's many store subscriptions (every `groupRects` measure, a tab change in
 * another scope, a focus move) re-run the derivation only for the slots whose
 * inputs changed — with sixty tabs open, every `projects.find`/`localTabCwd`/
 * `effectiveTabLocation` pass used to run for all of them on each of those.
 * The positioned `.center-pane` box stays in the layer (a rect change moves
 * boxes without touching a slot); this component is what a sleeping-tab
 * substitute (`SleepingPane`, plan §5.3) replaces the body of.
 */
function PaneSlotImpl({
  tab,
  scopeKey,
  groupId,
  visible,
  focused,
  paneProject,
  paneBox,
  projectSsh,
  hostSsh,
  localPersistEnabled,
  onConnect,
  mobileAgentTmuxReady,
}: PaneSlotProps) {
  // Mount-free remote, per-pane gating. A remote project's LOCAL panes run on
  // the mirror and work offline; only remote-I/O panes must wait for the pool.
  // Keyed by THIS pane's scope (not the active project) so a disconnected
  // remote project switched away from never un-holds.
  const paneRemoteProj = !!paneProject?.remote;
  const paneDisconnected = paneRemoteProj && projectSsh !== "connected";
  const vmProject = !!paneProject?.vm?.enabled;
  // A terminal pane runs on a remote host when its effective locality resolves
  // to one (primary or a worker). Held while THAT host's pool is down: spawning
  // `ssh -tt` now would block on the dead pool. Multi-host: a pane on gpu-2
  // holds iff gpu-2 is down, independent of the primary (plan §4.5).
  const location = effectiveTabLocation(tab, { vmProject });
  const rawHostId = remoteHostIdOf(location);
  // A tab naming a worker that no longer exists (machine removed) falls back
  // to the primary — matching the backend's wrap_pty_options (plan §8).
  const paneHostId =
    rawHostId && rawHostId !== "primary" &&
    !paneProject?.compute_hosts?.some((h) => h.id === rawHostId)
      ? "primary"
      : rawHostId;
  const paneHostSsh =
    paneHostId === "primary"
      ? projectSsh
      : paneHostId
        ? hostSsh?.[paneHostId]?.ssh
        : undefined;
  const holdRemoteTerminal =
    paneRemoteProj &&
    isPtyTabKind(tab.kind) &&
    paneHostId !== null &&
    paneHostSsh !== "connected";
  // The label of the host this pane runs on (primary host, or the worker's
  // label), for the hold placeholder + hover card.
  const paneHostLabel =
    paneHostId === "primary" || paneHostId === null
      ? (paneProject?.remote?.host ?? "")
      : (() => {
          const w = paneProject?.compute_hosts?.find((h) => h.id === paneHostId);
          return w?.label || w?.host || paneHostId;
        })();
  const projectDirectory = resolveProjectDirectory(paneProject);
  const mirror = resolveLocalMirror(paneProject);
  // The Files-tab browse dir: while a remote project is disconnected the SFTP
  // tree can't be listed (it would freeze the main thread), so browse the local
  // mirror instead — the same synced working copy the local tabs use.
  // FileBrowser re-lists on `projectDir` change, so it swaps back to the remote
  // tree once the pool connects. (Resolved here, not inside TabPane, because
  // the popout has no projects store to resolve it.)
  const filesProjectDir = paneDisconnected
    ? localTabCwd(
        { kind: "files" },
        { isRemoteProject: true, projectDirectory, mirror, fallback: tab.cwd },
      )
    : tab.cwd;
  // SSH-sync Phase 0: a local-on-remote tab runs in the project's local mirror
  // (state dir), not the remote tree it can't reach.
  const terminalCwd = localTabCwd(tab, {
    isRemoteProject: paneRemoteProj,
    projectDirectory,
    mirror,
    fallback: tab.cwd,
  });
  // Run this tab inside the project's session container when the toggle is
  // on: every PTY tab except `local_agent` (host-bound) execs into the one
  // shared container. Local projects only. Derived here so restored tabs are
  // covered too. NOTE: this flag is in TerminalView's spawn deps — flipping the
  // toggle respawns every live tab (ProjectPill confirms when that would
  // destroy a non-resumable agent conversation).
  //
  // `scope: "agents"` narrows it to agent tabs, leaving shells (and the
  // viewer's Run/Debug, which IS a shell tab) on the host. This mirrors
  // `services::sandbox::resolve_spawn_authority`, which re-derives the same
  // answer from the trusted project record and remains the authority — the
  // copy is here for the two things only the renderer can do: keep a live
  // shell from staying inside the container after the scope changes (the flag
  // is a spawn dep, so the change respawns exactly the affected tabs), and
  // avoid claiming a container the backend is about to take away.
  const containerScope = paneProject?.sandbox?.scope ?? "all";
  const sandbox =
    (tab.kind === "agent" || tab.kind === "shell") &&
    (containerScope === "all" || tab.kind === "agent") &&
    scopeKey !== "root" &&
    !!paneProject?.sandbox?.enabled &&
    !paneProject?.remote;
  // Persistent sessions (TODO #85): the stable, persisted session name to wrap
  // a shell/script tab in a tmux session, so a long run survives — for a
  // REMOTE tab an SSH drop / relaunch (default ON per project, opt out via the
  // pill toggle), for a LOCAL tab a Tabtivity crash (default ON on Unix via
  // `persist_local_sessions`). Remote shell/script AND remote agent tabs
  // (`shouldPersistTab`; the agent's process reattaches, composing with its
  // own `--resume`); local persistence stays shell-only
  // (`shouldPersistLocalTab`); never the root scope. In TerminalView's spawn
  // deps, so toggling respawns the tab. Undefined ⇒ no tmux wrap.
  const localRunning = !paneRemoteProj || location === "local";
  // A box scope's Mobile switch (#31aa) plays the project's part here: an
  // agent tab of the box gets tmux underneath it — the one thing that makes
  // it attachable from the phone — by the box's own switch.
  const mobileReadyKey = `${scopeKey}/${tab.key}`;
  if (!mobileAgentTmuxReady.has(mobileReadyKey)) {
    mobileAgentTmuxReady.set(
      mobileReadyKey,
      !!paneProject?.[MOBILE_ACCESS_KEY] || !!paneBox?.[MOBILE_ACCESS_KEY],
    );
  }
  const tmuxSession =
    shouldPersistTab(tab.kind, paneHostId, paneProject?.remote, tab.ephemeral) ||
    shouldPersistLocalTab(
      tab.kind,
      scopeKey,
      localRunning,
      localPersistEnabled,
      mobileAgentTmuxReady.get(mobileReadyKey) === true,
      isResumableAgentTab(tab) || isRelaunchableLocalTab(tab) || isSavedWhileLive(tab),
    )
      ? tab.tmuxSession
      : undefined;
  return (
    /* The shared per-tab render switch (`components/tabs/TabPane`), the SAME
       one every detached popout renders. The main window owns the projects
       store, so it resolves the mirror/sandbox/hold props the popout can't.
       New pane kinds/props go in TabPane so they reach both windows at once. */
    <TabPane
      tab={tab}
      scope={scopeKey}
      visible={visible}
      focused={focused}
      groupId={groupId}
      onConnect={onConnect}
      holdRemoteTerminal={holdRemoteTerminal}
      remoteHost={paneHostLabel}
      filesProjectDir={filesProjectDir}
      terminalCwd={terminalCwd}
      sandbox={sandbox}
      tmuxSession={tmuxSession}
      vmProject={vmProject}
    />
  );
}

export const PaneSlot = memo(PaneSlotImpl);
