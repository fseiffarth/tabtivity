import { memo } from "react";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { ProjectFilesTab } from "../files/ProjectFilesTab";
import { EmbedPane } from "../embed/EmbedPane";
import { FileViewerPane } from "../embed/FileViewerPane";
import { ProjectBlobPane } from "../common/ProjectBlobPane";
import { NetworkTrafficPane } from "../monitoring/NetworkTrafficPane";
import { SystemMonitorPane } from "../monitoring/SystemMonitorPane";
import { DiskUsagePane } from "../monitoring/DiskUsagePane";
import { CalendarPane } from "../calendar/CalendarPane";
import { BrowserPane } from "../browser/BrowserPane";
import { PrintManagerPane } from "../printing/PrintManagerPane";
import { SkillsLibraryTab } from "../skills/SkillsLibraryTab";
import { PromptChartTab } from "../agents/PromptChartTab";
import { RemotePaneHold } from "../projects/RemotePaneHold";
import { HostSessionHold } from "./HostSessionHold";
import { PaneTabContext } from "./paneTabContext";
import { effectiveTabLocation, remoteHostIdOf, type TabEntry } from "../../stores/tabs";

/**
 * The single per-tab `kind → pane` render switch, shared by the main window
 * (`CenterPanel`) and every detached popout (`DetachedCenterPanel`). Both windows
 * are separate React roots in separate JS heaps, so this used to be TWO
 * hand-maintained switches that silently drifted — a new pane kind or prop added
 * to one was routinely forgotten in the other (that is the whole class of "works
 * in the main window, dead in a popout" bugs). Keeping it here means a new pane
 * kind or prop lands in both windows at once.
 *
 * Everything that GENUINELY differs between the two windows is lifted into a
 * prop the HOST computes, because a popout is inert to the `projects`/`tabs`
 * stores and can't derive it:
 *  - `attachOnly` — a popout's terminals attach to the main window's PTY, never
 *    spawn (so all the terminal spawn inputs below are cosmetic there).
 *  - (There used to be an `ownsTabs` here, gating whether a pane could retitle
 *    its tab or open new ones: a popout ran on a streamed copy with no write
 *    channel back. Group B #231/#239 built that channel — a popout's tabs-store
 *    writes are forwarded to the main window by the seam in
 *    `stores/detachedContext` — so every window may now write tab state, and the
 *    props below are passed unconditionally. Without it a popped-out editor lost
 *    its scroll, zoom and Python breakpoints at every relaunch, a popped-out
 *    Files tab forgot the folder it was browsing, and a popped-out browser tab
 *    forgot its title and address.)
 *  - `filesProjectDir` / `terminalCwd` / `sandbox` / `holdRemoteTerminal` /
 *    `onConnect` — all resolved from the projects store, which the popout lacks.
 *
 * Values that are computed IDENTICALLY from the tab alone in both windows
 * (`projectId` from the scope, `localOnly`, `zoomable`) are derived here rather
 * than threaded as props.
 */
export interface TabPaneProps {
  tab: TabEntry;
  /** The owning scope key ("root" or a project id). Also names the PTY id. */
  scope: string;
  /** Laid out on screen (its group's active tab, and not hidden by fullscreen). */
  visible: boolean;
  /** The one visible pane that owns keyboard focus in this OS window. */
  focused: boolean;
  /** The group this pane sits in (viewer scroll-sync). Undefined in a popout. */
  groupId?: string;
  /** Popout: attach to the main window's PTY instead of spawning one. */
  attachOnly?: boolean;
  /** Open the connect dialog (network pane + a held remote terminal). */
  onConnect?: () => void;
  /** A remote terminal whose SSH pool is down — hold rather than spawn. */
  holdRemoteTerminal?: boolean;
  /** The held terminal's host label (only read when `holdRemoteTerminal`). */
  remoteHost?: string;
  /** The Files-tab browse dir (mirror-swapped while a remote is disconnected). */
  filesProjectDir: string;
  /** The terminal's cwd (the mirror path for a local-on-remote tab). */
  terminalCwd: string;
  /** Run this (agent/shell) tab inside the project's session container. */
  sandbox?: boolean;
  /** The stable tmux session name to spawn-or-attach this remote shell/script tab
   *  into (TODO #85), or undefined when the tab doesn't run persistently. */
  tmuxSession?: string;
  /** VM tier (`docs/vm_projects_plan.md`): the owning project lives inside a
   *  VM, so tab locality is pinned to it (agents-default-local is exactly the
   *  escape that tier forbids). Resolved by CenterPanel; a popout omits it —
   *  its panes are attach-only and never spawn. */
  vmProject?: boolean;
}

