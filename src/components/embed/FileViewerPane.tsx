import { PreviewImages } from "./previewImages";
import { DraftSaver } from "./draftSaver";
import { registerUnsavedWork } from "../../lib/window/unsavedWork";
import { lineStarts, indexedLine } from "./lineIndex";
import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../lib/execTrust";
import { CompletionCache, completionLineLength, completionWindow, typeThrough, type CompletionGhost } from "../../lib/viewers/completion/autocomplete";
import { OllamaCompletionProvider } from "../../lib/viewers/completion/ollamaCompletionProvider";
import { CopilotCompletionProvider, CopilotFeedback, copilotServes } from "../../lib/viewers/completion/copilotCompletionProvider";
import type { CompletionCandidate, CompletionProvider } from "../../lib/viewers/completion/completionProvider";
import { completionContext } from "../../lib/viewers/completion/completionContext";
import { bumpUsage } from "../../stores/usage";
import { METRIC } from "../../lib/usageMetrics";
import { emit, listen } from "@tauri-apps/api/event";
import { useWindowsStore } from "../../stores/windows";
import {
  ROOT_SCOPE,
  findGroupOfTab,
  findTabByKey,
  getDetachedViewerState,
  useTabsStore,
  type TabEntry,
  type ViewerState,
} from "../../stores/tabs";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { openTabInScope } from "../tabs/tabScopeContext";
import { useSettingsStore } from "../../stores/settings";
import { saverInterval, useQuiesce } from "../../stores/power";
import { useTexViewPrefStore, texViewScopeKey } from "../../stores/viewers/texViewPref";
import { useExperimental } from "../../lib/experimental";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { RemotePaneHold } from "../projects/RemotePaneHold";
import { useLinkRoutingStore } from "../../stores/linkRouting";
import {
  useEditorJumpStore,
  hasMountedEditor,
  registerEditor,
  unregisterEditor,
} from "../../stores/viewers/editorJump";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";
import { useScrollSync } from "../../stores/viewers/scrollSync";
import { parseDetachedParam } from "../../stores/detached";
import { Dropdown } from "../common/Dropdown";
import { PrinterIcon } from "../common/PrinterIcon";
import { SaveIcon } from "../common/SaveIcon";
import { CompareView } from "./CompareView";
import { GitMergeView } from "./GitMergeView";
import { PresentationOverlay } from "./PresentationOverlay";
import { usePresentationStore } from "../../stores/viewers/presentation";
import { matchAnchorId, renderMarkdown, splitLineHint, toggleTaskCheckbox } from "../../lib/viewers/markdown";
import { useMdAnchorStore } from "../../stores/viewers/mdAnchor";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { MdGraphView } from "./MdGraphView";
import {
  highlight,
  languageForPath,
  escapeHtml,
  lineCommentMarker,
  type Lang,
} from "../../lib/viewers/highlight";
import { useOllamaStatus } from "../../lib/ollamaStatus";
import {
  printDocument,
  printHtmlBody,
  MARKDOWN_PRINT_CSS,
  TEXT_PRINT_CSS,
  IMAGE_PRINT_CSS,
} from "../../lib/viewers/print";
import {
  formatJsonText,
  isInProcessJson,
  formatLangForPath,
  validationLangForPath,
  previewKindForPath,
  buildPreviewDoc,
  type PreviewKind,
} from "../../lib/viewers/format";
import {
  toggleInline,
  cycleHeading,
  toggleLinePrefix,
  makeLink,
  generateToc,
  type EditResult,
} from "../../lib/viewers/markdownEdit";
import {
  BEAMER_OVERLAY_COMMANDS,
  beamerEditRange,
  buildOverlaySpec,
  insertPause,
  isBeamerDocument,
  isOverlaySpecBody,
  nextOverlayNumber,
  overlayItems,
  wrapBeamerOverlay,
  type BeamerOverlayCommand,
  type RememberedSelection,
} from "../../lib/viewers/tex/beamer";
import { internalViewerFor, disabledViewers, relFromAbs, lineEndingOf, applyLineEnding, type InternalViewer, type FileEntry } from "../../lib/viewers/fileUtils";
import {
  isPythonPath,
  isPythonMainScript,
  pythonLinkRanges,
  pythonStringEnd,
  remapBreakpoints,
  resolvePythonDefinition,
  snapBreakpointLine,
} from "../../lib/viewers/python";
import {
  debugPythonFile,
  runCwd,
  runPythonFile,
  pythonRunPlan,
  fileSideLocation,
  placeForFocused,
} from "../../lib/terminal/pythonRun";
import { RunHostPicker } from "../tabs/TabLocalityBadges";
import { useRunHostPrefStore } from "../../stores/remote/runHostPref";
import {
  isSlurmScript,
  parseSbatchDirectives,
  directiveValue,
  spliceDirective,
  slurmAvailable,
  submitSlurmJob,
  openInteractiveJob,
  COMMON_SBATCH_KEYS,
  type SlurmInfo,
  type InteractiveResources,
} from "../../lib/remote/hpc/slurm";
import { FileDropContext } from "../files/fileDropContext";
import { UntestedTag } from "../common/UntestedTag";
import { FolderPickerDialog } from "../common/FolderPickerDialog";
import { fetchRemoteImage, hostsLabel, remoteImageHosts } from "../../lib/remote/remoteImages";
import { AddRemarkDialog } from "../files/AddRemarkDialog";
import { FileSourceSwitch } from "../files/ProjectFilesPane";
import {
  basename,
  dirname,
  fromFileUri,
  isPathWithin,
  normalizePath,
  resolvePath,
  relativePathFrom,
  relativePathWithin,
  toFileUri,
} from "../../lib/paths";
import { IS_MAC, IS_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import {
  resolveProjectDirectory,
  resolveLocalMirror,
  type AutocompleteMode,
  type GrammarIssue,
} from "../../types";
import { useSyncStore } from "../../stores/remote/sync";
import { ContextFilePicker } from "./ContextFilePicker";
import { useFileSourcesStore } from "../../stores/viewers/fileSources";
import {
  FileScopeContext,
  useFileScope,
  PaneVisibleContext,
  usePaneVisible,
  fileSource,
  type FileSource,
  readFileText,
  readFileBytes,
  writeFileText,
  fileMtime,
  describeFileErrorKey,
} from "./fileAccess";
import { DiffView } from "./DiffView";
import { SyncMergeView } from "./SyncMergeView";
import { OdtView } from "./OdtView";
import { ViewerErrorBoundary } from "./ViewerErrorBoundary";
import { MediaView } from "./MediaView";
import { GifView } from "./GifView";
import { ImageAnnotator } from "./ImageAnnotator";
import {
  type TexCapability,
  type TexCompileResult,
  type TexCompletions,
  type TexComplContext,
  getTexCapability,
  refreshTexCapability,
  lastLogLine,
  type TexError,
  parseTexErrors,
  resolveTexErrorPath,
  findTexRefAt,
  findTexKeyRefAt,
  resolveTexKeyRef,
  texKeyRefRanges,
  findTexComplAt,
  texCompletionsFor,
  insertTexCommand,
  insertTexEnvironment,
  TEX_STANDARD_COMMANDS,
  TEX_STANDARD_ENVIRONMENTS,
  type TexCommandEntry,
  type TexEnvEntry,
  type TexLabelEntry,
  type BibEntry,
  type TexWarning,
  type TexFileDiagnostics,
  parseTexWarnings,
  texDiagnosticsByFile,
  gatherTexWordCount,
  type TexWordCount,
  gatherTexCompletions,
  resolveTexRefAsync,
  texRefCreation,
  texPathExists,
  createTexRefFile,
  addTexChildFile,
  type TexRefCreation,
  texRefRanges,
  texRefHitRanges,
  synctexViewBest,
  pickSyncRect,
  sourceColumnFraction,
  isTexDocumentRoot,
  resolveTexRoot,
  lineStartOffset,
  offsetToLineCol,
  phraseAt,
  findTexDelimiterMatch,
  findUnclosedTexBrackets,
  findTexEnvNameMatch,
  syncTexEnvRename,
  texEnvNameRangeAt,
  texCommandAt,
  texCommandOccurrences,
  gatherTexStructure,
  texStructureParent,
  hasMatchingTexEnd,
  type TexStructure,
  type TexFileNode,
  texSnippetRanges,
  texPreamble,
  type TexSnippetRange,
  compileWasNoop,
} from "../../lib/viewers/tex/tex";
import {
  actionMatches,
  chordLabel,
  chordMatches,
  modifierLabel,
  resolveChord,
  zoomFor,
  type ShortcutMap,
} from "../../lib/shortcuts/shortcuts";
import { useChordHint, useShortcutOverrides } from "../../lib/shortcuts/shortcutHint";
import {
  renderTexPreview,
  cachedTexPreview,
  type TexPreview,
} from "../../lib/viewers/tex/texPreview";
import { TexStructureRail, TexStructureSidebar } from "./tex/TexStructureSidebar";
import { useDialogs } from "../common/PromptDialogs";
import { focusTexWorkspaceForSource } from "./openTexWorkspace";
import {
  compileTexWorkspace,
  registerTexCompile,
  registerTexWorkspace,
  unregisterTexCompile,
  unregisterTexWorkspace,
} from "../../stores/viewers/texCenter";
import { YamlTree } from "./YamlTree";
import { YamlGrid } from "./YamlGrid";
import { BibCards } from "./BibCards";
import { isTreePath, isJsonPath } from "../../lib/viewers/yaml";
import { isBibPath } from "../../lib/viewers/tex/bib";
import { hasCards } from "../../lib/viewers/yamlGrid";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";
import {
  defaultSpellLanguage,
  dictionaryChoices,
  languageDisplayName,
  type CatalogDictionary,
  type InstalledDictionary,
} from "../../lib/spellDictionaries";
import { ArrowUpRightIcon, BoltIcon, BugIcon, CommentIcon, GearIcon, LinkIcon, PlayIcon, UploadIcon, WarningIcon } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";

// The five heavyweight leaf viewers are code-split (§5.1 startup size): a
// static import here would parse pdfjs-dist + pdf-lib + fontkit (PdfView,
// DeckView) and the table/notebook/sqlite machinery at every window's launch.
// `lazy` defers each to its first render behind the existing dispatch switch;
// the Suspense boundaries sit around the two render sites below.
const TableView = lazy(() => import("./TableView").then((m) => ({ default: m.TableView })));
const NotebookView = lazy(() => import("./NotebookView").then((m) => ({ default: m.NotebookView })));
const SqliteView = lazy(() => import("./SqliteView").then((m) => ({ default: m.SqliteView })));
const PdfView = lazy(() => import("./pdf/PdfViewer").then((m) => ({ default: m.PdfView })));
const DeckView = lazy(() => import("./deck/DeckView").then((m) => ({ default: m.DeckView })));

/**
 * Persisted reader-position plumbing for an in-app viewer. Snapshots the tab's
 * saved `ViewerState` once (so the viewer restores scroll/zoom/pan from where the
 * reader left it on mount, rather than reacting to its own later writes) and
 * returns a stable `persist` that merges a patch back into the tab — flushed to
 * project.json by CenterPanel's debounced saveLayout, so the position survives an
 * Tabtivity restart. A no-op when `tabKey` is absent (e.g. tests).
 */
/**
 * A tab's persisted `ViewerState` seed, read once. Normally from `useTabsStore`
 * (the main window owns the layout store); in a DETACHED window that store has
 * no entry for the tab — its tabs render from a Tauri seed into local React
 * state, not the store — so fall back to the detached seed registry. Without
 * this fallback a detached editor loses per-tab scroll/zoom and the #45
 * autocomplete/spelling toggles, silently reverting to the per-type defaults.
 */
function seedViewerState(tabKey: string | undefined): ViewerState | undefined {
  if (!tabKey) return undefined;
  return (
    findTabByKey(useTabsStore.getState(), tabKey)?.viewerState ??
    getDetachedViewerState(tabKey)
  );
}

export function useViewerState(tabKey: string | undefined) {
  const [initial] = useState<ViewerState | undefined>(() => seedViewerState(tabKey));
  const persist = useCallback(
    (patch: ViewerState) => {
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );
  // Stable object so consumers can list `viewPos` in effect/callback deps without
  // re-running every render (`initial` and `persist` are both stable).
  return useMemo(() => ({ initial, persist }), [initial, persist]);
}

// The ghost-suggestion key legend's Alt chords, rendered once through
// `chordLabel` so they read ⌥ on macOS and Alt elsewhere; the handler itself is
// unchanged (`e.altKey`).
const AC_KEY_LABELS = {
  altRight: chordLabel({ key: "ArrowRight", alt: true }),
  altBrackets: `${chordLabel({ key: "[", alt: true })}/]`,
};

/** A small floating "{Ctrl}+Click to open" hint, anchored just above a hovered
 *  file link (#49). `at` is viewport coordinates of the link's top-left, or null
 *  to hide. Purely informational: pointer-events:none so it never blocks a click. */
function LinkOpenHint({
  at,
  label,
}: {
  at: { left: number; top: number } | null;
  label?: string;
}) {
  const t = useT();
  if (!at) return null;
  return (
    <div className="link-open-hint" role="tooltip" style={{ left: at.left, top: at.top }}>
      {label ?? t("fileViewer.linkOpenHint", { modifier: modifierLabel() })}
    </div>
  );
}

/** Pure zoom-to-cursor math for the image viewer (#52): given the current and
 *  next scale, the current top-left offset, and the viewport-local anchor the
 *  zoom should keep fixed, return the new offset. Extracted + tested. */
export function zoomOffset(
  prevScale: number,
  nextScale: number,
  offset: { x: number; y: number },
  anchor: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: anchor.x - ((anchor.x - offset.x) * nextScale) / prevScale,
    y: anchor.y - ((anchor.y - offset.y) * nextScale) / prevScale,
  };
}

/** A URI-list / DownloadURL dataTransfer payload for dragging a file out of the
 *  app as an OS-level drop source (#53). Mirrors FileTree's `file://` encoding. */
function pathToFileUri(path: string): string {
  return toFileUri(path);
}

/**
 * Populate a dragstart's dataTransfer so an image (or file) can be dropped OUT of
 * Tabtivity into another app — a browser file-upload field, a chat, etc. (#53).
 * Publishes:
 *  - `text/uri-list` + `text/plain`: the canonical `file://` URI (most targets).
 *  - `DownloadURL`: `mime:name:url`, used by Chromium-family drop targets.
 * Exported so it can be unit-tested with a mock DataTransfer. Returns nothing;
 * receivers that ignore these types simply don't accept the drop.
 */
export function onImageDragStart(
  e: { dataTransfer: DataTransfer | null },
  path: string,
) {
  const dt = e.dataTransfer;
  if (!dt) return;
  const uri = pathToFileUri(path);
  const name = basename(path);
  dt.setData("text/uri-list", uri);
  dt.setData("text/plain", uri);
  // DownloadURL = "<mime>:<filename>:<absolute url>". An empty mime lets the OS
  // sniff it; the receiver downloads/copies the file at `uri`.
  dt.setData("DownloadURL", `:${name}:${uri}`);
  dt.effectAllowed = "copy";
}

interface Props {
  /** Which built-in viewer to render with. */
  viewer: InternalViewer;
  /** Absolute path of the file being viewed. */
  path: string;
  /** Owning project id (null in the root scope). */
  projectId: string | null;
  /** This viewer tab's key, so opened file links route to the SAME subwindow by
   *  default and drag-to-set-default can key its session-only override (#50). */
  tabKey?: string;
  /** Whether this pane is the active/visible tab of its group. Published to the
   *  nested viewers via `PaneVisibleContext`: display:none hides the pixels, but
   *  the standing work — the `file_mtime` auto-reload polls (an SFTP round trip
   *  each for a remote project), GIF playback — must stop too, or every hidden
   *  tab of every backgrounded project keeps paying it forever. */
  visible?: boolean;
  /** The subwindow (group) id hosting this pane, for proportional scroll-linking
   *  between two side-by-side viewer subwindows (see stores/viewers/scrollSync). Null/
   *  absent when the pane isn't in a syncable group; the sync hooks then no-op. */
  groupId?: string | null;
}

/**
 * Host for an in-app file viewer tab (TODO Group K #40). Unlike EmbedPane (which
 * opens the file in an external app), this renders the file's contents directly
 * inside the tab using a built-in viewer — independent of any external default
 * app:
 *   - "text"     → an editable code editor: a monospace textarea with a
 *                  line-number gutter, Tab/Shift+Tab indent, Ctrl+Shift+C
 *                  linewise comment toggle, and Ctrl+S save back to disk
 *                  (Python, Rust, JSON, config files, …).
 *   - "markdown" → rendered HTML via renderMarkdown, with an Edit/Preview toggle
 *                  that lets you edit the source and save it back to disk.
 *   - "yaml"     → YAML **and JSON** (which is YAML's flow syntax): the same
 *                  editor with a Tree/Source toggle, where the tree is an editable
 *                  structure view (rename a key, retype a value, add a key or a
 *                  list item, reorder, delete). It splices the file's own text, so
 *                  comments and layout survive, each collection keeps the style it
 *                  is written in (block or flow), and both modes share one draft.
 *   - "image"    → the bytes wrapped in a Blob URL, shown in a zoomable/pannable
 *                  <img> (wheel to zoom at cursor, drag to pan, Fit / 1:1).
 *   - "pdf"      → rendered with pdf.js into a scrolling stack of page canvases
 *                  with a zoom toolbar. Every surface is ours, so the surround
 *                  and scrollbar follow the app theme (a dark viewer in dark
 *                  themes); the pages render as authored.
 *   - "tex"      → the LaTeX viewer: the same code editor as "text", plus an
 *                  in-tab compile + PDF preview split when a TeX engine is on
 *                  PATH; it degrades to exactly the "text" editor otherwise.
 * An "Open externally" button is always offered as a fallback.
 */
export function FileViewerPane({ viewer, path, projectId, tabKey, visible = true, groupId }: Props) {
  const fileName = basename(path) || path;

  // The native presenter is experimental; with the flag off a deck opens as the
  // JSON it physically is. Read up here because the dispatch below sits after an
  // early return, and a hook cannot.
  const deckOn = useExperimental("deck_presenter");

  // A talk in progress withdraws this pane's marker/laser overlay — see the note
  // at the render below, and `stores/viewers/presentation` for why it is a store.
  const presenting = usePresentationStore((s) => s.presenting > 0);

  // Resolve whether these bytes are remote-native (host SFTP) or the local
  // mirror, and publish it to the tab strip so the Remote/Local badge rides on
  // this tab itself instead of costing a whole viewer header row (see the
  // fileSources store). Only remote (SSH) projects yield anything but "none";
  // the query is cheap (no file read) and re-runs when the path/scope changes.
  // The published entry is dropped when the viewer unmounts (tab closed).
  // `null` = not resolved yet; used by the disconnected-gate below to hold
  // rather than flash a red read error before we know the source.
  const [source, setSource] = useState<FileSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    fileSource(path, projectId)
      .then((s) => {
        if (cancelled) return;
        setSource(s);
      })
      .catch(() => {
        if (cancelled) return;
        setSource("none");
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId]);

  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));

  // A viewer tab is opened against one fixed absolute path (mirror OR host). For
  // a remote project this manual override lets the SAME tab show the other side
  // instead — same rel path, root swapped — without touching the tab's
  // persisted path. Session-only: resets to "no override" when the tab is
  // retargeted to a different file, so `effectiveSource` falls back to the file's
  // OWN resolved side (`source`, from `fileSource(path)`) — i.e. the side the
  // path already points at. That is the load-bearing default: `openFileEntry`
  // hands the viewer a *host* path when the tree that opened it was on Remote and
  // a *mirror* path when it was on Local, so trusting the path is what makes
  // "opened from a Remote listing ⇒ shown over SFTP" hold. Seeding instead from a
  // shared per-project pref (the old behaviour) let a stale/other-surface value
  // silently rewrite a host path back to the mirror — the Files-tab / subwindow
  // sidebar use an *independent* source that never writes that pref, so a file
  // opened there on Remote was read locally. `null` = follow the path.
  const [sideOverride, setSideOverride] = useState<"local" | "remote" | null>(null);
  useEffect(() => {
    setSideOverride(null);
  }, [path, projectId]);
  const rel = useMemo(() => autoSyncRel(project, path), [project, path]);
  const mirrorRoot = useMemo(() => localMirrorRootFor(project), [project]);
  const effectiveSource: FileSource = sideOverride ?? source ?? "none";
  const effectivePath = useMemo(() => {
    if (!project?.remote || !rel) return path;
    if (effectiveSource === "remote") return resolvePath(project.remote.remote_path, rel);
    if (effectiveSource === "local" && mirrorRoot) return resolvePath(mirrorRoot, rel);
    return path;
  }, [project, rel, effectiveSource, mirrorRoot, path]);

  useEffect(() => {
    if (tabKey) useFileSourcesStore.getState().setSource(tabKey, effectiveSource);
    return () => {
      if (tabKey) useFileSourcesStore.getState().clearSource(tabKey);
    };
  }, [tabKey, effectiveSource]);

  // Disconnected remote project: reading a remote-native (SFTP) file would block
  // on the dead pool and each nested viewer would flash its own red read error.
  // Instead show the SAME "Not connected" placeholder the remote shell uses, so
  // the message is unified across terminal and file tabs. Local-mirror files
  // (source "local") and local projects ("none") work offline and render as
  // usual; while the source is still unknown on a disconnected remote we hold.
  // Gated on the EFFECTIVE side, not the tab's opened side, so flipping the
  // switch to Remote while offline surfaces the same Connect prompt a
  // remote-native tab would — the toggle itself stays put (matches
  // ProjectFilesPane's `useFileSource`).
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const remoteDisconnected = !!project?.remote && sshState !== "connected";

  // Does this file exist on the host? A local-only file (never synced) has no
  // host counterpart, so flipping the Local/Remote switch to Remote would only
  // strand the viewer on an SFTP read error — disable that segment instead. Only
  // knowable on a live pool; disconnected / not-yet-probed leaves it enabled (the
  // disconnected gate above owns that case). One cheap SFTP stat per remote tab.
  const [remoteMissing, setRemoteMissing] = useState(false);
  const remoteRoot = project?.remote?.remote_path;
  useEffect(() => {
    setRemoteMissing(false);
    // `visible`: a hidden viewer needs no live switch state — without the gate,
    // every mounted viewer tab of every backgrounded remote project fired an
    // SFTP stat the moment the pool (re)connected. Re-shown, this re-runs and
    // probes once.
    if (!remoteRoot || !rel || sshState !== "connected" || !visible) return;
    let cancelled = false;
    fileMtime(resolvePath(remoteRoot, rel), projectId)
      .then(() => { if (!cancelled) setRemoteMissing(false); })
      .catch(() => { if (!cancelled) setRemoteMissing(true); });
    return () => { cancelled = true; };
  }, [remoteRoot, rel, sshState, projectId, visible]);
  // Mirror the Local/Remote switch out to the tab strip so its file-source badge
  // is a clickable toggle (not just a glyph): switching applies only when this
  // remote project's file has a counterpart on the other side (`rel`). Cleared
  // when it doesn't, and on unmount. Owns no state — `setSideOverride` stays here.
  useEffect(() => {
    if (!tabKey) return;
    const store = useFileSourcesStore.getState();
    if (project?.remote && rel) {
      store.setControls(tabKey, {
        current: effectiveSource === "remote" ? "remote" : "local",
        set: setSideOverride,
        remoteDisabled: remoteMissing,
      });
    } else {
      store.clearControls(tabKey);
    }
    return () => {
      if (tabKey) useFileSourcesStore.getState().clearControls(tabKey);
    };
  }, [tabKey, project?.remote, rel, effectiveSource, remoteMissing]);

  // A `.tex` tab that is really a WORKSPACE, healing itself (#tex-structure).
  // `viewer` is persisted, so a `.tex` opened as a bare editor before the
  // one-workspace-per-document policy — or by any path that still makes a plain
  // editor tab — comes back as a bare editor for ever: no structure sidebar, and
  // Ctrl+click on an `\input` scatters a new tab instead of switching the center.
  // Two conditions together say "this tab is a whole document, shown as a
  // fragment": nothing includes it (`resolveTexRoot` answers with itself) AND it
  // declares a `\documentclass`. The second is what keeps a DELIBERATE child
  // editor tab (a drop, a followed link) a plain editor when its parent has never
  // been compiled and so is in no root map — a fragment has no class line. The
  // store lookup confines the write to a real tab of this exact file, so a pane
  // rendering some other path never rewrites the tab it sits in.
  useEffect(() => {
    if (viewer !== "tex" || !tabKey) return;
    const tab = findTabByKey(useTabsStore.getState(), tabKey);
    if (!tab || tab.kind !== "embed" || tab.viewer !== "tex" || tab.embedPath !== path) return;
    let cancelled = false;
    void (async () => {
      const root = await resolveTexRoot(path);
      if (cancelled || root !== path) return;
      const text = await readFileText(path, projectId).catch(() => null);
      if (cancelled || text == null || !isTexDocumentRoot(text)) return;
      useTabsStore.getState().setTabViewer(tabKey, "texworkspace");
    })();
    return () => { cancelled = true; };
  }, [viewer, tabKey, path, projectId]);

  if (remoteDisconnected && effectiveSource !== "local" && effectiveSource !== "none") {
    return (
      <RemotePaneHold
        host={project?.remote?.host ?? ""}
        onConnect={() => { if (projectId) openRemoteMachines(projectId); }}
      />
    );
  }

  const openExternally = () => {
    useWindowsStore
      .getState()
      .openFile(effectivePath, undefined, projectId, "side_file_tree")
      .catch((e) => console.error(e));
  };

  // Pick the concrete viewer, then publish this pane's owning project as the file
  // scope so every nested viewer/hook confines its file commands to this project
  // (and its box siblings) regardless of which project is globally current.
  // Every viewer below reads `effectivePath` — the tab's own opened path unless
  // the Local/Remote switch has retargeted it to the same rel path's other root
  // — EXCEPT "diff"/"syncdiff", which already compare both sides directly and
  // whose single `path` prop means something else in that mode.
  let view: React.ReactNode;
  if (viewer === "gif") {
    // Animated GIFs get the frame-transport viewer (#gifviewer); the plain
    // image viewer remains its opt-out fallback (VIEWER_FALLBACK).
    view = <GifView path={effectivePath} fileName={fileName} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "image") {
    view = <ImageView path={effectivePath} fileName={fileName} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "pdf") {
    view = <PdfView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  } else if (viewer === "markdown") {
    view = <MarkdownView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  } else if (viewer === "tex") {
    view = <TexView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "texworkspace") {
    // The LaTeX workspace: one tab hosting a structure sidebar + a center that
    // switches between the TeX editor and the image viewer for the selected file.
    // The compiled PDF opens as its OWN tab (SyncTeX both ways still works — the
    // reveal/jump channels are path-keyed, so they cross tab and window). `mainPath`
    // is the EFFECTIVE path so children enumerate on the same side (host SFTP vs
    // local mirror) as the shown main — the workspace follows one side per tab.
    view = (
      <TexWorkspaceView
        mainPath={effectivePath}
        projectId={projectId}
        tabKey={tabKey}
        groupId={groupId}
        onOpenExternally={openExternally}
      />
    );
  } else if (viewer === "table") {
    view = <TableView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "notebook") {
    view = <NotebookView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "diff") {
    view = <DiffView path={path} projectId={projectId} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "syncdiff") {
    view = <DiffView path={path} projectId={projectId} mode="sync" onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "syncmerge") {
    view = <SyncMergeView path={path} projectId={projectId} tabKey={tabKey} />;
  } else if (viewer === "gitmerge") {
    view = <GitMergeView path={path} projectId={projectId} tabKey={tabKey} />;
  } else if (viewer === "odt") {
    view = <OdtView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "media") {
    view = <MediaView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "html") {
    // HTML is now the editable base editor with a sandboxed live preview, keyed
    // to its own per-type prefs.
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="html" groupId={groupId} />;
  } else if (viewer === "eldeck") {
    // The presenter is experimental. Gated HERE rather than in `naturalViewerFor`
    // so a deck still resolves to a viewer for drag-to-tab and the hover card; with
    // the flag off it opens as what it physically is — JSON — in the structure tree.
    view = deckOn ? (
      <DeckView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />
    ) : (
      <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="yaml" groupId={groupId} />
    );
  } else if (viewer === "sqlite") {
    view = <SqliteView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "yaml") {
    // YAML is the same base editor, with the structure tree as its "preview" half
    // (#yaml) and its own per-type prefs.
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="yaml" groupId={groupId} />;
  } else if (viewer === "bib") {
    // A `.bib` is the same base editor too, with the bibliography CARD list as its
    // "preview" half (see BibCards) — one card per entry, editing this very draft.
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="bib" groupId={groupId} />;
  } else {
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  }
  const sourceSwitch =
    project?.remote && rel
      ? {
          current: (effectiveSource === "remote" ? "remote" : "local") as "local" | "remote",
          onChange: setSideOverride,
          remoteDisabled: remoteMissing,
        }
      : null;
  return (
    <FileScopeContext.Provider value={projectId}>
      <PaneVisibleContext.Provider value={visible}>
      <ViewerHeaderInfoContext.Provider value={{ path: effectivePath, projectId, sourceSwitch }}>
        {/* A single relative host so the marker/laser presentation overlay can
            sit over ANY viewer without each one wiring it in (see
            PresentationOverlay). `.presentation-host` is height:100% so the
            existing `.file-viewer` (also 100%) fills it unchanged.

            Withdrawn while a deck presenter is on screen: the presenter renders
            through a portal *over* this pane and mounts its own overlay, so this
            one is invisible and inert — but its window-level Escape listener is
            not, and a second handler competing for Escape mid-talk is exactly
            what made holstering the laser end the talk (TODO V #98). */}
        <div className="presentation-host">
          {/* Fallback null: a lazy viewer's chunk loads in milliseconds off
              local disk, and any placeholder would flash for exactly that. */}
          {/* One boundary for every viewer (threat model row 28): a viewer that
              throws while rendering shows a card in this pane instead of
              unmounting the window. Reset when the file or viewer changes. */}
          <ViewerErrorBoundary
            resetKey={`${viewer}\u0000${effectivePath}`}
            sourcePath={TEXT_SOURCE_VIEWERS.has(viewer) ? effectivePath : null}
            projectId={projectId}
            onOpenExternally={NO_OPEN_EXTERNALLY_VIEWERS.has(viewer) ? null : openExternally}
          >
            <Suspense fallback={null}>{view}</Suspense>
          </ViewerErrorBoundary>
          {!presenting && <PresentationOverlay />}
        </div>
      </ViewerHeaderInfoContext.Provider>
      </PaneVisibleContext.Provider>
    </FileScopeContext.Provider>
  );
}

/** Viewers whose file is text, so the error boundary can offer it as plain
 *  source. Binary viewers (images, PDF, ODT, media, SQLite, spreadsheets) and
 *  the comparison views, whose `path` means something else, are left out. */
const TEXT_SOURCE_VIEWERS: ReadonlySet<InternalViewer> = new Set<InternalViewer>([
  "text", "markdown", "tex", "texworkspace", "html", "yaml", "bib", "eldeck", "notebook",
]);

/** Views whose header has no "Open externally" (the merge resolvers: their
 *  `path` names a conflict, not one file the OS should open), so the error
 *  boundary's card does not offer it either. */
const NO_OPEN_EXTERNALLY_VIEWERS: ReadonlySet<InternalViewer> = new Set<InternalViewer>([
  "syncmerge", "gitmerge",
]);

/** The file identity a `ViewerHeader` needs to offer file-scoped actions (the
 *  auto-sync toggle, the Local/Remote source switch) without every sub-viewer
 *  threading these props through. Set by `FileViewerPane`; `null` outside a
 *  viewer pane. `sourceSwitch` is `null` unless the open file resolves to a rel
 *  path under a remote project's mirror or host root (i.e. the other side could
 *  exist too). */
const ViewerHeaderInfoContext = createContext<{
  path: string;
  projectId: string | null;
  sourceSwitch?: {
    current: "local" | "remote";
    onChange: (s: "local" | "remote") => void;
    remoteDisabled?: boolean;
  } | null;
} | null>(null);

/** A remote project's local-mirror root, or `null` for a local project / one
 *  with no resolvable mirror. Shared by `autoSyncRel` and the Local/Remote
 *  switch's path-building — both need the exact same root. */
function localMirrorRootFor(
  project: ReturnType<typeof useProjectsStore.getState>["projects"][number] | undefined,
): string | null {
  if (!project?.remote) return null;
  const projectDir = resolveProjectDirectory(project);
  return resolveLocalMirror(project) ?? (projectDir ? `${projectDir}/mirror` : null);
}

/**
 * Resolve `absPath` to the project-relative path the sync backend keys on, for a
 * REMOTE project only (auto-sync doesn't apply to local projects). Handles both a
 * local-mirror file (under the mirror root) and a remote-native file (under the
 * host `remote_path`). Returns `null` when the project isn't remote or the path
 * lies outside both roots (so the toggle simply hides).
 */
function autoSyncRel(
  project: ReturnType<typeof useProjectsStore.getState>["projects"][number] | undefined,
  absPath: string,
): string | null {
  if (!project?.remote) return null;
  const mirrorRoot = localMirrorRootFor(project);
  if (mirrorRoot) {
    const r = relFromAbs(mirrorRoot, absPath);
    if (r) return r;
  }
  const r2 = relFromAbs(project.remote.remote_path, absPath);
  return r2 || null;
}

/**
 * Auto-sync indicator + toggle for the viewer header. Shown only for a file that
 * belongs to a remote project (either its mirror copy or its host copy). Reflects
 * and flips `SyncEntry::auto_sync` via the sync store; disabled while the remote is
 * disconnected (the backend engine can't act until reconnected).
 */
function AutoSyncHeaderToggle({ path, projectId }: { path: string; projectId: string | null }) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const rel = useMemo(() => autoSyncRel(project, path), [project, path]);
  const auto = useSyncStore((s) =>
    projectId && rel ? !!s.byProject[projectId]?.[rel]?.auto : false,
  );
  const setAuto = useSyncStore((s) => s.setAuto);
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  if (!project?.remote || !rel || !projectId) return null;
  const connected = sshState === "connected";
  return (
    <button
      type="button"
      className={`file-viewer-autosync${auto ? " on" : ""}`}
      title={
        !connected
          ? t("fileViewer.autoSyncConnectFirst")
          : auto
            ? t("fileViewer.autoSyncOnHint")
            : t("fileTree.autoSyncFile")
      }
      aria-label={auto ? t("fileViewer.stopAutoSyncFile") : t("fileTree.autoSyncFile")}
      aria-pressed={auto}
      disabled={!connected}
      onClick={() => void setAuto(projectId, [rel], !auto, false)}
    >
      ⟳
    </button>
  );
}

/**
 * "Resolve divergence" button for the viewer header, shown only when the open
 * file is currently **diverged (amber)** for a remote project. Opens the exact
 * same three-way merge resolver (`syncmerge` → `SyncMergeView`/`CompareView`) the
 * orange list opens, so the user can reconcile local mirror ⇄ host from the file
 * they are already looking at instead of hunting it down in the Orange view.
 *
 * The resolver keys on the **mirror-side** path (`mirrorRoot/rel`), exactly as the
 * orange list builds it, regardless of which side this viewer is currently showing.
 */
function SyncResolveHeaderButton({ path, projectId }: { path: string; projectId: string | null }) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const rel = useMemo(() => autoSyncRel(project, path), [project, path]);
  const mirrorRoot = useMemo(() => localMirrorRootFor(project), [project]);
  const amber = useSyncStore((s) =>
    projectId && rel ? s.byProject[projectId]?.[rel]?.state === "amber" : false,
  );
  if (!project?.remote || !rel || !projectId || !mirrorRoot || !amber) return null;
  const mirrorPath = resolvePath(mirrorRoot, rel);
  return (
    <button
      type="button"
      className="file-viewer-resolve"
      title={t("fileViewer.resolveDivergenceTitle")}
      aria-label={t("fileViewer.resolveDivergence")}
      onClick={() =>
        openLinkedFile(undefined, dirname(mirrorPath), {
          path: mirrorPath,
          viewer: "syncmerge",
          label: basename(mirrorPath),
        })
      }
    >
      ±
    </button>
  );
}

/**
 * Open `resolved` (a linked file) following the #50 routing rules: prefer a
 * session-only drag-set override group, else the SAME subwindow/group as the
 * linking tab, else the focused group (addTab default). Re-activates an existing
 * viewer tab for the same file instead of opening a duplicate.
 */
export function openLinkedFile(
  linkingTabKey: string | undefined,
  linkingFileDir: string,
  resolved: { path: string; viewer: InternalViewer; label: string; mdGraphOriginKey?: string },
) {
  const store = useTabsStore.getState();
  // A `.tex` editor tab that healed into a workspace (`FileViewerPane`) is
  // still this file's tab: matching only `viewer: "tex"` answered every later
  // open of that document with one more copy.
  const sameFile = (t: TabEntry) =>
    t.kind === "embed" &&
    t.embedPath === resolved.path &&
    (t.viewer === resolved.viewer || (resolved.viewer === "tex" && t.viewer === "texworkspace"));
  const tab = {
    label: resolved.label,
    cmd: "",
    cwd: linkingFileDir,
    kind: "embed" as const,
    embedPath: resolved.path,
    viewer: resolved.viewer,
    ...(resolved.mdGraphOriginKey ? { mdGraphOriginKey: resolved.mdGraphOriginKey } : {}),
  };
  // A linking tab of ANOTHER scope — a viewer in the root console, floating over
  // a project — opens its link beside itself, in its own scope's focused
  // subwindow (the one it was clicked in), not in the project underneath.
  const owner = linkingTabKey ? findTabByKey(store, linkingTabKey)?.scope : undefined;
  if (owner && owner !== store.scope) {
    openTabInScope(owner, tab, sameFile);
    return;
  }
  const prior = store.tabs.find(sameFile);
  if (prior) {
    store.setActive(prior.key);
    return;
  }

  // 1. A session-only override set by dragging this link to another subwindow.
  const override =
    linkingTabKey != null
      ? useLinkRoutingStore.getState().getRoute(linkingTabKey, resolved.path)
      : null;
  // 2. Otherwise the SAME group the linking tab lives in.
  const sameGroup =
    linkingTabKey != null
      ? findGroupOfTab(store.layout, linkingTabKey)?.group.id ?? null
      : null;
  const targetGroup = override ?? sameGroup;

  if (targetGroup) {
    // splitWithNewTab with "center" adds into the target group without splitting,
    // and returns null if the group no longer exists (then we fall back).
    const created = store.splitWithNewTab(tab, targetGroup, "center");
    if (created) {
      store.setActive(created.key);
      return;
    }
  }
  // Fallback: focused group (addTab default).
  const entry = store.addTab(tab);
  store.setActive(entry.key);
}

/** Resolve a markdown local-file href (relative/absolute/`file:`) to an absolute
 *  path against the directory of the markdown file `mdPath`. Drops any
 *  `?query`/`#fragment`, percent-decodes, and normalises `.`/`..` segments. The
 *  result keeps `mdPath`'s separator style, so it is correct on Windows (native
 *  backslashes + drive letter) as well as Unix. Returns null for an empty target. */
function resolveLocalHref(mdPath: string, href: string): string | null {
  let h = splitLineHint(href.trim()).href.replace(/[?#].*$/, "");
  if (!h) return null;
  if (/^file:\/\//i.test(h)) {
    const decoded = fromFileUri(h);
    return decoded ? normalizePath(decoded) : null;
  }
  try { h = decodeURIComponent(h); } catch { /* keep the raw href */ }
  return resolvePath(dirname(mdPath), h);
}

/** MIME type for inlining a local image into the markdown preview as a Blob URL.
 *  Raster formats render even from a typeless blob (the webview content-sniffs
 *  the magic bytes), but SVG is XML text the browser will NOT sniff as an image —
 *  an `<img>` only renders it when the blob is explicitly `image/svg+xml`. That's
 *  why an SVG in a doc (e.g. README's "At a glance" map) showed blank. We set the
 *  type for every known extension so all inlined images carry a correct MIME. */
function imageMimeForPath(p: string): string {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".bmp": return "image/bmp";
    case ".ico": return "image/x-icon";
    default: return "";
  }
}

/** The built-in viewer for a bare path (no FileEntry handy), used to route a
 *  SyncTeX source target. Defaults to the plain text editor (e.g. `.sty`). */
export function viewerForPath(path: string): InternalViewer {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : null;
  const entry: FileEntry = {
    name,
    path,
    is_dir: false,
    size: 0,
    extension: ext,
    mime: null,
  };
  return internalViewerFor(entry) ?? "text";
}

/** Tauri event carrying a reverse-search jump across the main/detached window
 *  boundary (#42). Only the main window listens; see {@link jumpToSource}. */
const SOURCE_JUMP_EVENT = "editor-source-jump";
interface SourceJumpEnvelope {
  input: string;
  line: number;
  column: number;
  /** The main `.tex` that produces the PDF (the clicked source's root). Used to
   *  route the opened source into the subwindow that already holds that main
   *  `.tex`. Absent, or unmatched in the receiving window (its tab isn't open
   *  there), falls back to the focused group — see {@link applySourceJump}. */
  anchorPath?: string;
}

/** The key of an open editor tab for `path` (any viewer), or undefined. Lets a
 *  reverse-search source route into the subwindow that already holds the
 *  producing main `.tex`, via {@link openLinkedFile}'s same-group rule. */
function tabKeyForPath(path: string): string | undefined {
  const store = useTabsStore.getState();
  const holds = (t: TabEntry) => t.kind === "embed" && t.embedPath === path;
  // The root console's tabs are on screen too while it floats; a PDF there
  // anchors its source into the console, not into the project underneath.
  return (
    store.tabs.find(holds)?.key ??
    (useRootOverlayStore.getState().open
      ? store.tabsByScope[ROOT_SCOPE]?.find(holds)?.key
      : undefined)
  );
}

/** True when this webview is the MAIN window (no `?detached=` param) — the one
 *  that owns the full tab layout and is the canonical place to open source files
 *  for reverse search. */
function isMainWindow(): boolean {
  try {
    return parseDetachedParam(window.location.search) === null;
  } catch {
    return true;
  }
}

/** A `.tex` source may be owned by an open TeX workspace tab (which hosts its
 *  editor in-tab, the PDF being a separate tab). */
function isTexSource(path: string): boolean {
  return /\.tex$/i.test(path);
}

/**
 * Route a reverse-search jump into an already-open TeX workspace when one owns
 * the source, and report whether it did. On a hit it focuses the workspace and
 * switches its center to `input` ({@link focusTexWorkspaceForSource}) and posts
 * the scroll to the editor-jump store; `fallback` runs only when no workspace
 * owns the file. Non-`.tex` sources skip straight to the fallback.
 *
 * This has to run BEFORE the standalone `hasMountedEditor`/tab probes: a
 * workspace child sits mounted-but-hidden in the LRU, so it already satisfies
 * `hasMountedEditor` and a bare `requestJump` would scroll an invisible pane
 * instead of switching the center to it.
 */
function routeSourceJump(
  input: string,
  line: number,
  column: number,
  fallback: () => void,
) {
  if (!isTexSource(input)) {
    fallback();
    return;
  }
  focusTexWorkspaceForSource(input)
    .then((handled) => {
      if (handled) useEditorJumpStore.getState().requestJump(input, line, column);
      else fallback();
    })
    .catch(() => fallback());
}

/** Open/re-activate the source tab in THIS window and post the editor jump to its
 *  local editorJump store. The standalone (non-workspace) half of
 *  {@link jumpToSource}. `anchorPath` is the main `.tex` that produces the PDF:
 *  when the source is not already open, the new editor tab opens in the subwindow
 *  that already holds that main `.tex` (resolved to its tab here, so the group
 *  lookup runs in the window that owns the layout) rather than in whichever group
 *  happens to be focused. */
function openStandaloneSourceTab(input: string, line: number, column: number, anchorPath?: string) {
  const dir = dirname(input) || "/";
  const label = basename(input);
  const linkingTabKey = anchorPath ? tabKeyForPath(anchorPath) : undefined;
  openLinkedFile(linkingTabKey, dir, { path: input, viewer: viewerForPath(input), label });
  useEditorJumpStore.getState().requestJump(input, line, column);
}

/** Handle a reverse-search jump in THIS window: into an open TeX workspace when
 *  one owns the source, else open/focus the standalone source tab. The local half
 *  of {@link jumpToSource}, and what {@link listenSourceJump} runs for a jump
 *  broadcast from a detached PDF window. */
function applySourceJump(input: string, line: number, column: number, anchorPath?: string) {
  routeSourceJump(input, line, column, () =>
    openStandaloneSourceTab(input, line, column, anchorPath),
  );
}

/**
 * SyncTeX reverse search lands here: open (or re-activate) the source file's
 * editor tab and ask it to scroll to `line`/`column`. The editor
 * (`TexView`/`TextView`) for that path consumes the request via the editorJump
 * store, since the tab may already be open and won't remount.
 *
 * #42 cross-window: the PDF may be popped out into a detached window, either on
 * its own (source editor docked in the main window) or alongside the source in a
 * split view. Decide where to run the jump:
 *  - The source editor is already mounted in THIS window (e.g. a split PDF|TeX,
 *    possibly popped out) → just scroll it. This is the path a detached window
 *    must take, because its React-rendered tabs never populate `useTabsStore`,
 *    so a tab-store probe alone would wrongly report "not open" and delegate to
 *    the main window, where the editor isn't.
 *  - This window already has the source as a (possibly background) tab, or this
 *    IS the main window → open/focus it here.
 *  - Otherwise (detached window without the source) → broadcast to the main
 *    window, which owns the editor layout (it registers {@link listenSourceJump}).
 * `requestJump` itself broadcasts cross-window, so the scroll reaches the editor
 * wherever it is mounted regardless of which branch opens/focuses the tab.
 *
 * `anchorPath` is the main `.tex` that produces the PDF (the clicked source's
 * root). When the source file has no tab yet, the new editor opens in the
 * subwindow that already holds that main `.tex`, rather than whichever group
 * happens to be focused.
 */
export function jumpToSource(input: string, line: number, column = 0, anchorPath?: string) {
  // A `.tex` source owned by an open workspace is centered there first (in this
  // window, or wherever the workspace lives — the store write reaches it); only a
  // source no workspace owns falls through to the standalone routing below.
  routeSourceJump(input, line, column, () =>
    jumpToStandaloneSource(input, line, column, anchorPath),
  );
}

/** The standalone (non-workspace) reverse-search routing: scroll an already-open
 *  editor, open/focus the source tab here, or delegate to the main window. */
function jumpToStandaloneSource(input: string, line: number, column: number, anchorPath?: string) {
  if (hasMountedEditor(input)) {
    useEditorJumpStore.getState().requestJump(input, line, column);
    return;
  }
  const viewer = viewerForPath(input);
  const hasTab = useTabsStore
    .getState()
    .tabs.some((t) => t.kind === "embed" && t.viewer === viewer && t.embedPath === input);
  if (hasTab || isMainWindow()) {
    openStandaloneSourceTab(input, line, column, anchorPath);
    return;
  }
  // Detached window without the source tab: ask the main window to handle it.
  try {
    emit(SOURCE_JUMP_EVENT, { input, line, column, anchorPath } satisfies SourceJumpEnvelope)
      .catch(() => {});
  } catch {
    /* no Tauri event bus available */
  }
}

/**
 * MAIN window: listen for reverse-search jumps broadcast from a detached PDF
 * window and run them here (open/focus the source tab + scroll the caret).
 * Register once at startup; returns an unlisten. No-op outside Tauri. Detached
 * windows never register this — they either handle a jump locally (they own the
 * source tab) or delegate to the main window via {@link jumpToSource}.
 */
export async function listenSourceJump(): Promise<() => void> {
  try {
    return await listen<SourceJumpEnvelope>(SOURCE_JUMP_EVENT, (ev) => {
      const { input, line, column, anchorPath } = ev.payload;
      applySourceJump(input, line, column, anchorPath);
    });
  } catch {
    return () => {};
  }
}

export function ViewerHeader({
  onOpenExternally,
  children,
}: {
  onOpenExternally: () => void;
  children?: React.ReactNode;
}) {
  // No filename label: the tab already shows it. The spacer keeps the controls
  // and the open-externally icon pushed to the trailing edge. The remote/local
  // source badge no longer lives here — it rides on the tab itself (see
  // TabBar's tab-source badge), so it costs no header row. The auto-sync toggle
  // and the Local/Remote source switch (both remote projects only) ride in from
  // context so no sub-viewer has to pass them.
  const t = useT();
  const info = useContext(ViewerHeaderInfoContext);
  return (
    <div className="file-viewer-header">
      <div className="file-viewer-header-spacer" aria-hidden="true" />
      {children}
      {info?.sourceSwitch && (
        <FileSourceSwitch
          source={info.sourceSwitch.current}
          onChange={info.sourceSwitch.onChange}
          remoteDisabled={info.sourceSwitch.remoteDisabled}
        />
      )}
      {info && <SyncResolveHeaderButton path={info.path} projectId={info.projectId} />}
      {info && <AutoSyncHeaderToggle path={info.path} projectId={info.projectId} />}
      <button
        className="file-viewer-open-external"
        onClick={onOpenExternally}
        title={t("pdfViewer.openExternalTitle")}
        aria-label={t("pdfViewer.openExternalTitle")}
      >
        <ArrowUpRightIcon />
      </button>
    </div>
  );
}

// ── Undo/redo history (#46) ──────────────────────────────────────────────────

/** Edit-history state: a stack of past values, the present value, and a redo
 *  stack of future values. Pure so it can be unit-tested without React. */
/** Imperative editing surface exposed by {@link CodeEditor} via `editorApiRef`,
 *  letting a toolbar transform the live value+selection. */
export interface EditorApi {
  /** Run `fn` over the current value and selection `[start, end)`, commit the
   *  result through the editor's normal edit path, and restore the returned
   *  selection. */
  applyEdit: (fn: (value: string, start: number, end: number) => EditResult) => void;
}

export interface EditHistory {
  past: string[];
  present: string;
  future: string[];
}

export type EditAction =
  | { type: "set"; value: string; coalesce?: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; value: string };

/** Cap so a long editing session can't grow the undo stack without bound. */
const HISTORY_LIMIT = 200;

/**
 * Pure reducer for the editor undo/redo history (#46). A "set" pushes the prior
 * present onto `past` and clears `future`, unless `coalesce` is true (rapid
 * keystrokes) — then it replaces the present in place so a burst of typing
 * collapses into one undo step. "reset" seeds a fresh baseline (file (re)load)
 * with empty stacks.
 */
export function editHistoryReducer(state: EditHistory, action: EditAction): EditHistory {
  switch (action.type) {
    case "set": {
      if (action.value === state.present) return state;
      if (action.coalesce) {
        return { ...state, present: action.value, future: [] };
      }
      const past = [...state.past, state.present];
      if (past.length > HISTORY_LIMIT) past.shift();
      return { past, present: action.value, future: [] };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: prev,
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
      };
    }
    case "reset":
      return { past: [], present: action.value, future: [] };
    default:
      return state;
  }
}

// Coalesce keystrokes within this window into a single undo step.
const COALESCE_MS = 400;

// #45 automatic autocomplete: idle time after the last keystroke before a
// suggestion is requested for the focused editor. Long enough not to fire on
// every keystroke, short enough to feel responsive.
const AUTO_AC_DEBOUNCE_MS = 600;

// Dictionary spell check (the Hunspell `spell_check` command): idle time after
// the last keystroke before the draft is re-checked. A lookup, not a model call.
const SPELL_DEBOUNCE_MS = 800;

// #45 completion-length modes. Cycle order for the live Shift+Tab toggle (while
// a ghost suggestion is showing) and human labels for the status line / settings
// dropdown. Kept in sync with the Rust `CompletionMode`.
const AC_MODES: AutocompleteMode[] = ["sentence", "block", "scope"];
/** Next mode in the cycle (wraps), for the live Shift+Tab toggle. */
function nextAcMode(m: AutocompleteMode): AutocompleteMode {
  return AC_MODES[(AC_MODES.indexOf(m) + 1) % AC_MODES.length];
}
/** Human label for a completion-length mode, shared by the live status line and
 *  the settings dropdown. A pure helper (not a component), so it takes `t` as an
 *  explicit parameter — mirrors `TableView.tsx`'s `delimiterLabel`. */
function acModeLabel(m: AutocompleteMode, t: ReturnType<typeof useT>): string {
  if (m === "sentence") return t("projectSettings.sentence");
  if (m === "block") return t("projectSettings.block");
  return t("projectSettings.scope");
}

/** React wrapper over `editHistoryReducer` exposing `value`, a coalescing
 *  `setValue`, `undo`/`redo` (+ availability), and `reset`. */
function useEditHistory(initial: string) {
  const [hist, dispatch] = useReducer(editHistoryReducer, {
    past: [],
    present: initial,
    future: [],
  } as EditHistory);
  const lastEditAt = useRef(0);

  const setValue = useCallback((value: string) => {
    const now = Date.now();
    const coalesce = now - lastEditAt.current < COALESCE_MS;
    lastEditAt.current = now;
    dispatch({ type: "set", value, coalesce });
  }, []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const reset = useCallback((value: string) => {
    lastEditAt.current = 0;
    dispatch({ type: "reset", value });
  }, []);

  return {
    value: hist.present,
    setValue,
    undo,
    redo,
    reset,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
  };
}

// Poll interval for the diff-aware auto-reload (#43), ~1.5s.
const RELOAD_POLL_MS = 1500;

/** How long Source-mode typing in a YAML/JSON file must pause before the Cards
 *  toggle re-asks whether the file nests anything to card (a whole-file parse). */
const GRID_PROBE_SETTLE_MS = 400;

/**
 * Editable-file state shared by the editable viewers — the code and markdown
 * editors, and the table viewer, whose cell edits are splices into this same
 * text draft (see `lib/viewers/table.ts`): loads `path`, keeps a `draft` against
 * the last-known-on-disk `baseline` (so "dirty" is just draft !== baseline), and
 * writes the draft back via write_file_text — re-seeding the baseline on success
 * so the dirty flag clears without re-reading the file.
 *
 * Adds (Group M):
 *  - #46 undo/redo: the draft is backed by `useEditHistory`; `undo`/`redo` are
 *    surfaced for keybindings + toolbar buttons.
 *  - #47 autosave: when `settings.autosave` is on, a dirty buffer is saved after
 *    400 ms idle, with a 2-second maximum scheduling delay and serialized writes.
 *  - #43 diff-aware reload: polls `file_mtime`; when the file changes on disk it
 *    silently re-reads into a clean buffer, or surfaces a non-destructive banner
 *    when the buffer is dirty (Reload / Keep mine) — never clobbering edits.
 */
export function useEditableFile(path: string, enabled = true) {
  const scope = useFileScope();
  const t = useT();
  const paneVisible = usePaneVisible();
  // Widens the reload poll below while this window is unfocused (or Energy
  // Saver is on), the same way every other always-on timer site does.
  const quiesce = useQuiesce();
  const loadedIdentity = useRef<string | null>(null);
  const identity = JSON.stringify([path, scope]);
  const [content, setContent] = useState<string | null>(null);
  // The failure is held as a translation KEY, not a sentence: the read effects
  // must not depend on `t` (a language flip would re-run them and discard an
  // unsaved draft), and holding the key makes the message follow the language.
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const error = errorKey ? t(errorKey) : null;
  const [baseline, setBaseline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // True when disk changed under a dirty buffer; the viewer shows a banner.
  const [externalChange, setExternalChange] = useState(false);

  const { value: draft, setValue: setDraftValue, undo, redo, reset, canUndo, canRedo } =
    useEditHistory("");

  // mtime we last saw on disk, to detect external writes (#43). Our own saves
  // bump it so they don't trip the watcher.
  const lastMtime = useRef<number | null>(null);

  // The line ending the FILE uses, remembered at load and re-applied at save.
  //
  // It has to be remembered, because the draft cannot carry it: the editor is a
  // `<textarea>` and `onTextChange` reads `el.value`, whose API value the HTML
  // spec normalizes to LF. So the first keystroke anywhere in a CRLF file
  // silently rewrote EVERY line ending in the buffer and the save wrote LF
  // throughout — a one-character edit producing a whole-file diff, in every text
  // viewer at once (md, tex, yaml, .bib, code). That also broke the promise the
  // structured viewers are built on: `yaml.ts`, `table.ts` and `bib.ts` each
  // derive the file's ending from the buffer and splice it back, so on a CRLF
  // file they wrote CRLF into a buffer that turned LF underneath them and the
  // result was MIXED endings.
  //
  // The buffer is therefore LF by construction — seeded normalized, so every
  // parser and splice above sees one convention — and the ending is restored on
  // the way out, at the single place bytes leave this hook.
  const fileEol = useRef<"\r\n" | "\n">("\n");

  // Autosave is ON by default; only an explicit `autosave: false` disables it.
  const autosave = useSettingsStore((s) => s.settings?.autosave !== false);

  // setDraft seeds history when typing; reset is used for (re)loads from disk.
  const setDraft = setDraftValue;

  const seedFromDisk = useCallback(
    (text: string) => {
      // Record the file's own ending, then hold the buffer in LF (see `fileEol`).
      // A file with no CRLF at all is LF, which is also the right default for an
      // empty one. Mixed endings resolve to CRLF, the same "any CRLF ⇒ CRLF" rule
      // `bib.ts`'s `lineEndingOf` and `table.ts` already follow.
      fileEol.current = lineEndingOf(text);
      const lf = applyLineEnding(text, "\n");
      reset(lf);
      setBaseline(lf);
      setContent(lf);
      setExternalChange(false);
    },
    [reset],
  );

  // Initial load + mtime baseline.
  useEffect(() => {
    let cancelled = false;
    loadedIdentity.current = null;
    setSaving(false);
    setSaveError(null);
    setContent(null);
    setErrorKey(null);
    setBaseline(null);
    setExternalChange(false);
    lastMtime.current = null;
    if (!enabled) return;
    readFileText(path, scope)
      .then((text) => {
        if (cancelled) return;
        loadedIdentity.current = identity;
        seedFromDisk(text);
      })
      .catch((e) => { if (!cancelled) setErrorKey(describeFileErrorKey(e)); });
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope, seedFromDisk, enabled, identity]);

  const loaded = content != null && loadedIdentity.current === identity;
  const isDirty = loaded && baseline != null && draft !== baseline;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  // The poll's `.then` closes over the render that armed it, so the baseline is
  // read through a ref — same reason `isDirtyRef` exists beside it.
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  const saver = useMemo(() => new DraftSaver(async (text) => {
    // The ONE place a text buffer leaves this hook, and therefore the one place
    // the file's own line ending is restored (see `fileEol`). `\r?\n` rather than
    // `\n` so this is idempotent: a buffer that still holds CRLF — the seed,
    // before any keystroke has been through the textarea — is not doubled into
    // `\r\r\n`.
    await writeFileText(path, applyLineEnding(text, fileEol.current), scope);
    if (scope && basename(path).toLowerCase() === "remarks.md") {
      const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
      if (project) await useProjectRemarksStore.getState().load(scope, resolveProjectDirectory(project));
    }
  }), [path, scope]);
  useEffect(() => {
    let active = true;
    saver.onSaved = (text) => {
      if (!active) return;
      setBaseline(text);
      setExternalChange(false);
      void fileMtime(path, scope).then((m) => {
        if (active) lastMtime.current = m;
      }).catch(() => {});
    };
    saver.onStatus = (busy, error) => {
      if (active) { setSaving(busy); setSaveError(error); }
    };
    // A popout closed by a Wayland scope-out asks this before it goes.
    const unregister = registerUnsavedWork({
      dirty: () => saver.dirty,
      flush: () => saver.flushIfAutosave(),
    });
    return () => {
      active = false;
      unregister();
      saver.dispose();
    };
  }, [saver, path, scope]);
  useEffect(() => {
    saver.update(draft, baseline, loaded && enabled, autosave);
  }, [saver, draft, baseline, loaded, enabled, autosave]);
  const save = useCallback(() => saver.flush(), [saver]);

  // #43 diff-aware reload: poll mtime; on an external advance, re-read into a
  // clean buffer silently, or flag a banner if the buffer is dirty. Only while
  // the pane is on screen — every tab of every scope stays mounted, so a hidden
  // viewer's poll would otherwise run forever (an SFTP round trip per tick for a
  // remote project). The immediate check on re-show catches whatever changed on
  // disk while the pane was hidden, against the baseline seeded at load time.
  // While the window is unfocused the poll is widened, not stopped: a viewer
  // left open on a second screen as a live preview of a file edited in another
  // app must still follow it. `quiesce` is a dependency, so regaining focus
  // re-runs the effect — whose immediate `check()` is the catch-up.
  useEffect(() => {
    if (!loaded || !paneVisible) return;
    let cancelled = false;
    const check = () => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null) return;
          if (m <= lastMtime.current) return;
          lastMtime.current = m;
          if (isDirtyRef.current) {
            // Don't clobber unsaved edits — surface a reconcile banner.
            setExternalChange(true);
            return;
          }
          // Clean buffer → silently re-read + reseed baseline/draft.
          //
          // …but NOT when the bytes are the ones already in the buffer. An mtime
          // advance is not a content change: a latexmk run that rewrote an
          // identical file, a `touch`, a formatter that made no difference, a
          // checkout of the same content all land here, and `seedFromDisk`
          // `reset()`s the history — clearing `past` AND `future`. So an
          // untouched recompile in the background silently threw away the
          // reader's whole undo stack, with nothing on screen to say it had
          // happened. The banner case at least asks; this one never did.
          //
          // The comparison is made in BUFFER space, not against the raw bytes:
          // the draft is LF by construction (see `fileEol`), so a CRLF file read
          // back from disk would never compare equal and the skip would never
          // fire on exactly the platform that needs it.
          readFileText(path, scope)
            .then((text) => {
              if (cancelled || isDirtyRef.current) return;
              if (applyLineEnding(text, "\n") === baselineRef.current) return;
              seedFromDisk(text);
            })
            .catch(() => {});
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, saverInterval(RELOAD_POLL_MS, quiesce));
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, loaded, paneVisible, seedFromDisk, quiesce]);

  // Banner actions (#43): take the disk version, or keep mine (dismiss banner +
  // adopt current mtime so the next external change re-triggers).
  const reloadFromDisk = useCallback(() => {
    readFileText(path, scope)
      .then((text) => { if (loadedIdentity.current === identity) seedFromDisk(text); })
      .catch((e) => { if (loadedIdentity.current === identity) setSaveError(String(e)); });
  }, [path, scope, seedFromDisk, identity]);
  const keepMine = useCallback(() => setExternalChange(false), []);

  return {
    content, error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo,
    externalChange, reloadFromDisk, keepMine,
  };
}

/** The non-destructive external-change banner (#43). */
export function ExternalChangeBanner({
  onReload,
  onKeep,
}: {
  onReload: () => void;
  onKeep: () => void;
}) {
  const t = useT();
  return (
    <div className="file-viewer-reload-banner" role="alert">
      <span>{t("fileViewer.externalChangeMsg")}</span>
      <button className="file-viewer-reload-btn" onClick={onReload}>{t("common.reload")}</button>
      <button className="file-viewer-reload-btn" onClick={onKeep}>{t("fileViewer.keepMine")}</button>
    </div>
  );
}

const INDENT = "    "; // 4 spaces — what Tab inserts and Shift+Tab strips.

/** Apply Tab / Shift+Tab indentation to a code textarea, preserving selection.
 *  Returns the next value + selection, or null to let the key fall through. */
export function applyIndent(
  el: HTMLTextAreaElement,
  outdent: boolean,
): { value: string; selStart: number; selEnd: number } | null {
  const { value, selectionStart: start, selectionEnd: end } = el;
  const multiLine = value.slice(start, end).includes("\n");

  // Plain Tab with no multi-line selection → insert one indent at the caret.
  if (!outdent && !multiLine) {
    const value2 = value.slice(0, start) + INDENT + value.slice(end);
    const caret = start + INDENT.length;
    return { value: value2, selStart: caret, selEnd: caret };
  }

  // Otherwise operate on every line the selection touches.
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const block = value.slice(lineStart, end);
  const lines = block.split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines
    .map((line, i) => {
      if (outdent) {
        // Strip up to one indent's worth of leading whitespace (a full INDENT,
        // else whatever leading spaces/tabs exist, capped at INDENT width).
        const lead = line.match(/^[ \t]+/)?.[0].length ?? 0;
        const strip = line.startsWith(INDENT)
          ? INDENT.length
          : Math.min(lead, INDENT.length);
        if (strip > 0) {
          if (i === 0) firstDelta = -strip;
          totalDelta -= strip;
          return line.slice(strip);
        }
        return line;
      }
      if (i === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
      return INDENT + line;
    })
    .join("\n");

  const value2 = value.slice(0, lineStart) + next + value.slice(end);
  return {
    value: value2,
    selStart: Math.max(lineStart, start + firstDelta),
    selEnd: end + totalDelta,
  };
}

/** Advance across the closing brace of a TeX argument. This is deliberately a
 * narrow Tab-stop: it applies only to a collapsed caret immediately before `}`;
 * selections and ordinary source indentation retain their usual Tab behaviour.
 */
export function advanceTexBraceTabStop(el: HTMLTextAreaElement): number | null {
  const { value, selectionStart: start, selectionEnd: end } = el;
  return start === end && value[start] === "}" ? start + 1 : null;
}

/**
 * Toggle line comments over every line the selection touches (Ctrl+Shift+C),
 * using `marker` — `%` in a `.tex` file, `//`, `#`, … elsewhere. Returns the next
 * value + selection, or null when there is nothing to toggle.
 *
 * Comment or uncomment is decided by what is already there: the block
 * UNcomments only when every non-blank line it covers is already commented, so a
 * partially-commented block commutes to fully commented first (the same rule the
 * common editors use — pressing twice always round-trips). Commenting inserts at
 * the block's shallowest indent so relative indentation survives, and skips
 * blank lines rather than leaving stranded markers; uncommenting drops the
 * marker plus at most one following space, so `% x` → `x` while `%% x` keeps the
 * second percent — a deliberate double-comment is not this gesture's to undo.
 */
export function applyLineComment(
  el: HTMLTextAreaElement,
  marker: string,
): { value: string; selStart: number; selEnd: number } | null {
  if (!marker) return null;
  const { value, selectionStart: start, selectionEnd: end } = el;
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // A selection ending exactly at a line start stops at the newline before it —
  // it does not reach into the line it merely touches with its tail.
  const probe = end > start ? end - 1 : end;
  const nl = value.indexOf("\n", probe);
  const to = nl === -1 ? value.length : nl;

  const lines = value.slice(from, to).split("\n");
  const blank = (line: string) => line.trim() === "";
  // A selection of nothing but blank lines still comments them — there is no
  // "meaningful" line to skip in favour of.
  const skipBlanks = lines.some((line) => !blank(line));
  const body = skipBlanks ? lines.filter((line) => !blank(line)) : lines;
  const uncomment = body.every((line) => line.trimStart().startsWith(marker));
  const col = uncomment
    ? 0
    : Math.min(...body.map((line) => line.length - line.trimStart().length));

  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines
    .map((line, i) => {
      if (skipBlanks && blank(line)) return line;
      if (uncomment) {
        const at = line.indexOf(marker);
        const after = at + marker.length;
        const drop = marker.length + (line[after] === " " ? 1 : 0);
        if (i === 0) firstDelta = -drop;
        totalDelta -= drop;
        return line.slice(0, at) + line.slice(at + drop);
      }
      const add = marker.length + 1;
      if (i === 0) firstDelta = add;
      totalDelta += add;
      return line.slice(0, col) + marker + " " + line.slice(col);
    })
    .join("\n");

  if (totalDelta === 0) return null;
  return {
    value: value.slice(0, from) + next + value.slice(to),
    selStart: Math.max(from, start + firstDelta),
    selEnd: Math.max(from, end + totalDelta),
  };
}

/** The one HTML escaper (`lib/viewers/highlight`, §9.2), under the name this
 *  file's overlay builders and their importers (odt, notebook) already use. */
export const escapeHtmlText = escapeHtml;

/** How wide a tab renders in the editor and every overlay layer — `tab-size: 4`
 *  in `viewers.css`. Column arithmetic here has to agree with what the reader
 *  sees, so the two are one number and this comment is the link between them. */
const TAB_WIDTH = 4;

/** One indentation level, as the file itself writes it. */
export interface IndentUnit {
  /** The characters one level is made of — `"  "`, `"    "`, `"\t"`. */
  text: string;
  /** How many columns that is, once tabs are expanded. */
  width: number;
}

/** What a file with nothing to learn from indents by, and what the Tab key
 *  writes (see {@link INDENT}). */
const DEFAULT_INDENT_UNIT: IndentUnit = { text: INDENT, width: INDENT.length };

/** How far into a file the unit is sampled from. A file indents the same way
 *  throughout or it has no unit worth finding, so reading all of a 40k-line
 *  generated JSON on every keystroke buys nothing. */
const INDENT_SAMPLE_LINES = 2000;

/**
 * How much one indentation level is worth **in this file** — read out of the
 * text rather than assumed, because the editor's own 4 spaces are a house style
 * and the file being edited is somebody else's.
 *
 * Measured as the step between successive lines' indentation (the way an editor
 * infers it): a run of `0, 4, 8` says four, `0, 2, 4` says two. Only 2/3/4/8 are
 * admitted — every other step is a continuation line or a wrapped argument list,
 * not a level — and a file whose lines lead with tabs is a tab file whatever
 * those steps say, since one tab is one level by definition. Falls back to the
 * editor's own {@link INDENT} when the text says nothing.
 */
export function detectIndentUnit(source: string): IndentUnit {
  let tabbed = 0;
  let spaced = 0;
  const steps = new Map<number, number>();
  let prev = -1;
  let seen = 0;
  let i = 0;
  for (;;) {
    if (seen >= INDENT_SAMPLE_LINES) break;
    const nl = source.indexOf("\n", i);
    const to = nl < 0 ? source.length : nl;
    let width = 0;
    let sawTab = false;
    let j = i;
    for (; j < to; j++) {
      const ch = source[j];
      if (ch === "\t") {
        sawTab = true;
        width += TAB_WIDTH - (width % TAB_WIDTH);
      } else if (ch === " ") {
        width += 1;
      } else break;
    }
    // A blank line has no indentation to speak of and must not break the run:
    // it neither votes nor resets `prev`.
    if (j < to) {
      if (width > 0) {
        if (sawTab) tabbed++;
        else spaced++;
      }
      if (prev >= 0 && width > prev) {
        const step = width - prev;
        if (step === 2 || step === 3 || step === 4 || step === 8) {
          steps.set(step, (steps.get(step) ?? 0) + 1);
        }
      }
      prev = width;
    }
    seen++;
    if (nl < 0) break;
    i = nl + 1;
  }
  if (tabbed > spaced) return { text: "\t", width: TAB_WIDTH };
  let best = 0;
  let bestCount = 0;
  for (const [step, count] of steps) {
    // Ties go to the narrower step: `0, 4, 8` is also two steps of two, and the
    // finer reading is the one that draws a guide at every level that exists.
    if (count > bestCount || (count === bestCount && step < best)) {
      best = step;
      bestCount = count;
    }
  }
  return best > 0 ? { text: " ".repeat(best), width: best } : DEFAULT_INDENT_UNIT;
}

/** The column `pos` sits at on its own line, tabs expanded to the next
 *  {@link TAB_WIDTH} stop — the advance the monospace layers actually paint. */
function columnAt(source: string, pos: number): number {
  const from = source.lastIndexOf("\n", pos - 1) + 1;
  let col = 0;
  for (let i = from; i < pos; i++) {
    col += source[i] === "\t" ? TAB_WIDTH - (col % TAB_WIDTH) : 1;
  }
  return col;
}

/** The leading whitespace of the line `pos` sits on. */
function lineIndentAt(source: string, pos: number): string {
  const from = source.lastIndexOf("\n", pos - 1) + 1;
  let i = from;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(from, i);
}

/** One indentation level off the end of `lead`, never past column 0. */
function dedentOnce(lead: string, unit: IndentUnit): string {
  if (unit.text === "\t") return lead.endsWith("\t") ? lead.slice(0, -1) : lead;
  return lead.length >= unit.width ? lead.slice(0, lead.length - unit.width) : "";
}

/** The rest of `from`'s line, minus a trailing `#` comment — what decides
 *  whether an open bracket has arguments on its own line to align under. */
function pyCodeAfter(source: string, from: number): string {
  const nl = source.indexOf("\n", from);
  const line = source.slice(from, nl < 0 ? source.length : nl);
  const hash = line.indexOf("#");
  return hash < 0 ? line : line.slice(0, hash);
}

/** `line` up to the `%` that starts its comment (a `\%` is a percent sign, not
 *  a comment) — TeX's equivalent of {@link pyCodeAfter}. */
function texCodePrefix(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "%") return line.slice(0, i);
  }
  return line;
}

/**
 * What Python's Enter needs to know at `caret`: whether it lands inside a string
 * literal (where the text is data and nothing should be inferred from it), which
 * brackets are still open in front of it (implicit line continuation — the
 * openers can be lines above, which is why this scans from the top rather than
 * from the caret's own line), and the caret's own line with strings and comments
 * blanked out, so a trailing `:` is only read when it really is one.
 *
 * A lexer, not a parser — the buffer under an editing caret is regularly not
 * valid Python, and an unterminated literal is its normal state.
 */
function pythonIndentState(
  source: string,
  caret: number,
): { inString: boolean; openers: number[]; lineCode: string } {
  const openers: number[] = [];
  let lineCode = "";
  let i = 0;
  while (i < caret) {
    const c = source[i];
    if (c === "\n") {
      lineCode = "";
      i++;
      continue;
    }
    if (c === "#") {
      while (i < caret && source[i] !== "\n") {
        lineCode += " ";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const to = pythonStringEnd(source, i);
      if (to > caret) return { inString: true, openers, lineCode };
      for (let j = i; j < to; j++) {
        // A triple-quoted literal spans lines, and the line the caret is on is
        // still the one after the last newline inside it.
        lineCode = source[j] === "\n" ? "" : lineCode + " ";
      }
      i = to;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") openers.push(i);
    else if (c === ")" || c === "]" || c === "}") openers.pop();
    lineCode += c;
    i++;
  }
  return { inString: false, openers, lineCode };
}

/** The languages whose Enter is aligned rather than dropped to column 0. Both
 *  put their structure in the indentation, and both have a block opener the next
 *  line is expected to sit inside; every other language keeps the plain
 *  newline the engine writes. */
const AUTO_INDENT_LANGS: ReadonlySet<Lang> = new Set<Lang>(["python", "tex"]);

/** Python statements that end a block: the line after one starts a level out. */
const PY_BLOCK_EXIT = /^(?:return|raise|pass|break|continue)\b/;

/**
 * Enter, aligned with the code it continues (Python and TeX). Returns the next
 * value + caret, or **null** to let the engine insert the newline itself — which
 * is deliberate rather than lazy: a plain newline through the browser keeps the
 * textarea's own undo entry, so the only keystrokes this intercepts are the ones
 * that genuinely add something.
 *
 * What it adds, in the order the rules are tried:
 *
 *  - the current line's indentation, always, so a block does not fall out from
 *    under the caret;
 *  - **inside brackets** (Python's implicit continuation) the new line aligns
 *    under the first argument, or one level in when the opener ends its line —
 *    and when the caret sits directly between a pair, the closer is pushed onto
 *    its own line so `foo(|)` opens into a block;
 *  - **after a `:`** one level in, and after `return`/`raise`/`pass`/`break`/
 *    `continue` one level out, since that statement ended the block;
 *  - **after `\begin{env}`** one level in, plus the matching `\end{env}` below
 *    when the document does not already have one waiting (`hasMatchingTexEnd` —
 *    the same test the environment completion makes, so typing a `\begin` out by
 *    hand and completing it cannot disagree).
 *
 * A caret inside a string literal gets the plain carry and nothing else: the
 * text there is data, and a `:` at the end of a sentence is not a block.
 */
export function applyAutoIndent(
  el: HTMLTextAreaElement,
  lang: Lang,
  unit: IndentUnit = DEFAULT_INDENT_UNIT,
): { value: string; selStart: number; selEnd: number } | null {
  if (!AUTO_INDENT_LANGS.has(lang)) return null;
  const { value, selectionStart: start, selectionEnd: end } = el;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  // Only the part of the line being LEFT BEHIND decides the new line: a caret
  // parked inside the indentation splits it rather than copying it whole.
  const head = value.slice(lineStart, start);
  const lead = /^[ \t]*/.exec(head)?.[0] ?? "";

  let indent = lead;
  let tail = ""; // a further line written BELOW the new one (a closer)

  if (lang === "python") {
    const st = pythonIndentState(value, start);
    const open = st.openers.length > 0 ? st.openers[st.openers.length - 1] : -1;
    if (st.inString) {
      // Carry the indentation and infer nothing from the prose.
    } else if (open >= 0) {
      const openIndent = lineIndentAt(value, open);
      if (value[end] === BRACKET_CLOSE_FOR[value[open]]) {
        indent = openIndent + unit.text;
        tail = "\n" + openIndent;
      } else if (/\S/.test(pyCodeAfter(value, open + 1))) {
        indent = " ".repeat(columnAt(value, open) + 1);
      } else {
        indent = openIndent + unit.text;
      }
    } else {
      const code = st.lineCode.trim();
      if (code.endsWith(":")) indent = lead + unit.text;
      else if (PY_BLOCK_EXIT.test(code)) indent = dedentOnce(lead, unit);
    }
  } else {
    const begun = /\\begin\s*\{([^{}]+)\}\s*$/.exec(texCodePrefix(head));
    if (begun) {
      indent = lead + unit.text;
      if (!hasMatchingTexEnd(value.slice(end), begun[1])) {
        tail = `\n${lead}\\end{${begun[1]}}`;
      }
    }
  }

  const insert = "\n" + indent + tail;
  if (insert === "\n") return null; // nothing to add — leave it to the engine
  const caret = start + 1 + indent.length;
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    selStart: caret,
    selEnd: caret,
  };
}

/**
 * Build the indent-guide overlay: each line's leading whitespace is cut into
 * whole indentation levels and every level's first column wears a hairline, so
 * the nesting a file expresses through blank space becomes something to read
 * rather than something to count.
 *
 * Two rules keep it honest. The **file's own characters** are what the spans
 * wrap — never a tab rewritten as four spaces — because this layer sits on top
 * of the textarea's glyphs and one substituted character puts every guide after
 * it on the wrong column. And a **partial** level (an indentation of six with a
 * unit of four) still gets its guide at column four, where the level genuinely
 * starts, and nothing at all for the two spaces that follow.
 *
 * Returns null when no line in the file is indented — there is nothing to draw,
 * and the layer is then not rendered at all. SECURITY: every run of source text
 * is HTML-escaped before output, exactly as {@link decorateSearchRanges} does.
 */
export function decorateIndentGuides(source: string, unit: IndentUnit): string | null {
  if (unit.width <= 0) return null;
  let any = false;
  const out = source.split("\n").map((line) => {
    let w = 0;
    while (w < line.length && (line[w] === " " || line[w] === "\t")) w++;
    if (w === 0) return escapeHtmlText(line);
    any = true;
    let html = "";
    let col = 0;
    let chunk = "";
    let chunkCol = 0;
    const flush = () => {
      if (chunk === "") return;
      html +=
        chunkCol % unit.width === 0
          ? `<span class="file-viewer-indent-guide">${escapeHtmlText(chunk)}</span>`
          : escapeHtmlText(chunk);
      chunk = "";
    };
    for (let i = 0; i < w; i++) {
      const ch = line[i];
      if (chunk !== "" && col % unit.width === 0) {
        flush();
        chunkCol = col;
      }
      chunk += ch;
      col += ch === "\t" ? TAB_WIDTH - (col % TAB_WIDTH) : 1;
    }
    flush();
    return html + escapeHtmlText(line.slice(w));
  });
  return any ? out.join("\n") : null;
}

/** Where the indent guides are drawn: the languages that put meaning in leading
 *  whitespace, which is every one the editor highlights except the two that are
 *  prose — a stray indent in a paragraph is not a level of anything. */
const INDENT_GUIDE_LANGS = (lang: Lang) => lang !== "plain" && lang !== "markdown";

/**
 * Read-only sibling of `useEditableFile` for the table/notebook/diff viewers
 * (none of which edit on disk). Loads the file once via `read_file_text` and
 * polls `file_mtime`, silently re-reading when the file changes underneath — the
 * same load/refresh path `useEditableFile` uses, minus all the draft/undo/save
 * machinery. Returns the raw text (or null while loading) and an error string.
 */
export function useReadonlyFile(path: string) {
  const t = useT();
  const scope = useFileScope();
  const paneVisible = usePaneVisible();
  const [content, setContent] = useState<string | null>(null);
  // The failure is held as a translation KEY, not a sentence: the read effects
  // must not depend on `t` (a language flip would re-run them and discard an
  // unsaved draft), and holding the key makes the message follow the language.
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const error = errorKey ? t(errorKey) : null;
  const lastMtime = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setErrorKey(null);
    lastMtime.current = null;
    readFileText(path, scope)
      .then((text) => { if (!cancelled) setContent(text); })
      .catch((e) => { if (!cancelled) setErrorKey(describeFileErrorKey(e)); });
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope]);

  // Diff-aware reload: poll mtime and silently re-read on an external advance.
  // Visible panes only (hidden ones stay mounted forever); the immediate check
  // on re-show catches a change made while the pane was hidden.
  useEffect(() => {
    if (content == null || !paneVisible) return;
    let cancelled = false;
    const check = () => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          readFileText(path, scope)
            .then((text) => { if (!cancelled) setContent(text); })
            .catch(() => {});
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, content, paneVisible]);

  return { content, error, loaded: content != null };
}

/**
 * Build a transparent decoration layer (#49) where the `ranges` are wrapped in
 * `<span class="file-link">` so they read as clickable (dotted underline). The
 * surrounding text is escaped and emitted plain (transparent), so only the link
 * spans paint. SECURITY: every run of source text is HTML-escaped before output.
 */
export function decorateLinkRanges(
  source: string,
  ranges: { start: number; end: number; hit?: boolean }[],
): string {
  if (ranges.length === 0) return escapeHtmlText(source);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.start >= r.end) continue; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    // `data-off` carries the token's source offset so a Ctrl/⌘+click can follow
    // the link by the span it lands on rather than by `selectionStart` — a
    // modified click does not reposition a textarea's caret, so the caret is
    // stale exactly when the follow needs it.
    // A `hit` range is clickable but not a link to look at (the rest of an
    // `\input{…}` around its underlined path): same hit box, no underline.
    const cls = r.hit ? "file-link-hit" : "file-link";
    out += `<span class="${cls}" data-off="${r.start}">${escapeHtmlText(source.slice(r.start, r.end))}</span>`;
    pos = r.end;
  }
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * Build the hover-preview hit layer (#tex-hover-preview): the previewable TeX
 * fragments are wrapped in `<span class="file-viewer-tex-snippet">` carrying
 * their index, the rest emitted plain. The spans paint nothing until one is
 * hovered — this layer exists to be *hit-tested*, since the textarea owns pointer
 * events and a scroll-synced overlay's span boxes are the only thing in the
 * editor that knows where a character actually landed on screen (the same
 * technique the link, grammar and unclosed-bracket layers use). SECURITY: every
 * run of source text is HTML-escaped before output.
 */
export function decorateSnippetRanges(
  source: string,
  ranges: { start: number; end: number }[],
): string {
  if (ranges.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    out += `<span class="file-viewer-tex-snippet" data-si="${i}">${escapeHtmlText(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  });
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * Find every (non-overlapping) occurrence of `query` in `text` as a
 * `{start, end}` offset range (#67 editor search). A plain substring search;
 * `caseSensitive` toggles a case-fold. An empty query yields no matches.
 * Exported for unit testing.
 */
export function findMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    out.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length; // non-overlapping
  }
  return out;
}

/**
 * Build the transparent search-highlight overlay (#67): the `matches` ranges are
 * wrapped in `<span class="file-viewer-search-match">` (the `current` one also
 * carries `current`), the rest emitted plain so only the match spans paint a
 * background. SECURITY: every run of source text is HTML-escaped before output —
 * mirrors `decorateLinkRanges`.
 */
export function decorateSearchRanges(
  source: string,
  matches: { start: number; end: number }[],
  current: number,
): string {
  if (matches.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  matches.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    const cls = i === current ? "file-viewer-search-match current" : "file-viewer-search-match";
    out += `<span class="${cls}">${escapeHtmlText(source.slice(r.start, r.end))}</span>`;
    pos = r.end;
  });
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * Build the occurrence-highlight overlay (#tex-command-occurrences): the ranges
 * are wrapped in `<span class="file-viewer-occurrence-match">`, the rest emitted
 * plain, so only the other uses of the double-clicked control sequence paint.
 * A quieter fill than the search layer's on purpose — this mark is a passing
 * answer to a gesture, not a search the reader is stepping through. SECURITY:
 * every run of source text is HTML-escaped before output — mirrors
 * {@link decorateSearchRanges}.
 */
export function decorateOccurrenceRanges(
  source: string,
  ranges: { start: number; end: number }[],
): string {
  if (ranges.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos || r.start >= r.end) continue; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    out += `<span class="file-viewer-occurrence-match">${escapeHtmlText(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  }
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/** The three bracket pairs matched by {@link findMatchingBracket}: `(`/`)`,
 *  `[`/`]`, `{`/`}` — the pairs shared by every language the editor highlights
 *  (LaTeX group braces and optional-arg brackets included). Keyed both ways so
 *  a lookup never needs to know which side it's holding. */
const BRACKET_OPEN_FOR: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const BRACKET_CLOSE_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** One side of a matched delimiter pair: a `[start, end)` source range —
 *  length 1 for a plain `(`/`)`/etc., longer for a multi-character LaTeX token
 *  like `\[`, `$$`, or a whole `\begin{itemize}`. */
export interface BracketSide {
  start: number;
  end: number;
}

/** A matched delimiter pair (`open` earlier in the source than `close`), for
 *  the "highlight the matching bracket" overlay. Ranges rather than single
 *  offsets so the same type/overlay serves both the plain single-char
 *  ()[]{} matcher below and `lib/viewers/tex/tex.ts`'s LaTeX-aware math/environment
 *  matcher (`$`/`$$`/`\(`/`\)`/`\[`/`\]`/`\begin{…}`/`\end{…}`), which the two
 *  share structurally without either module importing the other's type. */
export interface BracketMatch {
  open: BracketSide;
  close: BracketSide;
}

/** Scan from `start` in direction `dir` (`1` forward, `-1` backward) for the
 *  offset where a running depth — incremented on `incChar`, decremented on
 *  `decChar` — returns to 0; that is the partner bracket. `null` if the depth
 *  never returns to 0 (unbalanced/unmatched). Shared by the two directions
 *  {@link findMatchingBracket} scans, which just swap which char increments vs.
 *  decrements. Pure — a plain nesting count, no comment/string awareness (the
 *  same level of sophistication as this file's other overlay decorators). */
function scanForBracketMatch(
  text: string,
  start: number,
  incChar: string,
  decChar: string,
  dir: 1 | -1,
): number | null {
  let depth = 1;
  for (let i = start; dir === 1 ? i < text.length : i >= 0; i += dir) {
    const ch = text[i];
    if (ch === incChar) depth++;
    else if (ch === decChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** If `text[pos]` is a bracket (either side of a pair), its match — scanning
 *  forward for an opener or backward for a closer, from just past `pos`. `null`
 *  when `pos` isn't a bracket, or the bracket found has no partner (unbalanced
 *  source). Shared by both adjacent offsets {@link findMatchingBracket} checks. */
function matchBracketAt(text: string, pos: number): BracketMatch | null {
  const ch = text[pos];
  if (ch === undefined) return null;
  if (BRACKET_CLOSE_FOR[ch]) {
    const close = scanForBracketMatch(text, pos + 1, ch, BRACKET_CLOSE_FOR[ch], 1);
    return close != null
      ? { open: { start: pos, end: pos + 1 }, close: { start: close, end: close + 1 } }
      : null;
  }
  if (BRACKET_OPEN_FOR[ch]) {
    const open = scanForBracketMatch(text, pos - 1, ch, BRACKET_OPEN_FOR[ch], -1);
    return open != null
      ? { open: { start: open, end: open + 1 }, close: { start: pos, end: pos + 1 } }
      : null;
  }
  return null;
}

/**
 * The bracket pair straddling `caret`, for the "highlight the matching
 * bracket" affordance. A caret sits "on" a bracket from either side of it, so
 * this checks BOTH adjacent characters — `text[caret]` (the caret sits just
 * before it) first, then `text[caret - 1]` (the caret sits just after it) —
 * covering all four ways a blinking caret can touch a bracket: just before or
 * just after either its open or its close. (An earlier cut only checked "just
 * before an opener" and "just after a closer", which missed the two positions
 * a caret is actually in most often — right after typing `(`, or right before
 * deleting `)` — so the caret could sit directly against a bracket and nothing
 * would light up.) Returns `null` when neither side is a bracket, or the
 * bracket found has no partner (unbalanced source). Pure / unit-tested.
 */
export function findMatchingBracket(text: string, caret: number): BracketMatch | null {
  return matchBracketAt(text, caret) ?? matchBracketAt(text, caret - 1);
}

/**
 * Build the transparent bracket-match overlay: the two paired delimiter
 * ranges found by {@link findMatchingBracket} (or `lib/viewers/tex/tex.ts`'s
 * math/environment matcher) are each wrapped in
 * `<span class="file-viewer-bracket-match">`, the rest emitted plain — mirrors
 * `decorateSearchRanges`. SECURITY: every run of source text is HTML-escaped.
 */
export function decorateBracketMatch(source: string, match: BracketMatch): string {
  const [a, b] =
    match.open.start < match.close.start ? [match.open, match.close] : [match.close, match.open];
  return (
    escapeHtmlText(source.slice(0, a.start)) +
    `<span class="file-viewer-bracket-match">${escapeHtmlText(source.slice(a.start, a.end))}</span>` +
    escapeHtmlText(source.slice(a.end, b.start)) +
    `<span class="file-viewer-bracket-match">${escapeHtmlText(source.slice(b.start, b.end))}</span>` +
    escapeHtmlText(source.slice(b.end))
  );
}

/**
 * Build the persistent TeX delimiter-diagnostic overlay. Every delimiter left
 * without a partner gets a danger-coloured wavy underline; source stays
 * transparent so the syntax layer keeps the glyph itself readable.
 * A range's `hint` rides along in `data-hint`, which is what the hover tooltip
 * reads — a `\begin{itemize}` with no end and an `\end{itemize}` with no begin
 * are different mistakes and say so, rather than sharing one generic message.
 * Ranges are sorted and overlap-pruned defensively (the TeX scanner normally
 * emits disjoint ranges). SECURITY: all source runs and hints are HTML-escaped.
 */
export function decorateUnclosedBrackets(
  source: string,
  ranges: (BracketSide & { hint?: string })[],
): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const range of sorted) {
    const start = Math.max(0, Math.min(range.start, source.length));
    const end = Math.max(start, Math.min(range.end, source.length));
    if (end <= start || start < pos) continue;
    out += escapeHtmlText(source.slice(pos, start));
    const hint = range.hint ? ` data-hint="${escapeHtmlText(range.hint)}"` : "";
    out +=
      `<span class="file-viewer-unclosed-bracket"${hint}>` +
      escapeHtmlText(source.slice(start, end)) +
      "</span>";
    pos = end;
  }
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * The `{start, end}` (in `next` coordinates) of the run of text that differs
 * between `prev` and `next`, found by trimming the common prefix and suffix.
 * Used to tint the most-recent edit. Returns `null` when nothing was inserted
 * or replaced — i.e. equal strings, or a pure deletion (whose changed range is
 * zero-width in `next`, so there is nothing to paint).
 */
export function diffRange(prev: string, next: string): { start: number; end: number } | null {
  const span = editSpan(prev, next);
  return span && span.endNext > span.start ? { start: span.start, end: span.endNext } : null;
}

/**
 * The full span of an edit between `prev` and `next`: `start` is the common
 * prefix length, `endPrev`/`endNext` are where the differing run ends in each
 * string (so `prev.slice(start, endPrev)` was replaced by `next.slice(start,
 * endNext)`). Unlike `diffRange` this is reported for deletions too (where
 * `endNext === start`), since the change-tint trail must still re-map older
 * ranges through a deletion. Returns `null` only for equal strings. Pure —
 * exported for tests.
 */
export function editSpan(
  prev: string,
  next: string,
): { start: number; endPrev: number; endNext: number } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { start, endPrev, endNext };
}

/** How many recent edit runs the change-tint trail keeps (and how many colour
 *  tiers `themes.css` defines, `.tier-0` … `.tier-(N-1)`). */
export const CHANGE_TIERS = 18;
/** Idle delay before the trail retires its oldest run, in ms — once typing stops
 *  the trail fades a tier at a time over CHANGE_TIERS × this. */
const CHANGE_DECAY_MS = 1800;

/* The deletion ghosts that used to live here — just-deleted text injected back
   into a transparent overlay in red strike-through, then faded away — are gone
   (2026-09-01). The animation was the expensive half: `fv-delete-fade` animated
   `font-size` down to 0, which is a full relayout of a whole-document <pre> on
   every frame of every deletion, and the overlay itself was re-escaped and
   rebuilt on each keystroke while any ghost lived. The green change trail below
   is the surviving half; it tints ranges that exist, so it never reflows. */

/** One run of recently typed text in the change-tint trail. `tier` is its age:
 *  0 is the newest edit, higher tiers are progressively older (and fainter). */
export interface ChangeRange {
  start: number;
  end: number;
  tier: number;
}

/**
 * Re-map an existing change range through a new edit so it keeps pointing at the
 * same characters: untouched if it sits entirely before the edit, shifted by the
 * length delta if entirely after, and dropped (returns `null`) if it overlaps the
 * edited region (its text was overwritten). Pure — exported for tests.
 */
export function remapChangeRange(
  range: { start: number; end: number },
  span: { start: number; endPrev: number; endNext: number },
): { start: number; end: number } | null {
  const delta = span.endNext - span.endPrev;
  if (range.end <= span.start) return range;
  if (range.start >= span.endPrev) {
    return { start: range.start + delta, end: range.end + delta };
  }
  return null;
}

/**
 * Build the transparent change-tint overlay: each recent edit range is wrapped in
 * `<span class="file-viewer-change-mark tier-N">` so it paints its age-graded
 * tint (tier 0 newest), the rest emitted plain. Ranges must be non-overlapping;
 * they are sorted left-to-right here. SECURITY: every run is HTML-escaped —
 * mirrors `decorateSearchRanges`.
 */
export function decorateChangeRanges(
  source: string,
  ranges: ChangeRange[],
): string {
  const clamped = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, source.length)),
      end: Math.max(0, Math.min(r.end, source.length)),
      tier: r.tier,
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (clamped.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  for (const r of clamped) {
    if (r.start < pos) continue; // defensive: skip any residual overlap
    out += escapeHtmlText(source.slice(pos, r.start));
    out += `<span class="file-viewer-change-mark tier-${r.tier}">${escapeHtmlText(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  }
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/** A grammar issue resolved to a concrete `{start, end}` character range in the
 *  current draft, carrying its originating issue for the tooltip / apply-fix. */
export interface GrammarRange {
  start: number;
  end: number;
  issue: GrammarIssue;
}

/**
 * Resolve each model-reported grammar issue to a character range in `text`. The
 * model reports the offending substring `bad` plus its 1-based `line`; we search
 * that line first (so duplicates of a word map to the right occurrence), then
 * fall back to the whole document, so a small edit since the check doesn't drop
 * every mark. Issues resolve in order with a per-line cursor, so several errors
 * on one line each map to their own occurrence. Unlocatable issues are skipped;
 * the result is sorted by start with overlaps pruned so the decorator's
 * left-to-right walk stays clean. Pure — exported for tests.
 */
export function resolveGrammarRanges(text: string, issues: GrammarIssue[]): GrammarRange[] {
  if (issues.length === 0) return [];
  // 0-based offset where each 1-based line begins (lineStarts[n-1] = line n).
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  // Per-line search cursor so repeated errors on a line advance past each other.
  const lineCursor = new Map<number, number>();
  const out: GrammarRange[] = [];
  for (const issue of issues) {
    const bad = issue.bad;
    if (!bad) continue;
    let start = -1;
    const li = issue.line - 1;
    if (li >= 0 && li < lineStarts.length) {
      const lineStart = lineStarts[li];
      const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] : text.length;
      const from = Math.max(lineStart, lineCursor.get(li) ?? lineStart);
      const idx = text.indexOf(bad, from);
      if (idx >= 0 && idx < lineEnd) {
        start = idx;
        lineCursor.set(li, idx + bad.length);
      }
    }
    if (start < 0) {
      // The reported line drifted since the check — locate it anywhere.
      const idx = text.indexOf(bad);
      if (idx >= 0) start = idx;
    }
    if (start < 0) continue;
    out.push({ start, end: start + bad.length, issue });
  }
  out.sort((a, b) => a.start - b.start);
  const pruned: GrammarRange[] = [];
  let lastEnd = -1;
  for (const r of out) {
    if (r.start < lastEnd) continue; // drop overlaps
    pruned.push(r);
    lastEnd = r.end;
  }
  return pruned;
}

/**
 * Build the transparent grammar overlay: each range is wrapped in a
 * `<span class="file-viewer-grammar-mark cat-<category>" data-gi="<i>">` so it
 * paints a coloured wavy underline (colour by category) while the surrounding
 * text stays plain/transparent. The `data-gi` index ties a span back to its
 * `ranges` entry for hover hit-testing. SECURITY: every run of source text is
 * HTML-escaped before output — mirrors `decorateSearchRanges`.
 */
export function decorateGrammarRanges(source: string, ranges: GrammarRange[]): string {
  if (ranges.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    const cat =
      r.issue.category === "spelling" || r.issue.category === "style"
        ? r.issue.category
        : "grammar";
    out += `<span class="file-viewer-grammar-mark cat-${cat}" data-gi="${i}">${escapeHtmlText(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  });
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * Replace each `{start, end}` range in `text` with `replacement`, returning the
 * new string (#67 find-and-replace). Ranges are applied left-to-right; any that
 * overlap an already-consumed range (or are empty) are skipped, mirroring the
 * non-overlapping match set `findMatches` produces. Pure — exported for testing.
 */
export function applyReplacements(
  text: string,
  ranges: { start: number; end: number }[],
  replacement: string,
): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.start >= r.end) continue;
    out += text.slice(pos, r.start) + replacement;
    pos = r.end;
  }
  out += text.slice(pos);
  return out;
}

/** Live device-pixel ratio, updated when it changes (window moved between
 *  monitors, display scale changed, browser zoom). Used to snap the editor's
 *  line-height to whole device pixels — see `snapToDevicePx`. */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() =>
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [dpr]);
  return dpr;
}

/**
 * Snap a CSS-pixel length to a whole number of device pixels at `dpr`.
 *
 * The code editor stacks a transparent <textarea> (which owns the caret) over a
 * syntax-highlighted <pre>. WebKitGTK lays the textarea's lines out as
 * whole-device-pixel line boxes (height `round(lineHeight·dpr)` each, stacked),
 * but positions the <pre>'s lines at the exact fractional multiple
 * (`round(n·lineHeight·dpr)`). Under a fractional display scale those differ by
 * a fraction of a pixel per line and accumulate — over a long file (hundreds of
 * lines) the caret drifts a full line above the coloured text by the bottom.
 * Making `lineHeight·dpr` a whole number means both layouts land on the same
 * grid, so the per-line advance is identical and nothing accumulates. A no-op at
 * an integer dpr (e.g. 1.0 or 2.0), where the drift never appeared.
 */
export function snapToDevicePx(cssPx: number, dpr: number): number {
  return Math.round(cssPx * dpr) / dpr;
}

/**
 * Where the caret at character `pos` of a textarea is, used to anchor the
 * `\ref`/`\cite` completion dropdown right under the typed key. The standard
 * hidden-mirror technique, in two halves: a div copies the textarea's box/text
 * metrics, holds the text up to `pos`, and a trailing marker span's offset gives
 * the caret position (`textareaCaretMirrorOffsets` → these offsets, relative to
 * the textarea's padding box); the textarea's own scroll and screen rect then
 * map it to the viewport (`textareaMirrorToViewport`).
 */
interface CaretMirrorOffsets {
  top: number;
  left: number;
  height: number;
}

/**
 * The textarea's content-box width — the width its lines wrap at — as the
 * fractional number layout actually uses, NOT `clientWidth`. `clientWidth` is
 * rounded to a whole pixel, and the editor's box is routinely fractional (it
 * is whatever flex leaves beside the gutter). Measured on WebKitGTK 2.52 with
 * the bundled JetBrains Mono at 12px (7.20006px advance): at a 527.5px box the
 * textarea wraps a 70-column comment onto two rows (70 × 7.20006 = 504.004 >
 * 503.5) while a mirror sized to `clientWidth` = 528 fits it on one — so every
 * gutter cell, caret mark and search mark below that line sat a row off, and the
 * coloured glyphs wrapped at a column the caret never reached. Sized to this
 * width instead, the mirror matched the textarea on every line of that document
 * at every width tried. The scrollbar is subtracted as `offsetWidth -
 * clientWidth`: both are rounded, but the difference is the scrollbar's whole-
 * pixel width, so it survives the rounding that the width itself does not.
 */
function textareaWrapWidth(ta: HTMLTextAreaElement): number {
  return ta.getBoundingClientRect().width - (ta.offsetWidth - ta.clientWidth);
}

/** Map mirror offsets to viewport coordinates. Cheap — one `getBoundingClientRect`
 *  and the live scroll offsets — so the completion dropdown can re-anchor on
 *  every keystroke while the expensive mirror layout below runs once per token. */
function textareaMirrorToViewport(
  ta: HTMLTextAreaElement,
  m: CaretMirrorOffsets,
): { left: number; top: number; height: number } {
  const rect = ta.getBoundingClientRect();
  return { left: rect.left + m.left - ta.scrollLeft, top: rect.top + m.top - ta.scrollTop, height: m.height };
}

/**
 * The mirror measurement itself: lay out the text up to `pos` in a hidden div
 * with the textarea's metrics and read the marker's offsets. This is a full
 * layout of everything before the caret — on a long document the single most
 * expensive thing a keystroke can do — which is why the caller caches it for
 * as long as the same token is being typed (the token's start does not move).
 */
function textareaCaretMirrorOffsets(ta: HTMLTextAreaElement, pos: number): CaretMirrorOffsets {
  const style = getComputedStyle(ta);
  const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
  const div = document.createElement("div");
  const copy = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom",
    "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle",
    "fontVariant", "letterSpacing", "wordSpacing", "lineHeight", "tabSize",
    "textIndent", "textTransform",
  ] as const;
  for (const p of copy) div.style[p as never] = style[p as never];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = ta.wrap === "off" ? "pre" : "pre-wrap";
  div.style.overflowWrap = "anywhere";
  div.style.overflow = "hidden";
  div.style.height = "auto";
  div.textContent = ta.value.slice(0, pos);
  const marker = document.createElement("span");
  // Only the word the caret is in follows it: that is what decides whether a
  // soft wrap moves the caret to the next line, and it is all the marker's
  // position depends on. The rest of the document was laid out for nothing.
  marker.textContent = /^\S{0,200}/.exec(ta.value.slice(pos, pos + 200))?.[0] || ".";
  div.appendChild(marker);
  document.body.appendChild(div);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  document.body.removeChild(div);
  return { left, top, height: lh };
}

/** Keys that, typed immediately after an accepted completion, replace the
 *  auto-inserted trailing space (closing punctuation reads better tight). */
const NO_SPACE_BEFORE = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}"]);

/** Bare modifier presses, ignored by the smart-space handler so that e.g. the
 *  Shift held to type `?` doesn't prematurely commit the space. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** One row of the TeX completion dropdown. `entry` carries the table row a
 *  command/environment candidate came from, so accepting can seed its arguments
 *  and close its block; a key candidate has none — its `value` is the whole
 *  answer. */
interface TexComplItem {
  value: string;
  detail?: string;
  /** True for a candidate the DOCUMENT defines, which the row marks: a local
   *  macro is the one candidate whose meaning is not general knowledge. */
  local?: boolean;
  entry?: TexCommandEntry | TexEnvEntry;
}

/** Compact one-line description of a bib entry for the dropdown's second column:
 *  author (first surname et al.) and year, falling back to the title. */
function citeDetail(e: { title?: string; author?: string; year?: string }): string | undefined {
  const bits: string[] = [];
  if (e.author) {
    const first = e.author.split(/\s+and\s+/i)[0].trim();
    const surname = first.includes(",") ? first.split(",")[0] : first.split(/\s+/).pop() || first;
    bits.push(e.author.includes(" and ") ? `${surname} et al.` : surname);
  }
  if (e.year) bits.push(e.year);
  const head = bits.join(" ");
  if (head && e.title) return `${head} — ${e.title}`;
  return head || e.title;
}

/** Is the screen point `x,y` inside a `.file-link` span's box? A **collapsed**
 *  rect never counts, however the point compares to it: a zero-by-zero box is
 *  not a hit target — it is a span that isn't laid out (an unmounted or hidden
 *  link layer) — and `0 >= 0 && 0 <= 0` is true on both axes, so the naive
 *  comparison reports a hit on the FIRST link in the document for any click at
 *  the viewport origin. Under jsdom, where every `getBoundingClientRect()` is
 *  all-zeros and a synthetic click defaults to `clientX/clientY = 0`, that made
 *  every Ctrl+click resolve the file's first link regardless of where it landed. */
function linkRectHit(r: DOMRect, x: number, y: number): boolean {
  if (r.width <= 0 || r.height <= 0) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** What the TeX viewer hands the editor to make hovering typeset something
 *  (#tex-hover-preview). Split this way so the editor stays document-agnostic:
 *  it never learns what a preamble is, and the viewer never learns where a span
 *  landed on screen. */
export interface HoverPreviewConfig {
  /** The previewable fragments of the current draft, as source ranges. */
  ranges: (source: string) => TexSnippetRange[];
  /** Typeset one fragment. `stillWanted` is polled by the compile queue, so a
   *  fragment the pointer has left is dropped before it reaches the engine;
   *  `undefined` back means exactly that and nothing should be shown. */
  render: (body: string, stillWanted: () => boolean) => Promise<TexPreview | undefined>;
  /** An already-rendered result for this fragment, if there is one — painted
   *  immediately, so a re-hover never shows a spinner it is about to replace. */
  cached: (body: string) => TexPreview | undefined;
}

/** How long the pointer must rest on a fragment before it is compiled. Long
 *  enough that crossing a page of equations on the way somewhere else starts
 *  nothing, short enough to feel like an answer to the hover rather than an
 *  event of its own. */
const HOVER_PREVIEW_DWELL_MS = 400;

/** How wide the hover card may get, and how far down the window an anchor may
 *  sit before the card opens upwards instead. */
const HOVER_PREVIEW_MAX_W = 520;
const HOVER_PREVIEW_FLIP_AT = 0.6;

function CodeEditor({
  error,
  draft,
  setDraft,
  loaded,
  save,
  path,
  onFollowLink,
  linkRanges,
  undo,
  redo,
  autocomplete,
  spellCheck,
  texCompletions,
  hoverPreview,
  fontSize,
  lineHeight,
  incFont,
  decFont,
  resetFont,
  wrap,
  gotoLine,
  onGotoApplied,
  onCaretChange,
  onSelectionChange,
  caretApiRef,
  editorApiRef,
  showBlame,
  blame,
  breakpoints,
  onToggleBreakpoint,
  initialScrollTop,
  onScrollPersist,
  groupId,
}: {
  error: string | null;
  draft: string;
  setDraft: (value: string) => void;
  loaded: boolean;
  save: () => void;
  /** File path, used to pick the syntax-highlighting language by extension. */
  path: string;
  /** When set, Ctrl/Cmd+Click resolves the reference at the clicked caret index
   *  and opens it (the LaTeX viewer wires this to `\input{…}` follow). */
  onFollowLink?: (caret: number) => void;
  /** SyncTeX reverse-search target: move the caret to (1-based) `line`/`column`
   *  (`column` 0 = line start) and scroll it into view whenever `nonce` changes. */
  gotoLine?: { line: number; column?: number; nonce: number };
  /** Called once a `gotoLine` request has been applied, so the caller can clear
   *  it (consume the editorJump request). */
  onGotoApplied?: () => void;
  /** Reports the current caret offset (after clicks / key navigation), so the
   *  LaTeX viewer can run SyncTeX forward search from it on compile. */
  onCaretChange?: (offset: number) => void;
  /** Reports the selection `[start, end)` after clicks / key navigation, while
   *  the textarea is focused (the same blur guard as `onCaretChange`). The
   *  beamer bar (#tex-beamer) remembers the last real one: WebKitGTK collapses
   *  a textarea's selection when focus moves to the bar's own number field, so
   *  by the time Wrap is clicked the live selection may already be gone. */
  onSelectionChange?: (start: number, end: number) => void;
  /** When set, receives a getter for the textarea's *live* caret offset (or
   *  `null` if the editor isn't mounted/available). The LaTeX viewer reads this
   *  synchronously at compile time so forward search uses the real cursor even if
   *  no caret event fired this session — `onCaretChange`/its snapshot can be a
   *  stale 0 (e.g. the editor was never focused, or a WebKitGTK blur reset it). */
  caretApiRef?: React.MutableRefObject<(() => number | null) | null>;
  /** When set, receives an imperative editing API so a toolbar (the Markdown
   *  viewer's bold/italic/heading/… controls) can transform the current
   *  value+selection; edits commit through the normal path so undo/redo and the
   *  syntax overlay stay consistent. Cleared on unmount. */
  editorApiRef?: React.MutableRefObject<EditorApi | null>;
  /** When set, returns the source ranges to decorate as clickable file links
   *  (#49). Currently the LaTeX viewer's `\input{…}`/`\includegraphics{…}` args. */
  linkRanges?: (source: string) => { start: number; end: number; hit?: boolean }[];
  /** Undo/redo handlers (#46) — wired to Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. */
  undo?: () => void;
  redo?: () => void;
  /** Opt-in local autocomplete config (#45). Disabled when undefined/off.
   *  `preferred` is the user's active local model (🧠 menu); the completion runs
   *  against whichever model is *currently loaded* in Ollama memory at trigger
   *  time, preferring `preferred` when it is among the loaded set. */
  autocomplete?: { enabled: boolean; preferred?: string; preferredProse?: string; mode?: AutocompleteMode };
  /** Opt-in dictionary (Hunspell) spell check. When enabled the draft is
   *  checked by the backend's loaded dictionary after a short idle; `language`
   *  is the dictionary code (unset → the backend's default). Issues are
   *  underlined with a hover tooltip and one-click fix. */
  spellCheck?: { enabled: boolean; language?: string };
  /** Opt-in `\ref`/`\cite` key completion (LaTeX viewer only). When supplied, a
   *  dropdown of `\label` keys (refs) or `.bib` entry keys (cites) appears while
   *  typing inside a recognised command's braces; Enter/Tab accepts. */
  texCompletions?: TexCompletions;
  /** Opt-in hover preview of the TeX snippet under the pointer
   *  (#tex-hover-preview, LaTeX viewer only). When supplied, resting the pointer
   *  on a formula or a previewable environment typesets that fragment and shows
   *  it in a card over the source. The editor owns the *gesture* — which
   *  fragments are hit boxes, the dwell, the card — and the caller owns the
   *  *compile*, because only the viewer knows the document's preamble, its
   *  folder and the chosen engine. */
  hoverPreview?: HoverPreviewConfig;
  /** Editor font metrics (text-size control). Default 12px / 18px when unset. */
  fontSize?: number;
  lineHeight?: number;
  /** Text-size handlers, wired to Ctrl +/− and Ctrl+0. */
  incFont?: () => void;
  decFont?: () => void;
  resetFont?: () => void;
  /** Soft-wrap long lines to the editor width instead of scrolling horizontally
   *  (used by the LaTeX viewer, whose prose lines run wide). The highlight/link/
   *  ghost overlays wrap in lockstep via the `is-wrapped` class. */
  wrap?: boolean;
  /** Git-blame overlay (#blame). When `showBlame` is set, a per-line blame column
   *  is painted in the gutter (scroll-locked with the line numbers) and the
   *  caret's line gets a faint inline attribution; hovering a blame cell shows a
   *  hovercard. `blame` maps 1-based line numbers to their attribution. */
  showBlame?: boolean;
  blame?: Map<number, BlameLine>;
  /** Debug breakpoints (#py), as 1-based line numbers. When `onToggleBreakpoint`
   *  is wired the gutter becomes interactive: each line number is a click target
   *  that toggles a breakpoint, and a breakpointed line paints a red dot. Only the
   *  Python editor supplies these; every other file type gets the inert,
   *  aria-hidden gutter it had before. */
  breakpoints?: ReadonlySet<number>;
  onToggleBreakpoint?: (line: number) => void;
  /** Persisted vertical scroll (px) to restore once the file loads, so reopening
   *  it (or a Tabtivity restart) lands the reader where they left off (#viewerpos).
   *  Applied once on first load; user scrolling thereafter reports via
   *  `onScrollPersist`. */
  initialScrollTop?: number;
  /** Called (throttled) with the textarea's `scrollTop` as the reader scrolls, so
   *  the position can be persisted. */
  onScrollPersist?: (scrollTop: number) => void;
  /** When set, the subwindow (group) id hosting this editor, so its scroll is
   *  proportionally linked to a side-by-side viewer subwindow (scrollSync). */
  groupId?: string | null;
}) {
  const t = useT();
  const chordHint = useChordHint();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Proportional scroll-link to a paired subwindow (no-op unless linked).
  const reportScrollSync = useScrollSync(groupId, textareaRef);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const blameInnerRef = useRef<HTMLDivElement>(null);
  const blameInlineRef = useRef<HTMLDivElement>(null);
  const indentLayerRef = useRef<HTMLPreElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const linkLayerRef = useRef<HTMLPreElement>(null);
  const searchLayerRef = useRef<HTMLPreElement>(null);
  const changeLayerRef = useRef<HTMLPreElement>(null);
  const grammarLayerRef = useRef<HTMLPreElement>(null);
  const bracketLayerRef = useRef<HTMLPreElement>(null);
  const unclosedLayerRef = useRef<HTMLPreElement>(null);
  const snippetLayerRef = useRef<HTMLPreElement>(null);
  const occurrenceLayerRef = useRef<HTMLPreElement>(null);
  const ghostRef = useRef<HTMLPreElement>(null);
  const measureRef = useRef<HTMLPreElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Link affordances over a recognised link (#49), only when `onFollowLink` is
  // wired (the LaTeX source editor):
  //  - `linkHover` shows the pointer cursor, but ONLY while the follow modifier is
  //    held, so the editor doesn't read as clickable the rest of the time.
  //  - `linkTip` anchors a "Ctrl+Click to open" hint, shown on plain hover (no
  //    modifier) so the shortcut is discoverable.
  const [linkHover, setLinkHover] = useState(false);
  const [linkTip, setLinkTip] = useState<{ left: number; top: number } | null>(null);
  // Last pointer position, so pressing/releasing the modifier while already
  // hovering a link (no mouse move) can still update the cursor.
  const lastMouse = useRef<{ x: number; y: number } | null>(null);

  // Ctrl/Cmd+wheel resizes the font. Bound non-passively (see
  // useZoomModifierWheel) so it never falls through to native scrolling — and
  // only while the modifier is down, so a plain scroll of a long file isn't
  // main-thread-bound by a listener that would ignore it anyway.
  const wheelRef = useZoomModifierWheel((e) => onCtrlWheelFont(e, incFont, decFont));

  // Resolve the link affordances for the screen point `x,y`. The link layer is
  // scroll-synced to sit exactly over the textarea text, so its `.file-link` span
  // rects are the on-screen link hit boxes — no glyph metrics needed.
  const updateLinkHover = useCallback(
    (x: number, y: number, mod: boolean) => {
      const layer = linkLayerRef.current;
      if (!onFollowLink || !layer) {
        setLinkHover(false);
        setLinkTip(null);
        return;
      }
      let hit: DOMRect | null = null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-link, .file-link-hit")) {
        const r = span.getBoundingClientRect();
        if (linkRectHit(r, x, y)) {
          hit = r;
          break;
        }
      }
      setLinkHover(hit != null && mod);
      setLinkTip(hit ? { left: hit.left, top: hit.top } : null);
    },
    [onFollowLink],
  );

  // The source offset of the `.file-link` span under a screen point, or null.
  // Used by Ctrl/⌘+click: a modified click does NOT move a textarea's caret, so
  // `selectionStart` is stale there — the span the pointer is actually over is the
  // reliable target, and its `data-off` (see `decorateLinkRanges`) is a real
  // offset inside the reference the follow resolves.
  const linkOffsetAt = useCallback((x: number, y: number): number | null => {
    const layer = linkLayerRef.current;
    if (!layer) return null;
    for (const span of layer.querySelectorAll<HTMLElement>(".file-link, .file-link-hit")) {
      const r = span.getBoundingClientRect();
      if (linkRectHit(r, x, y)) {
        const off = span.getAttribute("data-off");
        return off != null ? Number(off) : null;
      }
    }
    return null;
  }, []);

  // #45 autocomplete: a pending ghost-text suggestion + the caret it applies at.
  const [suggestion, setSuggestion] = useState<CompletionGhost | null>(null);
  // A short status shown to the user when a completion is in flight, returns
  // nothing, or can't run (e.g. no local model loaded) — otherwise the feature
  // fails silently and reads as broken. A trailing "…" marks a transient
  // in-flight message; final messages auto-dismiss (see the effect below).
  const [acStatus, setAcStatus] = useState<string | null>(null);
  const acAbort = useRef<AbortController | null>(null);
  const acDocumentVersion = useRef(0);
  useLayoutEffect(() => { acDocumentVersion.current++; }, [draft, path]);
  const acVisible = usePaneVisible();
  const acCache = useRef(new CompletionCache());
  const acCandidate = useRef(0);
  const acCandidates = useRef<CompletionCandidate[]>([]);
  const acDismissed = useRef<{ draft: string; caret: number } | null>(null);
  const acOutcome = useRef<{ model: string; mode: AutocompleteMode | "copilot" } | null>(null);
  const acEndpoint = useSettingsStore((s) => JSON.stringify([
    s.settings?.ollama_host, s.settings?.ollama_allow_remote_host,
  ]));
  // #45 live completion-length mode: starts from the per-type default and is
  // cycled in-editor with Shift+Tab while a suggestion is showing. Re-seeded if
  // the per-type default changes (e.g. the user picks a new default in settings).
  const [acMode, setAcMode] = useState<AutocompleteMode>(autocomplete?.mode ?? "sentence");
  useEffect(() => {
    setAcMode(autocomplete?.mode ?? "sentence");
  }, [autocomplete?.mode]);

  // Auto-dismiss a finished autocomplete status after a few seconds; keep the
  // in-flight "…" message until the request resolves.
  useEffect(() => {
    if (!acStatus || acStatus.endsWith("…")) return;
    const id = window.setTimeout(() => setAcStatus(null), 4000);
    return () => window.clearTimeout(id);
  }, [acStatus]);

  // #45 context files: extra project files the user attaches as read-only context
  // for completion. Per-editor (not persisted); each entry caches the file's text
  // at attach time so requests don't re-read disk on every keystroke. `acPicker`
  // toggles the QuickOpen-style file picker.
  const [contextFiles, setContextFiles] = useState<
    { rel: string; path: string; content: string }[]
  >([]);
  const [acPicker, setAcPicker] = useState(false);
  const scope = useFileScope();

  // Count one outcome per offered candidate, including partial acceptance.
  const recordAcOutcome = useCallback((accepted: boolean) => {
    const offered = acOutcome.current;
    if (!offered) return;
    acOutcome.current = null;
    bumpUsage(scope ?? "root", `${accepted ? METRIC.AUTOCOMPLETE_ACCEPT : METRIC.AUTOCOMPLETE_DISMISS}.${offered.mode}.${offered.model}`);
  }, [scope]);

  // Resolve the project the edited file belongs to (the longest project directory
  // that is a prefix of `path`), falling back to the active project — so the
  // context-file picker lists the right project even in a detached window.
  const acProjectDir = useMemo(() => {
    const { projects, activeId } = useProjectsStore.getState();
    let best = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > best.length) {
        best = dir;
      }
    }
    if (best) return best;
    const active = projects.find((p) => p.id === activeId);
    return active ? resolveProjectDirectory(active) : "";
  }, [path]);

  const addContextFile = useCallback(
    async (rel: string) => {
      if (!acProjectDir) return;
      const abs = `${acProjectDir}/${rel}`;
      if (contextFiles.some((f) => f.path === abs)) return; // already attached
      try {
        const content = await readFileText(abs, scope);
        setContextFiles((prev) =>
          prev.some((f) => f.path === abs) ? prev : [...prev, { rel, path: abs, content }],
        );
      } catch {
        /* unreadable file: silently skip */
      }
    },
    [acProjectDir, contextFiles, scope],
  );

  const removeContextFile = useCallback((abs: string) => {
    setContextFiles((prev) => prev.filter((f) => f.path !== abs));
  }, []);

  // \ref/\cite key completion (LaTeX viewer): the open dropdown's context, the
  // filtered items, the highlighted index, and the screen anchor. A caret tick
  // re-runs the detector when the caret moves without the text changing (arrow
  // keys / clicks). `complClosedAt` suppresses immediately reopening at the exact
  // caret we dismissed at (e.g. right after accepting a key).
  const [compl, setCompl] = useState<{
    ctx: TexComplContext;
    items: TexComplItem[];
    index: number;
    pos: { left: number; top: number; height: number };
  } | null>(null);
  const [caretTick, setCaretTick] = useState(0);
  const complClosedAt = useRef(-1);
  // The open dropdown's per-token work (see `refreshCompl`): the candidate list
  // for its family and the caret mirror's layout, valid while the text outside
  // `[start, end)` — held here as `prefix`/`suffix` — is unchanged.
  const complSession = useRef<{
    kind: TexComplContext["kind"];
    start: number;
    prefix: string;
    suffix: string;
    candidates: TexLabelEntry[] | BibEntry[] | TexCommandEntry[] | TexEnvEntry[];
    mirror: CaretMirrorOffsets;
  } | null>(null);
  const complListRef = useRef<HTMLUListElement>(null);
  // Keep the highlighted row in view. One effect per dropdown update, rather
  // than a ref callback on the active row: a fresh callback on every render
  // made React re-run it — and its layout-forcing `scrollIntoView` — on every
  // keystroke for every row.
  useEffect(() => {
    if (!compl) return;
    complListRef.current?.querySelector(".active")?.scrollIntoView?.({ block: "nearest" });
  }, [compl]);
  // Source index of a space auto-inserted after `}` when a completion was
  // accepted (else null). If the very next keystroke is closing punctuation, the
  // space is removed so it reads "\cite{x}." rather than "\cite{x} .".
  const autoSpace = useRef<number | null>(null);
  const bumpCaret = useCallback(() => setCaretTick((n) => n + 1), []);

  // Snap the line-height to whole device pixels so the textarea caret and the
  // highlight <pre> share a vertical grid and don't drift apart over a long file
  // under fractional display scaling (see snapToDevicePx).
  const dpr = useDevicePixelRatio();

  const draftLines = useMemo(
    () => (loaded ? draft.split("\n") : [""]),
    [loaded, draft],
  );
  const lineCount = Math.max(1, draftLines.length);

  // In soft-wrap mode (the LaTeX viewer) a logical line can span several visual
  // rows, so the gutter can't use fixed-height rows. We measure each logical
  // line's wrapped height from a hidden, full-width mirror (`measureRef`) and
  // size the gutter cells to match, keeping the numbers aligned. `lineHeights`
  // stays empty in non-wrap mode (where fixed rows are used) and until the first
  // measure; `measureNonce` re-triggers measurement on editor resize.
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  const [measureNonce, bumpMeasure] = useReducer((n: number) => n + 1, 0);

  // Soft-wrap content width (wrap mode only): the textarea's box width less its
  // vertical scrollbar (`textareaWrapWidth`, fractional — a rounded `clientWidth`
  // wraps one row off at fractional box widths). The overlay <pre> layers live in a
  // scrollbar-free, overflow:hidden parent, so left at min-width:100% they wrap
  // at the full box width — wider than the textarea once a vertical scrollbar
  // appears — and the caret drifts from the coloured glyphs over wrapped lines.
  // Constraining the overlays to this width makes every layer wrap identically.
  const [wrapWidth, setWrapWidth] = useState<number | null>(null);
  // Last wrap width the textarea was re-broken at. A vertical scrollbar
  // appearing/disappearing as the document grows past the editor height changes
  // the wrap width WITHOUT changing the border box, so the ResizeObserver below
  // never fires and the textarea keeps its stale wrapping (WebKitGTK won't
  // re-break on its own — see the nudge there). The overlay <pre>s, sized to the
  // fresh width each keystroke, then wrap at a different width, so the
  // coloured glyphs and the last-change tint drift down a row. Tracking the
  // width here lets the wrap layout effect nudge a re-break when it shifts.
  const prevWrapWidth = useRef<number | null>(null);

  // Syntax-highlighted HTML rendered in a <pre> layer behind a transparent
  // textarea, so the file colours by type while staying fully editable. `null`
  // (unknown language or a file too large to re-highlight on each keystroke)
  // means we show the plain opaque textarea instead. A trailing newline mirrors
  // the textarea's own final empty line so scrolling stays aligned.
  const lang = useMemo(() => languageForPath(path), [path]);
  // #45a: Copilot serves this editor only for a consented local project's code
  // file, or its text file under the second opt-in; everything else stays on
  // Ollama. The backend enforces the same gates.
  const copilotEnabled = useExperimental("copilot_completion");
  const acRemote = useProjectsStore((s) => !!s.projects.find((p) => p.id === scope)?.remote);
  const acCopilot = useSettingsStore((s) => copilotServes(s.settings, copilotEnabled, scope, acRemote, lang, path));
  // Per mount, so a remount never inherits the previous mount's document versions.
  const [acEditorId] = useState(() => crypto.randomUUID());
  const acFeedback = useMemo(
    () => (acCopilot && scope ? new CopilotFeedback(scope, acEditorId) : null),
    [acCopilot, scope, acEditorId],
  );
  // Hidden pane, other file, other provider, unmount: the server forgets the
  // document. The next request after a show re-opens it with current content.
  useEffect(() => () => acFeedback?.close(), [acFeedback, path, acVisible, autocomplete?.enabled]);
  const highlighted = useMemo(
    () => (loaded ? highlight(draft, lang) : null),
    [loaded, draft, lang],
  );

  // #49 link-decoration layer (only when a ranges fn is supplied).
  const linkHtml = useMemo(
    () => (loaded && linkRanges ? decorateLinkRanges(draft, linkRanges(draft)) : null),
    [loaded, draft, linkRanges],
  );

  // #tex-hover-preview: the previewable fragments, and the transparent layer
  // whose span boxes are their on-screen hit targets.
  const snippetRanges = useMemo(
    () => (loaded && hoverPreview ? hoverPreview.ranges(draft) : []),
    [loaded, draft, hoverPreview],
  );
  const snippetHtml = useMemo(
    () => (snippetRanges.length ? decorateSnippetRanges(draft, snippetRanges) : null),
    [draft, snippetRanges],
  );

  // #tex-command-occurrences: double-clicking a control sequence in a LaTeX file
  // marks every OTHER use of it in the same file, so "where else do I call this
  // macro" is a gesture rather than a search. State is the command's NAME (plus
  // the offset of the one under the pointer, the one left unmarked because the
  // selection already shows it), not a list of ranges: the ranges are recomputed
  // from the live draft, so an edit elsewhere in the file cannot leave stale
  // marks painted over moved text. Cleared by the next keystroke or mouse-down.
  const [cmdMark, setCmdMark] = useState<{ name: string; at: number } | null>(null);
  const occurrenceRanges = useMemo(() => {
    if (!cmdMark || lang !== "tex") return [];
    return texCommandOccurrences(draft, cmdMark.name).filter((r) => r.start !== cmdMark.at);
  }, [cmdMark, draft, lang]);
  const occurrenceHtml = useMemo(
    () => (occurrenceRanges.length ? decorateOccurrenceRanges(draft, occurrenceRanges) : null),
    [draft, occurrenceRanges],
  );

  // Keep the gutter and the overlay (highlight/link) layers aligned with the
  // textarea scroll. Reads the live textarea so it can be re-run on events that
  // move the scroll WITHOUT firing a scroll event — notably a resize.
  //
  // We translate the layers with a transform rather than setting their own
  // scrollTop/scrollLeft. A long line gives the textarea (overflow:auto) a
  // horizontal scrollbar, which shrinks its client height and inflates its max
  // scrollTop by the scrollbar thickness; the overlays (overflow:hidden) have no
  // scrollbar and a smaller max scrollTop, so mirroring the value would CLAMP at
  // the bottom and shift the whole overlay ~a line out of register. A transform
  // is not clamped to the content, so it tracks the textarea exactly even past
  // the overlay's own scroll range.
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { scrollTop, scrollLeft } = ta;
    if (gutterInnerRef.current) {
      gutterInnerRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    // Blame column + current-line inline hint scroll-lock vertically with the
    // numbers (they never shift horizontally, so translateY only).
    if (blameInnerRef.current) {
      blameInnerRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    if (blameInlineRef.current) {
      blameInlineRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    const transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    for (const ref of [
      indentLayerRef,
      highlightRef,
      linkLayerRef,
      searchLayerRef,
      changeLayerRef,
      grammarLayerRef,
      bracketLayerRef,
      unclosedLayerRef,
      snippetLayerRef,
      occurrenceLayerRef,
    ]) {
      if (ref.current) ref.current.style.transform = transform;
    }
    // The ghost layer keeps the inset/overflow:hidden model (it masks the layers
    // beneath with an opaque background, so it can't be sized to its own content
    // like the transform-synced layers); scroll it programmatically instead.
    if (ghostRef.current) {
      ghostRef.current.scrollTop = scrollTop;
      ghostRef.current.scrollLeft = scrollLeft;
    }
  }, []);

  // #viewerpos: restore the saved scroll once the file has loaded (and the
  // textarea can actually reach it), then persist subsequent scrolling. The
  // restore is one-shot so it never fights the reader after the first apply.
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (restoredScroll.current || !loaded) return;
    const ta = textareaRef.current;
    if (!ta) return;
    restoredScroll.current = true;
    if (initialScrollTop && initialScrollTop > 0) {
      ta.scrollTop = initialScrollTop;
      syncScroll();
    }
  }, [loaded, initialScrollTop, syncScroll]);

  // Throttle scroll persistence so a flick of the wheel doesn't churn the store
  // (and its debounced disk save) every frame; the trailing edge captures the
  // final resting position.
  const persistTimer = useRef<number | null>(null);
  const onScroll = () => {
    // Report BEFORE syncing the overlays, and never the other way round. When
    // this pane is scroll-linked, `reportScrollSync` reads `scrollHeight` —
    // a layout-flushing read. Running it after `syncScroll` has just written a
    // `transform` to the gutter and every overlay layer means the read has to
    // flush those pending writes first, i.e. a forced style+layout pass over
    // the whole document on every scroll event. Reading first costs nothing:
    // scrolling on its own doesn't dirty layout, so the geometry is already
    // current, and the writes then land against a clean tree.
    reportScrollSync();
    syncScroll();
    if (!onScrollPersist || !restoredScroll.current) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const top = ta.scrollTop;
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => onScrollPersist(top), 200);
  };
  useEffect(
    () => () => {
      if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  // #67 in-editor search (Ctrl/Cmd+F) and find-and-replace (Ctrl/Cmd+R). A
  // floating bar over the editor with next/previous navigation, a live match
  // count, and a case toggle; matches are painted by a transparent overlay layer
  // (`decorateSearchRanges`) aligned to the textarea exactly like the highlight/
  // link layers. Ctrl/Cmd+R opens the same bar with the replace row revealed.
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => (loaded && findOpen && query ? findMatches(draft, query, caseSensitive) : []),
    [loaded, findOpen, draft, query, caseSensitive],
  );
  const searchHtml = useMemo(
    () => (matches.length > 0 ? decorateSearchRanges(draft, matches, current) : null),
    [draft, matches, current],
  );

  // 1-based line numbers that hold a match (and the current match's line), so the
  // gutter can mark where the hits are (#67). A line number is 1 + the count of
  // newlines before the match's start offset.
  const starts = useMemo(() => lineStarts(draft), [draft]);
  const matchLineSet = useMemo(() => {
    const set = new Set<number>();
    for (const m of matches) set.add(indexedLine(starts, m.start));
    return set;
  }, [matches, starts]);
  const currentMatchLine = useMemo(() => {
    const m = matches[current];
    return m ? indexedLine(starts, m.start) : 0;
  }, [matches, current, starts]);

  // Indent guides: one hairline at the start of every indentation level the file
  // actually uses. The unit is read out of the text (`detectIndentUnit`) rather
  // than assumed, and is the same one Enter indents by, so what the reader sees
  // and what typing produces cannot disagree. Both memos are keyed on `draft`,
  // which the whole-document `highlight` pass already is — this costs a single
  // extra walk per keystroke, not a new order of work.
  const indentUnit = useMemo(() => detectIndentUnit(draft), [draft]);
  const indentHtml = useMemo(
    () =>
      loaded && INDENT_GUIDE_LANGS(lang) ? decorateIndentGuides(draft, indentUnit) : null,
    [loaded, lang, draft, indentUnit],
  );

  // TeX structure diagnostics are persistent rather than caret-local: every
  // delimiter left without a partner is red, and every logical line holding one
  // is marked in the gutter. Other editor languages keep their existing
  // behaviour. Each range carries its own hover hint, since the three mistakes
  // the scanner separates — an opening delimiter with no end, a `\begin` with no
  // `\end`, an `\end` with no `\begin` — read as different sentences and the
  // environment ones can name the environment.
  const unclosedBrackets = useMemo(() => {
    if (!loaded || lang !== "tex") return [];
    return findUnclosedTexBrackets(draft).map((range) => ({
      ...range,
      hint:
        range.problem === "unmatchedEnd"
          ? t("fileViewer.unmatchedEndHint", { env: range.env ?? "" })
          : range.env != null
            ? t("fileViewer.unclosedEnvHint", { env: range.env })
            : t("fileViewer.unclosedBracketHint"),
    }));
  }, [loaded, lang, draft, t]);
  const unclosedHtml = useMemo(
    () =>
      unclosedBrackets.length > 0
        ? decorateUnclosedBrackets(draft, unclosedBrackets)
        : null,
    [draft, unclosedBrackets],
  );
  const unclosedLineSet = useMemo(() => {
    const set = new Set<number>();
    for (const range of unclosedBrackets) {
      set.add(indexedLine(starts, range.start));
    }
    return set;
  }, [starts, unclosedBrackets]);
  const [unclosedTip, setUnclosedTip] = useState<{
    left: number;
    top: number;
    hint: string;
  } | null>(null);

  // Bracket-match highlight: whichever bracket the caret sits just before/after
  // gets its partner highlighted too (`findMatchingBracket`/`decorateBracketMatch`
  // — mirrors the search overlay). For a `.tex` file, when the plain ()[]{}
  // matcher finds nothing, fall back to `lib/viewers/tex/tex.ts`'s LaTeX-aware
  // extras: math-mode toggles (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and
  // `\begin{env}…\end{env}` structure blocks — LaTeX syntax the generic
  // matcher doesn't (and shouldn't, for every other file type) know about.
  // Re-run on every text change AND every caret move (`caretTick`, bumped by
  // `emitCaret`), reading the textarea's *live* selectionStart rather than a
  // stashed offset — the same reason `refreshCompl` does, since a keystroke
  // changes `draft` and the caret in the same tick and a stale offset would
  // highlight last render's position.
  const [bracketMatch, setBracketMatch] = useState<BracketMatch | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!loaded || !el) {
      setBracketMatch(null);
      return;
    }
    const offset = el.selectionStart;
    // For `.tex`, a caret inside a `\begin{…}`/`\end{…}` name marks the PARTNER's
    // name — checked ahead of the plain matcher, which at the name's edges would
    // otherwise pair that token's own `{`/`}` and say nothing about the partner.
    const envName = lang === "tex" ? findTexEnvNameMatch(draft, offset) : null;
    // A selection is not a caret and normally clears the overlay — with one
    // exception: the click-into-the-braces gesture selects exactly an environment
    // name, and that is precisely when the partner is worth pointing at.
    if (el.selectionStart !== el.selectionEnd) {
      const onName =
        envName != null &&
        [envName.open, envName.close].some(
          (s) => s.start === el.selectionStart && s.end === el.selectionEnd,
        );
      setBracketMatch(onName ? envName : null);
      return;
    }
    const match =
      envName ??
      findMatchingBracket(draft, offset) ??
      (lang === "tex" ? findTexDelimiterMatch(draft, offset) : null);
    setBracketMatch(match);
  }, [draft, caretTick, loaded, lang]);
  const bracketHtml = useMemo(
    () => (bracketMatch ? decorateBracketMatch(draft, bracketMatch) : null),
    [draft, bracketMatch],
  );

  // ── Git blame overlay (#blame) ─────────────────────────────────────────────
  // When `showBlame` is set, the gutter grows a per-line blame column (its own
  // inner, scroll-synced with the numbers), the caret's line gets a faint inline
  // attribution, and hovering a blame cell shows a hovercard. All read-only —
  // nothing here touches the editable textarea/highlight/save path.
  const [caretLine, setCaretLine] = useState(1);
  const [blameTip, setBlameTip] = useState<{ left: number; top: number; line: number } | null>(null);
  const effectiveLineHeight = lineHeight ?? Math.round((fontSize ?? 12) * 1.5);

  // Top offset (px, before scroll) of a 1-based line's first row. Mirrors the
  // gutter/editor 10px top padding and the wrap-mode measured `lineHeights`.
  const lineTop = useCallback(
    (line: number) => {
      let top = 10; // `.file-viewer-highlight/-editor` padding-top
      const idx = Math.max(0, line - 1);
      if (wrap && lineHeights.length) {
        for (let i = 0; i < idx && i < lineHeights.length; i++) top += lineHeights[i];
      } else {
        top += idx * effectiveLineHeight;
      }
      return top;
    },
    [wrap, lineHeights, effectiveLineHeight],
  );

  const caretBlame = showBlame ? blame?.get(caretLine) : undefined;

  // Age-tint a blame cell: newer commits are more saturated, decaying with age
  // so the column reads as a heat-map of recent activity. No tint for
  // uncommitted/unknown lines.
  const blameTint = useCallback((b: BlameLine | undefined): string | undefined => {
    if (!b || isUncommitted(b) || !b.author_time) return undefined;
    const ageDays = Math.max(0, (Date.now() / 1000 - b.author_time) / 86400);
    const a = 0.16 * Math.exp(-ageDays / 180);
    if (a < 0.01) return undefined;
    return `rgba(120, 150, 220, ${a.toFixed(3)})`;
  }, []);

  const onBlameMove = useCallback(
    (e: React.MouseEvent) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>(".file-viewer-blame-line");
      const line = cell ? Number(cell.dataset.line) : 0;
      const b = line ? blame?.get(line) : undefined;
      if (!cell || !b || isUncommitted(b)) {
        setBlameTip(null);
        return;
      }
      setBlameTip({ left: e.clientX, top: e.clientY, line });
    },
    [blame],
  );

  // Keep the current index in range as the draft (and so the match set) changes.
  useEffect(() => {
    if (current > 0 && current >= matches.length) {
      setCurrent(matches.length > 0 ? matches.length - 1 : 0);
    }
  }, [matches.length, current]);

  // Place the textarea selection on match `index` and scroll its line to roughly
  // the middle of the view. Focus stays in the find input so Enter keeps cycling;
  // the overlay's `current` highlight shows where we are. The line-based scroll
  // mirrors the SyncTeX `gotoLine` math (approximate under soft-wrap, exact else).
  const revealMatch = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      const m = matches[index];
      if (!el || !m) return;
      el.selectionStart = m.start;
      el.selectionEnd = m.end;
      const line = indexedLine(starts, m.start); // 1-based
      // Wrap-aware vertical offset, mirroring the SyncTeX `gotoLine` math: under
      // soft-wrap (the TeX viewer) a logical line's top is the SUM of the measured
      // wrapped-row heights, not `(line-1)·lineHeight`. The naive form undershoots
      // on wide-prose files and scrolled the match off-screen, so the search never
      // appeared to jump to it. `lineTop` handles both wrap and fixed-row modes.
      const target = lineTop(line) - el.clientHeight / 2 + effectiveLineHeight / 2;
      el.scrollTop = Math.max(0, target);
      syncScroll();
    },
    [matches, starts, syncScroll, lineTop, effectiveLineHeight],
  );

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (current + dir + matches.length) % matches.length;
      setCurrent(next);
      revealMatch(next);
    },
    [matches.length, current, revealMatch],
  );

  const openFind = useCallback((replace = false) => {
    const el = textareaRef.current;
    const sel =
      el && el.selectionStart !== el.selectionEnd
        ? el.value.slice(el.selectionStart, el.selectionEnd)
        : "";
    if (sel && !sel.includes("\n")) setQuery(sel);
    setFindOpen(true);
    if (replace) setReplaceOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setReplaceOpen(false);
    textareaRef.current?.focus();
  }, []);

  // Latest draft, read by closures (compile/forward-search/diff) that must see the
  // current text without re-subscribing.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Change-tint trail: tint recently typed runs with a sequential new→old colour
  // gradient that fades as typing continues. Every edit flows through `edit`,
  // which diffs old→new: the new run becomes tier 0 (newest), existing runs are
  // re-mapped through the edit so they keep tracking their characters and are
  // pushed one tier older; anything past CHANGE_TIERS or overwritten by the edit
  // drops off. `lastEditRef` lets the effect tell our own edits from a draft
  // change by another path (disk reload, undo/redo) and clear a now-stale trail.
  // Reloads go through the parent's `reset`, never `edit`, so they never light the
  // trail. A short idle decay retires the oldest run on a timer so the trail
  // fades away after typing stops. The whole feature is gated on the (default-ON)
  // `change_tint` setting.
  const changeTint = useSettingsStore((s) => s.settings?.change_tint !== false);
  // The editor's own chords (`editor*`, zoom), rebindable in Keyboard Shortcuts.
  const shortcutOverrides = useSettingsStore((s) => s.settings?.keyboard_shortcuts) as ShortcutMap | undefined;
  const changeTintRef = useRef(changeTint);
  changeTintRef.current = changeTint;
  const [changes, setChanges] = useState<ChangeRange[]>([]);
  const lastEditRef = useRef<string | null>(null);
  // Record ONE changed run in the trail. Split out of `edit` because a coupled
  // `\begin`/`\end` rename changes the document in two places at once, and
  // `editSpan` — which pares off a common prefix and suffix — can only report ONE
  // run: for the two it would hand back everything between them, tinting the
  // whole environment body. So such an edit is booked as its two real runs in
  // sequence, each against the text the previous one produced.
  const noteChangeTrail = useCallback((prevText: string, nextText: string) => {
    const span = editSpan(prevText, nextText);
    if (!span) return;
    setChanges((prev) => {
      const remapped = prev
        .map((r) => remapChangeRange(r, span))
        .filter((r): r is { start: number; end: number } => r != null);
      const merged =
        span.endNext > span.start
          ? [{ start: span.start, end: span.endNext }, ...remapped]
          : remapped;
      // newest-first → re-index so tier === age (0 = newest).
      return merged.slice(0, CHANGE_TIERS).map((r, i) => ({ ...r, tier: i }));
    });
  }, []);
  // Commit a new draft. `via` is the intermediate text an edit passed through
  // when it landed in two places — the document with only the user's own
  // keystroke in it — so the trail books "what was typed" and "what was mirrored"
  // as the two separate runs they are. Still ONE `setDraft`, so it stays one
  // undo step.
  const edit = useCallback(
    (next: string, via?: string) => {
      if (next !== draftRef.current) {
        acCandidates.current = [];
        acAbort.current?.abort();
        acAbort.current = null;
        setAcStatus(null);
        const before = draftRef.current;
        if (suggestion) {
          const inserted = next.slice(suggestion.at, suggestion.at + next.length - before.length);
          const matches = next.length > before.length && suggestion.text.startsWith(inserted) &&
            next === before.slice(0, suggestion.at) + inserted + before.slice(suggestion.at);
          recordAcOutcome(matches);
          if (matches) acFeedback?.accept(inserted);
        }
        setSuggestion((ghost) => typeThrough(before, next, ghost));
        if (changeTintRef.current) {
          const stages =
            via != null && via !== draftRef.current && via !== next ? [via, next] : [next];
          let from = draftRef.current;
          for (const stage of stages) {
            noteChangeTrail(from, stage);
            from = stage;
          }
        }
        lastEditRef.current = next;
      }
      setDraft(next);
    },
    [setDraft, noteChangeTrail, suggestion, recordAcOutcome, acFeedback],
  );

  // Where the caret and the view belong once React has re-rendered the textarea
  // with text we changed behind the user's back. Both are needed together, and
  // the SCROLL is the load-bearing half: a controlled textarea whose `value` prop
  // no longer matches the DOM is updated by assigning `.value`, which drops the
  // caret at the END of the document and scrolls there — so a mirrored rename two
  // lines into a long file threw the view to its last line on every keystroke.
  // Restoring in the layout effect below (before paint) rather than a rAF (after
  // it) is what makes the correction invisible instead of a visible bounce.
  const pendingSelRef = useRef<{ start: number; end: number } | null>(null);
  const pendingScrollRef = useRef<{ top: number; left: number } | null>(null);

  // The textarea's own change, with one LaTeX rule in front of it: renaming a
  // `\begin{env}` renames its `\end{env}` in the same keystroke (and the other
  // way round), so an environment can be retyped in place instead of leaving the
  // document briefly — or permanently — unbalanced. `syncTexEnvRename` decides
  // whether the edit was that; anything else falls through untouched (React then
  // leaves the DOM alone, since the new value is already what the user typed),
  // and either way it is ONE `edit` call, so a coupled rename is one undo step.
  const onTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      const value = el.value;
      if (lang === "tex") {
        const synced = syncTexEnvRename(draftRef.current, value, el.selectionStart);
        if (synced) {
          pendingSelRef.current = { start: synced.caret, end: synced.caret };
          pendingScrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
          // `value` is the document with only what the user typed in it — the
          // trail books that run and the mirrored one separately (see `edit`).
          edit(synced.text, value);
          return;
        }
      }
      edit(value);
    },
    [edit, lang],
  );
  // Drop a stale trail when the draft changes by some path other than our own
  // `edit` (disk reload, undo/redo), and clear it when the feature is turned off.
  useEffect(() => {
    if (lastEditRef.current !== null && draft !== lastEditRef.current) {
      setChanges([]);
      lastEditRef.current = null;
    }
  }, [draft]);
  useEffect(() => {
    if (!changeTint) setChanges([]);
  }, [changeTint]);
  // Idle decay: each keystroke resets this timer (re-runs on every `changes`
  // update), so while typing the trail stays; once typing stops it retires the
  // oldest run every CHANGE_DECAY_MS until the trail is gone.
  useEffect(() => {
    if (changes.length === 0) return;
    const id = window.setTimeout(() => {
      setChanges((prev) => prev.slice(0, -1).map((r, i) => ({ ...r, tier: i })));
    }, CHANGE_DECAY_MS);
    return () => window.clearTimeout(id);
  }, [changes]);
  const changeHtml = useMemo(
    () => (loaded && changeTint && changes.length ? decorateChangeRanges(draft, changes) : null),
    [loaded, draft, changes, changeTint],
  );

  // ── Spell-check overlay ─────────────────────────────────────────────────────
  // The dictionary's issues are resolved to ranges against the live draft (so
  // they self-heal across small edits) and underlined, with a hover tooltip.
  const [spellIssues, setSpellIssues] = useState<GrammarIssue[]>([]);
  // One status report per session for a failing/missing dictionary — an error
  // on every idle pause would be noise; markless is the steady signal.
  const spellReported = useRef(false);
  const [grammarStatus, setGrammarStatus] = useState<string | null>(null);
  const [grammarTip, setGrammarTip] = useState<
    { left: number; top: number; range: GrammarRange } | null
  >(null);
  // Close the hover tooltip on a short delay, so the pointer can travel from the
  // underlined mark up into the tooltip (to click Apply) without it vanishing.
  const grammarTipTimer = useRef<number | null>(null);
  const cancelGrammarTipClose = useCallback(() => {
    if (grammarTipTimer.current != null) {
      window.clearTimeout(grammarTipTimer.current);
      grammarTipTimer.current = null;
    }
  }, []);
  const scheduleGrammarTipClose = useCallback(() => {
    cancelGrammarTipClose();
    grammarTipTimer.current = window.setTimeout(() => setGrammarTip(null), 250);
  }, [cancelGrammarTipClose]);
  useEffect(() => () => cancelGrammarTipClose(), [cancelGrammarTipClose]);

  const grammarRanges = useMemo(
    () => (loaded && spellIssues.length ? resolveGrammarRanges(draft, spellIssues) : []),
    [loaded, draft, spellIssues],
  );
  const grammarHtml = useMemo(
    () => (grammarRanges.length ? decorateGrammarRanges(draft, grammarRanges) : null),
    [draft, grammarRanges],
  );

  // Re-apply the scroll transform whenever an overlay layer's presence changes.
  // syncScroll only runs on scroll events and the one-shot restore, but the
  // change trail (and the search layer) mounts lazily — only once there's
  // an edit or an active find. A layer that first mounts while the textarea is
  // already scrolled starts at translate(0,0), i.e. `scrollTop` px too low, and
  // stays out of register until the next scroll. Syncing on mount pins it to the
  // current offset immediately. useLayoutEffect so it lands before paint.
  useLayoutEffect(() => {
    syncScroll();
  }, [
    loaded,
    highlighted,
    linkHtml,
    searchHtml,
    changeHtml,
    grammarHtml,
    syncScroll,
  ]);

  // Auto-dismiss a finished grammar status; keep an in-flight "…" message.
  useEffect(() => {
    if (!grammarStatus || grammarStatus.endsWith("…")) return;
    const id = window.setTimeout(() => setGrammarStatus(null), 4000);
    return () => window.clearTimeout(id);
  }, [grammarStatus]);

  // Dictionary spell check: re-check the draft a short while after the user
  // stops typing. A lookup rather than a model call, so it affords the shorter
  // debounce; marks clear the moment the feature is turned off. A missing
  // dictionary reports through the shared status line, once per session.
  useEffect(() => {
    if (!spellCheck?.enabled || !loaded) {
      setSpellIssues([]);
      // Re-arm the once-per-enable failure report: a check that fails again
      // after the chip is toggled off and on (or the dictionary changed
      // underneath) must say so again, not stay silent for the session.
      spellReported.current = false;
      return;
    }
    const id = window.setTimeout(async () => {
      try {
        const issues = await invoke<GrammarIssue[]>("spell_check", {
          text: draftRef.current,
          language: spellCheck.language ?? "",
          doc: lang === "plain" ? "" : lang,
        });
        setSpellIssues(issues);
      } catch (e) {
        setSpellIssues([]);
        if (!spellReported.current) {
          spellReported.current = true;
          setGrammarStatus(
            String(e).includes("no_dictionary")
              ? t("fileViewer.spellingUnavailable")
              : t("fileViewer.spellingFailed"),
          );
        }
      }
    }, SPELL_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
    // Primitive deps (the config object's identity changes every render) so the
    // idle-check timer isn't reset by unrelated re-renders.
  }, [spellCheck?.enabled, spellCheck?.language, loaded, draft, lang, t]);

  // A new dictionary choice gets its own failure report (the flag above only
  // resets when the chip goes off).
  useEffect(() => {
    spellReported.current = false;
  }, [spellCheck?.language]);

  // Keep the grammar overlay aligned after it mounts/changes.
  useEffect(() => {
    if (grammarHtml) syncScroll();
  }, [grammarHtml, syncScroll]);

  // Keep the bracket-match overlay aligned after it mounts (it toggles on/off as
  // the caret moves onto/off a bracket, so a freshly-mounted <pre> would
  // otherwise sit un-scrolled at translate(0,0) until the next scroll event).
  useEffect(() => {
    if (bracketHtml) syncScroll();
  }, [bracketHtml, syncScroll]);

  // This layer mounts/unmounts as the document becomes balanced. Align a fresh
  // layer immediately when the editor is already scrolled.
  useEffect(() => {
    if (unclosedHtml) syncScroll();
    else setUnclosedTip(null);
  }, [unclosedHtml, syncScroll]);

  // The indent layer mounts the moment the first line is indented — align it
  // straight away, for the reason the two layers above are aligned.
  useEffect(() => {
    if (indentHtml) syncScroll();
  }, [indentHtml, syncScroll]);

  // Apply a single issue's suggested fix: replace its resolved range with the
  // suggestion and drop the issue so its mark clears (the rest re-resolve against
  // the new draft). Leaves the caret after the inserted text.
  const applyGrammarFix = useCallback(
    (range: GrammarRange) => {
      const repl = range.issue.suggestion;
      edit(applyReplacements(draftRef.current, [{ start: range.start, end: range.end }], repl));
      setSpellIssues((prev) => prev.filter((i) => i !== range.issue));
      setGrammarTip(null);
      const caret = range.start + repl.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) el.selectionStart = el.selectionEnd = caret;
      });
    },
    [edit],
  );

  // Hit-test the grammar overlay at a screen point, returning the range under the
  // cursor (its span carries `data-gi`, an index into `grammarRanges`). Mirrors
  // the link-layer hit-test: the layer is scroll-synced over the textarea text, so
  // its span rects are the on-screen marks.
  const grammarHitAt = useCallback(
    (x: number, y: number): GrammarRange | null => {
      const layer = grammarLayerRef.current;
      if (!layer) return null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-viewer-grammar-mark")) {
        const r = span.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const gi = Number(span.dataset.gi);
          return grammarRanges[gi] ?? null;
        }
      }
      return null;
    },
    [grammarRanges],
  );

  // The textarea owns pointer events, so hover-test the scroll-aligned diagnostic
  // layer's span boxes (the same technique used for grammar marks and links).
  const unclosedTipAt = useCallback(
    (x: number, y: number): { left: number; top: number; hint: string } | null => {
      const layer = unclosedLayerRef.current;
      if (!layer) return null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-viewer-unclosed-bracket")) {
        const r = span.getBoundingClientRect();
        if (linkRectHit(r, x, y)) {
          return { left: x, top: r.top, hint: span.dataset.hint ?? "" };
        }
      }
      return null;
    },
    [],
  );

  // ── #tex-hover-preview: the hover card ────────────────────────────────────
  // The pointer resting on a fragment typesets it. Three pieces of state, and
  // the split matters: `hoveredBody` is what the POINTER is on right now (a ref,
  // because the compile queue polls it to decide whether its run is still
  // wanted, and a state read inside a closure would be the value at hover time),
  // while `preview` is what the CARD is showing.
  const [preview, setPreview] = useState<{
    body: string;
    si: number; // index into `snippetRanges`: which span the card is about
    anchor: { left: number; top: number; bottom: number };
    result: TexPreview | null; // null = still compiling
  } | null>(null);
  const hoveredBody = useRef<string | null>(null);
  const previewTimer = useRef<number | null>(null);

  // Wash the fragment under the pointer. Toggled on the element rather than by a
  // `:hover` rule, because the layer takes no pointer events and an element that
  // is never hit-tested is never `:hover`ed — and rather than by re-rendering the
  // layer with the index in it, which would rebuild the whole document's HTML on
  // every pointer move. A stale ref left by a re-render is harmless: removing a
  // class from a detached node does nothing, and the next move re-marks.
  const hoveredSpan = useRef<HTMLElement | null>(null);
  const markHoveredSpan = useCallback((el: HTMLElement | null) => {
    if (hoveredSpan.current === el) return;
    hoveredSpan.current?.classList.remove("is-hovered");
    hoveredSpan.current = el;
    el?.classList.add("is-hovered");
  }, []);

  // Mark the fragment the CARD is showing — a stronger mark than the pointer
  // wash, and tied to the card rather than the pointer: the wash says "this is
  // previewable", this says "this is what you are looking at", and the two
  // differ for the whole dwell before a compile lands. Toggled as a class for
  // the same reason as the wash, but found by INDEX rather than kept as a node:
  // a keystroke rebuilds the layer (the card stays open — only leaving the
  // fragment closes it), which would detach the marked span and leave the open
  // card pointing at unmarked source. Re-finding the span whenever the layer's
  // HTML changes, and only while the fragment still reads as the card's body,
  // keeps the mark on the text for as long as the card is honest about it.
  const previewedSpan = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let el: HTMLElement | null = null;
    if (preview && snippetHtml != null) {
      const range = snippetRanges[preview.si];
      if (range && draft.slice(range.start, range.end) === preview.body) {
        el =
          snippetLayerRef.current?.querySelector<HTMLElement>(
            `.file-viewer-tex-snippet[data-si="${preview.si}"]`,
          ) ?? null;
      }
    }
    if (previewedSpan.current === el) return;
    previewedSpan.current?.classList.remove("is-previewed");
    previewedSpan.current = el;
    el?.classList.add("is-previewed");
  }, [preview, snippetHtml, snippetRanges, draft]);

  const cancelPreviewTimer = useCallback(() => {
    if (previewTimer.current != null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
  }, []);
  const closePreview = useCallback(() => {
    cancelPreviewTimer();
    hoveredBody.current = null;
    markHoveredSpan(null);
    setPreview(null);
  }, [cancelPreviewTimer, markHoveredSpan]);
  useEffect(() => () => cancelPreviewTimer(), [cancelPreviewTimer]);

  // Hit-test the snippet layer at a screen point: its spans carry `data-si`, an
  // index into `snippetRanges`. This runs on EVERY pointer move, so it must not
  // do what the (rarer) link/grammar hit-tests do — measure every span in the
  // layer — which on a page of equations is hundreds of getBoundingClientRect
  // calls per move. Instead the layer is hit-testable (see its pointer-events
  // note in viewers.css: the textarea above it still receives every real event)
  // and one `elementsFromPoint` asks the engine, which already knows the answer.
  // Plural, because `elementFromPoint` would only ever return the textarea on top.
  const snippetHitAt = useCallback(
    (x: number, y: number): { range: TexSnippetRange; si: number; rect: DOMRect; span: HTMLElement } | null => {
      const layer = snippetLayerRef.current;
      if (!layer) return null;
      if (typeof document.elementsFromPoint === "function") {
        for (const el of document.elementsFromPoint(x, y)) {
          if (el === layer) break; // reached the layer itself: no span here
          if (!(el instanceof HTMLElement) || !layer.contains(el)) continue;
          if (!el.classList.contains("file-viewer-tex-snippet")) continue;
          const si = Number(el.dataset.si);
          const range = snippetRanges[si];
          return range ? { range, si, rect: el.getBoundingClientRect(), span: el } : null;
        }
        return null;
      }
      // jsdom lays nothing out and has no elementsFromPoint; keep the measured
      // scan so the tests exercise the same downstream path.
      for (const span of layer.querySelectorAll<HTMLElement>(".file-viewer-tex-snippet")) {
        const r = span.getBoundingClientRect();
        if (linkRectHit(r, x, y)) {
          const si = Number(span.dataset.si);
          const range = snippetRanges[si];
          if (range) return { range, si, rect: r, span };
        }
      }
      return null;
    },
    [snippetRanges],
  );


  const updateSnippetHover = useCallback(
    (x: number, y: number) => {
      if (!hoverPreview) return;
      const hit = snippetHitAt(x, y);
      if (!hit) {
        // Leaving the fragment closes the card AND cancels the pending compile —
        // a preview nobody is waiting for is the one case this feature must not
        // pay the engine for.
        if (hoveredBody.current != null) closePreview();
        return;
      }
      markHoveredSpan(hit.span);
      const body = draftRef.current.slice(hit.range.start, hit.range.end);
      // The same fragment: the card is already open (or on its way) and must not
      // be re-anchored under the pointer as it drifts across the formula.
      if (hoveredBody.current === body) return;
      cancelPreviewTimer();
      hoveredBody.current = body;
      const at = { left: hit.rect.left, top: hit.rect.top, bottom: hit.rect.bottom };
      const cached = hoverPreview.cached(body);
      if (cached) {
        setPreview({ body, si: hit.si, anchor: at, result: cached });
        return;
      }
      setPreview(null);
      previewTimer.current = window.setTimeout(() => {
        previewTimer.current = null;
        if (hoveredBody.current !== body) return;
        setPreview({ body, si: hit.si, anchor: at, result: null });
        void hoverPreview
          .render(body, () => hoveredBody.current === body)
          .then((out) => {
            if (hoveredBody.current !== body || !out) return;
            setPreview((cur) => (cur && cur.body === body ? { ...cur, result: out } : cur));
          });
      }, HOVER_PREVIEW_DWELL_MS);
    },
    [hoverPreview, snippetHitAt, cancelPreviewTimer, closePreview, markHoveredSpan],
  );

  // Replace the current match (#67). We re-place the textarea selection on the
  // match first so the change history records a single, intelligible edit, then
  // splice `replaceWith` in via setDraft. The match set recomputes on the new
  // draft; the live `current` clamp keeps the index in range, leaving the next
  // occurrence selected so repeated Replace walks through them.
  const replaceCurrent = useCallback(() => {
    const m = matches[current];
    if (!m) return;
    edit(applyReplacements(draft, [m], replaceWith));
    // Put the caret just after the inserted text so a follow-up reveal lands here.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.selectionStart = el.selectionEnd = m.start + replaceWith.length;
    });
  }, [matches, current, draft, replaceWith, edit]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0) return;
    edit(applyReplacements(draft, matches, replaceWith));
  }, [matches, draft, replaceWith, edit]);

  // Reset to the first match whenever the query/case changes or the bar opens, so
  // typing jumps to the first hit. Reveal is deferred a frame so the recomputed
  // `matches` and the just-mounted overlay are in place.
  useEffect(() => {
    if (!findOpen) return;
    setCurrent(0);
    const id = requestAnimationFrame(() => revealMatch(0));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, findOpen]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // In the replace field, Enter replaces the current match (Ctrl/Cmd+Enter does
  // Replace All), and Escape closes the bar.
  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) replaceAll();
      else replaceCurrent();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // Ctrl/Cmd+F opens the find bar; Ctrl/Cmd+R opens it with the replace row
  // (both as bound: `editorFind` / `editorReplace`). Bound on the container so
  // it fires whenever focus is anywhere in the editor pane (the cursor is in
  // the tab), not only when the textarea holds focus — it catches the key as
  // it bubbles up. Ctrl/Cmd+R is also always intercepted so it never falls
  // through to the webview's page reload, which would tear down the app.
  const onContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const overrides = shortcutOverrides;
    const reload = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r";
    if (actionMatches("editorFind", overrides, e)) {
      e.preventDefault();
      openFind();
    } else if (actionMatches("editorReplace", overrides, e)) {
      e.preventDefault();
      if (replaceOpen) replaceInputRef.current?.focus();
      else openFind(true);
    } else if (reload) {
      // The webview's reload, still kept off Ctrl+R when replace moved away.
      e.preventDefault();
    }
  };

  // Re-sync the overlay layers whenever the editor is resized (window resize,
  // pane/divider drag, panel toggle). A resize can clamp the textarea's
  // scrollLeft/scrollTop without emitting a scroll event, which otherwise leaves
  // the coloured glyphs — and so the visible caret — shifted from the text. A
  // ResizeObserver on the textarea catches every cause (it is full-width, so a
  // window resize changes its box too). Guarded for jsdom, where it's absent.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // WebKitGTK quirk: a soft-wrap textarea re-breaks its lines when its box
      // shrinks but NOT when it grows, so after the editor widens the text stays
      // wrapped at the old, narrower width and leaves blank space on the right.
      // Nudge it to re-lay-out at the new width by toggling its wrap off→on within
      // a single synchronous reflow (no paint between, so no flicker; the value —
      // and thus caret/selection — is untouched).
      if (wrap) {
        ta.style.whiteSpace = "pre";
        void ta.offsetWidth;
        ta.style.whiteSpace = "";
      }
      syncScroll();
      bumpMeasure();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncScroll, loaded, wrap]);

  // Measure each logical line's wrapped height (wrap mode only) so the gutter
  // cells line up with the editor. Runs before paint to avoid a flash of
  // misaligned numbers. The mirror is sized to the textarea's exact wrap width
  // (its fractional box less the vertical scrollbar) so it wraps line-for-line.
  useLayoutEffect(() => {
    if (!wrap || !loaded) {
      setWrapWidth(null);
      prevWrapWidth.current = null;
      return;
    }
    const measure = measureRef.current;
    const ta = textareaRef.current;
    if (!measure || !ta) return;
    const cw = textareaWrapWidth(ta);
    // If the content width changed since the last measure — most often a vertical
    // scrollbar toggling as the doc crosses the editor height, which the
    // ResizeObserver can't see — force the textarea to re-break to the new width
    // with the same whiteSpace nudge used on resize (synchronous, pre-paint, so
    // no flicker and the value/caret are untouched). Keeps its wrapping in lockstep
    // with the overlay layers pinned to `cw`, so the last-change tint stays put.
    if (prevWrapWidth.current !== cw) {
      prevWrapWidth.current = cw;
      ta.style.whiteSpace = "pre";
      void ta.offsetWidth;
      ta.style.whiteSpace = "";
    }
    setWrapWidth(cw);
    measure.style.width = `${cw}px`;
    const next = Array.from(
      measure.children,
      (c) => (c as HTMLElement).offsetHeight,
    );
    setLineHeights((prev) =>
      prev.length === next.length && prev.every((h, i) => h === next[i])
        ? prev
        : next,
    );
  }, [wrap, loaded, draftLines, fontSize, lineHeight, measureNonce]);

  // Report the caret position so the LaTeX viewer can run SyncTeX forward search
  // from it. Cheap; only wired when `onCaretChange` is supplied.
  //
  // Guard on focus: WebKitGTK collapses a textarea's selection to offset 0 as it
  // loses focus and fires a spurious `select` event for that reset. Clicking the
  // Compile button blurs the editor, so without this guard that 0 would clobber
  // the caret the viewer uses for forward search — the cursor would appear to
  // jump to the top of the file and SyncTeX would look up line 1 (the preamble,
  // which has no output mapping) instead of the real caret. Only report while
  // the textarea is actually focused so a blur-time reset is ignored.
  const emitCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      if (document.activeElement === el) {
        onCaretChange?.(el.selectionStart);
        onSelectionChange?.(el.selectionStart, el.selectionEnd);
      }
      // Track the caret's line for the blame inline hint (cheap; only read).
      setCaretLine(offsetToLineCol(el.value, el.selectionStart).line);
    }
    bumpCaret();
  }, [onCaretChange, onSelectionChange, bumpCaret]);

  // Re-apply the scroll transform to the blame layers whenever they (re)mount or
  // the caret line changes: a freshly-mounted node starts at translateY(0), so
  // without this the column/inline hint would sit un-scrolled until the next
  // scroll event. syncScroll reads the live textarea scrollTop.
  useEffect(() => {
    if (showBlame) syncScroll();
  }, [showBlame, caretLine, blame, syncScroll]);

  // Publish a live caret getter so the viewer can read the *current* cursor at
  // compile time rather than relying on the last-reported snapshot. The Compile
  // button keeps focus (its onMouseDown preventDefault), so at the moment compile
  // runs `selectionStart` is the real cursor — robust even when no caret event
  // ever fired (the snapshot would still be its initial 0). Cleared on unmount so
  // a stale closure can't outlive the editor.
  useEffect(() => {
    if (!caretApiRef) return;
    caretApiRef.current = () => textareaRef.current?.selectionStart ?? null;
    return () => {
      caretApiRef.current = null;
    };
  }, [caretApiRef]);

  // Imperative editing API for a toolbar (the Markdown viewer). `applyEdit` runs
  // a pure transform on the current value+selection and commits it through
  // `edit`; the requested selection (and the view it was made in) is stashed in
  // the pending refs above and restored by the layout effect below once React has
  // re-rendered the textarea with the new value.
  useEffect(() => {
    if (!editorApiRef) return;
    editorApiRef.current = {
      applyEdit: (fn) => {
        const el = textareaRef.current;
        const start = el?.selectionStart ?? draftRef.current.length;
        const end = el?.selectionEnd ?? start;
        const res = fn(draftRef.current, start, end);
        pendingSelRef.current = { start: res.selStart, end: res.selEnd };
        if (el) pendingScrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
        el?.focus();
        edit(res.value);
      },
    };
    return () => {
      editorApiRef.current = null;
    };
  }, [editorApiRef, edit]);
  // Put the caret and the view back where the edit was made. Scroll first, then
  // selection: assigning `.value` has already thrown the textarea to the end of
  // the document, and the overlay layers (highlight/link/change) are re-aligned
  // by hand rather than left to the scroll event, which arrives a frame later —
  // i.e. after the paint this effect exists to get right.
  useLayoutEffect(() => {
    const sel = pendingSelRef.current;
    const view = pendingScrollRef.current;
    pendingSelRef.current = null;
    pendingScrollRef.current = null;
    if (!sel) return;
    const el = textareaRef.current;
    if (!el) return;
    if (view) {
      el.scrollTop = view.top;
      el.scrollLeft = view.left;
    }
    el.selectionStart = sel.start;
    el.selectionEnd = sel.end;
    if (view) syncScroll();
  }, [draft, syncScroll]);

  // SyncTeX reverse search: on a new `gotoLine` nonce, place the caret at the
  // target line/column and scroll it to roughly the middle of the view. SyncTeX
  // reports a column (0 when it has none); we offset into the line by it, clamped
  // to the line's end so a stale column can't spill onto the next line.
  useEffect(() => {
    if (!gotoLine || !loaded) return;
    const el = textareaRef.current;
    if (!el) return;
    const text = draftRef.current;
    const lineStart = lineStartOffset(text, gotoLine.line);
    let offset = lineStart;
    if (gotoLine.column && gotoLine.column > 1) {
      const nl = text.indexOf("\n", lineStart);
      const lineEnd = nl === -1 ? text.length : nl;
      offset = Math.min(lineStart + (gotoLine.column - 1), lineEnd);
    }
    el.focus();
    el.selectionStart = el.selectionEnd = offset;
    // Light the target line in the gutter straight away: assigning selectionStart
    // fires no `select` event, so `emitCaret` never runs and the caret-line
    // highlight would otherwise stay on wherever the cursor last was.
    setCaretLine(gotoLine.line);
    // Centre the target line's visual top. `lineTop` accounts for the gutter's
    // 10px padding and, under soft-wrap (the LaTeX editor), the measured per-line
    // wrapped heights — so a target below several wrapped lines lands centred
    // instead of drifting up a row per wrap, which the old (line-1)·lineHeight
    // math got wrong for exactly the wide-prose files reverse search runs on.
    const target = lineTop(gotoLine.line) - el.clientHeight / 2 + effectiveLineHeight / 2;
    el.scrollTop = Math.max(0, target);
    syncScroll();
    onGotoApplied?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoLine?.nonce, loaded]);

  const dismissSuggestion = useCallback(() => {
    acCandidates.current = [];
    const el = textareaRef.current;
    if (el) acDismissed.current = { draft: draftRef.current, caret: el.selectionStart };
    recordAcOutcome(false);
    acAbort.current?.abort();
    acAbort.current = null;
    setSuggestion(null);
    setAcStatus(null);
  }, [recordAcOutcome]);

  // Cancel on hiding, disabling, switching document/context/default mode, and unmount.
  useEffect(() => {
    dismissSuggestion();
    return dismissSuggestion;
  }, [acVisible, autocomplete?.enabled, path, scope, autocomplete?.preferred, autocomplete?.preferredProse, autocomplete?.mode, acEndpoint, contextFiles, acCopilot, dismissSuggestion]);

  // External changes (reload / undo) bypass edit(). Invalidate their generation.
  useEffect(() => {
    acAbort.current?.abort();
    acAbort.current = null;
    setAcStatus(null);
    acCandidates.current = [];
    if (draft !== lastEditRef.current) {
      recordAcOutcome(false);
      setSuggestion(null);
    }
  }, [draft, recordAcOutcome]);

  const requestCompletion = useCallback(async (opts?: { auto?: boolean; mode?: AutocompleteMode; candidate?: number }) => {
    const auto = opts?.auto === true;
    const mode = opts?.mode ?? acMode;
    const el = textareaRef.current;
    if (!el || !autocomplete?.enabled || !acVisible || el.selectionStart !== el.selectionEnd) return;
    if (auto && document.activeElement !== el) return;
    const caret = el.selectionStart;
    const snapshot = draftRef.current;
    if (auto && acDismissed.current?.draft === snapshot && acDismissed.current.caret === caret) return;
    const version = acDocumentVersion.current;
    acDismissed.current = null;
    const { prefix } = completionWindow(snapshot, caret);
    if (auto && prefix.replace(/\s+/g, "").length < 3) return;
    recordAcOutcome(false);
    acCandidates.current = [];
    acCandidate.current = opts?.candidate ?? 0;
    const candidate = acCandidate.current;
    acAbort.current?.abort();
    const ctl = new AbortController();
    acAbort.current = ctl;
    setSuggestion(null);
    setAcStatus(acCopilot ? t("fileViewer.copilotStatus") : t("fileViewer.autocompleteStatus", { mode: acModeLabel(mode, t) }));
    const publish = (candidates: CompletionCandidate[]) => {
      if (ctl.signal.aborted || acDocumentVersion.current !== version || draftRef.current !== snapshot ||
          el.selectionStart !== caret || el.selectionEnd !== caret) return;
      // Copilot returns its alternatives at once; Alt+[/] walks that list.
      if (acCopilot) acCandidates.current = candidates;
      const item = candidates[0];
      acOutcome.current = item ? { model: `${item.provider}/${item.model ?? item.provider}`, mode: acCopilot ? "copilot" : item.mode ?? mode } : null;
      setSuggestion(item ? { text: item.text, at: item.at, candidate: item } : null);
      if (item) setAcStatus(null);
    };
    try {
      const tabs = useTabsStore.getState();
      const context = (signal: AbortSignal) => completionContext({
        path, root: acProjectDir, draft: snapshot,
        openPaths: (tabs.tabsByScope[scope ?? "root"] ?? tabs.tabs)
          .filter((tab) => (!tab.scope || tab.scope === (scope ?? "root")) &&
            ["text", "markdown", "tex", "texworkspace"].includes(tab.viewer ?? ""))
          .flatMap((tab) => tab.embedPath ? [tab.embedPath] : []),
        manual: contextFiles.map((f) => ({ name: f.rel, content: f.content })),
        keys: lang === "tex" ? [
          ...[...snapshot.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]),
          ...(texCompletions?.labels.map((l) => l.key) ?? []),
          ...(texCompletions?.cites.map((c) => c.key) ?? []),
        ].join("\n") : undefined,
        read: (file) => readFileText(file, scope), signal,
      });
      const provider: CompletionProvider = acCopilot && scope ? new CopilotCompletionProvider({
        projectId: scope, editor: acEditorId, automatic: auto,
        tabSize: indentUnit.width || 4, insertSpaces: !indentUnit.text.startsWith("\t"),
      }) : new OllamaCompletionProvider({
        endpoint: acEndpoint, scope: scope ?? undefined, preferred: autocomplete.preferred,
        preferredProse: autocomplete.preferredProse, mode, candidate, context,
      }, acCache.current);
      const result = await provider.complete({
        path, text: snapshot, caret, language: lang, version,
      }, ctl.signal, publish);
      if (ctl.signal.aborted) return;
      setAcStatus(result.length || auto ? null : t("fileViewer.noSuggestion"));
    } catch (e) {
      if (ctl.signal.aborted) return;
      acOutcome.current = null;
      setSuggestion(null);
      const reason = String(e);
      if (reason.includes("copilot_cancelled") || reason.includes("copilot_stale_document")) { setAcStatus(null); return; }
      // Sign-in and setup problems would otherwise be invisible with automatic
      // suggestions on, so those two are shown even for an automatic request.
      const setup = reason.includes("copilot_not_signed_in") ? "fileViewer.copilotNotSignedIn"
        : reason.includes("copilot_not_installed") ? "fileViewer.copilotNotInstalled" : null;
      setAcStatus(setup ? t(setup) : auto ? null : t(reason.includes("not_running")
        ? "fileViewer.autocompleteUnavailable"
        : acCopilot ? "fileViewer.copilotFailed" : "fileViewer.autocompleteFailed"));
    } finally {
      ctl.abort();
      if (acAbort.current === ctl) acAbort.current = null;
    }
  }, [autocomplete, lang, acMode, contextFiles, acVisible, acEndpoint, path, scope, acProjectDir, texCompletions, recordAcOutcome, t, acCopilot, acEditorId, indentUnit]);

  // #45 automatic suggestions: when the per-type toggle is on, request a
  // completion a short while after the user stops typing. Re-runs on each draft
  // change; the cleanup clears the prior timer, so only an idle pause fires it.
  // Skipped while a suggestion is already showing or the \ref/\cite dropdown is
  // open. The focus/caret/context guards live in `requestCompletion`.
  useEffect(() => {
    if (!autocomplete?.enabled || !loaded || !acVisible) return;
    if (suggestion || compl) return;
    const id = window.setTimeout(() => void requestCompletion({ auto: true }), AUTO_AC_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [autocomplete?.enabled, loaded, draft, suggestion, compl, requestCompletion, acVisible]);

  // The ghost mounts fresh (scrollTop 0) each time a suggestion appears; align it
  // to the editor's current scroll so the inserted preview lands at the caret.
  useEffect(() => {
    if (suggestion) syncScroll();
  }, [suggestion, syncScroll]);

  useEffect(() => acFeedback?.show(suggestion?.candidate), [suggestion, acFeedback]);

  const acceptSuggestion = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !suggestion) return;
    const at = suggestion.at;
    const next = draft.slice(0, at) + suggestion.text + draft.slice(at);
    edit(next);
    const caret = at + suggestion.text.length;
    setSuggestion(null);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [suggestion, draft, edit]);

  // #45 partial accept (→ Right arrow): insert only the next "word" of the pending
  // suggestion and keep the remainder ghosted, so the user can walk a long
  // suggestion in word-sized steps. A word = any leading whitespace (including a
  // newline + indentation) plus the following run of non-space characters.
  const acceptWord = useCallback((line = false) => {
    const el = textareaRef.current;
    if (!el || !suggestion) return;
    const { text, at } = suggestion;
    const m = text.match(/^\s*\S+/);
    const take = line ? completionLineLength(text) : m ? m[0].length : text.length;
    const chunk = text.slice(0, take);
    const rest = text.slice(take);
    const next = draft.slice(0, at) + chunk + draft.slice(at);
    edit(next);
    const caret = at + chunk.length;
    // Keep the rest ghosted at the new caret; clear once it's fully consumed.
    setSuggestion(rest ? { ...suggestion, text: rest, at: caret } : null);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [suggestion, draft, edit]);

  // \ref/\cite completion: cap the dropdown so a huge .bib can't render
  // thousands of rows; the prefix filter usually narrows it well below this.
  const COMPL_LIMIT = 80;

  // Recompute the completion dropdown for the current caret. No-ops (closes the
  // dropdown) unless `texCompletions` is wired and the collapsed caret sits in a
  // recognised \ref/\cite argument. Items are prefix-then-substring ranked; the
  // highlighted index is preserved while the same token is being extended.
  const refreshCompl = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !texCompletions) { setCompl(null); return; }
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) { setCompl(null); return; }
    if (caret === complClosedAt.current) return; // suppressed at this exact caret
    complClosedAt.current = -1;
    const ctx = findTexComplAt(draft, caret);
    if (!ctx) { complSession.current = null; setCompl(null); return; }
    // One token, one session: the candidate list (which parses the draft) and
    // the mirror layout (which lays out everything before the caret) are both
    // functions of the document OUTSIDE the token being typed, so they are
    // computed when the dropdown opens and reused for every keystroke that only
    // extends or shortens that token. "Outside the token is unchanged" is
    // checked literally — same family, same start, and the text before and after
    // the token byte-identical — so an edit anywhere else starts a fresh
    // session rather than trusting a stale one.
    const prev = complSession.current;
    const session =
      prev &&
      prev.kind === ctx.kind &&
      prev.start === ctx.start &&
      draft.length - ctx.end === prev.suffix.length &&
      draft.startsWith(prev.prefix) &&
      draft.endsWith(prev.suffix)
        ? prev
        : {
            kind: ctx.kind,
            start: ctx.start,
            prefix: draft.slice(0, ctx.start),
            suffix: draft.slice(ctx.end),
            candidates: texCompletionsFor(texCompletions, draft, ctx.kind),
            mirror: textareaCaretMirrorOffsets(el, ctx.start),
          };
    complSession.current = session;
    const q = ctx.query.toLowerCase();
    let items: TexComplItem[];
    if (ctx.kind === "cite") {
      items = (session.candidates as BibEntry[])
        .filter(
          (e) =>
            !q ||
            e.key.toLowerCase().includes(q) ||
            e.title?.toLowerCase().includes(q) ||
            e.author?.toLowerCase().includes(q),
        )
        .map((e) => ({ value: e.key, detail: citeDetail(e) }));
    } else if (ctx.kind === "cmd") {
      // #245: a command is matched by PREFIX only. A substring match over a table
      // of two hundred names offers `\varepsilon` for `\ps`, which is noise on
      // every keystroke — a key list is browsed, a command name is typed.
      items = (session.candidates as TexCommandEntry[])
        .filter((c) => !q || c.name.toLowerCase().startsWith(q))
        .map((c) => ({
          value: c.name,
          // The signature, not a description: it is the one thing about a command
          // that is not in its name, and it needs no translation.
          detail: c.args > 0 ? "{…}".repeat(c.args) : undefined,
          local: c.local,
          entry: c,
        }));
    } else if (ctx.kind === "env") {
      items = (session.candidates as TexEnvEntry[])
        .filter((e) => !q || e.name.toLowerCase().includes(q))
        .map((e) => ({ value: e.name, detail: e.seed, local: e.local, entry: e }));
    } else {
      items = (session.candidates as TexLabelEntry[])
        .filter(
          (l) => !q || l.key.toLowerCase().includes(q) || l.section?.toLowerCase().includes(q),
        )
        .map((l) => ({ value: l.key, detail: l.section }));
    }
    if (q) {
      items.sort(
        (a, b) =>
          (a.value.toLowerCase().startsWith(q) ? 0 : 1) -
          (b.value.toLowerCase().startsWith(q) ? 0 : 1),
      );
    }
    items = items.slice(0, COMPL_LIMIT);
    if (items.length === 0) { setCompl(null); return; }
    // Re-anchoring is the cheap half: the textarea's screen rect and scroll.
    const pos = textareaMirrorToViewport(el, session.mirror);
    setCompl((prev) => {
      const same =
        prev != null &&
        prev.ctx.kind === ctx.kind &&
        prev.ctx.start === ctx.start &&
        prev.ctx.query === ctx.query;
      return { ctx, items, index: same ? Math.min(prev!.index, items.length - 1) : 0, pos };
    });
  }, [draft, texCompletions]);

  // Accept a completion (Tab): replace the token with the key. When it's the
  // last/only key in the braces, close them if needed, jump the caret OUT past
  // `}`, and add a trailing space (tracked in `autoSpace` for smart removal). For
  // a multi-key list (\cite{a,b}) it stays just after the inserted key instead.
  // `complClosedAt` keeps the dropdown from instantly reopening on that caret.
  const acceptCompl = useCallback(
    (item: TexComplItem) => {
      const el = textareaRef.current;
      if (!el || !compl) return;
      const value = item.value;
      // #245: a command and an environment are not keys, so neither is accepted
      // the way one is — the decision (seed the arguments, open the block) is a
      // pure function in `tex.ts`, and this only splices its answer in.
      if (compl.ctx.kind === "cmd" || compl.ctx.kind === "env") {
        const applied =
          compl.ctx.kind === "cmd"
            ? insertTexCommand(draft, compl.ctx, (item.entry as TexCommandEntry) ?? { name: value, args: 0 })
            : insertTexEnvironment(draft, compl.ctx, (item.entry as TexEnvEntry) ?? { name: value });
        autoSpace.current = null;
        complClosedAt.current = applied.caret;
        setCompl(null);
        edit(applied.text);
        requestAnimationFrame(() => {
          el.focus();
          el.selectionStart = el.selectionEnd = applied.caret;
        });
        return;
      }
      const { start, end } = compl.ctx;
      const head = draft.slice(0, start) + value;
      const rest = draft.slice(end);
      const closeRel = rest.indexOf("}");
      const beforeClose = closeRel >= 0 ? rest.slice(0, closeRel) : rest;
      let next: string;
      let caret: number;
      if (/\S/.test(beforeClose)) {
        // More keys remain inside the braces → keep the caret after this key.
        next = head + rest;
        caret = head.length;
        autoSpace.current = null;
      } else {
        // Last/only key: drop any spaces up to the brace, ensure a closing `}`,
        // then a single space, reusing one already after `}` if present.
        const afterBrace = closeRel >= 0 ? rest.slice(closeRel + 1) : rest;
        const sep = /^\s/.test(afterBrace) ? "}" : "} ";
        next = head + sep + afterBrace;
        autoSpace.current = head.length + 1; // index of the space right after `}`
        caret = head.length + 2; // past `}` and the space
      }
      complClosedAt.current = caret;
      setCompl(null);
      edit(next);
      requestAnimationFrame(() => {
        el.focus();
        el.selectionStart = el.selectionEnd = caret;
      });
    },
    [compl, draft, edit],
  );

  const closeCompl = useCallback(() => {
    const el = textareaRef.current;
    complClosedAt.current = el ? el.selectionStart : -1;
    setCompl(null);
  }, []);

  // Re-detect the completion context on every text change and caret move.
  useEffect(() => {
    refreshCompl();
  }, [draft, caretTick, refreshCompl]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the IME own composition keys; input events validate any type-through.
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    if (onFollowLink && (e.ctrlKey || e.metaKey) && lastMouse.current) {
      updateLinkHover(lastMouse.current.x, lastMouse.current.y, true);
    }

    // The occurrence marks answer one gesture and outlive it by nothing: the
    // next real keystroke drops them. Bare modifiers don't count — holding Ctrl
    // to copy the selection the double-click just made must not wipe them.
    if (cmdMark && !MODIFIER_KEYS.has(e.key)) setCmdMark(null);

    // Smart space after accepting a \ref/\cite: the first real keystroke decides
    // the auto space's fate. Closing punctuation right after it replaces it
    // (\cite{x}. not \cite{x} .); any other character commits it. Bare modifier
    // presses (e.g. Shift for `?`) are ignored so they don't drop the space.
    if (autoSpace.current != null && !MODIFIER_KEYS.has(e.key)) {
      const el = textareaRef.current;
      const at = autoSpace.current;
      if (
        e.key.length === 1 &&
        NO_SPACE_BEFORE.has(e.key) &&
        el &&
        el.selectionStart === el.selectionEnd &&
        el.selectionStart === at + 1
      ) {
        e.preventDefault();
        autoSpace.current = null;
        const next = draft.slice(0, at) + e.key + draft.slice(at + 1);
        edit(next);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = at + 1;
        });
        return;
      }
      autoSpace.current = null; // any other real key commits the space
    }

    // TeX dropdown: arrows move the highlight, Enter/Tab accept, Esc closes.
    // Handled first so its accept keys do not become a newline or indentation.
    if (compl && compl.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCompl((c) => (c ? { ...c, index: (c.index + 1) % c.items.length } : c));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCompl((c) =>
          c ? { ...c, index: (c.index - 1 + c.items.length) % c.items.length } : c,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptCompl(compl.items[compl.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeCompl();
        return;
      }
    }

    // #45: Ctrl+Space requests a suggestion. While a ghost suggestion is showing:
    //  - Tab accepts the whole suggestion,
    //  - Shift+Tab toggles the completion-length mode (Sentence → Block → Scope)
    //    and re-requests in it,
    //  - → (Right) accepts only the next word (repeat to walk word-by-word),
    //  - Esc dismisses.
    const overrides = shortcutOverrides;
    if (actionMatches("editorAutocomplete", overrides, e)) {
      e.preventDefault();
      void requestCompletion();
      return;
    }
    if (suggestion) {
      // Alt+[ / Alt+]. The US key positions count too: on German QWERTZ the
      // brackets sit behind AltGr, so Alt+Ü / Alt++ is the reachable chord.
      const bracket = e.key === "[" || e.code === "BracketLeft" ? "[" : e.key === "]" || e.code === "BracketRight" ? "]" : null;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && bracket) {
        e.preventDefault();
        if (acCopilot) {
          const items = acCandidates.current;
          if (items.length > 1 && items[0].version === acDocumentVersion.current) {
            recordAcOutcome(false);
            acCandidate.current = (acCandidate.current + (bracket === "]" ? 1 : items.length - 1)) % items.length;
            const item = items[acCandidate.current];
            acOutcome.current = { model: `${item.provider}/${item.model ?? item.provider}`, mode: "copilot" };
            setSuggestion({ text: item.text, at: item.at, candidate: item });
          }
        } else void requestCompletion({ candidate: (acCandidate.current + (bracket === "]" ? 1 : 2)) % 3 });
        return;
      }
      if (e.key === "ArrowRight" && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        acceptWord(true);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey && acCopilot) {
          // The language server has no length modes; nothing to switch.
        } else if (e.shiftKey) {
          // Toggle to the next mode and re-request, so the ghost switches to that
          // mode's completion in place.
          const m = nextAcMode(acMode);
          setAcMode(m);
          void requestCompletion({ mode: m });
        } else {
          acceptSuggestion();
        }
        return;
      }
      // Plain Right arrow accepts the next word; modified Right (select/word-move)
      // falls through and dismisses so native navigation still works.
      if (e.key === "ArrowRight" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        acceptWord();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissSuggestion();
        return;
      }
      // Let input events consume matching text (including paste and IME).
      if (Array.from(e.key).length !== 1 && e.key !== "Enter" && !MODIFIER_KEYS.has(e.key)) dismissSuggestion();
    }

    if (!MODIFIER_KEYS.has(e.key) && (e.key.startsWith("Arrow") ||
        ["Home", "End", "PageUp", "PageDown", "Escape"].includes(e.key))) dismissSuggestion();

    // #46 undo/redo (Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z unless rebound).
    if (actionMatches("editorRedo", overrides, e)) {
      e.preventDefault();
      redo?.();
      return;
    }
    if (actionMatches("editorUndo", overrides, e)) {
      e.preventDefault();
      undo?.();
      return;
    }

    if (actionMatches("editorSave", overrides, e)) {
      e.preventDefault();
      save();
      return;
    }
    // Text-size: Ctrl/Cmd +/-/0 on any layout. stopPropagation keeps the
    // window-level UI zoom (useKeyboard / DetachedApp) from also zooming the
    // whole window — the editor zooms its text, as an agent pane zooms its font.
    const zoom = zoomFor(e, overrides);
    if (zoom) {
      e.preventDefault();
      e.stopPropagation();
      (zoom === "in" ? incFont : zoom === "out" ? decFont : resetFont)?.();
      return;
    }
    // Ctrl/Cmd+Shift+C (as bound) — comment out the touched lines, or
    // uncomment them when they already are. `%` in TeX, the language's own
    // marker elsewhere; falls through untouched in a language with no line
    // comment.
    if (actionMatches("editorComment", overrides, e)) {
      const marker = lineCommentMarker(lang);
      if (!marker) return;
      const toggled = applyLineComment(e.currentTarget, marker);
      if (!toggled) return;
      e.preventDefault();
      edit(toggled.value);
      const ta = e.currentTarget;
      requestAnimationFrame(() => {
        ta.selectionStart = toggled.selStart;
        ta.selectionEnd = toggled.selEnd;
      });
      return;
    }
    // Enter, aligned with the block it continues (Python and TeX — see
    // `applyAutoIndent`). Modified Enter is left alone: Ctrl/Cmd+Enter and
    // Alt+Enter are other surfaces' gestures, and Shift+Enter is the plain
    // newline every editor keeps as the way out of a rule that guessed wrong.
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const next = applyAutoIndent(e.currentTarget, lang, indentUnit);
      if (!next) return;
      e.preventDefault();
      edit(next.value);
      const el = e.currentTarget;
      requestAnimationFrame(() => {
        el.selectionStart = next.selStart;
        el.selectionEnd = next.selEnd;
      });
      return;
    }
    if (e.key === "Tab") {
      // After a TeX completion has seeded an argument (`\\begin{}` is the
      // common case), Tab leaves that argument rather than inserting spaces.
      // A visible completion menu above already captured Tab, so it can still
      // accept its highlighted item.
      if (!e.shiftKey && lang === "tex") {
        const caret = advanceTexBraceTabStop(e.currentTarget);
        if (caret != null) {
          e.preventDefault();
          const el = e.currentTarget;
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = caret;
          });
          return;
        }
      }
      const next = applyIndent(e.currentTarget, e.shiftKey);
      if (!next) return;
      e.preventDefault();
      edit(next.value);
      const el = e.currentTarget;
      requestAnimationFrame(() => {
        el.selectionStart = next.selStart;
        el.selectionEnd = next.selEnd;
      });
    }
  };

  // After a click the textarea's caret (selectionStart) is at the click point,
  // so a Ctrl/Cmd+Click resolves the reference there. The modifier gates it so
  // ordinary clicks keep placing the caret as usual.
  // Clicking between the braces of `\begin{…}`/`\end{…}` selects the whole
  // environment name, so swapping an environment is click-and-type — and with the
  // coupled rename above, retyping it here rewrites the partner as you go. Only a
  // plain collapsed click qualifies: a drag-select, double- or shift-click has
  // already stated what it wanted selected, and a modifier click is the
  // link-follow gesture.
  const selectEnvName = (el: HTMLTextAreaElement) => {
    if (lang !== "tex" || el.selectionStart !== el.selectionEnd) return;
    const range = texEnvNameRangeAt(el.value, el.selectionStart);
    if (!range || range.end === range.start) return; // `\begin{}` — nothing to select
    el.setSelectionRange(range.start, range.end);
    emitCaret();
  };

  // #tex-command-occurrences: a double-click on a control sequence extends the
  // selection over the whole `\command` — the browser's word rules stop at the
  // backslash and hand back the letters alone — and marks every other use of it
  // in the file. A double-click on anything else (prose, a brace, `\\`) just
  // clears whatever was marked and keeps the native word selection.
  const onDoubleClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (lang !== "tex") return;
    const el = e.currentTarget;
    const cmd = texCommandAt(el.value, el.selectionStart);
    if (!cmd) {
      setCmdMark(null);
      return;
    }
    el.setSelectionRange(cmd.start, cmd.end);
    emitCaret();
    setCmdMark({ name: cmd.name, at: cmd.start });
  };

  const onClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    dismissSuggestion();
    emitCaret();
    if (e.ctrlKey || e.metaKey) {
      // Prefer the link span under the pointer: a Ctrl/⌘+click leaves the caret
      // where it was, so `selectionStart` points at the old position, not the
      // link that was clicked. Fall back to the caret for a forward-sync click
      // that landed on no link.
      if (onFollowLink) {
        const off = linkOffsetAt(e.clientX, e.clientY);
        onFollowLink(off ?? e.currentTarget.selectionStart);
      }
      return;
    }
    selectEnvName(e.currentTarget);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    lastMouse.current = { x: e.clientX, y: e.clientY };
    updateLinkHover(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    setUnclosedTip(unclosedBrackets.length ? unclosedTipAt(e.clientX, e.clientY) : null);
    updateSnippetHover(e.clientX, e.clientY);
    // Grammar tooltip: open it over a hovered mark, else schedule a close so the
    // pointer can still reach the open tooltip's Apply button.
    if (grammarRanges.length) {
      const hit = grammarHitAt(e.clientX, e.clientY);
      if (hit) {
        cancelGrammarTipClose();
        setGrammarTip({ left: e.clientX, top: e.clientY, range: hit });
      } else if (grammarTip) {
        scheduleGrammarTipClose();
      }
    }
  };

  if (error != null) return <div className="file-viewer-error">{error}</div>;
  if (!loaded) return <div className="file-viewer-loading">{t("common.loading")}</div>;

  // Ghost text: while a suggestion is pending, render the WHOLE projected
  // document — prefix + suggestion + the existing suffix shifted past it — over
  // an opaque background that masks the real layers beneath. This pushes the
  // text after the caret aside (horizontally and, for multi-line suggestions,
  // downward) instead of painting the proposal on top of it.
  const hasGhost = suggestion != null;

  // In wrap mode, pin every overlay <pre> to the textarea's content width so
  // they wrap line-for-line with it (see wrapWidth). A no-op otherwise.
  const overlayWidthStyle =
    wrap && wrapWidth != null ? { width: wrapWidth } : undefined;

  return (
    <div
      className="file-viewer-code"
      ref={wheelRef}
      onKeyDown={onContainerKeyDown}
      style={
        fontSize
          ? ({
              "--code-font-size": `${fontSize}px`,
              "--code-line-height": `${snapToDevicePx(
                lineHeight ?? Math.round(fontSize * 1.5),
                dpr,
              )}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      {/* Git-blame column (#blame). Sits left of the numbers, shares their cell
          heights (incl. wrap-mode `lineHeights`) and is scroll-locked via its own
          inner transform. Each cell shows the last author + relative date;
          uncommitted/unknown lines get a muted dot. Age-tinted like a heat-map. */}
      {showBlame && (
        <div
          className="file-viewer-blame-gutter"
          aria-hidden="true"
          onMouseMove={onBlameMove}
          onMouseLeave={() => setBlameTip(null)}
        >
          <div className="file-viewer-blame-inner" ref={blameInnerRef}>
            {Array.from({ length: lineCount }, (_, i) => {
              const b = blame?.get(i + 1);
              const h = wrap ? lineHeights[i] : undefined;
              const known = b != null && !isUncommitted(b);
              const style: React.CSSProperties = {};
              if (h != null) style.height = h;
              const tint = blameTint(b);
              if (tint) style.background = tint;
              return (
                <div
                  key={i}
                  className={`file-viewer-blame-line${known ? "" : " uncommitted"}${
                    i + 1 === caretLine ? " current" : ""
                  }`}
                  data-line={i + 1}
                  style={style}
                >
                  {known ? (
                    <>
                      <span className="fv-blame-author">{authorAbbrev(b!.author)}</span>
                      <span className="fv-blame-date">{blameRelDate(b!.author_time)}</span>
                    </>
                  ) : (
                    <span className="fv-blame-none">·</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Line-number gutter. Fixed-height rows normally; in wrap mode (the LaTeX
          viewer) a logical line can span several visual rows, so each cell is
          sized to its measured wrapped height (`lineHeights`). Lines holding a
          search match are marked, the current match brightest (#67).

          When `onToggleBreakpoint` is wired (the Python editor, #py) the cells
          become real buttons that set/clear a debug breakpoint, so the gutter
          stops being decoration and the whole column drops its `aria-hidden` —
          hiding a control from the accessibility tree would make the feature
          unreachable without a mouse. */}
      <div className="file-viewer-gutter" aria-hidden={onToggleBreakpoint ? undefined : "true"}>
        <div className="file-viewer-gutter-inner" ref={gutterInnerRef}>
          {Array.from({ length: lineCount }, (_, i) => {
            const n = i + 1;
            const h = wrap ? lineHeights[i] : undefined;
            const broken = breakpoints?.has(n) ?? false;
            const cls =
              (n === currentMatchLine
                ? "file-viewer-gutter-line current-match"
                : matchLineSet.has(n)
                  ? "file-viewer-gutter-line has-match"
                  : "file-viewer-gutter-line") +
              (n === caretLine ? " caret" : "") +
              (unclosedLineSet.has(n) ? " has-unclosed-bracket" : "") +
              (onToggleBreakpoint ? " is-breakable" : "") +
              (broken ? " has-breakpoint" : "");
            const style = h != null ? { height: h } : undefined;

            if (!onToggleBreakpoint) {
              return (
                <div key={i} className={cls} style={style}>
                  {n}
                </div>
              );
            }
            return (
              <button
                key={i}
                type="button"
                className={cls}
                style={style}
                // Keep the caret where it is: clicking the gutter sets a
                // breakpoint, it does not move the cursor or steal focus.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onToggleBreakpoint(n)}
                title={
                  broken
                    ? t("fileViewer.removeBreakpoint", { line: n })
                    : t("fileViewer.addBreakpoint", { line: n })
                }
                aria-pressed={broken}
                aria-label={
                  broken
                    ? t("fileViewer.removeBreakpoint", { line: n })
                    : t("fileViewer.addBreakpoint", { line: n })
                }
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className={`file-viewer-code-area${highlighted != null ? " highlighted" : ""}${
          linkHover ? " link-hover" : ""
        }${wrap ? " is-wrapped" : ""}${hasGhost ? " has-suggestion" : ""}`}
      >
        {/* Hidden full-width mirror used only to measure each logical line's
            wrapped height for the gutter (wrap mode). Sized to the textarea's
            content width in the layout effect; never painted. */}
        {wrap && (
          <pre className="file-viewer-gutter-measure" ref={measureRef} aria-hidden="true">
            {draftLines.map((ln, i) => (
              <div key={i} className="fv-measure-line">{ln === "" ? "\u200B" : ln}</div>
            ))}
          </pre>
        )}
        {/* Indent guides. First of the layers, so the hairlines sit behind the
            coloured glyphs rather than across them. */}
        {indentHtml != null && (
          <pre
            ref={indentLayerRef}
            className="file-viewer-indent-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: indentHtml + "\n" }}
          />
        )}
        {highlighted != null && (
          <pre
            ref={highlightRef}
            className="file-viewer-highlight"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: highlighted + "\n" }}
          />
        )}
        {bracketHtml != null && (
          <pre
            ref={bracketLayerRef}
            className="file-viewer-bracket-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: bracketHtml + "\n" }}
          />
        )}
        {unclosedHtml != null && (
          <pre
            ref={unclosedLayerRef}
            className="file-viewer-unclosed-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: unclosedHtml + "\n" }}
          />
        )}
        {changeHtml != null && (
          <pre
            ref={changeLayerRef}
            className="file-viewer-change-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: changeHtml + "\n" }}
          />
        )}
        {searchHtml != null && (
          <pre
            ref={searchLayerRef}
            className="file-viewer-search-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: searchHtml + "\n" }}
          />
        )}
        {grammarHtml != null && (
          <pre
            ref={grammarLayerRef}
            className="file-viewer-grammar-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: grammarHtml + "\n" }}
          />
        )}
        {snippetHtml != null && (
          <pre
            ref={snippetLayerRef}
            className="file-viewer-tex-snippet-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: snippetHtml + "\n" }}
          />
        )}
        {occurrenceHtml != null && (
          <pre
            ref={occurrenceLayerRef}
            className="file-viewer-occurrence-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: occurrenceHtml + "\n" }}
          />
        )}
        {linkHtml != null && (
          <pre
            ref={linkLayerRef}
            className="file-viewer-link-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: linkHtml + "\n" }}
          />
        )}
        {hasGhost && (
          <pre
            ref={ghostRef}
            className="file-viewer-ghost"
            aria-hidden="true"
            style={overlayWidthStyle}
          >
            {draft.slice(0, suggestion!.at)}
            <span className="file-viewer-ghost-text">{suggestion!.text}</span>
            {draft.slice(suggestion!.at)}
          </pre>
        )}
        <textarea
          ref={textareaRef}
          className="file-viewer-editor file-viewer-code-editor"
          value={draft}
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (!(e.ctrlKey || e.metaKey)) setLinkHover(false); emitCaret(); }}
          // Fires before the double-click that re-arms them, so a plain click
          // is what clears the occurrence marks.
          onMouseDown={() => { if (cmdMark) setCmdMark(null); }}
          onDoubleClick={onDoubleClick}
          onBlur={() => { setLinkHover(false); setLinkTip(null); setUnclosedTip(null); dismissSuggestion(); setCompl(null); closePreview(); }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => { setLinkHover(false); setLinkTip(null); setUnclosedTip(null); scheduleGrammarTipClose(); closePreview(); }}
          onClick={onClick}
          onSelect={emitCaret}
          onScroll={onScroll}
        />
        {/* Current-line blame hint (#blame): a faint, right-aligned annotation on
            the caret's line. Absolutely positioned at the line's top offset and
            scroll-locked with the blame column. */}
        {showBlame && caretBlame && !isUncommitted(caretBlame) && (
          <div
            ref={blameInlineRef}
            className="file-viewer-blame-inline"
            aria-hidden="true"
            style={{ top: lineTop(caretLine), lineHeight: `${effectiveLineHeight}px` }}
          >
            {caretBlame.author} · {blameRelDate(caretBlame.author_time)} · {caretBlame.summary}
          </div>
        )}
      </div>
      {onFollowLink && <LinkOpenHint at={linkTip} />}
      {unclosedTip && (
        <div
          className="file-viewer-unclosed-tip"
          style={{ left: unclosedTip.left, top: unclosedTip.top }}
          role="tooltip"
        >
          {unclosedTip.hint || t("fileViewer.unclosedBracketHint")}
        </div>
      )}
      {suggestion && !acStatus && (
        <div className="file-viewer-ac-status" role="status">
          {acCopilot ? t("fileViewer.copilotControls", AC_KEY_LABELS) : t("fileViewer.autocompleteControls", { ...AC_KEY_LABELS, candidate: acCandidate.current + 1 })}
        </div>
      )}
      {acStatus && (
        <div className="file-viewer-ac-status" role="status">
          {/* A trailing "…" marks an in-flight request — show a spinner. */}
          {acStatus.endsWith("…") && (
            <span className="file-viewer-ac-spinner" aria-hidden="true" />
          )}
          {acStatus}
        </div>
      )}
      {grammarStatus && (
        <div className="file-viewer-grammar-status" role="status">
          {grammarStatus.endsWith("…") && (
            <span className="file-viewer-ac-spinner" aria-hidden="true" />
          )}
          {grammarStatus}
        </div>
      )}
      {/* #tex-hover-preview: the typeset fragment, over the source. Never takes
          the pointer (`pointer-events: none` in CSS) — the card sits ON the
          text the pointer is resting on, so anything it could catch would be a
          gesture aimed at the editor underneath. It opens under the fragment and
          flips above it in the lower part of the window, the rule the remark
          card and the selection bar already flip by. */}
      {preview && (
        <div
          className={`file-viewer-tex-preview${preview.result?.error ? " is-error" : ""}`}
          role="status"
          style={
            preview.anchor.bottom > window.innerHeight * HOVER_PREVIEW_FLIP_AT
              ? {
                  left: Math.max(8, Math.min(preview.anchor.left, window.innerWidth - HOVER_PREVIEW_MAX_W - 8)),
                  bottom: window.innerHeight - preview.anchor.top + 8,
                }
              : {
                  left: Math.max(8, Math.min(preview.anchor.left, window.innerWidth - HOVER_PREVIEW_MAX_W - 8)),
                  top: preview.anchor.bottom + 8,
                }
          }
        >
          {preview.result == null ? (
            <span className="file-viewer-tex-preview-busy">
              <span className="file-viewer-tex-spinner" aria-hidden="true" />
              {t("fileViewer.texPreviewCompiling")}
            </span>
          ) : preview.result.url ? (
            <>
              {/* Half the raster's pixels: it is typeset at 4x its point size so
                  the formula stays crisp, and 2x natural is the size it is
                  actually readable at over 12px source. */}
              <img
                className="file-viewer-tex-preview-img"
                src={preview.result.url}
                alt={t("fileViewer.texPreviewAlt")}
                style={{ width: Math.min((preview.result.width ?? 0) / 2, HOVER_PREVIEW_MAX_W) }}
              />
              {preview.result.fallback && (
                <div className="file-viewer-tex-preview-note">
                  {t("fileViewer.texPreviewFallback")}
                </div>
              )}
            </>
          ) : (
            <div className="file-viewer-tex-preview-error">
              <span className="file-viewer-tex-preview-error-head">
                {t("fileViewer.texPreviewFailed")}
              </span>
              <span className="file-viewer-tex-preview-error-msg">{preview.result.error}</span>
            </div>
          )}
        </div>
      )}
      {grammarTip && (
        <div
          className={`file-viewer-grammar-tip cat-${grammarTip.range.issue.category}`}
          style={{ left: grammarTip.left, top: grammarTip.top }}
          role="tooltip"
          onMouseEnter={cancelGrammarTipClose}
          onMouseLeave={scheduleGrammarTipClose}
        >
          <div className="file-viewer-grammar-tip-cat">{grammarTip.range.issue.category}</div>
          {grammarTip.range.issue.message && (
            <div className="file-viewer-grammar-tip-msg">{grammarTip.range.issue.message}</div>
          )}
          {grammarTip.range.issue.suggestion && (
            <button
              type="button"
              className="file-viewer-grammar-tip-fix"
              // mousedown keeps the textarea from stealing focus before the click.
              onMouseDown={(e) => { e.preventDefault(); applyGrammarFix(grammarTip.range); }}
            >
              {t("fileViewer.grammarFix")} <span className="file-viewer-grammar-tip-sugg">{grammarTip.range.issue.suggestion}</span>
            </button>
          )}
          <button
            type="button"
            className="file-viewer-grammar-tip-fix"
            // mousedown keeps the textarea from stealing focus before the click.
            onMouseDown={(e) => {
              e.preventDefault();
              const word = grammarTip.range.issue.bad;
              void invoke("spell_add_word", { word }).catch(() => undefined);
              // Every mark of the same word clears — the word is now known.
              setSpellIssues((prev) => prev.filter((i) => i.bad !== word));
              setGrammarTip(null);
            }}
          >
            {t("fileViewer.addToDictionary")}
          </button>
        </div>
      )}
      {/* Blame hovercard (#blame): full attribution for the hovered gutter cell. */}
      {blameTip && (() => {
        const b = blame?.get(blameTip.line);
        if (!b || isUncommitted(b)) return null;
        return (
          <div
            className="file-viewer-blame-tip"
            style={{ left: blameTip.left, top: blameTip.top }}
            role="tooltip"
          >
            <div className="file-viewer-blame-tip-head">
              <span className="file-viewer-blame-tip-hash">{b.short}</span>
              <span className="file-viewer-blame-tip-author">{b.author}</span>
            </div>
            <div className="file-viewer-blame-tip-date">{t("fileViewer.blameAgo", { time: blameRelDate(b.author_time) })}</div>
            <div className="file-viewer-blame-tip-summary">{b.summary}</div>
          </div>
        );
      })()}
      {/* #45 context files: a button to attach project files plus chips for the
          attached ones, shown only when autocomplete is enabled for this type. */}
      {autocomplete?.enabled && !acCopilot && (
        <div className="file-viewer-ac-context">
          <button
            type="button"
            className="file-viewer-ac-context-add"
            onClick={() => setAcPicker(true)}
            title={t("fileViewer.addContextTitle")}
          >
            {t("fileViewer.addContext")}{contextFiles.length ? ` (${contextFiles.length})` : ""}
          </button>
          {contextFiles.map((f) => (
            <span key={f.path} className="file-viewer-ac-context-chip" title={f.rel}>
              {f.rel.split("/").pop()}
              <button
                type="button"
                aria-label={t("fileViewer.removeFromContext", { file: f.rel })}
                onClick={() => removeContextFile(f.path)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {acPicker && (
        <ContextFilePicker
          projectDir={acProjectDir}
          attached={contextFiles.map((f) => f.rel)}
          onPick={(rel) => void addContextFile(rel)}
          onClose={() => setAcPicker(false)}
        />
      )}
      {compl && (
        <ul
          ref={complListRef}
          className={`file-viewer-tex-compl${compl.ctx.kind === "cite" ? " is-cite" : ""}`}
          role="listbox"
          style={{ left: compl.pos.left, top: compl.pos.top + compl.pos.height }}
        >
          {compl.items.map((it, i) => (
            <li
              key={it.value + i}
              role="option"
              aria-selected={i === compl.index}
              className={`file-viewer-tex-compl-item${i === compl.index ? " active" : ""}`}
              // mousedown (not click) + preventDefault so the textarea keeps focus
              // — otherwise the blur handler would close the dropdown first.
              onMouseDown={(e) => { e.preventDefault(); acceptCompl(it); }}
              onMouseEnter={() => setCompl((c) => (c ? { ...c, index: i } : c))}
            >
              <span className="file-viewer-tex-compl-key">
                {compl.ctx.kind === "cmd" ? `\\${it.value}` : it.value}
              </span>
              {it.local && (
                <span className="file-viewer-tex-compl-local" title={t("fileViewer.complLocalTitle")}>
                  {t("fileViewer.complLocalTag")}
                </span>
              )}
              {it.detail && <span className="file-viewer-tex-compl-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {findOpen && (
        <div className="file-viewer-find" role="search">
          <div className="file-viewer-find-row">
            {/* Chevron expands/collapses the replace row from a find-only bar. */}
            <button
              className={`file-viewer-find-toggle${replaceOpen ? " active" : ""}`}
              onClick={() => setReplaceOpen((v) => !v)}
              aria-pressed={replaceOpen}
              aria-label={replaceOpen ? t("fileViewer.hideReplace") : t("fileViewer.showReplace")}
              title={replaceOpen ? t("fileViewer.hideReplace") : chordHint(t("fileViewer.showReplaceTitle"), "editorReplace")}
            >
              {replaceOpen ? "▾" : "▸"}
            </button>
            <input
              ref={findInputRef}
              className="file-viewer-find-input"
              type="text"
              value={query}
              placeholder={t("pdfViewer.findLabel")}
              aria-label={t("pdfViewer.findLabel")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKeyDown}
            />
            <span className="file-viewer-find-count" aria-live="polite">
              {matches.length > 0 ? `${current + 1}/${matches.length}` : query ? "0/0" : ""}
            </span>
            <button
              className={`file-viewer-find-btn${caseSensitive ? " active" : ""}`}
              onClick={() => setCaseSensitive((v) => !v)}
              aria-pressed={caseSensitive}
              title={t("pdfViewer.matchCaseTitle")}
              aria-label={t("pdfViewer.matchCaseTitle")}
            >
              Aa
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(-1)}
              disabled={matches.length === 0}
              title={t("pdfViewer.prevMatchTitle")}
              aria-label={t("pdfViewer.prevMatchLabel")}
            >
              ↑
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(1)}
              disabled={matches.length === 0}
              title={t("pdfViewer.nextMatchTitle")}
              aria-label={t("pdfViewer.nextMatchLabel")}
            >
              ↓
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={closeFind}
              title={t("pdfViewer.closeFindTitle")}
              aria-label={t("pdfViewer.closeFindLabel")}
            >
              ✕
            </button>
          </div>
          {replaceOpen && (
            <div className="file-viewer-find-row file-viewer-replace-row">
              <input
                ref={replaceInputRef}
                className="file-viewer-find-input"
                type="text"
                value={replaceWith}
                placeholder={t("fileViewer.replacePlaceholder")}
                aria-label={t("fileViewer.replaceWithLabel")}
                spellCheck={false}
                onChange={(e) => setReplaceWith(e.target.value)}
                onKeyDown={onReplaceKeyDown}
              />
              <button
                className="file-viewer-find-btn file-viewer-replace-btn"
                onClick={replaceCurrent}
                disabled={matches.length === 0}
                title={t("fileViewer.replaceCurrentTitle")}
                aria-label={t("fileViewer.replaceLabel")}
              >
                {t("fileViewer.replaceLabel")}
              </button>
              <button
                className="file-viewer-find-btn file-viewer-replace-btn"
                onClick={replaceAll}
                disabled={matches.length === 0}
                title={chordHint(t("fileViewer.replaceAllTitle"), { key: "Enter", ctrl: true })}
                aria-label={t("fileViewer.replaceAllLabel")}
              >
                {t("fileViewer.replaceAllBtn")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Save control shared by every editable viewer (#47). The outline disk matches
 * the printer mark beside it; dirty/clean state is carried by the button color
 * and enabled state, while an in-flight write swaps the mark for a spinner. */
export function SaveButton({
  isDirty,
  saving,
  save,
  title,
}: {
  isDirty: boolean;
  saving: boolean;
  save: () => void;
  title?: string;
}) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <button
      className={`file-viewer-save${isDirty ? " is-dirty" : ""}${saving ? " is-saving" : ""}`}
      onClick={save}
      disabled={!isDirty || saving}
      aria-label={t("common.save")}
      title={
        saving
          ? t("common.saving")
          : title ?? (isDirty ? chordHint(t("fileViewer.saveWithShortcut"), "editorSave") : t("fileViewer.noUnsavedChanges"))
      }
    >
      {saving ? (
        <span className="file-viewer-save-spinner" aria-hidden="true" />
      ) : (
        <SaveIcon />
      )}
    </button>
  );
}

/** Print button shared by every content viewer. Renders the viewer's content to
 *  a clean paginated document and hands it to the platform print dialog (which
 *  offers "Save as PDF") — see `lib/viewers/print`. `busy` covers async sources
 *  like the PDF viewer, which rasterises its pages before printing. */
function PrintButton({
  onPrint,
  busy = false,
  disabled = false,
}: {
  onPrint: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <button
      className={`file-viewer-print${busy ? " is-busy" : ""}`}
      onClick={onPrint}
      disabled={disabled || busy}
      title={busy ? t("pdfViewer.preparing") : t("pdfViewer.printLabel")}
      aria-label={t("pdfViewer.printLabel")}
    >
      {busy ? (
        <span className="file-viewer-save-spinner" aria-hidden="true" />
      ) : (
        <PrinterIcon />
      )}
    </button>
  );
}

/** Undo/redo toolbar buttons shared by the editable viewers (#46). */
export function UndoRedoButtons({
  undo,
  redo,
  canUndo,
  canRedo,
}: {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <div className="file-viewer-history" role="group" aria-label={t("fileViewer.editHistory")}>
      <button
        className="file-viewer-history-btn"
        onClick={undo}
        disabled={!canUndo}
        aria-label={t("common.undo")}
        title={chordHint(t("fileViewer.undoShortcut"), "editorUndo")}
      >
        ↶
      </button>
      <button
        className="file-viewer-history-btn"
        onClick={redo}
        disabled={!canRedo}
        aria-label={t("common.redo")}
        title={chordHint(t("fileViewer.redoShortcut"), "editorRedo")}
      >
        ↷
      </button>
    </div>
  );
}

// ── Per-format extras: format, validation, preview, markup toolbar ───────────

/**
 * "Format document" support for the editable text viewers. JSON is prettified
 * in-process; every other recognised type shells out to an external formatter
 * (prettier/black/rustfmt/gofmt) via the backend, which is probed once per path
 * so the button can disable itself when no tool is installed. A formatted result
 * is written back through `setDraft`, so it lands as one undo step.
 */
function useFormatter(path: string, draft: string, setDraft: (v: string) => void) {
  const t = useT();
  const lang = useMemo(() => formatLangForPath(path), [path]);
  const inProcess = useMemo(() => isInProcessJson(path), [path]);
  const enabled = inProcess || lang != null;
  // JSON (in-process) is always available; an external formatter is probed.
  const [available, setAvailable] = useState(inProcess);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!lang) {
      setAvailable(inProcess);
      return;
    }
    let cancelled = false;
    invoke<boolean>("formatter_available", { lang, path })
      .then((ok) => { if (!cancelled) setAvailable(inProcess || ok); })
      .catch(() => { if (!cancelled) setAvailable(inProcess); });
    return () => { cancelled = true; };
  }, [lang, path, inProcess]);

  // Auto-dismiss a finished status after a few seconds.
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), 6000);
    return () => window.clearTimeout(id);
  }, [status]);

  const run = useCallback(async () => {
    if (busy) return;
    const text = draftRef.current;
    setStatus(null);
    if (inProcess) {
      const res = formatJsonText(text);
      if (res.ok) {
        if (res.text !== text) setDraft(res.text);
      } else {
        setStatus(t("fileViewer.cantFormat", { error: res.error }));
      }
      return;
    }
    if (!lang) return;
    setBusy(true);
    try {
      const out = await invokeTrusted<string>("format_source", { text, lang, path });
      if (out !== text) setDraft(out);
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith("formatter-unavailable")) {
        setAvailable(false);
        setStatus(t("fileViewer.noFormatterInstalled"));
      } else {
        setStatus(msg.length > 240 ? `${msg.slice(0, 240)}…` : msg);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, inProcess, lang, path, setDraft, t]);

  return { enabled, available, busy, status, run };
}

/** "Format" toolbar button; disabled when no formatter is available or while a
 *  format is in flight. Keeps editor focus so the document stays the target. */
function FormatButton({
  available,
  busy,
  run,
}: {
  available: boolean;
  busy: boolean;
  run: () => void;
}) {
  const t = useT();
  return (
    <button
      className="file-viewer-format-btn"
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      disabled={!available || busy}
      title={available ? t("fileViewer.formatDocument") : t("fileViewer.noFormatterFound")}
      aria-label={t("fileViewer.formatDocument")}
    >
      {busy ? <span className="file-viewer-save-spinner" aria-hidden="true" /> : t("fileViewer.formatBtn")}
    </button>
  );
}

interface SyntaxIssue {
  line: number;
  column: number;
  message: string;
}

/** Debounced backend syntax check for JSON/YAML; returns the first parse error
 *  (or null when valid / not a checked type). Re-runs as the draft changes. */
function useSyntaxCheck(path: string, draft: string, loaded: boolean): SyntaxIssue | null {
  const lang = useMemo(() => validationLangForPath(path), [path]);
  const [issue, setIssue] = useState<SyntaxIssue | null>(null);
  useEffect(() => {
    if (!lang || !loaded) {
      setIssue(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      invoke<SyntaxIssue | null>("check_syntax", { text: draft, lang })
        .then((r) => { if (!cancelled) setIssue(r ?? null); })
        .catch(() => { if (!cancelled) setIssue(null); });
    }, 500);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [lang, draft, loaded]);
  return lang ? issue : null;
}

/** Inline parse-error banner for JSON/YAML, with a jump to the offending line. */
function ValidationBanner({
  issue,
  onJump,
}: {
  issue: SyntaxIssue | null;
  onJump: (line: number, column: number) => void;
}) {
  const t = useT();
  if (!issue) return null;
  const where = issue.line
    ? issue.column
      ? t("fileViewer.validationAtLineCol", { line: issue.line, column: issue.column })
      : t("fileViewer.validationAtLine", { line: issue.line })
    : "";
  return (
    <div className="file-viewer-validation" role="alert">
      <span className="file-viewer-validation-dot" aria-hidden="true" />
      <span className="file-viewer-validation-msg">
        {issue.message}
        {where}
      </span>
      {issue.line > 0 && (
        <button
          className="file-viewer-validation-jump"
          onClick={() => onJump(issue.line, issue.column)}
        >
          {t("fileViewer.goToLine")}
        </button>
      )}
    </div>
  );
}

/** Reusable Preview/Edit (Source) segmented toggle, styled like the existing
 *  markdown mode buttons. */
export function ModeToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="file-viewer-modes">
      {options.map((o) => (
        <button
          key={o.value}
          className={`file-viewer-mode${value === o.value ? " active" : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rendered-preview pane for HTML/SVG/CSS — a fully sandboxed (`sandbox=""`,
 *  no scripts) iframe so even a hostile file is inert. CSS is applied to a small
 *  sample document; HTML/SVG render their own source (HTML with a
 *  `<base href="about:srcdoc">` added, so its `#anchor` links scroll instead of
 *  navigating the frame away — see `SRCDOC_BASE_TAG`). */
function RenderedPreview({
  kind,
  content,
  fileName,
}: {
  kind: PreviewKind;
  content: string;
  fileName: string;
}) {
  const t = useT();
  const doc = useMemo(() => buildPreviewDoc(kind, content), [kind, content]);
  return (
    <iframe
      // sandbox="" is intentional and load-bearing: the most restrictive
      // sandbox, so no script in the file can run.
      sandbox=""
      srcDoc={doc}
      title={t("fileViewer.previewOf", { file: fileName })}
      className="file-viewer-html-frame"
      style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
    />
  );
}

/** Rendered SVG preview with Ctrl/⌘+wheel zoom toward the cursor (plain wheel
 *  scrolls; double-click resets to 100%). A sandboxed iframe would swallow the
 *  wheel, so the SVG is drawn as an `<img>` from an `image/svg+xml` Blob URL
 *  instead — just as inert: an image-context SVG runs no script and loads no
 *  external resource. Scale 1 is the SVG's intrinsic size (the viewport width
 *  when it declares none). */
function SvgPreview({ content, fileName }: { content: string; fileName: string }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([content], { type: "image/svg+xml" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [content]);
  const [baseWidth, setBaseWidth] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The point under the cursor, as a fraction of the image, plus where the
  // cursor sits in the viewport. Applied once the new size has laid out so that
  // point stays put. A fraction (not a scroll offset) survives several wheel
  // ticks landing before one render: each reads the still-displayed layout.
  const pendingAnchor = useRef<{ fx: number; fy: number; ax: number; ay: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const img = imgRef.current;
    const a = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!el || !img || !a) return;
    const r = el.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    const left = ir.left - r.left + el.scrollLeft;
    const top = ir.top - r.top + el.scrollTop;
    el.scrollLeft = left + a.fx * ir.width - a.ax;
    el.scrollTop = top + a.fy * ir.height - a.ay;
  }, [scale]);
  const wheelRef = useZoomModifierWheel((e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    const img = imgRef.current;
    if (!el || !img || e.deltaY === 0) return;
    const prev = scaleRef.current;
    const next = clampScale(prev * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    if (next === prev) return;
    const r = el.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    if (ir.width <= 0 || ir.height <= 0) return;
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    pendingAnchor.current = {
      fx: clamp01((e.clientX - ir.left) / ir.width),
      fy: clamp01((e.clientY - ir.top) / ir.height),
      ax: e.clientX - r.left,
      ay: e.clientY - r.top,
    };
    scaleRef.current = next;
    setScale(next);
  });
  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      wheelRef(el);
    },
    [wheelRef],
  );
  return (
    <div
      ref={setScroller}
      onDoubleClick={() => setScale(1)}
      style={{ width: "100%", height: "100%", overflow: "auto", background: "#fff" }}
    >
      {/* Centred while smaller than the pane; grows to scroll once larger. Auto
          margins (not align/justify) so an oversized image never overflows
          past the unreachable top/left edge. */}
      <div style={{ display: "flex", width: "max-content", minWidth: "100%", minHeight: "100%" }}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt={t("fileViewer.previewOf", { file: fileName })}
          draggable={false}
          onLoad={(e) => {
            const w = e.currentTarget.naturalWidth || scrollRef.current?.clientWidth || 300;
            setBaseWidth(w);
          }}
          style={{
            display: "block",
            margin: "auto",
            maxWidth: "none",
            height: "auto",
            width: baseWidth != null ? baseWidth * scale : undefined,
          }}
        />
      )}
      </div>
    </div>
  );
}

/** Markdown editing toolbar (#md-toolbar): inline/structural formatting plus a
 *  generated table of contents, applied through the editor's imperative API so
 *  each action is one undo step. Buttons `preventDefault` on mousedown so the
 *  editor keeps its selection as the action's target. */
function MarkdownToolbar({ api }: { api: React.MutableRefObject<EditorApi | null> }) {
  const t = useT();
  const act = (fn: (v: string, s: number, e: number) => EditResult) => () =>
    api.current?.applyEdit(fn);
  const btn = (label: React.ReactNode, title: string, fn: (v: string, s: number, e: number) => EditResult) => (
    <button
      className="file-viewer-md-btn"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={act(fn)}
    >
      {label}
    </button>
  );
  return (
    <div className="file-viewer-md-toolbar" role="group" aria-label={t("fileViewer.formattingGroup")}>
      {btn(<b>B</b>, t("fileViewer.mdBold"), (v, s, e) => toggleInline(v, s, e, "**"))}
      {btn(<i>I</i>, t("fileViewer.mdItalic"), (v, s, e) => toggleInline(v, s, e, "_"))}
      {btn(<span style={{ fontFamily: "var(--font-mono, monospace)" }}>{"<>"}</span>, t("fileViewer.mdInlineCode"), (v, s, e) => toggleInline(v, s, e, "`"))}
      {btn("H", t("fileViewer.mdCycleHeading"), (v, s) => cycleHeading(v, s))}
      {btn(<LinkIcon />, t("fileViewer.mdLink"), (v, s, e) => makeLink(v, s, e))}
      {btn("•", t("fileViewer.mdBulletedList"), (v, s, e) => toggleLinePrefix(v, s, e, "- "))}
      {btn("TOC", t("fileViewer.mdInsertToc"), (v, s, e) => {
        const toc = generateToc(v);
        const ins = toc ? `${toc}\n` : "";
        return { value: v.slice(0, s) + ins + v.slice(e), selStart: s, selEnd: s + ins.length };
      })}
    </div>
  );
}

/** Resolve the per-type viewer prefs for an InternalViewer from settings (#48). */
function useViewerPref(type: InternalViewer) {
  return useSettingsStore((s) => s.settings?.viewer_prefs?.[type]);
}

/** What {@link useTabAiPrefs} returns: the effective autocomplete/spelling config
 *  for the editor, plus the current control state + setters for the in-tab UI. */
export interface TabAiPrefs {
  ac: { enabled: boolean; preferred?: string; preferredProse?: string; mode: AutocompleteMode };
  sc: { enabled: boolean; language?: string };
  autocomplete: boolean;
  spelling: boolean;
  mode: AutocompleteMode;
  toggleAutocomplete: () => void;
  toggleSpelling: () => void;
  setMode: (m: AutocompleteMode) => void;
}

/**
 * Tab-local AI-assist prefs (#45). Each editor tab gets its OWN autocomplete
 * on/off, completion-length mode, and spelling on/off, overriding the per-type
 * `viewer_prefs` default for that tab only. The override is seeded once from the
 * tab's persisted `viewerState` and written back there (like scroll/zoom), so it
 * survives reopening the file and a Tabtivity restart. Until the user touches a
 * control, the value tracks the per-type setting reactively; once toggled, that
 * tab pins its own value. The `preferred` autocomplete model is its 🧠-menu tag
 * (`ollama_roles.autocomplete`), falling back to `ollama_model`.
 */
function useTabAiPrefs(tabKey: string | undefined, type: InternalViewer): TabAiPrefs {
  const pref = useViewerPref(type);
  // Per-task model preference (🧠 menu role chips): autocomplete can pin a
  // loaded model, falling back to the default `ollama_model` when it has no
  // explicit assignment. Resolved against the resident set
  // at trigger time (see the request paths above).
  const defaultModel = useSettingsStore((s) => s.settings?.ollama_model as string | undefined);
  const acRole = useSettingsStore((s) => s.settings?.ollama_roles?.autocomplete as string | undefined);
  const acProseRole = useSettingsStore((s) => s.settings?.ollama_roles?.autocomplete_prose as string | undefined);
  const acPreferred = acRole ?? defaultModel;
  // Dictionary spell check: no model involved — its one setting is which
  // Hunspell dictionary, machine-wide (unset lets the backend pick).
  const spellLanguage = useSettingsStore(
    (s) => s.settings?.spell_language as string | undefined,
  );
  const defAutocomplete = pref?.autocomplete === true;
  const defSpelling = pref?.spell_check === true;
  const defMode: AutocompleteMode = AC_MODES.includes(pref?.autocomplete_mode as AutocompleteMode)
    ? (pref!.autocomplete_mode as AutocompleteMode)
    : "sentence";

  // Seed the tab-local override once from the persisted viewerState. `undefined`
  // for a field means "no override yet" → fall through to the per-type default.
  const [override, setOverride] = useState<{
    autocomplete?: boolean;
    spelling?: boolean;
    mode?: AutocompleteMode;
  }>(() => {
    const vs = seedViewerState(tabKey);
    return {
      autocomplete: vs?.autocomplete,
      spelling: vs?.spellCheck,
      mode: vs?.autocompleteMode,
    };
  });

  const persist = useCallback(
    (patch: ViewerState) => {
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );

  const autocomplete = override.autocomplete ?? defAutocomplete;
  const spelling = override.spelling ?? defSpelling;
  const mode = override.mode ?? defMode;

  const toggleAutocomplete = useCallback(() => {
    setOverride((o) => {
      const next = !(o.autocomplete ?? defAutocomplete);
      persist({ autocomplete: next });
      return { ...o, autocomplete: next };
    });
  }, [persist, defAutocomplete]);
  const toggleSpelling = useCallback(() => {
    setOverride((o) => {
      const next = !(o.spelling ?? defSpelling);
      persist({ spellCheck: next });
      return { ...o, spelling: next };
    });
  }, [persist, defSpelling]);
  const setMode = useCallback(
    (m: AutocompleteMode) => {
      persist({ autocompleteMode: m });
      setOverride((o) => ({ ...o, mode: m }));
    },
    [persist],
  );

  return {
    ac: { enabled: autocomplete, preferred: acPreferred, preferredProse: acProseRole, mode },
    sc: { enabled: spelling, language: spellLanguage },
    autocomplete,
    spelling,
    mode,
    toggleAutocomplete,
    toggleSpelling,
    setMode,
  };
}

/** The hover preview's on/off (#tex-hover-preview): the PROJECT's, not the
 *  tab's — one click holds for every TeX pane of the project, across a project
 *  switch and a relaunch (`stores/viewers/texViewPref`). Seeded from the per-type
 *  `viewer_prefs.tex` default while no click has been made.
 *
 *  Unlike autocomplete it defaults **ON** (absent ⇒ on), and the difference
 *  is what the two cost: that calls a language model, this runs the
 *  TeX engine the viewer is already built around — on a fragment, once per
 *  distinct fragment, and only after the pointer has rested. */
function useTexHoverPreview(scope: string | null): { on: boolean; toggle: () => void } {
  const pref = useViewerPref("tex");
  const def = pref?.hover_preview !== false;
  const key = texViewScopeKey(scope);
  const override = useTexViewPrefStore((s) => s.byProject[key]?.hoverPreview);
  const on = override ?? def;
  const toggle = useCallback(() => {
    useTexViewPrefStore.getState().set(key, { hoverPreview: !on });
  }, [key, on]);
  return { on, toggle };
}

/**
 * Beamer mode for the TeX editor (#tex-beamer): is the overlay bar shown? Per
 * PROJECT, like the hover preview, but its default is the DOCUMENT's — on when
 * any file of it loads `\documentclass{beamer}` (`detected`), off otherwise — so
 * a deck opens with the bar and a paper never sees it, and a click either way
 * is remembered for the project: every file of the deck, this sitting and the
 * next.
 */
function useTexBeamerMode(
  scope: string | null,
  detected: boolean,
): { on: boolean; toggle: () => void } {
  const key = texViewScopeKey(scope);
  const override = useTexViewPrefStore((s) => s.byProject[key]?.beamer);
  const on = override ?? detected;
  const toggle = useCallback(() => {
    useTexViewPrefStore.getState().set(key, { beamer: !on });
  }, [key, on]);
  return { on, toggle };
}

/**
 * The beamer overlay bar (#tex-beamer): a command, a slide range, and three
 * actions over the editor's selection — Wrap (`\only<2->{…}` around it), Items
 * (`<n>` on each `\item` in the lines, counting up), Pause. The bar is chrome;
 * every edit is `lib/viewers/tex/beamer`'s and goes through the editor's `applyEdit`
 * so undo, the syntax overlay and the caret behave as for any other edit.
 *
 * The **from** field is empty by default and means "the next unused number in
 * this frame" (`nextOverlayNumber`), read from the draft at the moment of the
 * click — the number the author would otherwise have to look up. Typing a
 * number pins it; `to` and `onward` complete the range; and the spec field shows
 * what will be written and can be edited directly for the forms three number
 * fields cannot express (`<+->`, `<1,3>`, `<handout:0>`).
 */
function BeamerBar({
  api,
  selection,
}: {
  api: React.MutableRefObject<EditorApi | null>;
  selection: React.MutableRefObject<RememberedSelection | null>;
}) {
  const t = useT();
  const [cmd, setCmd] = useState<BeamerOverlayCommand>("only");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [onward, setOnward] = useState(true);
  // A spec typed by hand overrides the three fields until one of them moves.
  const [raw, setRaw] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const num = (s: string): number | null => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // The spec the fields describe; a `from` left empty is filled in at apply time.
  const specFor = (fromN: number | null): string =>
    raw ?? buildOverlaySpec(fromN, num(to), onward);
  const preview = raw ?? buildOverlaySpec(num(from) ?? 0, num(to), onward);
  const previewShown = num(from) == null && raw == null
    ? preview.replace(/^0/, "n")
    : preview;
  const previewValid = raw == null || isOverlaySpecBody(raw);

  const run = (
    fn: (value: string, start: number, end: number, spec: string) => EditResult | null,
  ) => {
    setNote(null);
    api.current?.applyEdit((value, liveStart, liveEnd) => {
      const { start, end } = beamerEditRange(value, liveStart, liveEnd, selection.current);
      const spec = specFor(num(from) ?? nextOverlayNumber(value, start));
      if (!isOverlaySpecBody(spec)) {
        setNote(t("fileViewer.beamerSpecInvalid"));
        return { value, selStart: start, selEnd: end };
      }
      const res = fn(value, start, end, spec);
      if (!res) {
        setNote(t("fileViewer.beamerNoItems"));
        return { value, selStart: start, selEnd: end };
      }
      return res;
    });
  };

  const field = (
    label: string,
    title: string,
    value: string,
    set: (v: string) => void,
    placeholder = "",
  ) => (
    <label className="file-viewer-beamer-field" title={title}>
      {label}
      <input
        type="number"
        min={1}
        max={999}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { set(e.target.value); setRaw(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") run(wrap); }}
      />
    </label>
  );
  const wrap = (v: string, s: number, e: number, spec: string) =>
    wrapBeamerOverlay(v, s, e, cmd, spec);

  return (
    <div className="file-viewer-beamer-bar" role="group" aria-label={t("fileViewer.beamerBarLabel")}>
      <Dropdown
        title={t("fileViewer.beamerCommandTitle")}
        value={cmd}
        onChange={(v) => setCmd(v as BeamerOverlayCommand)}
        options={BEAMER_OVERLAY_COMMANDS.map((c) => ({ value: c, label: `\\${c}` }))}
      />
      {field(t("fileViewer.beamerFrom"), t("fileViewer.beamerFromTitle"), from, setFrom, "n")}
      {field(t("fileViewer.beamerTo"), t("fileViewer.beamerToTitle"), to, setTo)}
      <label className="file-viewer-beamer-field" title={t("fileViewer.beamerOnwardTitle")}>
        <input
          type="checkbox"
          checked={onward}
          onChange={(e) => { setOnward(e.target.checked); setRaw(null); }}
        />
        {t("fileViewer.beamerOnward")}
      </label>
      <label className="file-viewer-beamer-field" title={t("fileViewer.beamerSpecTitle")}>
        <span className="file-viewer-beamer-spec" aria-hidden="true">{"<"}</span>
        <input
          type="text"
          className={previewValid ? undefined : "is-invalid"}
          aria-label={t("fileViewer.beamerSpecTitle")}
          value={raw ?? previewShown}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(wrap); }}
          spellCheck={false}
        />
        <span className="file-viewer-beamer-spec" aria-hidden="true">{">"}</span>
      </label>
      <span className="file-viewer-beamer-sep" aria-hidden="true" />
      <button
        type="button"
        className="file-viewer-beamer-apply"
        title={t("fileViewer.beamerWrapTitle", { cmd })}
        // mousedown + preventDefault keeps the editor's selection: the button
        // must not take focus, or the textarea blurs and WebKitGTK collapses
        // the very selection about to be wrapped.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(wrap)}
      >
        {t("fileViewer.beamerWrap")}
      </button>
      <button
        type="button"
        title={t("fileViewer.beamerItemsTitle")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run((v, s, e, spec) => overlayItems(v, s, e, spec))}
      >
        {t("fileViewer.beamerItems")}
      </button>
      <button
        type="button"
        title={t("fileViewer.beamerPauseTitle")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setNote(null);
          api.current?.applyEdit((v, s, e) => insertPause(v, s, e));
        }}
      >
        {t("fileViewer.beamerPause")}
      </button>
      {note && <span className="file-viewer-beamer-note" role="status">{note}</span>}
    </div>
  );
}

/**
 * Whether at least one local (Ollama) model is currently loaded into memory.
 * Local autocomplete runs only against a resident model, so its controls hide
 * when none is loaded. Mirrors the lamp logic in `LocalModelMenu`: `ollama_status` is
 * `"loaded"` iff `/api/ps` reports a resident model.
 *
 * Rides the app-wide shared poller (`lib/ollamaStatus`) rather than owning a
 * timer. This hook runs **per editable viewer tab**, so a private 5s interval
 * made the `/api/ps` request rate a function of how many tabs happened to be
 * open — asking the same machine-wide question N times over. One timer now
 * serves every surface, and they all flip on the same observation.
 */
function useLocalModelLoaded(): boolean {
  return useOllamaStatus() === "loaded";
}

/**
 * In-tab AI-assist controls for the editable viewers (#45): an Autocomplete
 * on/off toggle with a length-mode picker (Sentence/Block/Scope), beside the
 * dictionary Spelling toggle. The state is tab-local (see
 * {@link useTabAiPrefs}) — toggling here affects only this tab. Rendered in the
 * viewer header next to the font/undo/save controls. Autocomplete hides while
 * no local model is loaded (and Copilot doesn't serve the file).
 */
function EditorAiControls({ ai, path }: { ai: TabAiPrefs; path: string }) {
  const t = useT();
  const chordHint = useChordHint();
  const modelLoaded = useLocalModelLoaded();
  const scope = useFileScope();
  const enabled = useExperimental("copilot_completion");
  const remote = useProjectsStore((s) => !!s.projects.find((p) => p.id === scope)?.remote);
  const copilot = useSettingsStore((s) => copilotServes(s.settings, enabled, scope, remote, languageForPath(path), path));
  return (
    <div className="file-viewer-ai-controls" role="group" aria-label={t("fileViewer.aiAssistGroup")}>
      {/* Dictionary spelling needs no model, so it is offered regardless —
          only the model-backed autocomplete hides while nothing is loaded. */}
      <button
        type="button"
        className={`file-viewer-ai-btn${ai.spelling ? " active" : ""}`}
        onClick={ai.toggleSpelling}
        aria-pressed={ai.spelling}
        title={
          ai.spelling
            ? t("fileViewer.spellingOnHint")
            : t("fileViewer.spellingOffHint")
        }
      >
        {t("fileViewer.spellingLabel")}
      </button>
      {ai.spelling && <SpellLanguageSelect />}
      {(modelLoaded || copilot) && (
        <>
          <button
            type="button"
            className={`file-viewer-ai-btn${ai.autocomplete ? " active" : ""}`}
            onClick={ai.toggleAutocomplete}
            aria-pressed={ai.autocomplete}
            title={
              copilot ? chordHint(t("fileViewer.copilotToggleHint"), "editorAutocomplete") : ai.autocomplete
                ? chordHint(t("fileViewer.autocompleteOnHint"), "editorAutocomplete")
                : t("fileViewer.autocompleteOffHint")
            }
          >
            {t("fileViewer.autocompleteLabel")} <UntestedTag id="fileViewer.autocompleteLabel" />
          </button>
          {ai.autocomplete && !copilot && (
            <Dropdown
              className="file-viewer-ai-mode"
              value={ai.mode}
              title={t("fileViewer.completionLengthTitle")}
              onChange={(v) => ai.setMode(v as AutocompleteMode)}
              options={[
                { value: "sentence", label: t("projectSettings.sentence") },
                { value: "block", label: t("projectSettings.block") },
                { value: "scope", label: t("projectSettings.scope") },
              ]}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The dictionary the spelling chip reads, beside it — so the language can be
 * switched where the writing happens instead of in Project Settings. The
 * choice is `Settings.spell_language`, machine-wide (the backend's default,
 * an installed English variant, is what an unset value shows). Beside it, a
 * "＋ Language" menu downloads any other catalog language (the same
 * `spell_install_language` Project Settings' picker uses) and selects it —
 * shown even with nothing installed, which is when it is needed most.
 * Re-lists whenever the setting moves, which is also how a download made in
 * Settings while this tab is open reaches the list.
 */
function SpellLanguageSelect() {
  const t = useT();
  const uiLang = useI18nStore((s) => s.lang);
  const spellLanguage = useSettingsStore(
    (s) => s.settings?.spell_language as string | undefined,
  );
  const [dicts, setDicts] = useState<{
    installed: InstalledDictionary[];
    catalog: CatalogDictionary[];
  } | null>(null);
  // Bumped after a download: re-downloading the language the setting already
  // names (its files were missing) moves no setting, yet must re-list.
  const [listEpoch, setListEpoch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<{ installed: InstalledDictionary[]; catalog: CatalogDictionary[] }>("spell_dictionaries")
      .then((d) => {
        if (live) setDicts(d);
      })
      .catch(() => {
        if (live) setDicts({ installed: [], catalog: [] });
      });
    return () => {
      live = false;
    };
  }, [spellLanguage, listEpoch]);
  if (!dicts) return null;
  const choices = dictionaryChoices(dicts.installed, dicts.catalog, uiLang);

  const download = async (code: string) => {
    if (busy) return;
    setBusy(code);
    setError(null);
    try {
      await invoke("spell_install_language", { code });
      // Read it right away: the language you just fetched is the one you want.
      await useSettingsStore.getState().updateSettings({ spell_language: code });
      setListEpoch((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {choices.installed.length > 0 && (
        <Dropdown
          className="file-viewer-ai-mode"
          value={spellLanguage ?? defaultSpellLanguage(dicts.installed)}
          title={t("fileViewer.spellingLanguageTitle")}
          options={choices.installed.map((d) => ({ value: d.code, label: d.label }))}
          disabled={busy !== null}
          onChange={(v) => void useSettingsStore.getState().updateSettings({ spell_language: v })}
        />
      )}
      {choices.downloadable.length > 0 && (
        <>
          <Dropdown
            className="file-viewer-ai-mode"
            value=""
            placeholder={
              busy
                ? t("fileViewer.spellingDownloading", { lang: languageDisplayName(busy, uiLang) })
                : t("fileViewer.spellingAddLanguage")
            }
            title={t("fileViewer.spellingAddLanguageTitle")}
            options={choices.downloadable.map((d) => ({ value: d.code, label: d.label }))}
            disabled={busy !== null}
            onChange={(v) => void download(v)}
          />
          <UntestedTag id="fileViewer.spellingAddLanguage" />
        </>
      )}
      {error && (
        <ErrorNote
          as="span"
          role="alert"
          className="file-viewer-spell-error"
          error={t("projectSettings.spellDownloadFailed", { error })}
        />
      )}
    </>
  );
}

// Code-editor font sizing. The default matches the .file-viewer-code CSS metrics
// (12px / 18px); the line-height tracks the font at a fixed 1.5 ratio so the
// gutter and overlay layers stay aligned at any size.
export const EDITOR_FONT_DEFAULT = 12;
export const EDITOR_FONT_MIN = 8;
export const EDITOR_FONT_MAX = 32;
const EDITOR_LINE_RATIO = 1.5;
export const clampFontSize = (n: number) =>
  Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(n)));

/** Shared Ctrl/Cmd+wheel handler for the text viewers (code + markdown): scroll
 *  up grows, down shrinks the font, mirroring the browser zoom gesture and the
 *  Ctrl +/− keyboard shortcuts. A plain wheel (no modifier) falls through to
 *  native scrolling. Typed structurally so both native and synthetic wheel
 *  events satisfy it. */
function onCtrlWheelFont(
  e: Pick<WheelEvent, "ctrlKey" | "metaKey" | "deltaY"> & {
    preventDefault(): void;
  },
  inc?: () => void,
  dec?: () => void,
) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.deltaY < 0) inc?.();
  else if (e.deltaY > 0) dec?.();
}

/** Bind `handler` as a NON-passive `wheel` listener through the returned callback
 *  ref. React registers its synthetic `onWheel` passively at the document root,
 *  so `preventDefault()` inside a React `onWheel` is ignored: a Ctrl+wheel zoom
 *  can't stop the element from scrolling, so it scrolls to its limit and only
 *  then does the zoom visibly "take". Attaching the listener ourselves with
 *  `{ passive: false }` lets `preventDefault()` cancel the scroll, so Ctrl+wheel
 *  zooms immediately and never scrolls. The callback ref re-binds cleanly across
 *  mount/unmount (e.g. conditionally-rendered viewports). */
export function useNonPassiveWheel(handler: (e: WheelEvent) => void) {
  const cb = useRef(handler);
  cb.current = handler;
  const detach = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (el) {
      const listener = (e: WheelEvent) => cb.current(e);
      el.addEventListener("wheel", listener, { passive: false });
      detach.current = () => el.removeEventListener("wheel", listener);
    }
  }, []);
}

/** A Ctrl/⌘-held tracker shared by every viewer, with imperative subscribers.
 *
 *  Deliberately NOT React state: `useZoomModifierWheel` is used by the code
 *  editor and the markdown/text viewers, so a `setState` per modifier press
 *  would re-render those (very large) panes on every Ctrl+S, Ctrl+F, Ctrl+Z and
 *  Ctrl+C — a re-render to answer a question nothing renders. The window
 *  listeners are keyboard-only and bind once for the app's lifetime; they cost
 *  nothing on the scroll path, which is the whole point of the exercise. */
const zoomModSubs = new Set<(held: boolean) => void>();
let zoomModHeld = false;
let zoomModBound = false;

function setZoomModHeld(next: boolean) {
  if (next === zoomModHeld) return;
  zoomModHeld = next;
  for (const fn of zoomModSubs) fn(next);
}

function subscribeZoomMod(fn: (held: boolean) => void): () => void {
  zoomModSubs.add(fn);
  if (!zoomModBound) {
    zoomModBound = true;
    const sync = (e: KeyboardEvent) => setZoomModHeld(e.ctrlKey || e.metaKey);
    window.addEventListener("keydown", sync, true);
    window.addEventListener("keyup", sync, true);
    // A modifier released while another window holds focus never delivers its
    // keyup here, so without this the wheel listener would stay bound for good
    // — exactly the state this hook exists to avoid.
    window.addEventListener("blur", () => setZoomModHeld(false));
  }
  return () => {
    zoomModSubs.delete(fn);
  };
}

/** macOS trackpad pinch arrives as a `ctrlKey` wheel event with no preceding
 *  keydown, so there is no modifier press to gate on there and the listener has
 *  to stay bound. Not preventing it would let the pinch zoom the whole webview
 *  instead of the viewer's font. */
const WHEEL_ALWAYS_BOUND = IS_MAC;

/** {@link useNonPassiveWheel} for a handler that only ever acts on Ctrl/⌘+wheel
 *  (the font-zoom viewers), binding the listener ONLY while such a modifier is
 *  actually held.
 *
 *  A `{ passive: false }` wheel listener tells the engine the default action may
 *  be cancelled, so every wheel tick has to round-trip through the main thread
 *  before the element is allowed to scroll at all — the scroll can never outrun
 *  whatever else the main thread is doing (a terminal painting in another pane,
 *  a React commit), which reads as stuttering and stalling. Under WebKitGTK,
 *  where compositing is already software (DMABUF is off), that hop is the
 *  difference between a scroll the compositor can serve and one it cannot.
 *
 *  The gesture we need it for is keyboard-modified, so the binding can follow
 *  the modifier instead of being permanent: plain scrolling leaves the scroller
 *  with no wheel handler at all, and Ctrl+wheel still gets its
 *  `preventDefault()` because the keydown lands before the wheel tick. */
export function useZoomModifierWheel(handler: (e: WheelEvent) => void) {
  const cb = useRef(handler);
  cb.current = handler;
  const elRef = useRef<HTMLElement | null>(null);
  const detach = useRef<(() => void) | null>(null);

  const unbind = useCallback(() => {
    detach.current?.();
    detach.current = null;
  }, []);
  const bind = useCallback(() => {
    const el = elRef.current;
    if (!el || detach.current) return;
    const listener = (e: WheelEvent) => cb.current(e);
    el.addEventListener("wheel", listener, { passive: false });
    detach.current = () => el.removeEventListener("wheel", listener);
  }, []);

  useEffect(() => {
    const unsub = subscribeZoomMod((held) => {
      // Releasing the modifier must NOT unbind where the binding is permanent
      // (macOS), or the first pinch after any Ctrl press would zoom the webview.
      if (held) bind();
      else if (!WHEEL_ALWAYS_BOUND) unbind();
    });
    return () => {
      unsub();
      unbind();
    };
  }, [bind, unbind]);

  return useCallback(
    (el: HTMLElement | null) => {
      unbind();
      elRef.current = el;
      // Mounting mid-gesture (a pane revealed while Ctrl is already down) still
      // has to arrive bound — the keydown that would have bound it is past.
      if (el && (WHEEL_ALWAYS_BOUND || zoomModHeld)) bind();
    },
    [bind, unbind],
  );
}

/**
 * Per-TAB editor font size (text-size +/− control, #48). The zoom is tab-local:
 * changing it resizes only this viewer tab, not every other tab of the same
 * type. The size is seeded once from the tab's persisted `viewerState.fontSize`
 * and written back there (like scroll/zoom), so it survives reopening the file
 * and a Tabtivity restart. Until the user zooms this tab it tracks the per-type
 * `viewer_prefs[type].font_size` default reactively; once zoomed, the tab pins
 * its own size. `reset` clears the override, dropping back to that default.
 */
function useEditorFontSize(tabKey: string | undefined, type: InternalViewer) {
  const pref = useViewerPref(type);
  const typeDefault = clampFontSize(pref?.font_size ?? EDITOR_FONT_DEFAULT);

  // Tab-local override, seeded once from the persisted viewerState. `undefined`
  // means "no override yet" → fall through to the per-type default above.
  const [override, setOverride] = useState<number | undefined>(
    () => seedViewerState(tabKey)?.fontSize,
  );
  const fontSize = clampFontSize(override ?? typeDefault);

  const persist = useCallback(
    (size: number | undefined) => {
      setOverride(size);
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, { fontSize: size });
    },
    [tabKey],
  );
  const setFontSize = useCallback(
    (next: number) => persist(clampFontSize(next)),
    [persist],
  );

  return {
    fontSize,
    lineHeight: Math.round(fontSize * EDITOR_LINE_RATIO),
    // True once this tab has set its own size — lets surfaces with their own
    // default (the markdown preview) leave it alone until then.
    isCustom: override != null,
    inc: useCallback(() => setFontSize(fontSize + 1), [setFontSize, fontSize]),
    dec: useCallback(() => setFontSize(fontSize - 1), [setFontSize, fontSize]),
    // Clear the tab override so it falls back to the per-type default.
    reset: useCallback(() => persist(undefined), [persist]),
  };
}

/** A−/A+ text-size control for the code editors, mirroring the image/PDF zoom
 *  group. Reuses the `.file-viewer-zoom-btn` styling. */
function FontSizeControls({
  fontSize,
  inc,
  dec,
  reset,
}: {
  fontSize: number;
  inc: () => void;
  dec: () => void;
  reset: () => void;
}) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <div className="file-viewer-zoom file-viewer-fontsize" role="group" aria-label={t("fileViewer.textSizeGroup")}>
      <button
        className="file-viewer-zoom-btn"
        onClick={dec}
        disabled={fontSize <= EDITOR_FONT_MIN}
        title={chordHint(t("fileViewer.decreaseTextSize"), "zoomOut")}
        aria-label={t("fileViewer.decreaseTextSizeLabel")}
      >
        A−
      </button>
      <button
        className="file-viewer-zoom-level file-viewer-fontsize-level"
        onClick={reset}
        title={chordHint(t("fileViewer.resetTextSize"), "zoomReset")}
        aria-label={t("fileViewer.resetTextSizeLabel")}
      >
        {fontSize}
      </button>
      <button
        className="file-viewer-zoom-btn"
        onClick={inc}
        disabled={fontSize >= EDITOR_FONT_MAX}
        title={chordHint(t("fileViewer.increaseTextSize"), "zoomIn")}
        aria-label={t("fileViewer.increaseTextSizeLabel")}
      >
        A+
      </button>
    </div>
  );
}

/**
 * In-tab code editor for plain-text/source files. A monospace textarea with a
 * scroll-synced line-number gutter, Tab/Shift+Tab indentation, and Ctrl/Cmd+S
 * (or the Save button) to write the file back to disk.
 */
/** Subscribe an editor for `path` to pending SyncTeX reverse-search jumps,
 *  yielding the `gotoLine`/`onGotoApplied` props for `CodeEditor`. */
function useEditorJump(path: string) {
  const req = useEditorJumpStore((s) => s.requestsByPath[path] ?? null);
  const consume = useEditorJumpStore((s) => s.consume);
  const onGotoApplied = useCallback(() => consume(path), [consume, path]);
  // Advertise this editor to reverse search so a Ctrl+click in the PDF — even in
  // a detached window whose tabs never reach `useTabsStore` — scrolls it here
  // instead of being delegated to the main window (#42).
  useEffect(() => {
    registerEditor(path);
    return () => unregisterEditor(path);
  }, [path]);
  return {
    gotoLine: req ? { line: req.line, column: req.column, nonce: req.nonce } : undefined,
    onGotoApplied,
  };
}

/** One source line's git-blame attribution; mirrors the Rust `GitBlameLine`
 *  (snake_case, read verbatim). */
interface BlameLine {
  line_no: number;
  hash: string;
  short: string;
  author: string;
  author_time: number;
  summary: string;
}

/** True for git's working-tree "Not Committed Yet" pseudo-commit (all-zeros or
 *  empty sha) — those lines get no attribution / hovercard. */
function isUncommitted(b: BlameLine): boolean {
  return b.hash === "" || /^0+$/.test(b.hash);
}

/** Compact relative age ("now", "3d", "2mo", "5y") from a unix epoch (seconds). */
function blameRelDate(epochSecs: number): string {
  if (!epochSecs) return "";
  const secs = Math.max(0, Date.now() / 1000 - epochSecs);
  const day = 86400;
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < day) return `${Math.floor(secs / 3600)}h`;
  if (secs < day * 30) return `${Math.floor(secs / day)}d`;
  if (secs < day * 365) return `${Math.floor(secs / (day * 30))}mo`;
  return `${Math.floor(secs / (day * 365))}y`;
}

/** Shorten an author for the narrow gutter ("Ada Lovelace" → "A. Lovelace"). */
function authorAbbrev(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0]) return name;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/** Fetches per-line git blame for `path` when `enabled`, keyed by 1-based line
 *  number. Resolves the owning project directory exactly like the autocomplete
 *  path (longest project dir that prefixes `path`, falling back to the active
 *  project) and calls the backend `git_blame` — which dispatches local vs remote
 *  (SSH) transparently. A non-repo dir, a disconnected remote, or any error
 *  yields an empty map (blame just shows nothing); it never throws. */
function useBlame(path: string, enabled: boolean): Map<number, BlameLine> {
  const [byLine, setByLine] = useState<Map<number, BlameLine>>(() => new Map());
  useEffect(() => {
    if (!enabled) {
      setByLine(new Map());
      return;
    }
    const { projects, activeId } = useProjectsStore.getState();
    let projectDir = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > projectDir.length) projectDir = dir;
    }
    if (!projectDir) {
      const active = projects.find((p) => p.id === activeId);
      projectDir = active ? resolveProjectDirectory(active) : "";
    }
    if (!projectDir) {
      setByLine(new Map());
      return;
    }
    const relPath = relFromAbs(projectDir, path);
    let cancelled = false;
    invoke<BlameLine[]>("git_blame", { projectDir, relPath })
      .then((lines) => {
        if (cancelled) return;
        const map = new Map<number, BlameLine>();
        for (const l of lines) map.set(l.line_no, l);
        setByLine(map);
      })
      .catch(() => {
        if (!cancelled) setByLine(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);
  return byLine;
}

/** "Blame" toolbar toggle. When active the code editor paints a per-line blame
 *  column in the gutter plus a faint current-line inline annotation. */
function BlameButton({ active, toggle }: { active: boolean; toggle: () => void }) {
  const t = useT();
  return (
    <button
      className={`file-viewer-format-btn file-viewer-blame-btn${active ? " active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      title={active ? t("fileViewer.blameHideTitle") : t("fileViewer.blameShowTitle")}
      aria-label={t("fileViewer.blameToggleLabel")}
      aria-pressed={active}
    >
      {t("fileViewer.blameBtn")}
    </button>
  );
}

/**
 * The editor's debug breakpoints (#py) — the gutter's red dots.
 *
 * Two things make this more than a `Set<number>`:
 *
 *  - **They must survive edits.** A breakpoint names a line, so typing a new
 *    import at the top of the file silently re-points every dot below it at the
 *    wrong statement. Each draft change is therefore diffed against the previous
 *    one and the lines are remapped (`remapBreakpoints`).
 *  - **They must be settable only where pdb can break.** Clicking a blank line or
 *    a comment snaps down to the next executable line rather than setting a
 *    breakpoint pdb would reject at startup (`snapBreakpointLine`).
 *
 * They persist in the tab's `ViewerState`, so they survive closing the file and
 * a Tabtivity restart — the same plumbing (and the same `project.json` write) as the
 * reader's scroll position.
 */
function useBreakpoints(
  enabled: boolean,
  draft: string,
  loaded: boolean,
  viewPos: ReturnType<typeof useViewerState>,
) {
  const [lines, setLines] = useState<number[]>(() =>
    enabled ? (viewPos.initial?.breakpoints ?? []) : [],
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The draft the current lines were resolved against. Seeded on first load: the
  // editor's ""→content transition is not an edit, and diffing across it would
  // look like "every line was replaced" and drop every restored breakpoint.
  const prevDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !loaded) return;
    const before = prevDraft.current;
    prevDraft.current = draft;
    if (before === null || before === draft) return;
    setLines((cur) => {
      if (cur.length === 0) return cur;
      const next = remapBreakpoints(before, draft, cur);
      // Keep the identity stable when nothing moved, so the gutter doesn't
      // re-render on every keystroke.
      return next.length === cur.length && next.every((l, i) => l === cur[i]) ? cur : next;
    });
  }, [enabled, loaded, draft]);

  // Persist on change only — never on mount, which would rewrite the tab with the
  // value we just read out of it.
  const persistedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = lines.join(",");
    if (persistedKey.current === null) {
      persistedKey.current = key;
      return;
    }
    if (persistedKey.current === key) return;
    persistedKey.current = key;
    viewPos.persist({ breakpoints: lines });
  }, [enabled, lines, viewPos]);

  const toggle = useCallback((line: number) => {
    setLines((cur) => {
      if (cur.includes(line)) return cur.filter((l) => l !== line);
      const snapped = snapBreakpointLine(draftRef.current, line);
      if (snapped == null) return cur; // nothing executable below — no-op
      if (cur.includes(snapped)) return cur.filter((l) => l !== snapped);
      return [...cur, snapped].sort((a, b) => a - b);
    });
  }, []);

  const set = useMemo(() => new Set(lines), [lines]);
  return { lines, set, toggle };
}

/** Run / Debug (#py). Run executes the file in a fresh terminal tab; Debug does
 *  the same under `pdb`, pre-loaded with the gutter's breakpoints.
 *
 *  Right-clicking Run opens a small popover to type **arguments** (`sys.argv`) —
 *  appended to the command line and reused by every subsequent Run/Debug, so a
 *  plain left-click re-runs with them (the tooltip shows what they are). */
function RunDebugButtons({
  breakpointCount,
  busy,
  showDebug,
  args,
  setArgs,
  onRun,
  onDebug,
}: {
  breakpointCount: number;
  busy: boolean;
  /** Debug (pdb + breakpoint gutter) is behind the experimental gate; Run isn't. */
  showDebug: boolean;
  /** The current argument string, and its setter (right-click popover edits it). */
  args: string;
  setArgs: (v: string) => void;
  onRun: () => void;
  onDebug: () => void;
}) {
  const t = useT();
  const [argsOpen, setArgsOpen] = useState(false);
  // Hovering the Run/Debug buttons shows the saved args in an in-DOM popover — the
  // native `title` tooltip is unreliable under WebKitGTK, so it can't be the only
  // place the args are shown.
  const [hovering, setHovering] = useState(false);
  // Local draft so typing doesn't rebuild the run command on every keystroke; it
  // is committed to the shared `args` on Run or when the popover closes.
  const [draft, setDraft] = useState(args);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = useCallback(() => {
    setDraft(args);
    setArgsOpen(true);
  }, [args]);
  const commit = useCallback(() => {
    setArgs(draft.trim());
    setArgsOpen(false);
  }, [draft, setArgs]);

  // Focus the field when the popover opens, and close it on an outside click or Esc.
  useEffect(() => {
    if (!argsOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) commit();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [argsOpen, commit]);

  return (
    <div
      className="file-viewer-run-controls"
      ref={wrapRef}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        className="file-viewer-format-btn"
        // Right-click opens the args popover. We act on mousedown, not the
        // contextmenu event: preventing the button's default focus-steal (needed
        // to keep the editor caret) suppresses `contextmenu` under WebKitGTK, so
        // that event never arrives. Left-click still runs via onClick.
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button === 2) open();
        }}
        onClick={onRun}
        onContextMenu={(e) => e.preventDefault()}
        disabled={busy}
        title={`${t("fileViewer.runFileTitle")}\n${t("fileViewer.rightClickArgs")}`}
        aria-label={t("fileViewer.runFileLabel")}
      >
        <PlayIcon /> {t("fileViewer.runLabel")}{args ? " *" : ""}
      </button>
      {showDebug && (
      <button
        className="file-viewer-format-btn"
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button === 2) open();
        }}
        onClick={onDebug}
        onContextMenu={(e) => e.preventDefault()}
        disabled={busy}
        title={
          (breakpointCount > 0
            ? t(
                breakpointCount === 1 ? "fileViewer.debugPdbLinesOne" : "fileViewer.debugPdbLinesMany",
                { count: breakpointCount },
              )
            : t("fileViewer.debugPdbFirstLine")) +
          `\n${t("fileViewer.rightClickArgs")}`
        }
        aria-label={t("fileViewer.debugFileLabel")}
      >
        <BugIcon /> {t("fileViewer.debugLabel")}
      </button>
      )}
      {/* Saved-args hover hint. Shown only while hovering, only when args are set,
          and never over the editor popover (which shows them already). */}
      {hovering && args && !argsOpen && (
        <div className="file-viewer-run-argshint" role="tooltip">
          <span className="file-viewer-run-argshint-label">{t("fileViewer.argsHintLabel")}</span>
          <span className="file-viewer-run-argshint-val">{args}</span>
        </div>
      )}
      {argsOpen && (
        <div className="file-viewer-run-args" role="dialog" aria-label={t("fileViewer.runArgumentsDialog")}>
          <label className="file-viewer-run-args-label">{t("fileViewer.argsFieldLabel")}</label>
          <input
            ref={inputRef}
            className="file-viewer-run-args-input"
            value={draft}
            spellCheck={false}
            placeholder="--epochs 5 data.csv"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setArgs(draft.trim());
                setArgsOpen(false);
                onRun();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setArgsOpen(false);
              }
            }}
          />
          <div className="file-viewer-run-args-row">
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setArgs(draft.trim());
                setArgsOpen(false);
                onRun();
              }}
            >
              <PlayIcon /> {t("fileViewer.runLabel")}
            </button>
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setDraft("");
                setArgs("");
              }}
              disabled={!draft}
              title={t("fileViewer.clearArgsTitle")}
            >
              {t("fileViewer.clearArgsBtn")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Human labels for the `#SBATCH` keys the directive form surfaces. Mirrors
 *  `HpcPipelineWizard.tsx`'s `SBATCH_LABEL_KEYS` (same field set, same keys). */
const SBATCH_FIELD_LABEL_KEYS: Record<string, TranslationKey> = {
  "job-name": "hpcWizard.sbatchJobName",
  account: "hpcWizard.sbatchAccount",
  partition: "hpcWizard.sbatchPartition",
  time: "hpcWizard.sbatchTime",
  nodes: "hpcWizard.sbatchNodes",
  ntasks: "hpcWizard.sbatchTasks",
  "cpus-per-task": "hpcWizard.sbatchCpusPerTask",
  mem: "hpcWizard.sbatchMemory",
  gres: "hpcWizard.sbatchGres",
  output: "hpcWizard.sbatchOutput",
};

/** Placeholder hints per key, so an empty field still teaches the format. */
const SBATCH_FIELD_HINTS: Record<string, string> = {
  "job-name": "myjob",
  account: "your-group",
  partition: "gpu",
  time: "01:00:00",
  nodes: "1",
  ntasks: "1",
  "cpus-per-task": "4",
  mem: "8G",
  gres: "gpu:1",
  output: "slurm-%j.out",
};

/**
 * The SLURM control bar (HPC), shown beside the Python Run bar for a `#SBATCH`
 * script on a host that has SLURM. **Submit job** submits it and opens a log tab;
 * **Variables** toggles the `#SBATCH` directive form (render rows, edit text — each
 * edit splices the draft, an ordinary undoable change); **Interactive session…**
 * opens a resource mini-form that launches an `srun --pty` shell on a compute node.
 * Carries an `UntestedTag` until QA'd on a real cluster.
 */
function SlurmBar({
  busy,
  fields,
  onField,
  onSubmit,
  onInteractive,
}: {
  busy: boolean;
  fields: { key: string; value: string }[];
  onField: (key: string, value: string) => void;
  onSubmit: () => void;
  onInteractive: (res: InteractiveResources) => void;
}) {
  const t = useT();
  const [varsOpen, setVarsOpen] = useState(false);
  const [interOpen, setInterOpen] = useState(false);
  // Per-field typed drafts, so a splice (and its undo step) happens on commit
  // (blur/Enter), not on every keystroke.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [inter, setInter] = useState<InteractiveResources>({
    time: "01:00:00",
    cpus: "4",
    mem: "8G",
    gpus: "",
    partition: "",
    account: "",
  });

  const valueFor = (key: string) =>
    edits[key] ?? directiveValue(fields, key);
  const commit = (key: string) => {
    const v = edits[key];
    if (v === undefined) return;
    onField(key, v);
  };

  return (
    <div className="file-viewer-run-controls">
      <button
        className="file-viewer-format-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSubmit}
        disabled={busy}
        title={t("fileViewer.submitSlurmTitle")}
        aria-label={t("fileViewer.submitSlurmLabel")}
      >
        <UploadIcon /> {t("fileViewer.submitJobLabel")}
      </button>
      <button
        className={`file-viewer-format-btn${varsOpen ? " active" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setVarsOpen((v) => !v); setInterOpen(false); }}
        title={t("fileViewer.editSbatchTitle")}
        aria-pressed={varsOpen}
      >
        {t("fileViewer.variablesBtn")}
      </button>
      <button
        className={`file-viewer-format-btn${interOpen ? " active" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setInterOpen((v) => !v); setVarsOpen(false); }}
        title={t("fileViewer.openInteractiveTitle")}
        aria-pressed={interOpen}
      >
        <BoltIcon /> {t("fileViewer.interactiveSessionLabel")}
      </button>
      <UntestedTag id="fileViewerPane.1" />

      {varsOpen && (
        <div className="file-viewer-run-args" role="dialog" aria-label={t("fileViewer.sbatchVariablesDialog")}>
          <label className="file-viewer-run-args-label">{t("fileViewer.sbatchDirectivesLabel")}</label>
          <div className="slurm-directive-grid">
            {COMMON_SBATCH_KEYS.map((key) => (
              <label key={key} className="slurm-directive-field">
                <span className="slurm-directive-key">
                  {SBATCH_FIELD_LABEL_KEYS[key] ? t(SBATCH_FIELD_LABEL_KEYS[key]) : key}
                </span>
                <input
                  className="file-viewer-run-args-input"
                  value={valueFor(key)}
                  spellCheck={false}
                  placeholder={SBATCH_FIELD_HINTS[key] ?? ""}
                  onChange={(e) => setEdits((m) => ({ ...m, [key]: e.target.value }))}
                  onBlur={() => commit(key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commit(key);
                    }
                  }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {interOpen && (
        <div className="file-viewer-run-args" role="dialog" aria-label={t("fileViewer.interactiveSessionDialog")}>
          <label className="file-viewer-run-args-label">{t("fileViewer.interactiveSessionFieldLabel")}</label>
          <div className="slurm-directive-grid">
            {([
              ["account", "hpcWizard.sbatchAccount", "your-group"],
              ["partition", "hpcWizard.sbatchPartition", "gpu"],
              ["time", "hpcWizard.sbatchTime", "01:00:00"],
              ["cpus", "hpcWizard.sbatchCpusPerTask", "4"],
              ["mem", "hpcWizard.sbatchMemory", "8G"],
              ["gpus", "fileViewer.sbatchGpus", "1"],
            ] as const).map(([k, labelKey, hint]) => (
              <label key={k} className="slurm-directive-field">
                <span className="slurm-directive-key">{t(labelKey)}</span>
                <input
                  className="file-viewer-run-args-input"
                  value={inter[k] ?? ""}
                  spellCheck={false}
                  placeholder={hint}
                  onChange={(e) => setInter((s) => ({ ...s, [k]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="file-viewer-run-args-row">
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setInterOpen(false); onInteractive(inter); }}
            >
              <BoltIcon /> {t("fileViewer.startLabel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Compare" toolbar toggle. When active the editor body is replaced by the
 *  three-column compare/merge view (old commit ⇄ live content ⇄ editable result). */
function CompareButton({ active, toggle }: { active: boolean; toggle: () => void }) {
  const t = useT();
  return (
    <button
      className={`file-viewer-format-btn file-viewer-compare-btn${active ? " active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      title={active ? t("fileViewer.compareCloseTitle") : t("fileViewer.compareOpenTitle")}
      aria-label={t("fileViewer.compareToggleLabel")}
      aria-pressed={active}
    >
      {t("fileViewer.compareBtn")}
    </button>
  );
}

/**
 * The capability-driven base editor for every text/source file. Beyond the
 * shared code editor (highlight, line numbers, Tab indent, undo/redo, save,
 * autocomplete) it derives per-format extras from the path:
 *   - a "Format" button for prettifiable types (JSON in-process; CSS/HTML/JS/
 *     YAML/Python/Rust/Go via a backend formatter when the tool is installed),
 *   - an inline JSON/YAML validation banner with jump-to-line,
 *   - a Preview ⇄ Edit toggle with a sandboxed rendered preview for HTML, SVG,
 *     and CSS (CSS applied to a sample document).
 * `type` keys the per-type prefs (font size / autocomplete); it is "text" for
 * the generic editor and "html" for HTML files so their settings stay distinct.
 */
function TextView({
  path,
  onOpenExternally,
  tabKey,
  type = "text",
  groupId,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  type?: InternalViewer;
  groupId?: string | null;
}) {
  const t = useT();
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const ai = useTabAiPrefs(tabKey, type);
  const ac = ai.ac;
  const sc = ai.sc;
  const font = useEditorFontSize(tabKey, type);
  const jump = useEditorJump(path);
  const [showBlame, setShowBlame] = useState(false);
  const blame = useBlame(path, showBlame);
  const [compareOpen, setCompareOpen] = useState(false);
  const viewPos = useViewerState(tabKey);
  // Live scroll offsets for the two views this pane toggles between: the Source
  // code editor (`scrollTop`) and the YAML Tree (`yamlScrollTop`). Held in refs,
  // not only persisted, because the pane stays mounted across the Tree↔Source
  // toggle but each inner view REMOUNTS — and would otherwise seed from
  // `viewPos.initial` (the stale open-time snapshot) and jump there. The ref
  // carries the live position so a switch back lands where the view was left.
  const srcScroll = useRef(viewPos.initial?.scrollTop ?? 0);
  const yamlScroll = useRef(viewPos.initial?.yamlScrollTop ?? 0);
  const persistScroll = useCallback(
    (scrollTop: number) => {
      srcScroll.current = scrollTop;
      viewPos.persist({ scrollTop });
    },
    [viewPos],
  );

  // ── Python (#py): run/debug + breakpoints + go-to-definition ──────────────
  // Run is available only for a "main" script — one with a module-level
  // `if __name__ == "__main__":` guard — not for every importable .py module,
  // which has nothing useful to execute. Debug (pdb) and the breakpoint gutter
  // that only exists to feed it sit behind the experimental `python_run_debug`
  // flag — off by default, on in debug mode (`lib/experimental.ts`).
  // Go-to-definition is deliberately NOT gated: it reads, it never runs anything.
  const isPy = useMemo(() => isPythonPath(path), [path]);
  const pyDebugEnabled = useExperimental("python_run_debug");
  const isMainScript = useMemo(
    () => isPy && loaded && isPythonMainScript(draft),
    [isPy, loaded, draft],
  );
  const pyRun = isMainScript;
  const pyDebug = isMainScript && pyDebugEnabled;
  const projectId = useFileScope();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const projectDir = project ? resolveProjectDirectory(project) : "";
  const remarksEnabled = useExperimental("project_remarks");
  const remarkRel = projectDir ? relativePathWithin(projectDir, path) : null;
  const caretApiRef = useRef<(() => number | null) | null>(null);
  const [remarkLine, setRemarkLine] = useState<number | null>(null);
  const bp = useBreakpoints(pyDebug, draft, loaded, viewPos);
  const [launching, setLaunching] = useState(false);
  // Arguments typed into the Run button's right-click popover, appended to the
  // command line (see pythonRun.buildRunCommand). Kept PER FILE (keyed by absolute
  // path in global settings), not per tab, so every viewer of the same script
  // shares one set of args — edit them in one tab and the others follow live,
  // because both read this same store selector — and so they survive closing the
  // viewer and a Tabtivity restart, and show in the Run button's hover tooltip.
  const pyArgs = useSettingsStore((s) => s.settings?.python_run_args?.[path] ?? "");
  const setPyArgs = useCallback(
    (v: string) => {
      void useSettingsStore.getState().setPythonRunArgs(path, v);
    },
    [path],
  );
  // Non-null inside a detached popout → the run terminal must stream into THIS
  // window, not the main tab store (see placeForFocused).
  const fileDrop = useContext(FileDropContext);

  // The tab runs in the project's own scope, not whichever project happens to be
  // active — a viewer keeps working after you switch projects (see FileScopeContext),
  // and its Run button must not fire a terminal into a different project's layout.
  const scope = projectId ?? "root";
  const cwd = runCwd(projectDir, path);
  // The local root this project's files mirror to (null for a local project) —
  // the same helper the Local/Remote switch and auto-sync path-building use, so
  // all three agree on which root a local-side path hangs off. A viewer has no
  // Remote/Local switch of its own, so this plus the host root is how
  // `pythonRunPlan` tells which side the open file lives on.
  const mirrorRoot = useMemo(() => localMirrorRootFor(project), [project]);
  // Built at click time, not memoized: the run-host preference is read imperatively
  // (the picker beside this button writes it) and must be the value at the click.
  const runPlan = useCallback(
    () =>
      pythonRunPlan({
        projectDir,
        remotePath: project?.remote?.remote_path,
        localRoot: mirrorRoot,
        file: path,
        runHostPref: projectId
          ? useRunHostPrefStore.getState().byProject[projectId]
          : undefined,
      }),
    [projectDir, project, mirrorRoot, path, projectId],
  );

  const launch = useCallback(
    async (go: () => Promise<void>) => {
      setLaunching(true);
      try {
        await go();
      } finally {
        setLaunching(false);
      }
    },
    [],
  );

  // Open the run/debug terminal in the focused subwindow of this project — where
  // the user is looking — rather than beside this tab's group.
  const onRun = useCallback(
    () =>
      void launch(() =>
        runPythonFile({
          file: path,
          plan: runPlan(),
          scope,
          projectId,
          args: pyArgs,
          place: placeForFocused(fileDrop),
        }),
      ),
    [launch, path, runPlan, scope, projectId, pyArgs, fileDrop],
  );
  const onDebug = useCallback(
    () =>
      void launch(() =>
        debugPythonFile({
          file: path,
          plan: runPlan(),
          scope,
          projectId,
          breakpoints: bp.lines,
          args: pyArgs,
          place: placeForFocused(fileDrop),
        }),
      ),
    [launch, path, runPlan, scope, projectId, bp.lines, pyArgs, fileDrop],
  );

  // ── SLURM (HPC): submit / interactive on a batch script ───────────────────
  // A `.slurm`-style file (one carrying a `#SBATCH` directive) gets a submit bar
  // beside the Python one — but only when the project's host actually has SLURM
  // (`slurm_available`), so the affordance never appears off-HPC. Everything here
  // rides the same terminal-tab machinery Run uses (`lib/remote/hpc/slurm.ts`).
  const isSlurm = useMemo(() => loaded && isSlurmScript(draft), [loaded, draft]);
  const [slurmInfo, setSlurmInfo] = useState<SlurmInfo | null>(null);
  useEffect(() => {
    if (!isSlurm || !projectDir) {
      setSlurmInfo(null);
      return;
    }
    let cancelled = false;
    slurmAvailable(projectDir)
      .then((info) => { if (!cancelled) setSlurmInfo(info); })
      .catch(() => { if (!cancelled) setSlurmInfo(null); });
    return () => { cancelled = true; };
  }, [isSlurm, projectDir]);
  const showSlurm = isSlurm && !!slurmInfo?.available;
  const isRemoteProject = !!project?.remote;

  const onSlurmSubmit = useCallback(
    () =>
      void launch(async () => {
        if (!projectId) return;
        await submitSlurmJob({
          file: path,
          projectDir,
          cwd,
          projectId,
          scope,
          isRemote: isRemoteProject,
          place: placeForFocused(fileDrop),
        });
      }),
    [launch, path, projectDir, cwd, projectId, scope, isRemoteProject, fileDrop],
  );
  const onSlurmInteractive = useCallback(
    (res: InteractiveResources) => {
      openInteractiveJob({
        scope,
        cwd,
        res,
        hostId: "primary",
        isRemote: isRemoteProject,
        place: placeForFocused(fileDrop),
      });
    },
    [scope, cwd, isRemoteProject, fileDrop],
  );

  // Ctrl/Cmd+Click a name to open its `def`/`class` — in this file or in the
  // module it was imported from. `jumpToSource` handles both: it re-uses an open
  // editor when there is one (including the same file, and across a detached
  // window) and otherwise opens the target in this tab's subwindow.
  const followPython = useCallback(
    async (caret: number) => {
      const loc = await resolvePythonDefinition(draft, caret, path, projectDir, async (p) => {
        try {
          return await readFileText(p, projectId);
        } catch {
          return null; // doesn't exist / unreadable — just not this candidate
        }
      });
      if (loc) jumpToSource(loc.path, loc.line, loc.column);
    },
    [draft, path, projectDir, projectId],
  );

  const fmt = useFormatter(path, draft, setDraft);
  const issue = useSyntaxCheck(path, draft, loaded);
  const previewKind = useMemo(() => previewKindForPath(path), [path]);
  // #yaml: for YAML and JSON the "preview" is an editable structure tree rather
  // than a rendered document — it writes back into this very draft (see YamlTree),
  // which is what lets Tree and Source be two views on one text and keeps
  // save/undo/format/validation working across both without either mode knowing
  // about the other. JSON is YAML's flow syntax, so it is the same tree, written
  // back in the stricter dialect (`strict`).
  const isYaml = useMemo(() => isTreePath(path), [path]);
  const jsonStrict = useMemo(() => isJsonPath(path), [path]);
  // #yaml-grid: the CARD view for structured YAML/JSON — a recursive grid of nested
  // cards, editing the same draft by splice (see YamlGrid). Offered only when the
  // file actually nests a collection worth carding, so the Cards toggle appears
  // exactly where it does something (the tree's honesty rule).
  // (`gridAvailable` itself is computed below, once the mode is known.)
  // A `.bib` gets the bibliography CARD list as its "preview" half (see BibCards):
  // one card per entry, its `field = {value}` pairs as rows, splicing this same
  // draft — so Cards and Source are two views on one text exactly as Tree and
  // Source are for YAML. It is a FLAT list of records, so it has nothing to do with
  // the YAML tree's nesting and shares none of its state.
  const isBib = useMemo(() => isBibPath(path), [path]);
  // Every type whose "preview" is an editable structured view of the same draft (as
  // opposed to a rendered document). They share the toggle, the live undo/redo and
  // the body's scroll persistence; a file is only ever one of them.
  const structured = isYaml || isBib;
  // YAML/JSON opens in the TREE view by default ("preview"), a `.bib` in its CARDS
  // view (same mode value — a file is only one of the two); HTML/SVG in preview; CSS
  // in the editor. The YAML card view stays available (via the toggle, when the file
  // nests something to card) but is no longer the default — it still needs work.
  const [mode, setMode] = useState<"preview" | "grid" | "edit">(
    structured ? "preview" : previewKind === "html" || previewKind === "svg" ? "preview" : "edit",
  );
  // Whether the Cards toggle is offered re-parses the whole file. In Source mode
  // that question only decides a header button, so it is asked of the draft once
  // typing settles rather than on every keystroke — a parse of a large JSON file
  // is tens of milliseconds of UI thread per key. The tree and the cards always
  // see the live draft (an edit there must retire the card mode at once).
  const editingSource = mode === "edit";
  const [settledDraft, setSettledDraft] = useState(draft);
  // Entering (or leaving) Source starts from the live draft, set during render
  // (React's derived-state pattern) so the toggle never shows a stale answer.
  const [settledFor, setSettledFor] = useState(editingSource);
  if (settledFor !== editingSource) {
    setSettledFor(editingSource);
    setSettledDraft(draft);
  }
  useEffect(() => {
    if (!isYaml || !editingSource) return;
    const id = window.setTimeout(() => setSettledDraft(draft), GRID_PROBE_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [isYaml, editingSource, draft]);
  const gridText = editingSource ? settledDraft : draft;
  const gridAvailable = useMemo(
    () => (isYaml && loaded ? hasCards(gridText, jsonStrict) : false),
    [isYaml, loaded, gridText, jsonStrict],
  );
  // A flat file (or a card edit that removes all nesting) has no card view — retire
  // the mode rather than strand it on a toggle with no button, dropping to the tree.
  useEffect(() => {
    if (mode === "grid" && !gridAvailable && loaded) setMode("preview");
  }, [mode, gridAvailable, loaded]);
  const fileName = basename(path);
  const jumpToLine = useCallback(
    (line: number, column: number) =>
      useEditorJumpStore.getState().requestJump(path, line, column),
    [path],
  );

  // A jump names a LINE, and a line only exists in Source — so an incoming one
  // (a `\cite` followed into this `.bib`, a search hit, reverse search) switches
  // a structured file out of its card/tree view rather than being swallowed by a
  // view that has no lines to scroll to. Keyed on the request's nonce, so a
  // repeat jump to the same line still fires and an ordinary toggle back to the
  // cards is not undone a frame later.
  const gotoNonce = jump.gotoLine?.nonce;
  useEffect(() => {
    if (gotoNonce != null && structured) setMode("edit");
  }, [gotoNonce, structured]);

  const showEditor = (!previewKind && !structured) || mode === "edit";
  const wheelRef = useZoomModifierWheel((e) => {
    onCtrlWheelFont(e, font.inc, font.dec);
  });

  // The Tree (and preview) scrolls `.file-viewer-body` itself; the Source editor
  // scrolls its own inner viewport instead (see CodeEditor). Keep a ref to the
  // body alongside the wheel-font ref so the tree's scroll can be persisted and
  // restored on the switch back from Source.
  const bodyEl = useRef<HTMLDivElement | null>(null);
  const bodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      bodyEl.current = el;
      wheelRef(el);
    },
    [wheelRef],
  );
  // The TREE and the bib CARD LIST persist/restore the body's scroll (the YAML card
  // grid scrolls its own inner container, the editor its own viewport). They share
  // `yamlScrollTop` because one file is never both — a `.bib` has no tree and a
  // `.yaml` has no bib cards — so there is one structured view per tab to remember.
  const treeScrolls = structured && mode === "preview";
  const showGrid = isYaml && mode === "grid" && gridAvailable;
  const scrollRaf = useRef<number | null>(null);
  const onBodyScroll = useCallback(() => {
    if (!treeScrolls) return;
    const el = bodyEl.current;
    if (!el) return;
    yamlScroll.current = el.scrollTop;
    // Coalesce the store write to one per frame — a flick of the wheel must not
    // churn the tabs array (and its debounced disk save) every scroll event.
    if (scrollRaf.current == null) {
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        viewPos.persist({ yamlScrollTop: yamlScroll.current });
      });
    }
  }, [treeScrolls, viewPos]);
  useEffect(
    () => () => {
      if (scrollRaf.current != null) cancelAnimationFrame(scrollRaf.current);
    },
    [],
  );
  // Restore the tree's scroll when it (re)mounts — on load, and on switching back
  // from Source. Layout effect so it lands before paint, with no visible jump.
  useLayoutEffect(() => {
    if (treeScrolls && loaded && bodyEl.current) {
      bodyEl.current.scrollTop = yamlScroll.current;
    }
  }, [treeScrolls, loaded]);

  // Print: HTML/SVG/CSS print their rendered preview document; plain text and
  // source print as a wrapped monospace block.
  const handlePrint = useCallback(() => {
    if (previewKind) {
      void printDocument(buildPreviewDoc(previewKind, draft));
      return;
    }
    void printHtmlBody(
      `<pre class="print-pre">${escapeHtml(draft)}</pre>`,
      TEXT_PRINT_CSS,
      fileName,
    );
  }, [previewKind, draft, fileName]);

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        {(previewKind || structured) && (
          <ModeToggle
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "preview",
                label: isYaml
                  ? t("fileViewer.modeTree")
                  : isBib
                    ? t("fileViewer.modeCards")
                    : t("fileViewer.modePreview"),
              },
              // The card view leads no longer — Tree is the default. It is still
              // offered, but only for a file with nesting to card (the tree's
              // honesty rule).
              ...(gridAvailable ? [{ value: "grid" as const, label: t("fileViewer.modeCards") }] : []),
              {
                value: "edit",
                label:
                  structured || previewKind === "svg"
                    ? t("fileViewer.modeSource")
                    : t("fileViewer.modeEdit"),
              },
            ]}
          />
        )}
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        {/* Which machine a Run/Debug lands on — shown right next to the Run button
            so the choice is co-located with running, and keyed by THIS viewer's
            `projectId`, the exact scope `onRun` reads the preference back under (a
            picker in the file panel is keyed by the *active* project, which can
            differ from the viewed file's project → the choice would be dropped and
            the run would fall back to the primary). Only for a remote project with
            extra worker machines; a lone-primary project has no machine to pick. */}
        {showEditor && pyRun && isRemoteProject && projectId &&
          (project?.compute_hosts?.length ?? 0) > 0 &&
          // Not for a file open from the LOCAL mirror: that one runs in a local
          // shell and the preference cannot overrule it (`pythonRunPlan`), so a
          // machine name here would state the opposite of what ▶ does.
          fileSideLocation(path, project?.remote?.remote_path) === "remote" && (
            <RunHostPicker
              projectId={projectId}
              primaryHost={project?.remote?.label || project?.remote?.host}
              computeHosts={project?.compute_hosts}
            />
          )}
        {showEditor && pyRun && (
          <RunDebugButtons
            breakpointCount={bp.lines.length}
            busy={launching}
            showDebug={pyDebug}
            args={pyArgs}
            setArgs={setPyArgs}
            onRun={onRun}
            onDebug={onDebug}
          />
        )}
        {showEditor && showSlurm && (
          <SlurmBar
            busy={launching}
            fields={parseSbatchDirectives(draft)}
            onField={(key, value) => setDraft(spliceDirective(draft, key, value))}
            onSubmit={onSlurmSubmit}
            onInteractive={onSlurmInteractive}
          />
        )}
        {showEditor && <EditorAiControls ai={ai} path={path} />}
        {showEditor && fmt.enabled && (
          <FormatButton available={fmt.available} busy={fmt.busy} run={() => void fmt.run()} />
        )}
        {showEditor && (
          <BlameButton active={showBlame} toggle={() => setShowBlame((v) => !v)} />
        )}
        {showEditor && (
          <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
        )}
        {showEditor && remarksEnabled && projectId && remarkRel != null && (
          <button
            type="button"
            className="file-viewer-icon-btn"
            title={t("projectRemarks.addMenu")}
            onClick={() => {
              const offset = caretApiRef.current?.() ?? 0;
              setRemarkLine(offsetToLineCol(draft, offset).line);
            }}
          >
            <CommentIcon /> <UntestedTag id="fileViewerPane.2" />
          </button>
        )}
        {/* The YAML tree and the bib cards edit the text, so their edits are
            ordinary undo steps — the buttons stay live in those modes, unlike in a
            read-only preview. */}
        {(showEditor || structured) && (
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        )}
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
        <PrintButton onPrint={handlePrint} disabled={!loaded} />
      </ViewerHeader>
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {saveError && <ErrorNote className="file-viewer-error" error={saveError} />}
      {fmt.status && <div className="file-viewer-status-line">{fmt.status}</div>}
      {(showEditor || structured) && <ValidationBanner issue={issue} onJump={jumpToLine} />}
      <div
        className={`file-viewer-body${showEditor ? " file-viewer-code-body" : ""}`}
        ref={bodyRef}
        onScroll={onBodyScroll}
      >
        {!showEditor && (previewKind || structured) ? (
          error != null ? (
            <div className="file-viewer-error">{error}</div>
          ) : !loaded ? (
            <div className="file-viewer-loading">{t("common.loading")}</div>
          ) : isBib ? (
            // One card per bibliography entry, splicing the same draft — a field
            // edit here is dirty, undoable and saveable exactly like a typed one.
            <BibCards
              text={draft}
              onChange={setDraft}
              tabKey={tabKey}
              fontSize={font.isCustom ? font.fontSize : undefined}
            />
          ) : showGrid ? (
            // The grid edits the same draft by splice, just like the tree — a cell
            // edit is dirty, undoable and saveable exactly like a typed one.
            <YamlGrid
              text={draft}
              onChange={setDraft}
              tabKey={tabKey}
              fontSize={font.isCustom ? font.fontSize : undefined}
              strict={jsonStrict}
            />
          ) : isYaml ? (
            // The tree edits the draft in place — the same draft Source shows and
            // Ctrl+S writes, so an edit made here is dirty, undoable and saveable
            // exactly like a typed one.
            <YamlTree
              text={draft}
              onChange={setDraft}
              tabKey={tabKey}
              fontSize={font.isCustom ? font.fontSize : undefined}
              strict={jsonStrict}
            />
          ) : (
            // Preview reflects the live draft, so it tracks unsaved edits.
            previewKind === "svg" ? (
              <SvgPreview content={draft} fileName={fileName} />
            ) : (
              <RenderedPreview kind={previewKind!} content={draft} fileName={fileName} />
            )
          )
        ) : compareOpen ? (
          <CompareView
            path={path}
            rightText={draft}
            onApply={(merged) => {
              setDraft(merged);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        ) : (
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            save={() => void save()}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            spellCheck={sc}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            wrap
            gotoLine={jump.gotoLine}
            onGotoApplied={jump.onGotoApplied}
            showBlame={showBlame}
            blame={blame}
            breakpoints={pyDebug ? bp.set : undefined}
            onToggleBreakpoint={pyDebug ? bp.toggle : undefined}
            onFollowLink={isPy ? followPython : undefined}
            linkRanges={isPy ? pythonLinkRanges : undefined}
            // The LIVE offset (not `viewPos.initial`), so re-showing Source after
            // a trip through Tree restores where the editor was, not the stale
            // open-time snapshot.
            initialScrollTop={srcScroll.current}
            onScrollPersist={persistScroll}
            groupId={groupId}
            caretApiRef={caretApiRef}
          />
        )}
      </div>
      {remarkLine != null && projectId && remarkRel != null && (
        <AddRemarkDialog projectId={projectId} projectDir={projectDir} file={remarkRel}
          line={remarkLine} onClose={() => setRemarkLine(null)} />
      )}
    </div>
  );
}

/** Markdown documents whose remote images the user chose to load this session.
 *  Module scope so the choice survives the tab remounting; deliberately not
 *  persisted, since "yes, fetch from these hosts" was said about a file's
 *  contents at one moment, and the file can change. */
const remoteImagesAllowed = new Set<string>();

// A graph source can restore its mode when a linked markdown tab returns to it.
const mdGraphShow = new Map<string, () => void>();

function MarkdownView({
  path,
  onOpenExternally,
  tabKey,
  groupId,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
}) {
  const t = useT();
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const scope = useFileScope();
  const visible = usePaneVisible();
  // The relationship-graph mode is opt-in (`md_graph` experimental flag): the
  // Graph button only renders while the flag is live, and a mode the flag
  // withdrew falls back to the preview rather than stranding a blank pane.
  const graphEnabled = useExperimental("md_graph");
  const [mode, setMode] = useState<"preview" | "edit" | "graph">("preview");
  useEffect(() => {
    if (!tabKey) return;
    mdGraphShow.set(tabKey, () => setMode("graph"));
    return () => { mdGraphShow.delete(tabKey); };
  }, [tabKey]);
  useEffect(() => {
    if (!graphEnabled && mode === "graph") setMode("preview");
  }, [graphEnabled, mode]);
  const [compareOpen, setCompareOpen] = useState(false);
  const font = useEditorFontSize(tabKey, "markdown");
  const wheelRef = useZoomModifierWheel((e) => onCtrlWheelFont(e, font.inc, font.dec));
  // Proportional scroll-link (preview mode only — edit mode links via CodeEditor's
  // textarea). `.file-viewer-body` is the overflow:auto scroller for the preview.
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const setBodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      wheelRef(el);
      bodyScrollRef.current = el;
    },
    [wheelRef],
  );
  const ai = useTabAiPrefs(tabKey, "markdown");
  const ac = ai.ac;
  const sc = ai.sc;
  const fmt = useFormatter(path, draft, setDraft);
  // Imperative editor handle the formatting toolbar drives (bold/italic/TOC/…).
  const editorApi = useRef<EditorApi | null>(null);
  const viewPos = useViewerState(tabKey);
  const persistScroll = useCallback(
    (scrollTop: number) => viewPos.persist({ scrollTop }),
    [viewPos],
  );
  // Keep the hidden DOM stable; regenerate from the latest draft on show.
  const lastPreview = useRef("");
  const html = useMemo(() => {
    if (!loaded) lastPreview.current = "";
    else if (visible && mode === "preview") lastPreview.current = renderMarkdown(draft);
    return lastPreview.current;
  }, [loaded, draft, visible, mode]);
  // Register the preview scroller only while in preview mode, so it never fights
  // CodeEditor for the same group id (edit mode links via the textarea instead).
  const reportPreviewSync = useScrollSync(mode === "preview" ? groupId : null, bodyScrollRef);
  const graphOrigin = tabKey ? findTabByKey(useTabsStore.getState(), tabKey)?.mdGraphOriginKey : undefined;
  const canReturnToGraph = graphEnabled && graphOrigin && findTabByKey(useTabsStore.getState(), graphOrigin);

  // After the preview HTML is committed to the DOM, run the mermaid/KaTeX
  // enrichment pass (Dev A): it finds the mermaid code blocks and math
  // placeholders renderMarkdown emitted and renders them in place. Re-runs
  // whenever the rendered HTML changes or we switch back to preview mode.
  // The module is imported HERE, not at the top of the file (§5.3 startup
  // size): mermaid + katex + the katex CSS initialize at its module
  // evaluation, so a static import would pay that at every window's launch
  // instead of at the first markdown preview. Placeholders render as plain
  // source until the chunk lands (milliseconds), then enrich in place.
  const previewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible || mode !== "preview") return;
    if (!previewRef.current) return;
    let cancelled = false;
    void import("../../lib/viewers/markdownEnrich").then((m) => {
      // Re-read the ref after the await: the pane may have unmounted, or the
      // effect re-run for newer HTML (that run enriches the current DOM).
      const el = previewRef.current;
      if (!cancelled && el) void m.enrichMarkdownDom(el);
    });
    return () => {
      cancelled = true;
    };
  }, [html, mode, visible]);

  // #49/#50: local-file links in the rendered preview open in-app. Unlike the
  // source editor, Preview has no caret interaction to preserve, so a normal
  // click follows the usual Markdown convention.
  const [linkTip, setLinkTip] = useState<{
    left: number;
    top: number;
    destination: string;
  } | null>(null);
  // Kept local to the viewer rather than routed through AppShell's project toast:
  // Markdown tabs can live in detached windows, where the main shell's toast
  // would appear in the wrong window (or not be visible at all).
  const [copyNotice, setCopyNotice] = useState(0);
  const copyNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current);
    },
    [],
  );

  const images = useMemo(() => new PreviewImages(
    (target) => readFileBytes(target, scope), imageMimeForPath,
  ), [scope]);
  useEffect(() => () => images.dispose(), [images]);
  useEffect(() => {
    images.pause(!visible || mode !== "preview");
    return () => images.pause(true);
  }, [images, visible, mode]);
  useEffect(() => {
    if (!visible || mode !== "preview") return;
    const root = previewRef.current;
    if (!root) return;
    let cancelled = false;
    const targets = new Map<HTMLImageElement, string>();
    for (const img of root.querySelectorAll<HTMLImageElement>("img.md-img-local[data-md-src]")) {
      const target = resolveLocalHref(path, img.getAttribute("data-md-src") ?? "");
      if (target) targets.set(img, target);
    }
    images.retain(new Set(targets.values()));
    const load = (img: HTMLImageElement) => {
      const target = targets.get(img);
      if (!target) return;
      void images.load(target).then((url) => {
        if (!cancelled && url) img.src = url;
      });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) {
          load(entry.target as HTMLImageElement);
          observer?.unobserve(entry.target);
        }
      }, { root: bodyScrollRef.current, rootMargin: "300px" },
    );
    for (const img of targets.keys()) {
      if (observer) observer.observe(img);
      else load(img);
    }
    return () => { cancelled = true; observer?.disconnect(); };
  }, [html, mode, visible, path, images]);

  // Remote (http/https) images render as placeholders and fetch nothing until
  // the user presses Load in the banner: a document must not be able to make
  // the app contact a server just by being opened (tracking, or a leak out of a
  // VM/agent sandbox through the host). The fetch itself is the backend's
  // (`markdown_remote_image`), and the result lands as a blob: URL, which the
  // CSP already allows.
  const [remoteUrls, setRemoteUrls] = useState<string[]>([]);
  const [, bumpRemoteAllowed] = useState(0);
  const remoteAllowed = remoteImagesAllowed.has(path);
  const remoteMime = useRef(new Map<string, string>());
  const remoteImages = useMemo(() => new PreviewImages(
    async (url) => {
      const image = await fetchRemoteImage(url);
      remoteMime.current.set(url, image.mime);
      return image.bytes;
    },
    (url) => remoteMime.current.get(url) ?? "application/octet-stream",
  ), []);
  useEffect(() => () => remoteImages.dispose(), [remoteImages]);
  useEffect(() => {
    remoteImages.pause(!visible || mode !== "preview");
    return () => remoteImages.pause(true);
  }, [remoteImages, visible, mode]);
  useEffect(() => {
    if (!visible || mode !== "preview") return;
    const root = previewRef.current;
    if (!root) return;
    const spans = Array.from(root.querySelectorAll<HTMLElement>("span.md-img-remote[data-md-remote]"));
    const urls = [...new Set(spans.map((s) => s.dataset.mdRemote ?? "").filter(Boolean))];
    setRemoteUrls((prev) => (prev.length === urls.length && prev.every((u, i) => u === urls[i]) ? prev : urls));
    if (!remoteAllowed) return;
    let cancelled = false;
    remoteImages.retain(new Set(urls));
    for (const span of spans) {
      const url = span.dataset.mdRemote;
      // A failed image is not retried on every re-render; reopening the
      // document (or editing it) gives it a fresh placeholder to try again.
      if (!url || span.classList.contains("is-loaded") || span.classList.contains("is-failed")) continue;
      span.classList.add("is-loading");
      void remoteImages.load(url).then((blobUrl) => {
        if (cancelled || !span.isConnected) return;
        span.classList.remove("is-loading");
        if (!blobUrl) {
          span.classList.add("is-failed");
          span.title = `${t("fileViewer.remoteImageFailed")}\n${url}`;
          return;
        }
        const img = document.createElement("img");
        img.src = blobUrl;
        img.alt = span.textContent ?? "";
        span.replaceChildren(img);
        span.classList.add("is-loaded");
      });
    }
    return () => { cancelled = true; };
  }, [html, mode, visible, remoteAllowed, remoteImages, t]);

  // Cross-file `#fragment` navigation (stores/viewers/mdAnchor): when a followed link
  // into this document carried a fragment, scroll the rendered preview to that
  // heading once the preview exists — covering both a freshly opened tab (the
  // request outlives the mount) and an already-open one (`openLinkedFile`
  // re-activates it, and this store is how the fragment still arrives).
  // Consumed after one attempt in preview mode, found or not — a fragment
  // naming no heading is an authoring fact, not a standing order. While Edit
  // mode is showing, the request is left pending and applies on the switch
  // back to Preview.
  const anchorReq = useMdAnchorStore((s) => s.requestsByPath[path]);
  useEffect(() => {
    if (!anchorReq || mode !== "preview" || !loaded) return;
    const root = previewRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>("[id]"));
    const id = matchAnchorId(els.map((el) => el.id), anchorReq.fragment);
    if (id) els.find((el) => el.id === id)?.scrollIntoView({ block: "start" });
    useMdAnchorStore.getState().consume(path);
  }, [anchorReq, mode, loaded, html, path]);

  // Print the rendered Markdown. Prefer the live preview DOM (it carries the
  // enriched mermaid/KaTeX output and inlined local images); fall back to a fresh
  // render of the current draft when Edit mode has the preview unmounted.
  const handlePrint = useCallback(() => {
    const inner = previewRef.current?.innerHTML || html || renderMarkdown(draft);
    void printHtmlBody(
      `<div class="markdown-body">${inner}</div>`,
      MARKDOWN_PRINT_CSS,
      basename(path),
    );
  }, [html, draft, path]);

  // Every preview link reports its destination on hover. Resolve local file
  // paths against this Markdown file so `docs/guide.md` is unambiguous even when
  // multiple projects contain a file with that name; leave external URLs and
  // in-document fragments as authored.
  const onPreviewMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.("a") as HTMLAnchorElement | null;
    if (!a) {
      setLinkTip((current) => current ? null : current);
      return;
    }
    const href = a.getAttribute("href") ?? "";
    const resolved = a.classList.contains("file-link")
      ? resolveLocalHref(path, href)
      : null;
    const fragment = href.match(/[?#].*$/)?.[0] ?? "";
    const destination = resolved ? `${resolved}${fragment}` : href;
    const rect = a.getBoundingClientRect();
    setLinkTip((current) =>
      current?.destination === destination
        ? current
        : { left: rect.left, top: rect.top, destination },
    );
  }, [path]);

  // Copy-on-select for the rendered preview, matching the native terminal.
  // Mouse-up covers drag and double/triple-click selection while keeping the
  // clipboard write inside the user gesture required by WebKit. Both endpoints
  // must belong to this preview so a selection crossing into adjacent chrome or
  // another tiled pane cannot replace the clipboard unexpectedly.
  const onPreviewMouseUp = useCallback(() => {
    const root = previewRef.current;
    const selection = window.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !root.contains(selection.anchorNode) ||
      !root.contains(selection.focusNode)
    ) return;
    const text = selection.toString();
    const clipboard = navigator.clipboard;
    if (!text || !clipboard) return;
    void clipboard.writeText(text).then(() => {
      setCopyNotice((notice) => notice + 1);
      if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current);
      copyNoticeTimer.current = setTimeout(() => setCopyNotice(0), 2200);
    }).catch(() => {});
  }, []);

  const onPreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Task-list checkboxes toggle the underlying `- [ ]`/`- [x]` in the draft.
      // The clicked box's position among all task checkboxes in the preview is its
      // document order — exactly toggleTaskCheckbox's index — so we count them and
      // flip the matching source line. The native toggle stands until the re-render
      // reconciles it from the (now-updated) source, so there is no flicker.
      const box = (e.target as HTMLElement).closest?.(
        "li.task-item > input[data-md-task]",
      ) as HTMLInputElement | null;
      if (box) {
        const root = previewRef.current;
        if (!root) return;
        const boxes = Array.from(
          root.querySelectorAll<HTMLInputElement>("li.task-item > input[data-md-task]"),
        );
        const index = boxes.indexOf(box);
        if (index < 0) return;
        const nextSrc = toggleTaskCheckbox(draft, index);
        if (nextSrc != null) setDraft(nextSrc);
        return;
      }
      const a = (e.target as HTMLElement).closest?.("a") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        e.preventDefault();
        const els = Array.from(
          previewRef.current?.querySelectorAll<HTMLElement>("[id]") ?? [],
        );
        const id = matchAnchorId(els.map((element) => element.id), href.slice(1));
        if (id) els.find((element) => element.id === id)?.scrollIntoView({ block: "start" });
        return;
      }
      if (!a.classList.contains("file-link")) return;
      // Keep local paths inside Tabtivity rather than allowing the webview to
      // navigate away from the native preview.
      e.preventDefault();
      const hinted = splitLineHint(href);
      const target = resolveLocalHref(path, href);
      if (!target) return;
      openLinkedFile(tabKey, dirname(path), {
        path: target,
        viewer: viewerForPath(target),
        label: basename(target),
      });
      if (hinted.line != null) {
        useEditorJumpStore.getState().requestJump(target, hinted.line);
      }
      // A fragment on a cross-file markdown link (`docs/guide.md#setup`) rides
      // the anchor channel: the target view — freshly mounted or re-activated —
      // consumes it once its preview is rendered.
      const fragment = href.split("#").slice(1).join("#");
      if (fragment && viewerForPath(target) === "markdown") {
        useMdAnchorStore.getState().requestAnchor(target, fragment);
      }
    },
    [path, tabKey, draft, setDraft],
  );

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        {canReturnToGraph && (
          <button
            className="md-graph-back"
            disabled={isDirty || saving}
            title={t(isDirty || saving ? "mdGraph.backSaveFirst" : "mdGraph.back")}
            onClick={() => {
              if (!tabKey || !graphOrigin) return;
              mdGraphShow.get(graphOrigin)?.();
              const store = useTabsStore.getState();
              store.setActive(graphOrigin);
              store.removeTab(tabKey);
            }}
          >
            ← {t("mdGraph.back")}
            <UntestedTag id="mdGraph.back" />
          </button>
        )}
        <div className="file-viewer-modes">
          <button
            className={`file-viewer-mode${mode === "preview" ? " active" : ""}`}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            {t("fileViewer.modePreview")}
          </button>
          <button
            className={`file-viewer-mode${mode === "edit" ? " active" : ""}`}
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            {t("fileViewer.modeEdit")}
          </button>
          {graphEnabled && (
            <button
              className={`file-viewer-mode${mode === "graph" ? " active" : ""}`}
              aria-pressed={mode === "graph"}
              onClick={() => setMode("graph")}
            >
              {t("fileViewer.modeGraph")}
            </button>
          )}
        </div>
        {mode === "edit" && <MarkdownToolbar api={editorApi} />}
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        {mode === "edit" && <EditorAiControls ai={ai} path={path} />}
        {mode === "edit" && fmt.enabled && (
          <FormatButton available={fmt.available} busy={fmt.busy} run={() => void fmt.run()} />
        )}
        {mode === "edit" && (
          <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
        )}
        {mode === "edit" && (
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        )}
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
        <PrintButton onPrint={handlePrint} disabled={!loaded} />
      </ViewerHeader>
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {saveError && <ErrorNote className="file-viewer-error" error={saveError} />}
      {mode === "edit" && fmt.status && (
        <div className="file-viewer-status-line">{fmt.status}</div>
      )}
      {mode === "preview" && loaded && remoteUrls.length > 0 && !remoteAllowed && (
        <div className="file-viewer-reload-banner" role="status">
          <span>
            {t("fileViewer.remoteImagesBlocked", {
              count: remoteUrls.length,
              hosts: hostsLabel(remoteImageHosts(remoteUrls)),
            })}
          </span>
          <UntestedTag id="fileViewerPane.3" />
          <button
            className="file-viewer-reload-btn"
            title={t("fileViewer.remoteImagesLoadTitle")}
            onClick={() => {
              remoteImagesAllowed.add(path);
              bumpRemoteAllowed((n) => n + 1);
            }}
          >
            {t("fileViewer.remoteImagesLoad")}
          </button>
        </div>
      )}
      <div
        className={`file-viewer-body${mode === "edit" ? " file-viewer-code-body" : ""}`}
        ref={setBodyRef}
        onScroll={reportPreviewSync}
      >
        {mode === "graph" ? (
          <MdGraphView
            path={path}
            onOpen={(target) => {
              const viewer = viewerForPath(target);
              openLinkedFile(tabKey, dirname(path), {
                path: target,
                viewer,
                label: basename(target),
                mdGraphOriginKey: viewer === "markdown" ? tabKey : undefined,
              });
            }}
          />
        ) : mode === "edit" && compareOpen ? (
          <CompareView
            path={path}
            rightText={draft}
            onApply={(merged) => {
              setDraft(merged);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        ) : mode === "edit" ? (
          // The shared code editor gives markdown the same Tab/undo/save behaviour
          // as the text/tex viewers — and local autocomplete (#45). `wrap` so prose
          // soft-wraps. It renders its own load/error states.
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            save={() => void save()}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            spellCheck={sc}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            wrap
            editorApiRef={editorApi}
            initialScrollTop={viewPos.initial?.scrollTop}
            onScrollPersist={persistScroll}
            groupId={groupId}
          />
        ) : error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">{t("common.loading")}</div>
        ) : (
          <div
            ref={previewRef}
            className="markdown-body"
            // Leave the preview at its CSS default until the user sets a size,
            // then drive the base font-size so headings (em-based) scale with it.
            style={font.isCustom ? { fontSize: `${font.fontSize}px` } : undefined}
            onMouseMove={onPreviewMove}
            onMouseUp={onPreviewMouseUp}
            onMouseLeave={() => setLinkTip(null)}
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
      {mode === "preview" && <LinkOpenHint at={linkTip} label={linkTip?.destination} />}
      {copyNotice > 0 && (
        <div key={copyNotice} className="project-switch-toast" role="status" aria-live="polite">
          {t("fileViewer.copiedToClipboard")}
        </div>
      )}
    </div>
  );
}

/** Load a file's bytes and expose them as a Blob object URL, used by the image
 *  viewer (<img> sniffs the type). Like the editors/PDF (#43), it polls
 *  `file_mtime` and re-reads the bytes when the file changes on disk, so an image
 *  regenerated by an external tool updates in place. A same-path reload swaps the
 *  URL only once the new bytes are ready (no flash to a loading state); the old
 *  URL is revoked then, and the last URL is revoked on unmount. */
function useBlobUrl(path: string, type: string) {
  const scope = useFileScope();
  const t = useT();
  const paneVisible = usePaneVisible();
  const [url, setUrl] = useState<string | null>(null);
  // The failure is held as a translation KEY, not a sentence: the read effects
  // must not depend on `t` (a language flip would re-run them and discard an
  // unsaved draft), and holding the key makes the message follow the language.
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const error = errorKey ? t(errorKey) : null;
  const urlRef = useRef<string | null>(null);
  const lastMtime = useRef<number | null>(null);
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);

  // Reset to the loading state when the path itself changes (a genuine file
  // switch). A same-path reload (a diskVersion bump) keeps the current image up
  // until the fresh bytes arrive, so the view doesn't flash.
  useEffect(() => {
    setUrl(null);
    setErrorKey(null);
    lastMtime.current = null;
  }, [path]);

  // Load on mount, path switch, or on-disk change; revoke the previous URL only
  // once its replacement is ready.
  useEffect(() => {
    let cancelled = false;
    readFileBytes(path, scope)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(bytes)], type ? { type } : undefined);
        const objectUrl = URL.createObjectURL(blob);
        const prev = urlRef.current;
        urlRef.current = objectUrl;
        setUrl(objectUrl);
        if (prev) URL.revokeObjectURL(prev);
      })
      .catch((e) => { if (!cancelled) setErrorKey(describeFileErrorKey(e)); });
    return () => { cancelled = true; };
  }, [path, type, diskVersion, scope]);

  // Revoke the last live URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    },
    [],
  );

  // Seed the mtime baseline once per file, visible or not, so it pairs with the
  // bytes the load effect read — the re-show catch-up below compares against it.
  useEffect(() => {
    let cancelled = false;
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope]);

  // Poll mtime; on an external advance, bump diskVersion to re-read fresh bytes.
  // Visible panes only; the immediate check on re-show catches a hidden-time change.
  useEffect(() => {
    if (!paneVisible) return;
    let cancelled = false;
    const check = () => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          setDiskVersion((v) => v + 1);
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, paneVisible]);

  return { url, error };
}


/**
 * The in-tab LaTeX viewer. It always offers the same editable code editor as the
 * plain-text viewer; on top of that, when a TeX engine is on PATH it adds a
 * compile toolbar:
 *   - Compile saves the source first (it's editable) then runs `compile_tex`,
 *     which builds `<stem>.pdf` next to the source. On success the PDF is opened
 *     in its own tab (or the existing PDF tab is refocused) rather than an inline
 *     preview pane — the PDF tab polls the file's mtime, so a recompile reloads
 *     the fresh bytes on its own. On failure the build-log tail is shown with an
 *     expandable full log.
 *   - With no engine available it renders exactly the plain-text editor — no
 *     compile UI — so a TeX-less machine keeps the prior behaviour. While
 *     capability is still loading it shows the editor too, to avoid a flash of a
 *     different layout.
 *   - The engine selector only appears when more than one engine is on PATH;
 *     otherwise the backend default is used (`engine: null`).
 */

/** OS-appropriate command to install a LaTeX/TeX distribution, used by the
 *  one-click "Install LaTeX" prompt shown when no TeX engine is on PATH. These
 *  are best-effort defaults the user can edit in the spawned terminal: MiKTeX on
 *  Windows, MacTeX on macOS (Homebrew), TeX Live on Linux (Debian/Ubuntu apt). */
const TEX_INSTALL_CMD = IS_WINDOWS
  ? "winget install --id MiKTeX.MiKTeX -e"
  : IS_MAC
    ? "brew install --cask mactex-no-gui"
    : "sudo apt-get install -y texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended latexmk";

/** True when `path` is the main document or any enumerated child/graphic of the
 *  workspace structure — i.e. a target a sidebar/link switch should center rather
 *  than open in a new tab. */
function texWorkspaceContains(structure: TexStructure, path: string): boolean {
  const walk = (n: TexFileNode): boolean => {
    if (n.path === path) return true;
    if (n.graphics.some((g) => g.path === path)) return true;
    return n.children.some(walk);
  };
  return walk(structure.root);
}

/** How a `.tex` is built: the engine (`""` = let the backend pick) and the #54
 *  options. One value per *document*, not per file — see `TexView.compileOpts`. */
type TexCompileOpts = { engine: string; outDir: string; extraFlags: string };
const EMPTY_TEX_COMPILE_OPTS: TexCompileOpts = { engine: "", outDir: "", extraFlags: "" };

/** A tab's persisted build configuration (see `ViewerState.texEngine`), with the
 *  defaults filled in for a tab that has never had one. */
function texCompileOptsFrom(vs: ViewerState | undefined): TexCompileOpts {
  return {
    engine: vs?.texEngine ?? EMPTY_TEX_COMPILE_OPTS.engine,
    outDir: vs?.texOutDir ?? EMPTY_TEX_COMPILE_OPTS.outDir,
    extraFlags: vs?.texExtraFlags ?? EMPTY_TEX_COMPILE_OPTS.extraFlags,
  };
}

/** The same patch, in `ViewerState` spelling. Only the keys actually being
 *  changed are written, so a patch of one field never restates the other two. */
function texCompileViewerState(patch: Partial<TexCompileOpts>): ViewerState {
  const vs: ViewerState = {};
  if (patch.engine !== undefined) vs.texEngine = patch.engine;
  if (patch.outDir !== undefined) vs.texOutDir = patch.outDir;
  if (patch.extraFlags !== undefined) vs.texExtraFlags = patch.extraFlags;
  return vs;
}

// The most panes kept mounted in the workspace center at once. Switching between
// them is display:none, not remount, so an unsaved draft / undo / scroll of a
// file you flipped away from survives — the same guarantee two standalone `.tex`
// tabs have (CenterPanel keeps both mounted). Beyond the cap the LEAST-recently
// used CLEAN pane is dropped; a dirty pane (or the main file) is never evicted.
const TEX_WS_MAX_PANES = 12;
const TEX_WS_SIDEBAR_DEFAULT = 240;
// How many previously-centered files the workspace's ← button can walk back
// through. A cap rather than an unbounded list: nobody steps back through a
// hundred files, and the stack holds absolute paths for the life of the tab.
const TEX_WS_BACK_MAX = 50;

/**
 * The LaTeX WORKSPACE host: one tab that composes the left structure sidebar and
 * a keep-mounted center that switches between the reused `TexView` (a `.tex`) and
 * `ImageView`/`PdfView`/`TextView` (a graphic) for the selected file. The
 * compiled PDF is its OWN tab, opened beside the workspace via `openLinkedFile`.
 * SyncTeX still works both ways across that tab boundary: forward search lands via
 * the path-keyed `pdfSync` reveal, and a reverse click's `jumpToSource` routes
 * back into this workspace (`focusTexWorkspaceForSource`) to switch the center.
 *
 * It reuses the existing viewer components verbatim; the only new pieces are the
 * sidebar (a separate leaf) and this thin host. Everything the host needs is
 * already in `FileViewerPane`'s module scope (`TexView`, `ImageView`, `viewerForPath`,
 * `jumpToSource`), so it lives here inline rather than in its own file — that
 * avoids exporting the pane components and the `FileViewerPane ↔ workspace`
 * import cycle a separate file would create.
 *
 * One-side-per-tab: `mainPath` is the tab's EFFECTIVE path, so every child is
 * enumerated and shown on the same side (host SFTP vs local mirror) as the main.
 * Flipping the tab's Local/Remote switch re-roots `mainPath` and re-enumerates.
 */
function TexWorkspaceView({
  mainPath,
  projectId,
  tabKey,
  groupId,
  onOpenExternally,
}: {
  mainPath: string;
  projectId: string | null;
  tabKey?: string;
  groupId?: string | null;
  onOpenExternally: () => void;
}) {
  const t = useT();
  const workspaceVisible = usePaneVisible();

  // The parsed document structure (children + graphics). Re-gathered on mount, on
  // a root/side change, and after each successful compile (structureVersion bump).
  // A gather failure degrades to a degenerate one-node structure so the sidebar —
  // and its UntestedTag pill — still render.
  const [structure, setStructure] = useState<TexStructure | null>(null);
  const [structureVersion, setStructureVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const disabled = disabledViewers(useSettingsStore.getState().settings?.viewer_prefs);
    gatherTexStructure(mainPath, projectId, disabled)
      .then((s) => { if (!cancelled) setStructure(s); })
      .catch(() => {
        if (!cancelled)
          setStructure({ root: { path: mainPath, label: basename(mainPath), graphics: [], children: [] } });
      });
    return () => { cancelled = true; };
  }, [mainPath, projectId, structureVersion]);

  // Where this tab's ViewerState (the centered file, the sidebar width) actually
  // lives. In the MAIN window the layout store owns it, and the reads below are
  // reactive so a sidebar/link switch re-renders. In a DETACHED popout the store
  // has NO entry for the tab — its tabs render from a Tauri seed into local React
  // state (see `seedViewerState`) — so a store read is forever undefined and a
  // store WRITE is a silent no-op, which pinned the center to the main file and
  // killed the sidebar-resize in a popout. So keep a local mirror seeded from the
  // persisted state, treat the
  // store as the source of truth only when it actually holds the tab, and persist
  // to BOTH (the store write round-trips through the main window's layout save;
  // in a popout it is a harmless no-op and the local mirror drives the UI).
  const storeVs = useTabsStore((s) =>
    tabKey ? findTabByKey(s, tabKey)?.viewerState : undefined,
  );
  const [localVs, setLocalVs] = useState<ViewerState>(() => seedViewerState(tabKey) ?? {});
  const patchViewerState = useCallback(
    (patch: ViewerState) => {
      setLocalVs((prev) => ({ ...prev, ...patch }));
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );

  // The centered file: the persisted `texActivePath` when it still resolves in the
  // structure, else the main document (a stale id is inert).
  const storedActive = storeVs?.texActivePath ?? localVs.texActivePath;
  const activePath = useMemo(() => {
    if (!storedActive || storedActive === mainPath) return mainPath;
    if (structure && !texWorkspaceContains(structure, storedActive)) return mainPath;
    return storedActive;
  }, [storedActive, mainPath, structure]);

  const setActivePath = useCallback((p: string) => patchViewerState({ texActivePath: p }), [patchViewerState]);

  // Where the center has BEEN, most-recent last — the back stack behind the ←
  // button. Clicking a child in the sidebar (or following a `\ref`, or a SyncTeX
  // reverse jump) replaces what is centered, and until this existed the only way
  // back to the chapter you came from was to find it in the tree again — which for
  // a graphic reached from a figure three files deep is a search rather than a
  // step. Session state, deliberately NOT persisted: a stack restored from disk
  // would offer to go "back" to a file this sitting never left, and where you were
  // ten minutes before a relaunch is not a thing anyone is holding in their head.
  // Bounded, because a long editing session walks a lot of files.
  const [backStack, setBackStack] = useState<string[]>([]);
  // A side switch (Local/Remote) re-roots every path in the workspace, so the
  // stack it was built from names files on the other side.
  useEffect(() => { setBackStack([]); }, [mainPath]);

  // THE navigation: every path that replaces the center goes through here — the
  // sidebar, an in-document link, a SyncTeX jump — so nothing can move the center
  // without the back stack learning about it. A re-select of what is already
  // centered is not a step, or ← would walk a file back onto itself.
  const goTo = useCallback(
    (p: string) => {
      if (p === activePath) return;
      setBackStack((prev) => [...prev, activePath].slice(-TEX_WS_BACK_MAX));
      setActivePath(p);
    },
    [activePath, setActivePath],
  );
  const backTarget = backStack[backStack.length - 1];
  const backLabel = backTarget ? basename(backTarget) : undefined;
  const goBack = useCallback(() => {
    if (backTarget === undefined) return;
    setBackStack((prev) => prev.slice(0, -1));
    setActivePath(backTarget);
  }, [backTarget, setActivePath]);

  // UP (#tex-structure-up): from a chapter to the `\input{chapter}` line of the
  // file that inputs it. Back retraces where the center has been; Up climbs the
  // document's own tree, so it works for a child reached by a sidebar click, a
  // SyncTeX jump or a restored tab alike — the parent need never have been
  // centered this sitting. It is a navigation like any other (through `goTo`,
  // so ← undoes it), followed by a caret jump to the reference itself: landing
  // at the parent's top would leave the reader searching the file for the line
  // they just came from, which is the whole thing this step exists to skip.
  const upTarget = useMemo(
    () => (structure ? texStructureParent(structure, activePath) : null),
    [structure, activePath],
  );
  const goUp = useCallback(() => {
    if (!upTarget) return;
    goTo(upTarget.path);
    if (upTarget.line) useEditorJumpStore.getState().requestJump(upTarget.path, upTarget.line, upTarget.column);
  }, [upTarget, goTo]);
  const upLabel = upTarget ? basename(upTarget.path) : undefined;

  // The two chords (Alt+Shift+↑ / Alt+Shift+↓ by default, rebindable in the
  // Keyboard Shortcuts panel). Listened for on the workspace's own root rather
  // than in `useKeyboard`: they mean nothing outside a workspace tab, so the
  // scope is "focus is somewhere in this workspace" — the editor's textarea,
  // the sidebar, a viewer in the center — which the bubbling keydown gives for
  // free, and which is exactly where the global hook's editable-target guard
  // would have dropped them. A workspace in a popout gets them the same way,
  // with no per-window wiring. Only a chord that can act is consumed.
  const shortcutOverrides = useSettingsStore((s) => s.settings?.keyboard_shortcuts) as
    | ShortcutMap
    | undefined;
  const upChord = useMemo(() => chordLabel(resolveChord("texUp", shortcutOverrides)), [shortcutOverrides]);
  const backChord = useMemo(() => chordLabel(resolveChord("texBack", shortcutOverrides)), [shortcutOverrides]);
  const onWorkspaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const ev = e.nativeEvent;
      if (upTarget && chordMatches(resolveChord("texUp", shortcutOverrides), ev)) {
        e.preventDefault();
        e.stopPropagation();
        goUp();
      } else if (backTarget !== undefined && chordMatches(resolveChord("texBack", shortcutOverrides), ev)) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      } else if (chordMatches(resolveChord("texCompile", shortcutOverrides), ev)) {
        // Compile from anywhere in the workspace that is not an editor pane —
        // the structure sidebar, the error list, the toolbar. A pane handles
        // the chord itself and stops it before it gets here; this is the
        // fallback, routed through the same registry the PDF's rebuild uses so
        // the mounted editor (which owns the draft and the options) runs the
        // build. Only consumed when someone answered.
        if (compileTexWorkspace(activePath) || compileTexWorkspace(mainPath)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    [upTarget, backTarget, shortcutOverrides, goUp, goBack, activePath, mainPath],
  );

  // Advertise this workspace to SyncTeX reverse search (#42): a reverse click's
  // `focusTexWorkspaceForSource` centers it through the `texCenter` registry —
  // the ONLY route that reaches a popout, whose tabs store holds no entry a
  // `setViewerState(texActivePath)` could land in (the one-time `localVs` seed
  // above never re-reads the store, which is why the store-write route left a
  // popped-out workspace's center pinned and pdf→tex sync looking dead). Routed
  // through `goTo`, so the back stack records the step; `setActive` brings the
  // tab to the front of its group (in a popout it is forwarded as an ordinary
  // detached "activate" edit). The callback rides a ref so the registration is
  // one per mainPath, not one per render.
  const centerRef = useRef<(source: string) => void>(() => {});
  centerRef.current = (source: string) => {
    if (tabKey) useTabsStore.getState().setActive(tabKey);
    goTo(source);
  };
  useEffect(() => {
    const center = (source: string) => centerRef.current(source);
    registerTexWorkspace(mainPath, center);
    return () => unregisterTexWorkspace(mainPath, center);
  }, [mainPath]);

  // Keep-mounted center: the LRU list of mounted paths (most-recent last). The
  // active file is always mounted; the main file is pinned; a dirty pane is never
  // evicted (its unsaved draft would be lost).
  const [mounted, setMounted] = useState<string[]>(() => [mainPath]);
  const dirtyRef = useRef<Map<string, boolean>>(new Map());
  // Stable per-path dirty reporter, so TexView's onDirtyChange identity doesn't
  // churn every render.
  const dirtyHandlersRef = useRef<Map<string, (d: boolean) => void>>(new Map());
  const dirtyHandlerFor = useCallback((p: string) => {
    let h = dirtyHandlersRef.current.get(p);
    if (!h) {
      h = (d: boolean) => { dirtyRef.current.set(p, d); };
      dirtyHandlersRef.current.set(p, h);
    }
    return h;
  }, []);

  // Every mounted pane's `save`, so a Compile pressed in ANY pane first writes
  // EVERY pane's unsaved draft. Panes stay mounted (display:none) with their
  // drafts, and the build reads the files on disk: a chapter edited in one pane
  // and a Compile pressed in another built the chapter as last saved — and,
  // because nothing on disk had changed, latexmk reported "up-to-date" and the
  // old PDF came back as a success. Each `save` no-ops when its buffer is clean.
  const saveHandlersRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const saveRegistrarsRef = useRef<Map<string, (save: () => Promise<void>) => () => void>>(
    new Map(),
  );
  const saveRegistrarFor = useCallback((p: string) => {
    let r = saveRegistrarsRef.current.get(p);
    if (!r) {
      r = (save: () => Promise<void>) => {
        saveHandlersRef.current.set(p, save);
        return () => {
          if (saveHandlersRef.current.get(p) === save) saveHandlersRef.current.delete(p);
        };
      };
      saveRegistrarsRef.current.set(p, r);
    }
    return r;
  }, []);
  const saveAllPanes = useCallback(async () => {
    await Promise.all([...saveHandlersRef.current.values()].map((save) => save()));
  }, []);

  // Follow the active file into the mounted LRU, evicting the least-recently-used
  // clean, non-main, non-active pane past the cap.
  useEffect(() => {
    setMounted((prev) => {
      if (prev[prev.length - 1] === activePath) return prev;
      const next = prev.filter((x) => x !== activePath);
      next.push(activePath);
      while (next.length > TEX_WS_MAX_PANES) {
        const idx = next.findIndex(
          (x) => x !== mainPath && x !== activePath && !dirtyRef.current.get(x),
        );
        if (idx < 0) break; // everything left is dirty/pinned — keep it
        next.splice(idx, 1);
      }
      return next;
    });
  }, [activePath, mainPath]);

  // Non-null inside a detached popout: the workspace's tabs render from a Tauri
  // seed into LOCAL state and the main tab store isn't ours, so a PDF tab has to
  // stream into THIS window through the file-drop controller (the Python-Run
  // seam), not `openLinkedFile` — which would silently add the tab to the main
  // window's store where this popout never renders it (the reported bug).
  const fileDrop = useContext(FileDropContext);

  // "Show the PDF" — the single path that puts the compiled PDF on screen, used
  // by both the compile's forward-search and the explicit Open-PDF button. The
  // PDF is its OWN tab, not docked in-tab, deduped by path so a recompile
  // refocuses the same tab (its own mtime poll reloads the fresh bytes) rather
  // than stacking a duplicate — in the main window via `openLinkedFile`, in a
  // popout via `fileDrop.openTab` (`addDetachedTab` does the same path dedupe).
  // Either way it lands in the workspace's own subwindow. TexView only calls this
  // once a PDF exists, so there is nothing to probe here.
  const openPdfTab = useCallback(
    (pdf: string) => {
      const label = basename(pdf);
      const cwd = dirname(pdf) || dirname(mainPath) || "/";
      if (fileDrop) {
        fileDrop.openTab({ label, cmd: "", cwd, kind: "embed", embedPath: pdf, viewer: "pdf" });
        return;
      }
      openLinkedFile(tabKey, cwd, { path: pdf, viewer: "pdf", label });
    },
    [tabKey, mainPath, fileDrop],
  );

  // A successful compile (from any mounted editor — a child builds the root too):
  // remember the output PDF, open/refocus its tab, and re-gather the structure (a
  // build may add an \input or a figure). Never auto-compiles on restore — this
  // only ever fires from an explicit build.
  const onCompiled = useCallback(
    (info: { pdfPath: string; pdfVersion: number }) => {
      setStructureVersion((v) => v + 1);
      openPdfTab(info.pdfPath);
    },
    [openPdfTab],
  );

  // Which FILE is broken, drawn on the structure tree (#tex-structure-errors).
  // The Errors/Warnings cards answer "what is wrong" from whichever pane the
  // reader is editing; in a document split across a dozen `\input`s that leaves
  // the more useful question open, and the sidebar is the one surface already
  // drawing the document as its files. Reported by every build, failed or not,
  // and reset when the workspace changes documents (a side switch re-roots every
  // path) — stale badges pointing at a previous document's lines would be worse
  // than none.
  const [diagnostics, setDiagnostics] = useState<Map<string, TexFileDiagnostics>>(new Map());
  useEffect(() => { setDiagnostics(new Map()); }, [mainPath]);

  // How this document is compiled, shared by every `.tex` pane in the workspace.
  // Every one of them builds the SAME main file (`resolve_tex_root` redirects a
  // child fragment to its parent), so the engine is a property of the document:
  // per-pane state meant compiling from a chapter rebuilt the parent under the
  // backend's default engine while the main file's own toolbar still read
  // `xelatex`. Persisted on the workspace tab like `texActivePath` beside it — a
  // document that only builds under `lualatex` builds under it in every sitting,
  // instead of reverting to the backend's default on the next launch and failing
  // the first compile of the day for a reason the toolbar no longer shows.
  // Read like `texActivePath` above: the store when it holds this tab, the local
  // mirror in a popout where it never will.
  const compileOpts = useMemo<TexCompileOpts>(
    () => texCompileOptsFrom({ ...localVs, ...storeVs }),
    [storeVs, localVs],
  );
  const patchCompileOpts = useCallback(
    (patch: Partial<TexCompileOpts>) => patchViewerState(texCompileViewerState(patch)),
    [patchViewerState],
  );

  // In-structure link/error targets switch the center; out-of-tree ones fall back
  // to the standalone tab open (a `.bib` → bib cards, an external file).
  const onFollowChild = useCallback(
    (resolved: { path: string; viewer: InternalViewer; label: string }) => {
      if (resolved.path === mainPath || (structure && texWorkspaceContains(structure, resolved.path))) {
        goTo(resolved.path);
        return true;
      }
      return false;
    },
    [mainPath, structure, goTo],
  );
  const onJumpToSource = useCallback(
    (input: string, line: number, column: number) => {
      if (input === mainPath || (structure && texWorkspaceContains(structure, input))) {
        goTo(input);
        useEditorJumpStore.getState().requestJump(input, line, column);
      } else {
        jumpToSource(input, line, column);
      }
    },
    [mainPath, structure, goTo],
  );

  // Sidebar width and fold, persisted per tab (store-or-local, see
  // `patchViewerState`). Absent `texSidebarHidden` means shown.
  const sidebarWidth = (storeVs?.texSidebarWidth ?? localVs.texSidebarWidth) ?? TEX_WS_SIDEBAR_DEFAULT;
  const sidebarHidden = (storeVs?.texSidebarHidden ?? localVs.texSidebarHidden) ?? false;
  const onResizeSidebar = useCallback(
    (w: number) => patchViewerState({ texSidebarWidth: w }),
    [patchViewerState],
  );
  const hideSidebar = useCallback(() => patchViewerState({ texSidebarHidden: true }), [patchViewerState]);
  const showSidebar = useCallback(() => patchViewerState({ texSidebarHidden: false }), [patchViewerState]);

  // The sidebar's ＋ (#tex-structure-newfile): name a file, get it created and
  // `\input` into the document, then centered. The reference lands in the file
  // currently being edited when that is a `.tex` (a chapter grows its own
  // sections), else in the main document — and a parent with unsaved edits is
  // refused up front, because splicing it on disk would be undone by the next
  // save of the older draft (`addTexChildFile` documents the precondition).
  const { promptText, dialogs } = useDialogs();
  const onNewFile = useCallback(() => {
    const parent = viewerForPath(activePath) === "tex" ? activePath : mainPath;
    const parentName = basename(parent);
    const disabled = disabledViewers(useSettingsStore.getState().settings?.viewer_prefs);
    void promptText(
      {
        title: (
          <>
            {t("texWorkspace.newFileTitle")} <UntestedTag id="texWorkspace.newFileTitle" />
          </>
        ),
        body: t("texWorkspace.newFileBody", { name: parentName }),
        label: t("texWorkspace.newFileLabel"),
        confirmLabel: t("common.create"),
        validate: (value) => {
          if (dirtyRef.current.get(parent)) return t("texWorkspace.newFileDirty", { name: parentName });
          return texRefCreation(parent, { command: "input", token: value }, disabled)
            ? null
            : t("texWorkspace.newFileInvalid");
        },
      },
      async (value) => {
        const added = await addTexChildFile(parent, value, projectId, disabled);
        if (!added) return; // validate already refused this shape
        setStructureVersion((v) => v + 1);
        goTo(added.path);
      },
    );
  }, [activePath, mainPath, projectId, promptText, goTo, t]);

  const centerFor = (p: string) => {
    const v = viewerForPath(p);
    const paneKey = p === mainPath ? tabKey : tabKey ? `${tabKey}#${p}` : undefined;
    if (v === "tex") {
      return (
        <TexView
          path={p}
          tabKey={paneKey}
          onOpenExternally={onOpenExternally}
          onOpenPdf={openPdfTab}
          onFollowChild={onFollowChild}
          onJumpToSource={onJumpToSource}
          onDirtyChange={dirtyHandlerFor(p)}
          onRegisterSave={saveRegistrarFor(p)}
          onSaveAll={saveAllPanes}
          onCompiled={onCompiled}
          onDiagnostics={setDiagnostics}
          compileOpts={compileOpts}
          onCompileOptsChange={patchCompileOpts}
        />
      );
    }
    if (v === "image") {
      return <ImageView path={p} fileName={basename(p)} tabKey={paneKey} onOpenExternally={onOpenExternally} />;
    }
    if (v === "pdf") {
      return <PdfView path={p} tabKey={paneKey} onOpenExternally={onOpenExternally} groupId={groupId} />;
    }
    // A `.tikz`/`.sty`/other graphic-adjacent source: the plain code editor.
    return <TextView path={p} tabKey={paneKey} onOpenExternally={onOpenExternally} groupId={groupId} />;
  };

  return (
    <div className="tex-workspace" onKeyDown={onWorkspaceKeyDown}>
      {sidebarHidden ? (
        <TexStructureRail
          onShow={showSidebar}
          onBack={backTarget ? goBack : undefined}
          backLabel={backLabel}
          backChord={backChord}
          onUp={upTarget ? goUp : undefined}
          upLabel={upLabel}
          upLine={upTarget?.line}
          upChord={upChord}
        />
      ) : structure ? (
        <TexStructureSidebar
          structure={structure}
          activePath={activePath}
          width={sidebarWidth}
          onSelect={(p, _v, line) => {
            goTo(p);
            // A badge click carries the line; a plain row click does not, and
            // leaves the caret where that file was last left.
            if (line) useEditorJumpStore.getState().requestJump(p, line, 1);
          }}
          diagnostics={diagnostics}
          onResize={onResizeSidebar}
          onHide={hideSidebar}
          onNewFile={onNewFile}
          onBack={backTarget ? goBack : undefined}
          backLabel={backLabel}
          backChord={backChord}
          onUp={upTarget ? goUp : undefined}
          upLabel={upLabel}
          upLine={upTarget?.line}
          upChord={upChord}
        />
      ) : (
        <div className="tex-structure-sidebar" style={{ width: sidebarWidth }}>
          <div className="tex-structure-header">
            <span className="tex-structure-title">{t("texWorkspace.structureTitle")}</span>
            <UntestedTag id="fileViewerPane.4" />
            <button
              type="button"
              className="tex-structure-chrome-btn tex-structure-fold"
              title={t("texWorkspace.hideStructure")}
              aria-label={t("texWorkspace.hideStructure")}
              onClick={hideSidebar}
            >
              ‹
            </button>
          </div>
        </div>
      )}
      <div className="tex-workspace-center">
        {mounted.map((p) => (
          <div
            key={p}
            className="tex-workspace-pane"
            style={{ display: p === activePath ? undefined : "none" }}
          >
            {/* PdfView is lazy (§5.1) and this center renders outside the
                pane-level Suspense above. */}
            <PaneVisibleContext.Provider value={workspaceVisible && p === activePath}>
              <Suspense fallback={null}>{centerFor(p)}</Suspense>
            </PaneVisibleContext.Provider>
          </div>
        ))}
      </div>
      {dialogs}
    </div>
  );
}

/**
 * "That file isn't there yet — make it?" — the answer to a Ctrl/⌘+click on an
 * `\input{…}` naming a file that does not exist (#tex-create-ref).
 *
 * A banner rather than a modal, deliberately: this is an offer, not a question
 * that has to be answered before anything else can happen. The click was aimed at
 * the editor, the caret is still where the user left it, and declining has to
 * cost nothing — a modal would take the keyboard away from a document somebody is
 * in the middle of typing. It wears the pane's own notice chrome
 * (`tex-install-banner`), which is what this viewer already uses to say
 * "something is missing, here is the button that fixes it".
 */
function TexCreateRefBanner({
  creation,
  newFolder,
  busy,
  error,
  onCreate,
  onDismiss,
}: {
  creation: TexRefCreation;
  /** The file's folder is missing too and would be created along with it. */
  newFolder: boolean;
  busy: boolean;
  error: string | null;
  onCreate: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className="tex-install-banner" role="alert">
      <span className="tex-install-banner-text">
        {newFolder && creation.folder
          ? t("fileViewer.texMissingRefFolderMsg", {
              name: creation.rel,
              folder: creation.folder.rel,
            })
          : t("fileViewer.texMissingRefMsg", { name: creation.rel })}
        {error ? ` ${error}` : ""}
      </span>
      <UntestedTag id="fileViewerPane.5" />
      <button
        type="button"
        className="ollama-action-btn primary"
        onClick={onCreate}
        disabled={busy}
      >
        {busy ? t("fileViewer.texCreatingRef") : t("fileViewer.texCreateRefBtn")}
      </button>
      <button type="button" className="ollama-action-btn" onClick={onDismiss} disabled={busy}>
        {t("common.cancel")}
      </button>
    </div>
  );
}

/** One diagnostic as `file:line: message` — the shape TeX itself prints under
 *  `-file-line-error`, so a copied row pastes back into a search, a bug report
 *  or an agent prompt as the same text the log holds. A warning the log could
 *  not place carries the message alone rather than an invented location. */
function texDiagnosticText(
  message: string,
  file: string | undefined,
  line: number | undefined,
): string {
  return file && line ? `${file}:${line}: ${message}` : message;
}

/**
 * The one-click way to get a compile diagnostic out of the card and into an
 * agent tab, a mail, or a search box (#tex).
 *
 * Every row of the error and warning lists is already a *jump* button, and the
 * app sets `user-select: none` globally (`styles/base.css`) — so the text of a
 * TeX error was, of all the text in this viewer, the least reachable: clicking
 * it moved the caret instead of selecting it. This sits beside the jump (never
 * inside it — a button in a button is not a button) and carries the same ⧉ → ✓
 * as the connection log, because it is the same promise: the *whole* thing on
 * the clipboard, not the part that happens to be on screen.
 */
function TexCopyButton({
  text,
  label,
  className = "file-viewer-tex-copy",
}: {
  text: string;
  /** What this button copies, for the tooltip and the screen reader. */
  label: string;
  className?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // The ✓ resets on a timer owned by the effect, so copying again during an
  // in-flight window restarts it instead of leaving a stale tick behind.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);
  const title = copied ? t("fileViewer.copied") : label;
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={title}
      onClick={(e) => {
        // The row around this button jumps to the source location; copying is
        // not a request to move the caret there too.
        e.stopPropagation();
        if (!text) return;
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

function TexView({
  path,
  onOpenExternally,
  tabKey,
  onOpenPdf,
  onFollowChild,
  onJumpToSource,
  onDirtyChange,
  onRegisterSave,
  onSaveAll,
  onCompiled,
  onDiagnostics,
  compileOpts,
  onCompileOptsChange,
}: {
  path: string;
  onOpenExternally: () => void;
  /** This viewer tab's key, for #50 same-subwindow link routing. */
  tabKey?: string;
  // --- TeX workspace host seams (all optional; absent ⇒ today's standalone
  //     behavior, so a plain `viewer:"tex"` tab and its tests are unaffected) ---
  /** Show the compiled PDF. When present, `openPdf` calls this INSTEAD of the
   *  standalone tab's own open — the workspace routes the PDF tab into its own
   *  subwindow (via the workspace's real `tabKey`). Absent ⇒ the standalone tab's
   *  default (open/refocus a separate PDF tab keyed on this editor's tab). */
  onOpenPdf?: (pdf: string) => void;
  /** Follow an `\input`/`\includegraphics` target. Return true when the host
   *  handled it (an in-structure child/graphic switched the workspace center);
   *  false falls back to opening the target in its own tab (external/out-of-tree
   *  targets, a `.bib` → bib cards, …). */
  onFollowChild?: (resolved: { path: string; viewer: InternalViewer; label: string }) => boolean;
  /** Jump to a source location (a compile-error row). When present the host may
   *  switch the workspace center to an in-structure file; else the module default
   *  opens a tab. */
  onJumpToSource?: (input: string, line: number, column: number) => void;
  /** Report this editor's dirty state up, so the workspace's keep-mounted center
   *  cache never evicts a pane with unsaved edits. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Hand this pane's `save` to the workspace (returns the unregister), so a
   *  Compile pressed in any pane can flush this one's draft too. */
  onRegisterSave?: (save: () => Promise<void>) => () => void;
  /** Write every mounted pane's unsaved draft. Called before a build, after this
   *  pane's own save — the build reads files, not editor buffers. */
  onSaveAll?: () => Promise<void>;
  /** A successful compile finished: the actual output PDF and the bumped version.
   *  Opens/refocuses the PDF tab and drives a structure re-gather. */
  onCompiled?: (info: { pdfPath: string; pdfVersion: number }) => void;
  /** Every build's errors and warnings, bucketed by the absolute path of the
   *  file each is in, for the structure sidebar's per-file badges
   *  (#tex-structure-errors). Fired whether the build succeeded or failed —
   *  a green build still reports warnings, and only a failed one has errors —
   *  and with an empty map for a clean build, which is what clears the badges. */
  onDiagnostics?: (byFile: Map<string, TexFileDiagnostics>) => void;
  /** The compile configuration, OWNED BY THE HOST. Every `.tex` in a workspace
   *  builds the same main document (`resolve_tex_root`), so which engine — and
   *  which out-dir and extra flags — that build runs with is a property of the
   *  DOCUMENT, not of whichever file happens to be centered: per-pane state meant
   *  a child fragment silently rebuilt the parent under the backend's default
   *  engine while the main file's own tab still showed `lualatex`. Absent ⇒ the
   *  standalone tab keeps its own local copy (there is no document to share). */
  compileOpts?: TexCompileOpts;
  /** Patch the shared configuration. Present exactly when `compileOpts` is. */
  onCompileOptsChange?: (patch: Partial<TexCompileOpts>) => void;
}) {
  const t = useT();
  const texInstallLabel = IS_WINDOWS ? t("fileViewer.texInstallMiktex") : t("fileViewer.texInstallLatex");
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const scope = useFileScope();
  const ai = useTabAiPrefs(tabKey, "tex");
  const ac = ai.ac;
  const sc = ai.sc;
  const [compareOpen, setCompareOpen] = useState(false);
  const font = useEditorFontSize(tabKey, "tex");
  const viewPos = useViewerState(tabKey);
  const persistScroll = useCallback(
    (scrollTop: number) => viewPos.persist({ scrollTop }),
    [viewPos],
  );

  // Print the .tex source as a wrapped monospace block. (The compiled PDF, once
  // built, opens in the PDF viewer and prints from there.)
  const handlePrint = useCallback(() => {
    void printHtmlBody(
      `<pre class="print-pre">${escapeHtml(draft)}</pre>`,
      TEXT_PRINT_CSS,
      basename(path),
    );
  }, [draft, path]);

  // null while still probing; the editor renders regardless so there is no flash.
  const [cap, setCap] = useState<TexCapability | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTexCapability().then((c) => { if (!cancelled) setCap(c); });
    return () => { cancelled = true; };
  }, []);

  // A `\input{…}`-style reference whose file isn't there yet, waiting on the
  // user's answer (#tex-create-ref). `newFolder` records that the file's folder
  // is missing as well, so the offer can say the folder is made too rather than
  // creating a directory nobody was told about.
  const [createRef, setCreateRef] =
    useState<{ creation: TexRefCreation; newFolder: boolean } | null>(null);
  const [creatingRef, setCreatingRef] = useState(false);
  const [createRefError, setCreateRefError] = useState<string | null>(null);
  // The offer belongs to the file it was made in — a workspace re-uses this pane
  // for whichever `.tex` it centres next.
  useEffect(() => {
    setCreateRef(null);
    setCreateRefError(null);
  }, [path]);

  // Put a resolved reference on screen: in a workspace an in-structure
  // child/graphic switches the center view instead of opening a tab; the host
  // returns false for an out-of-tree target (a `.bib` → bib cards, an external
  // file), which falls through to the standalone tab open so nothing dead-ends.
  // Shared by following an existing reference and by opening one just created.
  const openTexRef = useCallback(
    (resolved: { path: string; viewer: InternalViewer; label: string }) => {
      if (onFollowChild?.(resolved)) return;
      openLinkedFile(tabKey, dirname(path) || "/", resolved);
    },
    [onFollowChild, tabKey, path],
  );

  // Ctrl/Cmd+Click a `\input{…}` (or \include/\subfile/\bibliography/
  // \includegraphics/…) to open the referenced file in its own tab, resolved
  // relative to this file. By default it opens in the SAME subwindow as this tab
  // (#50). A bare \includegraphics is resolved by probing the directory.
  const followLink = useCallback(
    async (caret: number): Promise<boolean> => {
      const disabled = disabledViewers(
        useSettingsStore.getState().settings?.viewer_prefs,
      );
      const target = findTexRefAt(draft, caret);
      if (target) {
        // A reference naming a file that isn't there yet is an ordinary state of
        // a document being written, so offer to CREATE it (#tex-create-ref)
        // rather than opening a tab whose only content is a read error. Only for
        // a reference an empty file is a valid first version of — see
        // `texRefCreation`; everything else keeps the plain open below.
        const creation = texRefCreation(path, target, disabled);
        if (creation && !(await texPathExists(creation.path, scope))) {
          setCreateRefError(null);
          setCreateRef({
            creation,
            newFolder:
              !!creation.folder && !(await texPathExists(dirname(creation.path), scope)),
          });
          return true;
        }
        const resolved = await resolveTexRefAsync(path, target, disabled);
        if (!resolved) return false;
        openTexRef(resolved);
        return true;
      }
      // A `\ref`/`\cite` (#tex-ref-jump): the target is a POSITION — the
      // `\label{…}` or the `.bib` record defining the key — so following it is an
      // editor jump, and only opens a file when the definition is in another one.
      // A key nothing defines is left alone: a `\ref` written before its label is
      // an ordinary state of a document, not an error to report at a click.
      const keyRef = findTexKeyRefAt(draft, caret);
      if (!keyRef) return false;
      const loc = await resolveTexKeyRef(path, keyRef, {
        projectId: scope,
        currentText: draft,
        disabled,
      });
      if (!loc) return false;
      if (loc.path !== path) {
        // Bring the defining file up first — in the workspace by switching the
        // center, else in its own tab — then jump. `requestJump` is keyed by path
        // and consumed by whichever editor mounts for it, so the order is safe
        // either way: a tab that opens a frame later still applies the request.
        if (!onFollowChild?.(loc)) {
          openLinkedFile(tabKey, dirname(path) || "/", loc);
        }
      }
      useEditorJumpStore.getState().requestJump(loc.path, loc.line, loc.column);
      return true;
    },
    [draft, path, tabKey, scope, onFollowChild, openTexRef],
  );

  // The offer's yes: make the file (and its folder, when the reference named one
  // that doesn't exist yet) and open it. `createTexRefFile` re-checks first and
  // simply reports "it was already there" — either way the click ends with the
  // file on screen, which is what it asked for.
  const createMissingRef = useCallback(async () => {
    if (!createRef || creatingRef) return;
    const { creation } = createRef;
    setCreatingRef(true);
    setCreateRefError(null);
    try {
      await createTexRefFile(creation, scope);
      setCreateRef(null);
      openTexRef({ path: creation.path, viewer: creation.viewer, label: creation.label });
    } catch (e) {
      setCreateRefError(String(e));
    } finally {
      setCreatingRef(false);
    }
  }, [createRef, creatingRef, scope, openTexRef]);

  // #49 + #tex-ref-jump: decorate every `\input{…}`/`\includegraphics{…}` path and
  // every `\ref{…}`/`\cite{…}` key so both read as the clickable links they are.
  const linkRanges = useCallback(
    (source: string) => [
      ...texRefRanges(source),
      ...texRefHitRanges(source),
      ...texKeyRefRanges(source),
    ],
    [],
  );

  // The compile configuration: the chosen engine (only offered when >1 is
  // available; "" means "let the backend pick") plus the #54 options. Held by the
  // workspace host when there is one — see `compileOpts` — so every file in one
  // structure builds its shared main document the same way; a standalone tab owns
  // the same shape locally, seeded from and written back to its own persisted
  // `ViewerState` so the engine a document needs is still selected after a
  // restart (the workspace persists the shared copy the same way).
  const [localOpts, setLocalOpts] = useState<TexCompileOpts>(() => texCompileOptsFrom(viewPos.initial));
  const { engine, outDir, extraFlags } = compileOpts ?? localOpts;
  const patchOpts = useCallback(
    (patch: Partial<TexCompileOpts>) => {
      if (onCompileOptsChange) onCompileOptsChange(patch);
      else {
        setLocalOpts((prev) => ({ ...prev, ...patch }));
        viewPos.persist(texCompileViewerState(patch));
      }
    },
    [onCompileOptsChange, viewPos],
  );
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  // True when the last compile ran with shell-escape (`\write18`) active despite
  // our args never enabling it — a system texmf.cnf / latexmkrc turned it on.
  const [shellEscape, setShellEscape] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState("");
  // Source locations parsed out of the last failed build's log (TeX runs with
  // `-file-line-error`), backing the jump-to-error buttons below.
  const [errors, setErrors] = useState<TexError[]>([]);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  // 0 = never compiled (preview shows a placeholder); each successful compile
  // bumps this to force the PDF blob to refetch the freshly written bytes.
  const [pdfVersion, setPdfVersion] = useState(0);
  // Mirror of `pdfVersion` for the compile closure (which doesn't depend on the
  // state), so it can report the next version to the workspace host in one write.
  const pdfVersionRef = useRef(0);
  // Why the last forward-search (caret → PDF) did not jump, if it didn't — shown
  // as a transient notice so it reads as a SyncTeX outcome, never as a build
  // failure (the PDF is always shown/refreshed regardless). `"miss"` = SyncTeX
  // ran but found no box for that line (the PDF kept its position); `"unavail"` =
  // SyncTeX could not run at all (tool absent, or a backend not yet rebuilt), the
  // case that used to masquerade as a miss; `"noPdf"` = a Ctrl/⌘+click forward
  // search before the document was ever compiled, so there is no PDF to jump
  // into yet. Auto-cleared by the effect below.
  const [syncNote, setSyncNote] = useState<null | "miss" | "unavail" | "noPdf">(null);
  // The last build finished without running an engine (latexmk found every
  // source unchanged) — a success that produced nothing new. Cleared by the
  // next build; shown until then so it explains the PDF the reader is looking at.
  const [compileNote, setCompileNote] = useState<null | "unchanged">(null);
  // latexmk exited non-zero over something that is not an error in the document
  // (warnings treated as errors in a latexmkrc, a bibliography rule, an
  // unresolved reference) and the PDF was written anyway: its complaint belongs
  // beside the build, not in place of it. Also carries the reason for a build
  // that really did fail, where latexmk explains itself better than the log tail.
  const [driverNote, setDriverNote] = useState<string | null>(null);

  // #245 warnings: what the build reported that did NOT stop it. This is where
  // nearly everything worth fixing lives — an undefined `\ref` prints `??` in the
  // PDF and compiles happily — so the list is raised on a SUCCESSFUL build too,
  // which is the case the error card can never cover. Collapsed by default: a
  // warning is not a failure, and a package's forty font substitutions must not
  // push the document off screen.
  const [warnings, setWarnings] = useState<TexWarning[]>([]);
  const [showWarnings, setShowWarnings] = useState(false);
  // #245 word count: on demand, never on a timer — it walks every `.tex` the
  // document reaches, and nobody wants that on each keystroke.
  const [wordCount, setWordCount] = useState<(TexWordCount & { files: number }) | null>(null);
  const [counting, setCounting] = useState(false);

  // \ref/\cite key completion: `\label` keys across the document and entry keys
  // from the connected `.bib` file(s), gathered from disk on load. Re-gathered
  // after each compile (a build may add labels / change bib resources). The
  // current file's own labels/macros/environments are merged in from the live
  // draft by the editor itself (`texCompletionsFor`), lazily — only once a
  // dropdown is actually open, and only for the family it shows. Merging them
  // here, on every keystroke, was three whole-document parses per character
  // typed in any TeX file, dropdown or not.
  const [gathered, setGathered] = useState<TexCompletions>({
    labels: [],
    cites: [],
    commands: TEX_STANDARD_COMMANDS,
    envs: TEX_STANDARD_ENVIRONMENTS,
  });
  useEffect(() => {
    let cancelled = false;
    gatherTexCompletions(path, scope)
      .then((c) => { if (!cancelled) setGathered(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope, pdfVersion]);

  // #54 compiler options: an optional output folder (relative to the source or
  // absolute) and extra engine flags (space-separated), both above with the
  // engine. The backend filters the flags so none can ever enable shell-escape.
  // Only the disclosure is per pane — it is chrome, not configuration.
  const [showOptions, setShowOptions] = useState(false);

  // SyncTeX reverse-search target (PDF → here) and the live caret (for forward
  // search on compile). draftRef keeps the latest text for the compile closure.
  const jump = useEditorJump(path);
  const caretRef = useRef(0);
  const onCaret = useCallback((offset: number) => { caretRef.current = offset; }, []);
  // Live caret getter published by the mounted CodeEditor (see `caretApiRef`).
  // Preferred over `caretRef` at compile time because it reads the real cursor,
  // not a snapshot that can be a stale 0 when the editor was never focused.
  const caretApiRef = useRef<(() => number | null) | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The file actually built on Compile: a child `.tex` redirects to its main
  // document (resolve_tex_root). Resolved on load and refreshed after each
  // compile, since compiling the parent may have just recorded the mapping.
  const [root, setRoot] = useState(path);
  useEffect(() => {
    let cancelled = false;
    resolveTexRoot(path).then((r) => { if (!cancelled) setRoot(r); });
    return () => { cancelled = true; };
  }, [path]);
  const isChild = root !== path;
  const rootName = basename(root);
  // Directory the build runs in — error paths in the log are relative to it.
  const rootDir = dirname(root) || "/";

  // The engine "Auto" builds with: the backend reads it off the document (a
  // `% !TEX program` comment, fontspec / luacode / xeCJK, …). Re-read whenever a
  // compile ends, since the save before it is what puts a new `\usepackage` on disk.
  const [autoEngine, setAutoEngine] = useState<string | null>(null);
  const showEngineMenu = (cap?.engines?.length ?? 0) > 1;
  useEffect(() => {
    if (!showEngineMenu || compiling) return;
    let cancelled = false;
    invoke<string | null>("tex_auto_engine", { path: root }).then(
      (e) => { if (!cancelled) setAutoEngine(e ?? null); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [showEngineMenu, root, compiling]);

  // The output-folder picker browses the project this document belongs to,
  // opening at the main file's folder. A relative out-dir resolves against that
  // folder in `compile_tex`, so the pick is stored relative to it (`..` included)
  // and survives the project moving. Outside any project — or a main file that
  // is not under the project's local tree — the bound is the main file's folder.
  const [outDirPickerOpen, setOutDirPickerOpen] = useState(false);
  const outDirBound = useMemo(() => {
    const project = scope ? useProjectsStore.getState().projects.find((p) => p.id === scope) : undefined;
    const projectDir = localMirrorRootFor(project) ?? (project ? resolveProjectDirectory(project) : null);
    return projectDir && isPathWithin(rootDir, projectDir) ? projectDir : rootDir;
  }, [scope, rootDir]);
  const pickOutDir = useCallback(
    async (dir: string) => {
      setOutDirPickerOpen(false);
      // The picker hands back `list_dirs`' canonical spelling; measure from the
      // main folder's canonical spelling too, or a symlinked project path would
      // climb out to `/` and back down.
      const base = await invoke<{ path: string }>("list_dirs", { path: rootDir })
        .then((l) => l.path)
        .catch(() => rootDir);
      const rel = relativePathFrom(base, dir);
      patchOpts({ outDir: rel === null ? dir : rel === "." ? "" : rel });
    },
    [rootDir, patchOpts],
  );

  // ── #tex-hover-preview ────────────────────────────────────────────────────
  // Hovering a formula typesets it. The compile itself is `lib/viewers/tex/texPreview`;
  // what lives here is the two things only this viewer knows — WHICH preamble the
  // fragment is typeset with, and WHERE the engine has to run for that preamble's
  // own `\usepackage{mystyle}` / `\input{macros}` to resolve.
  //
  // The preamble comes from the draft when this file has one, and otherwise from
  // the build root's text: an `\input`ed chapter is a real `.tex` with no preamble
  // at all, and previewing its formulas without the macros they use would report
  // "Undefined control sequence" for every one of them. Read once per root (and
  // again after a compile, which may have just recorded a different root), never
  // per hover.
  const [rootPreamble, setRootPreamble] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (root === path) {
      setRootPreamble(null);
      return () => { cancelled = true; };
    }
    readFileText(root, scope)
      .then((text) => { if (!cancelled) setRootPreamble(texPreamble(text) ?? ""); })
      .catch(() => { if (!cancelled) setRootPreamble(null); });
    return () => { cancelled = true; };
  }, [root, path, scope]);

  const hoverPref = useTexHoverPreview(scope);
  // #tex-beamer: the document decides the default (a deck opens with the bar),
  // the project remembers a click. The gather answers for the whole document; the
  // draft answers for a class line typed into THIS file before any compile.
  const beamerDetected = useMemo(
    () => gathered.beamer === true || isBeamerDocument(draft),
    [gathered.beamer, draft],
  );
  const beamer = useTexBeamerMode(scope, beamerDetected);
  const texEditorApi = useRef<EditorApi | null>(null);
  const beamerSelection = useRef<RememberedSelection | null>(null);
  const onSelectionChange = useCallback((start: number, end: number) => {
    beamerSelection.current =
      start === end ? null : { start, end, text: draftRef.current.slice(start, end) };
  }, []);
  const hoverPreview = useMemo<HoverPreviewConfig | undefined>(() => {
    if (!hoverPref.on || !cap?.available) return undefined;
    // Read the draft through the ref, not the closure: the config is memoized on
    // the *document's* identity (its root, its preamble, its engine), so it must
    // not be rebuilt on every keystroke — every rebuild would re-run the range
    // scan for the whole file and re-anchor an open card.
    const preambleOf = () => texPreamble(draftRef.current) ?? rootPreamble ?? "";
    return {
      ranges: texSnippetRanges,
      cached: (body) => cachedTexPreview(preambleOf(), body),
      render: (body, stillWanted) =>
        renderTexPreview(rootDir, preambleOf(), body, engine || null, stillWanted),
    };
  }, [hoverPref.on, cap?.available, rootPreamble, rootDir, engine]);

  // Open the compiled PDF as its own tab (it is a real file), reusing the embed
  // viewer. openLinkedFile dedupes against an already-open PDF tab for the same
  // path and routes to the same subwindow as this tab; the PDF pane polls mtime,
  // so a reused tab reloads the freshly compiled bytes on its own.
  const openPdf = useCallback(
    (pdf: string) => {
      // In a workspace the host opens the PDF tab in the workspace's own
      // subwindow; standalone opens/refocuses a separate PDF tab keyed on this tab.
      if (onOpenPdf) {
        onOpenPdf(pdf);
        return;
      }
      const name = basename(pdf);
      const dir = dirname(path) || "/";
      openLinkedFile(tabKey, dir, { path: pdf, viewer: "pdf", label: name });
    },
    [path, tabKey, onOpenPdf],
  );

  // The PDF this source builds to: the last compile's actual output when known
  // (it honours the #54 out-dir), else the conventional sibling of the built
  // root. Used by on-demand forward search without recompiling.
  const targetPdf = useCallback(
    () => pdfPath ?? root.replace(/\.tex$/i, ".pdf"),
    [pdfPath, root],
  );

  // SyncTeX forward search on demand: map a caret offset in this source to its
  // box in the PDF and reveal/flash it there — without recompiling. Opens (or
  // refocuses) the PDF tab only on a hit, so a miss never spawns a broken tab.
  const forwardSync = useCallback(
    async (caret: number) => {
      const pdf = targetPdf();
      setSyncNote(null);
      // Not compiled yet: say so, rather than letting SyncTeX fail on the
      // missing PDF and read as "SyncTeX didn't run".
      if (!(await texPathExists(pdf, scope))) {
        setSyncNote("noPdf");
        return;
      }
      const { line, column } = offsetToLineCol(draftRef.current, caret);
      const phrase = phraseAt(draftRef.current, caret) ?? undefined;
      // Try every spelling SyncTeX might have stored the source under. `null` here
      // means SyncTeX could not run at all — a different notice from a real miss.
      const recs = await synctexViewBest(pdf, path, rootDir, line, column);
      // Pick the record (box / wrapped row) the clicked column lands in.
      const rect = pickSyncRect(recs ?? [], sourceColumnFraction(draftRef.current, line, column));
      if (rect) {
        openPdf(pdf);
        // Pass the clicked word + neighbours so the PDF narrows the line box to
        // that exact word, using the phrase to pick the right occurrence.
        usePdfSyncStore.getState().requestReveal(pdf, rect, phrase);
      } else {
        setSyncNote(recs === null ? "unavail" : "miss");
      }
    },
    [targetPdf, path, openPdf, rootDir, scope],
  );

  // Ctrl/⌘+click in the editor: follow a `\input{…}`-style reference when the
  // caret sits on one, otherwise forward-sync that caret position into the PDF.
  const onEditorFollow = useCallback(
    async (caret: number) => {
      if (await followLink(caret)) return;
      await forwardSync(caret);
    },
    [followLink, forwardSync],
  );

  const compile = useCallback(async () => {
    if (compiling) return;
    setCompiling(true);
    setCompileError(null);
    setErrors([]);
    setWarnings([]);
    setSyncNote(null);
    setCompileNote(null);
    setDriverNote(null);
    // Snapshot the caret synchronously, before any await can let focus change or
    // a blur reset it: prefer the editor's live cursor, falling back to the last
    // reported offset. This is the position forward search reveals in the PDF.
    const caretAtCompile = caretApiRef.current?.() ?? caretRef.current;
    try {
      // The source is editable, so persist any pending edits before building —
      // this pane's AND every other mounted pane's (a workspace builds one
      // document from the files on disk; a draft left in another pane would be
      // built as last saved, and a latexmk no-op would then hand back the old PDF).
      await save();
      await onSaveAll?.();
      // A child file builds its main document instead of the fragment.
      const target = await resolveTexRoot(path);
      setRoot(target);
      // #54: pass the compiler options. The backend filters extra_flags so none
      // can ever enable shell-escape (compile_args_never_enable_shell_escape).
      const flags = extraFlags.trim().split(/\s+/).filter(Boolean);
      // A compile the reader asked for always builds: latexmk's `-g` overrides
      // its "every source unchanged, nothing to do" no-op, which otherwise hands
      // back the old PDF (say after an \input'd file changed outside Tabtivity or a
      // package was updated). The direct-engine path always runs the engine.
      if (cap?.latexmk && !flags.some((f) => /^-g+$/.test(f))) flags.unshift("-g");
      const res = await invokeTrusted<TexCompileResult>("compile_tex", {
        path: target,
        engine: engine || null,
        outDir: outDir.trim() || null,
        extraFlags: flags.length > 0 ? flags : null,
      });
      setLog(res.log);
      // The warnings are read whether or not the build succeeded: a document that
      // failed usually has both, and one that succeeded still has these.
      const parsedWarnings = parseTexWarnings(res.log);
      const parsedErrors = res.success ? [] : parseTexErrors(res.log);
      setWarnings(parsedWarnings);
      setErrors(parsedErrors);
      // The structure sidebar's per-file badges (#tex-structure-errors). Reported
      // from `target`, the file actually built, rather than this pane's `root`
      // state — which `setRoot` above has not applied yet in this closure.
      onDiagnostics?.(
        texDiagnosticsByFile(dirname(target) || "/", target, parsedErrors, parsedWarnings),
      );
      // Surface a shell-escape warning regardless of build success — an external
      // command may have run even if the document then failed to compile.
      setShellEscape(res.shell_escape);
      // latexmk's own account of the failure beats the log's last line, which is
      // its "use the -f option" advisory — an instruction, not a reason.
      setDriverNote(res.driver_note ?? null);
      if (!res.success) {
        const detail = parsedErrors[0]?.message || res.driver_note || lastLogLine(res.log);
        setCompileError(detail || t("fileViewer.compilationFailed"));
        return;
      }
      setCompileError(null);
      // latexmk ran no engine because nothing on disk changed: still a success
      // (the PDF matches the sources), but say so — a reader who expected new
      // content is otherwise left staring at the old PDF with a green build.
      setCompileNote(compileWasNoop(res.log) ? "unchanged" : null);
      if (res.pdf_path) {
        setPdfPath(res.pdf_path);
        const nextVersion = pdfVersionRef.current + 1;
        pdfVersionRef.current = nextVersion;
        setPdfVersion(nextVersion);
        // Tell the workspace host a build landed (opens/refocuses the PDF tab and
        // re-gathers the structure); no-op for a standalone tab.
        // The PDF is shown/refreshed FIRST, before any forward search — so a
        // SyncTeX miss (or SyncTeX being unavailable) can never keep the compiled
        // PDF off screen. Jump-to-cursor is a best-effort extra on top.
        onCompiled?.({ pdfPath: res.pdf_path, pdfVersion: nextVersion });
        openPdf(res.pdf_path); // open (or refocus) the PDF in its own tab
        // Forward search: reveal & highlight the caret's output position in the
        // PDF. `input` is this edited file even when a parent was built, since
        // the caret lives here. Best-effort — no-op when SyncTeX has no answer.
        const { line, column } = offsetToLineCol(draftRef.current, caretAtCompile);
        const recs = await synctexViewBest(res.pdf_path, path, rootDir, line, column);
        const rect = pickSyncRect(recs ?? [], sourceColumnFraction(draftRef.current, line, column));
        if (rect)
          usePdfSyncStore
            .getState()
            .requestReveal(
              res.pdf_path,
              rect,
              phraseAt(draftRef.current, caretAtCompile) ?? undefined,
              true,
            );
        // No jump: the PDF is already shown and stays where it was. Distinguish a
        // real miss (SyncTeX ran, no box for that line) from SyncTeX being
        // unavailable (`null`) so the notice names the actual cause, not a failure.
        // The reveal above carried the re-read; without one, ask for it outright
        // so Compile always puts the file as it is on disk on screen.
        else {
          setSyncNote(recs === null ? "unavail" : "miss");
          usePdfSyncStore.getState().requestReload(res.pdf_path);
        }
      }
    } catch (e) {
      setCompileError(String(e));
    } finally {
      setCompiling(false);
    }
  }, [
    compiling,
    save,
    onSaveAll,
    path,
    engine,
    outDir,
    extraFlags,
    cap?.latexmk,
    openPdf,
    rootDir,
    t,
    onCompiled,
    onDiagnostics,
  ]);

  // Advertise this editor's compile to the PDF tab's "recompile" notice (a
  // reverse-search click with no map, a stale map, or a PDF rebuilt without
  // SyncTeX). The PDF viewer owns no compile of its own — this one holds the
  // draft, the engine and the out-dir — so it asks here. Rides a ref so the
  // registration is one per path, not one per render.
  const compileRef = useRef(compile);
  compileRef.current = compile;
  useEffect(() => {
    const run = () => void compileRef.current();
    registerTexCompile(path, run);
    return () => unregisterTexCompile(path, run);
  }, [path]);

  // Ctrl+Shift+B (rebindable) builds the document. Bound on this pane's root
  // rather than in `useKeyboard` for the same reason as the workspace's
  // up/back chords: it is pressed with the caret in the editor's textarea,
  // which the global hook skips as an editable target. Consumed here so the
  // key never reaches the workspace above or the window beneath.
  const shortcutOverrides = useShortcutOverrides();
  const chordHint = useChordHint();
  const onTexKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!chordMatches(resolveChord("texCompile", shortcutOverrides), e.nativeEvent)) return;
      e.preventDefault();
      e.stopPropagation();
      void compileRef.current();
    },
    [shortcutOverrides],
  );

  // #245: count the whole document on demand. Reading the draft rather than the
  // file is the point — the count is asked for while writing, and one that lags
  // the last save by a paragraph is the wrong number.
  const runWordCount = useCallback(async () => {
    if (counting) return;
    setCounting(true);
    try {
      setWordCount(await gatherTexWordCount(path, scope, { currentText: draftRef.current }));
    } catch {
      setWordCount(null);
    } finally {
      setCounting(false);
    }
  }, [counting, path, scope]);

  // Auto-dismiss the forward-search notice a few seconds after it appears.
  useEffect(() => {
    if (!syncNote) return;
    const id = setTimeout(() => setSyncNote(null), 6000);
    return () => clearTimeout(id);
  }, [syncNote]);

  // Report dirty state up so the workspace's keep-mounted center cache never
  // evicts a pane with unsaved edits (no-op for a standalone tab).
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Lend this pane's `save` to the workspace for its save-all-before-compile.
  useEffect(() => onRegisterSave?.(save), [save, onRegisterSave]);

  // The error-list jump: a workspace switches the center to an in-structure file;
  // standalone falls back to the module default (open/focus a tab).
  const jumpToError = onJumpToSource ?? jumpToSource;

  // No engine (or still probing): degrade to exactly the plain-text editor.
  if (!cap || !cap.available) {
    return (
      <div className="file-viewer">
        <ViewerHeader onOpenExternally={onOpenExternally}>
          <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
          <EditorAiControls ai={ai} path={path} />
          <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
          <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
          <PrintButton onPrint={handlePrint} disabled={!loaded} />
        </ViewerHeader>
        {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
        {saveError && <ErrorNote className="file-viewer-error" error={saveError} />}
        {createRef && (
          <TexCreateRefBanner
            creation={createRef.creation}
            newFolder={createRef.newFolder}
            busy={creatingRef}
            error={createRefError}
            onCreate={() => void createMissingRef()}
            onDismiss={() => setCreateRef(null)}
          />
        )}
        {cap && !cap.available && (
          <div className="tex-install-banner" role="note">
            <span className="tex-install-banner-text">
              {t("fileViewer.noTexEngine")}
            </span>
            <code className="ollama-install-cmd">{TEX_INSTALL_CMD}</code>
            <button
              type="button"
              className="ollama-action-btn primary"
              title={t("projectDialog.runInTerminalTitle")}
              onClick={() =>
                runInstallInTab(texInstallLabel, TEX_INSTALL_CMD, IS_WINDOWS ? "default" : "bash")
              }
            >
              {t("ollama.runInTerminal")}
            </button>
            <button
              type="button"
              className="ollama-action-btn"
              title={t("fileViewer.recheckAfterInstallTitle")}
              onClick={() => void refreshTexCapability().then(setCap)}
            >
              {t("common.recheck")}
            </button>
          </div>
        )}
        <div className="file-viewer-body file-viewer-code-body">
          {compareOpen ? (
            <CompareView
              path={path}
              rightText={draft}
              onApply={(merged) => {
                setDraft(merged);
                setCompareOpen(false);
              }}
              onClose={() => setCompareOpen(false)}
            />
          ) : (
            <CodeEditor
              path={path}
              error={error}
              draft={draft}
              setDraft={setDraft}
              loaded={loaded}
              save={() => void save()}
              onFollowLink={onEditorFollow}
              linkRanges={linkRanges}
              undo={undo}
              redo={redo}
              autocomplete={ac}
              spellCheck={sc}
              texCompletions={gathered}
              fontSize={font.fontSize}
              lineHeight={font.lineHeight}
              incFont={font.inc}
              decFont={font.dec}
              resetFont={font.reset}
              gotoLine={jump.gotoLine}
              onGotoApplied={jump.onGotoApplied}
              onCaretChange={onCaret}
              caretApiRef={caretApiRef}
              initialScrollTop={viewPos.initial?.scrollTop}
              onScrollPersist={persistScroll}
              wrap
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="file-viewer" onKeyDown={onTexKeyDown}>
      {/* Single header row: the compile controls live alongside Save / Open
          externally rather than on a second toolbar line below. */}
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <button
          className={`file-viewer-tex-compile${compiling ? " is-compiling" : ""}`}
          // mousedown + preventDefault so clicking Compile doesn't blur the
          // editor textarea — the body caret stays put (and visible in a split)
          // instead of vanishing, and forward search still runs from it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void compile()}
          disabled={compiling}
          title={chordHint(
            isChild
              ? t("fileViewer.saveAndCompileNamed", { name: rootName })
              : t("fileViewer.saveAndCompile"),
            "texCompile",
          )}
        >
          {compiling
            ? t("fileViewer.compiling")
            : isChild
              ? t("fileViewer.compileNamed", { name: rootName })
              : t("fileViewer.compileBtn")}
        </button>
        {showEngineMenu && (
          <Dropdown
            className="file-viewer-tex-engine"
            title={t(
              // In a workspace the choice is the whole document's, so say so —
              // otherwise a dropdown that moves in every other pane reads as one
              // of them having lost its setting.
              onCompileOptsChange ? "fileViewer.latexEngineSharedTitle" : "fileViewer.latexEngineTitle",
            )}
            value={engine}
            onChange={(v) => patchOpts({ engine: v })}
            disabled={compiling}
            options={[
              // "" lets the backend pick from the document; label it with the
              // engine it would use (the first installed one until that answers).
              { value: "", label: t("fileViewer.engineAuto", { engine: autoEngine ?? cap.engines[0] }) },
              ...cap.engines.map((eng) => ({ value: eng, label: eng })),
            ]}
          />
        )}
        {showEngineMenu && !engine && <UntestedTag id="fileViewer.engineAuto" />}
        {compiling && <span className="file-viewer-tex-spinner" aria-hidden="true" />}
        <button
          className={`file-viewer-tex-options-toggle${showOptions ? " active" : ""}`}
          onClick={() => setShowOptions((v) => !v)}
          aria-pressed={showOptions}
          title={t("fileViewer.compilerOptionsTitle")}
        >
          {t("fileViewer.optionsBtn")} <GearIcon />
        </button>
        <button
          className={`file-viewer-tex-preview-toggle${hoverPref.on ? " active" : ""}`}
          onClick={hoverPref.toggle}
          aria-pressed={hoverPref.on}
          title={
            hoverPref.on
              ? t("fileViewer.texPreviewOnHint")
              : t("fileViewer.texPreviewOffHint")
          }
        >
          {t("fileViewer.texPreviewLabel")} <UntestedTag id="fileViewer.texPreviewLabel" />
        </button>
        <button
          className={`file-viewer-tex-beamer-toggle${beamer.on ? " active" : ""}`}
          onClick={beamer.toggle}
          aria-pressed={beamer.on}
          title={beamer.on ? t("fileViewer.beamerOnHint") : t("fileViewer.beamerOffHint")}
        >
          {t("fileViewer.beamerToggle")} <UntestedTag id="fileViewer.beamerToggle" />
        </button>
        {pdfVersion > 0 && pdfPath && (
          <button
            className="file-viewer-tex-open-pdf"
            onClick={() => openPdf(pdfPath)}
            title={t("fileViewer.openCompiledPdfTitle")}
          >
            {t("fileViewer.openPdfBtn")} <ArrowUpRightIcon />
          </button>
        )}
        <button
          className="file-viewer-tex-wordcount-btn"
          // The draft is handed in so the number answers for what is on screen,
          // not for what was last saved.
          onClick={() => void runWordCount()}
          disabled={counting || !loaded}
          title={t("fileViewer.wordCountTitle")}
        >
          {counting ? t("fileViewer.wordCountBusy") : t("fileViewer.wordCountBtn")}
        </button>
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        <EditorAiControls ai={ai} path={path} />
        <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
        <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
        <PrintButton onPrint={handlePrint} disabled={!loaded} />
      </ViewerHeader>
      {beamer.on && <BeamerBar api={texEditorApi} selection={beamerSelection} />}
      {compiling && (
        <div className="file-viewer-tex-progress" role="progressbar" aria-label={t("fileViewer.compilingLabel")}>
          <div className="file-viewer-tex-progress-bar" />
        </div>
      )}
      {showOptions && (
        <div className="file-viewer-tex-options" role="group" aria-label={t("fileViewer.compilerOptionsGroup")}>
          <label className="file-viewer-tex-option">
            <span>{t("fileViewer.outputFolderLabel")}</span>
            <input
              type="text"
              value={outDir}
              placeholder={t("fileViewer.outputFolderPlaceholder")}
              onChange={(e) => patchOpts({ outDir: e.target.value })}
            />
            <button
              type="button"
              className="file-viewer-tex-outdir-browse"
              onClick={() => setOutDirPickerOpen(true)}
              title={t("fileViewer.outputFolderBrowseTitle")}
            >
              {t("fileViewer.outputFolderBrowse")}
            </button>
            <UntestedTag id="fileViewerPane.6" />
          </label>
          <label className="file-viewer-tex-option">
            <span>{t("fileViewer.extraFlagsLabel")}</span>
            <input
              type="text"
              value={extraFlags}
              placeholder="e.g. -synctex=1 -file-line-error"
              onChange={(e) => patchOpts({ extraFlags: e.target.value })}
            />
          </label>
          <p className="file-viewer-tex-options-note">
            {t("fileViewer.shellEscapeNotePre")} <code>\write18</code> {t("fileViewer.shellEscapeNotePost")}
          </p>
        </div>
      )}
      {outDirPickerOpen && (
        <FolderPickerDialog
          initialPath={rootDir}
          boundPath={outDirBound}
          title={t("fileViewer.outputFolderPickerTitle", { name: rootName })}
          confirmLabel={t("fileViewer.outputFolderPickerConfirm")}
          allowCreateFolder
          onConfirm={(dir) => void pickOutDir(dir)}
          onClose={() => setOutDirPickerOpen(false)}
        />
      )}
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {createRef && (
        <TexCreateRefBanner
          creation={createRef.creation}
          newFolder={createRef.newFolder}
          busy={creatingRef}
          error={createRefError}
          onCreate={() => void createMissingRef()}
          onDismiss={() => setCreateRef(null)}
        />
      )}
      {compileNote === "unchanged" && (
        <div className="file-viewer-tex-sync-miss" role="status">
          {t("fileViewer.compileUnchangedMsg")} <UntestedTag id="fileViewer.compileUnchangedMsg" />
        </div>
      )}
      {/* Only alongside a *successful* build: a failed one already shows the same
          text as the error card's reason, and saying it twice reads as two
          problems. */}
      {driverNote && !compileError && (
        <div className="file-viewer-tex-sync-miss" role="status">
          {t("fileViewer.compileDriverNote")} <code>{driverNote}</code>{" "}
          <TexCopyButton label={t("fileViewer.copyError")} text={driverNote} />
          <UntestedTag id="fileViewerPane.7" />
        </div>
      )}
      {syncNote && (
        <div className="file-viewer-tex-sync-miss" role="status">
          {t(
            syncNote === "noPdf"
              ? "fileViewer.syncNoPdfMsg"
              : syncNote === "unavail"
                ? "fileViewer.syncUnavailMsg"
                : "fileViewer.syncMissMsg",
            { modifier: modifierLabel() },
          )}
          {syncNote === "noPdf" && <UntestedTag id="fileViewer.syncNoPdfMsg" />}
        </div>
      )}
      {shellEscape && (
        <div className="file-viewer-tex-shell-warning" role="alert">
          <WarningIcon /> {t("fileViewer.shellEscapeWarnPre")}<code>\write18</code>{t("fileViewer.shellEscapeWarnMid")}{" "}
          <code>texmf.cnf</code> {t("fileViewer.shellEscapeWarnOr")} <code>latexmkrc</code>{" "}
          {t("fileViewer.shellEscapeWarnPost")} <code>.tex</code> {t("fileViewer.shellEscapeWarnEnd")}
        </div>
      )}
      {saveError && <ErrorNote className="file-viewer-error" error={saveError} />}
      {compileError && (
        <div className="file-viewer-tex-error-card" role="alert">
          <div className="file-viewer-tex-error-head">
            <span className="file-viewer-tex-error-icon" aria-hidden="true"><WarningIcon /></span>
            <span className="file-viewer-tex-error-title">
              {t("fileViewer.compileErrorTitle")}
            </span>
            {errors.length > 0 && (
              <span className="file-viewer-tex-error-count">{errors.length}</span>
            )}
            {/* Copies every row, not the ones the card's 40%-max-height shows. */}
            <TexCopyButton
              className="file-viewer-tex-copy file-viewer-tex-copy-head"
              label={t("fileViewer.copyAllErrors")}
              text={
                errors.length > 0
                  ? errors
                      .map((err) => texDiagnosticText(err.message, err.file, err.line))
                      .join("\n")
                  : compileError
              }
            />
          </div>
          {/* The terse summary line only when no structured errors were parsed —
              otherwise it just repeats the first list row below. */}
          {errors.length > 0 ? (
            <ul className="file-viewer-tex-errors">
              {errors.map((err, i) => (
                <li key={`${err.file}:${err.line}:${i}`}>
                  <button
                    className="file-viewer-tex-error-jump"
                    title={t("fileViewer.jumpToLocation", { location: `${err.file}:${err.line}` })}
                    onClick={() =>
                      jumpToError(
                        resolveTexErrorPath(rootDir, err.file),
                        err.line,
                        1,
                      )
                    }
                  >
                    <span className="file-viewer-tex-error-loc">
                      {err.file.split("/").pop()}:{err.line}
                    </span>
                    <span className="file-viewer-tex-error-msg">{err.message}</span>
                  </button>
                  <TexCopyButton
                    label={t("fileViewer.copyError")}
                    text={texDiagnosticText(err.message, err.file, err.line)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="file-viewer-tex-log-line">{compileError}</div>
          )}
          {log && (
            <div className="file-viewer-tex-log-actions">
              <button
                className="file-viewer-tex-log-toggle"
                onClick={() => setShowLog((s) => !s)}
              >
                {showLog ? t("fileViewer.hideLog") : t("fileViewer.showFullLog")}
              </button>
              {/* The whole log, expanded or not: the point of copying it is to
                  hand it to someone who will read it elsewhere. */}
              <TexCopyButton label={t("fileViewer.copyLog")} text={log} />
              {/* One pill for the whole copy affordance — the row buttons are
                  the same control and would only repeat it. */}
              <UntestedTag id="fileViewerPane.8" />
            </div>
          )}
          {showLog && log && <pre className="file-viewer-tex-log">{log}</pre>}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="file-viewer-tex-warn-card" role="status">
          {/* The copy sits BESIDE the fold toggle, not inside it: the head is
              itself a button, and it copies every warning even while the card
              is folded shut. */}
          <div className="file-viewer-tex-warn-headrow">
            <button
              className="file-viewer-tex-warn-head"
              onClick={() => setShowWarnings((v) => !v)}
              aria-expanded={showWarnings}
            >
              <span className="file-viewer-tex-warn-icon" aria-hidden="true">⚑</span>
              <span className="file-viewer-tex-warn-title">{t("fileViewer.warningsTitle")}</span>
              <span className="file-viewer-tex-warn-count">{warnings.length}</span>
              <span className="file-viewer-tex-warn-caret" aria-hidden="true">
                {showWarnings ? "▾" : "▸"}
              </span>
            </button>
            <TexCopyButton
              className="file-viewer-tex-copy file-viewer-tex-copy-head"
              label={t("fileViewer.copyAllWarnings")}
              text={warnings
                .map((w) => texDiagnosticText(w.message, w.file ?? rootName, w.line))
                .join("\n")}
            />
          </div>
          {showWarnings && (
            <ul className="file-viewer-tex-warns">
              {warnings.map((w, i) => (
                <li key={`${w.file ?? ""}:${w.line ?? ""}:${i}`} className={`is-${w.kind}`}>
                  {/* A warning carries a line but often no file: only TeX's own
                      `(file … )` nesting names one, so a warning it could not
                      place falls back to the built root rather than guessing. */}
                  <button
                    className="file-viewer-tex-warn-jump"
                    disabled={!w.line}
                    title={
                      w.line
                        ? t("fileViewer.jumpToLocation", {
                            location: `${w.file ?? rootName}:${w.line}`,
                          })
                        : undefined
                    }
                    onClick={() =>
                      w.line &&
                      jumpToError(resolveTexErrorPath(rootDir, w.file ?? root), w.line, 1)
                    }
                  >
                    <span className="file-viewer-tex-warn-loc">
                      {w.line
                        ? `${(w.file ?? rootName).split("/").pop()}:${w.line}`
                        : t("fileViewer.warningNoLocation")}
                    </span>
                    <span className="file-viewer-tex-warn-msg">{w.message}</span>
                  </button>
                  <TexCopyButton
                    label={t("fileViewer.copyWarning")}
                    text={texDiagnosticText(w.message, w.file ?? rootName, w.line)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {wordCount && (
        <div className="file-viewer-tex-wordcount" role="status">
          <span className="file-viewer-tex-wordcount-main">
            {t("fileViewer.wordCountWords", { n: String(wordCount.words) })}
          </span>
          <span className="file-viewer-tex-wordcount-detail">
            {t("fileViewer.wordCountDetail", {
              headers: String(wordCount.headerWords),
              captions: String(wordCount.captionWords),
              characters: String(wordCount.characters),
            })}
          </span>
          <span className="file-viewer-tex-wordcount-detail">
            {t("fileViewer.wordCountObjects", {
              files: String(wordCount.files),
              floats: String(wordCount.floats),
              inline: String(wordCount.inlineMath),
              display: String(wordCount.displayMath),
            })}
          </span>
          <button
            className="file-viewer-tex-wordcount-close"
            onClick={() => setWordCount(null)}
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </div>
      )}
      <div className="file-viewer-body file-viewer-code-body">
        {compareOpen ? (
          <CompareView
            path={path}
            rightText={draft}
            onApply={(merged) => {
              setDraft(merged);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        ) : (
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            // Ctrl+S in the LaTeX viewer saves and recompiles (compile() persists
            // pending edits first), so the PDF preview tracks the source.
            save={() => void compile()}
            onFollowLink={onEditorFollow}
            linkRanges={linkRanges}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            spellCheck={sc}
            texCompletions={gathered}
            hoverPreview={hoverPreview}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            gotoLine={jump.gotoLine}
            onGotoApplied={jump.onGotoApplied}
            onCaretChange={onCaret}
            onSelectionChange={onSelectionChange}
            caretApiRef={caretApiRef}
            editorApiRef={texEditorApi}
            initialScrollTop={viewPos.initial?.scrollTop}
            onScrollPersist={persistScroll}
            wrap
          />
        )}
      </div>
    </div>
  );
}

// Exported so GifView shares the exact zoom behavior (steps, bounds) with the
// image viewer.
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 40;
export const ZOOM_STEP = 1.2;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * Zoomable/pannable image viewer. The image is drawn at its natural pixel size
 * and positioned with a CSS transform (`translate(...) scale(...)`, origin 0,0)
 * so a `scale` of 1 means 1:1 (one image pixel per CSS pixel). On load — and on
 * any viewport resize while still "fit" — the view resets to fit the whole image
 * centred in the viewport.
 *
 * Interactions:
 *   - wheel          → zoom toward the cursor
 *   - drag           → pan
 *   - double-click   → toggle between Fit and 100%
 *   - header buttons → − / percent / + / Fit / 1:1
 */
function ImageView({
  path,
  fileName,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  fileName: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const t = useT();
  const viewPos = useViewerState(tabKey);
  const { url, error } = useBlobUrl(path, "");
  // Print the image, fit to the page. The blob URL resolves in the print iframe
  // because a srcdoc iframe shares this document's origin.
  const handlePrint = useCallback(() => {
    if (!url) return;
    void printHtmlBody(
      `<div class="print-page"><img src="${url}" alt="${escapeHtml(fileName)}"></div>`,
      IMAGE_PRINT_CSS,
      fileName,
    );
  }, [url, fileName]);
  // #annotate (Dev F): when true, an editing overlay covers the viewer letting the
  // user draw on the image and save the result. Gated to raster images we can
  // re-encode to PNG.
  const [annotating, setAnnotating] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Natural (intrinsic) image size in pixels, set on load. The ref mirrors it so
  // an on-disk reload (#68) can tell a same-size content update from a new image.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const naturalRef = useRef<{ w: number; h: number } | null>(null);
  naturalRef.current = natural;
  // View transform: image-pixel scale and top-left offset within the viewport.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Live mirrors, read by `zoomTo`: the anchored-zoom offset is a function of the
  // PREVIOUS scale and offset together, and computing it inside a `setScale`
  // updater would mean calling `setOffset` from within another setter's updater —
  // which StrictMode double-invokes to check for purity, applying the pan
  // correction twice and throwing the cursor anchor off on every dev-build zoom.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  // True while the view is the auto-fit baseline, so a viewport resize re-fits.
  const fittedRef = useRef(true);

  const viewportSize = () => {
    const el = viewportRef.current;
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 };
  };

  // Fit scale for an image in a viewport — never upscales past 1:1, so small
  // images stay crisp rather than ballooning to fill the pane.
  const fitScaleFor = useCallback(
    (nat: { w: number; h: number }, vp: { w: number; h: number }) => {
      if (nat.w === 0 || nat.h === 0 || vp.w === 0 || vp.h === 0) return 1;
      return Math.min(vp.w / nat.w, vp.h / nat.h, 1);
    },
    [],
  );

  const fit = useCallback(
    (nat = natural) => {
      if (!nat) return;
      const vp = viewportSize();
      const s = fitScaleFor(nat, vp);
      setScale(s);
      setOffset({ x: (vp.w - nat.w * s) / 2, y: (vp.h - nat.h * s) / 2 });
      fittedRef.current = true;
    },
    [natural, fitScaleFor],
  );

  // Zoom to a target scale while keeping the given viewport-local point fixed
  // (defaults to the viewport centre).
  const zoomTo = useCallback((target: number, anchor?: { x: number; y: number }) => {
    const vp = viewportSize();
    const a = anchor ?? { x: vp.w / 2, y: vp.h / 2 };
    const prev = scaleRef.current;
    const next = clampScale(target);
    // #52: keep the anchor (cursor) point fixed under the zoom. Math extracted
    // into the pure, tested `zoomOffset` helper.
    setOffset(zoomOffset(prev, next, offsetRef.current, a));
    setScale(next);
    fittedRef.current = false;
  }, []);

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    const prev = naturalRef.current;
    setNatural(nat);
    if (!prev) {
      // First load: restore the session-persisted zoom/pan (#viewerpos) so an
      // Tabtivity restart reopens the image where the reader left it; otherwise fit.
      const init = viewPos.initial;
      if (init?.scale != null) {
        setScale(init.scale);
        setOffset({ x: init.offsetX ?? 0, y: init.offsetY ?? 0 });
        fittedRef.current = false;
        return;
      }
      fit(nat);
      return;
    }
    // Re-fit when the image's dimensions change; on a same-size content update
    // from disk (#68) keep the user's current zoom/pan.
    if (prev.w !== nat.w || prev.h !== nat.h) fit(nat);
  };

  // #viewerpos: persist zoom + pan (throttled, trailing-edge) once an image is
  // up, so reopening it or restarting Tabtivity restores this exact view.
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!natural) return;
    const s = scale;
    const ox = offset.x;
    const oy = offset.y;
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(
      () => viewPos.persist({ scale: s, offsetX: ox, offsetY: oy }),
      200,
    );
    return () => {
      if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    };
  }, [scale, offset, natural, viewPos]);

  // Re-fit on viewport resize while still in the fitted baseline state.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fittedRef.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Wheel zooms toward the cursor. Bound non-passively (see useNonPassiveWheel)
  // so `preventDefault()` cancels the native scroll instead of the viewport
  // scrolling to its limit before the zoom takes.
  const wheelRef = useNonPassiveWheel((e) => {
    if (!natural) return;
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomTo(scale * factor, anchor);
  });
  // Feed the same node to both the object ref (used for measuring/panning) and
  // the non-passive wheel binding.
  const setViewport = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      wheelRef(el);
    },
    [wheelRef],
  );

  // Pointer-drag panning.
  const dragRef = useRef<{ id: number; startX: number; startY: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!natural || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    setOffset({ x: d.ox + (e.clientX - d.startX), y: d.oy + (e.clientY - d.startY) });
    fittedRef.current = false;
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!natural) return;
    const atFit = Math.abs(scale - fitScaleFor(natural, viewportSize())) < 0.001;
    if (atFit) {
      const rect = viewportRef.current?.getBoundingClientRect();
      const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
      zoomTo(1, anchor);
    } else {
      fit();
    }
  };

  const percent = Math.round(scale * 100);

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <div className="file-viewer-zoom" role="group" aria-label={t("imageZoom.controlsLabel")}>
          <button
            className="file-viewer-zoom-btn"
            onClick={() => zoomTo(scale / ZOOM_STEP)}
            disabled={!natural || scale <= MIN_SCALE}
            title={t("imageZoom.zoomOutTitle")}
            aria-label={t("imageZoom.zoomOutTitle")}
          >
            −
          </button>
          <span className="file-viewer-zoom-level" title={t("imageZoom.currentZoomTitle")}>{percent}%</span>
          <button
            className="file-viewer-zoom-btn"
            onClick={() => zoomTo(scale * ZOOM_STEP)}
            disabled={!natural || scale >= MAX_SCALE}
            title={t("imageZoom.zoomInTitle")}
            aria-label={t("imageZoom.zoomInTitle")}
          >
            +
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => fit()}
            disabled={!natural}
            title={t("imageZoom.fitTitle")}
          >
            {t("imageZoom.fit")}
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => zoomTo(1)}
            disabled={!natural}
            title={t("imageZoom.actualSizeTitle")}
          >
            1:1
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => setAnnotating(true)}
            disabled={!url}
            title={t("fileViewer.annotateTitle")}
          >
            {t("fileViewer.annotateBtn")}
          </button>
        </div>
        <PrintButton onPrint={handlePrint} disabled={!url} />
      </ViewerHeader>
      <div className="file-viewer-body file-viewer-image-body">
        {annotating && url != null && (
          <ImageAnnotator
            src={url}
            path={path}
            fileName={fileName}
            onClose={() => setAnnotating(false)}
          />
        )}
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : url == null ? (
          <div className="file-viewer-loading">{t("common.loading")}</div>
        ) : (
          <div
            ref={setViewport}
            className={`file-viewer-image-viewport${dragging ? " dragging" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
          >
            <img
              className="file-viewer-image"
              src={url}
              alt={fileName}
              // #53: a real OS drop source — drag the image into a browser file
              // upload, a chat, etc. We publish the canonical `file://` URI and a
              // DownloadURL so receivers that prefer either get a usable target.
              // NOTE: OS-level drop-out on WebKitGTK is unreliable; this wires the
              // dataTransfer path (unit-testable) and degrades to a no-op where
              // the webview doesn't surface native drags. Tab-drag-out at the OS
              // level likely needs a Tauri capability — see TODO #53 manual test.
              draggable
              onDragStart={(e) => onImageDragStart(e, path)}
              onLoad={onImgLoad}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: "0 0",
                visibility: natural ? "visible" : "hidden",
                imageRendering: scale > 2 ? "pixelated" : "auto",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
