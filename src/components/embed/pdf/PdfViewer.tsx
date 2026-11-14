/**
 * The in-app PDF viewer: a pdf.js canvas stack with a zoom/fit toolbar, Ctrl+F
 * find (#71), print, and bidirectional SyncTeX (#66).
 *
 * Lifted verbatim out of `FileViewerPane` (which had grown past 6.6k lines) to give
 * the page-arrangement work a home of its own. Behaviour is unchanged.
 *
 * Like the sibling viewers (`TableView`, `OdtView`, `NotebookView`), this imports
 * shared viewer plumbing back from `FileViewerPane`; the resulting import cycle is
 * the established pattern here and is safe because every use is at call time.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePdfSyncStore, type PdfHighlight } from "../../../stores/viewers/pdfSync";
import { useScrollSync } from "../../../stores/viewers/scrollSync";
import { usePdfMarkupLink } from "../../../stores/viewers/markupLinks";
import {
  useFileScope,
  useFileSource,
  usePaneVisible,
  readFileBytes,
  writeFileBytes,
  fileMtime,
} from "../../../lib/files/fileAccess";
import { SaveButton } from "../fileViewer/toolbar";
import { useViewerState } from "../fileViewer/viewerState";
import { recompileTexSource } from "../../../lib/viewers/tex/openTexWorkspace";
import {
  SELF,
  initialPages,
  keepPageIds,
  isPristine,
  isPristineExceptNotes,
  type PageList,
  type PdfNote,
  type PdfQuad,
} from "../../../lib/viewers/pageModel";
import {
  newNoteId,
  toPdfDate,
  quadsAnchor,
} from "../../../lib/viewers/pdfNotes";
import {
  addMark,
  removeMark,
  clearMarks,
  markMatches,
  markCount,
  markedSheetCount,
  type Rect,
} from "../../../lib/viewers/redact";
import { registerPdfDoc, unregisterPdfDoc, updatePdfDoc } from "../../../lib/tabCost";
import {
  openSource,
  sourceBytes,
  buildPdf,
  REDACT_DEFAULT_DPI,
  type PdfSources,
} from "./pdfDoc";
import { HIGHLIGHT_COLORS } from "./notes";
import { PdfNotesPane } from "./PdfNotesPane";
import { PdfLinkConfirmDialog } from "./PdfLinkDialog";
import { markupStripKey, markupStripKeyUp, PdfMarkupBar, PdfMarkupUndoConfirm } from "./PdfMarkupBar";
import { PdfMarkupDock } from "./PdfMarkupDock";
import { PdfMarkupPageRail } from "./PdfMarkupPageRail";
import { PdfMarkupAgentPanel } from "./PdfMarkupAgentPanel";
import { pinKey, useQuestionPins } from "./PdfMarkupQuestions";
import { tickBadgesByPage } from "./PdfMarkupTicks";
import { usePdfMarkup } from "./usePdfMarkup";
import type { QuestionPin } from "../../../lib/viewers/markupQuestions";
import {
  claimMarkup,
  diskChangeAction,
  markupClaimsVersion,
  markupGate,
  markupHolder,
  releaseMarkup,
  subscribeMarkupClaims,
} from "../../../lib/viewers/pdfMarkup";
import { isDetachedWindow } from "../../../stores/detachedContext";
import { useSettingsStore } from "../../../stores/settings";
import { PageStrip } from "../../common/PageStrip";
import { PrinterIcon } from "../../common/PrinterIcon";
import { UntestedTag } from "../../common/UntestedTag";
import { ContextFilePicker } from "../ContextFilePicker";
import { useProjectsStore } from "../../../stores/projects";
import { resolveProjectDirectory } from "../../../types";
import { basename, isPathWithin } from "../../../lib/paths";
import {
  SYNC_NOTICE_MSG,
  type SyncRect,
} from "../../../lib/viewers/tex/tex";
import { useT } from "../../../lib/i18n";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { pdfFitScale } from "./fitScale";
import { PdfWorkerSlot } from "../../../lib/viewers/pdfLoad";
import { usePaneSleepHold, useSleepWhenHidden } from "../../../lib/sleepWhenHidden";
import { isTabInPopout, useTabsStore } from "../../../stores/tabs";
import { splitSubPaneKey } from "../../../stores/tabs/viewerState";
import { useUnsavedWork } from "../../../lib/window/unsavedWork";
import { ArrowUpRightIcon, CloseIcon, CommentIcon, PencilIcon, PlayIcon, SearchIcon, TagIcon } from "../../common/icons/Icon";
import { useDiskReloadPoll } from "../../../lib/useDiskReloadPoll";
import { RELOAD_RETRY_MS, RELOAD_MAX_RETRIES, settledFileSize } from "./reloadSettle";
import {
  PDF_MIN_SCALE,
  PDF_MAX_SCALE,
  PDF_ZOOM_STEP,
  clampPdfScale,
  type ZoomPreview,
  type PendingScroll,
  pageAnchorAt,
  anchoredScrollTarget,
  restoredPdfZoom,
  rescaleScrollTarget,
  shouldArmPdfRestoreDeadline,
} from "./zoomAnchor";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { PdfThumb } from "./PdfThumb";
import { OutlinePane } from "./PdfOutlinePane";
import { usePdfOutline } from "./usePdfOutline";
import { usePdfTextSelection } from "./usePdfTextSelection";
import { usePdfFind } from "./usePdfFind";
import { usePageJump } from "./usePageJump";
import { usePdfLinks } from "./usePdfLinks";
import { usePdfPresent } from "./usePdfPresent";
import { usePdfMetadata } from "./usePdfMetadata";
import { usePdfReverseSearch } from "./usePdfReverseSearch";
import { usePdfNotes } from "./usePdfNotes";
import { usePdfPrint } from "./usePdfPrint";
import { usePageTransfer } from "./usePageTransfer";

/** The longest a running build (`beginCompile`) holds the viewer's mtime poll:
 *  a compile that long is not a compile, it is a window that died mid-build. */
const PDF_COMPILE_HOLD_MAX_MS = 10 * 60_000;

/** How long a SyncTeX forward-search highlight stays up: its fade's length, as
 *  the reverse-search click marker's is, so reduced motion (no fade) still
 *  clears it. */
export const SYNC_HIGHLIGHT_MS = 2200;

/**
 * How many pages the viewer asks the pdf.js worker about at once, for the two
 * whole-document passes that are not rendering: the intrinsic page sizes taken at
 * load, and the text extraction the find bar and the blackout tool share.
 *
 * The worker is single-threaded, so a `Promise.all` over a 200-page document does
 * not finish any sooner than a queue — it just holds every page's parsed content at
 * the same time and cannot be stopped part-way. Small enough that a cancelled scan
 * costs at most this many pages of wasted work, large enough that the round trip to
 * the worker is never the bottleneck.
 */
const PAGE_SCAN_CONCURRENCY = 8;

/** How long after the last Ctrl+wheel tick the zoom is COMMITTED — the page
 *  canvases rasterised at the new scale and the scale persisted. Until then the
 *  page stack is scaled with a CSS transform, so a wheel gesture of a dozen ticks
 *  costs one render per page instead of a dozen (each allocating a canvas up to
 *  `PDF_MAX_CANVAS_PIXELS` and cancelling the one before it). Short enough that
 *  the crisp page follows the gesture almost at once. */
export const PDF_ZOOM_COMMIT_MS = 120;

/** How long a PDF tab stays hidden before its viewer sleeps: the parsed document
 *  (1.5–4× the file in the worker) and the worker itself are released, and the
 *  tab reloads from disk on show, at the persisted page/zoom/scroll. Composes with
 *  the page release above: hidden under 30 s the pages stay painted; up to this
 *  long the canvases are gone but the document answers at once; past it the
 *  document is gone too. Held off by unsaved marks or page edits, a running
 *  build of the file, and a popout mirroring the tab. */
export const PDF_DOC_RELEASE_MS = 5 * 60_000;

/** Is the key going to somewhere that types? The host div wraps the find bar, the
 *  go-to-page box and every remark card, so the page-stepping arrow keys have to
 *  leave the caret alone wherever one of those has focus. */
const isTextEntry = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
};

// Distinguishes two viewers showing the SAME file (a split view), which would
// otherwise collide on a tabKey/path-derived strip id.
let stripSeq = 0;
const nextStripId = () => ++stripSeq;

/**
 * Reusable pdf.js-backed PDF view: a zoom toolbar over a scrolling stack of page
 * canvases. Unlike the old native `<iframe>`, every surface here is ours, so the
 * surround and (via the global scrollbar rules) the scrollbar follow the app
 * theme — giving a dark viewer in dark themes while the pages stay as authored.
 *
 * The bytes at `path` can change under us — e.g. the LaTeX viewer recompiles the
 * PDF this tab is showing — so we poll `file_mtime` and reload when it advances,
 * the PDF counterpart to the editors' diff-aware reload (#43).
 */
