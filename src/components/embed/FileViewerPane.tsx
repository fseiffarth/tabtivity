import { PreviewImages } from "./previewImages";
import { usePaneSleepHold } from "../../lib/sleepWhenHidden";
import { Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../lib/execTrust";
import { useWindowsStore } from "../../stores/windows";
import { ROOT_SCOPE, findTabByKey, useTabsStore, type ViewerState } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useDiskReloadPoll } from "../../lib/useDiskReloadPoll";
import { useTexViewPrefStore, texViewScopeKey } from "../../stores/viewers/texViewPref";
import { useExperimental } from "../../lib/experimental";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { RemotePaneHold } from "../projects/RemotePaneHold";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";
import { useScrollSync } from "../../stores/viewers/scrollSync";
import { Dropdown } from "../common/Dropdown";
import { CompareView } from "./CompareView";
import { PresentationOverlay } from "./PresentationOverlay";
import { usePresentationStore } from "../../stores/viewers/presentation";
import { matchAnchorId, renderMarkdown, toggleTaskCheckbox } from "../../lib/viewers/markdown";
import { onMarkdownLinkClick, resolveLocalHref } from "../../lib/viewers/markdownLinks";
import { useMdAnchorStore } from "../../stores/viewers/mdAnchor";
import { escapeHtml } from "../../lib/textSafety";
import {
  printDocument,
  printHtmlBody,
  MARKDOWN_PRINT_CSS,
  TEXT_PRINT_CSS,
  IMAGE_PRINT_CSS,
} from "../../lib/viewers/print";
import { previewKindForPath, buildPreviewDoc, type PreviewKind } from "../../lib/viewers/format";
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
import { disabledViewers, type InternalViewer } from "../../lib/viewers/fileUtils";
import {
  isPythonPath,
  isPythonMainScript,
  pythonLinkRanges,
  resolvePythonDefinition,
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
  spliceDirective,
  slurmAvailable,
  submitSlurmJob,
  openInteractiveJob,
  type SlurmInfo,
  type InteractiveResources,
} from "../../lib/remote/hpc/slurm";
import { FileDropContext } from "../files/fileDropContext";
import { UntestedTag } from "../common/UntestedTag";
import { FolderPickerDialog } from "../common/FolderPickerDialog";
import { fetchRemoteImage, hostsLabel, remoteImageHosts } from "../../lib/remote/remoteImages";
import { AddRemarkDialog } from "../files/AddRemarkDialog";
import {
  basename,
  dirname,
  isPathWithin,
  resolvePath,
  relativePathFrom,
  relativePathWithin,
  toFileUri,
} from "../../lib/paths";
import { IS_HOST_MAC, IS_HOST_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import { resolveProjectDirectory } from "../../types";
import { useFileSourcesStore } from "../../stores/viewers/fileSources";
import {
  FileScopeContext,
  useFileScope,
  PaneVisibleContext,
  usePaneVisible,
  fileSource,
  FileSourceContext,
  useFileSource,
  type FileSource,
  readFileText,
  readFileBytes,
  fileMtime,
  describeFileErrorKey,
} from "../../lib/files/fileAccess";
import { DiffView } from "./DiffView";
import { ViewerErrorBoundary } from "./ViewerErrorBoundary";
import {
  type TexCapability,
  type TexCompileResult,
  type TexCompletions,
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
  TEX_STANDARD_COMMANDS,
  TEX_STANDARD_ENVIRONMENTS,
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
  synctexView,
  synctexStatus,
  syncNoticeKind,
  withUnsavedSource,
  editedAboveLine,
  type SyncNoticeKind,
  pickSyncRect,
  sourceColumnFraction,
  isTexDocumentRoot,
  resolveTexRoot,
  offsetToLineCol,
  phraseAt,
  gatherTexStructure,
  texStructureParent,
  type TexStructure,
  type TexFileNode,
  texSnippetRanges,
  texPreamble,
  compileWasNoop,
} from "../../lib/viewers/tex/tex";
import {
  chordLabel,
  chordMatches,
  modifierLabel,
  resolveChord,
  type ShortcutMap,
} from "../../lib/shortcuts/shortcuts";
import { useChordHint, useShortcutOverrides } from "../../lib/shortcuts/shortcutHint";
import { renderTexPreview, cachedTexPreview } from "../../lib/viewers/tex/texPreview";
import { TexStructureRail, TexStructureSidebar } from "./tex/TexStructureSidebar";
import { useDialogs } from "../common/PromptDialogs";
import {
  compileTexWorkspace,
  registerTexCompile,
  registerTexWorkspace,
  unregisterTexCompile,
  unregisterTexWorkspace,
} from "../../stores/viewers/texCenter";
import { isTreePath, isJsonPath } from "../../lib/viewers/yaml";
import { isBibPath } from "../../lib/viewers/tex/bib";
import { hasCards } from "../../lib/viewers/yamlGrid";
import { useT, type TranslationKey } from "../../lib/i18n";
import { ArrowUpRightIcon, CommentIcon, GearIcon, LinkIcon, WarningIcon } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";
import {
  TableView,
  NotebookView,
  SqliteView,
  PdfView,
  DeckView,
  GifView,
  SyncMergeView,
  GitMergeView,
  OdtView,
  MediaView,
  YamlTree,
  YamlGrid,
  BibCards,
  MdGraphView,
  ImageAnnotator,
} from "./fileViewer/lazyViewers";
import { seedViewerState, useViewerState } from "./fileViewer/viewerState";
import { openLinkedFile, openMarkdownTarget, viewerForPath } from "./fileViewer/openLinked";
import { jumpToSource } from "./fileViewer/sourceJump";
import { ViewerHeaderInfoContext, localMirrorRootFor, autoSyncRel, ViewerHeader } from "./fileViewer/ViewerHeader";
import { type EditorApi, useEditableFile, ExternalChangeBanner } from "./fileViewer/editableFile";
import { LinkOpenHint, type HoverPreviewConfig, CodeEditor } from "./fileViewer/CodeEditor";
import {
  SaveButton,
  PrintButton,
  UndoRedoButtons,
  useFormatter,
  FormatButton,
  useSyntaxCheck,
  ValidationBanner,
  ModeToggle,
  CompareButton,
} from "./fileViewer/toolbar";
import { useViewerPref, useTabAiPrefs, EditorAiControls } from "./fileViewer/editorPrefs";
import { onCtrlWheelFont, useNonPassiveWheel, useZoomModifierWheel, useEditorFontSize, FontSizeControls } from "./fileViewer/fontZoom";
import { useEditorJump, useBlame, BlameButton, useBreakpoints, RunDebugButtons, SlurmBar } from "./fileViewer/codeTools";

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
      {/* The side the viewer's bytes come from (`useFileSource`): the Mark up
          gate and SyncTeX read it. Until `file_source` answers, a remote
          project's file counts as remote — the side that offers less. */}
      <FileSourceContext.Provider value={sideOverride ?? source ?? (project?.remote ? "remote" : "none")}>
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
      </FileSourceContext.Provider>
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

/** How long Source-mode typing in a YAML/JSON file must pause before the Cards
 *  toggle re-asks whether the file nests anything to card (a whole-file parse). */
const GRID_PROBE_SETTLE_MS = 400;

/** Rendered-preview pane for HTML/SVG/CSS — a fully sandboxed (`sandbox=""`,
 *  no scripts) iframe so even a hostile file is inert. CSS is applied to a small
 *  sample document; HTML renders its own source, SVG as an image. Every
 *  document carries its own CSP (`PREVIEW_CSP`), and an HTML file's `#anchor`
 *  links are made absolute so they scroll instead of navigating the frame away
 *  — see `withPreviewGuards`. */
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
  // flag — off until ticked in Settings → Experimental (`lib/experimental.ts`).
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
  const scope = projectId ?? ROOT_SCOPE;
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
            project={project}
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
            <Suspense fallback={<div className="file-viewer-loading">{t("common.loading")}</div>}>
              <BibCards
                text={draft}
                onChange={setDraft}
                tabKey={tabKey}
                fontSize={font.isCustom ? font.fontSize : undefined}
              />
            </Suspense>
          ) : showGrid ? (
            // The grid edits the same draft by splice, just like the tree — a cell
            // edit is dirty, undoable and saveable exactly like a typed one.
            <Suspense fallback={<div className="file-viewer-loading">{t("common.loading")}</div>}>
              <YamlGrid
                text={draft}
                onChange={setDraft}
                tabKey={tabKey}
                fontSize={font.isCustom ? font.fontSize : undefined}
                strict={jsonStrict}
              />
            </Suspense>
          ) : isYaml ? (
            // The tree edits the draft in place — the same draft Source shows and
            // Ctrl+S writes, so an edit made here is dirty, undoable and saveable
            // exactly like a typed one.
            <Suspense fallback={<div className="file-viewer-loading">{t("common.loading")}</div>}>
              <YamlTree
                text={draft}
                onChange={setDraft}
                tabKey={tabKey}
                fontSize={font.isCustom ? font.fontSize : undefined}
                strict={jsonStrict}
              />
            </Suspense>
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
      // Links: `#anchor`s scroll here, local files open in a tab, and nothing
      // navigates the app window away (shared with every Markdown host).
      onMarkdownLinkClick(e, {
        root: previewRef.current,
        basePath: path,
        open: openMarkdownTarget(tabKey, path),
      });
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
          <Suspense fallback={<div className="file-viewer-loading">{t("common.loading")}</div>}>
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
          </Suspense>
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
  const [url, setUrl] = useState<string | null>(null);
  // The failure is held as a translation KEY, not a sentence: the read effects
  // must not depend on `t` (a language flip would re-run them and discard an
  // unsaved draft), and holding the key makes the message follow the language.
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const error = errorKey ? t(errorKey) : null;
  const urlRef = useRef<string | null>(null);
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);

  // Reset to the loading state when the path itself changes (a genuine file
  // switch). A same-path reload (a diskVersion bump) keeps the current image up
  // until the fresh bytes arrive, so the view doesn't flash.
  useEffect(() => {
    setUrl(null);
    setErrorKey(null);
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

  // On an external write, bump diskVersion to re-read fresh bytes.
  useDiskReloadPoll(path, scope, () => setDiskVersion((v) => v + 1));

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
const TEX_INSTALL_CMD = IS_HOST_WINDOWS
  ? "winget install --id MiKTeX.MiKTeX -e"
  : IS_HOST_MAC
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
  const texInstallLabel = IS_HOST_WINDOWS ? t("fileViewer.texInstallMiktex") : t("fileViewer.texInstallLatex");
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine, baseline,
  } = useEditableFile(path);
  const scope = useFileScope();
  // The SyncTeX commands read the map off local disk; a file read from a remote
  // host (not its local mirror) has none there.
  const remoteSource = useFileSource() === "remote";
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
  const compilingRef = useRef(compiling);
  compilingRef.current = compiling;
  // A build in flight keeps the pane awake: its result (diagnostics, the PDF
  // reload it asks for) lands in this component (performance plan §5.3).
  usePaneSleepHold(compiling);
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
  // Why the last forward search (caret → PDF) did not jump, or may have jumped to
  // the wrong place — shown as a transient notice so it reads as a SyncTeX
  // outcome, never as a build failure (the PDF is always shown/refreshed
  // regardless). The kinds are reverse search's (`syncNoticeKind`, worded from
  // the same `synctexStatus`) plus two of forward search's own: `"noPdf"` = a
  // Ctrl/⌘+click before the document was ever compiled, so there is no PDF to
  // jump into yet; `"remote"` = the PDF is read from a remote host, whose map the
  // SyncTeX commands (local disk only) cannot reach. `files` names the sources
  // edited since the build on a `"stale"` notice. Auto-cleared by the effect below.
  const [syncNote, setSyncNote] = useState<null | {
    kind: SyncNoticeKind | "noPdf" | "remote";
    files: string[];
  }>(null);
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
  // Read by forward search, which counts unsaved edits above the caret's line
  // as a stale source: the saved text when the draft differs from it, else null.
  const unsavedBaseRef = useRef<string | null>(null);
  unsavedBaseRef.current = isDirty ? baseline : null;

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

  // SyncTeX forward search, for both callers — a Ctrl/⌘+click and the reveal
  // after a compile. `text` and `caret` are one snapshot, so the line searched
  // and the phrase the PDF narrows to come from the same draft: a compile takes
  // it when the build starts, and typing during the build must not move the
  // reveal. Opens (or refocuses) the PDF tab only on a hit, so a miss never
  // spawns a broken tab; after a compile the PDF is already open, the reveal
  // rides its reload, and a miss asks for the reload outright. Every outcome is
  // worded the way reverse search words it (`syncNoticeKind`): a stale map is
  // said even on a hit, since the jump still happens but may be off. `unsaved`
  // is the saved text when the draft has unsaved edits: an edit above the
  // caret's line moved it, which counts this file as stale (Compile saves first).
  const revealInPdf = useCallback(
    async (pdf: string, text: string, caret: number, opts: { afterCompile: boolean; saved: string | null }) => {
      // A PDF read from a remote host has no map on local disk (the PDF sits on
      // the same side as its source). A mirror path is local and goes on.
      if (remoteSource) {
        setSyncNote({ kind: "remote", files: [] });
        if (opts.afterCompile) usePdfSyncStore.getState().requestReload(pdf);
        return;
      }
      const { line, column } = offsetToLineCol(text, caret);
      // Pick the record (box / wrapped row) the clicked column lands in.
      const rect = pickSyncRect(await synctexView(pdf, path, line), sourceColumnFraction(text, line, column));
      if (rect) {
        if (!opts.afterCompile) openPdf(pdf);
        // Pass the clicked word + neighbours so the PDF narrows the line box to
        // that exact word, using the phrase to pick the right occurrence.
        usePdfSyncStore.getState().requestReveal(pdf, rect, phraseAt(text, caret) ?? undefined, opts.afterCompile);
      } else if (opts.afterCompile) {
        usePdfSyncStore.getState().requestReload(pdf);
      }
      const raw = await synctexStatus(pdf);
      const moved = opts.saved != null && editedAboveLine(opts.saved, text, line);
      const status = moved ? withUnsavedSource(raw, path) : raw;
      const kind = syncNoticeKind(status, rect != null);
      if (kind) setSyncNote({ kind, files: status?.newer_sources ?? [] });
    },
    [remoteSource, path, openPdf],
  );

  // SyncTeX forward search on demand: reveal the caret's box in the PDF without
  // recompiling.
  const forwardSync = useCallback(
    async (caret: number) => {
      // A build is running: its own reveal follows, from the caret it took at
      // the start, and a notice from this click would only race it.
      if (compilingRef.current) return;
      const pdf = targetPdf();
      setSyncNote(null);
      // Not compiled yet: say so, rather than letting SyncTeX fail on the
      // missing PDF and read as a miss.
      if (!(await texPathExists(pdf, scope))) {
        setSyncNote({ kind: "noPdf", files: [] });
        return;
      }
      await revealInPdf(pdf, draftRef.current, caret, { afterCompile: false, saved: unsavedBaseRef.current });
    },
    [targetPdf, scope, revealInPdf],
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
    // The PDF this build rewrites (known from the last one) holds its mtime
    // poll until the build is over and asks for the one reload itself below.
    const rewriting = pdfPath;
    if (rewriting) usePdfSyncStore.getState().beginCompile(rewriting);
    setCompileError(null);
    setErrors([]);
    setWarnings([]);
    setSyncNote(null);
    setCompileNote(null);
    setDriverNote(null);
    // Snapshot the caret synchronously, before any await can let focus change or
    // a blur reset it: prefer the editor's live cursor, falling back to the last
    // reported offset. This is the position forward search reveals in the PDF —
    // taken with the draft it indexes (the text this build saves), so typing
    // during the build moves neither the line nor the phrase.
    const caretAtCompile = caretApiRef.current?.() ?? caretRef.current;
    const draftAtCompile = draftRef.current;
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
        // the caret lives here. Best-effort — a miss leaves the PDF where it was.
        await revealInPdf(res.pdf_path, draftAtCompile, caretAtCompile, { afterCompile: true, saved: null });
      }
    } catch (e) {
      setCompileError(String(e));
    } finally {
      if (rewriting) usePdfSyncStore.getState().endCompile(rewriting);
      setCompiling(false);
    }
  }, [
    compiling,
    pdfPath,
    save,
    onSaveAll,
    path,
    engine,
    outDir,
    extraFlags,
    cap?.latexmk,
    openPdf,
    revealInPdf,
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
                runInstallInTab(texInstallLabel, TEX_INSTALL_CMD, IS_HOST_WINDOWS ? "default" : "bash")
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
        // One set of notices for both directions: the map-status ones are the
        // PDF viewer's own (`pdfViewer.sync*`), worded for either.
        <div className="file-viewer-tex-sync-miss" role="status">
          {t(
            syncNote.kind === "noPdf"
              ? "fileViewer.syncNoPdfMsg"
              : syncNote.kind === "remote"
                ? "pdfViewer.syncRemoteMsg"
                : syncNote.kind === "noMap"
                  ? "pdfViewer.syncNoMapMsg"
                  : syncNote.kind === "pdfNewer"
                    ? "pdfViewer.syncPdfNewerMsg"
                    : syncNote.kind === "stale"
                      ? "pdfViewer.syncStaleMsg"
                      : "fileViewer.syncMissMsg",
            {
              modifier: modifierLabel(),
              files: syncNote.files.map((f) => basename(f)).join(", "),
            },
          )}
          {syncNote.kind === "noPdf" && <UntestedTag id="fileViewer.syncNoPdfMsg" />}
          {syncNote.kind === "stale" && <UntestedTag id="fileViewerPane.9" />}
          {syncNote.kind === "remote" && <UntestedTag id="pdfViewer.syncRemoteMsg" />}
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
                      {basename(err.file)}:{err.line}
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
                        ? `${basename(w.file ?? rootName)}:${w.line}`
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
          <Suspense fallback={null}>
            <ImageAnnotator
              src={url}
              path={path}
              fileName={fileName}
              onClose={() => setAnnotating(false)}
            />
          </Suspense>
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
