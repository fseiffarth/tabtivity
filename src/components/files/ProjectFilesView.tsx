import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invokeTrusted } from "../../lib/execTrust";
import { gitWorktreeArgs, type GitWorktreeSelection } from "../../lib/gitWorktree";
import { GitHistory } from "./GitHistory";
import { GitChangeTree, type ChangeScope } from "./GitChangeTree";
import { GitPushProposals } from "../agents/GitPushMcp";
import { AlertsSection } from "./AlertsSection";
import {
  FileSourceSwitch,
  ProjectFilesPane,
  useBoxRoots,
  useRemoteBlocked,
} from "./ProjectFilesPane";
import { RunHostPicker } from "../tabs/TabLocalityBadges";
import { ProjectFilesSettingsDialog, useProjectFileFilters } from "./ProjectFilesSettings";
import { useImportDrop } from "./importDrop";
import { logoutRemote, useProjectsStore } from "../../stores/projects";
import { GIT_STATE_COLOR } from "../../lib/theme/gitColors";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { useSyncStore, amberPaths, localNewPaths } from "../../stores/remote/sync";
import { confirmSyncTransfer } from "../../stores/remote/syncConfirm";
import { openLinkedFile, viewerForPath } from "../embed/FileViewerPane";
import { useWindowsStore } from "../../stores/windows";
import { useGitDirtyStore, gitDirtyState } from "../../stores/gitDirty";
import { resolveLocalMirror, type FilesPanelView, type GitReleasePreview, type ProjectEntry } from "../../types";
import { fmtModified, type SortKey } from "../../lib/viewers/fileUtils";
import {
  readGitBarSnapshot,
  writeGitBarSnapshot,
  type GitStatus,
} from "../../lib/projects/fileViewSnapshots";
import { basename, dirname } from "../../lib/paths";
import { projectTypeTags } from "../projects/projectTypeTags";
import { ProjectHoverCard, useProjectHoverCard } from "../projects/ProjectHoverCard";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { UntestedTag } from "../common/UntestedTag";
import { AgentSchedulesView } from "../agents/AgentSchedulesView";
import { useDialogs } from "../common/PromptDialogs";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { persistentSessionOf } from "../../lib/remote/closeRemoteTab";
import { sessionKindFromName, type TmuxSessionKind } from "../../lib/terminal/tmuxSession";
import { useRemoteStatusStore, sshOf } from "../../stores/remote/remoteStatus";
import {
  sessionHostsOf,
  useHostSessions,
  useHostSessionsStore,
  useShowAllSessions,
  type SessionRow,
} from "../../stores/remote/hostSessions";
import {
  slurmAvailable,
  slurmQueue,
  slurmCancel,
  slurmJobOut,
  openLogTab,
  type SlurmJob,
} from "../../lib/remote/hpc/slurm";
import { useHpcJobsStore } from "../../stores/remote/hpc/hpcJobs";
import { useSettingsStore } from "../../stores/settings";
import {
  wsAvailable,
  wsList,
  wsExtend,
  wsAnchor,
  wsTargetForProject,
  setProjectHpc,
  pullLogs,
  moveProjectRoot,
  projectPathIn,
  findProjectWorkspace,
  shouldWarnExpiry,
  remainingLabel,
  expiryTone,
  type HpcWorkspace,
} from "../../lib/remote/hpc/hpcWorkspace";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useExperimental } from "../../lib/experimental";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { RemarksPane } from "./RemarksPane";
import { DevTodoView, useDevTodoAvailable } from "./DevTodoView";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CommentIcon, GearIcon, HexagonIcon, InboxIcon, SearchIcon, TagIcon, TrashIcon, WindowIcon } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY, MOBILE_HOST_KEY } from "../../lib/brand";
import { MobileAccessPicker, phoneReachLabel } from "../mobile/MobileAccessPicker";
import { phoneReach, usePairedPhones } from "../mobile/usePairedPhones";
import { tmuxSessionRest } from "../../lib/brandMigration";

/** How long the pointer must rest on a session row before its stats card opens
 *  (TODO #85) — same value and rationale as `FileTree`'s `TOOLTIP_DWELL_MS`:
 *  long enough that a mouse merely passing over the list never triggers it. */
const TOOLTIP_DWELL_MS = 400;
const MOBILE_STATUS_POLL_MS = 15_000;
/** Git view re-read cadence: nothing watches the repo while that view shows. */
const GIT_VIEW_POLL_MS = 5_000;

interface MobileHostStatus {
  running: boolean;
}

/** Phone glyph for the header's Mobile access button — the same silhouette as
 *  the header `MobileIndicator`'s icon, so the machine-wide host lamp and this
 *  per-project switch read as one feature. Off draws a slash through it: the
 *  button is a plain icon, and a dimmed tint alone would be a state you have to
 *  compare against something to read. Inherits `currentColor`. */
