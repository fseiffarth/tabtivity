import { usePaneSleepHold } from "../../../lib/sleepWhenHidden";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../../lib/execTrust";
import { useSettingsStore } from "../../../stores/settings";
import { useProjectsStore } from "../../../stores/projects";
import { useEditorJumpStore } from "../../../stores/viewers/editorJump";
import { usePdfSyncStore } from "../../../stores/viewers/pdfSync";
import { Dropdown } from "../../common/Dropdown";
import { CompareView } from "../CompareView";
import { escapeHtml } from "../../../lib/textSafety";
import { printHtmlBody, TEXT_PRINT_CSS } from "../../../lib/viewers/print";
import { isBeamerDocument, type RememberedSelection } from "../../../lib/viewers/tex/beamer";
import { disabledViewers, type InternalViewer } from "../../../lib/viewers/fileUtils";
import { UntestedTag } from "../../common/UntestedTag";
import { FolderPickerDialog } from "../../common/FolderPickerDialog";
import { basename, dirname, isPathWithin, relativePathFrom } from "../../../lib/paths";
import { IS_HOST_MAC, IS_HOST_WINDOWS } from "../../../lib/platform";
import { runInstallInTab } from "../../../lib/installCommand";
import { resolveProjectDirectory } from "../../../types";
import { useFileScope, useFileSource, readFileText, fileMtime } from "../../../lib/files/fileAccess";
import { isHostPinned } from "../../../lib/projectTabHost";
import { useRemoteStatusStore } from "../../../stores/remote/remoteStatus";
import { useDiskReloadPoll } from "../../../lib/useDiskReloadPoll";
import { placeForFocused } from "../../../lib/terminal/pythonRun";
import { FileDropContext } from "../../files/fileDropContext";
import { HOST_TEX_ENGINES, openHostTexBuild } from "../../../lib/viewers/tex/hostTexBuild";
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
  resolveTexRoot,
  offsetToLineCol,
  phraseAt,
  texSnippetRanges,
  texPreamble,
  compileWasNoop,
} from "../../../lib/viewers/tex/tex";
import { chordMatches, modifierLabel, resolveChord } from "../../../lib/shortcuts/shortcuts";
import { useChordHint, useShortcutOverrides } from "../../../lib/shortcuts/shortcutHint";
import { renderTexPreview, cachedTexPreview } from "../../../lib/viewers/tex/texPreview";
import { registerTexCompile, unregisterTexCompile } from "../../../stores/viewers/texCenter";
import { useT } from "../../../lib/i18n";
import { ArrowUpRightIcon, GearIcon, WarningIcon } from "../../common/icons/Icon";
import { ErrorNote } from "../../common/ErrorNote";
import { useViewerState } from "./viewerState";
import { openLinkedFile } from "./openLinked";
import { jumpToSource } from "./sourceJump";
import { localMirrorRootFor, ViewerHeader } from "./ViewerHeader";
import { type EditorApi, useEditableFile, ExternalChangeBanner } from "./editableFile";
import { type HoverPreviewConfig, CodeEditor } from "./CodeEditor";
import { SaveButton, PrintButton, UndoRedoButtons, CompareButton } from "./toolbar";
import { useTabAiPrefs, EditorAiControls } from "./editorPrefs";
import { useEditorFontSize, FontSizeControls } from "./fontZoom";
import { useEditorJump } from "./codeTools";
import {
  useTexHoverPreview,
  useTexBeamerMode,
  BeamerBar,
  type TexCompileOpts,
  texCompileOptsFrom,
  texCompileViewerState,
  TexCreateRefBanner,
  texDiagnosticText,
  TexCopyButton,
} from "./texParts";

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
 *   - On a host-pinned project (VM, remote-only) there is no local tree to
 *     build: Compile opens a latexmk tab on the host instead
 *     (`lib/viewers/tex/hostTexBuild`), whatever this machine has installed,
 *     and the PDF tab opens once the build writes it.
 */

/** How long a host build's PDF is watched for (see `hostCompile`): a build that
 *  has written nothing by then is not coming, and the watch is an SFTP stat. */
const HOST_BUILD_WATCH_MS = 10 * 60_000;

