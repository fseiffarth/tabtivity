import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { confirm as dialogConfirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../lib/execTrust";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useDragStore, type EmbedCap, type FileDragItem } from "../../stores/drag/drag";
import { commitFileDrop, fileDropGoesToNewWindow } from "../tabs/commitFileDrop";
import { startDetachedDropSession } from "../tabs/detachedDropTargets";
import { FileDropContext } from "./fileDropContext";
import { openTabInScope, useTabScope } from "../tabs/tabScopeContext";
import { openFileEntry } from "./openFileEntry";
import { closeTabsForDeletedPath, retargetTabsForRenamedPath } from "./fileTabSync";
import {
  startCursorPoll,
  desktopCursor,
  desktopCoordinatesSupported,
  snapshotFrame,
  physToClient,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/window/coords";
import { bindDragRelease, dragPlatform, PLATFORM } from "../../lib/window/dragPlatform";
import { newDropToken, probeDropTarget } from "../../lib/window/dropClaim";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../../stores/settings";
import { useExperimental } from "../../lib/experimental";
import { GIT_STATE_COLOR } from "../../lib/theme/gitColors";
import { createDeckFile } from "../../lib/viewers/deck/create";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSyncStore, isPathExcluded, dirSyncAggregate, type SyncFileState, type SyncSkippedFile } from "../../stores/remote/sync";
import { confirmSyncTransfer } from "../../stores/remote/syncConfirm";
import { useActivityStore } from "../../stores/activity";
import { useFileClipboardStore } from "../../stores/fileClipboard";
import { type FileEntry, type InternalViewer, type SortKey, fmtSize, fmtModified, visibleEntries, sortEntries, isHiddenByEnding, internalViewerFor, disabledViewers, fileEntriesEqual, stringMapsEqual, nextSelection, STANDARD_PROJECT_FILES } from "../../lib/viewers/fileUtils";
import {
  dropFileTreeSnapshot,
  fileTreeSnapshotKey,
  readFileTreeSnapshot,
  writeFileTreeSnapshot,
} from "../../lib/projects/fileViewSnapshots";
import { type TexCapability, type TexCompileResult, getTexCapability, lastLogLine } from "../../lib/viewers/tex/tex";
import { basename, dirname, relativePathWithin, resolvePath } from "../../lib/paths";
import {
  moveDestRel,
  movedEntryAbs,
  resolveMoveTarget,
  createSpringLoader,
  type ResolvedMoveTarget,
} from "../../lib/projects/fileMove";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import { DirSizeUnavailable, guardedDirSize, isHostTimeout } from "../../lib/projects/dirSizeGuard";
import { useFastMode } from "../../lib/agents/fastMode";
import { isPythonPath } from "../../lib/viewers/python";
import {
  checkMainScripts,
  isMainScriptCached,
  needsMainCheck,
} from "../../lib/terminal/pythonMainCache";
import { runPythonFile, pythonRunPlan, placeForFocused } from "../../lib/terminal/pythonRun";
import {
  shellRunnerFor,
  shellScriptRunPlan,
  type ScriptShell,
} from "../../lib/terminal/shellScriptRun";
import { guardLoginNodeRun } from "../../lib/remote/hpc/hpcGuard";
import { projectIsOnHpc } from "../../lib/remote/hpc/hpcHost";
import { useRunHostPrefStore } from "../../stores/remote/runHostPref";
import { readFileText } from "../embed/fileAccess";
import { SetDefaultAppDialog } from "./SetDefaultAppDialog";
import { SendToProjectDialog, type SendSource } from "./SendToProjectDialog";
import { AddRemarkDialog } from "./AddRemarkDialog";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { normalizeScanPath } from "./ProjectFilesSettings";
import { FileTreeSearch } from "./FileTreeSearch";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { UntestedTag } from "../common/UntestedTag";
import { SyncSkippedLarge } from "./SyncSkippedLarge";
import { MenuShortcut } from "../common/MenuShortcut";
import type { ChordDescriptor } from "../../lib/shortcuts/shortcuts";
import { IdeMenuItems } from "../projects/IdeMenuItems";
import { RenameDialog, containingFolderLabel } from "./RenameDialog";
import { useDialogs } from "../common/PromptDialogs";
import { Dropdown } from "../common/Dropdown";
import { FileIcon } from "../common/icons/FileIcon";
import { ArrowDownIcon, ArrowUpIcon, PlayIcon, SearchIcon } from "../common/icons/Icon";
import { useT, type TranslationKey } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";
import { BRAND, NAMES, storageKey } from "../../lib/brand";

// The context menu's Delete rows name their keyboard twin (handleTreeKeyDown).
const DELETE_KEY: ChordDescriptor = { key: "Delete" };

// Persist whether the collapsed "gitignored" files section is expanded, so the
// choice survives side-panel hide/show and remounts (FileTree remounts each
// time the panel reopens). Mirrors GitHistory's localStorage view pref.
const GITIGNORED_EXPANDED_KEY = storageKey("fileTree.gitignoredExpanded");
// Same idea, for the collapsed "hidden by extension" group (the project's own
// hiddenEndings list — see ProjectFilesSettings) — collapsed by default too.
const HIDDEN_EXT_EXPANDED_KEY = storageKey("fileTree.hiddenExtExpanded");

// How many rows the tree renders at once, and how many more each click of the
// "show more" footer adds. The rows are not virtualized, so this is the bound on
// how much DOM one listing can build — see `rowCap` for why an unbounded listing
// is what makes a big folder freeze the window rather than merely load slowly.
// A page still overfills the tallest panel, so the cap is invisible in every
// ordinary folder and only engages where it is the difference between usable
// and not.
const ROW_CAP_STEP = 100;

// A stable empty-object fallback for the `python_run_args` selector below — a
// fresh `{}` literal on every render would change the snapshot's reference
// identity each time, which `useSyncExternalStore` (what the store hook is
// built on) reads as "changed" and re-renders forever.
const EMPTY_PY_ARGS: Record<string, string> = {};

/// How long the pointer must rest on a row before its tooltip opens. Long enough
/// that sweeping the tree never opens (or measures) anything — see
/// `handleEntryMouseEnter` for why entry-triggered tooltips were expensive.
const TOOLTIP_DWELL_MS = 400;
// Drag-to-move dwell before a hovered folder / crumb / ↑ spring-opens (the
// tree navigates there and the drag continues). Long enough that sweeping the
// cursor across folders toward a sibling never opens one by accident.
const SPRING_LOAD_MS = 650;

function sizeCategory(bytes: number): string {
  if (bytes < 10 * 1024) return "size-small";
  if (bytes < 500 * 1024) return "size-medium";
  if (bytes < 10 * 1024 * 1024) return "size-large";
  return "size-huge";
}

/** Hover title for a non-ignored size figure: the total + ignored split when
 *  there's ignored content to split out, else the plain fallback wording. A pure
 *  helper, not a component, so it takes `t` explicitly — the same shape
 *  `FileViewerPane`'s `acModeLabel` uses. */
function sizeTitle(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  shown: number,
  ignored: number,
  fallback: string,
): string {
  return ignored > 0
    ? t("fileTree.sizeTotalIgnoredSplit", {
        total: fmtSize(shown + ignored),
        ignored: fmtSize(ignored),
      })
    : fallback;
}

/** Sort keys as the breadcrumb's dropdown labels them. Lives here now that the
 *  control sits in the ⌂ row rather than in a row of its own above the tree. */
const SORT_KEY_LABEL: Record<SortKey, TranslationKey> = {
  name: "sortKey.name",
  size: "sortKey.size",
  type: "sortKey.type",
  created: "sortKey.created",
  modified: "sortKey.modified",
};

interface Props {
  projectDir: string;
  projectId: string | null;
  sortKey?: SortKey;
  descending?: boolean;
  /** When given, the breadcrumb (⌂) row carries the sort control — a right-
   *  aligned key dropdown plus a direction toggle. Omitted by hosts that keep
   *  the row minimal (the compact docked subwindow), which then just render
   *  whatever order the props already say. */
  onSortChange?: (sortKey: SortKey, descending: boolean) => void;
  hiddenEndings?: string[];
  hiddenPaths?: string[];
  shownPaths?: string[];
  /** Folders excluded from every recursive scan (`scan_excluded_paths` in
   *  project.json). They still LIST — only their size walk is skipped — so the
   *  exclusion stays visible and reversible on the row it applies to. */
  scanExcluded?: string[];
  /** When given, folder rows offer "Exclude from scans" / "Include in scans". */
  onToggleScanExcluded?: (relPath: string, excluded: boolean) => void;
  /** Collect the project root's scaffold files into their own collapsible
   *  section (`panel_separate_scaffold` in project.json, edited in Project
   *  Settings). Both this and the gitignored split used to be a toggle under
   *  the tree, which put a per-project rule in a surface that is mounted many
   *  times over at once — the side panel, every Files (Project) tab, every
   *  docked subwindow column — so the same project showed different sections
   *  depending on which copy you had last clicked, and nothing survived a
   *  relaunch. Default on, which is what the local state used to seed. */
  separateScaffold?: boolean;
  /** The same for everything git ignores (`panel_separate_gitignored`), which
   *  applies in every folder rather than only at the root. */
  separateGitignored?: boolean;
  initialRelPath?: string | null;
  onRelPathChange?: (relPath: string) => void;
  /** When given, the context menu offers "Open in a new tab" — on a folder, and
   *  on the background for the folder currently browsed. The host decides what
   *  that tab is (a Files (Project) tab) and which scope it lands in; a tree with
   *  no way to own a tab (a box root, a detached window) simply omits this. */
  onOpenFolderTab?: (relPath: string) => void;
  /** SSH-sync Phase 1: which side of a remote project this tree shows. `"remote"`
   *  = the host source with the sync overlay + select-to-sync affordance; `"local"`
   *  = the local mirror (browsed/watched as a plain local tree). Absent = a normal
   *  local/remote project tree (no sync UI). */
  syncSource?: "remote" | "local";
  /** For a remote project's LOCAL-mirror view: the project's remote state dir
   *  (the one `list_dir` resolves to the host over SFTP — i.e. the pane's own
   *  `projectDir`, the parent of `mirror/`). Lets the mirror tree cheaply readdir
   *  the host for the browsed folder and flag which local-only child folders don't
   *  exist on the remote yet. Absent for a local project / the remote-source view. */
  remoteProbeDir?: string | null;
  /** Whether the surface hosting this tree is on screen. A tree stays MOUNTED
   *  while hidden (it must be instantly ready on switch-back), but all of its
   *  standing work stops: the fs-watch + fs-change re-list (every mounted tree
   *  used to re-list on every event burst, hidden or not), the 15 s sync
   *  re-stat, the host readdir probe, and the lazy folder-size walks. When the
   *  tree's project becomes current again everything restarts, with one quiet
   *  catch-up re-list covering whatever changed while it was hidden. */
  active?: boolean;
  /** Fold state of the in-tree search box, when the HOST owns that chrome. The
   *  side panel puts the 🔍 / ↻ pair in its Files/Git/Apps toolbar row, so the
   *  tree renders neither button itself and, closed, renders no search row at
   *  all — the whole point of the move was to stop spending a row on chrome.
   *  Omit both and the tree keeps its own toggle beside the box (standalone
   *  use, e.g. a bare `<FileTree>` in a test). */
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  /** Bumped by the host's ↻ to force a re-list. A counter, not a boolean: two
   *  refreshes in a row must both land. */
  refreshNonce?: number;
}

type GitStatusMap = Record<string, string>;
/** `rowRect` is the right-clicked row's bounding box, captured at open time, so
 *  a glowing frame can float onto it and show which entry the menu targets. */
type EntryContextMenu = {
  x: number;
  y: number;
  entry: FileEntry | null;
  rowRect: { left: number; top: number; width: number; height: number } | null;
} | null;
type DeleteConfirm = { entries: FileEntry[] } | null;
/** Open paste-rename window: `kind` is whether the source is the in-app file
 *  clipboard or a system-clipboard image (screenshot); `name` is the name being
 *  chosen for the pasted result in the current folder. */
type PastePrompt = { kind: "file" | "image"; name: string; error: string | null };
/** The entry whose rename dialog is open (`RenameDialog` owns the typed name).
 *  Replaces a `window.prompt`, which WebKitGTK draws as a browser alert titled
 *  with the dev-server origin ("localhost:1420 says"). */
type RenamePrompt = { entry: FileEntry } | null;
/** A folder whose auto-sync toggle would pull enough from the host to be worth
 *  confirming first (`AUTO_SYNC_WARN_*`), with what it priced. */
type AutoConfirm = { entry: FileEntry; files: number; bytes: number } | null;

/** Auto-syncing a host folder bigger than either of these asks first. They are
 *  "would you notice this landing on your disk?" thresholds, not limits — the
 *  point is that byte-sync ignores `.gitignore`, so a folder full of experiment
 *  output looks exactly like a folder full of code to it. */
const AUTO_SYNC_WARN_FILES = 200;
const AUTO_SYNC_WARN_BYTES = 100 * 1024 * 1024;

export const STATUS_COLOR = GIT_STATE_COLOR;

const STATUS_TITLE_KEY: Record<string, TranslationKey> = {
  modified:  "fileTree.statusModified",
  untracked: "fileTree.statusUntracked",
  staged:    "fileTree.statusStaged",
  unpushed:  "fileTree.statusUnpushed",
  ignored:   "fileTree.statusIgnored",
};

/** Marker shown to the left of a tree entry for its git status.
 *  Ignored → gray ✕ glyph; everything else → a colored dot (red unstaged/
 *  untracked, orange staged, green committed-not-pushed); clean → empty slot. */
function GitMarker({ status }: { status: string | undefined }) {
  const t = useT();
  const slot: React.CSSProperties = {
    width: 11,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginRight: 3,
    fontSize: 11,
    lineHeight: 1,
  };
  if (status === "ignored") {
    return (
      <span style={{ ...slot, color: STATUS_COLOR[status] }} title={t(STATUS_TITLE_KEY[status])}>
        ✕
      </span>
    );
  }
  const color = status ? STATUS_COLOR[status] : undefined;
  return (
    <span style={slot} title={status ? t(STATUS_TITLE_KEY[status]) : undefined}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color ?? "transparent" }} />
    </span>
  );
}


// Native drag-out (tauri-plugin-drag) needs the OS drag-preview icon as a base64
// PNG data URL (its icon field rejects a bare path), read synchronously inside
// the `dragstart` gesture. The backend returns that data URL; cache it
// process-wide so every file row shares one warm-up (kicked off at mount) and
// reads it without awaiting.
let dragIconDataUrl = "";
let dragIconPromise: Promise<string> | null = null;
function warmDragIcon(): Promise<string> {
  if (!dragIconPromise) {
    dragIconPromise = invoke<string>("drag_preview_icon")
      .then((p) => (dragIconDataUrl = p))
      .catch(() => "");
  }
  return dragIconPromise;
}

/** Turn a raw `list_dir` failure into a sentence a user can act on. The common
 *  case, by far, is switching a remote project's file view to "Remote" while
 *  sitting in a folder that only exists in the local mirror (never synced to the
 *  host): the backend's SFTP `open_dir` fails deep in ssh2 with text like
 *  "sftp open_dir failed: …", which means nothing to a user. Say what actually
 *  happened and what to do about it instead. */
function describeListError(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  e: unknown,
  remoteSource: boolean,
): string {
  const raw = String(e);
  if (remoteSource) {
    // A missing/denied directory on the host. ssh2/libssh surface this as
    // "no such file", "No such file", "failure", or a bare open_dir error.
    if (/open_dir|read_dir|no such file|not found|failure|permission/i.test(raw)) {
      return t("fileTree.errLocalOnly");
    }
    return t("fileTree.errRemoteList");
  }
  return t("fileTree.errOpenFolder");
}

