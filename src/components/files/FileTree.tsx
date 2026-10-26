import { useModalFocus } from "../../hooks/useModalFocus";
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../lib/execTrust";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { FileDropContext } from "./fileDropContext";
import { openTabInScope, useTabScope } from "../../lib/tabs/tabScopeContext";
import { openFileEntry } from "../../lib/files/openFileEntry";
import { closeTabsForDeletedPath, retargetTabsForRenamedPath } from "./fileTabSync";
import { HOST_OS } from "../../lib/platform";
import { useSettingsStore } from "../../stores/settings";
import { useExperimental } from "../../lib/experimental";
import { GIT_STATE_COLOR } from "../../lib/theme/gitColors";
import { createDeckFile } from "../../lib/viewers/deck/create";
import { isPathExcluded, type SyncFileState, type SyncSkippedFile } from "../../stores/remote/sync";
import { confirmSyncTransfer } from "../../stores/remote/syncConfirm";
import { useActivityStore } from "../../stores/activity";
import { useFileClipboardStore } from "../../stores/fileClipboard";
import { type FileEntry, type InternalViewer, type SortKey, fmtSize, fmtModified, visibleEntries, internalViewerFor, disabledViewers, fileEntriesEqual, stringMapsEqual, nextSelection } from "../../lib/viewers/fileUtils";
import {
  dropFileTreeSnapshot,
  readFileTreeSnapshot,
} from "../../lib/projects/fileViewSnapshots";
import { type TexCompileResult, lastLogLine } from "../../lib/viewers/tex/tex";
import { basename, dirname, relativePathWithin, resolvePath } from "../../lib/paths";
import {
  moveDestRel,
  movedEntryAbs,
  type ResolvedMoveTarget,
} from "../../lib/projects/fileMove";
import { resolveProjectDirectory } from "../../types";
import { isPythonPath } from "../../lib/viewers/python";
import {
  isMainScriptCached,
} from "../../lib/terminal/pythonMainCache";
import { runPythonFile, pythonRunPlan, placeForFocused } from "../../lib/terminal/pythonRun";
import { argsFromLines } from "../../lib/terminal/runArgsFormat";
import { PythonInterpreterSelect } from "../projects/PythonInterpreterSelect";
import {
  shellRunnerFor,
  shellScriptRunPlan,
  type ScriptShell,
} from "../../lib/terminal/shellScriptRun";
import { guardLoginNodeRun } from "../../lib/remote/hpc/hpcGuard";
import { useRunHostPrefStore } from "../../stores/remote/runHostPref";
import { SetDefaultAppDialog } from "./SetDefaultAppDialog";
import { SendToProjectDialog, type SendSource } from "./SendToProjectDialog";
import { AddRemarkDialog } from "./AddRemarkDialog";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { FileTreeSearch } from "./FileTreeSearch";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { SyncSkippedLarge } from "./SyncSkippedLarge";
import { SyncMirrorSkips } from "./SyncMirrorSkips";
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
import { storageKey } from "../../lib/brand";
import type { GitStatusMap, MoveTargetAttrs, RowActions } from "./fileTreeTypes";
import { beginNativeFileDrag, startEntryPointerDrag } from "./fileTreeDrag";
import { useFileTreeFsWatch, useFileTreeListingState, useFileTreeMountLoad } from "./useFileTreeListing";
import { useFileTreeEmbedCaps, useFileTreeMountProbes, useFileTreeSearch, useFileTreeTooltip } from "./useFileTreeChrome";
import { useFileTreePythonMain, useFileTreeRunState } from "./useFileTreeRun";
import { useFileTreeRemote, useFileTreeSyncStatus } from "./useFileTreeRemote";
import { ROW_CAP_STEP, useFileTreeRowActions, useFileTreeRows } from "./useFileTreeRows";
import { useFileTreeDirSizes } from "./useFileTreeSizes";

