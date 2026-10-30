import { Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ROOT_SCOPE } from "../../../stores/tabs";
import { useSettingsStore } from "../../../stores/settings";
import { useExperimental } from "../../../lib/experimental";
import { useProjectsStore } from "../../../stores/projects";
import { useEditorJumpStore } from "../../../stores/viewers/editorJump";
import { CompareView } from "../CompareView";
import { escapeHtml } from "../../../lib/textSafety";
import { printDocument, printHtmlBody, TEXT_PRINT_CSS } from "../../../lib/viewers/print";
import { previewKindForPath, buildPreviewDoc, type PreviewKind } from "../../../lib/viewers/format";
import { type InternalViewer } from "../../../lib/viewers/fileUtils";
import {
  isPythonPath,
  isPythonMainScript,
  pythonLinkRanges,
  resolvePythonDefinition,
} from "../../../lib/viewers/python";
import {
  debugPythonFile,
  runCwd,
  runPythonFile,
  pythonRunPlan,
  fileSideLocation,
  placeForFocused,
} from "../../../lib/terminal/pythonRun";
import { RunHostPicker } from "../../tabs/TabLocalityBadges";
import { isHostPinned } from "../../../lib/projectTabHost";
import { useRunHostPrefStore } from "../../../stores/remote/runHostPref";
import {
  isSlurmScript,
  parseSbatchDirectives,
  spliceDirective,
  slurmAvailable,
  submitSlurmJob,
  openInteractiveJob,
  type SlurmInfo,
  type InteractiveResources,
} from "../../../lib/remote/hpc/slurm";
import { FileDropContext } from "../../files/fileDropContext";
import { UntestedTag } from "../../common/UntestedTag";
import { AddRemarkDialog } from "../../files/AddRemarkDialog";
import { basename, relativePathWithin } from "../../../lib/paths";
import { resolveProjectDirectory } from "../../../types";
import { useFileScope, readFileText } from "../../../lib/files/fileAccess";
import { offsetToLineCol } from "../../../lib/viewers/tex/tex";
import { isTreePath, isJsonPath } from "../../../lib/viewers/yaml";
import { isBibPath } from "../../../lib/viewers/tex/bib";
import { hasCards } from "../../../lib/viewers/yamlGrid";
import { useT } from "../../../lib/i18n";
import { CommentIcon } from "../../common/icons/Icon";
import { ErrorNote } from "../../common/ErrorNote";
import { YamlTree, YamlGrid, BibCards } from "./lazyViewers";
import { useViewerState } from "./viewerState";
import { jumpToSource } from "./sourceJump";
import { localMirrorRootFor, ViewerHeader } from "./ViewerHeader";
import { useEditableFile, ExternalChangeBanner } from "./editableFile";
import { CodeEditor } from "./CodeEditor";
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
} from "./toolbar";
import { useTabAiPrefs, EditorAiControls } from "./editorPrefs";
import { onCtrlWheelFont, useZoomModifierWheel, useEditorFontSize, FontSizeControls } from "./fontZoom";
import { useEditorJump, useBlame, BlameButton, useBreakpoints, RunDebugButtons, SlurmBar } from "./codeTools";
import { ZOOM_STEP, clampScale } from "./ImageView";

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
export function TextView({
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
              pinned={isHostPinned(project)}
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