function TabPaneImpl({
  tab,
  scope,
  visible,
  focused,
  groupId,
  attachOnly = false,
  onConnect,
  holdRemoteTerminal = false,
  remoteHost = "",
  filesProjectDir,
  terminalCwd,
  sandbox = false,
  tmuxSession,
  vmProject = false,
}: TabPaneProps) {
  // Identical in both windows: null for the root scope, else the scope id.
  const projectId = scope === "root" ? null : scope;
  const zoomable = tab.kind === "agent" || tab.kind === "local_agent";

  switch (tab.kind) {
    case "projects3d":
      // `visible` stops the 3D rAF loop while the root scope is backgrounded.
      return <ProjectBlobPane visible={visible} />;
    case "calendar":
      return <CalendarPane visible={visible} />;
    case "browser":
      // Reader mode is ordinary DOM (a sanitized page in a script-less iframe),
      // so this pane needs none of the native-view plumbing Plan A anticipated —
      // no bounds, no visibility sync, no suppression.
      return <BrowserPane tab={tab} scope={scope} visible={visible} />;
    case "printing":
      // Printers belong to the machine, so — like the calendar pane — this one
      // takes no project props at all. `visible` is not cosmetic here: it arms
      // the queue poll, so a background print tab shells out to nothing.
      return <PrintManagerPane visible={visible} />;
    case "network":
      // `projectId`, not `scope`: a root tab is the machine's own traffic, and
      // the pane's whole remote half (host tabs, SSH link, usage totals) hangs
      // off there being a project — the same `null` the monitor below takes.
      return <NetworkTrafficPane projectId={projectId} visible={visible} onConnect={onConnect} />;
    case "monitor":
      return <SystemMonitorPane projectId={projectId} visible={visible} />;
    case "diskusage":
      return (
        <DiskUsagePane
          projectId={projectId}
          projectCwd={tab.cwd}
          tabKey={tab.key}
          visible={visible}
        />
      );
    case "skillslibrary":
      // Same thin-host shape as ProjectFilesTab: resolves its own project from
      // `scope` rather than taking a prop, since a popout has no `filesProjectDir`
      // to hand it either.
      return <SkillsLibraryTab scope={scope} cwd={tab.cwd} visible={visible} />;
    case "promptchart":
      // Reads the scope's own agent tabs from the store, so it needs nothing a
      // popout could not hand it either. `visible` gates the clock tick.
      return <PromptChartTab scope={scope} visible={visible} />;
    case "files":
      return <FileBrowser projectDir={filesProjectDir} projectId={projectId} active={visible} />;
    case "projectfiles":
      return (
        <ProjectFilesTab
          scope={scope}
          cwd={tab.cwd}
          tabKey={tab.key}
          canOpenTabs
          // Names the viewer to its own window's Local/Remote memory (per
          // window, unlike everything else here), so a popout's Files tab keeps
          // its side across a remount too.
          viewerId={`tab:${tab.key}`}
          folder={tab.folder}
          visible={visible}
        />
      );
    case "embed":
      return tab.viewer ? (
        <FileViewerPane
          viewer={tab.viewer}
          path={tab.embedPath ?? ""}
          projectId={projectId}
          tabKey={tab.key}
          visible={visible}
          groupId={groupId}
        />
      ) : (
        <EmbedPane
          path={tab.embedPath ?? ""}
          exec={tab.embedExec}
          projectId={projectId}
          visible={visible}
        />
      );
    default:
      // Remote terminal pane while the pool is down (main window only): show a
      // Connect placeholder rather than mount TerminalView, which would spawn
      // `ssh -tt` and block on the dead pool.
      if (holdRemoteTerminal) {
        return <RemotePaneHold host={remoteHost} onConnect={onConnect ?? (() => {})} />;
      }
      // A restored Host session never auto-resumes: it ran unfenced with the
      // user's full rights, so restarting it is an explicit act.
      if (tab.hostSession && tab.hostSessionPaused && !attachOnly) {
        return <HostSessionHold scope={scope} tabKey={tab.key} />;
      }
      // The tab itself rides along for the pane's prompt strip, Chat and
      // Diffs: a popout's tabs store has no entry to look it up in.
      return (
        <PaneTabContext.Provider value={{ scope, tab }}>
        <TerminalView
          // PTY ids include the scope: tab keys alone collide across projects.
          id={`${scope}:${tab.key}`}
          cmd={tab.cmd}
          args={tab.args ?? []}
          env={tab.env ?? {}}
          // A popout is attach-only and never spawns, and its `terminal-ready`
          // never fires, so it takes no initialInput (matches its old behavior).
          initialInput={attachOnly ? undefined : tab.initialInput}
          cwd={terminalCwd}
          localOnly={effectiveTabLocation(tab, { vmProject }) === "local"}
          projectId={projectId}
          // Multi-host: the worker id (or "primary") this tab runs on, so the
          // backend resolves the right host's RemoteSpec (null for a local tab).
          remoteHostId={remoteHostIdOf(effectiveTabLocation(tab, { vmProject }))}
          sandbox={sandbox}
          // Persistent remote session (TODO #85). An explicit attach (opened from
          // the Sessions view) wins over the tab's own persistent session.
          tmuxSession={tmuxSession ?? null}
          tmuxAttach={tab.tmuxAttach ?? null}
          hostBoundUid={tab.hostBoundUid ?? null}
          hostSession={!!tab.hostSession}
          kind={tab.kind}
          scheduleTargetId={tab.scheduleTargetId}
          relaunchSeq={tab.relaunchSeq ?? 0}
          zoomable={zoomable}
          visible={visible}
          focused={focused}
          attachOnly={attachOnly}
        />
        </PaneTabContext.Provider>
      );
  }
}

/**
 * Memoized so a `CenterPanel` re-render (e.g. a pane-rect update every frame of a
 * divider drag) skips every pane whose props are unchanged, instead of
 * reconciling every terminal/viewer across every scope. Relies on all props being
 * referentially stable across such re-renders — notably `onConnect`, which the
 * host passes as a per-scope stable callback (never an inline arrow).
 */
export const TabPane = memo(TabPaneImpl);