// The context menu's Delete rows name their keyboard twin (handleTreeKeyDown).
const DELETE_KEY: ChordDescriptor = { key: "Delete" };

// Persist whether the collapsed "gitignored" files section is expanded, so the
// choice survives side-panel hide/show and remounts (FileTree remounts each
// time the panel reopens). Mirrors GitHistory's localStorage view pref.
const GITIGNORED_EXPANDED_KEY = storageKey("fileTree.gitignoredExpanded");
// Same idea, for the collapsed "hidden by extension" group (the project's own
// hiddenEndings list — see ProjectFilesSettings) — collapsed by default too.
const HIDDEN_EXT_EXPANDED_KEY = storageKey("fileTree.hiddenExtExpanded");

/// How long the pointer must rest on a row before its tooltip opens. Long enough
/// that sweeping the tree never opens (or measures) anything — see
/// `handleEntryMouseEnter` for why entry-triggered tooltips were expensive.
const TOOLTIP_DWELL_MS = 400;

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
 *  clipboard, a system-clipboard image (screenshot) or a file/folder a file
 *  manager copied (`system`); `name` is the name being chosen for the pasted
 *  result in the current folder. */
/** What `copy_path` left out of a copied folder (pipes, sockets, devices). */
type CopyReport = { skipped: string[]; skippedCount: number };

type PastePrompt = { kind: "file" | "image" | "system"; name: string; error: string | null };
/** A file or folder on the OS clipboard (`clipboard_file_paths`). */
type SystemClipboardFile = { path: string; name: string; isDir: boolean };
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

interface FileRowProps {
  entry: FileEntry;
  /** Scaffold / gitignored / hidden-ending section member (dimmed). */
  scaffold: boolean;
  /** Git letter (never for the gitignored / hidden-ending sections). */
  status: string | undefined;
  /** A folder's headline size (its non-ignored weight), once known. */
  dirShown: number | undefined;
  /** A folder excluded from the size scans (shows a note instead of a size). */
  scanExcluded: boolean;
  canPyRun: boolean;
  canShRun: boolean;
  isRunning: boolean;
  runLocked: boolean;
  isCompiling: boolean;
  dragTarget: InternalViewer | "embed" | null;
  isMoveTarget: boolean;
  selected: boolean;
  notOnRemote: boolean;
  /** The tree is sync-tracked (remote listing, or the local mirror of one). */
  syncTracked: boolean;
  /** The row's path relative to the tree root. */
  rel: string;
  syncState: SyncFileState;
  autoSync: boolean;
  pathExcluded: boolean;
  /** Some transfer is running in this project / it is this row's. */
  syncAnyBusy: boolean;
  syncThisBusy: boolean;
  remoteListing: boolean;
  /** Remark count for the slot, or null when the slot is not shown at all. */
  remarkCount: number | null;
  ctrlHeld: boolean;
  moveTargetAttrs: MoveTargetAttrs;
  rows: RowActions;
}

/**
 * One listing row. Memoised (performance plan §5.1): the tree re-renders on
 * every hover dwell, size arrival, git/sync status and selection change, and
 * with a few hundred rows on screen ("show more") each of those used to
 * rebuild every row's dozen elements. Everything that crosses this boundary
 * is a primitive, the entry, or one of the tree's two stable objects, so only
 * the rows whose own inputs changed render.
 */