function PdfCanvas({
  path,
  onOpenExternally,
  tabKey,
  groupId,
  onHoldChange,
}: {
  path: string;
  /** When set, an "Open externally" button is shown at the end of the toolbar.
   *  Used by the standalone PDF tab, which has no separate header row. */
  onOpenExternally?: () => void;
  /** This viewer tab's key, for #viewerpos scroll/zoom persistence. */
  tabKey?: string;
  /** Hosting subwindow (group) id, for proportional scroll-linking (scrollSync). */
  groupId?: string | null;
  /** Tells the host whether this canvas holds unsaved work (marks not yet
   *  written, page edits not yet saved), which must keep it from sleeping. */
  onHoldChange?: (held: boolean) => void;
}) {
  const t = useT();
  const chordHint = useChordHint();
  const scope = useFileScope();
  const paneVisible = usePaneVisible();

  const viewPos = useViewerState(tabKey);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── The working arrangement (#page-arrange) ──────────────────────────────
  // The sheets this viewer shows, and the documents they are drawn from. The
  // reader below renders straight off `pages`, so reordering/deleting/turning a
  // page is an array operation — nothing is re-parsed and nothing touches disk
  // until Save, which is the only place pdf-lib runs (`buildPdf`).
  const [sources, setSources] = useState<PdfSources>(() => new Map());
  // The authoritative live map. State mirrors it for rendering, but the ref is what
  // the load effect's cleanup frees from — correct even if teardown beats a re-render.
  const sourcesRef = useRef<PdfSources>(new Map());
  /** The pdf.js worker every load of the viewed file opens on (see the unmount
   *  effect below, which owns its life). */
  const workerSlot = useRef<PdfWorkerSlot | null>(null);
  const [pages, setPages] = useState<PageList>([]);
  // A drag's callbacks outlive the render they were created in (an import can land
  // seconds later, from another window), so they read the arrangement from here
  // rather than closing over a stale snapshot.
  const pagesRef = useRef<PageList>([]);
  pagesRef.current = pages;
  // "Page X / N" toolbar readout: the page occupying the viewport. Declared here
  // (rather than beside `updateVisiblePage` below) so the go-to-page control,
  // which seeds its input from the current value, can read it too.
  const [visiblePage, setVisiblePage] = useState(1);
  // The same number as a ref, because ← / → step off the *previous* page rather
  // than off a rendered one: two presses inside one frame both read the same
  // stale state and would advance a single page. The scroll listener writes
  // both, so the ref is only ever ahead of the state, never wrong about it.
  const visiblePageRef = useRef(1);
  // Undo/redo: the arrangement is a small immutable list, so history is just a
  // stack of them. Both stacks are mirrored into refs for the reason `pagesRef`
  // is: the three history moves below each write all three pieces at once, and a
  // `setState` called from inside another setter's updater is double-invoked by
  // StrictMode — which pushed every edit onto `past` twice (so the first Undo
  // did nothing) and stacked duplicates onto `future`.
  const [past, setPast] = useState<PageList[]>([]);
  const pastRef = useRef<PageList[]>([]);
  pastRef.current = past;
  const [future, setFuture] = useState<PageList[]>([]);
  const futureRef = useRef<PageList[]>([]);
  futureRef.current = future;
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** The page rail (the thumbnail strip you arrange pages in) is showing. */
  const [railOpen, setRailOpen] = useState(false);
  // The rail is the ONLY drop target for a page drag, so a viewer holding it closed
  // cannot receive pages at all. These two drive the spring-loaded rail below: the
  // live open state (read from a subscription callback, which closes over nothing),
  // and whether it was WE who opened it — only a rail this feature opened may be
  // closed again behind the reader's back.
  const railOpenRef = useRef(false);
  railOpenRef.current = railOpen;
  const railAutoOpenedRef = useRef(false);
  /** The rail's current selection, so an insert lands where the reader is looking. */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /** The "Insert PDF…" picker is open. */
  const [pickerOpen, setPickerOpen] = useState(false);
  // Identifies this viewer's rail among every strip mounted in this window, so a drag
  // from another rail can target it. Stable for the life of the viewer.
  const [stripId] = useState(() => `pdfrail:${tabKey ?? path}:${nextStripId()}`);
  // The file changed on disk while we hold unsaved edits — reloading would throw
  // them away, so ask instead of silently clobbering either side.
  const [staleOnDisk, setStaleOnDisk] = useState(false);

  // ── Blacking text out (#pdf-redact) ──────────────────────────────────────
  // Marks live ON the arrangement (`PageRef.marks`), so they are edits like any
  // other: undoable, carried by a page that is moved or duplicated, and nothing at
  // all until Save. These four are only the tool's own state.
  /** The blackout tool is armed — a drag over a page marks an area. */
  const [redacting, setRedacting] = useState(false);
  /** Markup mode (`usePdfMarkup`, `docs/done/pdf_markup_rounds_plan.md` §2.6) — the
   *  third mode that owns the plain drag, so it excludes the two above. */
  const [marking, setMarking] = useState(false);
  const markingRef = useRef(false);
  markingRef.current = marking;
  // The project the viewed file belongs to (the longest project directory that is
  // a prefix of `path`), so a capture files its PNG into the right
  // tabtivity-screenshots/ folder and the merge picker lists the right tree even in
  // a detached window.
  // It must stay project-scoped: the backend confines every write and read to the
  // scope's tree, so an arbitrary path would simply be refused.
  const pdfProjectDir = useMemo(() => {
    const { projects } = useProjectsStore.getState();
    let best = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > best.length) best = dir;
    }
    return best;
  }, [path]);
  /** Grow each drawn box out to the words it touches. On by default: a box drawn by
   *  eye clips ascenders and word ends, and the burn-in is pixel-exact, so an
   *  unsnapped mark is how a legible sliver of the redacted word survives. */
  const [snap, setSnap] = useState(true);
  /** Resolution the flattened sheets are rendered at. */
  const [redactDpi, setRedactDpi] = useState(REDACT_DEFAULT_DPI);
  /** The save that would burn the marks in is waiting to be confirmed. Flattening
   *  is irreversible and takes the page's text with it, so it is never the silent
   *  half of a Save the user pressed for a page reorder. */
  const [confirmRedact, setConfirmRedact] = useState(false);
  /** How much is pending: areas, and the sheets a save would flatten. Both are
   *  quoted wherever the price is named, because they are different numbers — 40
   *  boxes on one page costs one page's text, and one box on 40 pages costs forty. */
  const marksTotal = markCount(pages);
  const markedSheets = markedSheetCount(pages);

  const {
    metaOpen,
    setMetaOpen,
    stripMeta,
    setStripMeta,
    meta,
    setMeta,
    metaFieldLabel,
  } = usePdfMetadata({ doc });

  /** Unsaved edits: the arrangement no longer describes the file on disk, or the
   *  metadata is pending deletion — which is an edit with no page to sit on, and
   *  the only reason Save is reachable at all on an otherwise untouched file. */
  const dirty =
    doc != null && pages.length > 0 && (stripMeta || !isPristine(pages, doc.numPages));
  // The mtime poll runs on an interval that closes over its own scope; it needs
  // the LIVE dirty flag to decide whether an on-disk change may auto-reload.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useUnsavedWork(dirty);

  const {
    deckEnabled,
    makingDeck,
    openAsDeck,
    openPresentWindow,
  } = usePdfPresent({ path, scope, tabKey, visiblePage, setError });

  /**
   * Take hold of the pristine bytes of every open source that is not holding them.
   *
   * The viewed file is opened WITHOUT a copy of its own bytes (see `PdfSource`), so
   * that a reader who only reads a large document does not carry it twice. A save
   * needs them, and re-reading at save time would be too late: from the first edit
   * onwards the file on disk can be replaced under us — a LaTeX recompile is the
   * ordinary case — while the arrangement still describes the pages of the document
   * that is on screen. So the copy is taken at the first EDIT, which is the moment
   * the ability to rebuild those exact pages starts to be worth something.
   *
   * Fire-and-forget: it races nothing (the read is idempotent and cached onto the
   * source), and a failure is not reported here — `buildPdf` asks again at save time
   * and reports it there, where the reader is waiting for an answer.
   */
  const materializeSourceBytes = useCallback(() => {
    for (const src of sourcesRef.current.values()) {
      if (!src.bytes) void sourceBytes(src).catch(() => {});
    }
  }, []);

  /** Record an arrangement edit, making it undoable.
   *
   *  The current arrangement is read from `pagesRef`, not from a `setPages`
   *  updater: every caller already builds `next` from that same ref, so the two
   *  cannot disagree, and it keeps each setter's updater pure (see the refs). */
  const applyEdit = useCallback(
    (next: PageList) => {
      materializeSourceBytes();
      const cur = pagesRef.current;
      setPast((p) => [...p, cur]);
      setFuture([]);
      setPages(next);
    },
    [materializeSourceBytes],
  );

  const undo = useCallback(() => {
    const p = pastRef.current;
    if (p.length === 0) return;
    const prev = p[p.length - 1];
    const cur = pagesRef.current;
    setFuture((f) => [cur, ...f]);
    setPast(p.slice(0, -1));
    setPages(prev);
  }, []);

  const redo = useCallback(() => {
    const f = futureRef.current;
    if (f.length === 0) return;
    const next = f[0];
    const cur = pagesRef.current;
    setPast((p) => [...p, cur]);
    setFuture(f.slice(1));
    setPages(next);
  }, []);

  // Marking, unmarking and clearing are ordinary arrangement edits — which is the
  // whole reason marks were put on the entries: undo/redo, the dirty flag and the
  // page rail all cover redaction without knowing anything about it.
  const addRedactMark = useCallback(
    (entryId: string, rect: Rect) => applyEdit(addMark(pagesRef.current, entryId, rect)),
    [applyEdit],
  );
  const removeRedactMark = useCallback(
    (entryId: string, markId: string) => applyEdit(removeMark(pagesRef.current, entryId, markId)),
    [applyEdit],
  );
  const clearAllMarks = useCallback(
    () => applyEdit(clearMarks(pagesRef.current)),
    [applyEdit],
  );

  const {
    noteAuthor,
    noteKey,
    fileNotes,
    setFileNotes,
    hiddenHl,
    ensureNotes,
    notesOpen,
    setNotesOpen,
    placed,
    noteFocus,
    setNoteFocus,
    goToNote,
    stepToNote,
    autosaveNotes,
    setAutosaveNotesPersisted,
    notesAutosavable,
    writing,
    autosaving,
    setAutosaving,
    noteSaveRef,
    addPdfNote,
    updatePdfNote,
    deletePdfNote,
    notesTotal,
    notedSheets,
  } = usePdfNotes({ doc, pages, pagesRef, sourcesRef, applyEdit, viewPos, stripMeta, staleOnDisk });
  // How this reopen starts — the seeded zoom and whether it is the fit baseline.
  // Decided once, by `restoredPdfZoom`, which is where the rule is documented.
  const restored = useState(() => restoredPdfZoom(viewPos.initial))[0];
  const [scale, setScale] = useState(restored.scale);
  // A fit-baseline restore is not addressable until this sitting's pane width is
  // known and `fitWidth` has expressed the saved offset at that zoom. In
  // particular, a PDF loaded behind its TeX editor starts with width zero.
  const [initialZoomReady, setInitialZoomReady] = useState(false);
  // True while the PDF is at the fit-to-width baseline, so a pane/tab resize
  // re-fits. A manual zoom (buttons / Ctrl+wheel) clears it; the "Fit width"
  // button and the initial fit restore it. Mirrors ImageViewer's `fittedRef`.
  const fittedRef = useRef(restored.fitted);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Proportional scroll-link to a paired subwindow (no-op unless linked).
  const reportScrollSync = useScrollSync(groupId, scrollRef);
  const contentRef = useRef<HTMLDivElement>(null);
  // True once the first document load has run, so only that load restores the
  // session-persisted scroll/zoom (#viewerpos); later reloads behave as before.
  const didInitialLoad = useRef(false);
  // After a Ctrl+wheel zoom changes `scale`, the page canvases re-render to the
  // new size asynchronously. We stash the scroll target that keeps the cursor's
  // document point fixed and apply it once the content has actually resized.
  const pendingScroll = useRef<PendingScroll | null>(null);
  // A Ctrl+wheel zoom between its first tick and its commit (`ZoomPreview`).
  // `scale` — what the canvases are rasterised at, what the layers are laid out
  // by, what is persisted — does not move until the gesture has paused for
  // `PDF_ZOOM_COMMIT_MS`; the stack is CSS-scaled by `preview.scale / scale`
  // meanwhile. The ref is the wheel handler's view of it (bound once).
  const [zoomPreview, setZoomPreview] = useState<ZoomPreview | null>(null);
  const zoomPreviewRef = useRef<ZoomPreview | null>(null);
  const zoomCommitTimer = useRef<number | null>(null);
  /** Forget a pending preview without committing it — for a zoom set by other
   *  means (fit width) that would otherwise be overwritten by the stale commit. */
  const dropZoomPreview = useCallback(() => {
    if (zoomCommitTimer.current != null) window.clearTimeout(zoomCommitTimer.current);
    zoomCommitTimer.current = null;
    zoomPreviewRef.current = null;
    setZoomPreview(null);
  }, []);
  /** Commit the previewed zoom: one raster render per near page, one persist. The
   *  scroll target that keeps the previewed picture in place — the origin point
   *  of the preview, where it shows NOW (a plain scroll meanwhile moved it) — is
   *  stashed for the ResizeObserver to apply once the stack has relaid out at the
   *  new size; the CSS preview comes off in the same React commit. A gesture that
   *  wheeled back to the committed scale commits nothing and leaves no target. */
  const commitZoomPreview = useCallback(() => {
    const preview = zoomPreviewRef.current;
    dropZoomPreview();
    if (!preview || preview.scale === scaleRef.current) return;
    const el = scrollRef.current;
    if (el) {
      const cursorX = preview.cursorX - (el.scrollLeft - preview.scrollLeft);
      const cursorY = preview.cursorY - (el.scrollTop - preview.scrollTop);
      const eff = preview.scale / scaleRef.current;
      pendingScroll.current = preview.anchor
        ? { ...preview.anchor, cursorX, cursorY }
        : {
            top: preview.stackTop + preview.originY * eff - cursorY,
            left: preview.stackLeft + preview.originX * eff - cursorX,
          };
    }
    setScale(preview.scale);
  }, [dropZoomPreview]);
  useEffect(
    () => () => {
      if (zoomCommitTimer.current != null) window.clearTimeout(zoomCommitTimer.current);
    },
    [],
  );
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);
  // The diskVersion that produced `doc`. Compile-triggered forward search waits
  // for this to reach the requested fresh version before it scrolls.
  const [loadedDiskVersion, setLoadedDiskVersion] = useState(-1);
  /** The poll's baseline (`useDiskReloadPoll`, below): every path that re-reads
   *  or writes the file records the mtime it saw here. */
  const lastMtime = useRef<number | null>(null);

  // ── Mark up (`usePdfMarkup`, `docs/done/pdf_markup_rounds_plan.md` §2.6) ─────────
  // Marks drawn over the pages and sent, as a prompt with a marked copy, to an
  // agent tab of this project. Offered only where the sheets are the file's own
  // pages (`markupGate`), one viewer per file per window (`claimMarkup`).
  /** The loaded file's size: the gate's 24 MB bound and the layer's fingerprint. */
  const [docBytes, setDocBytes] = useState<number | null>(null);
  const fileSource = useFileSource();
  const [markupOwner] = useState(() => `pdfmarkup:${tabKey ?? path}:${nextStripId()}`);
  useSyncExternalStore(subscribeMarkupClaims, markupClaimsVersion);
  const pristineSheets = doc != null && pages.length > 0 && isPristineExceptNotes(pages, doc.numPages);
  const gateInput = {
    scope,
    source: fileSource,
    detached: isDetachedWindow(),
    size: docBytes,
    pristine: pristineSheets,
    dirty,
  };
  const markupOffered = markupGate({ ...gateInput, claimedElsewhere: false }).show;
  const markup = usePdfMarkup({
    projectId: markupOffered ? scope : null,
    scope,
    path,
    active: marking,
    visible: paneVisible,
    pageCount: doc?.numPages ?? 0,
    docSize: docBytes,
    docVersion: loadedDiskVersion,
    doc,
  });
  const markupRef = useRef(markup);
  markupRef.current = markup;
  // Unsaved work holds the viewer awake (`PdfView`): a sleep is an unmount, and
  // an unmount would drop unwritten marks (a layer the store could not take,
  // while it holds marks or a round), a Submit going out, or unsaved page edits
  // on the floor.
  const held =
    (markup.storage === "unsaved" && (markup.hasUnsent || markup.round !== null)) ||
    markup.sending ||
    dirty;
  useEffect(() => {
    onHoldChange?.(held);
  }, [held, onHoldChange]);
  // The agent's questions (`markup_ask`), pinned at the words they quote.
  const questionPins = useQuestionPins(marking ? doc ?? null : null, markup.questions.asks);
  const pinnedQuestions = useMemo(
    () => new Set([...questionPins.values()].flat().map((pin) => pinKey(pin.askId, pin.index))),
    [questionPins],
  );
  const showQuestion = markup.questions.show;
  // The agent's ticks (`markup_done`): a ✓ on each group of ticked sent marks.
  const tickBadges = useMemo(
    () => tickBadgesByPage(markup.edit.base, markup.ticks.groups, markup.ticks.captions),
    [markup.edit.base, markup.ticks.groups, markup.ticks.captions],
  );
  const approveTick = markup.ticks.approve;
  const pickQuestionPin = useCallback((pin: QuestionPin) => showQuestion(pin.askId, pin.index, "card"), [showQuestion]);
  const holder = markup.key ? markupHolder(markup.key) : undefined;
  const gate = markupGate({ ...gateInput, claimedElsewhere: holder !== undefined && holder !== markupOwner });
  const markupAllowed = gate.show && gate.blocked === null;
  // The claim lasts while this viewer marks; a second pane on the same file is
  // held back meanwhile (its button says why).
  useEffect(() => {
    const key = markup.key;
    if (!marking || !key) return;
    if (!claimMarkup(key, markupOwner)) {
      setMarking(false);
      return;
    }
    return () => releaseMarkup(key, markupOwner);
  }, [marking, markup.key, markupOwner]);
  // While a round of these marks is with an agent tab, that tab's prompt strip
  // offers the way back here (`stores/viewers/markupLinks`).
  const linkTarget = marking && markup.round && tabKey ? markup.roundTarget : null;
  usePdfMarkupLink(
    linkTarget?.ptyId ?? null,
    linkTarget && tabKey ? { tabKey, name: basename(path), owner: markupOwner } : null,
  );
  // Anything that makes the sheets stop being the file's pages ends the mode.
  useEffect(() => {
    if (marking && !markupAllowed) setMarking(false);
  }, [marking, markupAllowed]);
  /** Leave markup mode. A note still being typed is kept; a new version of the
   *  file held back for the marks loads now, as it would have without them. */
  const leaveMarkup = useCallback(() => {
    const m = markupRef.current;
    if (m.edit.note) m.edit.saveNote(m.edit.note.text);
    setMarking(false);
    if (m.stale) {
      m.clearStale();
      setDiskVersion((v) => v + 1);
    }
  }, []);
  const enterMarkup = useCallback(() => {
    // An agent tab asks about this file: the strip opens on that tab.
    const asking = markupRef.current.askWaiting;
    if (asking) markupRef.current.chooseTarget(asking);
    setRedacting(false);
    setRailOpen(false);
    setMarking(true);
  }, []);
  /** Take the file's current mtime as the poll's baseline: the viewer is about
   *  to read these bytes itself, so the poll must not notice the same write
   *  afterwards and reload a second time. */
  const seedMtime = useCallback(() => {
    void fileMtime(path, scope)
      .then((mtime) => { lastMtime.current = mtime; })
      .catch(() => {});
  }, [path, scope]);
  /** **Reload PDF** under the marks: the viewer's own same-path reload, which
   *  keeps zoom, scroll and page ids. */
  const reloadUnderMarks = useCallback(() => {
    markupRef.current.beforeReload();
    seedMtime();
    setDiskVersion((v) => v + 1);
  }, [seedMtime]);
  /** The one door for "the file changed on disk" — the mtime poll, a compile's
   *  re-read request and a SyncTeX reveal after a compile (`diskChangeAction`).
   *  While marking, the new pages load under the marks on their own unless
   *  Settings → PDF markup turned that off, or a note or a Submit is under way. */
  const diskChanged = useCallback((reload: () => void) => {
    const action = diskChangeAction({
      dirty: dirtyRef.current,
      markupHolds: markupRef.current.holdsReload,
      autoReload: useSettingsStore.getState().settings?.pdf_markup_auto_reload ?? true,
      noteOpen: markupRef.current.edit.note !== null || markupRef.current.sending,
    });
    if (action === "stale") setStaleOnDisk(true);
    else if (action === "markup") markupRef.current.markStale();
    else if (action === "underMarks") {
      // The caller's own reload, with the marks told first — as Reload PDF,
      // but the strip says it happened by itself.
      markupRef.current.beforeReload(true);
      reload();
    } else reload();
  }, []);

  // The path the currently-loaded document came from. A reload that keeps the
  // same path (a recompile bumped `diskVersion`) should preserve the reader's
  // scroll position; switching to a different file should not.
  const loadedPath = useRef<string | null>(null);
  // The zoom the pending `restoreScroll` target was measured at. A saved scroll
  // offset is CSS pixels at the scale of the session that wrote it, so if the
  // initial fit lands on a different zoom (a pane of a different width), the
  // target has to be re-expressed in the new scale or the reader is restored to
  // the wrong part of the document. Null whenever no rescaling is owed.
  const restoreScale = useRef<number | null>(null);
  // Scroll target to restore after a same-path reload (a recompile). The page
  // canvases re-render asynchronously, so the content grows over several frames;
  // the ResizeObserver below re-applies this until the position is reachable.
  const restoreScroll = useRef<{ top: number; left: number } | null>(null);
  // Where the reader last was while the pane was on screen (every settled scroll
  // event). A same-path reload landing while the pane is hidden restores to this:
  // a `display:none` scroller reads scrollTop/scrollLeft 0 in WebKitGTK (measured;
  // the offset itself survives and comes back on show), so capturing it then — a
  // TeX build finishing while its PDF sits behind the .tex or in a parked popout —
  // sent the reader to the top on show and persisted that.
  const lastScroll = useRef<{ top: number; left: number } | null>(null);
  const paneVisibleRef = useRef(paneVisible);
  paneVisibleRef.current = paneVisible;
  // True when the document about to load is a same-path reload (a recompile
  // rewrote this PDF). The fit effect reads it to keep the reader's current zoom
  // instead of snapping back to fit-width. Set at load-start so it reflects the
  // load that produced the current `doc`, regardless of effect timing.
  const reloadKeepZoom = useRef(false);
  const {
    syncNotice,
    setSyncNotice,
    onSyncClick,
  } = usePdfReverseSearch({ path, scope, fileSource, diskVersion, paneVisible, scrollRef });

  // SyncTeX forward search: a pending reveal/highlight request for this PDF.
  // Copied into local state so we can consume the store request immediately
  // (avoiding a re-fire) while keeping the highlight mounted to animate.
  const reveal = usePdfSyncStore((s) => s.byPath[path] ?? null);
  const consumeReveal = usePdfSyncStore((s) => s.consume);
  const [highlight, setHighlight] = useState<PdfHighlight | null>(null);
  // The highlight is a flash, gone with its fade (1.6 s) — but under reduced
  // motion the fade is off and the box would stay for good. Dropped after the
  // click marker's 2.2 s either way, so "briefly" holds for both. The clock runs
  // only while the pane is on screen: a reveal into a hidden pane is still there
  // to see (and scroll to) when it is shown.
  useEffect(() => {
    if (!highlight || !paneVisible) return;
    const id = window.setTimeout(() => setHighlight(null), SYNC_HIGHLIGHT_MS);
    return () => window.clearTimeout(id);
  }, [highlight, paneVisible]);
  const [reloadReveal, setReloadReveal] = useState<{
    highlight: PdfHighlight;
    targetVersion: number;
  } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const { afterReload, ...target } = reveal;
    if (afterReload) {
      // An already-open PDF must read the bytes the compiler just replaced.
      // A newly mounted PDF is already loading those bytes, so wait on its
      // current version instead of starting a redundant second read.
      const targetVersion = doc ? diskVersion + 1 : diskVersion;
      setReloadReveal({ highlight: target, targetVersion });
      if (doc) {
        seedMtime();
        // Held back like any other disk change (unsaved edits, marks on the
        // pages); the reveal waits for the version the reader then loads.
        diskChanged(() => setDiskVersion(targetVersion));
      }
    } else {
      setHighlight(target);
    }
    consumeReveal(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);
  useEffect(() => {
    if (!doc || !reloadReveal || loadedDiskVersion < reloadReveal.targetVersion) return;
    setHighlight(reloadReveal.highlight);
    setReloadReveal(null);
  }, [doc, loadedDiskVersion, reloadReveal]);

  // A plain re-read request (a compile with nothing to reveal — see
  // `requestReload`): re-read the bytes now rather than wait for an mtime
  // advance that, after a latexmk "up-to-date" no-op, never comes. Skipped while
  // the first load is still in flight (it is reading those bytes already) and
  // routed through the stale banner when page edits are pending, exactly like
  // the poll — a reload replaces the arrangement.
  const reloadNonce = usePdfSyncStore((s) => s.reloadByPath[path] ?? 0);

  // A build of this PDF is running (`beginCompile`): the mtime poll stands
  // down until it ends — bounded, so a window that dies mid-build (its
  // `endCompile` never arrives) cannot leave the poll off for good.
  const compiling = usePdfSyncStore((s) => (s.compilingByPath[path] ?? 0) > 0);
  const [compileHoldExpired, setCompileHoldExpired] = useState(false);
  useEffect(() => {
    setCompileHoldExpired(false);
    if (!compiling) return;
    const id = window.setTimeout(() => setCompileHoldExpired(true), PDF_COMPILE_HOLD_MAX_MS);
    return () => window.clearTimeout(id);
  }, [compiling]);
  const compileHeld = compiling && !compileHoldExpired;
  useEffect(() => {
    if (!reloadNonce || (!doc && !error)) return;
    diskChanged(() => {
      seedMtime();
      setDiskVersion((v) => v + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);

  // A SyncTeX reveal names a page of the FILE, but the reader shows an arrangement —
  // that page may have been moved, or dropped. Resolve it to the sheet currently
  // showing it (-1 = not on screen any more, so no highlight).
  const syncSheetIndex = useMemo(
    () =>
      highlight
        ? pages.findIndex((r) => r.src === SELF && r.page === highlight.rect.page)
        : -1,
    [highlight, pages],
  );

  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const {
    sel,
    setSel,
    copiedNow,
    copyOnSelect,
    setCopyOnSelectPersisted,
  } = usePdfTextSelection({ doc, contentRef, scale, scaleRef, viewPos });

  /**
   * Mark the current selection, and optionally open the card to write about it.
   *
   * One highlight **per sheet**, because an annotation belongs to a page: a drag
   * across a page break produces two, which is what the file would have to hold
   * anyway and what every other reader shows.
   *
   * The card is opened on the highlight that sits on the sheet the drag *ended* on —
   * the one the reader is looking at. Its id is minted here rather than read back off
   * the arrangement, because the add is a state update and the card has to be aimed in
   * the same commit; going through the store would mean opening it a frame later, at
   * which point the reader has already started typing into the page.
   *
   * A sheet whose own remarks have not been read yet is skipped rather than marked.
   * That list is the baseline an edit adopts, and marking against an empty one would
   * delete every comment already in the file at the next save — the same rule the
   * right-click menu is disabled by, applied where there is no menu to disable.
   */
  const highlightSelection = useCallback(
    (color: readonly [number, number, number], andRemark: boolean) => {
      const current = sel;
      if (!current) return;
      const stamp = toPdfDate(new Date());
      let open: { entryId: string; noteId: string; x: number; y: number } | null = null;
      for (const part of current.pages) {
        const ref = pagesRef.current[part.index];
        if (!ref) continue;
        const baseline = fileNotes.get(noteKey(ref));
        if (!baseline) continue;
        const quads: PdfQuad[] = part.quads.map((q) => ({ ...q }));
        const at = quadsAnchor(quads);
        const note: PdfNote = {
          id: newNoteId(),
          x: at.x,
          y: at.y,
          quads,
          // The whole selection's words on every sheet it covers, deliberately: a
          // sentence broken over a page break is one sentence, and half of it in each
          // of two cards is worse than the same sentence in both.
          quote: current.text.trim(),
          text: "",
          ...(noteAuthor ? { author: noteAuthor } : {}),
          color: [...color] as [number, number, number],
          created: stamp,
          modified: stamp,
        };
        addPdfNote(ref.id, note, baseline);
        if (part.index === current.focusIndex) {
          open = { entryId: ref.id, noteId: note.id, x: at.x, y: at.y };
        }
      }
      // The selection has been turned into something; leaving it up would leave the
      // bar over the mark it just made, offering to make it again.
      window.getSelection()?.removeAllRanges();
      setSel(null);
      const aim = open;
      if (andRemark && aim) {
        setNoteFocus((cur) => ({
          entryId: aim.entryId,
          noteId: aim.noteId,
          sheet: current.focusIndex + 1,
          x: aim.x,
          y: aim.y,
          nonce: (cur?.nonce ?? 0) + 1,
          edit: true,
        }));
      }
    },
    [sel, fileNotes, noteKey, noteAuthor, addPdfNote, setNoteFocus, setSel],
  );

  const {
    printing,
    handlePrint,
  } = usePdfPrint({ path, doc, pages, sources, redactDpi, stripMeta, setEditError });

  /**
   * Write the arrangement back to the file. The ONLY place a PDF is written.
   *
   * After a successful save the reader must be showing exactly what is now on disk.
   * For a save the reader *asked for* that is done by bumping `diskVersion` and
   * letting the load effect re-read the file — which resets the arrangement to the
   * identity, clears the history and frees any merged-in sources, i.e. the honest
   * reconciliation for a save that may have reordered, merged or flattened pages.
   * `lastMtime` is advanced first so our OWN write can't also trip the
   * external-change poll.
   *
   * A **silent** save (`silent`, which only the remark autosave passes) must not do
   * that, and the difference is the whole point of autosaving: a reload re-parses the
   * document, repaints every canvas, resets the scroll, throws away the undo history
   * and re-mints every remark id — a visible event, once per comment, in the middle of
   * reading. So it reconciles in place instead: the sheets that were written give up
   * their ownership (`notes` back to absent, so the arrangement is pristine and the
   * Save button goes clean) and what was written becomes the file's own remarks in the
   * cache, under the SAME ids. Nothing re-reads, nothing moves, the open card stays
   * addressed at the remark it was opened on.
   *
   * Two things make that reconciliation safe rather than clever, and both are
   * guarantees of the autosave gate rather than of this function: it only ever runs
   * over the identity arrangement (`isPristineExceptNotes` — no merges, no duplicates,
   * no turns), so a sheet's cache key is unique and cannot stand for two entries; and
   * a sheet whose remarks changed *while* the bytes were in flight keeps its
   * ownership, since its `notes` array is no longer the one that was written.
   */
  const handleSave = useCallback(async (redactConfirmed = false, silent = false) => {
    if (!dirty || writing.current) return;
    // Blackouts are burned in by rasterising the sheets that carry them, which
    // destroys their text for good. Ask first — the same Save also writes ordinary
    // page moves, and "I reordered two pages" must not silently flatten a page.
    if (!redactConfirmed && markCount(pagesRef.current) > 0) {
      setConfirmRedact(true);
      return;
    }
    setConfirmRedact(false);
    writing.current = true;
    // The Save button's spinner is feedback for a click; an autosave had no click, so
    // flashing it once per comment is chrome twitching at the reader. The panel says
    // "saving…" instead, where somebody who wants to know is already looking.
    if (silent) setAutosaving(true);
    else setSaving(true);
    setEditError(null);
    // The exact list the bytes are built from, so the reconciliation below can tell
    // what was written from what has been edited since.
    const written = pages;
    try {
      const bytes = await buildPdf(written, sources, {
        emptyMsg: t("pdfViewer.pdfBuildEmpty"),
        sourceClosedMsg: t("pdfViewer.pdfSourceClosed"),
        redactDpi,
        stripMetadata: stripMeta,
      });
      // Verify the file's identity HERE, not from the poll's cached flag.
      //
      // `staleRef` cannot be trusted at this point and the three ways it fails
      // are all live: the poll returns early while the pane is hidden, so the
      // flag can never become true there at all; the poll is 1500 ms against a
      // 1200 ms autosave timer, so even visible there is a window; and the flag
      // is read when the timer fires, not when the bytes go out, while `buildPdf`
      // above takes real time on a large document.
      //
      // What is on the other side of that window is not a competing editor but
      // latexmk: it writes the PDF IN PLACE via `-outdir` (nothing renames it
      // into position), repeatedly across one build, and the backend's write is a
      // plain create+truncate with no lock. So the loser of the race is either
      // the reader's remark — written, reported saved, then truncated away — or
      // the whole compile, overwritten by bytes built from the pre-compile
      // document. One stat immediately before the write closes the window to the
      // syscall gap; the class fix is atomic writes on both sides (see
      // `todo/group-m-viewers.md` #843).
      //
      // A silent save REFUSES when the identity cannot be read at all: an
      // unattended write must not proceed on "I could not check". An explicit
      // Save still goes through — the reader asked, and the banner is the report.
      const seen = await fileMtime(path, scope).catch(() => null);
      if (seen == null) {
        if (silent) return;
      } else if (lastMtime.current != null && seen > lastMtime.current) {
        setStaleOnDisk(true);
        return;
      }
      await writeFileBytes(path, bytes, scope);
      const m = await fileMtime(path, scope).catch(() => null);
      if (m != null) lastMtime.current = m;
      setStaleOnDisk(false);
      if (!silent) {
        setDiskVersion((v) => v + 1);
        return;
      }
      // What was just written IS the file's own set now — same remarks, same ids.
      setFileNotes((prev) => {
        const next = new Map(prev);
        for (const r of written) {
          if (r.notes) next.set(noteKey(r), r.notes.map((n) => ({ ...n })));
        }
        return next;
      });
      // …so the arrangement stops owning them and is pristine again. Deliberately
      // NOT through `applyEdit`: writing the file is not an edit of the document, and
      // making it undoable would put a step in the history that undoes nothing the
      // reader did.
      setPages((cur) =>
        cur.map((r) => {
          const w = written.find((x) => x.id === r.id);
          // Changed since the write went out: still pending, still owned.
          if (!w || !r.notes || r.notes !== w.notes) return r;
          const { notes: _written, ...rest } = r;
          return rest;
        }),
      );
    } catch (e) {
      // A failed write is reported even when the save was the app's own idea: silent
      // is about the successful case, and a remark that did not reach the file is
      // exactly what the reader has to be told.
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      writing.current = false;
      setSaving(false);
      setAutosaving(false);
    }
  }, [dirty, pages, sources, path, scope, redactDpi, stripMeta, noteKey, t, setAutosaving, setFileNotes, writing]);

  // What a scheduled remark autosave calls. Through a ref because the timer is armed
  // by an edit made long before this render's `handleSave` exists, and because the
  // save closes over the arrangement it must write — the one from the render that
  // last saw it, not the one from the render that armed the timer.
  noteSaveRef.current = () => void handleSave(false, true);

  const {
    pdfPickerRoots,
    mergePdf,
    exportPages,
    importPages,
    dropMovedPages,
  } = usePageTransfer({
    scope,
    pages,
    pagesRef,
    sourcesRef,
    setSources,
    selection,
    applyEdit,
    redactDpi,
    stripMeta,
    setEditError,
    railOpenRef,
    railAutoOpenedRef,
    setRailOpen,
    markingRef,
  });
  const {
    findOpen,
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    current,
    findInputRef,
    pageText,
    matches,
    searchScrollNonce,
    searchByPage,
    currentPage,
    markerTops,
    goToMatch,
    openFind,
    closeFind,
    onFindKeyDown,
  } = usePdfFind({ pages, sources, paneVisible, redacting, scrollRef, contentRef, scale });

  /**
   * Black out every hit of the current search, across the whole document — the fast
   * path the feature is really for. Redacting a name out of a 200-page report by
   * hand is 300 drags; here it is a search and one click, and because the boxes come
   * from the same measurement the overlay is drawn from, what gets covered is
   * exactly what was highlighted.
   *
   * Marks already covering a hit are left alone (`markMatches`), so running it again
   * after refining the query does not stack duplicates.
   */
  const redactAllMatches = useCallback(() => {
    if (matches.length === 0) return;
    const byPage = new Map<number, SyncRect[][]>();
    for (const m of matches) {
      const list = byPage.get(m.page) ?? [];
      list.push(m.rects);
      byPage.set(m.page, list);
    }
    applyEdit(markMatches(pagesRef.current, byPage));
  }, [matches, applyEdit]);

  const {
    pageJumpOpen,
    pageJumpValue,
    setPageJumpValue,
    pageJumpInputRef,
    stepPage,
    openPageJump,
    closePageJump,
    commitPageJump,
  } = usePageJump({ pages, pagesRef, contentRef, scrollRef, visiblePage, visiblePageRef });

  const {
    linkBack,
    destMark,
    linkConfirm,
    setLinkConfirm,
    linkGoBack,
    onPdfLink,
    openPdfLink,
  } = usePdfLinks({ path, scale, pagesRef, sourcesRef, scrollRef, contentRef, restoreScroll, setEditError });

  /** The markup strip's bare keys, while marking (`markupStripKey`). */
  const markupKey = useCallback(
    (e: { key: string; code: string; shiftKey: boolean; repeat?: boolean }): boolean => markupStripKey(markupRef.current, e),
    [],
  );

  // Ctrl/Cmd+F opens the find bar, Ctrl/Cmd+G opens go-to-page, Ctrl/Cmd+P opens
  // the print preview; Esc closes whichever is open. Bound on the host so it
  // fires wherever focus sits within the PDF pane (the scroll area is focusable).
  const onHostKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "f") {
        e.preventDefault();
        openFind();
      } else if (mod && key === "g") {
        e.preventDefault();
        openPageJump();
      } else if (mod && key === "s") {
        e.preventDefault();
        void handleSave();
      } else if (mod && key === "p" && !e.altKey && !e.shiftKey) {
        // Print what is in front of the reader. `preventDefault` unconditionally,
        // even while a print is already being prepared: the chord otherwise reaches
        // the webview, whose own Ctrl+P prints the WHOLE Tabtivity window — the app's
        // chrome, tabs and all — which is never what was meant here. (The palette's
        // global Ctrl+P yields to a focused PDF; see QuickOpen.)
        e.preventDefault();
        void handlePrint();
      } else if (mod && key === "z" && !e.shiftKey) {
        // Marking up, the keys undo strokes; the arrangement holds still then.
        if (marking && isTextEntry(e.target)) return;
        e.preventDefault();
        if (marking) markupRef.current.undo();
        else undo();
      } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
        if (marking && isTextEntry(e.target)) return;
        e.preventDefault();
        if (marking) markupRef.current.redo();
        else redo();
      } else if (marking && !mod && !e.altKey && !isTextEntry(e.target) && markupKey(e)) {
        e.preventDefault();
      } else if (e.altKey && e.key === "ArrowLeft") {
        // The browser's own "back" gesture, for the same thing it means here:
        // return from the link you just followed.
        e.preventDefault();
        linkGoBack();
      } else if (
        (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
        !mod &&
        !e.altKey &&
        !e.shiftKey &&
        !isTextEntry(e.target)
      ) {
        // Next/previous sheet — a beamer deck is a page per slide, and the arrow
        // keys are what it is read with in every other reader. Bare keys only:
        // Alt+← is already "back" above, and Shift+← extends a text selection.
        // At either end nothing is claimed, so the scroller keeps the key.
        if (stepPage(e.key === "ArrowRight" ? 1 : -1)) e.preventDefault();
      } else if (e.key === "Escape" && pageJumpOpen) {
        e.preventDefault();
        closePageJump();
      } else if (e.key === "Escape" && findOpen) {
        e.preventDefault();
        closeFind();
      } else if (e.key === "Escape" && redacting) {
        // Last of the Escape branches: putting the blackout tool away matters less
        // than closing whatever was opened on top of it, and disarming while the
        // find bar is up would leave the bar with nothing to close it.
        e.preventDefault();
        setRedacting(false);
      } else if (e.key === "Escape" && marking && markupRef.current.panel && !isTextEntry(e.target)) {
        // The agent panel closes first, then the selection lets go, then the
        // mode is left.
        e.preventDefault();
        markupRef.current.setPanel(false);
      } else if (e.key === "Escape" && marking && markupRef.current.edit.selection && !isTextEntry(e.target)) {
        // Selected marks let go first; the next Escape leaves the mode.
        e.preventDefault();
        markupRef.current.edit.clearSelection();
      } else if (e.key === "Escape" && marking && !isTextEntry(e.target)) {
        e.preventDefault();
        leaveMarkup();
      }
    },
    [
      marking,
      markupKey,
      leaveMarkup,
      openFind,
      closeFind,
      findOpen,
      openPageJump,
      closePageJump,
      pageJumpOpen,
      handleSave,
      undo,
      redo,
      redacting,
      linkGoBack,
      stepPage,
      handlePrint,
    ],
  );

  // Poll mtime; on a change (e.g. a recompile wrote a new PDF), bump
  // diskVersion so the load effect re-reads the fresh bytes (#43-style). The
  // baseline is seeded once per file, visible or not, so it pairs with the
  // bytes the load effect read. `useDiskReloadPoll` polls visible panes only —
  // a hidden PDF tab (every backgrounded project's, and a TeX PDF behind
  // another tab in its group) polled an SFTP stat per tick on a remote project
  // forever — and its immediate check on re-show catches a recompile that
  // happened while the tab was hidden.
  //
  // A reload REPLACES the arrangement, so it would silently throw away any
  // unsaved page edits. With edits pending `diskChanged` raises a banner and
  // lets the reader choose; without them the old auto-reload stands (a LaTeX
  // recompile must still refresh the PDF on its own). Marks on the pages hold
  // it back the same way, behind the markup strip's Reload.
  //
  // Held while a build of this PDF is running in a TeX editor (`beginCompile`):
  // latexmk rewrites the file once per pass, and the poll used to read every
  // intermediate PDF — retrying each one it caught mid-write — before the
  // compile's own reload request at the end read the one that counts.
  // Resuming after a build: its reload request (or its SyncTeX reveal) has
  // just asked for the bytes and is recording the mtime it read them at. An
  // immediate check here would see the same advance first and read the file
  // a second time; the interval's first tick is soon enough for a build that
  // ended without asking (a failed one).
  const wasCompileHeld = useRef(compileHeld);
  const resumingAfterCompile = wasCompileHeld.current && !compileHeld;
  useEffect(() => {
    wasCompileHeld.current = compileHeld;
  });
  useDiskReloadPoll(path, scope, () => diskChanged(() => setDiskVersion((v) => v + 1)), {
    baseline: lastMtime,
    enabled: !compileHeld,
    immediate: !resumingAfterCompile,
  });

  // Load (and reload on path / disk change) the document. pdf.js detaches the
  // backing buffer, so each load gets a fresh Uint8Array; the prior documents are
  // destroyed on cleanup to free worker memory.
  useEffect(() => {
    let cancelled = false;
    // Same-path reload (a recompile): remember where the reader was so we can
    // restore it once the fresh pages have laid out, instead of jumping to the
    // top. A genuine file switch starts fresh. On the FIRST load, instead restore
    // the position persisted from a prior session (#viewerpos) so a Tabtivity
    // restart reopens the PDF where the reader left it.
    const el = scrollRef.current;
    let firstRestore: { top: number; left: number } | null = null;
    if (!didInitialLoad.current) {
      didInitialLoad.current = true;
      const init = viewPos.initial;
      if (init && ((init.scrollTop ?? 0) > 0 || (init.scrollLeft ?? 0) > 0)) {
        firstRestore = { top: init.scrollTop ?? 0, left: init.scrollLeft ?? 0 };
        restoreScale.current = init.scale ?? null;
      }
    }
    const samePathReload = loadedPath.current === path;
    restoreScroll.current =
      firstRestore ??
      (samePathReload
        ? // A same-path re-run that lands while a restore is still PENDING must
          // keep that target rather than recapture the live position — because
          // the target was never reached, so `el.scrollTop` is still 0 and
          // capturing it would silently replace the persisted position with the
          // top of the document. This fires on React StrictMode's dev-mode
          // double-mount (the hot-reload build wraps the app in <StrictMode>) and
          // on a disk-change reload arriving mid-restore, and was "the PDF forgot
          // where I was" on every dev restart. Once the pending restore has been
          // applied and cleared, a genuine same-path reload (a recompile) falls
          // through to capturing where the reader actually is — read off the
          // scroller only while it is on screen (`lastScroll`).
          (restoreScroll.current ??
            (el
              ? paneVisibleRef.current
                ? { top: el.scrollTop, left: el.scrollLeft }
                : lastScroll.current
              : null))
        : null);
    reloadKeepZoom.current = samePathReload;
    loadedPath.current = path;
    // The documents the on-screen arrangement is currently drawn from — the file
    // itself AND any merged-in PDFs. Freed once the fresh load has swapped in,
    // not up front: keeping them alive is what lets a same-path reload (a
    // recompile) leave the old pages painted until the new ones are ready.
    const prevSources = sourcesRef.current;
    const freePrev = () => {
      for (const s of prevSources.values()) s.doc.loadingTask.destroy();
    };
    // Whether a failure may stay silent: only when a last good document is
    // actually on screen to fall back on. `samePathReload` alone is not that —
    // StrictMode's dev double-mount re-runs this effect with `loadedPath`
    // already set, so a FIRST load that fails (e.g. the backend refusing the
    // read) matched the reload case and swallowed its error into a permanent
    // "Loading…".
    const hasPrevDoc = prevSources.size > 0;
    // A same-path reload keeps the current document on screen while the fresh
    // bytes load — blanking it would flash the page (and, on a truncated
    // mid-compile read, an error) on every poll of a multi-second compile. A
    // genuine file switch shows the loading state as before.
    if (!samePathReload) {
      setDoc(null);
      setError(null);
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          // A recompile is caught mid-write more often than not: the mtime
          // advances on the compiler's first write, the poll fires, and a read
          // of a 100 MB thesis moves the whole truncated file over IPC — once
          // per retry. So a same-path reload (and any retry) first waits for
          // the size to hold still across two stats, and reads once.
          if (attempt > 0 || (samePathReload && hasPrevDoc)) {
            await settledFileSize(path, scope, () => cancelled);
            if (cancelled) return;
          }
          const bytes = await readFileBytes(path, scope);
          if (cancelled) return;
          // Taken before pdf.js detaches the buffer: the markup mode's size gate
          // and its layer's fingerprint.
          const byteLength = bytes.byteLength;
          // pdf.js DETACHES the buffer it is handed, so a save cannot reuse these
          // bytes — pdf-lib needs its own. For the file being VIEWED that copy is
          // not kept: it is re-read from disk instead, the first time an edit makes
          // it matter (`materializeSourceBytes` below). Reading a large document is
          // the common case and was paying the whole file twice for a save that
          // usually never comes.
          const src = await openSource(bytes, {
            reread: () => readFileBytes(path, scope),
            // The viewer's own worker, so a recompile's reload (and each retry of
            // a mid-write read) does not spawn a fresh one (`PdfWorkerSlot`).
            worker: workerSlot.current?.get(),
          });
          if (cancelled) {
            src.doc.loadingTask.destroy();
            return;
          }
          // A load is a fresh start: one source, the identity arrangement, no
          // history. Swap in the new document, THEN free the one it replaces —
          // freeing after the swap is what keeps the old pages painted through
          // the change instead of flashing empty.
          sourcesRef.current = new Map([[SELF, src]]);
          setSources(sourcesRef.current);
          setPages(
            samePathReload
              ? keepPageIds(pagesRef.current, initialPages(src.doc.numPages))
              : initialPages(src.doc.numPages),
          );
          setPast([]);
          setFuture([]);
          // The metadata is a property of the bytes, so a reload re-reads it and
          // disarms the pending deletion — after a save that performed one, the
          // panel must show the (now empty) file rather than still offering to
          // strip what has already gone.
          setStripMeta(false);
          setMeta(null);
          setStaleOnDisk(false);
          setError(null);
          setEditError(null);
          setLoadedDiskVersion(diskVersion);
          setDocBytes(byteLength);
          setDoc(src.doc);
          freePrev();
          return;
        } catch (e) {
          if (cancelled) return;
          // A truncated read while the compiler is still writing is transient:
          // retry a few times before treating it as a real error.
          if (attempt < RELOAD_MAX_RETRIES) {
            await sleep(RELOAD_RETRY_MS);
            if (cancelled) return;
            continue;
          }
          // Out of retries. On a reload there is a last good document to keep
          // showing (the next mtime poll will try the fresh file again), so say
          // nothing; on a first load there is nothing to fall back on.
          if (!samePathReload || !hasPrevDoc) {
            freePrev();
            setError(String(e));
          }
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, scope, diskVersion, setMeta, setStripMeta]);

  // Safety net: stop re-applying an unreachable target once the VISIBLE pages
  // have had time to lay out. A hidden tab is not merely off screen: its
  // `display:none` scroller has no reachable range, so starting this clock at
  // document load discarded TeX-linked PDFs' saved positions four seconds into
  // startup, while they were still sitting behind the restored editor tab.
  useEffect(() => {
    const target = restoreScroll.current;
    if (!shouldArmPdfRestoreDeadline(paneVisible, target)) return;
    const id = window.setTimeout(() => {
      restoreScroll.current = null;
      restoreScale.current = null;
    }, 4000);
    return () => window.clearTimeout(id);
  }, [doc, paneVisible]);

  // Release the open source documents when the viewer unmounts. This is its own
  // effect (not the load effect's cleanup) because the load effect now hands its
  // outgoing sources to the next load to free on success — so a same-path reload
  // never tears down the document that is still on screen.
  //
  // It also owns the viewer's pdf.js worker (`PdfWorkerSlot`), created here rather
  // than at render so a StrictMode remount gets a live one, and ended only once the
  // documents on it have been torn down.
  //
  // The slot doubles as this viewer's token in the tab cost registry
  // (`lib/tabCost`): registered with it, unregistered beside its disposal.
  const costMeta = useRef({ tabKey, path });
  costMeta.current = { tabKey, path };
  useEffect(() => {
    const slot = new PdfWorkerSlot();
    workerSlot.current = slot;
    registerPdfDoc(slot, costMeta.current);
    return () => {
      const pending = [...sourcesRef.current.values()].map((s) => s.doc.loadingTask.destroy());
      sourcesRef.current = new Map();
      if (workerSlot.current === slot) workerSlot.current = null;
      unregisterPdfDoc(slot);
      slot.dispose(pending);
    };
  }, []);

  // What this viewer holds, for the tab cost readout: pages over every open
  // source, the viewed file's bytes plus any merged source's own copy. No
  // document on screen (a file switch in flight, a failed load) counts as none.
  // Read off state the load path already sets; the load itself is untouched.
  useEffect(() => {
    const slot = workerSlot.current;
    if (!slot) return;
    let pages = 0;
    let bytes = doc ? (docBytes ?? 0) : 0;
    if (doc) {
      for (const [id, src] of sources) {
        pages += src.doc.numPages;
        if (id !== SELF) bytes += src.bytes?.byteLength ?? 0;
      }
    }
    updatePdfDoc(slot, { pages, bytes, tabKey, path });
  }, [sources, docBytes, doc, tabKey, path]);

  // Intrinsic (scale-1) CSS dimensions of every page, computed once per document
  // load. Lets each PdfPageCanvas reserve its true size before rendering so the
  // page stack reaches its full scroll height immediately — without it the
  // restored scroll position (#viewerpos) is unreachable until every page above
  // it has finished rendering, which on a slow startup loses the position to the
  // restore deadline. getPage()/getViewport() read only page metadata (no
  // rasterisation), so this is cheap relative to actually rendering the pages.
  const [pageSizes, setPageSizes] = useState<{ w: number; h: number }[] | null>(null);
  // The last full measurement of THIS file's own pages, in file order: a
  // same-path reload (a recompile) with the same page count and unchanged
  // first and last pages keeps it instead of asking the worker about every
  // page again — on a long document that pass was the first thing between a
  // build and its pages. Only the identity arrangement is ever kept, and never
  // across a file switch (reset with the path below).
  const measuredRef = useRef<{ n: number; sizes: { w: number; h: number }[] } | null>(null);
  useEffect(() => {
    measuredRef.current = null;
  }, [path, scope]);
  // A page canvas found its page a different size from the one reserved for it
  // (`onSize`): a reload kept the measurement because the count and the two end
  // pages were unchanged, and this page in the middle was the one that changed.
  // Correct the reservation — and the kept measurement, so the next reload's
  // comparison starts from the truth. A page above the viewport that changes
  // height would shift everything on screen by the difference; the page under
  // the viewport's top edge is pinned where it is, through the same anchored
  // target a zoom commit uses, unless one is already pending.
  const correctPageSize = useCallback((i: number, size: { w: number; h: number }) => {
    const kept = measuredRef.current;
    if (kept && i < kept.n) {
      measuredRef.current = { n: kept.n, sizes: kept.sizes.map((s, k) => (k === i ? size : s)) };
    }
    const el = scrollRef.current;
    const content = contentRef.current;
    if (el && content && !pendingScroll.current && !zoomPreviewRef.current) {
      const wraps = content.querySelectorAll<HTMLElement>(":scope > .file-viewer-pdf-page-wrap");
      const er = el.getBoundingClientRect();
      const top = er.top + el.clientTop;
      const left = er.left + el.clientLeft;
      const changed = wraps[i]?.getBoundingClientRect();
      if (changed && changed.height > 0 && changed.bottom <= top) {
        const anchor = pageAnchorAt(content, left, top);
        if (anchor) {
          const r = anchor.wrap.getBoundingClientRect();
          pendingScroll.current = {
            ...anchor,
            cursorX: r.left + anchor.fx * r.width - left,
            cursorY: r.top + anchor.fy * r.height - top,
          };
        }
      }
    }
    setPageSizes((prev) => {
      const cur = prev?.[i];
      if (!prev || !cur || (cur.w === size.w && cur.h === size.h)) return prev;
      const next = prev.slice();
      next[i] = size;
      return next;
    });
  }, []);
  useEffect(() => {
    if (pages.length === 0) {
      setPageSizes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const measure = async (ref: (typeof pages)[number]) => {
          const d = sources.get(ref.src)?.doc;
          if (!d) return { w: 0, h: 0 };
          const page = await d.getPage(ref.page);
          // A quarter turn swaps the sheet's box; asking for the rotated viewport
          // means the reserved height is right for turned pages too.
          const vp = page.getViewport({
            scale: 1,
            rotation: (((page.rotate + ref.rot) % 360) + 360) % 360,
          });
          return { w: vp.width, h: vp.height };
        };
        const identity = pages.every((r, i) => r.src === SELF && r.page === i + 1 && r.rot === 0);
        const kept = measuredRef.current;
        if (identity && kept && kept.n === pages.length && pages.length > 0) {
          const same = (a: { w: number; h: number }, b: { w: number; h: number }) =>
            a.w === b.w && a.h === b.h;
          const first = await measure(pages[0]);
          const last = pages.length > 1 ? await measure(pages[pages.length - 1]) : first;
          if (cancelled) return;
          if (same(first, kept.sizes[0]) && same(last, kept.sizes[kept.n - 1])) {
            // The sizes already reserved stand; `pageSizes` is still that array.
            return;
          }
        }
        // Windowed for the reason the text scan is (see `PAGE_SCAN_CONCURRENCY`):
        // this runs on every load, so on a long document it is the first thing
        // between the reader and their pages.
        const sizes: { w: number; h: number }[] = new Array(pages.length);
        for (let i = 0; i < pages.length && !cancelled; i += PAGE_SCAN_CONCURRENCY) {
          const done = await Promise.all(pages.slice(i, i + PAGE_SCAN_CONCURRENCY).map(measure));
          done.forEach((s, j) => {
            sizes[i + j] = s;
          });
        }
        if (cancelled) return;
        measuredRef.current = identity ? { n: pages.length, sizes } : null;
        setPageSizes(sizes);
      } catch {
        /* leave heights unreserved — restore falls back to the old behaviour */
      }
    })();
    return () => { cancelled = true; };
  }, [pages, sources]);

  // Fit the first page to the viewport when a document loads: by width, except
  // a landscape page (a slide) taller than the viewport at that width, which is
  // fitted whole (`pdfFitScale`). The toolbar button toggles `fitModeRef`; a
  // load or a resize re-fit keeps whatever the reader last chose.
  const fitModeRef = useRef<"page" | "width">("page");
  const [fitNext, setFitNext] = useState<"page" | "width">("width");
  const fitWidth = useCallback(async (d: PDFDocumentProxy) => {
    const el = scrollRef.current;
    if (!el) return;
    const page = await d.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const avail = el.clientWidth - 24; // leave room for page margins
    if (avail > 0 && vp.width > 0) {
      const availH = el.clientHeight - 24;
      const fit = pdfFitScale(avail, availH, vp.width, vp.height, fitModeRef.current === "page");
      const nextScale = clampPdfScale(fit.scale);
      // What the button offers next: the whole-page fit, only if it differs.
      setFitNext(fit.fitsPage || !pdfFitScale(avail, availH, vp.width, vp.height, true).fitsPage ? "width" : "page");
      // Re-express the pending target BEFORE announcing that zoom is ready: the
      // restore layout effect runs before ordinary effects, so leaving this to
      // the scale effect below could apply (and clear) the old-scale offset one
      // frame too early.
      const from = restoreScale.current;
      if (from != null && restoreScroll.current) {
        restoreScroll.current = rescaleScrollTarget(restoreScroll.current, from, nextScale);
        restoreScale.current = nextScale;
      }
      dropZoomPreview();
      setScale(nextScale);
      fittedRef.current = true;
      setInitialZoomReady(true);
      // Record the baseline here rather than leaving it to the scale-persist
      // effect: fitting when the view is already AT the fit (the "Fit width"
      // button on an untouched document) changes no scale, so that effect never
      // fires — and the flag is the whole point. `viewPos.persist` dedups.
      viewPos.persist({ pdfFitted: true });
    }
  }, [viewPos, dropZoomPreview]);

  // Fit to width when a document loads — UNLESS this is the first load and a
  // DELIBERATE zoom was persisted from a prior session, in which case honour the
  // saved scale (already seeded into `scale`). A saved scale that was merely the
  // previous session's fit is re-fitted to THIS pane instead: the pane it was
  // measured in is gone, and its width is what the number encoded. A same-path
  // reload (a recompile rewrote this PDF) keeps the reader's current zoom rather
  // than snapping back to fit-width; only a genuine switch to a different file
  // refits.
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (!doc) return;
    if (!didInitialFit.current) {
      didInitialFit.current = true;
      if (viewPos.initial?.scale != null && !fittedRef.current) {
        setInitialZoomReady(true);
        return;
      }
    } else if (reloadKeepZoom.current) {
      setInitialZoomReady(true);
      return;
    }
    void fitWidth(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, fitWidth]);

  // A hidden first load has width zero, so the attempt above intentionally does
  // nothing. Retry on reveal even in engines/tests where ResizeObserver does not
  // report the display:none → visible transition; only a successful fit marks
  // the saved scroll target ready to apply.
  useEffect(() => {
    if (!doc || !paneVisible || initialZoomReady || !fittedRef.current) return;
    void fitWidth(doc);
  }, [doc, paneVisible, initialZoomReady, fitWidth]);

  // Re-fit to width when the pane/tab resizes, but only while at the fit
  // baseline — a manual zoom opts out. Same contract as ImageViewer's resize
  // re-fit. `fitWidth` reads scrollRef.clientWidth, so the pane width alone
  // drives it; a scale change doesn't alter the pane width, so no feedback loop.
  useEffect(() => {
    const el = scrollRef.current;
    if (!doc || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fittedRef.current) void fitWidth(doc);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, fitWidth]);

  // #viewerpos: persist the zoom whenever it changes (only once a document is up,
  // so the pre-load placeholder scale is never written). setViewerState dedups,
  // so re-persisting an unchanged scale is a no-op.
  useEffect(() => {
    // `pdfFitted` rides along with every scale write so the next session can tell
    // the reader's zoom from a fit of a pane that no longer exists. Both setters
    // update `fittedRef` synchronously with their `setScale`, so by the time this
    // commit effect runs the ref describes the scale being written.
    if (doc) viewPos.persist({ scale, pdfFitted: fittedRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, doc]);

  // Keep a pending session restore addressed to the right part of the document
  // when the initial fit moves the zoom out from under it (see `restoreScale`).
  // Pixels scale with the zoom, so the target does too.
  useEffect(() => {
    const from = restoreScale.current;
    if (from == null || from === scale) return;
    restoreScale.current = scale;
    const target = restoreScroll.current;
    if (!target) {
      restoreScale.current = null;
      return;
    }
    restoreScroll.current = rescaleScrollTarget(target, from, scale);
  }, [scale]);

  // "Page X / N" toolbar readout: the page occupying the viewport. The anchor
  // is a third of the way down the viewport (typical PDF-viewer feel); the page
  // wraps are always all mounted, so a linear scan over their live rects stays
  // correct across zoom, resize, and mixed page heights.
  const updateVisiblePage = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const anchor = el.getBoundingClientRect().top + el.clientHeight / 3;
    const pages = content.children;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].getBoundingClientRect().bottom >= anchor) {
        visiblePageRef.current = i + 1;
        setVisiblePage(i + 1);
        return;
      }
    }
    if (pages.length > 0) {
      visiblePageRef.current = pages.length;
      setVisiblePage(pages.length);
    }
  }, []);
  useEffect(() => {
    visiblePageRef.current = 1;
    setVisiblePage(1);
    if (doc) updateVisiblePage();
  }, [doc, updateVisiblePage]);

  const {
    outlineOpen,
    setOutlineOpen,
    activeOutline,
    outlineDerived,
    outlinePlaceholder,
    currentOutlineId,
    jumpToPage,
  } = usePdfOutline({ doc, pages, pagesRef, visiblePage, contentRef });

  // #viewerpos: persist the scroll position as the reader scrolls (throttled,
  // trailing-edge). Ignored while a programmatic restore is still settling so we
  // don't overwrite the saved target with an intermediate frame.
  const scrollPersistTimer = useRef<number | null>(null);
  const onScrollPersist = useCallback(() => {
    const el = scrollRef.current;
    updateVisiblePage();
    if (!el || restoreScroll.current) return;
    reportScrollSync();
    const top = el.scrollTop;
    const left = el.scrollLeft;
    lastScroll.current = { top, left };
    if (scrollPersistTimer.current != null) window.clearTimeout(scrollPersistTimer.current);
    scrollPersistTimer.current = window.setTimeout(
      () => viewPos.persist({ scrollTop: top, scrollLeft: left }),
      200,
    );
  }, [viewPos, reportScrollSync, updateVisiblePage]);
  useEffect(
    () => () => {
      if (scrollPersistTimer.current != null) window.clearTimeout(scrollPersistTimer.current);
    },
    [],
  );

  // Ctrl/Cmd+wheel zooms the page stack toward the cursor (a plain wheel keeps
  // native scrolling). A tick does not rasterise: it moves the PREVIEW (the
  // stack CSS-scaled around the cursor) and re-arms the commit timer, so a
  // gesture of many ticks lands as one render at its final scale. The scroll
  // target that keeps the picture where the preview showed it is derived at the
  // commit from what the first tick measured (`ZoomPreview`), and applied by the
  // ResizeObserver below once the stack has relaid out at the committed size.
  const onWheel = useCallback((e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    // A user zoom takes over; abandon any in-flight recompile scroll restore.
    restoreScroll.current = null;
    const committed = scaleRef.current;
    const held = zoomPreviewRef.current;
    const base = held?.scale ?? committed;
    const factor = e.deltaY < 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP;
    let next = clampPdfScale(base * factor);
    // Wheeled back to where it started (1.2 × 1.2 / 1.2 is not always 1.2 in
    // floating point): nothing to commit, rather than a re-render of every near
    // page at a scale a rounding error away from the one they are at.
    if (Math.abs(next - committed) < 1e-9) next = committed;
    if (next === base) return;
    fittedRef.current = false; // manual zoom opts out of resize re-fit
    let preview: ZoomPreview;
    if (held) {
      // Later ticks keep the first tick's origin and anchor — the stack is
      // already transformed, so measuring again would move the origin under
      // its own transform and the picture would jump.
      preview = { ...held, scale: next };
    } else {
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left - el.clientLeft;
      const cursorY = e.clientY - rect.top - el.clientTop;
      const content = contentRef.current;
      const cr = content?.getBoundingClientRect();
      preview = {
        scale: next,
        originX: cr ? e.clientX - cr.left : 0,
        originY: cr ? e.clientY - cr.top : 0,
        cursorX,
        cursorY,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        stackLeft: cr ? cr.left - rect.left - el.clientLeft + el.scrollLeft : 0,
        stackTop: cr ? cr.top - rect.top - el.clientTop + el.scrollTop : 0,
        anchor: content ? pageAnchorAt(content, e.clientX, e.clientY) : null,
      };
    }
    zoomPreviewRef.current = preview;
    setZoomPreview(preview);
    if (zoomCommitTimer.current != null) window.clearTimeout(zoomCommitTimer.current);
    zoomCommitTimer.current = window.setTimeout(commitZoomPreview, PDF_ZOOM_COMMIT_MS);
  }, [commitZoomPreview]);

  // Bind the zoom wheel non-passively so `preventDefault()` above actually
  // cancels the native scroll — a React `onWheel` is passive, so Ctrl+wheel
  // would otherwise scroll the page to its limit before the zoom took hold.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Settle a same-path reload's saved position the moment the fresh document is
  // up. The ResizeObserver below is the one that used to do this, and it only
  // fires when the page stack CHANGES SIZE — which a recompile that kept every
  // page's geometry no longer does, now that unchanged pages keep their canvases.
  // Left pending, the target would still be sitting there at the next build and
  // would yank the reader back to where they were two compiles ago (the 4 s
  // fallback timer in the load effect is what used to mask that). Applying it
  // here is also simply correct: nothing moved, so the position is already right
  // and this clears the request.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const target = restoreScroll.current;
    if (!doc || !paneVisible || !initialZoomReady || !el || !target) return;
    el.scrollTop = target.top;
    el.scrollLeft = target.left;
    if (el.scrollTop >= target.top - 1) {
      restoreScroll.current = null;
      restoreScale.current = null;
    }
  }, [doc, paneVisible, initialZoomReady]);

  // Apply a pending cursor-anchored scroll target once the page content has
  // resized after a zoom (the observer fires when the canvases repaint).
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // Cursor-anchored zoom target: apply once, the moment the canvases resize.
      const pending = pendingScroll.current;
      if (pending) {
        pendingScroll.current = null;
        const target = "wrap" in pending ? anchoredScrollTarget(el, pending) : pending;
        if (target) {
          el.scrollTop = target.top;
          el.scrollLeft = target.left;
        }
      }
      // Recompile reload: the page stack grows over several frames as canvases
      // render, so keep re-applying the saved position until it's reached, then
      // stop. A target the new (shorter) document can't hold is dropped by the
      // bounded fallback timer in the load effect.
      const restore = restoreScroll.current;
      if (restore) {
        el.scrollTop = restore.top;
        el.scrollLeft = restore.left;
        if (el.scrollTop >= restore.top - 1) {
          restoreScroll.current = null;
          restoreScale.current = null;
        }
      }
      // A layout-height change (zoom re-render, pages appearing) moves which
      // page sits under the anchor even without a scroll event.
      updateVisiblePage();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [doc, updateVisiblePage]);

  return (
    <div
      className="file-viewer-pdf-host"
      onKeyDown={onHostKeyDown}
      onKeyUp={(e) => {
        if (marking && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextEntry(e.target) && markupStripKeyUp(markupRef.current, e)) e.preventDefault();
      }}
    >
      <div className="file-viewer-pdf-toolbar" role="group" aria-label={t("pdfViewer.zoomControlsLabel")}>
        {/* Contents (chapters) sits at the far left — it opens the navigation
            column on the same side, so the button lines up over it. */}
        <button
          className={`file-viewer-zoom-btn${outlineOpen ? " active" : ""}`}
          onClick={() => setOutlineOpen((v) => !v)}
          disabled={!doc}
          title={t("pdfViewer.contentsTitle")}
          aria-label={t("pdfViewer.contentsLabel")}
          aria-pressed={outlineOpen}
        >
          ☰
        </button>
        {/* Back to where the last link was followed from (#pdf-links). Rendered
            only once there is somewhere to go back to: a permanently disabled
            arrow in a viewer whose links most documents don't have would be
            chrome that never does anything. */}
        {linkBack.length > 0 && (
          <button
            className="file-viewer-zoom-btn"
            onClick={linkGoBack}
            title={chordHint(t("pdfLinks.backTitle"), { key: "ArrowLeft", alt: true })}
            aria-label={t("pdfLinks.backLabel")}
          >
            ←
          </button>
        )}
        {linkBack.length > 0 && <UntestedTag id="pdfViewer.2" />}
        <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
        <button
          className="file-viewer-zoom-btn"
          onClick={() => {
            fittedRef.current = false;
            commitZoomPreview();
            setScale((s) => clampPdfScale(s / PDF_ZOOM_STEP));
          }}
          disabled={!doc || scale <= PDF_MIN_SCALE}
          title={t("imageZoom.zoomOutTitle")}
          aria-label={t("imageZoom.zoomOutTitle")}
        >
          −
        </button>
        <span className="file-viewer-zoom-level">{Math.round((zoomPreview?.scale ?? scale) * 100)}%</span>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => {
            fittedRef.current = false;
            commitZoomPreview();
            setScale((s) => clampPdfScale(s * PDF_ZOOM_STEP));
          }}
          disabled={!doc || scale >= PDF_MAX_SCALE}
          title={t("imageZoom.zoomInTitle")}
          aria-label={t("imageZoom.zoomInTitle")}
        >
          +
        </button>
        <button
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={() => {
            if (!doc) return;
            fitModeRef.current = fitNext;
            void fitWidth(doc);
          }}
          disabled={!doc}
          title={t(fitNext === "page" ? "pdfViewer.fitPageTitle" : "pdfViewer.fitPageWidthTitle")}
        >
          {t(fitNext === "page" ? "pdfViewer.fitPageButton" : "pdfViewer.fitWidthButton")}
        </button>
        {doc && (
          pageJumpOpen ? (
            <input
              ref={pageJumpInputRef}
              className="file-viewer-pdf-pagejump-input"
              type="number"
              min={1}
              max={pages.length}
              value={pageJumpValue}
              aria-label={t("pdfViewer.goToPageLabel")}
              onChange={(e) => setPageJumpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPageJump();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closePageJump();
                }
              }}
              onBlur={closePageJump}
            />
          ) : (
            <button
              className="file-viewer-zoom-btn file-viewer-pdf-pagenum"
              onClick={openPageJump}
              title={chordHint(t("pdfViewer.goToPageTitle"), { key: "g", ctrl: true })}
              aria-label={t("pdfViewer.goToPageLabel")}
            >
              {visiblePage} / {pages.length}
            </button>
          )
        )}
        <button
          className={`file-viewer-zoom-btn${findOpen ? " active" : ""}`}
          onClick={() => (findOpen ? closeFind() : openFind())}
          disabled={!doc}
          title={chordHint(t("pdfViewer.findTitle"), { key: "f", ctrl: true })}
          aria-label={t("pdfViewer.findLabel")}
          aria-pressed={findOpen}
        >
          <SearchIcon />
        </button>
        {/* There is deliberately no "select text" button beside this one any more.
            It was a mode, and selecting words in a document is not one — see the
            text layer in `PdfPageCanvas`. */}
        {/* Black out text (#pdf-redact). Beside the find button because the two work
            as a pair — search for the name, black out every hit. */}
        <button
          className={`file-viewer-zoom-btn${redacting ? " active" : ""}`}
          onClick={() => {
            if (marking) leaveMarkup();
            setRedacting((v) => !v);
          }}
          disabled={!doc}
          title={t("pdfRedact.toolTitle")}
          aria-label={t("pdfRedact.toolLabel")}
          aria-pressed={redacting}
        >
          ▮
        </button>
        <UntestedTag id="pdfViewer.3" />
        {/* Mark up (`usePdfMarkup`): beside the blackout tool, the other mode that
            draws over the page. Absent where it has nothing to send to (root,
            boxes, remote projects, popouts) — see `markupGate`. */}
        {gate.show && (
          <>
            <button
              className={`file-viewer-zoom-btn file-viewer-zoom-text${marking ? " active" : ""}${
                !marking && (markup.hasUnsent || markup.askWaiting) ? " is-armed" : ""
              }`}
              onClick={() => (marking ? leaveMarkup() : enterMarkup())}
              disabled={!doc || (!marking && gate.blocked !== null)}
              title={t(
                gate.blocked === "arranged"
                  ? "pdfMarkup.toggleArranged"
                  : gate.blocked === "claimed"
                    ? "pdfMarkup.toggleClaimed"
                    : !marking && markup.askWaiting
                      ? "pdfMarkup.toggleAsks"
                      : "pdfMarkup.toggleTitle",
              )}
              aria-pressed={marking}
            >
              <PencilIcon /> {t("pdfMarkup.toggle")}
            </button>
            <UntestedTag id="desktop.markup" />
          </>
        )}
        {/* There is deliberately no ✂ copy-region button any more either: the
            region capture is armed by the header's global Screenshot app, which
            hands the shot to a visible PDF viewer before it would spawn an OS
            region tool — one capture entry point instead of two. */}
        {/* The remarks panel (#pdf-notes) — the document's comments as a list, and
            the way to walk them. A panel rather than a mode: reading the remarks is
            not a thing you stop doing to the page, so it arms nothing and turns
            nothing off. */}
        <button
          className={`file-viewer-zoom-btn${notesOpen ? " active" : ""}`}
          onClick={() => setNotesOpen((v) => !v)}
          disabled={!doc}
          title={t("pdfNotes.paneTitle")}
          aria-label={t("pdfNotes.paneTitle")}
          aria-pressed={notesOpen}
        >
          <CommentIcon />
        </button>
        <UntestedTag id="pdfViewer.4" />
        {/* Delete the metadata (#pdf-meta). Beside the blackout tool because the two
            are the same job on the file's two halves — what is on the page, and what
            the file says about itself off it. */}
        <button
          className={`file-viewer-zoom-btn${metaOpen ? " active" : ""}${stripMeta ? " is-armed" : ""}`}
          onClick={() => setMetaOpen((v) => !v)}
          disabled={!doc}
          title={t("pdfMeta.toolTitle")}
          aria-label={t("pdfMeta.toolLabel")}
          aria-pressed={metaOpen}
        >
          <TagIcon />
        </button>
        <UntestedTag id="pdfViewer.5" />
        {/* ── Page arranging (#page-arrange) ────────────────────────────────
            Edits live in memory until Save, so a stray delete is always one Ctrl+Z
            away and never touches the file. */}
        <button
          className={`file-viewer-zoom-btn${railOpen ? " active" : ""}`}
          onClick={() => setRailOpen((v) => !v)}
          disabled={!doc || marking}
          title={t("pdfViewer.arrangePagesTitle")}
          aria-label={t("pdfViewer.arrangePagesTitle")}
          aria-pressed={railOpen}
        >
          ▤
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => setPickerOpen(true)}
          disabled={!doc || !pdfProjectDir || marking}
          title={
            pdfProjectDir
              ? t("pdfViewer.insertPdfTitle")
              : t("pdfViewer.insertPdfNoProjectTitle")
          }
          aria-label={t("pdfViewer.insertPdfLabel")}
        >
          ⊕
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={undo}
          disabled={past.length === 0 || marking}
          title={chordHint(t("pdfViewer.undoTitle"), { key: "z", ctrl: true })}
          aria-label={t("common.undo")}
        >
          ↶
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={redo}
          disabled={future.length === 0 || marking}
          title={chordHint(t("pdfViewer.redoTitle"), { key: "z", ctrl: true, shift: true })}
          aria-label={t("common.redo")}
        >
          ↷
        </button>
        <SaveButton
          isDirty={dirty}
          saving={saving}
          save={() => void handleSave()}
          title={dirty ? chordHint(t("pdfViewer.saveDirtyTitle"), { key: "s", ctrl: true }) : t("pdfViewer.saveCleanTitle")}
        />
        {/* Pending remarks (#pdf-notes), beside the Save that writes them. Shown by
            the number of SHEETS being rewritten rather than of remarks, because
            deleting the last remark on a page leaves nothing to count and is still a
            pending change — a readout that vanished at that moment would say the
            edit had been lost. */}
        {notedSheets > 0 && (
          <span className="file-viewer-pdf-note-pending" title={t("pdfNotes.pendingTitle")}>
            <CommentIcon /> {t("pdfNotes.pending", { n: notesTotal, pages: notedSheets })}
            <UntestedTag id="pdfViewer.6" />
          </span>
        )}
        <button
          className={`file-viewer-print file-viewer-pdf-print${printing ? " is-busy" : ""}`}
          onClick={() => void handlePrint()}
          disabled={!doc || printing}
          title={printing ? t("pdfViewer.preparing") : chordHint(t("pdfViewer.printTitle"), { key: "p", ctrl: true })}
          aria-label={t("pdfViewer.printLabel")}
        >
          {printing ? (
            <span className="file-viewer-save-spinner" aria-hidden="true" />
          ) : (
            <PrinterIcon />
          )}
        </button>
        <UntestedTag id="pdfViewer.printLabel" />
        {/* Fullscreen present: this PDF in a window of its own, with nothing else
            on the screen. Beside Print because the two are the same job aimed at
            the two audiences a document has — the room and the page. */}
        <button
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={openPresentWindow}
          disabled={!doc}
          title={
            dirty
              ? t("pdfViewer.fullscreenPresentDirtyTitle")
              : t("pdfViewer.fullscreenPresentTitle")
          }
          aria-label={t("pdfViewer.fullscreenPresentLabel")}
        >
          <PlayIcon /> {t("pdfViewer.fullscreenPresentBtn")}
        </button>
        <UntestedTag id="pdfViewer.7" />
        {deckEnabled && (
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => void openAsDeck()}
            disabled={!doc || makingDeck}
            title={t("pdfViewer.presentTitle")}
          >
            {makingDeck ? "…" : <><PlayIcon /> {t("pdfViewer.presentButton")}</>}
          </button>
        )}
        {onOpenExternally && (
          <button
            className="file-viewer-open-external file-viewer-pdf-external"
            onClick={onOpenExternally}
            title={t("pdfViewer.openExternalTitle")}
            aria-label={t("pdfViewer.openExternalTitle")}
          >
            <ArrowUpRightIcon />
          </button>
        )}
      </div>
      {redacting && (
        // The blackout tool's own strip. It says what the tool does, what it will
        // cost at save, and offers the two bulk actions — never a "redact" button
        // that silently rewrites the file, which is the shape this feature must not
        // have.
        <div className="file-viewer-pdf-redact-bar" role="group" aria-label={t("pdfRedact.toolLabel")}>
          <span className="file-viewer-pdf-redact-hint">{t("pdfRedact.dragHint")}</span>
          <label className="file-viewer-pdf-redact-opt">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
            {t("pdfRedact.snapToText")}
          </label>
          <label className="file-viewer-pdf-redact-opt">
            {t("pdfRedact.quality")}
            <select
              value={redactDpi}
              onChange={(e) => setRedactDpi(Number(e.target.value))}
              aria-label={t("pdfRedact.quality")}
            >
              <option value={150}>{t("pdfRedact.qualityDraft")}</option>
              <option value={REDACT_DEFAULT_DPI}>{t("pdfRedact.qualityStandard")}</option>
              <option value={300}>{t("pdfRedact.qualitySharp")}</option>
            </select>
          </label>
          <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
          {/* Search-driven bulk marking. Offered only with hits on screen: a button
              that can only report "nothing matched" is chrome, and the find bar is
              where the query it would use lives. */}
          {findOpen && matches.length > 0 ? (
            <button className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={redactAllMatches}>
              {t("pdfRedact.blackOutMatches", { n: matches.length })}
            </button>
          ) : (
            <button
              className="file-viewer-zoom-btn file-viewer-zoom-text"
              onClick={openFind}
              title={t("pdfRedact.searchFirstTitle")}
            >
              {t("pdfRedact.searchFirstButton")}
            </button>
          )}
          <span className="file-viewer-pdf-redact-count">
            {marksTotal > 0
              ? t("pdfRedact.pending", { areas: marksTotal, pages: markedSheets })
              : t("pdfRedact.pendingNone")}
          </span>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={clearAllMarks}
            disabled={marksTotal === 0}
          >
            {t("pdfRedact.clearAll")}
          </button>
          <span className="file-viewer-pdf-redact-warn">{t("pdfRedact.flattenWarning")}</span>
        </div>
      )}
      {marking && <PdfMarkupBar markup={markup} onDone={leaveMarkup} />}
      {marking && <PdfMarkupUndoConfirm markup={markup} onReload={reloadUnderMarks} />}
      {metaOpen && doc && (
        // The metadata panel — the blackout tool's strip, wearing the same class so
        // the two read as the pair they are. It shows the fields BEFORE it offers to
        // delete them, which is the whole point: none of this is on the page, so a
        // bare "Delete all metadata" button would be a control whose effect the
        // reader could neither see beforehand nor verify afterwards.
        <div className="file-viewer-pdf-redact-bar" role="group" aria-label={t("pdfMeta.toolLabel")}>
          <span className="file-viewer-pdf-redact-hint">{t("pdfMeta.hint")}</span>
          <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
          {meta == null ? (
            <span className="file-viewer-pdf-redact-count">{t("pdfMeta.reading")}</span>
          ) : meta.entries.length === 0 && !meta.xmp ? (
            <span className="file-viewer-pdf-redact-count">{t("pdfMeta.none")}</span>
          ) : (
            <span className={`file-viewer-pdf-meta-list${stripMeta ? " is-doomed" : ""}`}>
              {meta.entries.map((e) => (
                <span key={e.key} className="file-viewer-pdf-meta-entry">
                  <span className="file-viewer-pdf-meta-key">{metaFieldLabel(e.key)}</span>
                  <span className="file-viewer-pdf-meta-value">{e.value}</span>
                </span>
              ))}
              {/* The XMP packet has no value worth printing — it is a whole XML
                  document — so it is named as a presence rather than quoted. */}
              {meta.xmp && (
                <span className="file-viewer-pdf-meta-entry">
                  <span className="file-viewer-pdf-meta-key">{t("pdfMeta.xmp")}</span>
                </span>
              )}
            </span>
          )}
          <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
          {/* Arms a pending deletion; it is Save that writes it, exactly as a
              blackout is. Offered even for a file with nothing listed, because the
              list is what pdf.js can see — the per-page packets and the private
              scratch space an editor left behind are cleared by the same save and
              are not in it. */}
          <button
            className={`file-viewer-zoom-btn file-viewer-zoom-text${stripMeta ? " active" : ""}`}
            onClick={() => {
              // A pending deletion makes the file dirty without going through
              // `applyEdit`, so it has to take hold of the source bytes itself —
              // it is a change waiting to be written like any other.
              materializeSourceBytes();
              setStripMeta((v) => !v);
            }}
            aria-pressed={stripMeta}
            title={t("pdfMeta.deleteAllTitle")}
          >
            {stripMeta ? t("pdfMeta.keepButton") : t("pdfMeta.deleteAllButton")}
          </button>
          {stripMeta && (
            <span className="file-viewer-pdf-redact-warn">{t("pdfMeta.pendingSave")}</span>
          )}
        </div>
      )}
      {findOpen && (
        <div className="file-viewer-find file-viewer-find-pdf" role="search">
          <div className="file-viewer-find-row">
            <input
              ref={findInputRef}
              className="file-viewer-find-input"
              type="text"
              value={query}
              placeholder={t("pdfViewer.findPlaceholder")}
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
              <CloseIcon />
            </button>
          </div>
        </div>
      )}
      {confirmRedact && (
        // The one gate in front of an irreversible write. It names both numbers and
        // says plainly what is destroyed — a "this cannot be undone" with no subject
        // is what gets clicked through.
        <div className="file-viewer-banner is-warn" role="alert">
          <span>{t("pdfRedact.confirmMessage", { areas: marksTotal, pages: markedSheets })}</span>
          <button onClick={() => void handleSave(true)}>{t("pdfRedact.confirmSaveButton")}</button>
          <button onClick={() => setConfirmRedact(false)}>{t("common.cancel")}</button>
        </div>
      )}
      {staleOnDisk && (
        // The file changed underneath our unsaved edits. Reloading would throw them
        // away and saving would overwrite the newer file, so neither happens on its
        // own — the reader picks.
        <div className="file-viewer-banner" role="alert">
          <span>{t("pdfViewer.staleOnDiskMessage")}</span>
          <button
            onClick={() => {
              setStaleOnDisk(false);
              setDiskVersion((v) => v + 1);
            }}
          >
            {t("pdfViewer.reloadDiscardButton")}
          </button>
          <button onClick={() => setStaleOnDisk(false)}>{t("pdfViewer.keepChangesButton")}</button>
        </div>
      )}
      {syncNotice && (
        // A reverse-search click that could not be honoured, or was honoured
        // from a build the source has since moved past. Names the edited files
        // on a stale map so the reader can tell "I forgot to recompile" from
        // "someone else's build".
        <div className="file-viewer-banner" role="status">
          <span>
            {t(
              syncNotice.opened
                ? syncNotice.kind === "remote"
                  ? "pdfViewer.syncRemoteOpenedMsg"
                  : "pdfViewer.syncNoMapOpenedMsg"
                : syncNotice.kind === "miss"
                  ? "pdfViewer.syncMissMsg"
                  : SYNC_NOTICE_MSG[syncNotice.kind],
              {
                files: syncNotice.sources.map((f) => basename(f)).join(", "),
                file: basename(syncNotice.source),
              },
            )}
            {syncNotice.kind === "remote" && <UntestedTag id="pdfViewer.syncRemoteMsg" />}
            {syncNotice.opened && <UntestedTag id="pdfViewer.syncOpenedByName" />}
          </span>
          {syncNotice.canRecompile && (
            <button
              onClick={() => {
                const { source } = syncNotice;
                setSyncNotice(null);
                void recompileTexSource(source);
              }}
            >
              {t("pdfViewer.syncRecompileButton")}
            </button>
          )}
          <button onClick={() => setSyncNotice(null)}>{t("common.close")}</button>
        </div>
      )}
      {editError && (
        <div className="file-viewer-banner is-error" role="alert">
          <span>{editError}</span>
          <button onClick={() => setEditError(null)}>{t("pdfViewer.dismiss")}</button>
        </div>
      )}
      <div className="file-viewer-pdf-scroll-wrap">
        {outlineOpen && doc && (
          <OutlinePane
            doc={doc}
            nodes={activeOutline}
            placeholder={outlinePlaceholder}
            derived={outlineDerived}
            currentId={currentOutlineId}
            onJump={jumpToPage}
          />
        )}
        {notesOpen && doc && (
          // The remarks panel, on the same side as the contents sidebar and wearing
          // its chrome: both are lists of what is in the document, read beside it.
          <PdfNotesPane
            placed={placed}
            currentId={noteFocus?.noteId ?? null}
            autosave={autosaveNotes}
            autosavable={notesAutosavable}
            saving={autosaving}
            onSetAutosave={setAutosaveNotesPersisted}
            onGo={(p) => goToNote(p)}
            onStep={stepToNote}
            onEditNote={(p) => goToNote(p, true)}
            onDeleteNote={(p) => {
              const ref = pagesRef.current.find((r) => r.id === p.entryId);
              if (ref) deletePdfNote(p.entryId, p.note.id, fileNotes.get(noteKey(ref)) ?? []);
            }}
            onClose={() => setNotesOpen(false)}
          />
        )}
        {marking && doc && (
          <PdfMarkupPageRail
            pages={pages}
            marked={(page) => !!markup.edit.base.pages[page]}
            visiblePage={visiblePage}
            onJump={jumpToPage}
            thumb={(ref) => <PdfThumb doc={doc} page={ref.page} rot={ref.rot} />}
          />
        )}
        {railOpen && doc && !marking && (
          // The page rail: the SAME <PageStrip> the print preview uses, stood on its
          // side. Drag to reorder, shift-click for a range, right-click for the rest.
          <div className="file-viewer-pdf-rail">
            <PageStrip
              pages={pages}
              onChange={applyEdit}
              orientation="column"
              onSelectionChange={setSelection}
              // Drag pages out of this rail and into another PDF viewer's — in this
              // window or in a detached one. Copy by default; Shift moves them.
              stripId={stripId}
              onExport={exportPages}
              onImport={importPages}
              onMovedOut={dropMovedPages}
              renderThumb={(ref) => (
                <PdfThumb
                  doc={sources.get(ref.src)?.doc}
                  page={ref.page}
                  rot={ref.rot}
                  marks={ref.marks}
                />
              )}
              badgeFor={(_ref, i) => String(i + 1)}
              titleFor={(ref) =>
                (ref.src === SELF
                  ? t("pdfViewer.pageOf", { n: ref.page })
                  : t("pdfViewer.pageOfMerged", { n: ref.page })) +
                (ref.rot ? t("pdfViewer.turnedSuffix", { deg: ref.rot }) : "")
              }
            />
          </div>
        )}
        <div
          className="file-viewer-pdf-scroll"
          ref={scrollRef}
          tabIndex={0}
          onScroll={onScrollPersist}
        >
          {error != null ? (
            <div className="file-viewer-error">{error}</div>
          ) : !doc ? (
            <div className="file-viewer-loading">{t("common.loading")}</div>
          ) : (
            <div
              className="file-viewer-pdf-pages"
              ref={contentRef}
              // A zoom in progress: the stack scaled with CSS around the cursor
              // until the gesture pauses and the canvases are rendered at the new
              // size (`PDF_ZOOM_COMMIT_MS`). A transform changes no layout, so the
              // scroll offset holds still underneath it — which is what lets the
              // committed, cursor-anchored scroll target be computed up front.
              style={
                zoomPreview
                  ? {
                      transform: `scale(${zoomPreview.scale / scale})`,
                      transformOrigin: `${zoomPreview.originX}px ${zoomPreview.originY}px`,
                    }
                  : undefined
              }
            >
              {/* The reader renders the ARRANGEMENT, sheet by sheet — each pulled
                  from its own source document — so an edit shows up immediately with
                  nothing re-parsed. An unedited PDF is the identity arrangement over
                  its own pages, i.e. exactly what it always was. Keyed by entry id so
                  a reorder MOVES the canvas rather than repainting it. */}
              {pages.map((ref, i) => {
                const srcDoc = sources.get(ref.src)?.doc;
                if (!srcDoc) return null;
                return (
                  <PdfPageCanvas
                    key={ref.id}
                    doc={srcDoc}
                    pageNumber={ref.page}
                    rot={ref.rot}
                    scale={scale}
                    cssSize={pageSizes?.[i]}
                    onSize={(size) => correctPageSize(i, size)}
                    // SyncTeX only means anything for pages of the file itself: a
                    // page merged in from another PDF has no line in this source.
                    // Wired whether or not a map exists: without one the click
                    // explains itself (a "recompile" notice) instead of doing
                    // nothing. The crosshair cursor still only arms with a map.
                    onSyncClick={ref.src === SELF ? onSyncClick : undefined}
                    highlight={highlight && i === syncSheetIndex ? highlight : null}
                    onReveal={() => { restoreScroll.current = null; }}
                    searchMatches={searchByPage.get(i + 1)}
                    searchScrollNonce={currentPage === i + 1 ? searchScrollNonce : 0}
                    // Only pages of the file itself carry a link layer for now:
                    // a merged-in page's GoTo destinations point into ITS
                    // document, and following one into this arrangement would
                    // land on whatever happens to sit at that page number here.
                    onLink={ref.src === SELF ? onPdfLink : undefined}
                    destMark={destMark && destMark.index === i ? destMark : null}
                    marks={ref.marks}
                    notes={ref.notes}
                    fileNotes={fileNotes.get(noteKey(ref))}
                    noteAuthor={noteAuthor}
                    noteFocus={noteFocus && noteFocus.entryId === ref.id ? noteFocus : null}
                    noteAutosave={autosaveNotes}
                    onNeedNotes={() => ensureNotes([ref])}
                    onNoteAdd={(note, baseline) => addPdfNote(ref.id, note, baseline)}
                    onNoteUpdate={(noteId, patch, baseline) =>
                      updatePdfNote(ref.id, noteId, patch, baseline)
                    }
                    onNoteDelete={(noteId, baseline) => deletePdfNote(ref.id, noteId, baseline)}
                    redacting={redacting}
                    hiddenHighlights={hiddenHl.get(noteKey(ref)) ?? ""}
                    selBar={
                      sel && sel.focusIndex === i
                        ? {
                            x: sel.barX,
                            y: sel.barY,
                            lineHeight:
                              sel.pages.find((pp) => pp.index === i)?.quads[0]?.h ?? 12,
                            copyOn: copyOnSelect,
                            copied: copiedNow,
                            onHighlight: (c) => highlightSelection(c, false),
                            onRemark: () => highlightSelection(HIGHLIGHT_COLORS[0], true),
                            onToggleCopy: () => setCopyOnSelectPersisted(!copyOnSelect),
                          }
                        : null
                    }
                    textItems={snap ? pageText?.[i] : undefined}
                    onRedactAdd={(rect) => addRedactMark(ref.id, rect)}
                    onRedactRemove={(markId) => removeRedactMark(ref.id, markId)}
                    markup={marking ? markup.edit : null}
                    questionPins={
                      marking && markup.panel && ref.src === SELF && questionPins.has(i + 1)
                        ? { pins: questionPins.get(i + 1)!, focus: markup.questions.focus, onPick: pickQuestionPin }
                        : null
                    }
                    tickBadges={
                      marking && markup.panel && ref.src === SELF && tickBadges.has(i + 1)
                        ? { badges: tickBadges.get(i + 1)!, disabled: markup.sending, onApprove: (marks) => approveTick(i + 1, marks) }
                        : null
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
        {findOpen && markerTops.length > 0 && (
          <div className="file-viewer-pdf-search-rail" aria-hidden="true">
            {markerTops.map((m, i) => (
              <div
                key={i}
                className={`file-viewer-pdf-search-tick${m.current ? " current" : ""}`}
                style={{ top: m.top }}
              />
            ))}
          </div>
        )}
        {marking && markup.panel && (
          <PdfMarkupAgentPanel markup={markup} pinned={pinnedQuestions} onReload={reloadUnderMarks} />
        )}
        {marking && doc && (
          <PdfMarkupDock markup={markup} page={visiblePage} area={scrollRef} />
        )}
      </div>
      {linkConfirm && (
        <PdfLinkConfirmDialog
          url={linkConfirm}
          onOpen={() => openPdfLink(linkConfirm)}
          onClose={() => setLinkConfirm(null)}
        />
      )}
      {pickerOpen && (
        // Deliberately the project-scoped picker rather than an OS file dialog: the
        // backend confines every read to the scope's tree, so a path from outside it
        // would be refused anyway — better to only offer what can actually be read.
        <ContextFilePicker
          projectDir={pdfProjectDir}
          roots={pdfPickerRoots ?? undefined}
          attached={[]}
          onPick={(rel, dir) => {
            const base = dir ?? pdfProjectDir;
            const abs = `${base}/${rel}`;
            if (!/\.pdf$/i.test(abs)) {
              setEditError(t("pdfViewer.notAPdf", { name: basename(abs) }));
              return;
            }
            setPickerOpen(false);
            void mergePdf(abs);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

export function PdfView({
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
  // Sleep (§4.3): a tab hidden for `PDF_DOC_RELEASE_MS` unmounts its canvas —
  // whose own teardown destroys the documents and ends the worker — and mounts
  // it afresh on show, where the first load restores the persisted position
  // (`viewPos.initial`, seeded from the §3.1 stage before the store). Never
  // with unsaved work in the canvas, while a build is rewriting the file (its
  // reload request would find no viewer), or for a tab a popout shows (the
  // popout's writes land on this tab's payload; its pane here is the mirror).
  const paneVisible = usePaneVisible();
  const [held, setHeld] = useState(false);
  const compiling = usePdfSyncStore((s) => (s.compilingByPath[path] ?? 0) > 0);
  // A TeX workspace's PDF pane (`<tab>#<path>`) is mirrored with its tab.
  const mirrored = useTabsStore(
    (s) => tabKey != null && isTabInPopout(s, splitSubPaneKey(tabKey)?.tab ?? tabKey),
  );
  const asleep = useSleepWhenHidden({
    hidden: !paneVisible,
    afterMs: PDF_DOC_RELEASE_MS,
    hold: held || compiling || mirrored,
  });
  // The same holds keep a sleepable pane around this viewer awake (§5.3): the
  // pane's sleep unmounts this whole component, canvas and marks with it.
  usePaneSleepHold(held || compiling);
  // No ViewerHeader: the tab already shows the file name, so a filename row would
  // be redundant. The "Open externally" action lives in the PdfCanvas toolbar.
  return (
    <div className="file-viewer">
      <div className="file-viewer-body">
        {asleep ? (
          <div className="file-viewer-pdf-host file-viewer-sleeping" data-sleeping="pdf" />
        ) : (
          <PdfCanvas
            path={path}
            onOpenExternally={onOpenExternally}
            tabKey={tabKey}
            groupId={groupId}
            onHoldChange={setHeld}
          />
        )}
      </div>
    </div>
  );
}