export function FileTree({
  projectDir,
  projectId,
  sortKey = "name",
  descending = false,
  onSortChange,
  hiddenEndings = [],
  hiddenPaths = [],
  scanExcluded,
  onToggleScanExcluded,
  separateScaffold = true,
  separateGitignored = true,
  shownPaths = [],
  initialRelPath = "",
  onRelPathChange,
  onOpenFolderTab,
  syncSource,
  remoteProbeDir,
  active = true,
  searchOpen: searchOpenProp,
  onSearchOpenChange,
  refreshNonce,
}: Props) {
  const t = useT();
  // Non-null inside a detached popout: replaces the main window's CenterPanel
  // drop authority (which this window can't reach) for a file dragged onto a
  // pane. See fileDropContext.
  const fileDrop = useContext(FileDropContext);
  // Set inside the root console: the tabs this tree opens are root's, not the
  // active project's (see tabScopeContext).
  const tabScope = useTabScope();
  // The tree is unmounted, not hidden, whenever the side panel closes
  // (`mountTree={open}`) or the panels are toggled away — so a reveal used to
  // start from an empty tree and fill itself in over a listing, a git-status
  // round trip and one recursive walk per folder. `mountSeed` is the last state
  // this (project, root, folder) was left in: every piece of it below is seeded
  // from it so the FIRST frame after a reveal is already populated, and the
  // mount effect then upgrades it with a quiet, diffing refresh. Read once (a
  // lazy initializer), so a re-render never re-seeds over live state.
  const [mountSeed] = useState(() =>
    readFileTreeSnapshot(fileTreeSnapshotKey(projectId, projectDir, initialRelPath ?? "")),
  );
  // Consumed by the mount effect: the seeded first pass refreshes instead of
  // re-listing from scratch. A later run of that effect (a remote pool coming
  // up) is a real load, so the flag only ever fires once.
  const seedPending = useRef(!!mountSeed);
  const snapshotKeyFor = useCallback(
    (rel: string) => fileTreeSnapshotKey(projectId, projectDir, rel),
    [projectId, projectDir],
  );
  const [rawEntries, setRawEntries] = useState<FileEntry[]>(() => mountSeed?.entries ?? []);
  // Recursive folder sizes (bytes), keyed by absolute folder path. Filled in
  // lazily by a per-folder backend call so a big subtree never blocks the
  // listing — the tree renders immediately and each folder's size appears
  // once it resolves. `requestedSizes` guards against re-dispatching the same
  // folder while it's in flight (or after it failed), so fs-watch churn doesn't
  // trigger a request storm; both reset in `load()` (navigation / refresh) so a
  // re-listed folder recomputes. Shared between the two size-fetch effects
  // below (plain `dir_size` for the gitignored section, `dir_size_breakdown`
  // for everything else) so the same folder is never fetched by both — besides
  // being wasted work, two independent walks of the same folder can disagree
  // if it's being actively written to, which would make the ignored split
  // exceed the total from the other call.
  // Fast mode withdraws every recursive size walk below (and with it the row
  // figures and the group totals summed from them). Reactive, so turning it
  // off re-runs the effects and prices the folders on screen — the dedupe set
  // was never filled while it was on, so nothing is skipped.
  const fastMode = useFastMode();
  const [dirSizes, setDirSizes] = useState<Record<string, number>>(() => mountSeed?.dirSizes ?? {});
  const requestedSizes = useRef<Set<string>>(new Set());
  // Which listing the in-flight size calls belong to. Bumped by `load()`, the
  // only thing that invalidates the cache — so a result is stale ONLY if the
  // folder was re-listed under it, never merely because the tree re-rendered.
  // This is load-bearing: the effects below key on `sections`, whose identity
  // changes on any re-render (`load()` itself sets rawEntries and THEN, a
  // round-trip later, gitStatuses), and cancelling on that would drop every
  // size call still in flight — permanently, since `requestedSizes` keeps it
  // from being re-dispatched. Small folders resolved inside the gap and showed
  // a size; a big one (the whole point of the feature) never did.
  const sizeGeneration = useRef(0);
  // Scan exclusions, normalised once per change into the one spelling the backend
  // matches on. `scanExcludedList` is what the walk commands receive (it prunes
  // excluded subtrees *nested inside* a folder being sized); `isScanExcluded`
  // additionally stops us dispatching a walk for an excluded folder at all.
  const scanExcludedList = useMemo(
    () => (scanExcluded ?? []).map(normalizeScanPath).filter(Boolean),
    [scanExcluded],
  );
  const scanExcludedSet = useMemo(() => new Set(scanExcludedList), [scanExcludedList]);
  const isScanExcluded = useCallback(
    (rel: string) => scanExcludedSet.has(normalizeScanPath(rel)),
    [scanExcludedSet],
  );
  // The rel path of the most recent `load` call — the folder the tree is
  // committed to showing. Every async listing/status result checks itself
  // against it before touching state, so a `refresh` of folder A that lands
  // after the user has moved on to B can't paint A's rows or A's git letters
  // under B's breadcrumb (the seeded `load` puts B on screen at once, so a slow
  // A result used to visibly flash in over it). Seeded from the saved folder
  // for the same reason `relPath` is: the seeded mount's refresh must pass.
  const loadTargetRef = useRef<string>(initialRelPath ?? "");
  // Bytes of a folder's recursive size that are git-ignored, for folders that
  // are NOT themselves ignored (they sit in the regular/standard section) but
  // contain ignored content — e.g. a source folder with a build output dir
  // inside. Filled from the same `dir_size_breakdown` call that fills
  // `dirSizes` for these folders (one walk, both numbers), so the split can
  // never exceed the total it was measured against. A folder with no ignored
  // content is simply absent from this map (nothing to annotate).
  const [dirIgnoredBytes, setDirIgnoredBytes] = useState<Record<string, number>>(
    () => mountSeed?.dirIgnoredBytes ?? {},
  );
  // Which files can be embedded as a frameless in-tab app (Group K #40). Keyed
  // by extension (default-app resolution is per-mime/extension), so we only
  // query the backend once per distinct extension. Only embeddable files get the
  // drag-to-tab affordance (3D hover + pointer drag); the rest open on dblclick.
  const [embedByExt, setEmbedByExt] = useState<Record<string, boolean>>({});
  // Seed from the saved folder (`initialRelPath`) rather than "" so a (re)mount
  // renders that folder immediately. Starting at "" made every remount paint the
  // ROOT for one frame — then the mount effect's async `load(initialRelPath)`
  // would snap back to the saved folder, so a remounting tree visibly flickered
  // "root ↔ current folder". Reading the prop lazily fixes that for all remount
  // causes; the mount effect below still runs and just fetches this folder's
  // listing (relPath is already correct, so there is no root frame).
  const [relPath, setRelPath] = useState(() => initialRelPath ?? "");
  // Multi-selection: a set of entry ABSOLUTE paths (`e.path`, the row key), plus
  // the range anchor. Click selects; shift-click extends a contiguous range;
  // ctrl/cmd-click toggles a row. Backs bulk delete/move/copy, drag-all, and
  // open-all. Cleared on folder navigation (in `load`) and pruned when the
  // listing changes (fs-watch removes a selected file).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When a remote listing fails because the folder isn't on the host, this holds
  // the crumb index (into the path segments) of the FIRST segment that doesn't
  // exist on the host — everything from here on is local-only. null when the
  // whole path exists (the normal case) or the source is local. The breadcrumb
  // tints the on-host prefix and strikes through the local-only tail from it.
  const [missingCrumbDepth, setMissingCrumbDepth] = useState<number | null>(null);
  const [gitStatuses, setGitStatuses] = useState<GitStatusMap>(() => mountSeed?.gitStatuses ?? {});
  const [isDragOver, setIsDragOver] = useState(false);
  const [gitignoredExpanded, setGitignoredExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GITIGNORED_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [scaffoldExpanded, setScaffoldExpanded] = useState(false);
  const [hiddenExtExpanded, setHiddenExtExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDDEN_EXT_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Whether the Ctrl key is currently held. While held, file rows arm NATIVE
  // HTML5 drag-and-drop (export/copy the file to an embedded browser / external
  // target like Signal) instead of the pointer-based drag-to-tab. The two can't
  // both be armed on the same drag (native DnD fires pointercancel on WebKitGTK
  // and breaks the pointer drag — see onEntryPointerDown's R6 note), so Ctrl is
  // the explicit switch. Tracked as state so `draggable` re-evaluates per row
  // when Ctrl is pressed/released.
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [tooltip, setTooltip] = useState<{ rect: DOMRect; entry: FileEntry } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  // Vertical-only correction: a row near the bottom of a short docked viewer
  // (the side panel, a subwindow's file sidebar) still measures its anchor
  // against the WHOLE app window, so an unclamped `top: tooltip.rect.top`
  // could push the tooltip's body past the window's bottom edge. Horizontal
  // placement already picks a side with room (see the style below), so only
  // this axis needs correcting. Measured off `offsetHeight`, not the element's
  // current on-screen rect, so a stale shift from a previous tooltip can't
  // pollute the new measurement.
  const [tooltipShift, setTooltipShift] = useState(0);
  useLayoutEffect(() => {
    if (!tooltip) {
      setTooltipShift(0);
      return;
    }
    const el = tooltipRef.current;
    if (!el) {
      setTooltipShift(0);
      return;
    }
    const overflow = tooltip.rect.top + el.offsetHeight - (window.innerHeight - 8);
    setTooltipShift(overflow > 0 ? overflow : 0);
  }, [tooltip]);
  // Drop a pending dwell timer if the tree unmounts mid-hover, so it can't fire
  // a setState against a gone component.
  useEffect(() => () => cancelTooltipTimer(), []);
  // In-tree search: while `search` is non-empty the tree body is replaced by a
  // flat result list (FileTreeSearch). `searchMode` picks filename vs. content
  // search; `searchCase` only applies to content search (name search is fuzzy).
  // Both backends walk the canonical LOCAL path, so the search box is only shown
  // for a non-remote-source tree (see `remoteListing` below).
  // Right-click on the breadcrumb turns the path into an editable field (holding
  // the current folder's absolute path) so a path can be typed/pasted to jump —
  // and copies that absolute path to the clipboard. `null` = not editing.
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const pathEditRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  // Search folds away and starts CLOSED: the box + mode pills cost two rows of
  // tree on every surface that renders FileTree (the side panel is the tight
  // one), and most sessions browse rather than search. Opening it is one click,
  // and closing clears the query so the tree comes straight back.
  const [searchOpenSelf, setSearchOpenSelf] = useState(false);
  // Who owns the fold: the side panel passes both halves and draws the toggle
  // in its own toolbar; a bare tree keeps the toggle (and the refresh button)
  // in the search row.
  const hostOwnsSearchChrome = onSearchOpenChange !== undefined;
  const searchOpen = hostOwnsSearchChrome ? !!searchOpenProp : searchOpenSelf;
  function setSearchOpen(open: boolean) {
    if (onSearchOpenChange) onSearchOpenChange(open);
    else setSearchOpenSelf(open);
  }
  // Closing must not leave a live query behind: `searching` already ignores it,
  // but the next open would silently repopulate the results view from a query
  // nobody typed now. This is an effect on the RESULT rather than a line in the
  // setter above, because the fold can also be closed from outside the tree
  // entirely — the side panel's toolbar owns that button and never calls in.
  useEffect(() => {
    if (!searchOpen) setSearch("");
  }, [searchOpen]);
  const [searchMode, setSearchMode] = useState<"name" | "content">("name");
  const [searchCase, setSearchCase] = useState(false);
  // Search scope: false (default) confines the search to the browsed folder
  // (`relPath`); true searches from the project root. Only meaningful in a
  // subfolder — at the root the two are identical.
  const [searchRoot, setSearchRoot] = useState(false);
  // A pending "reveal in tree" (jump-to-path) request from a search result: the
  // parent folder to navigate to and the entry name to select once it lists.
  const [pendingReveal, setPendingReveal] = useState<{ parent: string; name: string } | null>(null);
  // Drag-to-move: the resolved drop target under the cursor while a file is
  // being dragged (null = none). The ref carries the live value into the drag's
  // window-bound release handler (which captured an earlier closure); the state
  // drives THIS tree's drop-target highlight and only changes when the hovered
  // target changes (not every pointermove), so the tree re-renders rarely. A
  // target in ANOTHER tree (a box member root, a Files tab of a different
  // project) can't be highlighted through this tree's state — its element is
  // classed imperatively instead (`moveTargetElRef`).
  const moveTargetRef = useRef<ResolvedMoveTarget | null>(null);
  const moveTargetElRef = useRef<HTMLElement | null>(null);
  // The folder on screen, readable from inside a drag gesture that outlives
  // renders: spring-loading (below) navigates the tree mid-drag, so the
  // `relPath` a pointerdown closure captured is the folder the drag STARTED in
  // (which is what the move's no-op check wants), not the one now listed.
  const relPathRef = useRef(relPath);
  relPathRef.current = relPath;
  const [moveTargetRel, setMoveTargetRel] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<EntryContextMenu>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  // The focusable tree root. File rows preventDefault on pointerdown to arm the
  // drag, which suppresses the browser's default focus-the-ancestor — so we move
  // focus here explicitly on selection, or the tree's key handlers (Enter/Delete/
  // Escape) would only fire after a manual Tab-in (notably in the docked sidebar).
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  useClampToViewport(contextMenuRef, contextMenu, setContextMenu);
  // Close on any click outside the menu, not just inside this tree: the tree's
  // own `onMouseDown={() => setContextMenu(null)}` only fires for a click that
  // bubbles through the `.file-tree` root, so a click in the terminal, another
  // tab, or anywhere else in the window left a stale menu floating (it's
  // portaled to document.body, so it stays visually on top regardless).
  useEffect(() => {
    if (!contextMenu) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(ev.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [contextMenu]);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm>(null);
  const [autoConfirm, setAutoConfirm] = useState<AutoConfirm>(null);
  const [defaultAppFor, setDefaultAppFor] = useState<FileEntry | null>(null);
  const [sendTo, setSendTo] = useState<SendSource | null>(null);
  const [remarkFor, setRemarkFor] = useState<FileEntry | null>(null);
  const remarksEnabled = useExperimental("project_remarks");
  const remarkCounts = useProjectRemarksStore((s) => projectId ? s.byProject[projectId]?.countsByFile : undefined);
  const [pastePrompt, setPastePrompt] = useState<PastePrompt | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [renamePrompt, setRenamePrompt] = useState<RenamePrompt>(null);
  // The panel's other questions — New File/Folder/Presentation — in the same
  // chrome the rename above wears, rather than in the browser's native boxes.
  const { promptText, dialogs } = useDialogs();
  // SSH-sync Phase 2: project-relative paths whose push was blocked by a stale
  // host base, awaiting the user's keep-local / take-host / skip choice. The
  // first is shown in the conflict modal; resolving advances the queue.
  const [pushConflicts, setPushConflicts] = useState<string[]>([]);
  const [pushBusy, setPushBusy] = useState(false);
  // What the last transfer started from this tree did. It exists for the
  // successful case: a failure had `error`, a conflict had its own modal, and a
  // push that simply worked said nothing whatsoever — the same blank as a button
  // whose click was swallowed. Stays until dismissed or superseded rather than
  // fading, since a one-second push must not report itself into a toast the user
  // has not looked at yet (the whole-project row in `ProjectFilesPane` strikes
  // the same bargain, with the same chrome).
  const [syncNotice, setSyncNotice] = useState<{
    text: string;
    bad: boolean;
    /** Files over the cap a pull left on the host (gap 35). */
    skipped?: SyncSkippedFile[];
  } | null>(null);
  // Whether the system clipboard holds an image when the context menu opened
  // (probed async on right-click), gating the "Paste screenshot" option.
  const [clipboardImage, setClipboardImage] = useState(false);
  const clipboardEntries = useFileClipboardStore((s) => s.entries);
  const setClipboardEntries = useFileClipboardStore((s) => s.setEntries);
  const clearClipboard = useFileClipboardStore((s) => s.clear);
  // The primary clipboard item — backs the single-file paste-rename prompt and
  // its labels. Multi-item pastes read the full `clipboardEntries` array.
  const clipboard = clipboardEntries[0] ?? null;
  // TeX toolchain presence (null until probed); absolute paths of .tex files
  // currently compiling, for the inline build spinner.
  const [texCap, setTexCap] = useState<TexCapability | null>(null);
  const [compiling, setCompiling] = useState<Set<string>>(new Set());
  // Per-file arguments for the ▶ Run button, remembered so a re-run reuses them.
  // Set via the right-click popover (`argsPopover`, positioned at the cursor).
  // Same shared, persisted map the open-editor's Run/Debug toolbar reads/writes
  // (`FileViewerPane.tsx`'s `pyArgs`/`setPyArgs`) — keyed by absolute path in
  // global settings, not local component state, so it survives this tree
  // unmounting (side-panel hide/close) and a Tabtivity restart. Shell scripts
  // (`.sh` & co.) share the map: it is keyed by path, and the name predates them.
  const runArgsByPath = useSettingsStore((s) => s.settings?.python_run_args ?? EMPTY_PY_ARGS);
  const setRunArgs = useCallback((path: string, v: string) => {
    void useSettingsStore.getState().setPythonRunArgs(path, v);
  }, []);
  const [argsPopover, setArgsPopover] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
    draft: string;
  } | null>(null);
  const argsPopoverRef = useRef<HTMLDivElement | null>(null);
  const argsInputRef = useRef<HTMLInputElement | null>(null);
  useClampToViewport(argsPopoverRef, argsPopover, setArgsPopover);
  useEffect(() => {
    if (!argsPopover) return;
    argsInputRef.current?.focus();
    argsInputRef.current?.select();
  }, [argsPopover?.entry.path]);
  const runInBackground = useSettingsStore((s) => s.settings?.run_scripts_in_background ?? true);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  /** Gates the "New Presentation" item, exactly as the PDF viewer's Present
   *  button is gated — the native presenter is still experimental. */
  const deckEnabled = useExperimental("deck_presenter");
  const runningScripts = useActivityStore((s) => s.runningScripts);
  const runningRunFiles = useActivityStore((s) => s.runningRunFiles);
  const runScript = useActivityStore((s) => s.runScript);
  // Mount-free remote (Phase 2): a remote project lists over SFTP and has no
  // local inotify watcher, so we skip the fs-watch wiring and offer a manual
  // refresh control instead. Local projects keep live watch-driven updates.
  const isRemote = useProjectsStore(
    (s) => !!s.projects.find((p) => p.id === projectId)?.remote,
  );
  // The local mirror root for a remote project, resolved the same way
  // `ProjectFilesPane`/`ProjectFilesView` do (persisted override, else the default
  // `<state_dir>/mirror`). Used to build the mirror-side absolute path the
  // three-way merge viewer (`SyncMergeView`) opens a diverged file at — the ± diff
  // button below routes through it. Null for a local (non-remote) project.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const mirrorRoot = useMemo(() => {
    if (!project?.remote) return null;
    return (
      resolveLocalMirror(project) ??
      `${resolveProjectDirectory(project).replace(/[/\\]+$/, "")}/mirror`
    );
  }, [project]);
  // SSH-sync Phase 1: the local mirror source (`syncSource === "local"`) is a
  // plain LOCAL tree even though its project is remote — it lists/watches the
  // local mirror dir and is never gated on the SSH pool. Only a remote-SOURCE
  // tree dispatches its listing over SFTP. `remoteListing` is the flag the
  // watch/refresh-bar/pool-gate logic below keys on.
  const treatLocal = syncSource === "local";
  const remoteListing = isRemote && !treatLocal;
  // SSH-sync overlay state for the remote source: per-path green/amber/none + the
  // in-flight transfer progress. Only consulted in the remote-source view.
  const syncStatus = useSyncStore((s) => (projectId ? s.byProject[projectId] : undefined));
  // Aggregated sync state for FOLDERS that have no manifest entry of their own.
  // The manifest tracks files (a directory only gets an entry when it is
  // explicitly folder-selected / folder-auto-synced); files pulled individually
  // leave every ancestor folder absent, so a folder row's own-path lookup
  // defaults to "none" and paints a red "push to host" button even when every
  // file inside it is green/in-sync. This rolls each tracked file's state up onto
  // all of its ancestor directories: `any` = the folder contains a tracked file,
  // `allGreen` = they are all green. A folder with its own entry still uses that
  // (handled at the lookup site); this only rescues the entry-less ones. Keyed by
  // project-relative directory path.
  const dirSyncAgg = useMemo(() => dirSyncAggregate(syncStatus), [syncStatus]);
  const syncProgress = useSyncStore((s) => (projectId ? s.progressByProject[projectId] : undefined));
  const refreshSyncStatus = useSyncStore((s) => s.refreshStatus);
  const syncPull = useSyncStore((s) => s.pull);
  const syncPush = useSyncStore((s) => s.push);
  const syncMarkSelected = useSyncStore((s) => s.markSelected);
  const syncSetAuto = useSyncStore((s) => s.setAuto);
  const syncAutoPreview = useSyncStore((s) => s.autoPreview);
  const syncSetExcluded = useSyncStore((s) => s.setExcluded);
  // A remote project's `list_dir`/`git_file_statuses` dispatch over SSH/SFTP on
  // the backend. Those are SYNCHRONOUS Tauri commands (they run on the main
  // thread), so calling them while the pooled connection is down blocks on the
  // dead SSH session and FREEZES the whole window. Gate every listing on the pool
  // being "connected": until then the tree shows a disconnected note instead of
  // issuing any remote call. Reconnect (header lamp / center placeholder) brings
  // the pool up, flips this true, and the load effect re-runs.
  const remoteSshState = useRemoteStatusStore((s) =>
    projectId ? s.byProject[projectId]?.ssh : undefined,
  );
  const remoteBlocked = remoteListing && remoteSshState !== "connected";
  // Whether this project's PRIMARY host is a tagged cluster login node — the host
  // that owns the files, and so the one every stat loop below walks. Gates the
  // periodic re-stat, not the explicit one: see the sync-status effect.
  const settingsForHpc = useSettingsStore((s) => s.settings);
  const primaryIsHpc = projectIsOnHpc(settingsForHpc, project);
  // Local-mirror view of a remote project: the NAMES of the browsed folder's
  // immediate children that exist on the host, from one SFTP readdir per
  // navigation (only while the pool is live — a host readdir is a main-thread
  // command that would freeze on a dead session, like every other remote call).
  // A local child folder absent from this set is local-only — it has never
  // reached the host — and the tree flags it so "Local" mode doesn't quietly
  // imply the whole mirror is on the remote. `null` = unknown (not this view, or
  // disconnected): flag nothing rather than guess.
  const [hostChildNames, setHostChildNames] = useState<Set<string> | null>(null);

  // Dotfiles always render inline here — there's no separate "hidden" section;
  // any that are actually gitignored, or match a hiddenEndings rule, get
  // pulled into their own collapsed section below instead (see the render
  // below) — `keepHiddenEndings` is what keeps them in this list rather than
  // dropping them outright, mirroring how a gitignored entry was never
  // filtered out of here either.
  const entries = useMemo(
    () => visibleEntries(rawEntries, {
      showHidden: true,
      showStandardFiles: true,
      sortKey,
      descending,
      hiddenEndings,
      keepHiddenEndings: true,
      relPath,
      hiddenPaths,
      shownPaths,
    }),
    [rawEntries, sortKey, descending, hiddenEndings, relPath, hiddenPaths, shownPaths],
  );

  // Whether a visible Python file is a "main" script (has a module-level
  // `if __name__ == "__main__":` guard) — the Run ▶ button only shows for
  // those, not for every importable module. It needs the file's content, which
  // the tree listing doesn't carry, so it is read once per *version* of a file
  // and the verdict is persisted in settings.json (`lib/terminal/pythonMainCache`).
  //
  // Persisting is what makes this affordable on BOTH sides. It used to be a
  // component-lifetime ref, so every reopen of the viewer re-read every visible
  // .py — and because that is an SFTP round trip per file on a remote listing,
  // remote skipped the check entirely and showed ▶ on every .py. That is the
  // local/remote disagreement this replaces: the same library module offered a
  // Run button on the host and none on the mirror. Now both sides ask the same
  // question and pay for the answer once.
  const pyMainCache = useSettingsStore((s) => s.settings?.python_main_scripts);
  // Guards against a second scan of files whose read is still in flight (the
  // cache only learns the answer when it lands). Keyed by path + version, so a
  // file edited mid-scan is still re-checked.
  const pyMainInFlight = useRef<Set<string>>(new Set());
  // Bumped by the ↻ refresh button: re-check every listed .py regardless of its
  // stamp. The stamp cannot see a same-second write that lands on an identical
  // size, and "I pressed refresh" is exactly the gesture that should not trust it.
  const [pyMainNonce, setPyMainNonce] = useState(0);
  const pyMainNonceSeen = useRef(0);
  useEffect(() => {
    // Fast mode stops the *scanning*, not the answers already paid for: the
    // cache is still read below, so a file whose verdict is known keeps its \u25b6.
    if (fastMode) return;
    const forced = pyMainNonceSeen.current !== pyMainNonce;
    pyMainNonceSeen.current = pyMainNonce;
    // The ref object's identity never changes, so holding the Set itself is the
    // same Set the cleanup must clear — and it satisfies the hooks lint, which
    // can't know that a ref to a plain Set is not a ref to a DOM node.
    const inFlight = pyMainInFlight.current;
    const version = (e: FileEntry) => `${e.path}#${e.size}#${e.modified_secs ?? 0}`;
    const pending = entries
      .filter((e) => !e.is_dir && isPythonPath(e.path) && !inFlight.has(version(e)))
      .map((e) => ({ path: e.path, size: e.size, mtime: e.modified_secs ?? 0 }))
      .filter((f) => forced || needsMainCheck(pyMainCache, f));
    if (pending.length === 0) return;
    pending.forEach((f) => inFlight.add(`${f.path}#${f.size}#${f.mtime}`));
    let cancelled = false;
    void (async () => {
      const verdicts = await checkMainScripts(
        pending,
        (path) => readFileText(path, projectId),
        { cancelled: () => cancelled },
      );
      if (cancelled) return;
      // One settings write for the whole folder, not one per file.
      await useSettingsStore.getState().setPythonMainVerdicts(verdicts);
    })();
    return () => {
      cancelled = true;
      // A cancelled scan's files were never answered, so they must not stay
      // marked as in flight or the next listing would skip them forever.
      pending.forEach((f) => inFlight.delete(`${f.path}#${f.size}#${f.mtime}`));
    };
  }, [entries, projectId, pyMainCache, pyMainNonce, fastMode]);

  /** Re-list the current folder, and re-check every .py in it for the Run gate.
   *  Both refresh buttons (the remote bar's and the local breadcrumb's) call this,
   *  so a manual refresh means the same thing on either side. */
  function refreshListing() {
    void load(relPath);
    pyMainInFlight.current.clear();
    setPyMainNonce((n) => n + 1);
    if (projectId) void refreshSyncStatus(projectId);
  }

  // The host's ↻ (the side panel's toolbar owns that button now) reaches the
  // tree as a bumped counter. The first render carries the host's starting
  // value, which is not a refresh request — only a CHANGE is, so the last-seen
  // value is seeded from the prop rather than from 0/undefined.
  const lastRefreshNonce = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === lastRefreshNonce.current) return;
    lastRefreshNonce.current = refreshNonce;
    refreshListing();
    // `refreshListing` is re-created every render; the nonce is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  // Per-entry git status resolving the "whole directory is ignored" sentinel the
  // backend emits under the reserved key "." (git's porcelain never lists an empty
  // ignored subdir, so those children arrive absent from `gitStatuses`; without
  // this they'd fall out of the gitignored section — see git.rs `git_file_statuses`).
  // When the current folder is wholly ignored, every listed child defaults to
  // "ignored" unless it already carries an explicit status (a force-added tracked
  // file). Every consumer reads this, never the raw `gitStatuses`, so the tree, the
  // section split, and the hover card stay consistent.
  const displayStatuses = useMemo(() => {
    if (gitStatuses["."] !== "ignored") return gitStatuses;
    const m: GitStatusMap = {};
    for (const e of entries) m[e.name] = gitStatuses[e.name] ?? "ignored";
    return m;
  }, [gitStatuses, entries]);

  // The four on-screen sections in render order (regular, then the collapsible
  // scaffold + gitignored + hidden-by-extension groups). Shared by the
  // renderer and the selection click handler so a shift-range spans exactly
  // what the user sees. Mirrors the split the render body applies below.
  const sections = useMemo(() => {
    // Extension-hidden wins over both other splits — it's an explicit,
    // per-project user rule (ProjectFilesSettings), more specific than "is
    // this a scaffold file" or "does git ignore it".
    const notHiddenExt = entries.filter((e) => !isHiddenByEnding(e, hiddenEndings, relPath, shownPaths));
    const hiddenExt = entries.filter((e) => isHiddenByEnding(e, hiddenEndings, relPath, shownPaths));
    const isRoot = !relPath && separateScaffold;
    const nonStandard = isRoot ? notHiddenExt.filter((e) => !STANDARD_PROJECT_FILES.has(e.name)) : notHiddenExt;
    const standard = isRoot ? notHiddenExt.filter((e) => STANDARD_PROJECT_FILES.has(e.name)) : [];
    // The size breakdown is an independent ignored-path scan. If it establishes
    // that every byte in a folder is ignored, keep that folder out of the normal
    // section even when the status request was incomplete (for example an older
    // backend, or Git configured with status.showUntrackedFiles=no). Otherwise
    // the normal-row size subtracts the ignored bytes and misleadingly shows 0 B.
    const isIgnored = (e: FileEntry) =>
      displayStatuses[e.name] === "ignored" ||
      (e.is_dir &&
        (dirIgnoredBytes[e.path] ?? 0) > 0 &&
        dirSizes[e.path] !== undefined &&
        (dirIgnoredBytes[e.path] ?? 0) >= dirSizes[e.path]);
    // With the gitignored split off, ignored entries stay in the regular list
    // rather than moving to a section that is not rendered — the point of the
    // switch is to see them in place, not to hide them.
    const regular = separateGitignored ? nonStandard.filter((e) => !isIgnored(e)) : nonStandard;
    const gitignored = separateGitignored ? nonStandard.filter(isIgnored) : [];
    // The listing gives every folder size 0, so "Size" must sort on the figure
    // the row shows: the recursive walk, less its ignored bytes outside the
    // gitignored / hidden-by-extension groups (mirrors `dirShown` in
    // renderEntry). An unwalked or scan-excluded folder sorts last.
    const bySize = (list: FileEntry[], subtractIgnored: boolean) =>
      sortKey !== "size"
        ? list
        : sortEntries(list, "size", descending, (e) => {
            if (!e.is_dir) return e.size;
            const total = dirSizes[e.path];
            if (total === undefined) return undefined;
            return subtractIgnored ? total - (dirIgnoredBytes[e.path] ?? 0) : total;
          });
    return {
      regular: bySize(regular, true),
      standard: bySize(standard, true),
      gitignored: bySize(gitignored, false),
      hiddenExt: bySize(hiddenExt, false),
    };
  }, [
    entries,
    relPath,
    separateScaffold,
    separateGitignored,
    displayStatuses,
    dirSizes,
    dirIgnoredBytes,
    hiddenEndings,
    shownPaths,
    sortKey,
    descending,
  ]);

  // How many rows the tree will actually render, raised a page at a time by the
  // "show more" footer. Rows are NOT virtualized, and each one is ~16 elements
  // with ~11 handlers rebuilt on every render of this component — so a folder
  // holding thousands of files (an ML sweep's `results/` routinely does: one run
  // per config × per step) builds six figures of DOM and re-reconciles the lot
  // every time a size lands, a sync status refreshes, or the pointer moves. That
  // is enough to make the whole window unusable while the CPU still looks idle,
  // because the cost is layout/paint in a software-rendered webview, not compute.
  // Capping keeps the cost proportional to what is on screen; the folder is still
  // fully reachable, one page at a time.
  const [rowCap, setRowCap] = useState(ROW_CAP_STEP);
  // A new folder (or a new project) starts back at one page — the cap is about
  // this listing, not a preference to carry around the tree.
  useEffect(() => {
    setRowCap(ROW_CAP_STEP);
  }, [relPath, projectId]);

  // The rows actually rendered, in on-screen order, clipped to `rowCap` across
  // the sections as a whole (the budget is spent top-down, so raising the cap
  // extends the list rather than reshuffling it). Collapsed sections spend
  // nothing — they render no rows. Section *labels* keep counting the full
  // `sections` lists, so "gitignored (8316)" still tells the truth about the
  // folder while only a page of it is on screen.
  const rowWindow = useMemo(() => {
    let budget = rowCap;
    const clip = (list: FileEntry[]) => {
      const out = budget >= list.length ? list : list.slice(0, Math.max(0, budget));
      budget -= out.length;
      return out;
    };
    const regular = clip(sections.regular);
    const standard = scaffoldExpanded ? clip(sections.standard) : [];
    const gitignored = gitignoredExpanded ? clip(sections.gitignored) : [];
    const hiddenExt = hiddenExtExpanded ? clip(sections.hiddenExt) : [];
    const total =
      sections.regular.length +
      (scaffoldExpanded ? sections.standard.length : 0) +
      (gitignoredExpanded ? sections.gitignored.length : 0) +
      (hiddenExtExpanded ? sections.hiddenExt.length : 0);
    const shown = regular.length + standard.length + gitignored.length + hiddenExt.length;
    return { regular, standard, gitignored, hiddenExt, hidden: total - shown };
  }, [sections, rowCap, scaffoldExpanded, gitignoredExpanded, hiddenExtExpanded]);

  // Flat list of visible row paths in on-screen order — the axis a shift-range
  // spans. Collapsed sections contribute no rows (they aren't rendered), and
  // neither do rows beyond the cap: a range must span exactly what the user can
  // see, or shift-click would silently select rows that aren't on screen.
  const orderedVisible = useMemo(() => {
    const paths = rowWindow.regular.map((e) => e.path);
    paths.push(...rowWindow.standard.map((e) => e.path));
    paths.push(...rowWindow.gitignored.map((e) => e.path));
    paths.push(...rowWindow.hiddenExt.map((e) => e.path));
    return paths;
  }, [rowWindow]);

  // Prune selected paths that vanished from the listing (fs-watch removed a
  // file, a folder was deleted, etc.) so stale entries never linger in bulk ops.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map((e) => e.path));
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (live.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [entries]);

  function clearSelection() {
    anchorRef.current = null;
    setSelected((prev) => (prev.size === 0 ? prev : new Set()));
  }

  // Apply a click on a row to the selection, honouring shift (range) and
  // ctrl/cmd (toggle) via the pure `nextSelection` helper.
  function selectFromClick(entry: FileEntry, ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    setSelected((prev) => {
      const { selected: next, anchor } = nextSelection(
        prev,
        orderedVisible,
        anchorRef.current,
        entry.path,
        { shift: ev.shiftKey, toggle: ev.ctrlKey || ev.metaKey },
      );
      anchorRef.current = anchor;
      return next;
    });
  }

  // Resolve embed capability for any not-yet-known file extension in view. One
  // backend call per distinct extension; results cached in embedByExt.
  useEffect(() => {
    const unknown = new Map<string, string>(); // ext → a sample path
    for (const e of entries) {
      if (e.is_dir) continue;
      const ext = e.extension ?? "";
      if (!(ext in embedByExt) && !unknown.has(ext)) unknown.set(ext, e.path);
    }
    if (unknown.size === 0) return;
    let cancelled = false;
    (async () => {
      // Fire every distinct-extension capability probe concurrently rather than
      // awaiting each in series (Eff #8): the checks are independent, so the
      // batch finishes in roughly one round-trip instead of N.
      const results = await Promise.all(
        [...unknown].map(async ([ext, path]) => {
          try {
            const cap = await invoke<EmbedCap>("embed_capability", { path, handler: null, projectId });
            return [ext, cap.os_embeddable && cap.app_embeddable] as const;
          } catch {
            return [ext, false] as const;
          }
        }),
      );
      if (!cancelled) setEmbedByExt((m) => ({ ...m, ...Object.fromEntries(results) }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Lazily compute the recursive size of each visible gitignored-section
  // folder. Fires one backend call per not-yet-requested folder (concurrently
  // — they're independent) and fills `dirSizes` as each resolves. A failed
  // call is left unresolved; the `requestedSizes` guard keeps it (and
  // steady-state re-renders / fs-watch reloads) from re-dispatching. Plain
  // `dir_size` is enough here — the whole folder is ignored by definition, so
  // there's no split to compute, unlike the regular/standard effect below.
  //
  // Scoped to the RENDERED rows (`rowWindow`), not the whole section: pricing a
  // folder costs a recursive walk — a `du` over SSH for a remote project — so a
  // listing holding thousands of subfolders would dispatch thousands of them for
  // rows that aren't even on screen. `requestedSizes` dedupes, so raising the
  // render cap prices the newly revealed folders and only those. `active` gates
  // all three size effects the same way: a hidden tree walks nothing, and the
  // dedupe set means reactivation prices exactly the still-unpriced folders.
  useEffect(() => {
    if (!active || fastMode) return;
    const pending = rowWindow.gitignored.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      guardedDirSize(projectDir, () =>
        invoke<number>("dir_size", {
          projectDir,
          relPath: relForEntry(e),
          excluded: scanExcludedList,
        }),
      )
        .then((bytes) => {
          if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
        })
        .catch(() => {
          /* best-effort display aid — leave unresolved on failure */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowWindow.gitignored, active, fastMode]);

  // Same as the gitignored effect above, for the visible hidden-by-extension
  // rows — a plain `dir_size` is enough here too, since the group's own
  // total needs no ignored/non-ignored split.
  useEffect(() => {
    if (!active || fastMode) return;
    const pending = rowWindow.hiddenExt.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      guardedDirSize(projectDir, () =>
        invoke<number>("dir_size", {
          projectDir,
          relPath: relForEntry(e),
          excluded: scanExcludedList,
        }),
      )
        .then((bytes) => {
          if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
        })
        .catch(() => {
          /* best-effort display aid — leave unresolved on failure */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowWindow.hiddenExt, active, fastMode]);

  // Lazily compute the recursive size of each visible regular/standard-section
  // folder, split into ignored vs. non-ignored bytes in the SAME backend walk
  // that produces the total — so a folder with e.g. a build output dir mixed
  // in with source can show that split, and the ignored figure can never
  // exceed the total it was measured against (two independent walks of the
  // same folder can disagree if it's being actively written to, which is
  // exactly the kind of folder — build/output dirs — this feature targets).
  // Fills both `dirSizes` and `dirIgnoredBytes` from one response, sharing
  // `requestedSizes` with the effect above so no folder is fetched twice.
  // Scoped to the rendered rows for the same reason that effect is — see there.
  useEffect(() => {
    if (!active || fastMode) return;
    const candidates = [...rowWindow.regular, ...rowWindow.standard];
    const pending = candidates.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      guardedDirSize(projectDir, () =>
        invoke<{ total: number; ignored: number }>("dir_size_breakdown", {
          projectDir,
          relPath: relForEntry(e),
          excluded: scanExcludedList,
        }),
      )
        .then(({ total, ignored }) => {
          if (sizeGeneration.current !== gen) return;
          setDirSizes((m) => ({ ...m, [e.path]: total }));
          if (ignored > 0) setDirIgnoredBytes((m) => ({ ...m, [e.path]: ignored }));
        })
        .catch((err) => {
          // The fallback is for a `dir_size_breakdown` that failed for a reason
          // `dir_size` wouldn't (a backend that hasn't picked up this newer
          // command, no `git` on PATH) — there, a folder's size matters more than
          // its ignored split. It is NOT for a host that stopped answering: a
          // timed-out or breaker-refused call says nothing about the *command*,
          // so retrying with the other one would just queue a second doomed call
          // per folder — twice the pile-up the guard exists to prevent.
          if (err instanceof DirSizeUnavailable || isHostTimeout(err)) return;
          guardedDirSize(projectDir, () =>
            invoke<number>("dir_size", {
              projectDir,
              relPath: relForEntry(e),
              excluded: scanExcludedList,
            }),
          )
            .then((bytes) => {
              if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
            })
            .catch(() => {
              /* best-effort display aid — leave unresolved on failure */
            });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowWindow.regular, rowWindow.standard, active, fastMode]);

  // Total bytes contained in each section, kept separate rather than merged
  // into one figure — the point of splitting scaffold/gitignored out visually
  // is that their weight (e.g. a huge gitignored build dir) shouldn't hide
  // inside the "real" content total. Sums whatever `dirSizes`/`e.size` already
  // know; unresolved subfolder sizes count as 0 until their `dir_size` call
  // lands, same best-effort as the per-row display above. `regular`/`standard`
  // are non-ignored-only (mirroring the per-row headline number), with the
  // ignored portion pulled out separately so callers can put it on hover —
  // `gitignored` needs no such split, it's ignored content in its entirety.
  const groupSizes = useMemo(() => {
    const total = (list: FileEntry[]) =>
      list.reduce((sum, e) => sum + (e.is_dir ? (dirSizes[e.path] ?? 0) : e.size), 0);
    const ignored = (list: FileEntry[]) =>
      list.reduce((sum, e) => sum + (e.is_dir ? (dirIgnoredBytes[e.path] ?? 0) : 0), 0);
    // Whether the sum is still MISSING a folder — the thing that makes it a lower
    // bound rather than a measurement, and the reason it must not be printed as a
    // plain figure (see `renderGroupTotal`). Three independent causes, deliberately
    // folded into one flag because the reader's question is the same for all of
    // them: a `dir_size` still in flight (on a remote project that is a `du` over
    // SSH, four at a time), one that failed or was refused by the breaker, and a
    // folder past the render cap, which is never requested at all. An excluded
    // folder is NOT missing: it is deliberately unmeasured and contributes 0.
    const incomplete = (list: FileEntry[]) =>
      list.some(
        (e) => e.is_dir && dirSizes[e.path] === undefined && !isScanExcluded(relForEntry(e)),
      );
    const regularIgnored = ignored(sections.regular);
    const standardIgnored = ignored(sections.standard);
    return {
      regular: total(sections.regular) - regularIgnored,
      regularIgnored,
      regularPartial: incomplete(sections.regular),
      standard: total(sections.standard) - standardIgnored,
      standardIgnored,
      standardPartial: incomplete(sections.standard),
      gitignored: total(sections.gitignored),
      gitignoredPartial: incomplete(sections.gitignored),
      hiddenExt: total(sections.hiddenExt),
      hiddenExtPartial: incomplete(sections.hiddenExt),
    };
    // `relForEntry`/`isScanExcluded` depend only on `relPath`/`scanExcluded`, both
    // of which force a re-list (and so a fresh `sections`) when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, dirSizes, dirIgnoredBytes]);

  /**
   * A group header's byte total.
   *
   * A folder's recursive size arrives asynchronously and may never arrive at all
   * (a `du` over SSH that timed out, the breaker in `dirSizeGuard`, a folder past
   * the render cap that is never requested), so until every folder in the group
   * has answered the sum is a **lower bound**, not a measurement. Printing it
   * plainly is what made a remote listing read as a measured `0 B`: a folder
   * holding only subfolders sums to zero for as long as the walks take, and the
   * figure then silently corrected itself seconds later.
   *
   * So an incomplete sum says it is incomplete — `…` while nothing has landed,
   * `≥ 1.2 MB` once part of it has — and a bare figure means the total really is
   * the total.
   */
  const renderGroupTotal = (bytes: number, partial: boolean, title: string) => (
    // Fast mode: no folder walk means every sum is a permanent lower bound, so
    // the header would read "\u2265 1.2 MB" for the rest of the session. A
    // figure that can never resolve is worse than none — see `lib/agents/fastMode`'s
    // rule that an absence must be legible rather than look stuck.
    fastMode ? null : <span
      className={`file-tree-path-total${partial ? " partial" : ""}`}
      title={partial ? `${title} — ${t("fileTree.sizeIncomplete")}` : title}
    >
      {!partial
        ? fmtSize(bytes)
        : bytes > 0
          ? t("fileTree.sizeAtLeast", { size: fmtSize(bytes) })
          : "…"}
    </span>
  );

  const isEmbeddable = (e: FileEntry): boolean =>
    !e.is_dir && embedByExt[e.extension ?? ""] === true;

  // A file can be dragged onto a tab bar if either: it opens in a built-in
  // viewer (pdf/markdown/text — always, independent of any external app), or its
  // external default handler is embeddable. The built-in viewer wins when both
  // apply, so PDFs/text/markdown never depend on the configured external app.
  const draggableToTab = (e: FileEntry): InternalViewer | "embed" | null => {
    if (e.is_dir) return null;
    const viewer = internalViewerFor(e, disabledViewerSet);
    if (viewer) return viewer;
    return isEmbeddable(e) ? "embed" : null;
  };

  useEffect(() => {
    let cancelled = false;
    getTexCapability().then((cap) => { if (!cancelled) setTexCap(cap); });
    return () => { cancelled = true; };
  }, []);

  // Track Ctrl so file rows can switch to native DnD (export/copy to browser or
  // an external app) while it's held. Also clear on blur/visibility loss so a
  // release that happens while another window has focus doesn't leave rows stuck
  // in native-drag mode.
  useEffect(() => {
    // Warm the native drag-out preview icon so its path is ready (sync-readable)
    // by the time the user starts a Ctrl-drag. Only the plugin path (Win/mac)
    // needs it — the Linux `start_file_drag` embeds the icon backend-side.
    if (PLATFORM !== "linux") void warmDragIcon();
    const sync = (e: KeyboardEvent) => {
      setCtrlHeld(e.ctrlKey);
    };
    const clear = () => setCtrlHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    if (!projectDir) return;
    // Don't list a disconnected remote project's tree — the sync list_dir/
    // git_file_statuses commands would block the main thread on the dead SSH pool
    // and freeze the app. Re-runs once the pool connects (remoteBlocked flips).
    if (remoteBlocked) return;
    const rel = initialRelPath ?? "";
    // Seeded mount (the panel was revealed again): the folder is already on
    // screen, so upgrade it in place with the quiet, diffing refresh instead of
    // re-listing from scratch — no loading flash, and nothing repaints where
    // nothing changed. If the folder no longer lists, fall through to the full
    // load so the error is shown rather than the stale rows.
    if (seedPending.current) {
      seedPending.current = false;
      // One frame later, not inside this commit: `list_dir`/`git_file_statuses`
      // are SYNCHRONOUS Tauri commands on the main thread (over SFTP for a
      // remote project), so dispatching them here would stall the very frame
      // the seed exists to make instant. The tree is already on screen; the
      // upgrade can wait for it to paint.
      let cancelled = false;
      const frame = requestAnimationFrame(() => {
        void refresh(rel).then((ok) => {
          if (!ok && !cancelled) void load(rel);
        });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    load(rel);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, remoteBlocked]);

  // Keep the folder's snapshot current so the NEXT mount (a panel reveal, a
  // `panelsHidden` toggle) paints it immediately. Written from the live state
  // rather than at the fetch sites so every source that moves the tree — the
  // listing, the fs-watch refresh, each folder size as it resolves — is
  // captured by construction. Skipped while an error is up: a failed listing is
  // not a state worth restoring, and `load` has already dropped that key.
  useEffect(() => {
    if (!projectDir || error) return;
    writeFileTreeSnapshot(snapshotKeyFor(relPath), {
      entries: rawEntries,
      gitStatuses,
      dirSizes,
      dirIgnoredBytes,
    });
  }, [projectDir, snapshotKeyFor, relPath, rawEntries, gitStatuses, dirSizes, dirIgnoredBytes, error]);

  // SSH-sync Phase 1: keep the sync overlay fresh — re-stat selected files
  // whenever the tree (re)lists. Runs for both the remote-source tree and the
  // local-mirror tree (the marker is symmetric); `remoteBlocked` only ever gates
  // the remote-source case; the mirror tree keeps working offline off the last-
  // known manifest state (the backend falls back gracefully when the pool is
  // down — see `sync_status`).
  useEffect(() => {
    // `active` doubles as the reactivation catch-up: a hidden tree skips the
    // refresh, and the flip back to visible re-runs this with fresh sync state.
    if (isRemote && projectId && !remoteBlocked && active) {
      void refreshSyncStatus(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRemote, projectId, remoteBlocked, relPath, active]);

  // SSH-sync: the host tree has no change watcher (inotify can't see the SFTP
  // tree), so a remote-side edit wouldn't flip a file to amber until the user
  // re-lists — and the local-mirror view has no re-list button at all. Re-stat
  // the SELECTED files (cheap metadata over the pooled ControlMaster — NOT a
  // tree re-list) whenever Tabtivity regains focus and on a light interval, so a
  // remote-only divergence surfaces on its own shortly after it happens instead
  // of silently going stale. Gated on a live pool so a cold connection never
  // re-stats (which would report stale green); runs for both the remote-source
  // and local-mirror views (the amber marker is symmetric).
  useEffect(() => {
    // Hidden trees re-stat nothing: the sync markers they'd refresh aren't on
    // screen, and the mount-refresh effect above catches up on reactivation.
    if (!isRemote || !projectId || remoteSshState !== "connected" || !active) return;
    const refresh = () => { void refreshSyncStatus(projectId); };
    window.addEventListener("focus", refresh);
    // The 15 s tick is the third periodic walk of a host tree, after the 25 s
    // byte-sync pass and the 12 s lockstep poll — both of which the HPC tag
    // already stops for exactly the reason `lib/remote/hpc/hpcHost.ts` gives ("the same walk,
    // unasked for, forever"). A tagged login node gets no timer here either: an
    // open file tree is not a standing request to stat a cluster every quarter
    // minute. What survives is the focus listener and every explicit re-list —
    // both are gestures, and the amber marker still refreshes on each of them.
    // Fast mode drops this tick for the HPC tag's reason applied to a preference
    // rather than a host: an open file tree is not a standing request to stat a
    // host every quarter minute. The focus listener above and every explicit
    // re-list survive, so the markers still catch up on a gesture.
    const id = primaryIsHpc || fastMode
      ? undefined
      : window.setInterval(() => {
          // Only tick while Tabtivity is focused: a backgrounded window doesn't need
          // to keep re-stat'ing the host every 15 s (the `focus` listener re-stats
          // on return anyway), which keeps an idle remote project off the wire.
          if (document.hasFocus()) refresh();
        }, 15000);
    return () => {
      window.removeEventListener("focus", refresh);
      if (id !== undefined) window.clearInterval(id);
    };
  }, [isRemote, projectId, remoteSshState, refreshSyncStatus, primaryIsHpc, active, fastMode]);

  // Local-mirror view: readdir the HOST for the browsed folder so folders that
  // live only in the local mirror can be flagged (see `hostChildNames`). One
  // cheap SFTP readdir per navigation, gated on a live pool. If the folder ITSELF
  // isn't on the host (readdir fails), every local child here is off-host too, so
  // an empty set is the right answer — it flags them all.
  useEffect(() => {
    // `!active`: a hidden tree probes no host; the flags fall back to "unknown"
    // (no markers) and the reactivation re-run re-probes.
    if (!treatLocal || !isRemote || !remoteProbeDir || remoteSshState !== "connected" || !active) {
      setHostChildNames(null);
      return;
    }
    let cancelled = false;
    const target = relPath;
    invoke<FileEntry[]>("list_dir", { projectDir: remoteProbeDir, relPath: target })
      .then((entries) => {
        if (!cancelled) setHostChildNames(new Set(entries.map((x) => x.name)));
      })
      .catch(() => {
        if (!cancelled) setHostChildNames(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [treatLocal, isRemote, remoteProbeDir, remoteSshState, relPath, active]);

  // Live updates: watch the currently-displayed directory on the backend and
  // re-fetch when it changes, so files created/removed by terminals, agents, or
  // other processes appear without manual navigation. Re-points to the new
  // directory whenever relPath changes; tears down on unmount/panel close.
  //
  // Active surfaces only: trees stay mounted while hidden (background Files
  // tabs, backgrounded projects), and the fs-change listener ignores the event's
  // path — so every mounted tree used to re-list (list_dir + git_file_statuses)
  // on every event burst anywhere. A hidden tree now stops watching entirely and
  // catches up with ONE quiet re-list when its surface is next shown (the same
  // identity-preserving refresh an fs-change triggers, so nothing repaints when
  // nothing changed). React runs effect cleanups before setups across the tree,
  // so the deactivating tree's `unwatch_dir` lands before the activating tree's
  // `watch_dir` claims the single backend watch slot.
  const sawInactive = useRef(false);
  useEffect(() => {
    // Remote projects have no local fs watcher (inotify can't see the SFTP tree);
    // they refresh manually via the toolbar button. Skip the watch wiring. The
    // local mirror source IS a real local dir, so it keeps live watch updates.
    if (!projectDir || remoteListing) return;
    if (!active) {
      sawInactive.current = true;
      return;
    }
    if (sawInactive.current) {
      sawInactive.current = false;
      void refresh(relPath);
    }
    const absDir = relPath ? `${projectDir}/${relPath}` : projectDir;
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // `repoDir` points the backend's `.git` watch at the project's repo, so
    // add/commit/push (which only write `.git/`) re-read the markers too.
    invoke("watch_dir", { path: absDir, repoDir: projectDir }).catch(() => {});
    listen("fs-change", () => {
      // Coalesce the burst of events a single write emits into one reload.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refresh(relPath), 250);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
      invoke("unwatch_dir").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, relPath, remoteListing, active]);

  async function load(rel: string) {
    // Never issue the (synchronous, main-thread) remote listing commands while the
    // pool is down — they would freeze the window. See `remoteBlocked`.
    if (remoteBlocked) return;
    loadTargetRef.current = rel;
    setError(null);
    setMissingCrumbDepth(null);
    // Navigating into a different folder abandons the current selection (its
    // paths aren't on screen anymore). The quiet fs-watch `refresh()` deliberately
    // does NOT clear — a background re-list must not wipe an in-progress selection.
    clearSelection();
    // Re-listing (navigation or an explicit refresh) recomputes folder sizes:
    // drop the cache + in-flight guard so the effect re-requests them fresh, and
    // bump the generation so a call still walking the OLD folder can't land its
    // bytes on the new listing. The quiet fs-watch `refresh()` deliberately does
    // NOT do this — folder sizes stay put through watch churn.
    sizeGeneration.current += 1;
    requestedSizes.current.clear();
    // The folder's last-known listing, if we've been here before: paint it (and
    // its sizes) at once so navigation lands on a populated tree instead of a
    // spinner, then let the fetch below replace it. `relPath` moves WITH the
    // seeded entries, never before them — a breadcrumb pointing at one folder
    // over another folder's rows would resolve a clicked row's path against the
    // wrong root. Everything is re-requested regardless (the dedupe set was just
    // cleared), so a seed only ever decides what is on screen in the meantime.
    const seed = readFileTreeSnapshot(snapshotKeyFor(rel));
    let announced = false;
    const announceRel = () => {
      if (announced) return;
      announced = true;
      setRelPath(rel);
      onRelPathChange?.(rel);
    };
    if (seed) {
      announceRel();
      setRawEntries(seed.entries);
      setGitStatuses(seed.gitStatuses);
      setDirSizes(seed.dirSizes);
      setDirIgnoredBytes(seed.dirIgnoredBytes);
    } else {
      setLoading(true);
      setDirSizes({});
      setDirIgnoredBytes({});
    }
    try {
      const result = await invoke<FileEntry[]>("list_dir", {
        projectDir,
        relPath: rel,
      });
      // Superseded by a later navigation: that load owns the screen now.
      if (loadTargetRef.current !== rel) return;
      setRawEntries((prev) => (fileEntriesEqual(prev, result) ? prev : result));
      announceRel();
      const statuses = await invoke<GitStatusMap | null>("git_file_statuses", {
        projectDir,
        relPath: rel,
      }).catch(() => null);
      if (loadTargetRef.current !== rel) return;
      // A failed status probe is a transient (a `.git/index.lock` held by
      // another git, a spawn hiccup) and not "nothing is ignored/modified":
      // keep what is on screen (the seed's letters) rather than wiping it to a
      // map that moves every ignored folder into the regular list for one
      // frame. Unseeded, there is nothing to keep — the previous folder's
      // letters belong to the previous folder.
      if (statuses) setGitStatuses((prev) => (stringMapsEqual(prev, statuses) ? prev : statuses));
      else if (!seed) setGitStatuses({});
    } catch (e) {
      if (loadTargetRef.current !== rel) return;
      // The listing failed — most often because "Remote" was selected in a
      // folder that only exists in the local mirror. Drop the previous listing
      // (which would otherwise leave the LOCAL files on screen under a Remote
      // header, falsely implying they're on the host) and show a readable
      // reason. Keep `relPath` so the breadcrumb / Local switch still work.
      // Forget the snapshot too: a folder that no longer lists must not come
      // back seeded (and silently listing-looking) on the next reveal.
      dropFileTreeSnapshot(snapshotKeyFor(rel));
      setRawEntries([]);
      setGitStatuses({});
      announceRel();
      setError(describeListError(t, e, remoteListing));
      // Remote source: find where the path stops existing on the host so the
      // breadcrumb can show the boundary (on-host prefix vs local-only tail).
      // Only on a remote failure, walking up from the deepest ancestor — a
      // handful of cheap SFTP stats over the already-live pool.
      if (remoteListing) void probeRemoteBoundary(rel);
    } finally {
      // A superseded load leaves the spinner to the load that replaced it.
      if (loadTargetRef.current === rel) setLoading(false);
    }
  }

  // Walk up the failed path to the deepest ancestor that DOES list on the host,
  // and mark the first segment past it as the start of the local-only tail. Root
  // ("") is assumed present, so a path whose very first segment is absent marks
  // depth 0. Best-effort and self-cancelling: a newer `load` clears the state.
  async function probeRemoteBoundary(rel: string) {
    const parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) return;
    let depth = 0; // default: first segment already missing
    for (let k = parts.length - 1; k >= 1; k--) {
      const prefix = parts.slice(0, k).join("/");
      try {
        await invoke<FileEntry[]>("list_dir", { projectDir, relPath: prefix });
        depth = k;
        break;
      } catch {
        // keep walking up
      }
    }
    // Guard against a race: only apply if we're still on the same failed path.
    if (loadTargetRef.current === rel) setMissingCrumbDepth(depth);
  }

  // Right-click the breadcrumb: copy the current folder's absolute path to the
  // clipboard and open the inline path editor pre-filled with it.
  function startPathEdit() {
    const abs = resolvePath(projectDir, relPath);
    navigator.clipboard?.writeText(abs).catch(() => {});
    setPathEdit(abs);
  }

  // Commit the edited path: accept either an absolute path or a project-relative
  // one, resolve it against the project root, and navigate there when it stays
  // inside the project. A path outside the project is rejected (the tree is
  // project-scoped) — the field just closes without navigating.
  function commitPathEdit() {
    const raw = pathEdit?.trim() ?? "";
    setPathEdit(null);
    if (!raw) return;
    const abs = resolvePath(projectDir, raw);
    const rel = relativePathWithin(projectDir, abs);
    if (rel === null) return;
    if (rel !== relPath) void load(rel);
  }

  // Focus + select the path field when it opens so the copied path can be
  // replaced or edited immediately.
  useEffect(() => {
    if (pathEdit !== null) pathEditRef.current?.select();
  }, [pathEdit !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quiet reload for the fs watcher: re-fetch the current directory without the
  // loading flash, and only swap state in when the result actually changed.
  // Replacing rawEntries/gitStatuses on every event (a single write emits a
  // burst) is what caused the tree to flicker, so we diff before committing.
  // Returns whether the folder listed. The fs-watch caller ignores it (a failure
  // there is transient churn); the seeded mount uses it to fall back to a full
  // `load`, which is what surfaces the error for a folder that really is gone.
  async function refresh(rel: string): Promise<boolean> {
    if (remoteBlocked) return true;
    let result: FileEntry[];
    try {
      result = await invoke<FileEntry[]>("list_dir", { projectDir, relPath: rel });
    } catch {
      return false; // transient (e.g. dir mid-rename) — keep the last good listing
    }
    // The tree has navigated away while this was in flight: these rows belong
    // to a folder that is no longer on screen. Reported as listed — the caller's
    // only fallback is a full load of `rel`, which would be just as stale.
    if (loadTargetRef.current !== rel) return true;
    setRawEntries((prev) => (fileEntriesEqual(prev, result) ? prev : result));
    const statuses = await invoke<GitStatusMap | null>("git_file_statuses", {
      projectDir,
      relPath: rel,
    }).catch(() => null);
    if (loadTargetRef.current !== rel) return true;
    // Keep the last good letters over a failed probe (see `load`): a quiet
    // refresh must never move rows between sections because git was busy.
    if (statuses) setGitStatuses((prev) => (stringMapsEqual(prev, statuses) ? prev : statuses));
    return true;
  }

  // Jump-to-path: reveal a project-relative path in the tree. A folder navigates
  // into it; a file navigates to its parent folder and selects+scrolls it. Leaves
  // search mode so the tree (with the target selected) is what's shown. Used by
  // every search result (both name and content hits).
  function revealPath(rel: string, isDir: boolean) {
    setSearch("");
    if (isDir) {
      load(rel);
      return;
    }
    const parts = rel.split("/").filter(Boolean);
    const name = parts[parts.length - 1] ?? "";
    const parent = parts.slice(0, -1).join("/");
    // Expand the collapsible sections so the row is rendered wherever it lives
    // (a scaffold or gitignored file would otherwise be hidden). The subsequent
    // effect selects and scrolls once the folder has listed.
    setScaffoldExpanded(true);
    setGitignoredExpanded(true);
    setPendingReveal({ parent, name });
    if (parent !== relPath) load(parent);
  }

  // Resolve a pending reveal once the target folder is listed: select the entry
  // and scroll its row into view, then clear the request. Gives up (clears) if
  // the entry isn't in the listing — e.g. hidden by a filter.
  useEffect(() => {
    if (!pendingReveal) return;
    if (pendingReveal.parent !== relPath) return; // still navigating
    const entry = entries.find((e) => e.name === pendingReveal.name);
    if (!entry) {
      setPendingReveal(null);
      return;
    }
    anchorRef.current = entry.path;
    setSelected(new Set([entry.path]));
    const path = entry.path;
    requestAnimationFrame(() => {
      try {
        document
          .querySelector(`[data-entry-path="${CSS.escape(path)}"]`)
          ?.scrollIntoView({ block: "center" });
      } catch {
        /* best-effort scroll */
      }
    });
    setPendingReveal(null);
  }, [entries, pendingReveal, relPath]);

  function handleClick(entry: FileEntry) {
    if (entry.is_dir) {
      const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
      load(rel);
    } else if (entry.extension === ".zip") {
      // A zip "opens" by extracting in place into a sibling folder, then
      // navigating into it — rather than handing the archive to an external app.
      void extractArchive(entry);
    } else {
      openEntry(entry, false);
    }
  }

  // Open one file entry: a native-viewer type lands as an embed tab in the
  // project's focused subwindow (or streams into a popout via `fileDrop`); a
  // type with no native viewer, or an explicit external open (Shift), opens in
  // the OS default app. The single open-a-file policy — see `openFileEntry`.
  function openEntry(entry: FileEntry, external: boolean) {
    openFileEntry({
      entry,
      projectDir,
      projectId,
      origin: "side_file_tree",
      external,
      disabled: disabledViewerSet,
      // In a detached popout, stream the viewer tab into that window rather than
      // writing the popout's non-authoritative local tab store.
      placeTab: fileDrop ? fileDrop.openTab : undefined,
      scope: tabScope,
    });
  }

  // Single-click routing. A plain click on a folder navigates into it (and
  // drops any selection); every other click — a file, or a modifier-click on a
  // folder — drives the multi-selection instead (shift = range, ctrl/cmd =
  // toggle). Opening a file stays a double-click (onDoubleClick → handleOpen).
  function handleRowClick(ev: React.MouseEvent, entry: FileEntry) {
    const hasMod = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (entry.is_dir && !hasMod) {
      clearSelection();
      handleClick(entry);
      return;
    }
    selectFromClick(entry, ev);
    // Take keyboard focus so Delete/Enter/Escape act on this selection without a
    // manual Tab-in (the row's pointerdown preventDefault suppresses auto-focus).
    treeRootRef.current?.focus({ preventScroll: true });
  }

  // Open a file on double-click. A native-viewer type opens in the focused
  // subwindow; a type with no native viewer — or a Shift+double-click — opens in
  // the OS default app (see `openEntry`). If the entry belongs to a
  // multi-selection, open EVERY selected file this way; otherwise just this one.
  // Folders keep navigating via handleClick.
  function handleOpen(entry: FileEntry, ev?: React.MouseEvent) {
    if (entry.is_dir) {
      handleClick(entry);
      return;
    }
    const external = ev?.shiftKey ?? false;
    const targets =
      selected.has(entry.path) && selected.size > 1
        ? entries.filter((e) => !e.is_dir && selected.has(e.path))
        : [entry];
    for (const t of targets) {
      if (t.extension === ".zip") void extractArchive(t);
      else openEntry(t, external);
    }
  }

  // Keyboard on the focused tree: Enter opens every selected file, Escape drops
  // the selection, Delete removes it (the right-click Delete's keyboard twin).
  // Only acts while something is selected so it never steals keys from the rest
  // of the panel.
  function handleTreeKeyDown(ev: React.KeyboardEvent) {
    if (selected.size === 0) return;
    // Never hijack Delete/Enter from the in-tree search box or a rename field.
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (ev.key === "Escape") {
      ev.stopPropagation();
      clearSelection();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      // Enter mirrors a double-click; Shift+Enter forces the external app.
      for (const t of entries.filter((e) => !e.is_dir && selected.has(e.path))) {
        if (t.extension === ".zip") void extractArchive(t);
        else openEntry(t, ev.shiftKey);
      }
    } else if (ev.key === "Delete") {
      ev.preventDefault();
      // Mirror the context menu's bulk target set (files and folders alike).
      promptDelete(entries.filter((e) => selected.has(e.path)));
    }
  }

  /** Extract a .zip into a new sibling folder and navigate into it. */
  async function extractArchive(entry: FileEntry) {
    setContextMenu(null);
    setLoading(true);
    setError(null);
    try {
      const folderRel = await invoke<string>("extract_archive", {
        projectDir,
        relPath: relForEntry(entry),
      });
      await load(folderRel);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function goUp() {
    const parts = relPath.split("/").filter(Boolean);
    parts.pop();
    load(parts.join("/"));
  }

  // A tooltip opens on DWELL, never on mere entry. `tooltip` is state on THIS
  // component and the rows are not memoized, so each open/close re-renders the
  // whole listing — and `getBoundingClientRect()` forces a synchronous reflow on
  // top. Setting it from `onMouseEnter` therefore made a mouse merely *crossing*
  // the tree cost two full re-renders plus two reflows per row, which is what
  // made moving over the tree stutter (worst under the software renderer, since
  // `WEBKIT_DISABLE_DMABUF_RENDERER=1` puts every repaint on the CPU). Deferring
  // makes a pass-over free: only a genuine pause measures and opens anything.
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelTooltipTimer() {
    if (tooltipTimer.current !== null) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
  }

  function handleEntryMouseEnter(e: React.MouseEvent<HTMLDivElement>, entry: FileEntry) {
    // `currentTarget` is nulled once the handler returns, so capture the row now
    // rather than inside the timeout.
    const row = e.currentTarget;
    cancelTooltipTimer();
    tooltipTimer.current = setTimeout(() => {
      tooltipTimer.current = null;
      // Always shows the name (the row can truncate it); Created/Modified/Ignored
      // lines below are conditional on the entry actually having that data.
      setTooltip({ rect: row.getBoundingClientRect(), entry });
    }, TOOLTIP_DWELL_MS);
  }

  function handleEntryMouseLeave() {
    cancelTooltipTimer();
    // Costs no render when nothing is open: React bails out on an unchanged
    // value, so a sweep across rows that never dwelt stays free.
    setTooltip(null);
  }

  // Start the native OS drag-out (EXPORT/COPY to another app: a browser, Signal,
  // a file manager, the desktop). Real OLE/NSDragging/GTK drag with an
  // OS-rendered icon; copy semantics, so files are never MOVED out of the
  // project. Reached two ways: a dir's HTML5 dragstart (handleEntryDragStart),
  // and the mid-drag Ctrl handoff inside onEntryPointerDown.
  function beginNativeFileDrag(paths: string[]) {
    // Linux uses our own GTK drag (`start_file_drag`): tauri-plugin-drag's GTK
    // backend hands external targets an EMPTY payload — it tears down its
    // drag-data-get handler at drop-performed, before the target requests the
    // text/uri-list data — so a drop into a browser silently did nothing (it
    // also ships unencoded file:// URIs, which strict consumers discard).
    if (PLATFORM === "linux") {
      void invoke("start_file_drag", { paths }).catch((err) =>
        // Surfaces the most common failure: the backend wasn't rebuilt, so the
        // command doesn't exist yet — the drag silently no-ops otherwise.
        console.error(`[${BRAND.slug}] native file drag-out failed:`, err),
      );
      return;
    }
    const begin = (icon: string) =>
      startDrag({ item: paths, icon, mode: "copy" })
        .catch((err) => {
          // Same visibility for the plugin path (`plugin:drag|start_drag` and
          // `drag_preview_icon` only exist after a backend rebuild).
          console.error(`[${BRAND.slug}] native file drag-out failed:`, err);
        });
    // The icon data URL is normally warm by drag time; if not, resolve first.
    if (dragIconDataUrl) void begin(dragIconDataUrl);
    else void warmDragIcon().then(begin);
  }

  function handleEntryDragStart(e: React.DragEvent<HTMLDivElement>, entry: FileEntry) {
    // WebKitGTK's HTML5 drag-out renders no drag image outside the window and
    // doesn't reliably export the file to other apps, so suppress it and hand
    // off to the native OS drag.
    e.preventDefault();
    // Dragging a row that belongs to a >1 selection exports the whole
    // selection, mirroring the pointer drag-to-tab's multi-drag.
    const paths =
      selected.has(entry.path) && selected.size > 1
        ? entries.filter((en) => selected.has(en.path)).map((en) => en.path)
        : [entry.path];
    beginNativeFileDrag(paths);
  }

  // Start a pointer-based drag from a file row, mirroring TabBar.onTabPointerDown.
  // HTML5 native DnD is unreliable on WebKitGTK (it hijacks the pointer stream
  // and fires pointercancel), so once the pointer crosses a 5px threshold we
  // drive a "file" drag from plain window listeners. On drop, commitFileDrop
  // either opens the file as a frameless embed tab (capability permitting) or
  // falls back to an external launch.
  //
  // R6: we e.preventDefault() here to suppress native DnD and the row's
  // `draggable`/onDragStart is disabled for files (see renderEntry), so both
  // can't fire. The commit fires from THIS handler's window-pointerup — the
  // only listener guaranteed to see the release before pointer capture on
  // WebKitGTK — never from CenterPanel.
  function onEntryPointerDown(
    e: React.PointerEvent,
    entry: FileEntry,
    dragTarget: InternalViewer | "embed" | null,
  ) {
    if (e.button !== 0 || entry.is_dir) return;
    // A built-in viewer drives the in-app drop; "embed" means an external
    // handler, so no viewer. `canTab` is whether this file can land on a tab bar
    // / new window at all — only such files take the commitFileDrop path on
    // release. Files without a tab target are still draggable, but ONLY to move
    // them into a folder (drag-to-move); released anywhere else they do nothing.
    const viewer = dragTarget === "embed" ? null : dragTarget;
    const canTab = dragTarget != null;
    // Multi-selection drag: if the pressed row belongs to a >1 selection, the
    // whole selection is dragged; otherwise just this row. `dragEntries` (files
    // + folders) drives drag-to-move; `dragFiles` (file members only, with their
    // built-in viewer resolved) is the tab/window drop payload — folders can move
    // but never become tabs. A release over a tab bar / split / new window
    // creates tabs when `canDrop`: for a single drag only a viewer/embed file
    // qualifies (unchanged); for a multi drag any file member becomes an embed
    // tab.
    const isMultiDrag = selected.has(entry.path) && selected.size > 1;
    const dragEntries = isMultiDrag ? entries.filter((en) => selected.has(en.path)) : [entry];
    const dragFiles: FileDragItem[] = dragEntries
      .filter((en) => !en.is_dir)
      .map((en) => ({ path: en.path, name: en.name, viewer: internalViewerFor(en, disabledViewerSet) ?? undefined }));
    const canDrop = isMultiDrag ? dragFiles.length > 0 : canTab;
    // Ctrl held → the user wants to EXPORT/COPY this file out to another app
    // (Signal, a browser, a file manager). The row arms HTML5 `draggable` while
    // `ctrlHeld` (see renderEntry); its onDragStart suppresses the broken
    // WebKitGTK drag and hands off to the native OS drag (handleEntryDragStart).
    // Bail out here without preventDefault so that gesture takes over instead of
    // the pointer drag-to-tab.
    if (e.ctrlKey) return;
    // Let the inline run (▶) button own its own clicks — don't seed a drag or
    // swallow the click when the press lands on it.
    if ((e.target as HTMLElement).closest(".file-run-btn")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const captureEl = e.currentTarget as HTMLElement;
    let dragging = false;
    // #42: an open popout of the current scope is a valid drop target — releasing
    // the file over one docks it there as an embed tab instead of spawning a new
    // window. SAME shared session the tab drag (TabBar) uses, so a file dragged
    // over a popout behaves exactly like one dragged over the main window.
    const detached = startDetachedDropSession();

    // Latest in-window client coords ("outside this window" test) and the latest
    // physical desktop cursor (cross-window hit-test, poll-driven — see lib/window/coords;
    // DOM screenX/Y units diverge across WebKitGTK/WebView2/WKWebView).
    let lastClient = { x: startX, y: startY };
    let lastPhys: PhysPoint | null = null;
    let stopPoll: (() => void) | null = null;

    // Mid-drag Ctrl → arms the native OS EXPORT drag (copy the file(s) out to
    // whatever app the cursor ends up over). Ctrl *before* the press is the
    // multi-select toggle, so export is armed by pressing Ctrl AFTER the drag
    // is underway — symmetric with Shift, which modifies the drop while
    // already dragging (see DragGhost's modifier highlight). Mirrors that:
    // holding Ctrl only MARKS the ghost's "copy out" option; the in-app hover
    // (ghost, folder highlight, popout hover) keeps running unchanged.
    //
    // The gesture then switches between two modes at the WINDOW BOUNDARY, and
    // can switch back and forth as often as the user likes:
    //  - leaving the window with Ctrl held → the OS drag takes over the still-
    //    held button (GTK can only BEGIN a drag while the button is physically
    //    down, so the crossing is the last moment this is possible), and a
    //    release out there drops into the external app.
    //  - coming back INTO the window → the OS drag is cancelled and the in-app
    //    ghost/hover resumes, so re-entering never leaves the user staring at
    //    an OS drag icon over Tabtivity's own window.
    // While the OS owns the drag the webview sees no pointer events at all, so
    // the boundary test runs off the OS-cursor poll (physical px → this
    // window's client px via the frame snapshot), which keeps ticking
    // regardless of who holds the pointer grab.
    let nativeActive = false;
    let frame: WindowFrame | null = null;
    // The `tabtivity:file-drag-ended` subscription (registered below, once the
    // gesture is real) and whether the gesture has already ended — `listen` is
    // async, so it can resolve after cleanup and must then unsubscribe at once.
    let unlistenEnded: (() => void) | null = null;
    let gestureOver = false;
    const inWindow = (c: { x: number; y: number }) =>
      c.x >= 0 && c.y >= 0 && c.x < window.innerWidth && c.y < window.innerHeight;
    const toNativeDrag = () => {
      if (!dragging || nativeActive) return;
      nativeActive = true;
      // The in-app drop targets are meaningless while the OS owns the drag.
      spring.cancel();
      setMoveTarget(null);
      detached.hover(null, { x: 0, y: 0 }, entry.name);
      beginNativeFileDrag(dragEntries.map((en) => en.path));
    };
    const backToInAppDrag = () => {
      if (!nativeActive) return;
      nativeActive = false;
      void invoke("cancel_file_drag").catch(() => {});
    };
    // Ctrl, tracked as gesture state rather than read off each pointer event.
    // Cancelling the GTK drag hands the pointer back, but NOT the implicit grab
    // the original pointerdown had: the webview then sees plain mousemove while
    // the cursor is over the window and NOTHING once it leaves. So after one
    // handoff, `PointerEvent.ctrlKey` stops arriving exactly where the next
    // handoff would need it — hence a flag the key events maintain, plus the
    // cursor poll below as the position source. (The keydown arm also covers
    // Ctrl pressed while the cursor already sits outside the window.)
    let ctrlDown = false;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Control") return;
      ctrlDown = true;
      if (dragging && !inWindow(lastClient)) toNativeDrag();
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key === "Control") ctrlDown = false;
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
        useDragStore.getState().startFileDrag({
          label: isMultiDrag ? `${dragEntries.length} items` : entry.name,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          filePath: entry.path,
          fileName: entry.name,
          viewer: viewer ?? undefined,
          files: isMultiDrag ? dragFiles : undefined,
        });
        // Built-in viewers render in-app and need no external handler, so skip
        // the embed-capability probe for them. For other embeddable files,
        // prefetch the capability so the drop can resolve embed-vs-external.
        if (!viewer) {
          invoke<EmbedCap>("embed_capability", { path: entry.path, handler: null, projectId })
            .then((cap) => useDragStore.getState().setEmbedCap(cap))
            .catch(() => useDragStore.getState().setEmbedCap(null));
        }
        // Begin resolving popout drop targets now that a real drag is underway.
        void detached.resolve();
        // Capture the terminal pointer event on engines that don't keep delivering
        // it past the source window's HWND (Win/mac); WebKitGTK keeps the implicit
        // grab, so the flag leaves capture off there.
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* capture is best-effort; the OS-cursor poll does not depend on it */
          }
        }
        // This window's geometry, for mapping the polled OS cursor back into
        // client px while the OS drag owns the pointer (see `nativeActive`).
        void snapshotFrame()
          .then((f) => {
            frame = f;
          })
          .catch(() => {});
        // Poll the OS cursor (physical desktop px) to drive the popout hover past
        // the main viewport — DOM pointermove may not cross the OS window boundary.
        stopPoll = startCursorPoll((p) => {
          lastPhys = p;
          // The poll is the SOLE arbiter of the window boundary, in BOTH
          // directions. DOM pointer events can't be: once the OS drag has run
          // even once, the implicit grab is gone, so they stop at the window
          // edge — exactly where the crossing has to be detected.
          const c = frame ? physToClient(frame, p) : null;
          if (nativeActive) {
            if (!c) return;
            // The OS owns the pointer: this poll is also the only position
            // source, so keep the ghost tracking the cursor for the moment it
            // comes back in — whereupon the OS drag is cancelled and the
            // in-app hover takes over again.
            lastClient = c;
            useDragStore.getState().move(c.x, c.y);
            if (inWindow(c)) backToInAppDrag();
            return;
          }
          if (c && ctrlDown && !inWindow(c)) {
            toNativeDrag();
            return;
          }
          detached.hover(detached.at(p), p, entry.name);
        });
      }
      // While the OS drag owns the pointer, a stray DOM move must not fight the
      // poll for the ghost position or revive the in-app drop targets.
      if (nativeActive) return;
      ctrlDown = ev.ctrlKey;
      lastClient = { x: ev.clientX, y: ev.clientY };
      useDragStore.getState().move(ev.clientX, ev.clientY);
      hitTestMove(ev.clientX, ev.clientY);
      // Inside a detached popout, CenterPanel's window-wide drop authority isn't
      // there to resolve the pane under the cursor — do it here so the popout's
      // split/merge preview lights up and the release has a target to commit to.
      // (In the main window CenterPanel owns this; `fileDrop` is null there.)
      if (fileDrop) fileDrop.resolveTarget(ev.clientX, ev.clientY);
    };

    // Drag-to-move: highlight the folder row / breadcrumb / up button under the
    // cursor as the destination. The drag ghost is pointer-events:none, so
    // elementFromPoint reaches the rows beneath it — including rows of OTHER
    // mounted trees (a box member root, a Files tab of another project), so
    // every target carries its own tree's identity and `resolveMoveTarget`
    // decides what a drop there means: a same-tree move (dropping onto the
    // file's current folder is a no-op), a cross-project move (local↔local
    // only), or nothing. Runs on every pointermove, and once more after a
    // spring-load navigation lands (the rows under a still cursor changed).
    function hitTestMove(x: number, y: number) {
      const overEl = document.elementFromPoint(x, y) as HTMLElement | null;
      const moveEl = overEl?.closest<HTMLElement>("[data-move-rel]") ?? null;
      const target = moveEl
        ? {
            rel: moveEl.getAttribute("data-move-rel") ?? "",
            root: moveEl.getAttribute("data-move-root") ?? projectDir,
            remote: moveEl.getAttribute("data-move-remote") === "1",
          }
        : null;
      const resolved = resolveMoveTarget(target, {
        root: projectDir,
        folderRel: relPath,
        remote: remoteListing,
      });
      setMoveTarget(resolved, resolved?.crossRoot ? moveEl : null);
      // Spring-loading: hovering a folder row / crumb / ↑ of THIS tree navigates
      // there after a dwell, so the drag can reach folders the current listing
      // doesn't show. Same tree only — another tree's `load` is out of reach
      // from here. Not the folder already listed (nothing to open), and not a
      // folder that is itself being dragged (it can't hold itself).
      const springKey =
        target && target.root === projectDir && target.rel !== relPathRef.current
          ? target.rel
          : null;
      spring.hover(
        springKey !== null &&
          !dragEntries.some((de) => de.is_dir && relForEntry(de) === springKey)
          ? springKey
          : null,
        { x, y },
      );
    }
    const spring = createSpringLoader({
      delayMs: SPRING_LOAD_MS,
      onOpen: (rel) => {
        if (gestureOver || nativeActive) return;
        void load(rel).then(() => {
          // The listing under the (unmoved) cursor changed: re-resolve the drop
          // target against the new rows once React has painted them, so the
          // highlight and a release without further movement agree with what
          // the user sees.
          requestAnimationFrame(() => {
            if (!gestureOver && !nativeActive) hitTestMove(lastClient.x, lastClient.y);
          });
        });
      },
    });

    // Tear down the move listener, poll, popout highlight, and pointer capture —
    // however the gesture resolves.
    const cleanup = () => {
      gestureOver = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      spring.cancel();
      setMoveTarget(null);
      stopPoll?.();
      unlistenEnded?.();
      unlistenEnded = null;
      // Clear the popout highlight + tear down the panes listener. `targetAt`
      // still hit-tests the cached pane geometry for the commit below.
      detached.dispose();
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    const commitRelease = async (shiftKey: boolean) => {
      const releasedAt = Date.now();
      // The OS owns the drag: it is dropping into an external app, and the
      // in-app drop targets don't apply. `tabtivity:file-drag-ended` ends the
      // gesture instead (a stray pointerup here must not ALSO spawn a tab or a
      // window on top of the export).
      if (nativeActive) return;
      // Read the drop-target folder BEFORE cleanup() runs — cleanup calls
      // setMoveTarget(null), which nulls moveTargetRef.current, so reading it
      // afterwards always saw null and silently dropped every drag-to-move (the
      // file just stayed put). See git dfcb6e0, which introduced the read below
      // the cleanup() call.
      const moveTarget = moveTargetRef.current;
      cleanup();
      if (!dragging) {
        // Never moved → a plain click does NOT open. Opening a file is a
        // double-click (onDoubleClick → handleClick); dragging it onto a tab bar
        // is the other gesture. So a single click is a no-op here.
        return;
      }
      // Drag-to-move takes precedence: released over a folder / breadcrumb in the
      // tree → relocate the file(s) there. This is the one gesture available to
      // ALL files (even those with no tab/viewer target). When a multi-selection
      // is being dragged, every selected file moves. A cross-root target
      // (another project's tree in a box view, or another project's Files tab)
      // moves INTO that project — `move_path` confines each side to its own
      // root, so the two-root call is the supported shape.
      if (moveTarget != null) {
        useDragStore.getState().end();
        for (const de of dragEntries) {
          await moveEntryToFolder(relForEntry(de), de.name, moveTarget, de.path);
        }
        return;
      }
      const d = useDragStore.getState().drag;
      if (d == null) return;
      // A file with no tab/viewer/embed target can only be moved (handled above);
      // released anywhere else it does nothing — never leak it out as an external
      // open or an empty embed tab. (Multi drags qualify when any file member can
      // become a tab — see `canDrop`.)
      if (!canDrop) {
        useDragStore.getState().end();
        return;
      }
      // Inside a detached popout: commit against the pane resolved above by the
      // injected controller (a new embed tab into that pane, streamed to the main
      // window as an `add` edit). The main window's cross-window branches below —
      // dock into ANOTHER popout, spawn a new standalone window — don't apply
      // here (a popout can't own the main tab store), so this is the whole commit.
      if (fileDrop) {
        fileDrop.commit(d, projectDir);
        useDragStore.getState().end();
        return;
      }
      // Final physical cursor at release (a fresh read; falls back to the last
      // poll reading if the IPC fails). This is the canonical cross-window space.
      const phys = (await desktopCursor().catch(() => null)) ?? lastPhys;
      // Released over an open popout → dock the file into it as an embed tab,
      // landing in the SPECIFIC pane the popout resolved under the cursor (mirrors
      // a tab dragged onto a popout). BUT only if the popout is actually the front
      // window at the drop point: its bounds can geometrically contain the cursor
      // while it sits BEHIND the main window (the press raised the main window) or
      // another app. Docking into a popout the user can't see is wrong — treat an
      // occluded popout like a release into empty space so a NEW window opens.
      // Shift forces a brand-new standalone window even when released over a
      // front popout — the explicit "don't dock here, give me a fresh window"
      // override the user asked for.
      const overDetached = phys ? detached.at(phys) : null;
      const overFrontDetached =
        !shiftKey &&
        overDetached &&
        (await invoke<boolean>("detached_window_frontmost", {
          registryId: overDetached.label,
        }).catch(() => true));
      if (overDetached && overFrontDetached && phys) {
        commitFileDrop(d, projectId, projectDir, null, {
          scope: overDetached.scope,
          groupId: overDetached.groupId,
          target: detached.targetAt(overDetached, phys),
        });
        useDragStore.getState().end();
        return;
      }
      // Released OUTSIDE the main window (e.g. dragged onto another monitor):
      // open the file in its own standalone detached window at the cursor. Client
      // coords outside [0,inner) is the signal. The new window's bounds feed Rust
      // `.position(x,y)`, which is PHYSICAL → use the physical cursor, not DOM
      // screen coords.
      //
      // A popout under the cursor is NOT treated as "outside" here: a FRONT popout
      // was already docked into above; an OCCLUDED popout (behind the main window)
      // means the main window is what's actually under the cursor, so the release
      // must fall through to the in-window split — spawning a new window the user
      // can't see they're aiming at is exactly the bug this avoids.
      //
      // Shift forces a new window even when released INSIDE the main window: the
      // split/dock preview was suppressed during the drag (see CenterPanel's
      // pointer-move handler), so the only sensible commit is a fresh window.
      const outside = fileDropGoesToNewWindow({
        shiftKey,
        lastClient,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
      // No desktop geometry (native Wayland): `phys` is null, so the popout
      // hit-test above could not run — but a popout may well be under the
      // cursor. Ask this scope's windows to claim the release
      // (`lib/window/dropClaim`), exactly as a tab dragged out of the bar does;
      // the popout that receives the pointer answers with the pane under it.
      if (outside && !shiftKey && !phys && !(await desktopCoordinatesSupported())) {
        const scope = useTabsStore.getState().scope;
        const claim = await probeDropTarget({
          token: newDropToken(getCurrentWindow().label),
          scope,
          sourceLabel: getCurrentWindow().label,
          tabKey: "",
          label: d.label,
          releasedAt,
        });
        if (claim?.groupId) {
          commitFileDrop(d, projectId, projectDir, null, {
            scope,
            groupId: claim.groupId,
            target: claim.target ?? undefined,
          });
          useDragStore.getState().end();
          return;
        }
      }
      const detachBounds =
        outside && phys
          ? {
              x: Math.round(phys.x - 80),
              y: Math.round(phys.y - 8),
              w: 900,
              h: 640,
            }
          : null;
      commitFileDrop(d, projectId, projectDir, detachBounds);
      useDragStore.getState().end();
    };

    // Escape / blur / a genuine pointercancel (Win/mac) aborts: tear down and drop
    // any in-flight drag without committing.
    const onAbort = () => {
      cleanup();
      if (dragging) useDragStore.getState().end();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    const unbindRelease = bindDragRelease({
      onCommit: (shiftKey) => void commitRelease(shiftKey),
      onAbort,
    });
    // Once the OS drag owns the pointer, the webview never sees the release, so
    // the backend reports the drop (or the user's abort) that ends the whole
    // gesture. NOT fired by the cancel we ourselves issue on re-entry — that
    // hands control back to the in-app drag, which is still very much alive.
    void listen(NAMES.fileDragEndedEvent, () => {
      unbindRelease();
      onAbort();
    }).then((un) => {
      // `listen` is async: the gesture can already be over when it resolves.
      if (gestureOver) un();
      else unlistenEnded = un;
    });
  }

  function relForEntry(entry: FileEntry): string {
    return relPath ? `${relPath}/${entry.name}` : entry.name;
  }

  // Set the current drag-to-move drop target (null = none). Keeps the ref (read
  // by the release handler) and the highlight in sync; the setter is a no-op
  // when unchanged so dragging over the same folder doesn't churn renders.
  // A same-tree target highlights through this tree's own render state; a
  // cross-tree target's element (`crossEl`) belongs to another tree whose state
  // this drag can't reach, so its `move-drop-target` class is applied
  // imperatively — re-applied every pointermove, which also survives that
  // tree re-rendering mid-drag and recomputing its className without it.
  function setMoveTarget(target: ResolvedMoveTarget | null, crossEl: HTMLElement | null = null) {
    moveTargetRef.current = target;
    if (moveTargetElRef.current && moveTargetElRef.current !== crossEl) {
      moveTargetElRef.current.classList.remove("move-drop-target");
    }
    moveTargetElRef.current = crossEl;
    crossEl?.classList.add("move-drop-target");
    const ownRel = target && !crossEl ? target.rel : null;
    setMoveTargetRel((prev) => (prev === ownRel ? prev : ownRel));
  }

  // Identity stamped on every `data-move-rel` drop target, so a drag that
  // started in a DIFFERENT tree (box member roots, another project's Files tab)
  // knows which root — and which side, local or remote — a drop here lands in.
  // Every `data-move-rel` site must spread this; `FileMove.test.ts` enforces it.
  const moveTargetAttrs = {
    "data-move-root": projectDir,
    "data-move-remote": remoteListing ? "1" : undefined,
  };

  // Relocate a dragged file into a folder shown in a tree (drag-to-move). The
  // target may belong to THIS tree or — cross-root — to another project's tree
  // (`resolveMoveTarget` already vetted it: local↔local only). `move_path`
  // confines each side to its own passed root, so the destination root goes
  // through verbatim. A name collision in the destination aborts with an error
  // rather than silently clobbering — moving is meant to be safe.
  async function moveEntryToFolder(
    sourceRel: string,
    name: string,
    target: ResolvedMoveTarget,
    sourceAbs: string,
  ) {
    const destRel = moveDestRel(target.rel, name);
    setLoading(true);
    setError(null);
    try {
      const exists = await invoke<boolean>("project_path_exists", {
        projectDir: target.root,
        relPath: destRel,
      }).catch(() => false);
      if (exists) {
        setError(
          t("fileTree.alreadyExistsIn", {
            name,
            folder: target.rel || t("fileTree.projectRootFolder"),
          }),
        );
        setLoading(false);
        return;
      }
      await invoke("move_path", {
        srcProjectDir: projectDir,
        srcRel: sourceRel,
        destProjectDir: target.root,
        destRel,
      });
      // Retarget any open viewer tab of the moved file/folder (main + detached).
      const newAbs = movedEntryAbs({
        sourceAbs,
        sourceRel,
        destRel,
        destRoot: target.root,
        crossRoot: target.crossRoot,
      });
      retargetTabsForRenamedPath(sourceAbs, newAbs);
      // This tree re-lists (the entry left it); a cross-root destination tree
      // catches up through its own fs-watch.
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function showEntryContextMenu(e: React.MouseEvent<HTMLDivElement>, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    cancelTooltipTimer();
    setTooltip(null);
    // Right-clicking a row that ISN'T part of the current selection resets the
    // selection to just it (standard file-manager behavior); right-clicking one
    // that IS keeps the whole multi-selection so the menu can act on all of it.
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      anchorRef.current = entry.path;
    }
    const row = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      entry,
      rowRect: { left: row.left, top: row.top, width: row.width, height: row.height },
    });
    probeClipboardImage();
  }

  /** "Download to…" (`docs/vm_projects_plan.md` Phase 2): SFTP-copy a remote
   *  file/folder to a locally picked destination, size-confirmed. Built for
   *  the mirrorless VM posture — the existing tree-transfer buttons all assume
   *  a mirror destination, so without this a mirrorless project has no casual
   *  per-file exit — but offered on every remote listing (a worker's outputs
   *  want the same door). Every crossing is user-clicked: pick a folder,
   *  read the numbers, confirm. */
  async function downloadEntryTo(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId) return;
    try {
      const rel = relForEntry(entry);
      const size = await invoke<{ files: number; bytes: number }>("remote_download_size", {
        projectId,
        relPath: rel,
      });
      const dest = await openDialog({ directory: true, multiple: false });
      if (typeof dest !== "string") return;
      const ok = await dialogConfirm(
        t("fileTree.downloadToConfirm", {
          name: entry.name,
          files: size.files,
          size: fmtSize(size.bytes),
          dest,
        }),
        { title: t("fileTree.downloadToTitle") },
      );
      if (!ok) return;
      setLoading(true);
      await invoke("remote_download_to", { projectId, relPath: rel, destDir: dest });
      setLoading(false);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function stageEntry(entry: FileEntry) {
    setContextMenu(null);
    setLoading(true);
    setError(null);
    try {
      await invoke("git_add_path", { projectDir, relPath: relForEntry(entry) });
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  /** Open the in-app diff viewer for a file. The DiffView viewer resolves the
   *  absolute source path and asks the backend (`git_diff_file`) for the diff,
   *  so we just hand it the path. Re-opening drops any prior diff tab for the
   *  same path (mirrors openPdfTab) so the diff refreshes. */
  function showDiff(entry: FileEntry) {
    setContextMenu(null);
    const tab = {
      label: entry.name,
      cmd: "",
      cwd: projectDir,
      kind: "embed" as const,
      embedPath: entry.path,
      viewer: "diff" as const,
    };
    const sameDiff = (t: TabEntry) =>
      t.kind === "embed" && t.viewer === "diff" && t.embedPath === entry.path;
    if (tabScope) {
      openTabInScope(tabScope, tab, sameDiff, { replace: true });
      return;
    }
    const store = useTabsStore.getState();
    const prior = store.tabs.find(sameDiff);
    if (prior) store.removeTab(prior.key);
    store.addTab(tab);
  }

  /** SSH-sync: open a diverged (amber) file in the three-way merge viewer — the
   *  same PyCharm-style resolve view the orange list opens (local mirror ⇄ merged
   *  ⇄ remote host, per-block take-left/right) — instead of the old
   *  take-local/take-host popup. On open the viewer runs a byte-for-byte test and
   *  self-resolves a metadata-only divergence (identical bytes).
   *
   *  `SyncMergeView` keys off the mirror-side absolute path (`mirrorRoot/rel`), so
   *  build that here from `relForEntry` regardless of which side the tree is
   *  currently listing (the host path is not under the mirror). */
  function openSyncMerge(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId || !mirrorRoot) return;
    const rel = relForEntry(entry);
    const abs = `${mirrorRoot.replace(/[/\\]+$/, "")}/${rel}`;
    const tab = {
      label: basename(abs) || entry.name,
      cmd: "",
      cwd: dirname(abs),
      kind: "embed" as const,
      embedPath: abs,
      viewer: "syncmerge" as const,
    };
    // In a detached popout, stream the tab into that window (its store is
    // authoritative); otherwise reuse an already-open merge tab for this exact
    // file, else add a fresh one to the focused subwindow.
    if (fileDrop) {
      fileDrop.openTab(tab);
      return;
    }
    const sameMerge = (t: TabEntry) =>
      t.kind === "embed" && t.viewer === "syncmerge" && t.embedPath === abs;
    if (tabScope) {
      openTabInScope(tabScope, tab, sameMerge);
      return;
    }
    const store = useTabsStore.getState();
    const prior = store.tabs.find(sameMerge);
    if (prior) store.setActive(prior.key);
    else store.setActive(store.addTab(tab).key);
  }

  // SSH-sync Phase 1: pull this file/folder into the local mirror (and mark it
  // selected), or stop tracking it. Remote source view only.
  //
  // A pull writes the host's bytes over the mirror's — for a folder row, over the
  // whole subtree — so it asks first (`stores/remote/syncConfirm`), naming what would be
  // replaced and what would be lost. The button used to do it on one click, which
  // is what made an ordinary misclick destructive.
  /**
   * Pull one project-relative path (a file, a folder, or "" for the whole
   * project) from the host into the mirror, with the confirm in front of it.
   *
   * Rel-based rather than entry-based because the same transfer is started from
   * three places and only one of them has a `FileEntry`: a tree row, the row's
   * context menu, and the tree head's folder-level slot — which acts on the
   * folder currently being *browsed*, including the root, which has no row to
   * carry an entry.
   */
  async function syncRelToLocal(rel: string, label: string, isDir: boolean) {
    setContextMenu(null);
    if (!projectId) return;
    const ok = await confirmSyncTransfer({
      projectId,
      direction: "pull",
      relPath: rel,
      isDir,
      label,
    });
    if (!ok) return;
    setSyncNotice(null);
    try {
      const outcome = await syncPull(projectId, rel);
      // The confirmation is that it landed at all. Silence used to be the
      // *only* successful outcome, which reads exactly like a button that does
      // nothing. Files over the cap it left on the host are named with it.
      setSyncNotice({
        text: t("fileTree.pullDoneNotice", { name: label }),
        bad: false,
        skipped: outcome.skippedTooLarge,
      });
    } catch (err) {
      setError(String(err));
    }
  }

  async function syncEntryToLocal(entry: FileEntry) {
    await syncRelToLocal(relForEntry(entry), entry.name, entry.is_dir);
  }

  async function stopSyncingEntry(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId) return;
    try {
      await syncMarkSelected(projectId, [relForEntry(entry)], false, entry.is_dir);
    } catch (err) {
      setError(String(err));
    }
  }

  // Auto-sync: toggle background bidirectional sync for a file or (recursively) a
  // folder. Turning it on implies tracking; the backend engine reconciles it on
  // its next pass, skipping anything diverged (orange).
  //
  // Turning it ON over a FOLDER is the one click in the app that can start hauling
  // a host tree down in bulk, and byte-sync does not read `.gitignore` — so a
  // deliberately host-side directory (experiment output, checkpoints) is not
  // protected by being gitignored the way it is from lockstep. Price it first and
  // make the user confirm when the answer is big; small folders just proceed.
  // Exclude a folder from byte-sync outright — the durable form of "leave this
  // on the host / leave this on my machine". Unlike auto-off it is honoured by
  // the whole-project pull and push too; it is the same marker the large-folder
  // setup prompt (`BigFolderExcludeDialog`) writes, so a folder answered for
  // there reads back correctly here (and can be undone here).
  async function toggleSyncExcluded(entry: FileEntry, excluded: boolean) {
    setContextMenu(null);
    if (!projectId) return;
    try {
      await syncSetExcluded(projectId, [relForEntry(entry)], excluded);
    } catch (err) {
      setError(String(err));
    }
  }

  async function toggleAutoSyncEntry(entry: FileEntry, on: boolean) {
    setContextMenu(null);
    if (!projectId) return;
    if (on && entry.is_dir && isRemote) {
      try {
        const preview = await syncAutoPreview(projectId, relForEntry(entry));
        if (preview.files > AUTO_SYNC_WARN_FILES || preview.bytes > AUTO_SYNC_WARN_BYTES) {
          setAutoConfirm({ entry, ...preview });
          return;
        }
      } catch {
        // Preview is advisory (a cold pool, an unreadable dir). Failing to price
        // the pull must not block the toggle the user explicitly asked for.
      }
    }
    await applyAutoSync(entry, on);
  }

  // The write half of the toggle, shared by the direct path and the confirm modal.
  async function applyAutoSync(entry: FileEntry, on: boolean) {
    if (!projectId) return;
    setAutoConfirm(null);
    try {
      await syncSetAuto(projectId, [relForEntry(entry)], on, entry.is_dir);
    } catch (err) {
      setError(String(err));
    }
  }

  // SSH-sync Phase 2: push a local mirror file/folder up to the host. A push that
  // a host change would clobber is blocked and queued for per-file resolution —
  // but a push that lands on an unchanged host file simply replaces it, which for
  // a folder row is a whole subtree of the host's content going under the mirror's.
  // So, like the pull, it asks first and names what it would replace.
  async function pushRelToHost(rel: string, label: string, isDir: boolean) {
    setContextMenu(null);
    if (!projectId) return;
    const ok = await confirmSyncTransfer({
      projectId,
      direction: "push",
      relPath: rel,
      isDir,
      label,
    });
    if (!ok) return;
    setSyncNotice(null);
    try {
      const r = await syncPush(projectId, rel, false);
      if (r.conflicts.length > 0) setPushConflicts(r.conflicts);
      else if (r.failed_total > 0)
        setError(r.first_error ?? t("fileTree.pushFailedCount", { count: r.failed_total }));
      else if (r.pushed === 0) setError(t("fileTree.pushedNothing"));
      // The success case, which used to be the ONLY outcome with no feedback at
      // all: a push that worked and a push that never ran looked identical, and
      // the row's button going away is not something the eye catches on a tree
      // of two hundred. Conflicts are named separately — those files are still
      // orange, and calling that a successful push would be wrong.
      else
        setSyncNotice({
          text: t("fileTree.pushDoneNotice", { count: r.pushed, name: label }),
          bad: false,
        });
    } catch (err) {
      setError(String(err));
    }
  }

  async function pushEntryToHost(entry: FileEntry) {
    await pushRelToHost(relForEntry(entry), entry.name, entry.is_dir);
  }

  // Push the whole local mirror up to the host (root context menu, local source).
  async function pushAllToHost() {
    await pushRelToHost("", basename(projectDir) || t("fileTree.projectRootFolder"), true);
  }

  // Drop the whole remaining conflict queue in one click. A push over a folder or
  // a whole project can come back with hundreds of both-sides-changed files, and
  // answering "keep local or take host?" once per file is not a decision anyone
  // can make at that size — the honest answer is "not now". It is the safe
  // direction and it loses nothing: skipping touches neither side, so every file
  // left here stays diverged and stays listed in the file view's orange
  // (diverged) list, where they can be worked through one at a time with the
  // merge viewer.
  function skipAllPushConflicts() {
    if (pushBusy) return;
    setPushConflicts([]);
    void load(relPath);
  }

  // Resolve the first queued push conflict: keep-local force-pushes, take-host
  // pulls the host copy back, skip drops it. Each advances the queue.
  async function resolvePushConflict(action: "keep" | "host" | "skip") {
    const rel = pushConflicts[0];
    if (!rel || !projectId) return;
    setPushBusy(true);
    try {
      if (action === "keep") await syncPush(projectId, rel, true);
      else if (action === "host") {
        // A host copy that grew past the cap is not pulled; say so rather
        // than let the queue move on as if it had been. Added to a skipped
        // line the queue already shows, so an earlier one is not lost.
        const outcome = await syncPull(projectId, rel);
        if (outcome.skippedTooLarge.length > 0) {
          setSyncNotice((prev) => ({
            text: "",
            bad: false,
            skipped: [...(prev && !prev.text ? (prev.skipped ?? []) : []), ...outcome.skippedTooLarge],
          }));
        }
      }
      // "skip" leaves both sides as-is.
    } catch (err) {
      setError(String(err));
    } finally {
      setPushBusy(false);
      setPushConflicts((q) => q.slice(1));
      await load(relPath);
    }
  }

  async function updateGitignore(entry: FileEntry, action: "ignore" | "unignore") {
    setContextMenu(null);
    setLoading(true);
    setError(null);
    try {
      await invoke("update_gitignore_rule", {
        projectDir,
        relPath: relForEntry(entry),
        isDir: entry.is_dir,
        action,
      });
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function promptDelete(targets: FileEntry[]) {
    setContextMenu(null);
    if (targets.length > 0) setDeleteConfirm({ entries: targets });
  }

  function renameEntry(entry: FileEntry) {
    setContextMenu(null);
    setRenamePrompt({ entry });
  }

  /** The dialog's action. Throws on failure so the dialog keeps the typed name
   *  and shows the reason; the tab retarget and the reload only run on success. */
  async function confirmRename(entry: FileEntry, nextName: string) {
    setLoading(true);
    setError(null);
    await invoke("rename_path", {
      projectDir,
      oldRel: relForEntry(entry),
      newName: nextName,
    }).catch((err) => {
      setLoading(false);
      throw err;
    });
    // Retarget any open viewer tab of this file (main + detached) to the new
    // path. Derive the new absolute path by swapping the basename on the entry's
    // own absolute path (== embedPath), so it holds for local and remote alike.
    const oldAbs = entry.path;
    const newAbs = `${oldAbs.slice(0, oldAbs.lastIndexOf("/") + 1)}${nextName}`;
    retargetTabsForRenamedPath(oldAbs, newAbs);
    setRenamePrompt(null);
    await load(relPath);
  }

  /**
   * Create an empty `.eldeck.json` and open it in the deck editor.
   *
   * The **only** way to start a presentation used to be the "Present" button
   * inside an already-open PDF viewer, which meant a deck could not exist
   * without a PDF already existing. "New File" produced an empty file, and
   * `parseDeck("")` rejected that hard — so the from-blank path the design
   * documents (write a starter Beamer `.tex`, compile it, place layers on it)
   * was unreachable in practice (TODO V #107). The sidecar is written with real
   * contents rather than left empty so the file is a valid deck on disk from the
   * first moment, not only once the editor has been opened on it.
   */
  async function createDeck() {
    setContextMenu(null);
    // The write runs from inside the dialog, so a refused name (a collision, a
    // bad character) keeps the typed one on screen instead of discarding it.
    await promptText(
      {
        title: t("fileTree.newPresentation"),
        body: newEntryBody(),
        label: t("fileTree.newPresentationPrompt"),
        initial: "talk",
        confirmLabel: t("common.create"),
      },
      async (trimmed) => {
        setLoading(true);
        setError(null);
        try {
          const { fileName, abs } = await createDeckFile({
            projectDir,
            projectId,
            relDir: relPath,
            name: trimmed,
          });
          await load(relPath);
          openEntry(
            {
              name: fileName,
              path: abs,
              is_dir: false,
              size: 0,
              extension: "json",
              mime: "application/json",
            },
            false,
          );
        } catch (err) {
          setLoading(false);
          throw err;
        }
      },
    );
  }

  /** "Creating in <folder>" — the same orientation the rename dialog gives, and
   *  the answer to the question a bare name field cannot: *where*. The tree's
   *  browsed folder, not the clicked entry's. */
  function newEntryBody() {
    const folder = relPath
      ? relPath.slice(relPath.lastIndexOf("/") + 1)
      : t("fileTree.projectRootFolder");
    return (
      <>
        {t("fileTree.newEntryIn")} <strong>{folder}</strong>
      </>
    );
  }

  async function createEntry(kind: "file" | "dir") {
    setContextMenu(null);
    await promptText(
      {
        title: t(kind === "file" ? "fileBrowser.newFile" : "fileBrowser.newFolder"),
        body: newEntryBody(),
        label: t(
          kind === "file" ? "fileTree.newFileNamePrompt" : "fileTree.newFolderNamePrompt",
        ),
        confirmLabel: t("common.create"),
      },
      async (trimmed) => {
        const rel = relPath ? `${relPath}/${trimmed}` : trimmed;
        setLoading(true);
        setError(null);
        try {
          await invoke(kind === "file" ? "create_file" : "create_dir", {
            projectDir,
            relPath: rel,
          });
          await load(relPath);
        } catch (err) {
          setLoading(false);
          throw err;
        }
      },
    );
  }

  function copyEntries(targets: FileEntry[], op: "copy" | "cut") {
    setContextMenu(null);
    if (targets.length === 0) return;
    setClipboardEntries(
      targets.map((entry) => ({
        projectDir,
        relPath: relForEntry(entry),
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
        op,
      })),
    );
  }

  /** Suggest a name not already present in the current folder, appending
   *  " copy"/" copy N" (before the extension) until it is free. `extraTaken`
   *  adds names already claimed earlier in a bulk paste (which hasn't re-listed
   *  yet) so two pasted items can't collide with each other. */
  function suggestPasteName(name: string, extraTaken?: ReadonlySet<string>): string {
    const taken = new Set(rawEntries.map((e) => e.name));
    if (extraTaken) for (const n of extraTaken) taken.add(n);
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; ; i++) {
      const candidate = `${stem} copy${i > 1 ? ` ${i}` : ""}${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  function openPastePrompt() {
    setContextMenu(null);
    if (!clipboard) return;
    setPastePrompt({ kind: "file", name: suggestPasteName(clipboard.name), error: null });
  }

  function openScreenshotPrompt() {
    setContextMenu(null);
    setPastePrompt({ kind: "image", name: suggestPasteName("screenshot.png"), error: null });
  }

  // The context-menu Paste entry. A single clipboard item keeps its rename
  // prompt (openPastePrompt); a multi-item clipboard pastes in bulk (pasteAll).
  function renderPasteButton() {
    if (clipboardEntries.length === 0) return null;
    const multi = clipboardEntries.length > 1;
    const move = clipboard?.op === "cut" ? t("fileTree.pasteMoveSuffix") : "";
    return (
      <button onClick={() => (multi ? void pasteAll() : openPastePrompt())}>
        {multi
          ? t("fileTree.pasteItemsCount", { count: clipboardEntries.length, move })
          : t("fileTree.pasteNamed", { name: clipboard?.name ?? "", move })}
      </button>
    );
  }

  // Paste a multi-item clipboard into the current folder in one go — no per-file
  // rename prompt; each collision is auto-resolved with " copy". The single-item
  // paste keeps its rename prompt (openPastePrompt / confirmPaste).
  async function pasteAll() {
    setContextMenu(null);
    if (clipboardEntries.length === 0) return;
    setLoading(true);
    setError(null);
    const claimed = new Set<string>();
    try {
      for (const cb of clipboardEntries) {
        const newName = suggestPasteName(cb.name, claimed);
        claimed.add(newName);
        const destRel = relPath ? `${relPath}/${newName}` : newName;
        await invoke(cb.op === "cut" ? "move_path" : "copy_path", {
          srcProjectDir: cb.projectDir,
          srcRel: cb.relPath,
          destProjectDir: projectDir,
          destRel,
        });
        // Same-project cut relocates within this tree → retarget any open viewer
        // tab of the moved file (mirrors confirmPaste's single-item handling).
        if (cb.op === "cut" && cb.projectDir === projectDir) {
          const oldAbs = cb.path;
          const newAbs = `${oldAbs.slice(0, oldAbs.length - cb.relPath.length)}${destRel}`;
          retargetTabsForRenamedPath(oldAbs, newAbs);
        }
      }
      if (clipboardEntries.some((c) => c.op === "cut")) clearClipboard();
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function confirmPaste() {
    if (!pastePrompt) return;
    const newName = pastePrompt.name.trim();
    if (!newName || newName.includes("/") || newName.includes("\\") || newName === "." || newName === "..") {
      setPastePrompt({ ...pastePrompt, error: t("fileTree.invalidFileName") });
      return;
    }
    const destRel = relPath ? `${relPath}/${newName}` : newName;
    setPasteBusy(true);
    try {
      if (pastePrompt.kind === "image") {
        await invoke("save_clipboard_image", { projectDir, relPath: destRel });
      } else {
        if (!clipboard) return;
        await invoke(clipboard.op === "cut" ? "move_path" : "copy_path", {
          srcProjectDir: clipboard.projectDir,
          srcRel: clipboard.relPath,
          destProjectDir: projectDir,
          destRel,
        });
        if (clipboard.op === "cut") {
          // A same-project cut relocates within this scope's tree, so retarget any
          // open viewer tab of the moved file (main + detached). A cross-project
          // cut lands in a different scope than the source tab, which this
          // current-scope helper doesn't own, so leave it (reopen to refresh).
          if (clipboard.projectDir === projectDir) {
            const oldAbs = clipboard.path;
            const newAbs = `${oldAbs.slice(0, oldAbs.length - clipboard.relPath.length)}${destRel}`;
            retargetTabsForRenamedPath(oldAbs, newAbs);
          }
          clearClipboard();
        }
      }
      setPastePrompt(null);
      await load(relPath);
    } catch (err) {
      setPastePrompt({ ...pastePrompt, error: String(err) });
    } finally {
      setPasteBusy(false);
    }
  }

  function showRootContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    cancelTooltipTimer();
    setTooltip(null);
    setContextMenu({ x: e.clientX, y: e.clientY, entry: null, rowRect: null });
    probeClipboardImage();
  }

  // Ask the backend whether a screenshot/image is on the system clipboard so the
  // open context menu can reveal "Paste screenshot". Async, so the menu shows
  // immediately and the option appears once the probe resolves.
  function probeClipboardImage() {
    invoke<boolean>("clipboard_has_image")
      .then(setClipboardImage)
      .catch(() => setClipboardImage(false));
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;
    const targets = deleteConfirm.entries;
    setDeleteConfirm(null);
    setLoading(true);
    setError(null);
    try {
      for (const entry of targets) {
        await invoke(entry.is_dir ? "delete_dir" : "delete_file", {
          projectDir,
          relPath: relForEntry(entry),
        });
        // Close any open viewer tab for the deleted file/folder (main + detached).
        closeTabsForDeletedPath(entry.path);
      }
      clearSelection();
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function runShellScript(event: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    launchShell(entry, runArgsByPath[entry.path]);
  }

  /** Run a shell script with `args` appended to its command line — detached when
   *  "run in background" is on (the backend's shell parses them), else in a
   *  foreground terminal tab (the tab's shell does). */
  function launchShell(entry: FileEntry, args?: string) {
    const remoteForegroundOnly = remoteListing;
    if (runInBackground && !remoteForegroundOnly) {
      // Detached spawn: no tab, no captured output. The activity store tracks
      // the run (and the app-lifetime `script-finished` listener clears it) so
      // the spinner survives side-panel hide/show — see TODO group R #34.
      runScript(entry.path, projectDir, projectId, args);
      return;
    }
    const interp = shellRunnerFor(entry.extension, PLATFORM) as ScriptShell | null;
    if (!interp) return; // not a shell type we know how to run
    const plan = shellScriptRunPlan({
      project,
      treeRoot: projectDir,
      syncSource,
      scriptPath: entry.path,
      interp,
      // The machine chosen in the RunHostPicker. It only picks WHICH remote
      // machine a host-side script runs on — a script browsed on the local mirror
      // runs in a local shell regardless (same rule as the Python Run beside it).
      runHostPref: projectId
        ? useRunHostPrefStore.getState().byProject[projectId]
        : undefined,
      args,
    });
    if (!plan) {
      setError(t("fileTree.runFailedOutsideTree", { path: entry.path }));
      return;
    }
    const tab = {
      label: entry.name,
      cmd: interp,
      cwd: plan.cwd,
      kind: "shell" as const,
      initialInput: plan.initialInput,
      runFile: entry.path,
      location: plan.location,
    };
    // Same placement policy as the Python Run: stream into a detached popout when
    // we're in one, else the focused subwindow of this project. Preceded by the
    // same login-node gate the Python Run has: if `plan.location` resolves to a
    // machine tagged HPC, running a script there is asked about first
    // (`lib/remote/hpc/hpcGuard.ts`) — a script is the likeliest thing on this menu to be
    // actual compute.
    void guardLoginNodeRun({
      projectId,
      location: plan.location,
      kind: "login-node-run",
    }).then((ok) => {
      if (!ok) return;
      if (fileDrop) fileDrop.openTab(tab);
      else useTabsStore.getState().addTabToScope(tabScope ?? projectId ?? "root", tab);
    });
  }

  /** Run a Python file: open a terminal tab in the project's scope running the
   *  project's interpreter on it. Same mechanism as the viewer's Run button
   *  (`lib/terminal/pythonRun`), so it inherits remote-host/container locality and picks
   *  up the project's pinned/auto-detected interpreter. */
  function runPythonScript(event: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    launchPython(entry, runArgsByPath[entry.path]);
  }

  /** The ▶ popover's Run: a `.py` row runs through Python, anything else it is
   *  offered on is a shell script. */
  function launchWithArgs(entry: FileEntry, args: string) {
    if (isPythonPath(entry.path)) launchPython(entry, args);
    else launchShell(entry, args);
  }

  /** Open a run terminal for `entry`, appending `args` to the command line (see
   *  `lib/terminal/pythonRun`). Same placement as the viewer's Run; failures surface into
   *  the tree's error banner. */
  function launchPython(entry: FileEntry, args?: string) {
    runPythonFile({
      file: entry.path,
      // Which machine, cwd and path — the same resolution the shell-script Run
      // above uses, so the ▶ on a `.py` row and the ▶ on a `.sh` row beside it
      // cannot land on different machines. Browsing the Local mirror with no
      // run-host chosen runs LOCALLY; `projectDir` is already the mirror root on
      // that side, so it doubles as the local root here.
      plan: pythonRunPlan({
        projectDir: project ? resolveProjectDirectory(project) : projectDir,
        remotePath: project?.remote?.remote_path,
        localRoot: mirrorRoot ?? projectDir,
        file: entry.path,
        runHostPref: projectId
          ? useRunHostPrefStore.getState().byProject[projectId]
          : undefined,
      }),
      scope: projectId ?? "root",
      projectId,
      args,
      // In a detached popout `fileDrop` is set → the tab streams into that window;
      // in the main window it lands in the project's focused subwindow.
      place: placeForFocused(fileDrop),
    }).catch((err) => setError(t("fileTree.runFailed", { error: String(err) })));
  }

  /** Open (or refresh) the in-app PDF viewer tab for a freshly compiled PDF.
   *  The viewer reads the bytes once on mount, so on a recompile we drop any
   *  existing tab for this path and add a fresh one to pick up the new output. */
  function openPdfTab(pdfPath: string) {
    const tab = {
      label: basename(pdfPath) || pdfPath,
      cmd: "",
      cwd: projectDir,
      kind: "embed" as const,
      embedPath: pdfPath,
      viewer: "pdf" as const,
    };
    const samePdf = (t: TabEntry) =>
      t.kind === "embed" && t.viewer === "pdf" && t.embedPath === pdfPath;
    if (tabScope) {
      openTabInScope(tabScope, tab, samePdf, { replace: true });
      return;
    }
    const store = useTabsStore.getState();
    const prior = store.tabs.find(samePdf);
    if (prior) store.removeTab(prior.key);
    store.addTab(tab);
  }

  /** Compile a .tex file to PDF, then refresh the tree (the PDF appears) and
   *  optionally open it in the in-app viewer. Build feedback is the inline
   *  spinner on the row; failures surface in the tree error banner. */
  async function compileTex(entry: FileEntry, openPdf: boolean) {
    setContextMenu(null);
    if (compiling.has(entry.path)) return;
    setCompiling((s) => new Set(s).add(entry.path));
    setError(null);
    try {
      const res = await invokeTrusted<TexCompileResult>("compile_tex", {
        path: entry.path,
        engine: null,
      });
      if (!res.success) {
        // latexmk's own summary, when it gave one, says more than the log's last
        // line (its "use the -f option" advisory).
        const detail = res.driver_note || lastLogLine(res.log);
        setError(
          t("fileTree.compileFailed", { name: entry.name, detail: detail ? `: ${detail}` : "" }),
        );
        return;
      }
      await load(relPath);
      if (openPdf && res.pdf_path) openPdfTab(res.pdf_path);
    } catch (err) {
      setError(String(err));
    } finally {
      setCompiling((s) => {
        const next = new Set(s);
        next.delete(entry.path);
        return next;
      });
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (!projectDir) return;
    const files = Array.from(e.dataTransfer.files).filter((f) => f.size > 0 || f.type !== "");
    if (!files.length) return;
    setLoading(true);
    setError(null);
    try {
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const rel = relPath ? `${relPath}/${file.name}` : file.name;
        await invoke("write_project_file_bytes", {
          projectDir,
          relPath: rel,
          content: Array.from(new Uint8Array(buf)),
        });
      }
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  if (!projectDir) {
    return (
      <div className="file-tree-empty">{t("common.noProjectSelected")}</div>
    );
  }

  // Disconnected remote project: the tree can't be listed without freezing the
  // app (sync remote commands on the main thread). Show a note and let the user
  // reconnect from the header lamp; the tree re-lists once the pool is up.
  if (remoteBlocked) {
    return (
      <div className="file-tree-empty">
        {remoteSshState === "connecting"
          ? t("fileTree.connectingToHost")
          : t("fileTree.disconnectedReconnect")}
      </div>
    );
  }

  // Whether the search results replace the browsed listing. The search box is
  // only offered on a local-source tree (its backends walk the local path).
  const canSearch = !remoteListing;
  const searching = canSearch && searchOpen && search.trim().length > 0;
  // Folder the search is confined to: the browsed folder by default, the whole
  // project when "root" is chosen (or when already at the root).
  const searchScope = searchRoot ? "" : relPath;
  const scopeLabel = relPath ? basename(relPath) || relPath : "";

  /**
   * The sync control for the folder currently being BROWSED — the tree head's
   * counterpart to the per-row slot, and the only one the project root can have:
   * the root is not a row in anybody's listing, so at the top level (where a
   * file view opens) the whole green/orange pull/push vocabulary was simply
   * absent, and the one transfer people actually want there — "send this folder
   * up" — was reachable only from a context menu or the pane's text button.
   *
   * The state is read from the roll-up FIRST, unlike a row (which prefers its
   * own manifest entry). A directory's own entry is always reported green by the
   * backend — it is a marker, not a measurement — so honouring it here would
   * paint a folder full of diverged files as in sync. The roll-up is derived from
   * the files themselves and cannot say that.
   */
  function renderFolderSyncSlot() {
    const syncTracked = remoteListing || treatLocal;
    if (!syncTracked || !projectId) return null;
    const agg = dirSyncAgg[relPath];
    const state: SyncFileState = agg?.any
      ? agg.allGreen
        ? agg.anyNew
          ? "localnew"
          : "green"
        : "amber"
      : (syncStatus?.[relPath]?.state ?? "none");
    const label = relPath
      ? basename(relPath) || relPath
      : basename(projectDir) || t("fileTree.projectRootFolder");
    if (isPathExcluded(syncStatus, relPath)) {
      return (
        <span
          className="file-sync-excluded"
          title={t("fileTree.excludedFromByteSync")}
          aria-label={t("fileTree.excludedFromByteSync")}
        >
          ✕
        </span>
      );
    }
    // Diverged: the same non-interactive ± a folder row shows. Which side wins is
    // a per-file question, and answering it for a whole subtree in one click is
    // not something this button may offer.
    if (state === "amber") {
      return (
        <span
          className="file-sync-dir-diverged"
          title={t("fileTree.folderDiverged")}
          aria-label={t("fileTree.folderDiverged")}
        >
          ±
        </span>
      );
    }
    // Otherwise in sync, but holding NEW local-only files the host has never
    // seen: the actionable upload, always ⬆ push whichever tree is showing —
    // the new bytes are on the local side by definition.
    if (state === "localnew") {
      const busy = !!syncProgress;
      return (
        <button
          type="button"
          className="orange-file-act orange-file-act--icon orange-file-act--slot orange-file-act--local"
          title={t("fileTree.folderHasNewFiles")}
          aria-label={t("fileTree.folderHasNewFiles")}
          disabled={busy}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void pushRelToHost(relPath, label, true);
          }}
        >
          <ArrowUpIcon />
        </button>
      );
    }
    // In sync: still shown, quietly. An empty slot is the state the root had
    // before this existed, and it cannot be told from a control that failed to
    // render.
    if (state === "green") {
      return (
        <span
          className="file-sync-folder-green"
          title={t("fileTree.folderInSync", { name: label })}
          aria-label={t("fileTree.folderInSync", { name: label })}
        >
          ✓
        </span>
      );
    }
    const busy = !!syncProgress;
    return (
      <button
        type="button"
        className={`orange-file-act orange-file-act--icon orange-file-act--slot ${remoteListing ? "orange-file-act--remote" : "orange-file-act--local"}`}
        title={t(remoteListing ? "fileTree.syncFolderSlotTitle" : "fileTree.pushFolderSlotTitle", {
          name: label,
        })}
        aria-label={t(
          remoteListing ? "fileTree.syncFolderSlotTitle" : "fileTree.pushFolderSlotTitle",
          { name: label },
        )}
        disabled={busy}
        onClick={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void (remoteListing
            ? syncRelToLocal(relPath, label, true)
            : pushRelToHost(relPath, label, true));
        }}
      >
        {remoteListing ? <ArrowDownIcon /> : <ArrowUpIcon />}
      </button>
    );
  }

  const folderSyncSlot = renderFolderSyncSlot();

  return (
    <div
      ref={treeRootRef}
      className={`file-tree${isDragOver ? " drag-over" : ""}${moveTargetRel === relPath ? " move-drop-target" : ""}`}
      // The listing itself is a drop target for the folder it shows: after a
      // spring-load navigated the tree mid-drag, releasing over a file row or
      // empty space lands in the folder now on screen. Folder rows and crumbs
      // are nested targets and win the `closest()` lookup; the file's own
      // folder stays a no-op (`resolveMoveTarget`).
      data-move-rel={relPath}
      {...moveTargetAttrs}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleTreeKeyDown}
      onMouseDown={() => setContextMenu(null)}
      onContextMenu={showRootContextMenu}
    >
      {/* Sticky header: the remote/refresh bar, the in-tree search box and the
          breadcrumb path line stay pinned while the tree body scrolls (the sort
          row lives above the scroll container and is already fixed). They share
          ONE sticky wrapper so they stack instead of each pinning to top:0 and
          colliding — which is what hid the path line behind the search box.
          Shared by the side panel and the Files (Project) tab (both render
          FileTree), so both get the fixed path line. */}
      <div className="file-tree-head">
      {remoteListing && (
        <div className="file-tree-remote-bar" title={t("fileTree.remoteBarTitle")}>
          <span className="file-tree-remote-label">{t("fileSourceSwitch.remote")}</span>
          <div className="file-tree-bar-actions">
            {/* The browsed folder's own pull control — the root's included, which
                is the one this bar exists to give it. */}
            {folderSyncSlot}
            {syncProgress && (
              <span className="file-tree-sync-progress" title={t("fileTree.syncingRel", { rel: syncProgress.rel || "…" })}>
                ⟳ {syncProgress.done}/{syncProgress.total}
              </span>
            )}
            <button
              className="file-tree-up file-tree-refresh"
              onClick={refreshListing}
              disabled={loading}
              title={t("fileTree.refreshSftpTitle")}
              aria-label={t("common.refresh")}
            >
              ↻
            </button>
          </div>
        </div>
      )}
      {/* The local source needs a bar only while it has folder-sync state to
          report. Refresh itself belongs in the existing search row below, so it
          never creates an otherwise empty row. */}
      {!remoteListing && (folderSyncSlot || syncProgress) && (
        <div className="file-tree-local-bar">
          <div className="file-tree-bar-actions">
            {/* The browsed folder's own push control (see `renderFolderSyncSlot`).
                The local bar is where it matters most: a push starts from this
                side, and at the root there was no row to start it from. */}
            {folderSyncSlot}
            {/* Same counter, same class, same slot as the remote bar's. It belongs
                here MORE than there: a push is started from the Local side, so this
                is the bar that is on screen while the longest transfer in the app
                runs. Without it the local side showed nothing at all. */}
            {syncProgress && (
              <span className="file-tree-sync-progress" title={t("fileTree.syncingRel", { rel: syncProgress.rel || "…" })}>
                ⟳ {syncProgress.done}/{syncProgress.total}
              </span>
            )}
          </div>
        </div>
      )}
      {/* Closed under a host that owns the chrome, there is nothing left to
          draw — that is the row the move to the toolbar buys back. A bare tree
          still renders the row, because its own toggle lives in it. */}
      {canSearch && (searchOpen || !hostOwnsSearchChrome) && (
        <div className={`file-tree-search${searchOpen ? "" : " file-tree-search--collapsed"}`}>
          <div className="file-tree-search-row">
            {/* The one control that survives the fold. It sits where the input
                would start, so opening does not move the row's other buttons. */}
            {!hostOwnsSearchChrome && (
              <button
                type="button"
                className={`file-tree-up file-tree-search-toggle${searchOpen ? " active" : ""}`}
                aria-pressed={searchOpen}
                aria-expanded={searchOpen}
                onClick={() => setSearchOpen(!searchOpen)}
                title={searchOpen ? t("fileTree.hideSearch") : t("fileTree.showSearch")}
                aria-label={searchOpen ? t("fileTree.hideSearch") : t("fileTree.showSearch")}
              >
                <SearchIcon />
              </button>
            )}
            {searchOpen && (
              <>
                <input
                  type="text"
                  className="file-tree-search-input"
                  value={search}
                  autoFocus
                  placeholder={
                    searchMode === "name"
                      ? searchScope
                        ? t("fileTree.findFilesInScope", { scope: scopeLabel })
                        : t("fileTree.findFiles")
                      : searchScope
                        ? t("fileTree.searchInScope", { scope: scopeLabel })
                        : t("fileTree.searchInFiles")
                  }
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    // Keep the tree's Enter/Escape handler out of the input.
                    e.stopPropagation();
                    // Escape clears a query, and folds the box away once it is
                    // already empty — the same two-step every find bar uses.
                    if (e.key === "Escape") {
                      if (search) setSearch("");
                      else setSearchOpen(false);
                    }
                  }}
                />
                {search && (
                  <button
                    type="button"
                    className="file-tree-search-clear"
                    title={t("fileTree.clearSearch")}
                    aria-label={t("fileTree.clearSearch")}
                    onClick={() => setSearch("")}
                  >
                    ×
                  </button>
                )}
              </>
            )}
            {/* A local listing has an fs watcher, so it does not normally need a
                manual refresh. This is still the escape hatch for the Run-gate
                re-check when a same-second, same-size write leaves its persisted
                stamp untouched. Under a host that owns the chrome it is the ↻ in
                the toolbar (reaching this tree as `refreshNonce`), so the tree
                does not draw a second one. */}
            {!hostOwnsSearchChrome && (
              <button
                className="file-tree-up file-tree-refresh"
                onClick={refreshListing}
                disabled={loading}
                title={t("fileTree.refreshTitle")}
                aria-label={t("common.refresh")}
              >
                ↻
              </button>
            )}
          </div>
          {searchOpen && (
            <div className="file-tree-search-modes">
              <button
                type="button"
                className={`file-tree-search-mode${searchMode === "name" ? " active" : ""}`}
                aria-pressed={searchMode === "name"}
                onClick={() => setSearchMode("name")}
                title={t("fileTree.searchNamesTitle")}
              >
                {t("fileTree.searchName")}
              </button>
              <button
                type="button"
                className={`file-tree-search-mode${searchMode === "content" ? " active" : ""}`}
                aria-pressed={searchMode === "content"}
                onClick={() => setSearchMode("content")}
                title={t("fileTree.searchContentTitle")}
              >
                {t("fileTree.searchContent")}
              </button>
              {searchMode === "content" && (
                <button
                  type="button"
                  className={`file-tree-search-mode${searchCase ? " active" : ""}`}
                  aria-pressed={searchCase}
                  onClick={() => setSearchCase((v) => !v)}
                  title={t("search.caseSensitive")}
                >
                  Aa
                </button>
              )}
              {/* Scope: search under the browsed folder (default) or the whole
                  project. Only shown in a subfolder — at the root they're the same. */}
              {relPath && (
                <span className="file-tree-search-scope">
                  <button
                    type="button"
                    className={`file-tree-search-mode file-tree-search-scope-folder${!searchRoot ? " active" : ""}`}
                    aria-pressed={!searchRoot}
                    onClick={() => setSearchRoot(false)}
                    title={t("fileTree.searchUnderScope", { scope: relPath })}
                  >
                    {scopeLabel}
                  </button>
                  <button
                    type="button"
                    className={`file-tree-search-mode${searchRoot ? " active" : ""}`}
                    aria-pressed={searchRoot}
                    onClick={() => setSearchRoot(true)}
                    title={t("fileTree.searchWholeProject")}
                  >
                    {t("fileTree.searchRoot")}
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {/* Search backends walk the canonical local path, so a remote-source
          listing has no search box. Say why in its place — the Local/Remote
          switch is already visible in the source row — rather than leaving the
          affordance to silently vanish. */}
      {!canSearch && (
        <div className="file-tree-search-remote-hint">{t("fileTree.searchRemoteHint")}</div>
      )}
      {!searching && pathEdit !== null && (
        <div className="file-tree-breadcrumb file-tree-path-edit">
          <input
            ref={pathEditRef}
            className="file-tree-path-input"
            value={pathEdit}
            spellCheck={false}
            onChange={(e) => setPathEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPathEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setPathEdit(null);
              }
            }}
            onBlur={() => setPathEdit(null)}
          />
        </div>
      )}
      {!searching && pathEdit === null && (() => {
        // Parent of the current folder — the up button doubles as a drag-to-move
        // target ("move into the parent dir"). The breadcrumb crumbs cover the
        // other ancestors (and ⌂ the project root).
        //
        // Rendered at the ROOT too, where it holds only ⌂ and the folder total.
        // The root used to be served by the scaffold toggle's row instead, which
        // carried both of those as a side effect of being the one thing under
        // the tree; with the toggle moved into Project Settings the breadcrumb
        // is what keeps the total, the right-click path editor and the
        // drag-into-the-root target on screen there.
        const parentRel = relPath.split("/").filter(Boolean).slice(0, -1).join("/");
        return (
        <div
          className="file-tree-breadcrumb"
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            startPathEdit();
          }}
        >
          {relPath && (
            <button
              className={`file-tree-up${moveTargetRel === parentRel ? " move-drop-target" : ""}`}
              data-move-rel={parentRel}
              {...moveTargetAttrs}
              onClick={goUp}
              title={t("fileTree.goUp")}
            >
              ↑
            </button>
          )}
          <button
            className={`file-tree-crumb${!relPath ? " current" : ""}${moveTargetRel === "" ? " move-drop-target" : ""}`}
            data-move-rel=""
            {...moveTargetAttrs}
            onClick={() => load("")}
            title={t("fileTree.projectRootTitle")}
          >
            ⌂
          </button>
          {relPath.split("/").filter(Boolean).map((seg, i, arr) => {
            const target = arr.slice(0, i + 1).join("/");
            const isLast = i === arr.length - 1;
            // When a remote listing failed, `missingCrumbDepth` marks where the
            // path leaves the host tree: segments before it exist on the host
            // (on-host), segments from it on are local-only (missing). The cue is
            // shape first — strike-through + a ⊘ badge for missing — with a colour
            // tint only as reinforcement, so it reads without relying on colour.
            const missing = missingCrumbDepth !== null && i >= missingCrumbDepth;
            const onHost = missingCrumbDepth !== null && i < missingCrumbDepth;
            return (
              <React.Fragment key={target}>
                <span className="file-tree-crumb-sep">/</span>
                <button
                  className={`file-tree-crumb${isLast ? " current" : ""}${moveTargetRel === target ? " move-drop-target" : ""}${missing ? " crumb-missing" : ""}${onHost ? " crumb-on-host" : ""}`}
                  data-move-rel={target}
                  {...moveTargetAttrs}
                  onClick={() => { if (!isLast) load(target); }}
                  title={
                    missing
                      ? t("fileTree.crumbNotOnHost", { target })
                      : onHost
                        ? t("fileTree.crumbOnHost", { target })
                        : target
                  }
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
          {/* The row's right end: the folder total and — where the host offers
              one — the sort control. Grouped in one flex box because both want
              to sit right, and two independent `margin-left:auto` siblings
              would split the free space between them instead of stacking at
              the edge. */}
          <span className="file-tree-crumb-end">
            {renderGroupTotal(
              groupSizes.regular,
              groupSizes.regularPartial,
              sizeTitle(t, groupSizes.regular, groupSizes.regularIgnored, t("fileTree.totalSizeShown")),
            )}
            {onSortChange && (
              <span
                className="file-tree-sort"
                /* The crumbs are drag-to-move targets and the whole row opens
                   the path editor on right-click; neither belongs to the sort
                   control, so it keeps its clicks to itself. */
                onContextMenu={(e) => e.stopPropagation()}
              >
                <Dropdown
                  className="file-tree-sort-key"
                  value={sortKey}
                  onChange={(v) => onSortChange(v as SortKey, descending)}
                  title={t("projectFilesPane.sortByTitle", { key: t(SORT_KEY_LABEL[sortKey]) })}
                  options={(["name", "size", "type", "created", "modified"] as SortKey[]).map(
                    (key) => ({ value: key, label: t(SORT_KEY_LABEL[key]) }),
                  )}
                />
                <button
                  type="button"
                  className="file-tree-sort-dir"
                  onClick={() => onSortChange(sortKey, !descending)}
                  title={t(
                    descending
                      ? "projectFilesPane.sortDescendingTitle"
                      : "projectFilesPane.sortAscendingTitle",
                  )}
                >
                  {descending ? "↓" : "↑"}
                </button>
              </span>
            )}
          </span>
        </div>
        );
      })()}
      </div>
      {loading && <div className="file-tree-loading">{t("common.loading")}</div>}
      {error && <ErrorNote className="file-tree-error" error={error} />}
      {/* What the last transfer did — the success half, which nothing reported
          before. Same chrome as the whole-project row's result line. */}
      {syncNotice && (
        <div
          className={`project-files-sync-result${syncNotice.bad ? " project-files-sync-result--bad" : ""}`}
          role="status"
        >
          <span>
            {syncNotice.text}
            {syncNotice.skipped && <SyncSkippedLarge files={syncNotice.skipped} lead={!!syncNotice.text} />}
          </span>
          <button
            className="file-tree-up"
            onClick={() => setSyncNotice(null)}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </div>
      )}
      {searching && (
        <FileTreeSearch
          projectDir={projectDir}
          projectId={projectId}
          query={search}
          mode={searchMode}
          caseSensitive={searchCase}
          scopeRel={searchScope}
          onReveal={revealPath}
        />
      )}
      {!searching && (() => {
        // Sections (regular / collapsible scaffold / collapsible gitignored) are
        // computed once in the `sections` memo above and shared with the
        // selection click handler so a shift-range spans exactly these rows.
        // `sections` carries the FULL lists — the section headers count them, and
        // a header that counted only the rendered page would misreport the folder.
        // `rowWindow` carries the capped lists that are actually rendered.
        // Only the three collapsible sections read their full list here (their
        // headers count it); the regular section has no header, so it is read
        // from `rows` alone.
        const { standard, gitignored, hiddenExt } = sections;
        const rows = rowWindow;

        function renderEntry(e: FileEntry, isScaffold = false, isGitignored = false, isHiddenExt = false) {
          const status = isGitignored || isHiddenExt ? undefined : displayStatuses[e.name];
          const sizeClass = !e.is_dir ? sizeCategory(e.size) : "";
          // A folder's headline number is its non-ignored weight — the part
          // that's actually "yours" — with the full total + ignored split
          // available on hover; the gitignored section shows a folder's whole
          // size plainly since there nothing but ignored content is left.
          // A folder in the gitignored section never subtracts: it may still
          // carry a `dirIgnoredBytes` entry (the breakdown is dispatched from
          // the first render, when `git_file_statuses` hasn't landed yet and
          // every folder still looks regular), and there the ignored figure is
          // the folder's WHOLE size — subtracting it would show a plain 0 B.
          const dirTotal = e.is_dir ? dirSizes[e.path] : undefined;
          const dirIgnored = e.is_dir && !isGitignored && !isHiddenExt ? dirIgnoredBytes[e.path] : undefined;
          const dirShown = dirTotal !== undefined ? dirTotal - (dirIgnored ?? 0) : undefined;
          const canShRun = !e.is_dir && shellRunnerFor(e.extension, PLATFORM) !== null;
          // Run only for a Python "main" script — one with a module-level
          // `if __name__ == "__main__":` guard — not for every importable module,
          // which has nothing useful to execute. The verdict comes from the
          // persisted cache filled by the effect above, and it is read WITHOUT
          // checking the stamp: while a re-check of a just-edited script is in
          // flight the previous answer is the best one available, and keeping it
          // stops ▶ blinking out from under the pointer mid-edit. Remote is no
          // longer special-cased — that exemption is what put a ▶ on every remote
          // .py, library modules included.
          const canPyRun = !e.is_dir && isPythonPath(e.path)
            && isMainScriptCached(pyMainCache, e.path);
          const canRun = canShRun || canPyRun;
          // "Running" drives the green pulse + title/aria and unions both run
          // paths: a detached `.sh` tracked by real process liveness
          // (`runningScripts`), and a tab-backed run (Python / foreground shell)
          // whose tab is producing output (`runningRunFiles`, busy-gated).
          const isRunning = runningScripts.has(e.path) || runningRunFiles.has(e.path);
          // But only the detached path LOCKS the button: it has no tab to watch
          // and a second click would double-spawn. A tab-backed run stays
          // clickable so a re-run can replace the tab mid-session.
          const runLocked = runningScripts.has(e.path);
          const isCompiling = compiling.has(e.path);
          const dragTarget = draggableToTab(e);
          const isMoveTarget = e.is_dir && moveTargetRel === relForEntry(e);
          // SSH-sync Phase 1: per-path mirror state, symmetric across the
          // remote-source and local-mirror trees. Each non-resting state gets a
          // colored action button left of the icon: red for `none` (not synced)
          // — pull/push it; orange for `amber` (host diverged from our mirror) —
          // view the diff. `green` (in sync) is the resting state and shows
          // nothing.
          const syncTracked = remoteListing || treatLocal;
          const rel = syncTracked ? relForEntry(e) : "";
          // A folder with no manifest entry of its own falls back to the rolled-up
          // state of its tracked descendants (`dirSyncAgg`): green when it contains
          // tracked files and they are all green (so no misleading red push button),
          // amber when a tracked descendant diverged — except that an otherwise
          // all-green folder holding a NEW local-only file reads `localnew`, the
          // actionable "upload what's new" state: in the REMOTE tree the folder is
          // the only place that file can surface at all (the host readdir doesn't
          // list it). Edge cases: a folder with only untracked ("none") or only
          // new descendants has `any: false` → "none" → shows the action button
          // (correct — there IS something to transfer); a folder with an own
          // manifest entry keeps its authoritative lookup (unchanged); backend dir
          // rows always report green, so own-entry dirs never enter the aggregate
          // path. `none` remains the default when nothing is known.
          const syncState: SyncFileState = !syncTracked
            ? "none"
            : syncStatus?.[rel]?.state ??
              (e.is_dir && dirSyncAgg[rel]?.any
                ? dirSyncAgg[rel].allGreen
                  ? dirSyncAgg[rel].anyNew
                    ? "localnew"
                    : "green"
                  : "amber"
                : "none");
          // Auto-sync glyph: shown on both the remote and local trees when this
          // path (or an ancestor auto folder) is set to auto-sync. Coexists with
          // the amber ± button — an auto path that went orange is exactly what the
          // user must resolve manually.
          const autoSync = syncTracked ? !!syncStatus?.[rel]?.auto : false;
          // Effective (own-or-inherited) byte-sync exclusion: takes over the
          // whole sync slot (file or folder) with a grey X, ahead of the
          // red/orange/auto icons — an excluded path has none of those states
          // to act on. A folder shows this too (not just its excluded
          // descendants): it's the row the user actually right-clicked
          // "Exclude from sync" on, so it must visibly reflect that.
          const pathExcluded = syncTracked ? isPathExcluded(syncStatus, rel) : false;
          // Local-mirror view only: a folder that exists in the mirror but not on
          // the host (its name is absent from the host readdir, `hostChildNames`).
          // Dimmed + tagged so "Local" mode never implies the whole tree is on the
          // remote. `hostChildNames === null` (unknown / disconnected) flags nothing.
          const notOnRemote =
            e.is_dir &&
            treatLocal &&
            hostChildNames !== null &&
            !hostChildNames.has(e.name);
          return (
            <div
              key={e.path}
              className={`file-entry ${e.is_dir ? "dir" : "file"}${dragTarget ? " embeddable" : ""}${isScaffold || isGitignored || isHiddenExt ? " scaffold" : ""}${isMoveTarget ? " move-drop-target" : ""}${selected.has(e.path) ? " selected" : ""}${notOnRemote ? " not-on-remote" : ""}`}
              // Row key for jump-to-path reveal scroll (search results).
              data-entry-path={e.path}
              // Folders are drag-to-move destinations: dropping a dragged file
              // here relocates it (hit-tested by data-move-rel in the drag).
              data-move-rel={e.is_dir ? relForEntry(e) : undefined}
              {...(e.is_dir ? moveTargetAttrs : undefined)}
              // Dirs: single-click navigates + native DnD (file export).
              // Files, plain drag: pointer-based drag onto a tab bar for
              // drag-to-tab files (built-in viewer OR embeddable handler); R6 —
              // native DnD disabled then so it can't hijack the pointer. Opened
              // by double-click.
              // Files, CTRL held: arm native HTML5 DnD so any file can be dragged
              // out into an embedded browser / external target like Signal (the
              // pointer drag-to-tab bails on Ctrl, see onEntryPointerDown).
              onClick={(ev) => handleRowClick(ev, e)}
              onDoubleClick={e.is_dir ? undefined : (ev) => handleOpen(e, ev)}
              onContextMenu={(ev) => showEntryContextMenu(ev, e)}
              draggable={e.is_dir || ctrlHeld}
              onDragStart={
                e.is_dir || ctrlHeld
                  ? (ev) => handleEntryDragStart(ev, e)
                  : (ev) => ev.preventDefault()
              }
              // Every file arms the pointer drag — files with a tab/viewer target
              // can drop onto a tab bar, and ALL files can be dragged into a
              // folder to move them. Folders aren't dragged (they navigate).
              onPointerDown={!e.is_dir ? (ev) => onEntryPointerDown(ev, e, dragTarget) : undefined}
              onMouseEnter={(ev) => handleEntryMouseEnter(ev, e)}
              onMouseLeave={handleEntryMouseLeave}
            >
              <GitMarker status={status} />
              {remarksEnabled && projectId && !e.is_dir && (
                <span className="file-remark-slot">
                  {(remarkCounts?.[relForEntry(e)] ?? 0) > 0 && <span className="file-remark-count">{remarkCounts?.[relForEntry(e)]}</span>}
                </span>
              )}
              {/* Fixed-width sync slot: always reserved on a sync-tracked tree so
                  file/folder names stay left-aligned whether or not the row has an
                  action button. `none` → red sync/push button; `amber` → orange
                  diff button; `green` → empty (in sync). */}
              {syncTracked && (
                <span className="file-sync-slot">
                  {pathExcluded ? (
                    <span
                      className="file-sync-excluded"
                      title={t("fileTree.excludedFromByteSync")}
                      aria-label={t("fileTree.excludedFromByteSync")}
                    >
                      ✕
                    </span>
                  ) : (
                    <>
                      {syncState === "none" && (() => {
                        const anyBusy = !!syncProgress;
                        const thisBusy = syncProgress?.rel === rel;
                        return (
                          <button
                            type="button"
                            className={`orange-file-act orange-file-act--icon orange-file-act--slot ${remoteListing ? "orange-file-act--remote" : "orange-file-act--local"}${thisBusy ? " busy" : ""}`}
                            title={t(remoteListing ? "fileTree.syncToLocal" : "fileTree.pushToHost")}
                            aria-label={t(remoteListing ? "fileTree.syncToLocal" : "fileTree.pushToHost")}
                            disabled={anyBusy}
                            onClick={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              void (remoteListing ? syncEntryToLocal(e) : pushEntryToHost(e));
                            }}
                          >
                            {thisBusy ? <span className="file-run-spinner" /> : remoteListing ? <ArrowDownIcon /> : <ArrowUpIcon />}
                          </button>
                        );
                      })()}
                      {/* NEW local-only content: this file (or something inside
                          this folder) exists in the mirror and was never synced,
                          so the host has no copy. The only meaningful action is
                          the upload, whichever tree is showing — hence always ⬆
                          and always the push handler, unlike the "none" slot
                          above whose direction follows the listing side. */}
                      {syncState === "localnew" && (() => {
                        const anyBusy = !!syncProgress;
                        const thisBusy = syncProgress?.rel === rel;
                        const title = t(
                          e.is_dir ? "fileTree.folderHasNewFiles" : "fileTree.pushNewFile",
                        );
                        return (
                          <button
                            type="button"
                            className={`orange-file-act orange-file-act--icon orange-file-act--slot orange-file-act--local${thisBusy ? " busy" : ""}`}
                            title={title}
                            aria-label={title}
                            disabled={anyBusy}
                            onClick={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              void pushEntryToHost(e);
                            }}
                          >
                            {thisBusy ? <span className="file-run-spinner" /> : <ArrowUpIcon />}
                          </button>
                        );
                      })()}
                      {syncState === "amber" && !e.is_dir && (
                        <button
                          type="button"
                          className="file-diff-btn"
                          title={t("fileTree.diffTitle")}
                          aria-label={t("fileTree.diffAria")}
                          onClick={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            openSyncMerge(e);
                          }}
                        >
                          ±
                        </button>
                      )}
                      {syncState === "amber" && e.is_dir && (
                        <span
                          className="file-sync-dir-diverged"
                          title={t("fileTree.folderDiverged")}
                          aria-label={t("fileTree.folderDiverged")}
                        >
                          ±
                        </span>
                      )}
                      {/* Auto-sync indicator (non-interactive): only when the slot
                          has no action button, so it never crowds out the
                          red/orange controls. Amber auto paths still show ±
                          (needs resolving). */}
                      {autoSync && syncState === "green" && (
                        <span
                          className="file-autosync-icon"
                          title={t("fileTree.autoSyncing")}
                          aria-label={t("fileTree.autoSyncing")}
                        >
                          ⟳
                        </span>
                      )}
                    </>
                  )}
                </span>
              )}
              {canRun && (
                <button
                  type="button"
                  className={`file-run-btn${isRunning ? " running" : ""}`}
                  // No native `title` here on purpose: hovering this button sits
                  // inside the row, which already has the row's own portaled
                  // tooltip open (below) — a browser title tooltip on top of it
                  // would be a second, uncontrolled hover. Everything it would
                  // have said (run/args/right-click hint) lives in that tooltip
                  // instead.
                  aria-label={t(isRunning ? "fileTree.runningName" : "fileTree.runName", { name: e.name })}
                  onClick={(ev) => (canPyRun ? runPythonScript(ev, e) : runShellScript(ev, e))}
                  // Right-click the Run button → set arguments: `sys.argv` for a
                  // Python script, `$@` for a shell script. Swallowed either way so
                  // it doesn't fall through to the row's file context menu.
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setArgsPopover({
                      entry: e,
                      x: ev.clientX,
                      y: ev.clientY,
                      draft: runArgsByPath[e.path] ?? "",
                    });
                  }}
                  disabled={runLocked}
                >
                  <PlayIcon />
                </button>
              )}
              {isCompiling && (
                <span
                  className="file-run-btn running"
                  title={t("fileTree.compilingNameEllipsis", { name: e.name })}
                  aria-label={t("fileTree.compilingName", { name: e.name })}
                >
                  <span className="file-run-spinner" />
                </span>
              )}
              <span className="file-icon"><FileIcon ext={e.extension} isDir={e.is_dir} /></span>
              <span className="file-name">{e.name}</span>
              {notOnRemote && (
                <span
                  className="file-offhost-tag"
                  title={t("fileTree.localOnlyFolderTitle")}
                  aria-label={t("fileTree.localOnlyFolderAria")}
                >
                  {t("fileTree.localOnlyTag")}
                </span>
              )}
              {e.is_dir && isScanExcluded(relForEntry(e)) ? (
                // Stands in for the size rather than sitting beside it: there is no
                // size to show, and saying why is more use than an empty column.
                <span
                  className="file-size file-size-excluded"
                  title={t("fileTree.excludedFromScansTitle")}
                >
                  {t("fileTree.notScanned")}
                </span>
              ) : e.is_dir ? (
                dirShown !== undefined && (
                  <span className={`file-size ${sizeCategory(dirShown)}`}>
                    {fmtSize(dirShown)}
                  </span>
                )
              ) : (
                <span className={`file-size ${sizeClass}`}>{fmtSize(e.size)}</span>
              )}
            </div>
          );
        }

        return (
          <>
            {rows.regular.map((e) => renderEntry(e, false))}
            {standard.length > 0 && (
              <>
                <button
                  type="button"
                  className="file-tree-section-divider file-tree-hidden-toggle"
                  aria-expanded={scaffoldExpanded}
                  onClick={() => setScaffoldExpanded((v) => !v)}
                  title={t(scaffoldExpanded ? "fileTree.collapseScaffold" : "fileTree.expandScaffold")}
                >
                  <span className="file-tree-hidden-caret">{scaffoldExpanded ? "▾" : "▸"}</span>
                  {t("fileTree.scaffoldSection", { count: standard.length })}
                  {renderGroupTotal(
                    groupSizes.standard,
                    groupSizes.standardPartial,
                    sizeTitle(t, groupSizes.standard, groupSizes.standardIgnored, t("fileTree.totalSizeScaffold")),
                  )}
                </button>
                {scaffoldExpanded && rows.standard.map((e) => renderEntry(e, true))}
              </>
            )}
            {gitignored.length > 0 && (
              <>
                <button
                  type="button"
                  className="file-tree-section-divider file-tree-hidden-toggle"
                  aria-expanded={gitignoredExpanded}
                  onClick={() => setGitignoredExpanded((v) => {
                    const next = !v;
                    try { localStorage.setItem(GITIGNORED_EXPANDED_KEY, next ? "1" : "0"); } catch { /* ignore storage failures */ }
                    return next;
                  })}
                  title={t(gitignoredExpanded ? "fileTree.collapseGitignored" : "fileTree.expandGitignored")}
                >
                  <span className="file-tree-hidden-caret">{gitignoredExpanded ? "▾" : "▸"}</span>
                  {t("fileTree.gitignoredSection", { count: gitignored.length })}
                  {renderGroupTotal(
                    groupSizes.gitignored,
                    groupSizes.gitignoredPartial,
                    t("fileTree.totalSizeGitignored"),
                  )}
                </button>
                {gitignoredExpanded && rows.gitignored.map((e) => renderEntry(e, false, true))}
              </>
            )}
            {hiddenExt.length > 0 && (
              <>
                <button
                  type="button"
                  className="file-tree-section-divider file-tree-hidden-toggle"
                  aria-expanded={hiddenExtExpanded}
                  onClick={() => setHiddenExtExpanded((v) => {
                    const next = !v;
                    try { localStorage.setItem(HIDDEN_EXT_EXPANDED_KEY, next ? "1" : "0"); } catch { /* ignore storage failures */ }
                    return next;
                  })}
                  title={t(hiddenExtExpanded ? "fileTree.collapseHiddenExt" : "fileTree.expandHiddenExt")}
                >
                  <span className="file-tree-hidden-caret">{hiddenExtExpanded ? "▾" : "▸"}</span>
                  {t("fileTree.hiddenExtSection", { count: hiddenExt.length })}
                  {renderGroupTotal(
                    groupSizes.hiddenExt,
                    groupSizes.hiddenExtPartial,
                    t("fileTree.totalSizeHiddenExt"),
                  )}
                </button>
                {hiddenExtExpanded && rows.hiddenExt.map((e) => renderEntry(e, false, false, true))}
              </>
            )}
            {rows.hidden > 0 && (
              // The escape hatch for the render cap. Says how many rows are held
              // back so the number is never a mystery, and reveals a page at a
              // time rather than the whole folder — the point is to keep the DOM
              // bounded, and a "show all" would hand back the freeze it prevents.
              <button
                type="button"
                className="file-tree-section-divider file-tree-more"
                onClick={() => setRowCap((n) => n + ROW_CAP_STEP)}
                title={t("fileTree.showMoreTitle", {
                  shown: orderedVisible.length,
                  more: Math.min(rows.hidden, ROW_CAP_STEP),
                })}
              >
                {t("fileTree.showMoreButton", {
                  more: Math.min(rows.hidden, ROW_CAP_STEP),
                  hidden: rows.hidden,
                })}
              </button>
            )}
          </>
        );
      })()}
      {contextMenu?.rowRect && createPortal(
        <div
          key={contextMenu.entry?.path ?? "root"}
          className="file-entry-highlight"
          style={{
            left: contextMenu.rowRect.left,
            top: contextMenu.rowRect.top,
            width: contextMenu.rowRect.width,
            height: contextMenu.rowRect.height,
          }}
        />,
        document.body,
      )}
      {argsPopover &&
        createPortal(
          <div className="file-run-args-backdrop" onMouseDown={() => setArgsPopover(null)}>
            <div
              ref={argsPopoverRef}
              className="file-run-args"
              style={{ left: argsPopover.x, top: argsPopover.y }}
              onMouseDown={(ev) => ev.stopPropagation()}
              role="dialog"
              aria-label={t("fileTree.runArgsAria", { name: argsPopover.entry.name })}
            >
              <label className="file-run-args-label">
                {isPythonPath(argsPopover.entry.path) ? (
                  t("fileTree.runArgsLabel", { name: argsPopover.entry.name })
                ) : (
                  <>
                    {t("fileTree.runArgsLabelShell", { name: argsPopover.entry.name })}
                    <UntestedTag id="fileTree.1" />
                  </>
                )}
              </label>
              <input
                ref={argsInputRef}
                className="file-run-args-input"
                value={argsPopover.draft}
                spellCheck={false}
                placeholder={isPythonPath(argsPopover.entry.path) ? "--epochs 5 data.csv" : "--verbose out/"}
                onChange={(ev) =>
                  setArgsPopover((p) => (p ? { ...p, draft: ev.target.value } : p))
                }
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    const a = argsPopover.draft.trim();
                    setRunArgs(argsPopover.entry.path, a);
                    launchWithArgs(argsPopover.entry, a);
                    setArgsPopover(null);
                  } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    setArgsPopover(null);
                  }
                }}
              />
              <div className="file-run-args-row">
                <button
                  type="button"
                  className="file-run-args-btn"
                  onClick={() => {
                    const a = argsPopover.draft.trim();
                    setRunArgs(argsPopover.entry.path, a);
                    launchWithArgs(argsPopover.entry, a);
                    setArgsPopover(null);
                  }}
                >
                  {t("fileTree.runArgsRun")}
                </button>
                <button
                  type="button"
                  className="file-run-args-btn"
                  onClick={() => {
                    const a = argsPopover.draft.trim();
                    setRunArgs(argsPopover.entry.path, a);
                    setArgsPopover(null);
                  }}
                  title={t("fileTree.rememberArgsTitle")}
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu file-browser-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!contextMenu.entry && (
            <>
              {onOpenFolderTab && (
                <>
                  <button
                    onClick={() => {
                      setContextMenu(null);
                      onOpenFolderTab(relPath);
                    }}
                  >
                    {t("fileTree.openViewInNewTab")}
                  </button>
                  {/* The project in its IDE, from the tree's root menu as well
                      as the pill's — the same rows, same backend detection.
                      Offered where "Open in a new tab" is (the side panel
                      host); a tree browsing a subfolder still opens the
                      project, since the markers sit at its root. */}
                  {projectId && (
                    <IdeMenuItems projectId={projectId} onClose={() => setContextMenu(null)} />
                  )}
                  <hr />
                </>
              )}
              <button onClick={() => createEntry("file")}>
                {t("fileBrowser.newFile")}
              </button>
              <button onClick={() => createEntry("dir")}>
                {t("fileBrowser.newFolder")}
              </button>
              {/* The native presenter's from-blank path. Without it, creating a
                  deck required an existing PDF and the "Present" button inside
                  its viewer — the only affordance in the whole app — so the
                  from-blank flow the design promises was unreachable (TODO V
                  #107). Gated on the same experimental flag the PDF button is.

                  Captioned as its own group rather than left loose under "New
                  File": a `.eldeck.json` is Tabtivity's own format, not a file type
                  the OS or the generic new-file path knows how to make, and the
                  caption is what says so at the point of choosing. */}
              {deckEnabled && (
                <div className="context-menu-group">
                  <div className="context-menu-group-label">
                    {t("fileTree.appNativeGroup")}
                  </div>
                  <button className="untested" onClick={() => void createDeck()}>
                    {t("fileTree.newPresentation")}
                    <UntestedTag id="fileTree.2" />
                  </button>
                </div>
              )}
              {treatLocal && (
                <>
                  <hr />
                  <button onClick={() => pushAllToHost()}>
                    {t("fileTree.pushAllToHost")}
                  </button>
                </>
              )}
              {(clipboard || clipboardImage) && <hr />}
              {renderPasteButton()}
              {clipboardImage && (
                <button onClick={openScreenshotPrompt}>
                  {t("fileTree.pasteScreenshot")}
                </button>
              )}
            </>
          )}
          {contextMenu.entry && (() => {
            const entry = contextMenu.entry;
            // When the right-clicked row is part of a >1 selection, the menu acts
            // on the whole selection (bulk Copy/Cut/Delete only — the per-file
            // actions like Rename / Stage / Set-default-app don't generalise).
            const menuEntries =
              selected.has(entry.path) && selected.size > 1
                ? entries.filter((en) => selected.has(en.path))
                : [entry];
            if (menuEntries.length > 1) {
              const n = menuEntries.length;
              return (
                <>
                  <button onClick={() => copyEntries(menuEntries, "copy")}>
                    {t("fileTree.copyItemsCount", { count: n })}
                  </button>
                  <button onClick={() => copyEntries(menuEntries, "cut")}>
                    {t("fileTree.cutItemsCount", { count: n })}
                  </button>
                  {renderPasteButton()}
                  <hr />
                  <button className="danger" onClick={() => promptDelete(menuEntries)}>
                    {t("fileTree.deleteItemsCount", { count: n })}
                    <MenuShortcut chord={DELETE_KEY} />
                  </button>
                </>
              );
            }
            const status = displayStatuses[entry.name];
            const isTex = !entry.is_dir && entry.extension === ".tex";
            const isZip = !entry.is_dir && entry.extension === ".zip";
            const entryRel = relForEntry(entry);
            const syncSel = remoteListing ? syncStatus?.[entryRel]?.selected : false;
            // Auto-sync is symmetric across the remote/local trees (both are
            // sync-tracked); read the effective flag either way.
            const syncTracked = remoteListing || treatLocal;
            const autoOn = syncTracked ? !!syncStatus?.[entryRel]?.auto : false;
            // Own marker only: an inherited exclusion is the transfer paths'
            // business, but the label here must describe THIS row's answer.
            const syncExcluded = syncTracked
              ? !!syncStatus?.[entryRel]?.excluded
              : false;
            return (
              <>
                {onOpenFolderTab && entry.is_dir && (
                  <>
                    <button
                      onClick={() => {
                        setContextMenu(null);
                        onOpenFolderTab(entryRel);
                      }}
                    >
                      {t("fileTree.openInNewTab")}
                    </button>
                    <hr />
                  </>
                )}
                {/* Local trees only: the exclusion governs the LOCAL walks (the
                    size walk and the churn watcher). A remote folder's size comes
                    from `du` on the host, which this list has no say over. */}
                {onToggleScanExcluded && entry.is_dir && !remoteListing && (
                  <>
                    <button
                      onClick={() => {
                        setContextMenu(null);
                        const now = isScanExcluded(entryRel);
                        onToggleScanExcluded(entryRel, !now);
                        // Drop any size already shown for the folder: leaving the
                        // old number up would claim a figure we've stopped keeping
                        // current. Re-including re-requests it via `requestedSizes`.
                        requestedSizes.current.delete(entry.path);
                        setDirSizes((m) => {
                          const next = { ...m };
                          delete next[entry.path];
                          return next;
                        });
                        setDirIgnoredBytes((m) => {
                          const next = { ...m };
                          delete next[entry.path];
                          return next;
                        });
                      }}
                      title={t(
                        isScanExcluded(entryRel)
                          ? "fileTree.resumeScanTitle"
                          : "fileTree.neverScanTitle",
                      )}
                    >
                      {t(isScanExcluded(entryRel) ? "fileTree.includeInScans" : "fileTree.excludeFromScans")}
                    </button>
                    <hr />
                  </>
                )}
                {remoteListing && (
                  <>
                    <button onClick={() => syncEntryToLocal(entry)}>
                      {t(entry.is_dir ? "fileTree.syncFolderToLocal" : "fileTree.syncToLocal")}
                    </button>
                    {syncSel && (
                      <button onClick={() => stopSyncingEntry(entry)}>
                        {t("fileTree.stopSyncing")}
                      </button>
                    )}
                    <hr />
                  </>
                )}
                {treatLocal && (
                  <>
                    <button onClick={() => pushEntryToHost(entry)}>
                      {t(entry.is_dir ? "fileTree.pushFolderToHost" : "fileTree.pushToHost")}
                    </button>
                    <hr />
                  </>
                )}
                {syncTracked && (
                  <>
                    <button onClick={() => toggleAutoSyncEntry(entry, !autoOn)}>
                      {t(
                        autoOn
                          ? entry.is_dir
                            ? "fileTree.stopAutoSyncFolder"
                            : "fileTree.stopAutoSync"
                          : entry.is_dir
                            ? "fileTree.autoSyncFolder"
                            : "fileTree.autoSyncFile",
                      )}
                    </button>
                    {/* Stronger than "stop auto-syncing": an exclusion is also
                        honoured by the whole-project Sync all / push, which is
                        what a giant data or build folder needs. Same marker the
                        large-folder setup prompt writes, so the two agree. */}
                    {entry.is_dir && (
                      <button
                        className="untested"
                        onClick={() => toggleSyncExcluded(entry, !syncExcluded)}
                        title={t(
                          syncExcluded
                            ? "fileTree.includeInSyncTitle"
                            : "fileTree.excludeFromSyncTitle",
                        )}
                      >
                        {t(syncExcluded ? "fileTree.includeInSync" : "fileTree.excludeFromSync")}
                        <UntestedTag id="fileTree.3" />
                      </button>
                    )}
                    <hr />
                  </>
                )}
                {isZip && (
                  <>
                    <button onClick={() => extractArchive(entry)}>
                      {t("fileTree.extractHere")}
                    </button>
                    <hr />
                  </>
                )}
                {isTex && texCap?.available && (
                  <>
                    <button
                      onClick={() => compileTex(entry, true)}
                      disabled={compiling.has(entry.path)}
                    >
                      {t("fileTree.compileViewPdf")}
                    </button>
                    <button
                      onClick={() => compileTex(entry, false)}
                      disabled={compiling.has(entry.path)}
                    >
                      {t("fileTree.compilePdf")}
                    </button>
                    <hr />
                  </>
                )}
                {(status === "modified" || status === "untracked") && (
                  <button onClick={() => stageEntry(entry)}>
                    {t("fileTree.stageGitAdd")}
                  </button>
                )}
                {status && !entry.is_dir && (
                  <button onClick={() => showDiff(entry)}>
                    {t("fileTree.showDiff")}
                  </button>
                )}
                <button onClick={() => updateGitignore(entry, "ignore")}>
                  {t("fileTree.addToGitignore")}
                </button>
                <button onClick={() => updateGitignore(entry, "unignore")}>
                  {t("fileTree.unignoreFromGitignore")}
                </button>
                {!entry.is_dir && entry.extension && (
                  <>
                    <hr />
                    <button onClick={() => { setContextMenu(null); setDefaultAppFor(entry); }}>
                      {t("fileTree.setDefaultAppEllipsis")}
                    </button>
                  </>
                )}
                <hr />
                <button onClick={() => copyEntries([entry], "copy")}>
                  {t("common.copy")}
                </button>
                <button onClick={() => copyEntries([entry], "cut")}>
                  {t("common.cut")}
                </button>
                {/* Copy this file/folder into another project. Local trees only:
                    the source is read as an ordinary filesystem path, which a
                    remote (SFTP) listing's entry is not. */}
                {!remoteListing && (
                  <button
                    className="untested"
                    onClick={() => {
                      setContextMenu(null);
                      setSendTo({ path: entry.path, name: entry.name, isDir: entry.is_dir });
                    }}
                  >
                    {t("sendToProject.menuItem")}
                    <UntestedTag id="fileTree.4" />
                  </button>
                )}
                {remarksEnabled && projectId && !entry.is_dir && (
                  <button className="untested" onClick={() => { setContextMenu(null); setRemarkFor(entry); }}>
                    {t("projectRemarks.addMenu")} <UntestedTag id="projectRemarks.addMenu" />
                  </button>
                )}
                {/* The per-file/folder SFTP exit — the one casual way bytes
                    leave a mirrorless (VM) project, size-confirmed. */}
                {remoteListing && (
                  <button className="untested" onClick={() => void downloadEntryTo(entry)}>
                    {t("fileTree.downloadToMenuItem")}
                    <UntestedTag id="fileTree.5" />
                  </button>
                )}
                {renderPasteButton()}
                {clipboardImage && (
                  <button onClick={openScreenshotPrompt}>
                    {t("fileTree.pasteScreenshot")}
                  </button>
                )}
                <hr />
                <button onClick={() => renameEntry(entry)}>
                  {t("fileBrowser.rename")}
                </button>
                <button className="danger" onClick={() => promptDelete([entry])}>
                  {t("fileBrowser.delete")}
                  <MenuShortcut chord={DELETE_KEY} />
                </button>
              </>
            );
          })()}
          <button onClick={() => setContextMenu(null)}>{t("common.cancel")}</button>
        </div>,
        document.body,
      )}
      {deleteConfirm && createPortal(
        <div className="modal-backdrop" onMouseDown={() => setDeleteConfirm(null)}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            {deleteConfirm.entries.length === 1 ? (
              <>
                <h2>{t(deleteConfirm.entries[0].is_dir ? "fileTree.deleteFolderTitle" : "fileTree.deleteFileTitle")}</h2>
                <p>
                  {t("fileTree.confirmDeleteOnePre")} <strong>{deleteConfirm.entries[0].name}</strong>
                  {t("fileTree.confirmDeleteOnePost")}
                </p>
                <div className="file-delete-path">{relForEntry(deleteConfirm.entries[0])}</div>
              </>
            ) : (
              <>
                <h2>{t("fileTree.deleteItemsTitle", { count: deleteConfirm.entries.length })}</h2>
                <p>
                  {t("fileTree.confirmDeleteMany", { count: deleteConfirm.entries.length })}
                </p>
                <div className="file-delete-path">
                  {deleteConfirm.entries.map((e) => e.name).join(", ")}
                </div>
              </>
            )}
            <div className="file-delete-actions">
              <button type="button" onClick={() => setDeleteConfirm(null)}>{t("common.cancel")}</button>
              <button type="button" className="danger" onClick={confirmDelete}>{t("fileBrowser.delete")}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {autoConfirm && createPortal(
        <div className="modal-backdrop" onMouseDown={() => setAutoConfirm(null)}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{t("fileTree.autoSyncConfirmTitle")}</h2>
            <p>
              {t("fileTree.autoSyncConfirmPre")} <strong>{autoConfirm.entry.name}</strong>{" "}
              {t("fileTree.autoSyncConfirmMid")}{" "}
              <strong>{t("fileTree.autoSyncFilesCount", { count: autoConfirm.files.toLocaleString() })}</strong>{" "}
              ({fmtSize(autoConfirm.bytes)}) {t("fileTree.autoSyncConfirmPost")}
            </p>
            <p>
              {t("fileTree.autoSyncConfirmBody2Pre")}{" "}
              <strong>{t("fileTree.autoSyncConfirmBody2Strong")}</strong>
              {t("fileTree.autoSyncConfirmBody2Post")}
            </p>
            <div className="file-delete-path">{relForEntry(autoConfirm.entry)}</div>
            <div className="file-delete-actions">
              <button type="button" onClick={() => setAutoConfirm(null)}>{t("common.cancel")}</button>
              <button
                type="button"
                onClick={() => applyAutoSync(autoConfirm.entry, true)}
              >
                {t("fileTree.autoSyncAnyway")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {pushConflicts.length > 0 && createPortal(
        <div className="modal-backdrop" onMouseDown={() => !pushBusy && resolvePushConflict("skip")}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{t("fileTree.hostChangedTitle")}</h2>
            <p>
              <strong>{basename(pushConflicts[0]) || pushConflicts[0]}</strong>{" "}
              {t("fileTree.hostChangedPost")}
            </p>
            <div className="file-delete-path">{pushConflicts[0]}</div>
            {pushConflicts.length > 1 && (
              <>
                <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {t(
                    pushConflicts.length - 1 > 1
                      ? "fileTree.moreConflictsMany"
                      : "fileTree.moreConflictsOne",
                    { count: pushConflicts.length - 1 },
                  )}
                </p>
                {/* Where the skipped ones go. Stated here rather than only in the
                    button's tooltip, because "skip all" reads like giving up
                    unless you know the files stay listed and resolvable. */}
                <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {t("fileTree.skipAllWhere")}
                </p>
              </>
            )}
            <div className="file-delete-actions">
              {pushConflicts.length > 1 && (
                <button
                  type="button"
                  disabled={pushBusy}
                  onClick={skipAllPushConflicts}
                  title={t("fileTree.skipAllTitle")}
                  style={{ marginRight: "auto" }}
                >
                  {t("fileTree.skipAll", { count: pushConflicts.length })}
                </button>
              )}
              <button type="button" disabled={pushBusy} onClick={() => resolvePushConflict("skip")}>
                {t("common.skip")}
              </button>
              <button type="button" disabled={pushBusy} onClick={() => resolvePushConflict("host")}>
                {t("fileTree.takeHost")}
              </button>
              <button type="button" className="danger" disabled={pushBusy} onClick={() => resolvePushConflict("keep")}>
                {t("fileTree.keepLocal")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {pastePrompt && createPortal(
        <div className="modal-backdrop" onMouseDown={() => !pasteBusy && setPastePrompt(null)}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>
              {pastePrompt.kind === "image"
                ? t("fileTree.pasteScreenshotTitle")
                : t(clipboard?.isDir ? "fileTree.pasteFolderTitle" : "fileTree.pasteFileTitle")}
            </h2>
            <p>
              {pastePrompt.kind === "image" ? (
                <>{t("fileTree.saveClipboardImage")}</>
              ) : (
                <>
                  {t(clipboard?.op === "cut" ? "common.move" : "common.copy")}{" "}
                  <strong>{clipboard?.name}</strong>
                </>
              )}{" "}
              {t("fileTree.pasteIntoPre")}{" "}
              <strong>{relPath || basename(projectDir) || t("fileTree.projectRootFolder")}</strong>{" "}
              {t("fileTree.pasteIntoPost")}
            </p>
            <input
              className="file-paste-name"
              autoFocus
              value={pastePrompt.name}
              disabled={pasteBusy}
              onChange={(e) => setPastePrompt({ ...pastePrompt, name: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmPaste();
                if (e.key === "Escape") setPastePrompt(null);
              }}
            />
            {pastePrompt.error && <ErrorNote className="file-delete-path file-delete-error" error={pastePrompt.error} />}
            <div className="file-delete-actions">
              <button type="button" onClick={() => setPastePrompt(null)} disabled={pasteBusy}>{t("common.cancel")}</button>
              <button type="button" onClick={confirmPaste} disabled={pasteBusy || !pastePrompt.name.trim()}>
                {t(pastePrompt.kind === "file" && clipboard?.op === "cut" ? "common.move" : "common.paste")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {dialogs}
      {renamePrompt && (
        <RenameDialog
          entryName={renamePrompt.entry.name}
          isDir={renamePrompt.entry.is_dir}
          folder={containingFolderLabel(renamePrompt.entry.path, t("fileTree.projectRootFolder"))}
          onCancel={() => setRenamePrompt(null)}
          onRename={(next) => confirmRename(renamePrompt.entry, next)}
        />
      )}
      {defaultAppFor && defaultAppFor.extension && (
        <SetDefaultAppDialog
          ext={defaultAppFor.extension}
          fileName={defaultAppFor.name}
          projectId={projectId ?? null}
          onClose={() => setDefaultAppFor(null)}
        />
      )}
      {sendTo && (
        <SendToProjectDialog
          source={sendTo}
          fromProjectId={projectId}
          onClose={() => setSendTo(null)}
        />
      )}
      {remarkFor && projectId && (
        <AddRemarkDialog projectId={projectId} projectDir={projectDir} file={relForEntry(remarkFor)}
          onClose={() => setRemarkFor(null)} />
      )}
      {tooltip && createPortal(
        <div
          ref={tooltipRef}
          className="file-tooltip"
          // Anchor on whichever side of the row has more room, so the tooltip pops
          // *away* from the panel edge: docked right → opens left (the default),
          // docked left → the row sits near x:0 and it opens right instead. Keyed
          // off the row's own rect, so it does the right thing in a centred tab too.
          // `tooltipShift` pulls it back up when it would otherwise overflow the
          // window's bottom edge (a row near the bottom of a short docked viewer).
          style={
            window.innerWidth - tooltip.rect.right > tooltip.rect.left
              ? { left: tooltip.rect.right + 8, top: tooltip.rect.top - tooltipShift }
              : { right: window.innerWidth - tooltip.rect.left + 8, top: tooltip.rect.top - tooltipShift }
          }
        >
          <div className="file-tooltip-name">{tooltip.entry.name}</div>
          {(remoteListing || treatLocal) && isPathExcluded(syncStatus, relForEntry(tooltip.entry)) && (
            <div className="file-tooltip-excluded">{t("fileTree.excludedFromByteSync")}</div>
          )}
          {tooltip.entry.created_secs && (
            <div><span className="file-tooltip-label">{t("fileTree.tooltipCreated")} </span>{fmtModified(tooltip.entry.created_secs)}</div>
          )}
          {tooltip.entry.modified_secs && (
            <div><span className="file-tooltip-label">{t("fileTree.tooltipModified")}</span>{fmtModified(tooltip.entry.modified_secs)}</div>
          )}
          {/* Same rule as the row: no ignored/total split for a folder that is
              itself ignored — "412 MB of 412 MB ignored" says nothing. */}
          {tooltip.entry.is_dir
            && displayStatuses[tooltip.entry.name] !== "ignored"
            && dirIgnoredBytes[tooltip.entry.path] !== undefined && (
            <div>
              <span className="file-tooltip-label">{t("fileTree.tooltipIgnored")} </span>
              {fmtSize(dirIgnoredBytes[tooltip.entry.path])}
              {dirSizes[tooltip.entry.path] !== undefined &&
                t("fileTree.tooltipOfTotal", { total: fmtSize(dirSizes[tooltip.entry.path]) })}
            </div>
          )}
          {!tooltip.entry.is_dir && (
            isPythonPath(tooltip.entry.path)
              ? (isMainScriptCached(pyMainCache, tooltip.entry.path) || runArgsByPath[tooltip.entry.path])
              : shellRunnerFor(tooltip.entry.extension, PLATFORM) !== null
          ) && (
            <>
              {(isPythonPath(tooltip.entry.path)
                ? isMainScriptCached(pyMainCache, tooltip.entry.path)
                : true) && (
                <div>
                  <span className="file-tooltip-label">{t("fileTree.tooltipRun")} </span>
                  {t("fileTree.tooltipRunHint")}
                </div>
              )}
              {/* Nested under Run, not a top-level "Run args" row — and shown
                  even when the file above lost its Run button (no `__main__`
                  guard), so args set earlier don't just look lost. */}
              {runArgsByPath[tooltip.entry.path] && (
                <div className="file-tooltip-sub">
                  <span className="file-tooltip-label">{t("fileTree.tooltipArgs")} </span>
                  {runArgsByPath[tooltip.entry.path]}
                </div>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