const FileRow = React.memo(function FileRow({
  entry: e,
  scaffold,
  status,
  dirShown,
  scanExcluded,
  canPyRun,
  canShRun,
  isRunning,
  runLocked,
  isCompiling,
  dragTarget,
  isMoveTarget,
  selected,
  notOnRemote,
  syncTracked,
  rel,
  syncState,
  autoSync,
  pathExcluded,
  syncAnyBusy,
  syncThisBusy,
  remoteListing,
  remarkCount,
  ctrlHeld,
  moveTargetAttrs,
  rows,
}: FileRowProps) {
  const t = useT();
  const canRun = canShRun || canPyRun;
  const sizeClass = !e.is_dir ? sizeCategory(e.size) : "";
  return (
    <div
      className={`file-entry ${e.is_dir ? "dir" : "file"}${dragTarget ? " embeddable" : ""}${scaffold ? " scaffold" : ""}${isMoveTarget ? " move-drop-target" : ""}${selected ? " selected" : ""}${notOnRemote ? " not-on-remote" : ""}`}
      // Row key for jump-to-path reveal scroll (search results).
      data-entry-path={e.path}
      // Folders are drag-to-move destinations: dropping a dragged file
      // here relocates it (hit-tested by data-move-rel in the drag).
      data-move-rel={e.is_dir ? rel : undefined}
      {...(e.is_dir ? moveTargetAttrs : undefined)}
      // Plain drag: pointer-based — files with a built-in viewer OR an
      // embeddable handler drop onto a tab bar; files and folders alike
      // move into a folder row / crumb / ↑ (spring-opening it on a dwell).
      // R6 — native DnD disabled then so it can't hijack the pointer.
      // Files open by double-click, folders navigate on a single click.
      // CTRL held: arm native HTML5 DnD so any entry can be dragged out
      // into an embedded browser / external target like Signal (the
      // pointer drag bails on Ctrl, see onEntryPointerDown).
      onClick={(ev) => rows.click(ev, e)}
      onDoubleClick={e.is_dir ? undefined : (ev) => rows.open(e, ev)}
      onContextMenu={(ev) => rows.contextMenu(ev, e)}
      draggable={ctrlHeld}
      onDragStart={ctrlHeld ? (ev) => rows.dragStart(ev, e) : (ev) => ev.preventDefault()}
      onPointerDown={(ev) => rows.pointerDown(ev, e, dragTarget)}
      onMouseEnter={(ev) => rows.mouseEnter(ev, e)}
      onMouseLeave={rows.mouseLeave}
    >
      <GitMarker status={status} />
      {remarkCount !== null && (
        <span className="file-remark-slot">
          {remarkCount > 0 && <span className="file-remark-count">{remarkCount}</span>}
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
              {syncState === "none" && (
                <button
                  type="button"
                  className={`orange-file-act orange-file-act--icon orange-file-act--slot ${remoteListing ? "orange-file-act--remote" : "orange-file-act--local"}${syncThisBusy ? " busy" : ""}`}
                  title={t(remoteListing ? "fileTree.syncToLocal" : "fileTree.pushToHost")}
                  aria-label={t(remoteListing ? "fileTree.syncToLocal" : "fileTree.pushToHost")}
                  disabled={syncAnyBusy}
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (remoteListing) rows.syncToLocal(e);
                    else rows.pushToHost(e);
                  }}
                >
                  {syncThisBusy ? <span className="file-run-spinner" /> : remoteListing ? <ArrowDownIcon /> : <ArrowUpIcon />}
                </button>
              )}
              {/* NEW local-only content: this file (or something inside
                  this folder) exists in the mirror and was never synced,
                  so the host has no copy. The only meaningful action is
                  the upload, whichever tree is showing — hence always ⬆
                  and always the push handler, unlike the "none" slot
                  above whose direction follows the listing side. */}
              {syncState === "localnew" && (() => {
                const title = t(
                  e.is_dir ? "fileTree.folderHasNewFiles" : "fileTree.pushNewFile",
                );
                return (
                  <button
                    type="button"
                    className={`orange-file-act orange-file-act--icon orange-file-act--slot orange-file-act--local${syncThisBusy ? " busy" : ""}`}
                    title={title}
                    aria-label={title}
                    disabled={syncAnyBusy}
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      rows.pushToHost(e);
                    }}
                  >
                    {syncThisBusy ? <span className="file-run-spinner" /> : <ArrowUpIcon />}
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
                    rows.openSyncMerge(e);
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
          onClick={(ev) => (canPyRun ? rows.runPython(ev, e) : rows.runShell(ev, e))}
          // Right-click the Run button → set arguments: `sys.argv` for a
          // Python script, `$@` for a shell script. Swallowed either way so
          // it doesn't fall through to the row's file context menu.
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            rows.openRunArgs(ev, e);
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
      {e.is_dir && scanExcluded ? (
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
});

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
  const {
    seedPending, snapshotKeyFor, rawEntries, setRawEntries, fastMode, dirSizes, setDirSizes,
    requestedSizes, sizeGeneration, scanExcludedList, isScanExcluded, loadTargetRef,
    dirIgnoredBytes, setDirIgnoredBytes, embedByExt, setEmbedByExt, relPath, setRelPath, selected,
    setSelected, anchorRef, loading, setLoading, error, setError, missingCrumbDepth,
    setMissingCrumbDepth, gitStatuses, setGitStatuses,
  } = useFileTreeListingState({
    projectId, projectDir, initialRelPath, scanExcluded,
  });
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
  const { tooltip, setTooltip, tooltipRef, tooltipShift } = useFileTreeTooltip({
    cancelTooltipTimer,
  });
  // Right-click on the breadcrumb turns the path into an editable field (holding
  // the current folder's absolute path) so a path can be typed/pasted to jump —
  // and copies that absolute path to the clipboard. `null` = not editing.
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const pathEditRef = useRef<HTMLInputElement | null>(null);
  const {
    search, setSearch, hostOwnsSearchChrome, searchOpen, setSearchOpen, searchMode, setSearchMode,
    searchCase, setSearchCase, searchRoot, setSearchRoot,
  } = useFileTreeSearch({
    searchOpenProp, onSearchOpenChange,
  });
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
  // When the last drag gesture ended (see `commitRelease`), so the click its
  // release fires is not taken as a click on the row.
  const dragClickGuard = useRef(0);
  const [moveTargetRel, setMoveTargetRel] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<EntryContextMenu>(null);
  // The focusable tree root. File rows preventDefault on pointerdown to arm the
  // drag, which suppresses the browser's default focus-the-ancestor — so we move
  // focus here explicitly on selection, or the tree's key handlers (Enter/Delete/
  // Escape) would only fire after a manual Tab-in (notably in the docked sidebar).
  const treeRootRef = useRef<HTMLDivElement | null>(null);
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
  const { promptText, confirmAction, dialogs } = useDialogs();
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
  // Files/folders a file manager put on the system clipboard, probed the same
  // way; pasted as copies through the OS-drop import (`import_external_file`).
  const [systemFiles, setSystemFiles] = useState<SystemClipboardFile[]>([]);
  const clipboardEntries = useFileClipboardStore((s) => s.entries);
  const setClipboardEntries = useFileClipboardStore((s) => s.setEntries);
  const clearClipboard = useFileClipboardStore((s) => s.clear);
  // The primary clipboard item — backs the single-file paste-rename prompt and
  // its labels. Multi-item pastes read the full `clipboardEntries` array.
  const clipboard = clipboardEntries[0] ?? null;
  const { texCap, setTexCap, compiling, setCompiling, runArgsByPath, setRunArgs, argsPopover, setArgsPopover, argsPopoverRef, argsInputRef } = useFileTreeRunState();
  const runInBackground = useSettingsStore((s) => s.settings?.run_scripts_in_background ?? true);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  /** Gates the "New Presentation" item, exactly as the PDF viewer's Present
   *  button is gated — the native presenter is still experimental. */
  const deckEnabled = useExperimental("deck_presenter");
  const runningScripts = useActivityStore((s) => s.runningScripts);
  const runningRunFiles = useActivityStore((s) => s.runningRunFiles);
  const runScript = useActivityStore((s) => s.runScript);
  const {
    isRemote, project, mirrorRoot, treatLocal, remoteListing, syncStatus, dirSyncAgg, syncProgress,
    refreshSyncStatus, syncPull, syncPush, syncMarkSelected, syncSetAuto, syncAutoPreview,
    syncSetExcluded, remoteSshState, remoteBlocked, primaryIsHpc, hostChildNames, setHostChildNames,
  } = useFileTreeRemote({
    projectId, syncSource,
  });

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

  const { pyMainCache, pyMainInFlight, setPyMainNonce } = useFileTreePythonMain({
    entries, projectId, fastMode,
  });

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

  const { displayStatuses, sections, setRowCap, rowWindow, orderedVisible } = useFileTreeRows({
    gitStatuses, entries, hiddenEndings, relPath, shownPaths, separateScaffold, separateGitignored,
    dirIgnoredBytes, dirSizes, sortKey, descending, projectId, scaffoldExpanded, gitignoredExpanded,
    hiddenExtExpanded, setSelected,
  });

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

  useFileTreeEmbedCaps({ entries, embedByExt, setEmbedByExt, projectId });

  const { groupSizes } = useFileTreeDirSizes({
    active, fastMode, rowWindow, sections, requestedSizes, sizeGeneration, isScanExcluded,
    relForEntry, projectDir, scanExcludedList, dirSizes, setDirSizes, dirIgnoredBytes,
    setDirIgnoredBytes,
  });

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

  useFileTreeMountProbes({ setTexCap, setCtrlHeld });

  useFileTreeMountLoad({
    projectDir, remoteBlocked, initialRelPath, seedPending, load, refresh, error, snapshotKeyFor,
    relPath, rawEntries, gitStatuses, dirSizes, dirIgnoredBytes,
  });

  useFileTreeSyncStatus({
    isRemote, projectId, remoteBlocked, relPath, active, refreshSyncStatus, remoteSshState,
    primaryIsHpc, fastMode, treatLocal, remoteProbeDir, setHostChildNames,
  });

  useFileTreeFsWatch({ projectDir, remoteListing, active, relPath, refresh });

  async function load(rel: string) {
    // Never issue the (synchronous, main-thread) remote listing commands while the
    // pool is down — they would freeze the window. See `remoteBlocked`.
    if (remoteBlocked) return;
    loadTargetRef.current = rel;
    setError(null);
    setMissingCrumbDepth(null);
    // The hovered row is about to unmount, so its `mouseleave` never fires: a
    // pending dwell or an open tooltip would otherwise outlive it.
    cancelTooltipTimer();
    setTooltip(null);
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
    // `anchorRef`/`setSelected` come from `useFileTreeListingState`: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (Date.now() - dragClickGuard.current < 400) return;
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
      // A row unmounted during the dwell (navigated away, re-listed) measures as
      // an all-zero rect and would pin a tooltip to the window's top-left corner
      // that no `mouseleave` ever closes.
      if (!row.isConnected) return;
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

  // The pointer drag a row starts: see `startEntryPointerDrag` (fileTreeDrag.ts).
  function onEntryPointerDown(
    e: React.PointerEvent,
    entry: FileEntry,
    dragTarget: InternalViewer | "embed" | null,
  ) {
    startEntryPointerDrag({
      selected, entries, disabledViewerSet, relForEntry, setMoveTarget, projectId, projectDir,
      relPath, remoteListing, relPathRef, load, fileDrop, moveTargetRef, dragClickGuard,
      moveEntryToFolder,
    }, e, entry, dragTarget);
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

  const { moveTargetAttrs, rowActions } = useFileTreeRowActions({
    projectDir, remoteListing, handleRowClick, handleOpen, showEntryContextMenu,
    handleEntryDragStart, onEntryPointerDown, handleEntryMouseEnter, handleEntryMouseLeave,
    syncEntryToLocal, pushEntryToHost, openSyncMerge, runShellScript, runPythonScript,
    setArgsPopover, runArgsByPath,
  });

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
      // This tree re-lists the folder now on screen — after a spring-load that
      // is where the drag went, not where it started (the entry left either
      // way); a cross-root destination tree catches up through its own
      // fs-watch.
      await load(relPathRef.current);
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
    probeSystemClipboard();
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
      const ok = await confirmAction({
        title: t("fileTree.downloadToTitle"),
        body: t("fileTree.downloadToConfirm", {
          name: entry.name,
          files: size.files,
          size: fmtSize(size.bytes),
          dest,
        }),
      });
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
    const newAbs = resolvePath(dirname(oldAbs), nextName);
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
      ? basename(relPath)
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

  function openSystemPastePrompt() {
    setContextMenu(null);
    if (!systemFiles[0]) return;
    setPastePrompt({ kind: "system", name: suggestPasteName(systemFiles[0].name), error: null });
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

  // The context-menu entry for files a file manager copied. One item keeps the
  // rename prompt, several paste in bulk — the in-app Paste's split.
  function renderSystemPasteButton() {
    if (systemFiles.length === 0) return null;
    const multi = systemFiles.length > 1;
    return (
      <button className="untested" onClick={() => (multi ? void pasteAllSystem() : openSystemPastePrompt())}>
        {multi
          ? t("fileTree.pasteFromSystemCount", { count: systemFiles.length })
          : t("fileTree.pasteFromSystemNamed", { name: systemFiles[0].name })}
        <UntestedTag id="fileTree.pasteFromSystem" />
      </button>
    );
  }

  // Copy every system-clipboard item into the current folder, auto-naming each
  // collision with " copy" (pasteAll's rule). The source is never moved, even
  // after a file manager's Cut.
  async function pasteAllSystem() {
    setContextMenu(null);
    const files = systemFiles;
    if (files.length === 0) return;
    setLoading(true);
    setError(null);
    const claimed = new Set<string>();
    try {
      for (const f of files) {
        const destName = suggestPasteName(f.name, claimed);
        claimed.add(destName);
        await invoke("import_external_file", {
          projectDir,
          sourcePath: f.path,
          destRel: relPath,
          replace: false,
          destName,
        });
      }
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function copySkippedNote(count: number, names: string[]): string {
    return t("fileTree.copySkipped", { count, names: names.join(", ") });
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
    let skippedCount = 0;
    const skippedNames: string[] = [];
    try {
      for (const cb of clipboardEntries) {
        const newName = suggestPasteName(cb.name, claimed);
        claimed.add(newName);
        const destRel = relPath ? `${relPath}/${newName}` : newName;
        const done = await invoke<CopyReport | null | undefined>(cb.op === "cut" ? "move_path" : "copy_path", {
          srcProjectDir: cb.projectDir,
          srcRel: cb.relPath,
          destProjectDir: projectDir,
          destRel,
        });
        if (done?.skippedCount) {
          skippedCount += done.skippedCount;
          skippedNames.push(...done.skipped.map((n) => `${newName}/${n}`));
        }
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
      if (skippedCount > 0) setError(copySkippedNote(skippedCount, skippedNames));
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
    let skippedNote: string | null = null;
    try {
      if (pastePrompt.kind === "image") {
        await invoke("save_clipboard_image", { projectDir, relPath: destRel });
      } else if (pastePrompt.kind === "system") {
        const source = systemFiles[0];
        if (!source) return;
        await invoke("import_external_file", {
          projectDir,
          sourcePath: source.path,
          destRel: relPath,
          replace: false,
          destName: newName,
        });
      } else {
        if (!clipboard) return;
        const done = await invoke<CopyReport | null | undefined>(clipboard.op === "cut" ? "move_path" : "copy_path", {
          srcProjectDir: clipboard.projectDir,
          srcRel: clipboard.relPath,
          destProjectDir: projectDir,
          destRel,
        });
        if (done?.skippedCount) skippedNote = copySkippedNote(done.skippedCount, done.skipped);
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
      if (skippedNote) setError(skippedNote);
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
    probeSystemClipboard();
  }

  // Ask the backend whether a screenshot/image or copied files are on the system
  // clipboard so the open context menu can reveal "Paste screenshot" / "Paste
  // … from the system clipboard". Async, so the menu shows immediately and the
  // options appear once the probes resolve. A remote listing has no local
  // folder to import into, so it skips the file probe.
  function probeSystemClipboard() {
    invoke<boolean>("clipboard_has_image")
      .then(setClipboardImage)
      .catch(() => setClipboardImage(false));
    setSystemFiles([]);
    if (remoteListing) return;
    invoke<SystemClipboardFile[]>("clipboard_file_paths")
      .then((files) => setSystemFiles(Array.isArray(files) ? files : []))
      .catch(() => setSystemFiles([]));
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
    const interp = shellRunnerFor(entry.extension, HOST_OS) as ScriptShell | null;
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

  // The tree's own prompts own the keyboard while they are up (Escape, Tab,
  // and no app shortcuts underneath). A busy one ignores Escape like its
  // backdrop does.
  const deleteModalRef = useModalFocus(() => setDeleteConfirm(null), !!deleteConfirm);
  const autoModalRef = useModalFocus(() => setAutoConfirm(null), !!autoConfirm);
  const pushModalRef = useModalFocus(
    () => { if (!pushBusy) void resolvePushConflict("skip"); },
    pushConflicts.length > 0,
  );
  const pasteModalRef = useModalFocus(() => { if (!pasteBusy) setPastePrompt(null); }, !!pastePrompt);

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
      <SyncMirrorSkips projectId={projectId ?? undefined} />
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
          const canShRun = !e.is_dir && shellRunnerFor(e.extension, HOST_OS) !== null;
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
          const rel = relForEntry(e);
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
            <FileRow
              key={e.path}
              entry={e}
              scaffold={isScaffold || isGitignored || isHiddenExt}
              status={status}
              dirShown={dirShown}
              scanExcluded={e.is_dir && isScanExcluded(rel)}
              canPyRun={canPyRun}
              canShRun={canShRun}
              isRunning={isRunning}
              runLocked={runLocked}
              isCompiling={isCompiling}
              dragTarget={dragTarget}
              isMoveTarget={isMoveTarget}
              selected={selected.has(e.path)}
              notOnRemote={notOnRemote}
              syncTracked={syncTracked}
              rel={rel}
              syncState={syncState}
              autoSync={autoSync}
              pathExcluded={pathExcluded}
              syncAnyBusy={!!syncProgress}
              syncThisBusy={syncProgress?.rel === rel}
              remoteListing={remoteListing}
              remarkCount={remarksEnabled && projectId && !e.is_dir ? (remarkCounts?.[rel] ?? 0) : null}
              ctrlHeld={ctrlHeld}
              moveTargetAttrs={moveTargetAttrs}
              rows={rowActions}
            />
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
              {/* One option per line (`runArgsFormat`); Enter runs, Shift+Enter
                  breaks a line, and the lines are joined back on save. */}
              <textarea
                ref={argsInputRef}
                className="file-run-args-input file-run-args-list"
                value={argsPopover.draft}
                spellCheck={false}
                wrap="off"
                rows={Math.min(8, Math.max(2, argsPopover.draft.split("\n").length))}
                placeholder={isPythonPath(argsPopover.entry.path) ? "--epochs 5\ndata.csv" : "--verbose\nout/"}
                onChange={(ev) =>
                  setArgsPopover((p) => (p ? { ...p, draft: ev.target.value } : p))
                }
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" && !ev.shiftKey) {
                    ev.preventDefault();
                    const a = argsFromLines(argsPopover.draft);
                    setRunArgs(argsPopover.entry.path, a);
                    launchWithArgs(argsPopover.entry, a);
                    setArgsPopover(null);
                  } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    setArgsPopover(null);
                  }
                }}
              />
              {project && isPythonPath(argsPopover.entry.path) && (
                <PythonInterpreterSelect
                  project={project}
                  labelClassName="file-run-args-label"
                  selectClassName="file-run-args-input"
                />
              )}
              <div className="file-run-args-row">
                <button
                  type="button"
                  className="file-run-args-btn"
                  onClick={() => {
                    const a = argsFromLines(argsPopover.draft);
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
                    const a = argsFromLines(argsPopover.draft);
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
      {contextMenu && (
        <ContextMenuPortal x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
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
              {(clipboard || clipboardImage || systemFiles.length > 0) && <hr />}
              {renderPasteButton()}
              {renderSystemPasteButton()}
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
            // Own OR inherited: a row inside an excluded tree is downloaded the
            // same way. The pull leaves the exclusion in place (auto-sync and
            // Sync all keep skipping it), so it is offered as a one-off copy.
            const downloadExcluded = syncTracked && isPathExcluded(syncStatus, entryRel);
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
                    {downloadExcluded ? (
                      <button
                        className="untested"
                        onClick={() => syncEntryToLocal(entry)}
                        title={t("fileTree.downloadExcludedTitle")}
                      >
                        {t(entry.is_dir ? "fileTree.downloadExcludedFolder" : "fileTree.downloadExcludedFile")}
                        <UntestedTag id="fileTree.downloadExcludedFolder" />
                      </button>
                    ) : (
                      <button onClick={() => syncEntryToLocal(entry)}>
                        {t(entry.is_dir ? "fileTree.syncFolderToLocal" : "fileTree.syncToLocal")}
                      </button>
                    )}
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
                    {/* The local copy of an excluded folder holds only what was
                        downloaded (or git-tracked) — fetch the host's bytes here. */}
                    {downloadExcluded && entry.is_dir && (
                      <button
                        className="untested"
                        onClick={() => syncEntryToLocal(entry)}
                        title={t("fileTree.downloadExcludedTitle")}
                      >
                        {t("fileTree.downloadExcludedFolder")}
                        <UntestedTag id="fileTree.downloadExcludedFolder" />
                      </button>
                    )}
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
                {renderSystemPasteButton()}
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
        </ContextMenuPortal>
      )}
      {deleteConfirm && createPortal(
        <div className="modal-backdrop" onMouseDown={() => setDeleteConfirm(null)}>
          <div ref={deleteModalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
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
          <div ref={autoModalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
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
          <div ref={pushModalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
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
          <div ref={pasteModalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>
              {pastePrompt.kind === "image"
                ? t("fileTree.pasteScreenshotTitle")
                : t(
                    (pastePrompt.kind === "system" ? systemFiles[0]?.isDir : clipboard?.isDir)
                      ? "fileTree.pasteFolderTitle"
                      : "fileTree.pasteFileTitle",
                  )}
            </h2>
            <p>
              {pastePrompt.kind === "image" ? (
                <>{t("fileTree.saveClipboardImage")}</>
              ) : pastePrompt.kind === "system" ? (
                <>
                  {t("common.copy")} <strong>{systemFiles[0]?.name}</strong>
                </>
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
              : shellRunnerFor(tooltip.entry.extension, HOST_OS) !== null
          ) && (
            <>
              {(isPythonPath(tooltip.entry.path)
                ? isMainScriptCached(pyMainCache, tooltip.entry.path)
                : true) && (
                <div>
                  <span className="file-tooltip-label">{t("fileTree.tooltipRun")} </span>
                  {t(isPythonPath(tooltip.entry.path) ? "fileTree.tooltipRunHintPy" : "fileTree.tooltipRunHint")}
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