function MobileAccessIcon({ on }: { on: boolean }) {
  return (
    <svg
      className="side-panel-mobile-btn-icon"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4.1" y="1.5" width="7.8" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.7 3.6H9.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="12.3" r="0.7" fill="currentColor" />
      {on ? (
        <circle cx="12.6" cy="3.4" r="2.25" fill="currentColor" />
      ) : (
        <path d="M2.6 14.2L13.4 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** The row's own name button shows a short, stable label rather than the raw
 *  `tabtivity-<uuid>` — meaningless to read at a glance and mostly there to keep
 *  the name unique. The full id lives in the session-stats popup instead
 *  (`SessionStatsMenu` below), alongside the rest of the row's detail. A
 *  hand-started/foreign session's name is usually short and meaningful
 *  (`train`), so it's shown as-is. */
function sessionDisplayName(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  name: string,
): string {
  return tmuxSessionRest(name) !== null ? t("projectFilesView.sessionLabel") : name;
}

/** The Sessions view's per-machine session-type sub-heading (TODO #85): one label
 *  per {@link TmuxSessionKind} bucket. `other` groups foreign/legacy/renamed
 *  sessions the name cannot attribute to an agent or a shell. */
const SESSION_KIND_LABEL: Record<TmuxSessionKind, TranslationKey> = {
  agent: "projectFilesView.sessionKindAgents",
  shell: "projectFilesView.sessionKindShells",
  other: "projectFilesView.sessionKindOther",
};

/** Absolute local-time readout for a host-clock epoch timestamp, for the
 *  session-stats popup (the row itself only ever shows relative age). */
function absoluteTime(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString();
}

/** "How long has this session existed" / "how long has it sat idle", as a
 *  compact duration (not the `relativeAge` "N ago" phrasing, which reads
 *  wrong as a label next to "Uptime"/"Idle for"). */
function relativeDuration(epochSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

/** Anchor for the per-row session-stats hover card (TODO #85) — the same
 *  dwell-triggered tooltip pattern `FileTree` uses for a file/folder row
 *  (`handleEntryMouseEnter`/`.file-tooltip`), applied to a session row. Carries
 *  only the (host, name) identity, not a snapshot of the session — the card
 *  looks the live row up from `sessionRows` on every render, so its stats keep
 *  advancing with the Sessions view's own 7s poll while it's open, rather than
 *  freezing at whatever "working"/uptime the session had when the dwell fired. */
interface SessionTooltip {
  rect: DOMRect;
  hostId: string;
  name: string;
}

interface MtimeCue {
  text: string;
  tone: "remote" | "local" | "neutral";
  title: string;
}

/** Which side moved, as a small badge. The verdict comes from the backend's
 *  `host_diverged`/`local_diverged` — each side compared to its own recorded
 *  base, so host/local clock skew can never pick the wrong authority. The
 *  mtimes are kept purely as DISPLAY metadata (the tooltip's "modified when"
 *  lines); the badge's tone/text no longer trusts them. Tone always names the
 *  side the text is about: remote = --warning (orange), local = --success
 *  (green), matching the take-remote/keep-local icon buttons below.
 *
 *  A row only reaches this list once the manifest has recorded a synced base
 *  for it (`amberPaths` reads `state === "amber"`, which `compute_state`
 *  never sets for an untracked path) — so a null mtime here is never "this
 *  file was never synced," it's "this file WAS synced and one side's copy
 *  has since been deleted." The tooltip says so explicitly, since the badge
 *  text alone ("Remote only") reads ambiguously otherwise. Exported for tests. */
export function mtimeDivergenceCue(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  hostMtime: number | null | undefined,
  localMtime: number | null | undefined,
  hostDiverged: boolean,
  localDiverged: boolean,
  hostChecked: boolean,
): MtimeCue {
  const hostLabel =
    hostMtime != null
      ? t("projectFilesView.remoteModified", { when: fmtModified(hostMtime) })
      : t("projectFilesView.remoteDeletedSinceSync");
  const localLabel =
    localMtime != null
      ? t("projectFilesView.localModified", { when: fmtModified(localMtime) })
      : t("projectFilesView.localDeletedSinceSync");
  const title = `${hostLabel}\n${localLabel}`;
  if (hostMtime == null && localMtime == null) {
    // "Gone on both sides" is a host fact — only claim it when this pass
    // actually asked the host. A cold pool (or an errored stat) reports every
    // host mtime as null, and asserting a deletion out of that would put the
    // Forget action under a false sentence.
    if (!hostChecked) {
      const uncheckedLabel = t("projectFilesView.localGoneHostUnchecked");
      return { text: uncheckedLabel, tone: "neutral", title: `${uncheckedLabel}\n${localLabel}` };
    }
    return { text: t("projectFilesView.goneBothSides"), tone: "neutral", title };
  }
  if (hostMtime == null) return { text: t("projectFilesView.localOnly"), tone: "local", title };
  if (localMtime == null) return { text: t("projectFilesView.remoteOnly"), tone: "remote", title };
  // Both present: use the backend's per-side base comparison, never a
  // cross-machine mtime comparison.
  if (hostDiverged && localDiverged)
    return { text: t("projectFilesView.bothChanged"), tone: "neutral", title };
  if (hostDiverged) return { text: t("projectFilesView.remoteNewer"), tone: "remote", title };
  if (localDiverged) return { text: t("projectFilesView.localNewer"), tone: "local", title };
  // Neither flagged (a self-heal race): nothing actually diverged.
  return { text: t("projectFilesView.sameTime"), tone: "neutral", title };
}


type View = FilesPanelView;

// A single shared empty array for scopes with no registered tabs. Must be a
// stable reference — a Zustand selector that returned a fresh `[]` here would
// make `useSyncExternalStore` see a new snapshot every render and loop forever.
const EMPTY_SCOPE_TABS: TabEntry[] = [];

/**
 * The shared file view rendered by BOTH the side panel (`SidePanel`) and the
 * Files (Project) tab (`ProjectFilesTab`) — the view switcher (Files / Git /
 * Apps / Orange), the inline git action bar, the git history,
 * the tracked-windows list, the diverged (orange) list, the type tags, hover
 * card and SSH logout, plus the settings dialog. One component, so the panel and
 * the tab can never drift into two different file *viewers* of the same project
 * — exactly as `ProjectFilesPane` already unifies the tree itself.
 *
 * What each host still owns is what must differ: identity (the panel keys off the
 * active project, a tab off its own scope), the browsed folder (the panel's lives
 * in the projects store, a tab's on its `TabEntry`), where the Remote/Local
 * switch's `useFileSource` hook lives, and the panel-only window chrome (pin,
 * resize border, the "Hidden subwindows" list) which comes in through the
 * `resizeHandle` / `pin` / `hidden` / `footer` ReactNode slots — meaningless in
 * a tab, so a tab simply passes none.
 */
export interface ProjectFilesViewProps {
  /** The scope: a project id, a `box:<id>` scope, or "root". */
  scope: string;
  /** The project's id (was `activeId` in the panel); null in root scope. */
  projectId: string | null;
  /** The project (was `activeProject`); null in root/box scope. */
  project: ProjectEntry | null;
  /** The tree root. */
  projectDir: string;

  /** The browsed folder (host-owned so two views of one project don't yank each
   *  other around). */
  folder: string;
  onFolderChange: (folder: string) => void;

  /** Which side of a remote project the files view shows — the host over SFTP
   *  ("Remote") or the synced mirror ("Local"). The host owns `useFileSource`. */
  source: "remote" | "local";
  setSource: (s: "remote" | "local") => void;

  /** Whether this view is live/visible. Gates git + windows probes and the pill
   *  dirty-dot write, so a closed panel / background tab never churns them. */
  active: boolean;
  /** Whether the tree (and its fs-watch) is mounted. Forwarded to
   *  `ProjectFilesPane`. */
  mountTree: boolean;

  /** Compact mode: strip the project-name/tags/source-switch/git-bar header row
   *  and the Alerts group — the view-switcher toolbar (Files/Git/
   *  Search/Apps/±/sessions/jobs/import/etc.) and every view it switches to
   *  render identically to the full chrome. The sync + sort rows
   *  (`ProjectFilesPane`) are still stripped, so the tree's find-files search
   *  stays topmost there. Set only by the docked subwindow viewer
   *  (`SubwindowFilesSidebar`); the side panel and the Files (Project) tab
   *  leave it unset and keep the full chrome. */
  compact?: boolean;

  /** Host callback for the tree's "Open in a new tab"; omitted where a tab can't
   *  be owned (a box root, a popout on a streamed tab copy). */
  onOpenFolderTab?: (relPath: string) => void;

  /** The host controls the outer container's own identity (slide-in panel vs.
   *  flex tab, width, resize transitions, hover-reveal handlers); this component
   *  appends the drop classes and spreads the import-drop handlers onto it. */
  containerClassName: string;
  containerStyle?: React.CSSProperties;
  containerProps?: React.HTMLAttributes<HTMLDivElement>;

  /** Panel-only fragments interleaved with the shared DOM (undefined in a tab). */
  resizeHandle?: React.ReactNode;
  pin?: React.ReactNode;
  hidden?: React.ReactNode;
  /** Panel-only bottom frame chrome, rendered outside the scrollable viewer. */
  footer?: React.ReactNode;

  /** Host-owned view switcher selection. The side panel passes these so the view
   *  survives what remounts this component — a project switch (the panel is keyed
   *  by project id) and a relaunch (it lands in `settings.side_panel_view`). A
   *  host that passes neither keeps the view in local state, defaulting to Files,
   *  which is what a Files (Project) tab and the docked subwindow sidebar want:
   *  each of those is opened for a folder, not resumed. */
  view?: View;
  onViewChange?: (view: View) => void;
}

export function ProjectFilesView({
  scope,
  projectId,
  project,
  projectDir,
  folder,
  onFolderChange,
  source,
  setSource,
  active,
  mountTree,
  onOpenFolderTab,
  containerClassName,
  containerStyle,
  containerProps,
  resizeHandle,
  pin,
  hidden,
  footer,
  compact,
  view: hostView,
  onViewChange,
}: ProjectFilesViewProps) {
  const t = useT();
  // Sessions/Jobs/workspaces ask their questions in the panel's own chrome, the
  // one the file tree below them already uses — not in WebKitGTK's native boxes,
  // which arrive themeless and titled with the page origin.
  const { promptText, confirmAction, showMessage, dialogs } = useDialogs();
  const { windows, refresh, closeApp } = useWindowsStore();
  // The Apps view shows THIS scope's launches only — the store holds every
  // scope's slice (it is shared by all mounted viewers), so filter per render.
  const scopedWindows = useMemo(
    () =>
      windows
        .filter((w) => (w.project_id ?? null) === (projectId ?? null))
        .sort((a, b) => a.opened_at - b.opened_at),
    [windows, projectId],
  );
  const remarksEnabled = useExperimental("project_remarks");
  // The checkout's todo groups; only a dev build has a checkout to read.
  const devTodo = useDevTodoAvailable();
  // A box scope shows a multi-root file view (the box folder + every member
  // project's root) instead of one project tree; the pane renders it. Read here
  // rather than beside the tree because the view switcher below gates half its
  // buttons on it.
  const { activeBox } = useBoxRoots(scope);
  // Whether the primary host has SLURM — the Jobs button's gate. Declared up
  // here with the other view gates; the probe that sets it lives with the rest
  // of the Jobs code further down.
  const [slurmSupported, setSlurmSupported] = useState(false);
  // The view switcher's selection. Held here even when a host persists it (the
  // `view`/`onViewChange` props) so a click paints immediately rather than after
  // the host's write has come back — the host's value is folded in whenever it
  // CHANGES, which covers both a settings load that lands after this mounted and
  // the write-back of a click.
  const [localView, setLocalView] = useState<View>(hostView ?? "files");
  const [seenHostView, setSeenHostView] = useState(hostView);
  if (hostView !== seenHostView) {
    setSeenHostView(hostView);
    if (hostView !== undefined) setLocalView(hostView);
  }
  const requestedView = localView;
  const setView = useCallback(
    (next: View) => {
      setLocalView(next);
      onViewChange?.(next);
    },
    [onViewChange],
  );
  // What is actually shown. A stored view whose toolbar button this project
  // doesn't have — Orange/Sessions off a remote project, Jobs off a SLURM host,
  // Remarks with the flag off — would otherwise be a room with no door out, and
  // SLURM support in particular is only known one async probe after mount. So
  // the unavailable view *renders* as Files while the stored value stays put:
  // switch back to a remote project, or let the probe land, and it returns.
  const viewAvailable = (candidate: View): boolean => {
    switch (candidate) {
      case "orange":
      case "sessions":
        return !activeBox && !!project?.remote && !!projectId;
      case "jobs":
        return !activeBox && slurmSupported && !!projectId;
      case "remarks":
        return !activeBox && remarksEnabled && !!projectId;
      case "todo":
        return !activeBox && devTodo;
      default:
        return true;
    }
  };
  const view: View = viewAvailable(requestedView) ? requestedView : "files";
  useEffect(() => {
    if (active && remarksEnabled && projectId && projectDir) {
      void useProjectRemarksStore.getState().load(projectId, projectDir);
    }
  }, [active, remarksEnabled, projectId, projectDir]);
  const [showSettings, setShowSettings] = useState(false);
  // Toggles the Downloads section stacked below the file tree (fast-copy of
  // recent downloads into the project). Toolbar ⬇⬇ button; files view only.
  const [showDownloads, setShowDownloads] = useState(false);
  // The in-tree search box's fold, hoisted out of FileTree so its 🔍 can live in
  // the toolbar row beside Files/Git/Apps: closed (the default) the tree spends
  // no row at all on search chrome, which in the side panel's width is the
  // difference between seeing three more files and not. ↻ moved up with it —
  // the two shared the tree's row, and leaving refresh behind would have kept
  // that row alive for one button. It reaches the tree as a bumped counter.
  const [searchOpen, setSearchOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // The Alerts group stacked below the viewer's body (urgent mail, the next
  // appointments, due/overdue cards) — below the file tree in the files view,
  // and below Git/Orange/Sessions/Jobs/Remarks/Agents/Windows in theirs: the
  // rows are global, so which view the panel happens to be parked on must not
  // decide whether a due card is seen. Unlike Downloads there is no local shown
  // flag: `files_alerts` IS the visibility, which is what lets the × stick — the
  // group is on by default, so a close that came back at the next remount (and
  // this viewer is mounted many times over) would be a control that doesn't work.
  // It is one machine-wide key, so the header's 🔔 (`header/AlertsToggle`), this
  // group's ×, and the Project Settings checkbox are three faces of one switch
  // and cannot disagree.
  const alertsEnabled = useSettingsStore((s) => s.settings?.files_alerts ?? true);
  const mobileHostEnabled = useSettingsStore((s) => s.settings?.[MOBILE_HOST_KEY]?.enabled ?? false);
  // ...but never in the docked subwindow column (`compact`), whatever the
  // setting says: that viewer is a ~300px sidebar beside a terminal, where a
  // strip of mail/appointment/card rows takes the space the tree is there for
  // — and it is the surface mounted many times over at once, so one alert
  // would be repeated once per open subwindow. The header's 🔔 still reads as
  // on, correctly: it is the machine's switch, and the group it arms is showing
  // in the side panel and every Files tab — this one column is the exception.
  const alertsHere = alertsEnabled && !compact;
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const setProjectMobileAccess = useProjectsStore((s) => s.setProjectMobileAccess);
  const mobileEligible = !!projectId
    && !!project
    && !project.remote
    && !project.sandbox?.enabled
    && !project.vm?.enabled;
  const [mobileHostConnected, setMobileHostConnected] = useState(false);
  const [mobileAccessBusy, setMobileAccessBusy] = useState(false);
  const [mobileAccessError, setMobileAccessError] = useState<string | null>(null);
  // Kept here (not in the pane): the pane unmounts while the view shows Git or
  // Search, and the chosen sort must survive the trip back to Files.
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);

  // The Mobile host is machine-wide, but enabling its deliberately narrow
  // terminal surface is a per-project decision. Keep the quick toggle out of
  // the viewer until the host is actually reachable, matching the header's
  // green Mobile indicator rather than trusting its persisted enabled setting.
  useEffect(() => {
    if (!active || !mobileHostEnabled || !mobileEligible) {
      setMobileHostConnected(false);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void invoke<MobileHostStatus>("mobile_host_status")
        .then((status) => {
          if (!cancelled) setMobileHostConnected(status.running);
        })
        .catch(() => {
          if (!cancelled) setMobileHostConnected(false);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, MOBILE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
    };
  }, [active, mobileEligible, mobileHostEnabled]);

  const mobileAccessOn = project?.[MOBILE_ACCESS_KEY] ?? false;

  // The phone button opens the per-phone picker rather than toggling: which
  // paired phones reach the project is part of the same decision. The picker
  // writes each choice itself (All → every phone, ticks → that list, Turn off).
  const [mobilePicker, setMobilePicker] = useState<{ x: number; y: number } | null>(null);
  const mobileDevices = project?.[MOBILE_DEVICES_KEY];
  // Paired phones only matter here for a list's count in the button's title:
  // read them while that button shows one, and again when the picker closes.
  const { phones: pairedPhones } = usePairedPhones(
    `${mobilePicker !== null}:${JSON.stringify(mobileDevices ?? null)}`,
    active && mobileHostConnected && mobileEligible && mobileAccessOn && mobileDevices !== undefined,
  );
  const mobileReach = phoneReach(mobileAccessOn, mobileDevices, pairedPhones);
  const applyMobileAccess = (enabled: boolean, devices: string[] | null) => {
    if (!projectId) return Promise.resolve();
    setMobileAccessBusy(true);
    setMobileAccessError(null);
    return setProjectMobileAccess(projectId, enabled, devices)
      .catch((reason) => {
        setMobileAccessError(String(reason));
        throw reason;
      })
      .finally(() => setMobileAccessBusy(false));
  };

  // Seeded from the last snapshot of this repo so a reveal (the whole view is
  // unmounted by the `panelsHidden` toggle) shows the action bar populated on
  // the first frame instead of an empty one that fills in a `git status` later.
  // Keyed by `projectDir`, which is what `effectiveGitRoot` is until nested-repo
  // detection says otherwise — and that detection refreshes the bar itself.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(
    () => readGitBarSnapshot(projectDir)?.status ?? null,
  );
  const [unpushedCommits, setUnpushedCommits] = useState<string[]>(
    () => readGitBarSnapshot(projectDir)?.unpushed ?? [],
  );
  const [openTree, setOpenTree] = useState<"add" | "commit" | "push" | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitWorktree, setGitWorktree] = useState<{ root: string; selection: GitWorktreeSelection | null } | null>(null);
  // Bumped by the Pull button: GitHistory owns the pull preview it opens.
  const [pullRequest, setPullRequest] = useState(0);
  const [gitError, setGitError] = useState<string | null>(null);
  // Whether the project is missing scaffold files — drives the "no scaffold"
  // type tag shown beside its name, mirroring ProjectPill's hover tags.
  const [scaffoldMissing, setScaffoldMissing] = useState(false);
  // Nested-repo detection: when the browsed folder lives in a git repo distinct
  // from the project's own repo, `nestedRoot` holds that repo's root and the git
  // section re-roots at it. `preferProjectRepo` is the manual toggle override
  // back to the project repo.
  const [nestedRoot, setNestedRoot] = useState<string | null>(null);
  const [preferProjectRepo, setPreferProjectRepo] = useState(false);
  const commitRef = useRef<HTMLTextAreaElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const refreshGitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localFile = project?.local_file;
  // Remote git/endings probes dispatch over SSH/SFTP via SYNCHRONOUS Tauri
  // commands (run on the main thread). Calling them while the pool is down blocks
  // on the dead session and freezes the window, so suppress them until the remote
  // project is connected. Local projects are never blocked.
  const { remoteSshState, remoteBlocked } = useRemoteBlocked(projectId, !!project?.remote);
  // Which endings/paths the tree hides, from the project's own project.json —
  // shared with the side panel, so both views hide the same files.
  const filters = useProjectFileFilters({ localFile, projectDir, remoteBlocked });

  // Run both git probes concurrently (Eff #9): they hit independent
  // subprocesses, so `Promise.all` collapses two serially-awaited chains into
  // one round of parallel work. Each result still applies independently.
  const runRefreshGit = (dir: string) => {
    const context = gitContextKey;
    const worktreeArgs = gitWorktreeArgs(selectedGitWorktree);
    void Promise.all([
      invoke<GitStatus>("git_status", { projectDir: dir, ...worktreeArgs }).catch(() => null),
      // A failed read (git refused or timed out, #2349) is no reading, not
      // "nothing to push": `null`, so neither this bar nor the pill draws clean.
      invoke<string[]>("git_unpushed_commits", { projectDir: dir, ...worktreeArgs }).catch(() => null),
    ]).then(([status, unpushed]) => {
      if (context !== gitContextKeyRef.current) return;
      setGitStatus(status);
      // Unknown keeps the last list shown rather than emptying it.
      if (unpushed) setUnpushedCommits(unpushed);
      if (!selectedGitWorktree && unpushed) writeGitBarSnapshot(dir, { status, unpushed });
      // Keep the project's pill dot in sync from the data we just fetched (no
      // extra git subprocesses), so edits/commits/pushes reflect immediately
      // instead of waiting for the switcher's periodic poll.
      // Don't let a nested repo's status pollute the project pill's dirty dot —
      // that dot tracks the project repo (the switcher's poll recomputes it).
      // Gate on `active` so a background tab never churns the shared store.
      if (active && projectId && status && !onNestedRepo && !selectedGitWorktree) {
        const level = gitDirtyState(status, unpushed?.length ?? 0);
        // Without the unpushed count a clean tree may still be "unpushed":
        // leave the dot to the switcher's probe instead of writing "clean".
        if (unpushed || level !== "clean") useGitDirtyStore.getState().set(projectId, level);
      }
    });
  };

  // Debounced entry point (Eff #9): bursts of git-affecting actions (add →
  // commit → push, or rapid fs changes) coalesce into a single refresh instead
  // of spawning a fresh trio of subprocesses per call.
  const refreshGit = (dir: string) => {
    if (refreshGitTimer.current) clearTimeout(refreshGitTimer.current);
    refreshGitTimer.current = setTimeout(() => {
      refreshGitTimer.current = null;
      runRefreshGit(dir);
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (refreshGitTimer.current) clearTimeout(refreshGitTimer.current);
    };
  }, []);

  // The change tree is click-opened and persistent; close it on Escape or a
  // click anywhere outside the action bar (which contains both the toggles and
  // the tree itself).
  useEffect(() => {
    if (!openTree) return;
    const onDown = (e: MouseEvent) => {
      if (!actionBarRef.current?.contains(e.target as Node)) setOpenTree(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenTree(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openTree]);

  const treeScope: ChangeScope | null =
    openTree === "add" ? "unstaged" : openTree === "commit" ? "staged" : openTree === "push" ? "unpushed" : null;

  // Detect a nested git repo: if the folder currently browsed in the file tree
  // lives inside a git repo distinct from the project's own repo, re-root the
  // git section at it (auto-switch). Local projects only — the backend returns
  // null for remote ones, so `nestedRoot` stays null and behavior is unchanged.
  useEffect(() => {
    if (!projectDir || project?.remote) {
      setNestedRoot(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      invoke<string | null>("git_repo_root", { projectDir, relPath: "" }).catch(() => null),
      invoke<string | null>("git_repo_root", { projectDir, relPath: folder }).catch(() => null),
    ]).then(([projRoot, folderRoot]) => {
      if (cancelled) return;
      const norm = (p: string | null) => (p ? p.replace(/[/\\]+$/, "") : null);
      const pr = norm(projRoot);
      const fr = norm(folderRoot);
      setNestedRoot(fr && fr !== pr ? fr : null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectDir, folder, project?.remote]);

  // Default to auto-switch: reset the manual override on a project switch or
  // whenever we leave the nested repo, so entering one always shows it first.
  useEffect(() => {
    setPreferProjectRepo(false);
  }, [projectId]);
  useEffect(() => {
    if (!nestedRoot) setPreferProjectRepo(false);
  }, [nestedRoot]);

  // The repo root the whole git section (status, commit, push, history) operates
  // on: the nested repo when detected and not overridden, else the project repo.
  const effectiveGitRoot = nestedRoot && !preferProjectRepo ? nestedRoot : projectDir;
  const onNestedRepo = !!nestedRoot && effectiveGitRoot !== projectDir;
  const selectedGitWorktree = view === "git" && gitWorktree?.root === effectiveGitRoot ? gitWorktree.selection : null;
  const gitContextKey = JSON.stringify([effectiveGitRoot, selectedGitWorktree?.site ?? "host", selectedGitWorktree?.path ?? ""]);
  const gitContextKeyRef = useRef(gitContextKey);
  gitContextKeyRef.current = gitContextKey;
  const onGitWorktreeChanged = useCallback((selection: GitWorktreeSelection | null) => {
    setGitWorktree({ root: effectiveGitRoot, selection });
  }, [effectiveGitRoot]);
  const previousGitContext = useRef(gitContextKey);
  useEffect(() => {
    if (previousGitContext.current === gitContextKey) return;
    previousGitContext.current = gitContextKey;
    setCommitMsg(null);
    setOpenTree(null);
    setGitError(null);
    setGitStatus(null);
    setUnpushedCommits([]);
  }, [gitContextKey]);

  // Diverged (amber/orange) files for a remote project, from the cached sync
  // status — backs the toolbar count badge and the "Orange" list view. These are
  // exactly the files auto-sync refuses to touch (both sides changed), so they
  // need a human to pick a side.
  const syncMap = useSyncStore((s) => (projectId ? s.byProject[projectId] : undefined));
  const orangeFiles = useMemo(() => amberPaths(syncMap), [syncMap]);
  // NEW local-only files (never synced — the host has no copy). A separate list
  // from the amber one on purpose: these have nothing to merge and no remote
  // side to take, so their whole vocabulary is "upload" or "leave local".
  const newLocalFiles = useMemo(() => localNewPaths(syncMap), [syncMap]);
  // The local mirror root, to open an amber file's mirror copy for inspection.
  const mirrorRoot = resolveLocalMirror(project) ?? (projectDir ? `${projectDir}/mirror` : null);

  // Persistent (tmux) sessions on the project's hosts (TODO #85): a session
  // outlives the tab that started it, so a host can hold runs no open tab points at
  // (a crashed/relaunched Tabtivity, another machine, a hand-started `tmux`). This list
  // makes them discoverable and reattachable — the primary UI surface for the
  // feature. **Multi-host**: aggregated across the primary AND every connected
  // worker, each row tagged with its host; polled while this view is active (rides
  // each host's pooled ControlMaster). An absent tmux / no server yields nothing.
  //
  // The list, its poll and its toggle all live in `stores/remote/hostSessions`, NOT
  // here: this component is rendered by the side panel, by every Files (Project)
  // tab and by every subwindow's docked column at once, and a per-instance poll
  // meant one `tmux ls` per host per surface every 7s — and, worse, that a
  // session killed in one surface sat on in the others until their own interval
  // came round. The store keeps one reading per project, refcounted by the
  // surfaces showing it (`active` decides whether this one subscribes at all), so
  // every viewer reads the same rows and a kill/rename lands in all of them.
  const sessionHosts = useMemo(() => sessionHostsOf(project), [project]);
  const sessionRows = useHostSessions(projectId, active && !!project?.remote);
  // The Sessions list is scoped to THIS project by default (the backend filters
  // by session name, falling back to the session's working directory for the
  // pre-scoping and hand-started ones a name cannot attribute). This is the
  // escape hatch: a host's full listing, so a session running outside any
  // project tree — an orphaned run whose tab is long gone — is still reachable
  // to attach to or kill. Shared like the list itself: it changes what the
  // backend returns, so two viewers of one project must not hold two answers.
  const [showAllSessions, setShowAllSessions] = useShowAllSessions(projectId);

  // Per-row session-stats hover card (TODO #85): the exact dwell-tooltip
  // mechanism `FileTree` uses for a file/folder row — open on a genuine pause,
  // not mere mouse-in (a bare `onMouseEnter` measurement would reflow on every
  // pass over the list), close immediately on leave.
  const [sessionTooltip, setSessionTooltip] = useState<SessionTooltip | null>(null);
  const sessionTooltipRef = useRef<HTMLDivElement | null>(null);
  const sessionTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelSessionTooltipTimer() {
    if (sessionTooltipTimer.current !== null) {
      clearTimeout(sessionTooltipTimer.current);
      sessionTooltipTimer.current = null;
    }
  }
  useEffect(() => () => cancelSessionTooltipTimer(), []);
  function handleSessionRowMouseEnter(e: React.MouseEvent<HTMLDivElement>, hostId: string, name: string) {
    const row = e.currentTarget;
    cancelSessionTooltipTimer();
    sessionTooltipTimer.current = setTimeout(() => {
      sessionTooltipTimer.current = null;
      setSessionTooltip({ rect: row.getBoundingClientRect(), hostId, name });
    }, TOOLTIP_DWELL_MS);
  }
  function handleSessionRowMouseLeave() {
    cancelSessionTooltipTimer();
    setSessionTooltip(null);
  }
  // Vertical-only overflow correction, same as `FileTree`'s `tooltipShift`: a
  // row near the bottom of a short docked viewer still measures its anchor
  // against the whole app window, so an unclamped `top` could push the card
  // past the window's bottom edge. Horizontal side is picked in the render
  // below (whichever side of the row has more room).
  const [sessionTooltipShift, setSessionTooltipShift] = useState(0);
  useLayoutEffect(() => {
    if (!sessionTooltip) {
      setSessionTooltipShift(0);
      return;
    }
    const el = sessionTooltipRef.current;
    if (!el) {
      setSessionTooltipShift(0);
      return;
    }
    const overflow = sessionTooltip.rect.top + el.offsetHeight - (window.innerHeight - 8);
    setSessionTooltipShift(overflow > 0 ? overflow : 0);
  }, [sessionTooltip]);
  // Closing a session (kill/rename) drops it from `sessionRows`; the card has
  // no session left to look up, so it self-closes rather than showing
  // stale/blank stats.
  useEffect(() => {
    if (!sessionTooltip) return;
    const stillThere = sessionRows.some(
      (r) => r.hostId === sessionTooltip.hostId && r.session.name === sessionTooltip.name,
    );
    if (!stillThere) setSessionTooltip(null);
  }, [sessionRows, sessionTooltip]);

  // Keep the Sessions view grouped in the configured machine order. A fallback
  // group preserves a row if a machine was renamed or removed while its list
  // request was still in flight.
  const sessionGroups = useMemo(() => {
    const groups = new Map<string, { hostId: string; hostLabel: string; rows: SessionRow[] }>();
    for (const host of sessionHosts)
      groups.set(host.id, { hostId: host.id, hostLabel: host.label, rows: [] });
    for (const row of sessionRows) {
      const group = groups.get(row.hostId);
      if (group) group.rows.push(row);
      else groups.set(row.hostId, { hostId: row.hostId, hostLabel: row.hostLabel, rows: [row] });
    }
    // Within each machine, split the sessions by the kind of tab they back
    // (`sessionKindFromName`), in a fixed order so the sub-headings never reshuffle
    // as sessions come and go. An empty bucket is dropped — a header for a type this
    // host is not running would be noise — and `other` (foreign/legacy/renamed
    // sessions) only appears when there is at least one, so an ordinary all-Tabtivity
    // host shows just Agents/Shells.
    return [...groups.values()]
      .filter((group) => group.rows.length > 0)
      .map((group) => {
        const byKind = new Map<TmuxSessionKind, SessionRow[]>();
        for (const row of group.rows) {
          const kind = sessionKindFromName(row.session.name);
          (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push(row);
        }
        const kindGroups = (["agent", "shell", "other"] as const)
          .map((kind) => ({ kind, rows: byKind.get(kind) ?? [] }))
          .filter((kg) => kg.rows.length > 0);
        return { ...group, kindGroups };
      });
  }, [sessionHosts, sessionRows]);

  // The (host, session) each open shell tab of this scope owns, so a Sessions row
  // can reveal the tab that runs it instead of opening a second attach.
  // Coalesce to the shared empty array OUTSIDE the selector: a selector that
  // returns a fresh `[]` when this scope has no tabs yields a new snapshot on
  // every render, which makes `useSyncExternalStore` loop forever ("getSnapshot
  // should be cached" → Maximum update depth). Returning the stored array (stable)
  // or `undefined` (stable) from the selector, then defaulting here, is loop-safe.
  const scopeTabs = useTabsStore((s) => s.tabsByScope[scope]) ?? EMPTY_SCOPE_TABS;
  const sessionOwners = useMemo(() => {
    const m = new Map<string, string>(); // `${hostId}\0${name}` → owning tab key
    for (const tab of scopeTabs) {
      const info = persistentSessionOf(scope, tab);
      if (info) m.set(`${info.hostId} ${info.session}`, tab.key);
    }
    return m;
  }, [scopeTabs, scope]);

  // Open a host session in a tab: reveal the owning tab if one exists, else add a
  // shell tab on THAT host that ATTACHES to the named session (idempotent; `-D`
  // detaches any other client). The tab carries the name so it reattaches across a
  // restart, and its locality is the row's host.
  const openSession = (hostId: string, name: string) => {
    if (!projectId) return;
    const ownerKey = sessionOwners.get(`${hostId} ${name}`);
    if (ownerKey) {
      useTabsStore.getState().setActive(ownerKey);
      return;
    }
    useTabsStore.getState().addTabToScope(projectId, {
      label: tmuxSessionRest(name) !== null ? "session" : name,
      cmd: "",
      args: [],
      cwd: projectDir,
      kind: "shell",
      location: hostId === "primary" ? "remote" : `host:${hostId}`,
      tmuxAttach: name,
    });
  };

  // Kill a host session (per-row, confirmed). Drops the row optimistically; the
  // poll reconciles. Unlike a tab close (which merely detaches), a kill terminates
  // the session, so the tab that owns it — now attached to a dead session — is
  // closed too rather than left showing a defunct terminal.
  const killSession = async (hostId: string, name: string) => {
    if (!projectId) return;
    const ok = await confirmAction({
      title: t("projectFilesView.killSessionDialogTitle"),
      body: t("projectFilesView.confirmKillSession", { name }),
      confirmLabel: t("projectFilesView.killSessionAction"),
      danger: true,
    });
    if (!ok) return;
    const ownerKey = sessionOwners.get(`${hostId} ${name}`);
    invoke("remote_tmux_kill", { projectId, hostId, session: name })
      .then(() => {
        // Into the SHARED list, so the panel, the tab and every docked column
        // drop the row together rather than each waiting out its own poll.
        useHostSessionsStore.getState().dropRow(projectId, hostId, name);
        if (ownerKey) useTabsStore.getState().removeTab(ownerKey);
      })
      .catch(() => {});
  };

  // Rename a host session (per-row). The name must be tmux-safe; on success the
  // owning tab's persisted name is updated too, so it reattaches to the renamed
  // session after a restart (the live client stays attached — rename never drops it).
  const renameSession = async (hostId: string, oldName: string) => {
    if (!projectId) return;
    await promptText(
      {
        title: t("projectFilesView.renameSessionDialogTitle"),
        label: t("projectFilesView.renameSessionPrompt"),
        initial: oldName,
        confirmLabel: t("common.rename"),
        unchanged: oldName,
        // The tmux-safe check was an alert that threw the typed name away; as a
        // validator it lands under the field, with the name still in it.
        validate: (next) =>
          /^[A-Za-z0-9_-]+$/.test(next) ? null : t("projectFilesView.sessionNameInvalid"),
      },
      async (next) => {
        await invoke("remote_tmux_rename", {
          projectId,
          hostId,
          session: oldName,
          newName: next,
        });
        const ownerKey = sessionOwners.get(`${hostId} ${oldName}`);
        if (ownerKey) useTabsStore.getState().setTabTmuxName(scope, ownerKey, next);
        useHostSessionsStore.getState().renameRow(projectId, hostId, oldName, next);
      },
    );
  };

  // ── SLURM jobs (HPC) ──────────────────────────────────────────────────────
  // A Jobs view, primary-only to start: whether the primary host has SLURM, and
  // this user's live queue on it. Rides the primary's pooled ControlMaster; polled
  // only while the view is active (like Sessions). A local project with SLURM (a
  // login node) also gets it. The session store carries just-submitted jobs so a
  // Watch can resolve their log path without a fresh scontrol.
  const [jobRows, setJobRows] = useState<SlurmJob[]>([]);
  const sessionJobs = useHpcJobsStore((s) =>
    projectId ? s.byProject[projectId] : undefined,
  );
  // Primary connectivity, so probes/polls re-run the moment it connects.
  const primaryConn = useRemoteStatusStore((s) => sshOf(s, projectId ?? "", "primary"));
  const primaryReady = !project?.remote || primaryConn === "connected";
  useEffect(() => {
    if (!active || !projectDir || !primaryReady) {
      setSlurmSupported(false);
      return;
    }
    let cancelled = false;
    slurmAvailable(projectDir)
      .then((info) => { if (!cancelled) setSlurmSupported(info.available); })
      .catch(() => { if (!cancelled) setSlurmSupported(false); });
    return () => { cancelled = true; };
  }, [active, projectDir, primaryReady]);
  useEffect(() => {
    if (!active || view !== "jobs" || !slurmSupported || !projectDir) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const jobs = await slurmQueue(projectDir);
        if (!cancelled) setJobRows(jobs);
      } catch {
        if (!cancelled) setJobRows([]);
      }
    };
    void poll();
    const iv = setInterval(() => void poll(), 7000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [active, view, slurmSupported, projectDir]);

  // Watch a job: open a log tab tailing its stdout. Use the session store's path
  // if we submitted it this session, else resolve via scontrol.
  const watchJob = async (jobId: string, name: string) => {
    if (!projectDir) return;
    try {
      const known = sessionJobs?.find((j) => j.jobId === jobId);
      const outFile =
        known?.outFile ??
        (await slurmJobOut(projectDir, jobId, undefined, project?.hpc?.logs_dir));
      openLogTab({
        scope,
        projectDir,
        outFile,
        jobLabel: `${jobId} ${name}`,
        hostId: "primary",
        isRemote: !!project?.remote,
      });
    } catch (e) {
      void showMessage({
        title: t("projectFilesView.watchJobDialogTitle"),
        body: t("projectFilesView.watchJobResolveFailed", { jobId, error: String(e) }),
        error: true,
      });
    }
  };

  // ── HPC workspaces (Phase C) ──────────────────────────────────────────────
  // A workspace is the piece of the cluster's parallel filesystem this project's
  // data lives on — and it is DELETED when it expires. The wizard is where one is
  // allocated; this is where an already-running project *sees the clock* and
  // spends an extension before the deadline. Read once when the Jobs view opens
  // (never polled: `ws_list` is a full SSH round trip and the number moves in
  // days, not seconds).
  const [wsRows, setWsRows] = useState<HpcWorkspace[]>([]);
  const [wsBusy, setWsBusy] = useState(false);
  // The read runs for the Jobs view AND — when the project records a workspace —
  // as soon as its host is reachable, because the expiry banner has to appear
  // without the user first opening a view they have no reason to visit.
  const wantWorkspaces = view === "jobs" || Boolean(project?.hpc?.workspace_id);
  useEffect(() => {
    if (!active || !wantWorkspaces || !projectDir || !primaryReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = await wsAvailable(wsTargetForProject(projectDir));
        if (cancelled || !info.available) {
          if (!cancelled) setWsRows([]);
          return;
        }
        const list = await wsList(wsTargetForProject(projectDir));
        if (!cancelled) setWsRows(list);
      } catch {
        if (!cancelled) setWsRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [active, wantWorkspaces, projectDir, primaryReady]);

  // The workspace this project's tree actually lives in — the one whose expiry
  // deletes the host copy of the project, not merely "some data".
  const projectWs = useMemo(
    () => findProjectWorkspace(wsRows, project?.hpc, project?.remote?.remote_path),
    [wsRows, project?.hpc, project?.remote?.remote_path],
  );
  const [expiryDismissed, setExpiryDismissed] = useState("");
  const warnExpiry =
    shouldWarnExpiry(projectWs) && expiryDismissed !== `${projectWs?.id}:${projectWs?.remaining_days}`;

  // Spend one of a workspace's extensions. The filesystem it was allocated on has
  // to be repeated, so the row's own value is passed straight back.
  const extendWs = async (ws: HpcWorkspace) => {
    if (!projectDir) return;
    await promptText(
      {
        title: t("projectFilesView.extendWorkspaceDialogTitle"),
        body: t("projectFilesView.extendWorkspacePrompt", { id: ws.id }),
        label: t("projectFilesView.extendWorkspaceDaysLabel"),
        initial: "30",
        confirmLabel: t("projectFilesView.extendWorkspaceAction"),
        // A day count, so a non-number is refused where it was typed rather
        // than silently dropping the click on the floor as the prompt did.
        validate: (answer) =>
          Number.isFinite(Number(answer)) && Number(answer) >= 1
            ? null
            : t("projectFilesView.extendWorkspaceDaysInvalid"),
      },
      async (answer) => {
        const next = await wsExtend(
          wsTargetForProject(projectDir),
          ws.id,
          Number(answer),
          ws.filesystem,
        );
        setWsRows((rs) => rs.map((r) => (r.id === ws.id ? { ...r, ...next } : r)));
      },
    );
  };

  // Move the project's host tree into another workspace — the escape hatch an
  // expiry makes inevitable (a primary's remote_path is otherwise fixed at
  // creation). Nothing is copied host-side: the new root starts empty and is
  // re-seeded from the LOCAL MIRROR, which is the durable copy. Whatever the old
  // workspace still holds stays there until it expires, so this must be said
  // before it happens, not after.
  const moveProjectTo = async (ws: HpcWorkspace) => {
    if (!projectId || !project?.remote) return;
    const folder = basename(project.remote.remote_path.replace(/\/+$/, "")) || projectId;
    const dest = projectPathIn(ws, folder);
    const ok = await confirmAction({
      title: t("projectFilesView.moveProjectTitle"),
      body: t("projectFilesView.confirmMoveProject", { dest }),
      confirmLabel: t("projectFilesView.moveProjectAction"),
      danger: true,
    });
    if (!ok) return;
    setWsBusy(true);
    try {
      // The pool caches the spec, so the connection has to be dropped around the
      // rewrite and re-opened against the new root.
      await invoke("remote_disconnect", { projectId }).catch(() => {});
      const updated = await moveProjectRoot(projectId, dest);
      useProjectsStore.setState((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? { ...p, ...updated } : p)),
      }));
      // Reconnect BEFORE re-anchoring: the anchor script rides the project's SSH
      // path, and between the disconnect above and this there is no session for
      // it to ride (on a password host it would have nothing to authenticate
      // with, and no prompt could be answered from here).
      // `viaLogin`: credential-less by necessity (there is no prompt to answer from
      // here), so it can only ride an existing master — never evidence of key auth.
      // `background: false`: this is the middle of a move the user clicked, and the
      // host it runs against is a cluster by construction — the dial policy's default
      // would refuse it on exactly the machines this flow exists for.
      await invoke("remote_connect", { projectId, viaLogin: true, background: false }).catch(
        () => {},
      );

      // Re-anchor: the record file gains a line naming the new workspace, and the
      // `workspace` symlink re-points. This is exactly the history the record
      // exists for — a project passes through several workspaces in a year.
      let logsDir = project.hpc?.logs_dir;
      const anchorRel = project.hpc?.anchor_rel;
      if (anchorRel) {
        try {
          const made = await wsAnchor(wsTargetForProject(projectDir), {
            anchorRel,
            workspacePath: ws.path,
            workspaceId: ws.id,
            projectName: project.name,
            makeLogs: true,
          });
          logsDir = made.logs_dir ?? logsDir;
        } catch {
          /* the move already succeeded; the anchor is a convenience */
        }
      }
      await setProjectHpc(projectId, {
        workspace_id: ws.id,
        workspace_path: ws.path,
        filesystem: ws.filesystem,
        anchor_dir: project.hpc?.anchor_dir,
        anchor_rel: anchorRel,
        logs_dir: logsDir,
      }).catch(() => {});
    } catch (e) {
      void showMessage({
        title: t("projectFilesView.moveProjectTitle"),
        body: t("projectFilesView.moveProjectFailed", { error: String(e) }),
        error: true,
      });
    } finally {
      setWsBusy(false);
    }
  };

  // Copy the home anchor's logs into the local mirror — the provenance record on
  // the machine the user actually reads logs on.
  const pullProjectLogs = async () => {
    const dir = project?.hpc?.logs_dir;
    if (!projectId || !dir) return;
    try {
      const n = await pullLogs(projectId, dir);
      await showMessage({
        title: t("projectFilesView.pullLogsDialogTitle"),
        body:
          n > 0
            ? t(n === 1 ? "projectFilesView.pulledLogsOne" : "projectFilesView.pulledLogsMany", { count: n })
            : t("projectFilesView.noLogsYet"),
      });
    } catch (e) {
      await showMessage({
        title: t("projectFilesView.pullLogsDialogTitle"),
        body: t("projectFilesView.copyLogsFailed", { error: String(e) }),
        error: true,
      });
    }
  };

  // Cancel a job (confirmed). Drops the row optimistically; the poll reconciles.
  const cancelJob = async (jobId: string, name: string) => {
    if (!projectDir) return;
    const ok = await confirmAction({
      title: t("projectFilesView.cancelJobDialogTitle"),
      body: t("projectFilesView.confirmCancelJob", { jobId, name: name ? ` (${name})` : "" }),
      confirmLabel: t("projectFilesView.cancelJobAction"),
      danger: true,
    });
    if (!ok) return;
    try {
      await slurmCancel(projectDir, jobId);
      setJobRows((rs) => rs.filter((r) => r.id !== jobId));
      if (projectId) useHpcJobsStore.getState().remove(projectId, jobId, "primary");
    } catch (e) {
      await showMessage({
        title: t("projectFilesView.cancelJobDialogTitle"),
        body: t("projectFilesView.cancelJobFailed", { error: String(e) }),
        error: true,
      });
    }
  };

  // Resolve the scaffold-missing flag whenever the project changes. Failures
  // fall back to "present" so a probe error doesn't flash the tag.
  useEffect(() => {
    if (!projectId) {
      setScaffoldMissing(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>("project_scaffold_missing", { projectId })
      .then((v) => { if (!cancelled) setScaffoldMissing(v); })
      .catch(() => { if (!cancelled) setScaffoldMissing(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const typeTags = project ? projectTypeTags(project, scaffoldMissing, t) : [];

  // Right-click menu on the SSH (remote) tag: open the one unified "Remote machines"
  // hub, which connects/manages every host and adds workers
  // (docs/multi_host_remote_plan.md).
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const [sshTagMenu, setSshTagMenu] = useState<{ x: number; y: number } | null>(null);

  // Import button's Files.../Folder... menu — same portal+backdrop pattern as
  // the SSH tag's context menu above.
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null);

  // Same hover card as the project pill, shown when hovering the project name
  // here — minus the type tags, which already sit beside the name below.
  const nameHover = useProjectHoverCard(project ?? undefined);
  const leftDockedPanel = containerClassName.includes("side-panel left");

  // The root scope's own tree (`~/tabtivity/root`): a real folder with no project
  // record behind it — no project.json, no git provider, no settings dialog — so
  // it is named for what it is rather than falling back to a bare "Files". The
  // check is the scope's, not "no project": a box scope has none either.
  const isRootScope = !project && !activeBox && scope === ROOT_SCOPE;

  const openInOsBrowser = () => {
    if (!projectDir) return;
    const sub = folder.replace(/^\/+|\/+$/g, "");
    const path = sub ? `${projectDir.replace(/\/+$/, "")}/${sub}` : projectDir;
    invoke("open_in_file_manager", { path }).catch((e) => console.error("open_in_file_manager", e));
  };

  // OS file drop → copy into the project, prompting on collisions. Confined to a
  // single project (a box scope has no single destination root). The whole
  // container is the drop zone, so a drop outside the files view lands at the
  // project root; inside it, on the browsed folder.
  const importDrop = useImportDrop({
    projectDir,
    enabled: !activeBox,
    destRel: view === "files" ? folder : "",
    // The tree auto-reloads via its fs-watch; refresh git so new untracked files
    // show in the status counts immediately.
    onImported: () => refreshGit(effectiveGitRoot),
  });

  // Refresh THIS scope's slice of the windows store (root/box scope included:
  // projectId null is a real scope holding its own null-project launches).
  useEffect(() => {
    if (active) {
      refresh(projectId ?? undefined);
    }
  }, [active, projectId]);

  useEffect(() => {
    if (active && effectiveGitRoot && !remoteBlocked) {
      refreshGit(effectiveGitRoot);
    } else if (!effectiveGitRoot || remoteBlocked) {
      // No repo to describe, or a remote pool that can't be asked — those are
      // real "we don't know" states, so the bar clears. Merely going inactive is
      // not: the counts stay put so the next reveal has something to show, and
      // the branch above refreshes them the moment it comes back.
      setGitStatus(null);
      setUnpushedCommits([]);
    }
  }, [active, effectiveGitRoot, remoteBlocked, gitContextKey]);

  // The counts are one `git status` reading; nothing above re-reads them when
  // the repo moves under the view (an agent's or a terminal's add/commit/
  // checkout), so a bar read mid-edit went on offering "Add 163" after the
  // tree was clean. Follow the file tree's `fs-change` (its watch covers the
  // repo's index/HEAD/refs, `fs_watch.rs`), and in the Git view — which mounts
  // no tree, and must not steal the backend's single watch slot from one shown
  // elsewhere — re-read on entry and on a slow poll while it is on screen.
  useEffect(() => {
    if (!active || !effectiveGitRoot || remoteBlocked) return;
    const root = effectiveGitRoot;
    const local = !project?.remote;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    if (local) {
      void listen("fs-change", () => refreshGit(root)).then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });
    }
    let poll: ReturnType<typeof setInterval> | null = null;
    if (view === "git") {
      refreshGit(root);
      if (local) {
        poll = setInterval(() => {
          if (document.visibilityState === "visible") refreshGit(root);
        }, GIT_VIEW_POLL_MS);
      }
    }
    return () => {
      cancelled = true;
      unlisten?.();
      if (poll) clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, effectiveGitRoot, remoteBlocked, project?.remote, view, gitContextKey]);

  // The gear dialog belongs to the project it was opened on; a project switch
  // reloads the filters under it, so close it rather than let it re-target.
  useEffect(() => {
    setShowSettings(false);
  }, [localFile, projectDir]);

  const handleAdd = async () => {
    if (!effectiveGitRoot) return;
    setGitBusy(true);
    setGitError(null);
    try {
      await invoke("git_add_all", { projectDir: effectiveGitRoot, ...gitWorktreeArgs(selectedGitWorktree) });
      refreshGit(effectiveGitRoot);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommitOpen = async () => {
    if (!effectiveGitRoot) return;
    setGitBusy(true);
    setGitError(null);
    try {
      const msg = await invoke<string>("git_generate_commit_message", { projectDir: effectiveGitRoot, ...gitWorktreeArgs(selectedGitWorktree) });
      setCommitMsg(msg);
      setTimeout(() => commitRef.current?.focus(), 50);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommitConfirm = async () => {
    if (!effectiveGitRoot || commitMsg === null) return;
    setGitBusy(true);
    setGitError(null);
    try {
      await invokeTrusted("git_commit", { projectDir: effectiveGitRoot, ...gitWorktreeArgs(selectedGitWorktree), message: commitMsg });
      setCommitMsg(null);
      refreshGit(effectiveGitRoot);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handlePush = async () => {
    if (!effectiveGitRoot) return;
    setGitBusy(true);
    setGitError(null);
    try {
      // On a nested repo, push to its own configured remote (no project id →
      // plain `git push`), not the project's GitHub/GitLab provider flow.
      await invokeTrusted("git_push", {
        projectDir: effectiveGitRoot,
        ...gitWorktreeArgs(selectedGitWorktree),
        projectId: onNestedRepo ? null : projectId ?? null,
      });
      refreshGit(effectiveGitRoot);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  // Release: tag the branch's pushed tip and push only that tag
  // (`services::git_release`). The dialog opens on the backend's suggestion;
  // anything that blocks a release right now (push first, tag exists) is
  // said instead of offered.
  const handleRelease = async () => {
    if (!effectiveGitRoot || onNestedRepo) return;
    setGitBusy(true);
    setGitError(null);
    let preview: GitReleasePreview;
    try {
      preview = await invokeTrusted<GitReleasePreview>("git_release_preview", { projectDir: effectiveGitRoot, ...gitWorktreeArgs(selectedGitWorktree), projectId: projectId ?? null });
    } catch (e) {
      setGitError(String(e));
      setGitBusy(false);
      return;
    }
    setGitBusy(false);
    if (preview.problem && preview.category !== "tag_exists") {
      await showMessage({ title: t("projectFilesView.releaseBlockedTitle"), body: preview.problem, error: true });
      return;
    }
    let done = "";
    const tag = await promptText({
      title: <>{t("projectFilesView.releaseDialogTitle")} <UntestedTag id="gitRelease" /></>,
      body: [
        t("projectFilesView.releaseBody", {
          sha: preview.head?.slice(0, 7) ?? "",
          subject: preview.subject?.replace(/^\S+\s/, "") ?? "",
          branch: preview.branch ?? "",
          url: preview.url ?? "",
        }),
        preview.source ? t("projectFilesView.releaseSource", { file: preview.source }) : t("projectFilesView.releaseCounted"),
        preview.problem ?? "",
      ].filter(Boolean).join("\n\n"),
      label: t("projectFilesView.releaseLabel"),
      initial: preview.suggested,
      confirmLabel: t("projectFilesView.releaseConfirm"),
      validate: (value) => (/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value.trim()) ? null : t("projectFilesView.releaseInvalid")),
    }, async (value) => {
      done = await invokeTrusted<string>("git_release_tag", { projectDir: effectiveGitRoot, ...gitWorktreeArgs(selectedGitWorktree), projectId: projectId ?? null, tag: value.trim() });
    });
    if (tag !== null && done) {
      refreshGit(effectiveGitRoot);
      await showMessage({ title: t("projectFilesView.releaseDoneTitle"), body: done });
    }
  };

  // Keep pending Git work visible from the Files view without keeping the
  // action controls in a separate header row. The colour matches the next
  // actionable step: add, then commit, then push.
  const gitPendingColor = !gitStatus?.is_repo
    ? null
    : gitStatus.unstaged + gitStatus.untracked > 0
      ? GIT_STATE_COLOR.modified
      : gitStatus.staged > 0
        ? GIT_STATE_COLOR.staged
        : unpushedCommits.length > 0
          ? GIT_STATE_COLOR.unpushed
          : null;

  return (
    <div
      className={`${containerClassName}${importDrop.dropActive ? " drop-active" : ""}${importDrop.dropFlash ? " drop-flash" : ""}`}
      style={containerStyle}
      {...containerProps}
      {...importDrop.handlers}
    >
      {resizeHandle}
      {importDrop.conflictModal}
      {dialogs}
      {/* Compact (docked subwindow) viewer: only the project-name/tags/source-
          switch/git-bar header is stripped — the tree's find-files search stays
          topmost. The Files/Git/Search/Apps toolbar (± diverged, sessions, jobs,
          import, open-in-OS, downloads, settings) renders in both modes, so a
          subwindow file viewer behaves identically to the side panel / Files
          (Project) tab except for that header row. */}
      {!compact && (
      <div className="side-panel-header">
        {pin}
        <span
          style={{
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: !activeBox && project ? "default" : undefined,
          }}
          onMouseEnter={
            !activeBox && project
              ? (e) => void nameHover.open(
                e.currentTarget.getBoundingClientRect(),
                leftDockedPanel ? "start" : "center",
              )
              : undefined
          }
          onMouseLeave={!activeBox && project ? () => nameHover.close() : undefined}
          // The root scope has no project to hover a card for, so what it is
          // rather than what it holds goes in the plain tooltip: the path, and
          // the one sentence saying this folder is the scratch area.
          title={isRootScope ? `${projectDir}\n${t("projectFilesView.rootScopeTitle")}` : undefined}
        >
          {activeBox ? (
            <>
              <HexagonIcon /> {activeBox.name}
            </>
          ) : project ? (
            project.name
          ) : isRootScope ? (
            `✦ ${t("projectFilesView.rootScopeName")}`
          ) : (
            t("projectFilesView.filesFallbackName")
          )}
        </span>
        {isRootScope && <UntestedTag id="projectFilesView.1" />}
        {!activeBox && project && (
          <ProjectHoverCard project={project} state={nameHover} showTags={false} />
        )}
        {/* Static project type tags (git / provider / SSH / scaffold). These are
            labels only — no interactivity — so they deliberately look nothing
            like the source switch below. */}
        {!activeBox && typeTags.length > 0 && (
          <span className="side-panel-type-tags">
            {typeTags.map((tag) => {
              // The SSH tag carries a right-click menu (connect / manage · remote
              // machines); the rest stay pure labels.
              const isSsh = tag.key === "ssh" && !!project?.remote && !!projectId;
              return (
                <span
                  key={tag.key}
                  className="pill-popup-tag"
                  title={
                    isSsh
                      ? `${tag.title}\n${t("projectFilesView.sshTagContextHint")}`
                      : tag.title
                  }
                  style={{
                    color: tag.color,
                    borderColor: tag.color,
                    background: `${tag.color}22`,
                    cursor: isSsh ? "context-menu" : undefined,
                  }}
                  onContextMenu={
                    isSsh
                      ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSshTagMenu({ x: e.clientX, y: e.clientY });
                        }
                      : undefined
                  }
                >
                  {tag.label}
                </span>
              );
            })}
          </span>
        )}
        {/* Per-project Tabtivity Mobile opt-in. Deliberately NOT shaped like the
            tag chips beside it: those are static labels, this one is a live
            switch, and a chip that looked like them would invite reading it as
            another fact about the project. It is the header's own icon-button
            family instead — square, hover-lit, phone slashed while off. */}
        {mobileHostConnected && mobileEligible && (
          <button
            type="button"
            className={`side-panel-mobile-btn${mobileAccessOn ? " on" : ""}`}
            disabled={mobileAccessBusy}
            aria-pressed={mobileAccessOn}
            aria-haspopup="menu"
            aria-label={t("projectFilesView.mobileAccessAria", { name: project?.name ?? "" })}
            title={
              mobileReach.kind === "all"
                ? t("projectFilesView.mobileAccessAllTitle")
                : mobileReach.kind === "some"
                  ? t("projectFilesView.mobileAccessSomeTitle", { phones: phoneReachLabel(mobileReach, t) })
                  : mobileReach.kind === "none"
                    ? t("projectFilesView.mobileAccessNoneTitle")
                    : t("projectFilesView.mobileAccessOffTitle")
            }
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMobilePicker({ x: r.left, y: r.bottom + 2 });
            }}
          >
            <MobileAccessIcon on={mobileAccessOn} />
          </button>
        )}
        {mobilePicker && mobileHostConnected && mobileEligible && (
          <MobileAccessPicker
            x={mobilePicker.x}
            y={mobilePicker.y}
            kind="project"
            enabled={mobileAccessOn}
            devices={mobileDevices}
            onApply={applyMobileAccess}
            onClose={() => setMobilePicker(null)}
          />
        )}
        {mobileAccessError && <ErrorNote className="side-panel-mobile-access-error" role="alert" error={mobileAccessError} />}
        {sshTagMenu && projectId && (
          <ContextMenuPortal
            x={sshTagMenu.x}
            y={sshTagMenu.y}
            onClose={() => setSshTagMenu(null)}
          >
              <div className="context-menu-group">
                <div className="context-menu-group-label">
                  {project?.remote?.host ?? t("projectFilesView.remoteFallback")}
                </div>
                {/* One unified hub: connect/manage every host (primary + workers)
                    and add a machine, all from "Remote machines…". */}
                <button
                  className="untested"
                  onClick={() => {
                    openRemoteMachines(projectId);
                    setSshTagMenu(null);
                  }}
                >
                  {t("projectFilesView.remoteMachinesEllipsis")}
                  <UntestedTag id="projectFilesView.2" />
                </button>
              </div>
          </ContextMenuPortal>
        )}
        {/* Remote/Local file-source switch (remote SSH projects only). A live
            segmented control — NOT a tag — that flips the files view between the
            host tree over SFTP ("Remote") and the synced mirror ("Local"). It's
            right-aligned and styled as a switch so it never reads as one of the
            static tags above. */}
        {!activeBox && project?.remote && projectId && (
          <>
          {/* Breaker: drop the switch onto its own row so it left-aligns with the
              pin/name (header padding edge) instead of trailing the tags. */}
          <span style={{ flexBasis: "100%", width: 0, height: 0 }} />
          <FileSourceSwitch source={source} onChange={setSource} />
          {/* Run-host picker — which REMOTE machine (primary or a worker) scripts
              and shells launched from this project run on, distinct from the source
              switch's read side. Deliberately absent on Local: there is only one
              local machine, so the control would have nothing to choose, and
              showing a machine name there would state the opposite of what happens
              (a Local-side ▶ runs in a local shell and the preference cannot
              overrule it — see `lib/terminal/pythonRun`'s `pythonRunPlan`). */}
          {source === "remote" && (
            <RunHostPicker
              projectId={projectId}
              primaryHost={project.remote.label || project.remote.host}
              computeHosts={project.compute_hosts}
            />
          )}
          {/* One-click SSH logout, shown while connected. Lives here (not on the
              project pill) so the pill stays status-only; the danger tint only
              appears on hover. */}
          {remoteSshState === "connected" && (
            <button
              type="button"
              className="side-panel-conn-logout"
              aria-label={t("projectFilesView.logoutAriaLabel", { host: project.remote.host })}
              title={t("projectFilesView.logoutTitle", {
                host: project.remote.host,
                vpn: project.remote.openvpn ? t("projectFilesView.logoutVpnSuffix") : "",
              })}
              onClick={() => logoutRemote(project)}
            >
              <span aria-hidden="true">⏻</span> {t("projectFilesView.logout")}
            </button>
          )}
          </>
        )}
      </div>
      )}

      {hidden}

      {/* Compact (docked subwindow) viewer strips the whole header above, which
          is where the Remote/Local source switch normally lives — but a remote
          project still needs it here to flip the tree between host and mirror.
          It gets its own row in the header's place: ABOVE the Files/Git/Search/
          Apps toolbar, so the compact viewer stacks source-switch → view row →
          content in the same order the side panel does. Deliberately NOT gated
          on the files view — the side panel's switch is always up, and a row
          that appeared only under "Files" would shove the toolbar up and down on
          every view change. */}
      {compact && !activeBox && project?.remote && projectId && (
        <div className="side-panel-source side-panel-source--compact">
          <FileSourceSwitch source={source} onChange={setSource} />
          {/* Remote side only, same reason as the full header's copy above — and
              this is the compact (docked subwindow) viewer, where the switch and
              the picker sit on one narrow row and a stale machine name beside a
              Local tag is at its most misleading. */}
          {source === "remote" && (
            <RunHostPicker
              projectId={projectId}
              primaryHost={project.remote.label || project.remote.host}
              computeHosts={project.compute_hosts}
            />
          )}
        </div>
      )}

      <div className="side-panel-toolbar">
        {/* Agents (#249): every agent tab of this scope that can carry
            schedules, plus the scope's collected prompts. Same row as Apps so
            the side panel and the Files tab offer it alike. */}
        {(["files", "git", "windows", "agents"] as View[]).map((v) => (
          <button
            key={v}
            className={`toolbar-btn toolbar-btn--sm${view === v ? " active" : ""}${v === "git" && gitPendingColor ? " toolbar-btn--flagged" : ""}`}
            style={{ marginLeft: v === "files" ? 0 : 2 }}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {t(
              v === "files"
                ? "projectFilesView.tabFiles"
                : v === "git"
                  ? "projectFilesView.tabGit"
                  : v === "agents"
                    ? "projectFilesView.tabAgents"
                    : "projectFilesView.tabApps",
            )}
            {v === "git" && gitPendingColor && (
              <span
                className="toolbar-btn-flag"
                style={{ backgroundColor: gitPendingColor }}
                aria-hidden="true"
              />
            )}
          </button>
        ))}
        {/* Orange (diverged) files: a dedicated toggle for remote projects,
            badged with the count so conflicts are visible at a glance. Auto-sync
            never touches these, so this is where they get resolved. The badge
            also counts NEW local-only files — a file the host has never seen is
            invisible in the remote tree, so this count is where its existence
            first shows up at all. */}
        {!activeBox && project?.remote && projectId && (
          <button
            className={`toolbar-btn toolbar-btn--sm side-panel-orange-btn${view === "orange" ? " active" : ""}`}
            style={{ marginLeft: 2 }}
            aria-pressed={view === "orange"}
            onClick={() => setView(view === "orange" ? "files" : "orange")}
            title={t("projectFilesView.divergedFilesTitle", {
              count: orangeFiles.length + newLocalFiles.length,
            })}
          >
            ± {orangeFiles.length + newLocalFiles.length > 0 && (
              <span className="side-panel-orange-count">
                {orangeFiles.length + newLocalFiles.length}
              </span>
            )}
          </button>
        )}
        {/* Persistent (tmux) sessions on the host (TODO #85): remote-only, badged
            with the live session count, so a run left alive on the host is one
            click from being reattached. */}
        {!activeBox && project?.remote && projectId && (
          <button
            className={`toolbar-btn toolbar-btn--sm side-panel-orange-btn${view === "sessions" ? " active" : ""}`}
            style={{ marginLeft: 2 }}
            aria-pressed={view === "sessions"}
            onClick={() => setView(view === "sessions" ? "files" : "sessions")}
            title={t("projectFilesView.persistentSessionsTitle", { count: sessionRows.length })}
          >
            ☰ {sessionRows.length > 0 && <span className="side-panel-orange-count">{sessionRows.length}</span>}
          </button>
        )}
        {/* SLURM jobs (HPC): shown only when the host actually has SLURM, so the
            toggle never appears off-cluster. Badged with the live queue count. */}
        {!activeBox && slurmSupported && projectId && (
          <button
            className={`toolbar-btn toolbar-btn--sm side-panel-orange-btn${view === "jobs" ? " active" : ""}`}
            style={{ marginLeft: 2 }}
            aria-pressed={view === "jobs"}
            onClick={() => setView(view === "jobs" ? "files" : "jobs")}
            title={t("projectFilesView.slurmJobsTitle", { count: jobRows.length })}
          >
            <GearIcon /> {jobRows.length > 0 && <span className="side-panel-orange-count">{jobRows.length}</span>}
          </button>
        )}
        {!activeBox && remarksEnabled && projectId && (
          <button
            className={`toolbar-btn toolbar-btn--sm side-panel-orange-btn${view === "remarks" ? " active" : ""}`}
            style={{ marginLeft: 2 }}
            aria-pressed={view === "remarks"}
            onClick={() => setView(view === "remarks" ? "files" : "remarks")}
            title={t("projectRemarks.view")}
          >
            <CommentIcon />
          </button>
        )}
        {!activeBox && devTodo && (
          <button
            className={`toolbar-btn toolbar-btn--sm side-panel-orange-btn${view === "todo" ? " active" : ""}`}
            style={{ marginLeft: 2 }}
            aria-pressed={view === "todo"}
            onClick={() => setView(view === "todo" ? "files" : "todo")}
            title={t("devTodo.viewTitle")}
            aria-label={t("devTodo.viewTitle")}
          >
            <CheckIcon />
          </button>
        )}
        {/* The tree's search + refresh, hoisted out of the tree itself. Files
            view only: both act on the tree, and the tree is only mounted there
            (a ↻ in the Git view would bump a counter nothing is listening to).
            Same chrome as every other toolbar button — see `toolbar-btn`. */}
        {view === "files" && (
          <button
            className={`toolbar-btn toolbar-btn--sm${searchOpen ? " active" : ""}`}
            style={{ marginLeft: 2 }}
            aria-pressed={searchOpen}
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
            title={searchOpen ? t("fileTree.hideSearch") : t("fileTree.showSearch")}
            aria-label={searchOpen ? t("fileTree.hideSearch") : t("fileTree.showSearch")}
          >
            <SearchIcon />
          </button>
        )}
        {view === "files" && (
          <button
            className="toolbar-btn toolbar-btn--sm"
            style={{ marginLeft: 2 }}
            onClick={() => setRefreshNonce((n) => n + 1)}
            title={t("fileTree.refreshTitle")}
            aria-label={t("common.refresh")}
          >
            ↻
          </button>
        )}
        {importDrop.canImport && (
          <button
            className="toolbar-btn toolbar-btn--sm"
            style={{ marginLeft: 2 }}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setImportMenu({ x: r.left, y: r.bottom + 2 });
            }}
            title={t("projectFilesView.importTitle")}
          >
            <ArrowDownIcon />
          </button>
        )}
        {importMenu && (
          <ContextMenuPortal
            x={importMenu.x}
            y={importMenu.y}
            onClose={() => setImportMenu(null)}
          >
              <button
                onClick={() => {
                  setImportMenu(null);
                  void importDrop.importViaDialog();
                }}
              >
                {t("projectFilesView.importFiles")}
              </button>
              <button
                onClick={() => {
                  setImportMenu(null);
                  void importDrop.importFolderViaDialog();
                }}
              >
                {t("projectFilesView.importFolder")}
              </button>
          </ContextMenuPortal>
        )}
        {projectDir && (
          <button
            className="toolbar-btn toolbar-btn--sm"
            style={{ marginLeft: 2 }}
            onClick={openInOsBrowser}
            title={t("projectFilesView.openInFileManagerTitle")}
          >
            ⧉
          </button>
        )}
        {!activeBox && projectDir && (
          <button
            className={`toolbar-btn toolbar-btn--sm${showDownloads ? " active" : ""}`}
            style={{ marginLeft: 2 }}
            aria-pressed={showDownloads}
            onClick={() => {
              setShowDownloads((v) => !v);
              // The section lives in the files view; jump there when revealing it.
              if (!showDownloads) setView("files");
            }}
            title={t("projectFilesView.showDownloadsTitle")}
          >
            <InboxIcon />
          </button>
        )}
        {/* The Alerts group's 🔔 used to sit here, between 📥 and ⚙. It is now the
            header's (`header/AlertsToggle`), beside the ☑ board: `files_alerts`
            is one machine-wide setting and the group draws the same rows in
            every project, so a per-project toolbar rendered one switch once per
            open file viewer and made a global thing look like this project's.
            The group itself stays below the tree — only its switch moved. */}
        {projectId && (
          <button
            className="toolbar-btn toolbar-btn--sm"
            style={{ marginLeft: 2 }}
            onClick={() => setShowSettings(true)}
            title={t("projectFilesView.projectSettingsTitle")}
          >
            <GearIcon />
          </button>
        )}
      </div>

      {/* The workspace clock. A workspace expiry does not merely delete "some
          data" — for a project whose root lives in one it deletes the host tree,
          repo included. So the warning is raised wherever the user is (every
          view, not just Jobs), states the two actions that answer it, and is
          dismissible only until the number changes. */}
      {warnExpiry && projectWs && (
        <div className={`hpc-expiry-banner tone-${expiryTone(projectWs)}`}>
          <span>
            {t("projectFilesView.expiryPre")} <strong>{projectWs.id}</strong> — {remainingLabel(projectWs)}.{" "}
            {t("projectFilesView.expiryPost")}
          </span>
          <div className="hpc-expiry-actions">
            <button type="button" onClick={() => void extendWs(projectWs)}>
              {t("projectFilesView.extendEllipsis")}
            </button>
            <button type="button" onClick={() => setView("jobs")}>
              {t("projectFilesView.workspaces")}
            </button>
            <button
              type="button"
              title={t("projectFilesView.dismissExpiryTitle")}
              onClick={() => setExpiryDismissed(`${projectWs.id}:${projectWs.remaining_days}`)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {view === "git" && (
        <>
        <div className="side-panel-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {nestedRoot && (
            <div className="nested-repo-toggle" role="group" aria-label={t("projectFilesView.gitRepositoryAriaLabel")}>
              <button
                type="button"
                className={`nested-repo-pill${!onNestedRepo ? " active" : ""}`}
                title={projectDir}
                onClick={() => setPreferProjectRepo(true)}
              >
                {project?.name || t("projectFilesView.projectFallback")}
              </button>
              <button
                type="button"
                className={`nested-repo-pill${onNestedRepo ? " active" : ""}`}
                title={nestedRoot}
                onClick={() => setPreferProjectRepo(false)}
              >
                {basename(nestedRoot) || nestedRoot}
              </button>
            </div>
          )}
          <GitHistory
            projectDir={effectiveGitRoot}
            projectId={onNestedRepo ? undefined : project?.remote ? projectId ?? undefined : undefined}
            remote={!onNestedRepo && !!project?.remote}
            authProjectId={onNestedRepo ? undefined : projectId ?? undefined}
            onChanged={() => effectiveGitRoot && refreshGit(effectiveGitRoot)}
            onWorktreeChanged={onGitWorktreeChanged}
            actionsBusy={gitBusy || commitMsg !== null}
            connected={active && !remoteBlocked}
            pullRequest={pullRequest}
          />
        </div>
        {/* Add / Commit / Push live at the FOOT of the panel, below the history
            they act on — the same place every other "do it" control in the app
            sits, and out of the scroll area so they stay reachable however far
            down the log you are. The commit box is rendered above the buttons
            for that reason too: the footer grows upward, so the confirm stays
            the bottom-most thing. Its change-tree popover opens upward
            (`.git-action-bar` in files-panel.css). */}
        {!activeBox && gitStatus?.is_repo && (
          <div ref={actionBarRef} className="git-action-bar">
            {commitMsg !== null && (
              <textarea
                ref={commitRef}
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                rows={7}
                className="git-commit-input"
              />
            )}
            {commitMsg !== null ? (
              <>
                <button className="git-action-btn git-action-btn--commit" disabled={gitBusy} onClick={handleCommitConfirm} title={t("projectFilesView.confirmCommitTitle")}>
                  <span data-testid="commit-bar" className="git-step-dot" style={{ background: GIT_STATE_COLOR.staged }} />
                  <span className="git-btn-glyph">↵</span><span className="git-btn-label">{t("projectFilesView.confirm")}</span>
                </button>
                <button className="git-action-btn git-action-btn--back" disabled={gitBusy} onClick={() => setCommitMsg(null)} title={t("projectFilesView.goBackTitle")}>
                  <span className="git-btn-glyph">←</span><span className="git-btn-label">{t("projectFilesView.back")}</span>
                </button>
              </>
            ) : (
              <>
                {gitStatus.unstaged + gitStatus.untracked > 0 && (
                  <div className="git-action git-action--add">
                    <button className="git-action-btn git-action-btn--add" disabled={gitBusy} onClick={handleAdd} title={t("projectFilesView.stageAllTitle", { count: gitStatus.unstaged + gitStatus.untracked })}>
                      <span data-testid="add-bar" className="git-step-dot" style={{ background: GIT_STATE_COLOR.modified }} />
                      <span className="git-btn-glyph">⊕</span><span className="git-btn-label">{t("projectFilesView.add", { count: gitStatus.unstaged + gitStatus.untracked })}</span>
                    </button>
                    <button className="git-action-toggle" disabled={gitBusy} aria-label={t("projectFilesView.showChangedFiles")} aria-expanded={openTree === "add"} title={t("projectFilesView.showChangedFiles")} onClick={() => setOpenTree((prev) => (prev === "add" ? null : "add"))}>
                      {openTree === "add" ? "▾" : "▴"}
                    </button>
                  </div>
                )}
                {gitStatus.staged > 0 && (
                  <div className="git-action git-action--commit">
                    <button className="git-action-btn git-action-btn--commit" disabled={gitBusy} onClick={handleCommitOpen} title={t("projectFilesView.commitStagedTitle", { count: gitStatus.staged })}>
                      <span data-testid="commit-bar" className="git-step-dot" style={{ background: GIT_STATE_COLOR.staged }} />
                      <span className="git-btn-glyph"><CheckIcon /></span><span className="git-btn-label">{t("projectFilesView.commit", { count: gitStatus.staged })}</span>
                    </button>
                    <button className="git-action-toggle" disabled={gitBusy} aria-label={t("projectFilesView.showStagedFiles")} aria-expanded={openTree === "commit"} title={t("projectFilesView.showStagedFiles")} onClick={() => setOpenTree((prev) => (prev === "commit" ? null : "commit"))}>
                      {openTree === "commit" ? "▾" : "▴"}
                    </button>
                  </div>
                )}
                {unpushedCommits.length > 0 && (
                  <div className="git-action git-action--push">
                    <button className="git-action-btn git-action-btn--push" disabled={gitBusy} onClick={handlePush} title={t(unpushedCommits.length === 1 ? "projectFilesView.pushCommitOneTitle" : "projectFilesView.pushCommitManyTitle", { count: unpushedCommits.length })}>
                      <span data-testid="push-bar" className="git-step-dot" style={{ background: GIT_STATE_COLOR.unpushed }} />
                      <span className="git-btn-glyph"><ArrowUpIcon /></span><span className="git-btn-label">{t("projectFilesView.push", { count: unpushedCommits.length })}</span>
                    </button>
                    <button className="git-action-toggle" disabled={gitBusy} aria-label={t("projectFilesView.showUnpushedFiles")} aria-expanded={openTree === "push"} title={t("projectFilesView.showUnpushedFiles")} onClick={() => setOpenTree((prev) => (prev === "push" ? null : "push"))}>
                      {openTree === "push" ? "▾" : "▴"}
                    </button>
                  </div>
                )}
                {/* No caret, so no `.git-action` group: the preview it opens is
                    GitHistory's pull panel, above. */}
                {(gitStatus.behind ?? 0) > 0 && (
                  <button
                    className="git-action-btn git-action-btn--pull"
                    disabled={gitBusy}
                    onClick={() => setPullRequest((n) => n + 1)}
                    title={t("projectFilesView.pullTitle", { count: gitStatus.behind ?? 0 })}
                  >
                    <span className="git-btn-glyph"><ArrowDownIcon /></span><span className="git-btn-label">{t("projectFilesView.pull", { count: gitStatus.behind ?? 0 })}</span>
                  </button>
                )}
                {/* Release: only once everything is pushed and nothing is
                    incoming, on a local project's own repo, and not when the
                    tip already carries a tag. */}
                {!onNestedRepo && !project?.remote && gitStatus.has_remote && !gitStatus.head_tagged && unpushedCommits.length === 0 && (gitStatus.behind ?? 0) === 0 && (
                  <button className="git-action-btn git-action-btn--release" disabled={gitBusy} onClick={() => void handleRelease()} title={t("projectFilesView.releaseTitle")}>
                    <span className="git-btn-glyph"><TagIcon /></span><span className="git-btn-label">{t("projectFilesView.release")}</span>
                    <UntestedTag id="gitRelease" />
                  </button>
                )}
                {treeScope && projectDir && <GitChangeTree projectDir={effectiveGitRoot} worktree={selectedGitWorktree} scope={treeScope} />}
              </>
            )}
            {gitError && <ErrorNote className="git-action-error" error={gitError} />}
            {/* An agent's push request for this project (`services::git_push_mcp`):
                the card that approves or dismisses it, beside the user's own Push. */}
            {!onNestedRepo && <GitPushProposals projectId={projectId} />}
          </div>
        )}
        </>
      )}

      {view === "orange" && (
        <div className="side-panel-scroll side-panel-orange" style={{ flex: 1, overflowY: "auto" }}>
          {orangeFiles.length === 0 && newLocalFiles.length === 0 ? (
            <div className="side-panel-orange-empty">{t("projectFilesView.noDivergedFiles")}</div>
          ) : (
            <>
              {/* Bulk "…for all" resolution: take one side for every diverged
                  file at once. Both are destructive to the losing side — and by
                  definition every file here has content on BOTH sides — so each
                  goes through the shared transfer confirmation, which names the
                  losing files rather than only counting them. Header + icon
                  buttons (not a text button per row) so the bar stays compact. */}
              {orangeFiles.length > 0 && (
              <div className="orange-bulk-bar">
                <span className="orange-bulk-count">
                  {t("projectFilesView.divergedCount", { count: orangeFiles.length })}
                </span>
                <UntestedTag id="projectFilesView.3" />
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--remote"
                    aria-label={t("projectFilesView.takeRemoteAllAria")}
                    title={t("projectFilesView.takeRemoteAllTitle")}
                    disabled={remoteBlocked}
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "pull",
                          relPath: "",
                          isDir: true,
                          label: project?.name ?? projectId,
                          relPaths: orangeFiles,
                          force: true,
                        });
                        if (!ok) return;
                        await useSyncStore
                          .getState()
                          .resolveAll(projectId, orangeFiles, "host");
                      })();
                    }}
                  >
                    <ArrowDownIcon />
                  </button>
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--local"
                    aria-label={t("projectFilesView.keepLocalAllAria")}
                    title={t("projectFilesView.keepLocalAllTitle")}
                    disabled={remoteBlocked}
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "push",
                          relPath: "",
                          isDir: true,
                          label: project?.name ?? projectId,
                          relPaths: orangeFiles,
                          force: true,
                        });
                        if (!ok) return;
                        await useSyncStore
                          .getState()
                          .resolveAll(projectId, orangeFiles, "local");
                      })();
                    }}
                  >
                    <ArrowUpIcon />
                  </button>
                </div>
              </div>
              )}
              {orangeFiles.map((rel) => {
                const rowHostMtime = syncMap?.[rel]?.hostMtime;
                const rowLocalMtime = syncMap?.[rel]?.localMtime;
                const rowHostChecked = syncMap?.[rel]?.hostChecked ?? false;
                const mtimeCue = mtimeDivergenceCue(
                  t,
                  rowHostMtime,
                  rowLocalMtime,
                  syncMap?.[rel]?.hostDiverged ?? false,
                  syncMap?.[rel]?.localDiverged ?? false,
                  rowHostChecked,
                );
                // "Remote only" / "Local only": the other side has no file at
                // all, so the action that would act on it is a no-op — disable
                // it rather than leave a button that errors when clicked. What a
                // one-sided deletion gets INSTEAD is the 🗑 action below: the
                // arrows can only undo the deletion (restore the gone side from
                // the surviving copy), so without it a file deleted locally kept
                // resurrecting from the host however often it was deleted.
                const noHostFile = rowHostMtime == null;
                const noLocalFile = rowLocalMtime == null;
                // Which side a 🗑 would delete: the surviving copy of a file
                // deleted on exactly one side. Deleting the mirror copy is only
                // offered when the host was actually consulted and positively
                // reported the file gone (`hostChecked`) — a cold pool reports
                // every host mtime as null without asking. The backend re-verifies
                // either premise against live state before deleting anything.
                const deleteSide: "host" | "local" | null =
                  noLocalFile && !noHostFile
                    ? "host"
                    : noHostFile && !noLocalFile && rowHostChecked
                      ? "local"
                      : null;
                // Deleted on BOTH sides since the last sync: nothing to
                // transfer, nothing to merge — the only sensible action left is
                // to stop tracking the entry.
                const goneBoth = noHostFile && noLocalFile;
                return (
                  <div key={rel} className="orange-file-row" title={rel}>
                <button
                  type="button"
                  className="orange-file-name"
                  disabled={!mirrorRoot || goneBoth}
                  title={mirrorRoot && !goneBoth ? t("projectFilesView.openFileTitle", { rel }) : rel}
                  onClick={() => {
                    if (!mirrorRoot) return;
                    const abs = `${mirrorRoot}/${rel}`;
                    // Open the diverged file in the three-way merge viewer
                    // (local mirror ⇄ merged ⇄ remote host, PyCharm-style), so
                    // the user can take changes from either side per block and
                    // resolve the divergence in one place.
                    openLinkedFile(undefined, dirname(abs), {
                      path: abs,
                      viewer: "syncmerge",
                      label: basename(abs),
                    });
                  }}
                >
                  <span className="orange-file-dot" aria-hidden="true">±</span>
                  {rel}
                </button>
                {mtimeCue && (
                  <span
                    className={`orange-mtime-badge orange-mtime-badge--${mtimeCue.tone}`}
                    title={mtimeCue.title}
                  >
                    {mtimeCue.text}
                  </span>
                )}
                {goneBoth ? (
                  <div className="orange-file-actions">
                    {/* Deselecting drops the row to state "none" immediately and
                        stops tracking; the manifest keeps an inert unselected
                        marker (the backend prune only runs for entries still
                        selected). No transfer, nothing deleted. */}
                    <button
                      type="button"
                      className="orange-file-act"
                      title={t(
                        rowHostChecked
                          ? "projectFilesView.forgetFileTitle"
                          : "projectFilesView.forgetFileUncheckedTitle",
                      )}
                      onClick={() => {
                        if (projectId)
                          void useSyncStore.getState().markSelected(projectId, [rel], false, false);
                      }}
                    >
                      {t("projectFilesView.forgetFile")}
                    </button>
                  </div>
                ) : (
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--remote"
                    aria-label={t("projectFilesView.takeRemoteAria")}
                    title={t(noHostFile ? "projectFilesView.noRemoteCopyTitle" : "projectFilesView.takeRemoteTitle")}
                    disabled={remoteBlocked || noHostFile}
                    // Per-row take-a-side: the other side's copy of this file is
                    // gone the moment it runs, and this row exists precisely
                    // because both sides hold something. Ask, naming the file.
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "pull",
                          relPath: rel,
                          isDir: false,
                          label: basename(rel) || rel,
                          force: true,
                        });
                        if (ok) await useSyncStore.getState().pull(projectId, rel);
                      })();
                    }}
                  >
                    <ArrowDownIcon />
                  </button>
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--local"
                    aria-label={t("projectFilesView.keepLocalAria")}
                    title={t(noLocalFile ? "projectFilesView.noLocalCopyTitle" : "projectFilesView.keepLocalTitle")}
                    disabled={remoteBlocked || noLocalFile}
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "push",
                          relPath: rel,
                          isDir: false,
                          label: basename(rel) || rel,
                          force: true,
                        });
                        if (ok) await useSyncStore.getState().push(projectId, rel, true);
                      })();
                    }}
                  >
                    <ArrowUpIcon />
                  </button>
                  {deleteSide && (
                    <button
                      type="button"
                      className="orange-file-act orange-file-act--icon orange-file-act--delete"
                      aria-label={t(
                        deleteSide === "host"
                          ? "projectFilesView.deleteHostAria"
                          : "projectFilesView.deleteLocalAria",
                      )}
                      title={t(
                        deleteSide === "host"
                          ? "projectFilesView.deleteHostTitle"
                          : "projectFilesView.deleteLocalTitle",
                      )}
                      disabled={remoteBlocked}
                      // Complete the deletion instead of undoing it: delete the
                      // surviving copy on the other side. Destroys the file's
                      // LAST copy anywhere, so it goes through the shared sync
                      // confirm dialog's delete variant, which says exactly that.
                      onClick={() => {
                        if (!projectId) return;
                        void (async () => {
                          const ok = await confirmSyncTransfer({
                            projectId,
                            deleteSide,
                            relPath: rel,
                            isDir: false,
                            label: basename(rel) || rel,
                          });
                          if (ok)
                            await useSyncStore
                              .getState()
                              .applyDelete(projectId, rel, deleteSide);
                        })();
                      }}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
                )}
                  </div>
                );
              })}
              {/* NEW local-only files: exist in the mirror, never synced, so
                  the host has no copy. A section of its own rather than rows in
                  the amber list above, because the vocabulary differs — nothing
                  to merge, no remote side to take, no deletion to complete; the
                  whole offer is "upload" (or leave it local). Without this
                  section such a file was invisible everywhere: the remote tree
                  lists the host's readdir, and the amber list only knows files
                  the manifest has seen. */}
              {newLocalFiles.length > 0 && (
                <>
                  <div className="orange-bulk-bar">
                    <span className="orange-bulk-count">
                      {t("projectFilesView.newLocalCount", { count: newLocalFiles.length })}
                    </span>
                    <UntestedTag id="projectFilesView.4" />
                    <div className="orange-file-actions">
                      <button
                        type="button"
                        className="orange-file-act orange-file-act--icon orange-file-act--local"
                        aria-label={t("projectFilesView.uploadNewAllAria")}
                        title={t("projectFilesView.uploadNewAllTitle")}
                        disabled={remoteBlocked}
                        onClick={() => {
                          if (!projectId) return;
                          void (async () => {
                            const ok = await confirmSyncTransfer({
                              projectId,
                              direction: "push",
                              relPath: "",
                              isDir: true,
                              label: project?.name ?? projectId,
                              relPaths: newLocalFiles,
                            });
                            if (!ok) return;
                            await useSyncStore
                              .getState()
                              .resolveAll(projectId, newLocalFiles, "local");
                          })();
                        }}
                      >
                        <ArrowUpIcon />
                      </button>
                    </div>
                  </div>
                  {newLocalFiles.map((rel) => (
                    <div key={rel} className="orange-file-row" title={rel}>
                      <button
                        type="button"
                        className="orange-file-name"
                        disabled={!mirrorRoot}
                        title={
                          mirrorRoot
                            ? t("projectFilesView.openFileTitle", { rel })
                            : rel
                        }
                        onClick={() => {
                          if (!mirrorRoot) return;
                          const abs = `${mirrorRoot}/${rel}`;
                          // Plain open (no merge viewer): there is no host copy
                          // to merge against — this is just the local file.
                          openLinkedFile(undefined, dirname(abs), {
                            path: abs,
                            viewer: viewerForPath(abs),
                            label: basename(abs),
                          });
                        }}
                      >
                        <span className="orange-file-dot orange-file-dot--new" aria-hidden="true">
                          +
                        </span>
                        {rel}
                      </button>
                      <div className="orange-file-actions">
                        <button
                          type="button"
                          className="orange-file-act orange-file-act--icon orange-file-act--local"
                          aria-label={t("projectFilesView.uploadNewAria")}
                          title={t("projectFilesView.uploadNewTitle")}
                          disabled={remoteBlocked}
                          onClick={() => {
                            if (!projectId) return;
                            void (async () => {
                              const ok = await confirmSyncTransfer({
                                projectId,
                                direction: "push",
                                relPath: rel,
                                isDir: false,
                                label: basename(rel) || rel,
                              });
                              if (ok) await useSyncStore.getState().push(projectId, rel);
                            })();
                          }}
                        >
                          <ArrowUpIcon />
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {view === "sessions" && (
        <div className="side-panel-scroll side-panel-orange" style={{ flex: 1, overflowY: "auto" }}>
          {!remoteBlocked && (
            <label
              className="tmux-scope-toggle"
              title={t("projectFilesView.tmuxScopeOff") + t("projectFilesView.tmuxScopeOn")}
            >
              <input
                type="checkbox"
                checked={showAllSessions}
                onChange={(e) => setShowAllSessions(e.target.checked)}
              />
              {t("projectFilesView.allHostSessions")}
            </label>
          )}
          {sessionRows.length === 0 ? (
            <div className="side-panel-orange-empty">
              {t(
                remoteBlocked
                  ? "projectFilesView.connectToListSessions"
                  : showAllSessions
                    ? "projectFilesView.noSessionsOnHosts"
                    : "projectFilesView.noSessionsForProject",
              )}
            </div>
          ) : (
            sessionGroups.map(({ hostId, hostLabel, kindGroups }) => (
              <section
                className="tmux-machine-group"
                key={hostId}
                aria-label={t("projectFilesView.persistentSessionsOnHostAria", { host: hostLabel })}
              >
                <div className="tmux-machine-group-title">{hostLabel}</div>
                {kindGroups.map(({ kind, rows }) => (
                  <div className="tmux-kind-group" key={kind}>
                    <div className="tmux-kind-group-title">{t(SESSION_KIND_LABEL[kind])}</div>
                    {rows.map(({ session: s }) => {
                      const owned = sessionOwners.has(`${hostId} ${s.name}`);
                      return (
                        <div
                          key={`${hostId} ${s.name}`}
                          className="orange-file-row"
                          onMouseEnter={(e) => handleSessionRowMouseEnter(e, hostId, s.name)}
                          onMouseLeave={handleSessionRowMouseLeave}
                        >
                          <button
                            type="button"
                            className="orange-file-name"
                            title={t(
                              owned ? "projectFilesView.revealTabRunning" : "projectFilesView.attachTo",
                              { name: s.name },
                            )}
                            onClick={() => openSession(hostId, s.name)}
                          >
                            <span className="orange-file-dot" aria-hidden="true">
                              {s.attached ? "●" : "○"}
                            </span>
                            {s.working && (
                              <span className="tmux-work-dot" aria-hidden="true" title={t("projectFilesView.workingTitle")} />
                            )}
                            <span className="tmux-session-label">{sessionDisplayName(t, s.name)}</span>
                            {owned && <span className="tmux-session-meta">{t("projectFilesView.openMeta")}</span>}
                          </button>
                          <div className="orange-file-actions">
                            <button
                              type="button"
                              className="orange-file-act"
                              title={t("projectFilesView.renameSessionTitle")}
                              onClick={() => void renameSession(hostId, s.name)}
                            >
                              {t("projectFilesView.rename")}
                            </button>
                            <button
                              type="button"
                              className="orange-file-act"
                              title={t("projectFilesView.killSessionTitle")}
                              aria-label={t("projectFilesView.killSessionAria", { name: s.name })}
                              onClick={() => void killSession(hostId, s.name)}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
      )}
      {sessionTooltip && (() => {
        const statsRow = sessionRows.find(
          (r) => r.hostId === sessionTooltip.hostId && r.session.name === sessionTooltip.name,
        );
        if (!statsRow) return null;
        const s = statsRow.session;
        const owned = sessionOwners.has(`${statsRow.hostId} ${s.name}`);
        // Same side-picking + vertical-shift positioning as FileTree's `.file-tooltip`:
        // opens toward whichever side of the row has more room, and is pulled up if
        // it would otherwise overflow the window's bottom edge.
        const style: React.CSSProperties =
          window.innerWidth - sessionTooltip.rect.right > sessionTooltip.rect.left
            ? { left: sessionTooltip.rect.right + 8, top: sessionTooltip.rect.top - sessionTooltipShift }
            : { right: window.innerWidth - sessionTooltip.rect.left + 8, top: sessionTooltip.rect.top - sessionTooltipShift };
        return createPortal(
          <div ref={sessionTooltipRef} className="file-tooltip" style={style}>
            <div className="file-tooltip-name">
              {s.name}
              <UntestedTag id="projectFilesView.5" />
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipHost")}</span>
              {statsRow.hostLabel}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipStatus")}</span>
              {s.working
                ? t("projectFilesView.tooltipWorking", { command: s.currentCommand })
                : t("projectFilesView.tooltipIdle")}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipUptime")}</span>
              {t("projectFilesView.tooltipSince", {
                duration: relativeDuration(s.created),
                when: absoluteTime(s.created),
              })}
            </div>
            <div>
              <span className="file-tooltip-label">
                {t(s.working ? "projectFilesView.tooltipActive" : "projectFilesView.tooltipIdleFor")}
              </span>
              {s.working ? t("projectFilesView.tooltipNow") : relativeDuration(s.activity)}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipWindows")}</span>
              {s.windows}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipAttached")}</span>
              {t(s.attached ? "common.yes" : "common.no")}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipOpenInTab")}</span>
              {t(owned ? "common.yes" : "common.no")}
            </div>
          </div>,
          document.body,
        );
      })()}

      {view === "jobs" && (
        <div className="side-panel-scroll side-panel-orange" style={{ flex: 1, overflowY: "auto" }}>
          <div className="side-panel-jobs-head">
            <UntestedTag id="projectFilesView.6" />
          </div>
          {wsRows.length > 0 && (
            <>
              <div className="side-panel-orange-note">
                {t("projectFilesView.workspacesNote")}
                {project?.hpc?.logs_dir && (
                  <button
                    type="button"
                    className="orange-file-act"
                    title={t("projectFilesView.pullLogsTitle", { dir: project.hpc.logs_dir })}
                    onClick={() => void pullProjectLogs()}
                  >
                    {t("projectFilesView.pullLogs")}
                  </button>
                )}
              </div>
              {wsRows.map((ws) => {
                const here = projectWs?.id === ws.id && projectWs?.path === ws.path;
                return (
                  <div key={`${ws.filesystem ?? ""}/${ws.id}`} className="orange-file-row" title={ws.path}>
                    <span className="orange-file-name" style={{ cursor: "var(--cur-default, default)" }}>
                      <span className="orange-file-dot" aria-hidden="true">{here ? "●" : "○"}</span>
                      {ws.id}
                      <span className={`tmux-session-meta hpc-ws-remaining tone-${expiryTone(ws)}`}>
                        {[
                          here ? t("projectFilesView.thisProject") : "",
                          ws.filesystem ?? "",
                          remainingLabel(ws),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <div className="orange-file-actions">
                      <button
                        type="button"
                        className="orange-file-act"
                        title={t("projectFilesView.extendWorkspaceTitle")}
                        onClick={() => void extendWs(ws)}
                      >
                        {t("projectFilesView.extend")}
                      </button>
                      {!here && project?.remote && (
                        <button
                          type="button"
                          className="orange-file-act"
                          disabled={wsBusy}
                          title={t("projectFilesView.moveHereTitle")}
                          onClick={() => void moveProjectTo(ws)}
                        >
                          {t("projectFilesView.moveHere")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {jobRows.length === 0 ? (
            <div className="side-panel-orange-empty">
              {t(
                remoteBlocked
                  ? "projectFilesView.connectToListJobs"
                  : "projectFilesView.noQueuedJobs",
              )}
            </div>
          ) : (
            jobRows.map((j) => (
              <div key={j.id} className="orange-file-row" title={`${j.id} ${j.name}`}>
                <button
                  type="button"
                  className="orange-file-name"
                  title={t("projectFilesView.watchJobTitle", { id: j.id })}
                  onClick={() => void watchJob(j.id, j.name)}
                >
                  <span className="orange-file-dot" aria-hidden="true">
                    {j.state === "RUNNING" ? "●" : "○"}
                  </span>
                  {j.name || j.id}
                  <span className="tmux-session-meta">
                    {j.id} · {j.state}
                    {j.time ? ` · ${j.time}` : ""}
                    {j.nodes ? ` · ${j.nodes} node${j.nodes === "1" ? "" : "s"}` : ""}
                    {j.reason && j.reason !== "(None)" ? ` · ${j.reason}` : ""}
                  </span>
                </button>
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act"
                    title={t("projectFilesView.watchJobTitle", { id: j.id })}
                    onClick={() => void watchJob(j.id, j.name)}
                  >
                    {t("projectFilesView.watch")}
                  </button>
                  <button
                    type="button"
                    className="orange-file-act"
                    title={t("projectFilesView.cancelJobTitle")}
                    aria-label={t("projectFilesView.cancelJobAria", { id: j.id })}
                    onClick={() => void cancelJob(j.id, j.name)}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {view === "files" && (
        <ProjectFilesPane
          scope={scope}
          project={project}
          projectDir={projectDir}
          folder={folder}
          onFolderChange={onFolderChange}
          active={active}
          source={source}
          hiddenEndings={filters.hiddenEndings}
          hiddenPaths={filters.hiddenPaths}
          shownPaths={filters.shownPaths}
          scanExcluded={filters.scanExcluded}
          onToggleScanExcluded={filters.toggleScanExcluded}
          separateScaffold={filters.separateScaffold}
          separateGitignored={filters.separateGitignored}
          sortKey={sortKey}
          descending={descending}
          onSortChange={(key, desc) => {
            setSortKey(key);
            setDescending(desc);
          }}
          showDownloads={showDownloads}
          onCloseDownloads={() => setShowDownloads(false)}
          // The host's frame footer belongs to the panel, not to the global
          // Alerts group stacked below, so in the files view the pane places it
          // ABOVE that group — every other view renders it at the bottom, and
          // the group follows it there too.
          frameFooter={footer}
          // Right-click → "Open in a new tab": the same file view, on that
          // folder, as a Files (Project) tab in this project's scope.
          onOpenFolderTab={onOpenFolderTab}
          // A closed panel keeps no tree mounted (and so no fs-watch).
          mountTree={mountTree}
          compact={compact}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          refreshNonce={refreshNonce}
        />
      )}
      {view === "remarks" && projectId && (
        <RemarksPane projectId={projectId} projectDir={projectDir} visible={active} />
      )}

      {view === "todo" && <DevTodoView active={active} />}

      {view === "agents" && <AgentSchedulesView scope={scope} active={active} />}

      {view === "windows" && (
        <div className="side-panel-scroll" style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          <div className="file-tree-empty" style={{ paddingBottom: 4 }}>
            <UntestedTag id="projectFilesView.7" />
          </div>
          {scopedWindows.length === 0 ? (
            <div className="file-tree-empty">{t("projectFilesView.noOpenedWindows")}</div>
          ) : (
            scopedWindows.map((w) => (
              <div key={w.id} className="file-entry">
                <span className="file-icon"><WindowIcon /></span>
                <span className="file-name" title={w.exec}>
                  {basename(w.exec) || w.exec}
                  {w.file && <span style={{ color: "var(--text-muted)" }}> {basename(w.file)}</span>}
                </span>
                <button
                  className="tab-close"
                  onClick={() => closeApp(w.id)}
                  title={t(w.pid > 0 ? "projectFilesView.closeAppTitle" : "projectFilesView.untrackTitle")}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {view !== "files" && footer}
      {/* The Alerts group belongs to the viewer, not to one of its views: mail,
          appointments and cards are global, so a user who left the panel on Git
          (or Sessions, or Jobs) must still see the row that is due. It sits
          after every view's body — in the files view that is directly under the
          tree and its frame footer, exactly where it always was. A box's
          multi-root view is no exception any more: the rows are machine-wide,
          so standing in a box scope is not a reason for a due card to vanish,
          and the header's 🔔 reading as on while the panel showed nothing was
          the same wrong answer the per-view exclusion used to give. */}
      {alertsHere && (
        <AlertsSection onClose={() => void updateSettings({ files_alerts: false })} />
      )}
      {showSettings && project && localFile && (
        <ProjectFilesSettingsDialog
          localFile={localFile}
          project={project}
          filters={filters}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