/** OS-appropriate command to install a LaTeX/TeX distribution, used by the
 *  one-click "Install LaTeX" prompt shown when no TeX engine is on PATH. These
 *  are best-effort defaults the user can edit in the spawned terminal: MiKTeX on
 *  Windows, MacTeX on macOS (Homebrew), TeX Live on Linux (Debian/Ubuntu apt). */
const TEX_INSTALL_CMD = IS_HOST_WINDOWS
  ? "winget install --id MiKTeX.MiKTeX -e"
  : IS_HOST_MAC
    ? "brew install --cask mactex-no-gui"
    : "sudo apt-get install -y texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended latexmk";

export function TexView({
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
  // A host-pinned project (VM, remote-only) has no local tree to build in:
  // Compile opens a build tab on its host instead (`lib/viewers/tex/hostTexBuild`),
  // this machine's TeX install is beside the point, and the hover preview —
  // which typesets in the document's local folder — is off.
  const scopeProject = useProjectsStore((s) => (scope ? s.projects.find((p) => p.id === scope) : undefined));
  const hostPinned = isHostPinned(scopeProject);
  const hostConnected = useRemoteStatusStore((s) => (scope ? s.byProject[scope]?.ssh : undefined)) === "connected";
  // Non-null inside a detached popout: the build tab streams into THAT window.
  const fileDrop = useContext(FileDropContext);
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
  // A host build names its engine from the host's usual set, not this
  // machine's installs; its Auto is latexmk's own default.
  const engines = hostPinned ? HOST_TEX_ENGINES : (cap?.engines ?? []);
  const showEngineMenu = engines.length > 1;
  useEffect(() => {
    // `tex_auto_engine` reads the document off this machine's disk.
    if (!showEngineMenu || compiling || hostPinned) return;
    let cancelled = false;
    invoke<string | null>("tex_auto_engine", { path: root }).then(
      (e) => { if (!cancelled) setAutoEngine(e ?? null); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [showEngineMenu, root, compiling, hostPinned]);

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
    if (!hoverPref.on || !cap?.available || hostPinned) return undefined;
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
  }, [hoverPref.on, cap?.available, hostPinned, rootPreamble, rootDir, engine]);

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
      const rect = pickSyncRect(await synctexView(pdf, path, line, scope), sourceColumnFraction(text, line, column));
      if (rect) {
        if (!opts.afterCompile) openPdf(pdf);
        // Pass the clicked word + neighbours so the PDF narrows the line box to
        // that exact word, using the phrase to pick the right occurrence.
        usePdfSyncStore.getState().requestReveal(pdf, rect, phraseAt(text, caret) ?? undefined, opts.afterCompile);
      } else if (opts.afterCompile) {
        usePdfSyncStore.getState().requestReload(pdf);
      }
      const raw = await synctexStatus(pdf, scope);
      const moved = opts.saved != null && editedAboveLine(opts.saved, text, line);
      const status = moved ? withUnsavedSource(raw, path) : raw;
      const kind = syncNoticeKind(status, rect != null);
      if (kind) setSyncNote({ kind, files: status?.newer_sources ?? [] });
    },
    [remoteSource, path, openPdf, scope],
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

  // ── The host build (a host-pinned project; `lib/viewers/tex/hostTexBuild`) ──
  // Compile saves, then opens the build tab on the host. The build runs there,
  // in the tab, so this pane learns of its result only from the PDF: it is
  // watched (`useDiskReloadPoll` — paused while the pane is hidden, which it
  // is whenever the build tab shares its group, and caught up on show) from
  // the mtime it had before, or from absent, until it changes. Then the PDF
  // tab is opened (or refocused) as a local build's success would; an already
  // open one reloads itself on its own poll.
  const [hostBuildPdf, setHostBuildPdf] = useState<string | null>(null);
  const hostBuildBaseline = useRef<number | null>(null);
  useEffect(() => {
    setHostBuildPdf(null);
  }, [path]);
  useEffect(() => {
    if (!hostBuildPdf) return;
    const id = window.setTimeout(() => setHostBuildPdf(null), HOST_BUILD_WATCH_MS);
    return () => window.clearTimeout(id);
  }, [hostBuildPdf]);
  useDiskReloadPoll(
    hostBuildPdf,
    scope,
    () => {
      const pdf = hostBuildPdf;
      setHostBuildPdf(null);
      if (!pdf) return;
      setPdfPath(pdf);
      const nextVersion = pdfVersionRef.current + 1;
      pdfVersionRef.current = nextVersion;
      setPdfVersion(nextVersion);
      onCompiled?.({ pdfPath: pdf, pdfVersion: nextVersion });
      openPdf(pdf);
    },
    { seed: false, baseline: hostBuildBaseline, enabled: !!hostBuildPdf && hostConnected },
  );
  const hostCompile = useCallback(async () => {
    const remoteRoot = scopeProject?.remote?.remote_path;
    if (compiling || !scope || !remoteRoot) return;
    setCompiling(true);
    setCompileError(null);
    setSyncNote(null);
    try {
      // The build reads files, not editor buffers: every pane's draft first.
      await save();
      await onSaveAll?.();
      const target = await resolveTexRoot(path);
      setRoot(target);
      const pdf = target.replace(/\.tex$/i, ".pdf");
      // -1 stands for "no PDF yet", so the first build's PDF counts as a change.
      const before = await fileMtime(pdf, scope).catch(() => null);
      const opened = await openHostTexBuild({
        scope,
        projectDir: resolveProjectDirectory(scopeProject),
        texPath: target,
        remoteRoot,
        engine,
        place: placeForFocused(fileDrop),
      });
      if (!opened) return;
      hostBuildBaseline.current = before ?? -1;
      setHostBuildPdf(pdf);
    } catch (e) {
      setCompileError(String(e));
    } finally {
      setCompiling(false);
    }
  }, [compiling, scope, scopeProject, save, onSaveAll, path, engine, fileDrop]);
  const build = hostPinned ? hostCompile : compile;

  // Advertise this editor's compile to the PDF tab's "recompile" notice (a
  // reverse-search click with no map, a stale map, or a PDF rebuilt without
  // SyncTeX). The PDF viewer owns no compile of its own — this one holds the
  // draft, the engine and the out-dir — so it asks here. Rides a ref so the
  // registration is one per path, not one per render.
  const compileRef = useRef(build);
  compileRef.current = build;
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

  // No engine (or still probing): degrade to exactly the plain-text editor. A
  // host-pinned project builds on its host, whatever this machine has.
  if (!hostPinned && (!cap || !cap.available)) {
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
          onClick={() => void build()}
          disabled={compiling}
          title={chordHint(
            hostPinned
              ? t("tex.compileOnHostTitle", { host: scopeProject?.remote?.label || scopeProject?.remote?.host || "" })
              : isChild
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
        {hostPinned && <UntestedTag id="tex.compileOnHostTab" />}
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
              { value: "", label: t("fileViewer.engineAuto", { engine: (hostPinned ? null : autoEngine) ?? engines[0] }) },
              ...engines.map((eng) => ({ value: eng, label: eng })),
            ]}
          />
        )}
        {showEngineMenu && !engine && <UntestedTag id="fileViewer.engineAuto" />}
        {compiling && <span className="file-viewer-tex-spinner" aria-hidden="true" />}
        {/* The out-dir picker and extra flags shape `compile_tex`'s run; a host
            build runs a fixed latexmk line, and the hover preview
            typesets locally — neither is offered on a host-pinned project. */}
        {!hostPinned && (
          <button
            className={`file-viewer-tex-options-toggle${showOptions ? " active" : ""}`}
            onClick={() => setShowOptions((v) => !v)}
            aria-pressed={showOptions}
            title={t("fileViewer.compilerOptionsTitle")}
          >
            {t("fileViewer.optionsBtn")} <GearIcon />
          </button>
        )}
        {!hostPinned && (
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
        )}
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
      {showOptions && !hostPinned && (
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
            // pending edits first), so the PDF preview tracks the source. On a
            // host-pinned project it only saves: a build there is a new tab on
            // the host, which a save must not open (Compile / the chord does).
            save={() => void (hostPinned ? save() : compile())}
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
