import { useSearchText } from "./useSearchText";
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
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePdfSyncStore } from "../../../stores/viewers/pdfSync";
import { useScrollSync } from "../../../stores/viewers/scrollSync";
import { usePdfMarkupLink } from "../../../stores/viewers/markupLinks";
import {
  useFileScope,
  useFileSource,
  usePaneVisible,
  readFileBytes,
  readFileText,
  writeFileBytes,
  fileMtime,
  describeFileErrorKey,
} from "../fileAccess";
import { useExperimental } from "../../../lib/experimental";
import { emptyDeck } from "../../../lib/viewers/deck/model";
import { deckPathForPdf, serializeDeck } from "../../../lib/viewers/deck/sidecar";
import { jumpToSource, SaveButton, useViewerState } from "../FileViewerPane";
import { canRecompileTexSource, recompileTexSource } from "../openTexWorkspace";
import {
  renderPdfPagesToImages,
  printHtmlBody,
  PDF_PRINT_CSS,
  type NativePrint,
} from "../../../lib/viewers/print";
import {
  SELF,
  initialPages,
  keepPageIds,
  insertPages,
  deletePages,
  pagesOf,
  isPristine,
  isPristineExceptNotes,
  type PageList,
  type PageRef,
  type RedactRect,
  type PdfNote,
  type PdfQuad,
} from "../../../lib/viewers/pageModel";
import {
  newNoteId,
  toPdfDate,
  addNote,
  updateNote,
  removeNote,
  noteCount,
  notedSheetCount,
  placedNotes,
  stepNote,
  isHighlight,
  quadsAnchor,
  type PlacedNote,
} from "../../../lib/viewers/pdfNotes";
import { fingerprintPage, samePage, type PageFingerprint } from "./pageFingerprint";
import {
  rectFromDrag,
  isDraggedFar,
  snapToText,
  addMark,
  removeMark,
  clearMarks,
  markMatches,
  markCount,
  markedSheetCount,
  type Rect,
} from "../../../lib/viewers/redact";
import {
  openSource,
  sourceBytes,
  newSourceId,
  buildPdf,
  readPdfMetadata,
  REDACT_DEFAULT_DPI,
  type PdfSources,
  type PdfMetadata,
} from "./pdfDoc";
import {
  loadOutline,
  detectHeadings,
  flattenOutline,
  outlineIsNavigable,
  type OutlineNode,
  type HeadingRun,
  type PdfDest,
} from "./outline";
import { loadPageLinks, destTopInBigPoints, type PdfLink } from "./links";
import { pageTextItemBoxes } from "./pageText";
import { HIGHLIGHT_COLORS, loadPageNotes } from "./notes";
import {
  PdfNoteLayer,
  type NoteMenuState,
  type NoteEditState,
} from "./PdfNoteLayer";
import { PdfNotesPane } from "./PdfNotesPane";
import { PdfTextLayer } from "./PdfTextLayer";
import { PdfSelectionBar, selectionBarPos } from "./PdfSelectionBar";
import { readViewerSelection, type ViewerSelection } from "./selection";
import { scrollIntoPdfBox } from "./scrollBox";
import { PdfLinkConfirmDialog } from "./PdfLinkDialog";
import { PdfMarkupLayer } from "./PdfMarkupLayer";
import { PdfMarkupBar } from "./PdfMarkupBar";
import { PdfMarkupQuestions, PdfQuestionPins, pinKey, useQuestionPins } from "./PdfMarkupQuestions";
import { PdfTickBadges, tickBadgesByPage, type TickBadge } from "./PdfMarkupTicks";
import { usePdfMarkup, type MarkupEdit, type QuestionFocus } from "./usePdfMarkup";
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
import {
  type PdfPresentReady,
  type PdfPresentSeed,
  PDF_PRESENT_READY,
  pdfPresentLabel,
  pdfPresentSeedEvent,
} from "./present";
import { openRoutedUri } from "../../../lib/linkTarget";
import {
  SCREENSHOT_CAPTURE_EVENT,
  screenshotFilename,
  type ScreenshotCaptureDetail,
} from "../../../lib/window/screenshot";
import { printPdfNative } from "../../../lib/window/printing";
import { layoutPrintPdf } from "../../../lib/viewers/pdfPrintLayout";
import { useSettingsStore } from "../../../stores/settings";
import { PageStrip } from "../../common/PageStrip";
import { PrinterIcon } from "../../common/PrinterIcon";
import { UntestedTag } from "../../common/UntestedTag";
import { subscribePageDragActive, type PageTransfer } from "../../../stores/drag/pdfDrag";
import { ContextFilePicker } from "../ContextFilePicker";
import { useProjectsStore } from "../../../stores/projects";
import { useScreenshotPendingStore } from "../../../stores/screenshotPending";
import { BOX_SCOPE_PREFIX, boxMembersOfScope, boxScopeId, useBoxesStore } from "../../../stores/boxes";
import { resolveProjectDirectory } from "../../../types";
import { basename, dirname, isPathWithin } from "../../../lib/paths";
import {
  pdfPageMatches,
  pdfPointToBigPoints,
  bigPointsToCssRect,
  synctexEdit,
  synctexStatus,
  syncNoticeKind,
  resolveTexRoot,
  refineToWord,
  type SyncNoticeKind,
  type SyncRect,
  type SyncSource,
  type TextItemBox,
  type CaretPhrase,
} from "../../../lib/viewers/tex/tex";
import { useT, type TranslationKey } from "../../../lib/i18n";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { pdfRasterRatio } from "./raster";
import { PdfWorkerSlot } from "../../../lib/viewers/pdfLoad";
import { useUnsavedWork } from "../../../lib/window/unsavedWork";
import { ArrowUpRightIcon, CommentIcon, PlayIcon, SearchIcon, TagIcon } from "../../common/icons/Icon";

/** How often the open PDF re-checks its file's mtime for an on-disk change (a
 *  LaTeX recompile rewrites the very bytes this tab is showing). Mirrors the
 *  other viewers' poll interval. */
const RELOAD_POLL_MS = 1500;

/** A recompile rewrites the PDF in place, so a reload can catch the file
 *  mid-write and pdf.js throws `InvalidPDFException: Invalid PDF structure` on
 *  the truncated bytes. That is transient — the write finishes in well under a
 *  second — so a failed parse is retried a few times before it counts as a real
 *  error, at this spacing, while the last good document stays on screen. */
const RELOAD_RETRY_MS = 250;
const RELOAD_MAX_RETRIES = 12;

/** How long after the last remark edit the file is written, when autosaving remarks
 *  is on (#pdf-notes). Long enough that writing a sentence, correcting it and moving
 *  its marker is one write rather than three; short enough that a reader who closes
 *  the tab straight after typing does not lose the remark. */
const NOTE_AUTOSAVE_MS = 1200;

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

const PDF_MIN_SCALE = 0.1;
const PDF_MAX_SCALE = 8;
const PDF_ZOOM_STEP = 1.2;
const clampPdfScale = (s: number) => Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, s));

/** Is the key going to somewhere that types? The host div wraps the find bar, the
 *  go-to-page box and every remark card, so the page-stepping arrow keys have to
 *  leave the caret alone wherever one of those has focus. */
const isTextEntry = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
};

/**
 * How a reopened PDF should start: the zoom to seed, and whether that zoom is the
 * fit-to-width baseline (so the pane's width, not the saved number, has the last
 * word).
 *
 * The viewer persists its scale on EVERY change, so most saved values are not a
 * zoom the reader chose — they are whatever fit the pane the document was last
 * read in. Restoring one of those as a deliberate zoom is how a PDF came back
 * badly rescaled after a restart: a pane even slightly narrower than last time
 * left the pages overflowing it, and treating the value as manual also disabled
 * the re-fit that would have corrected it, so it stayed wrong for the session.
 *
 * `pdfFitted === false` is the only evidence of a deliberate zoom. State written
 * before the flag existed has none, so it re-fits.
 */
export function restoredPdfZoom(
  init: { scale?: number; pdfFitted?: boolean } | undefined,
): { scale: number; fitted: boolean } {
  return {
    // 1.2 is only the pre-load placeholder; the load effect fits or restores.
    scale: init?.scale != null ? clampPdfScale(init.scale) : 1.2,
    fitted: init?.pdfFitted !== false,
  };
}

/**
 * A pending scroll-restore target re-expressed at a new zoom. A saved offset is
 * CSS pixels at the scale of the session that wrote it, so when the initial fit
 * lands on a different zoom the target has to move with it — otherwise restoring
 * a re-fitted document drops the reader at the wrong part of it.
 */
export function rescaleScrollTarget(
  target: { top: number; left: number },
  from: number,
  to: number,
): { top: number; left: number } {
  if (!(from > 0) || !(to > 0)) return target;
  const ratio = to / from;
  return { top: target.top * ratio, left: target.left * ratio };
}

/**
 * A restore target may only time out while the reader is actually on screen.
 * Hidden tabs have no scrollable layout (`display:none`), so their scrollTop is
 * clamped to zero no matter how complete the PDF is. TeX-linked PDFs commonly
 * restart behind their editor tab; expiring the target there turns a valid saved
 * position into a jump to the top before the reader has even opened the tab.
 */
export function shouldArmPdfRestoreDeadline(
  paneVisible: boolean,
  target: { top: number; left: number } | null,
): boolean {
  return paneVisible && target != null;
}

/** The eight standard `/Info` field names, bound to their wording (#pdf-meta). A
 *  map rather than a derived key, because these are the only names in the dict that
 *  belong to the format: everything else is the producer's own invention, and the
 *  lookup missing is how the panel knows to print the raw name instead. */
const META_FIELD_KEYS: Record<string, TranslationKey> = {
  Title: "pdfMeta.field.Title",
  Author: "pdfMeta.field.Author",
  Subject: "pdfMeta.field.Subject",
  Keywords: "pdfMeta.field.Keywords",
  Creator: "pdfMeta.field.Creator",
  Producer: "pdfMeta.field.Producer",
  CreationDate: "pdfMeta.field.CreationDate",
  ModDate: "pdfMeta.field.ModDate",
};

/**
 * How every page in this viewer is rendered, thumbnails and rasters included.
 *
 * `ENABLE_STORAGE` rather than the default, for exactly one thing: a highlight the
 * viewer has read out of the file is drawn by the viewer itself — as boxes that can be
 * clicked, recoloured, remarked on and deleted — so the page render must stop painting
 * the file's own copy underneath, or every marked sentence would wear two washes of
 * colour and the top one would be inert. pdf.js's annotation storage is the supported
 * way to say so (`{ noView: true }` keyed by the annotation's id, honoured by
 * `mustBeViewed` in the worker), and this mode is what makes the worker read it.
 *
 * Nothing else in the storage is ever written, so for a document with no highlights
 * this is the default mode with an extra empty map.
 */
const ANNOT_MODE = pdfjs.AnnotationMode.ENABLE_STORAGE;

/** Height in CSS px of a page rail thumbnail. The width follows the page's aspect. */
const RAIL_THUMB_H = 96;

// Distinguishes two viewers showing the SAME file (a split view), which would
// otherwise collide on a tabKey/path-derived strip id.
let stripSeq = 0;
const nextStripId = () => ++stripSeq;

/**
 * One page rail thumbnail.
 *
 * Rendered LAZILY: a rail over a 500-page document would otherwise rasterise 500
 * pages the moment it opens. An IntersectionObserver paints each thumbnail only once
 * it is near the visible part of the rail, and the card reserves its box beforehand
 * so the rail's scroll height is right from the start.
 */
export function PdfThumb({
  doc,
  page,
  rot,
  marks,
}: {
  doc?: PDFDocumentProxy;
  page: number;
  rot: number;
  /** Pending blackouts on this sheet (#pdf-redact) — painted onto the thumbnail so
   *  the rail shows the same page the reader does. */
  marks?: readonly RedactRect[];
}) {
  const visible = usePaneVisible();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true); // no observer (tests/jsdom): just render
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        setNear(entries.some((e) => e.isIntersecting));
      },
      { root: null, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !near || !doc) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      let p;
      try {
        p = await doc.getPage(page);
      } catch {
        // A page tree the compiler has not finished writing ("Page dictionary kid
        // reference points to wrong type of object"): the next mtime poll brings
        // the finished file, and an unpainted thumbnail is the right face for now.
        return;
      }
      if (cancelled) return;
      const rotation = (((p.rotate + rot) % 360) + 360) % 360;
      const base = p.getViewport({ scale: 1, rotation });
      const viewport = p.getViewport({
        scale: RAIL_THUMB_H / (base.height || 1),
        rotation,
      });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      // `ANNOT_MODE`, like every other render in this viewer. Without it pdf.js
      // defaults to `ENABLE`, which ignores the `{noView: true}` suppression the
      // storage carries for a highlight the viewer has taken over — so the rail
      // painted the file's own copy UNDER ours and showed a marked sentence at
      // double strength beside a page showing it once.
      task = p.render({ canvas, canvasContext: ctx, viewport, annotationMode: ANNOT_MODE });
      try {
        await task.promise;
      } catch {
        /* superseded by a newer render — ignore */
      }
      // Hand the page back on EVERY path, not just the painted one. A superseded
      // render — a fast rail scroll, a recompile swapping the document, `marks`
      // changing, the rail closing — rejects above, and the old `painted &&`
      // guard then skipped the cleanup and left that page holding every image it
      // had decoded. That is the same ~660 MB / 4.7 GB leak the comment below
      // describes, on the one branch it did not cover.
      {
        // Hand the page's parse back now that the thumbnail has its pixels. A
        // render decodes every image on the page at full size and caches the
        // bitmaps on the page object until something asks for them back — and
        // for the rail nothing ever did, so a thumbnailed deck kept every page's
        // decoded images alive for the document's whole life: measured at
        // ~660 MB for a 57-page talk with 97 megapixel-plus figures, re-paid on
        // every recompile (a fresh document, the rail repainting each page).
        // That is what a popout showing such a deck was at 4.7 GB of (2026-09-01).
        // A page the main view is rendering right now is left alone by pdf.js
        // (the cleanup is refused and retried once that render completes) — it
        // then re-decodes on its next repaint, a one-time cost, since the rail
        // paints each thumbnail once.
        p.cleanup();
      }
      if (cancelled || !marks?.length) return;
      ctx.fillStyle = "#000000";
      for (const m of marks) {
        ctx.fillRect(
          m.x * viewport.scale,
          m.y * viewport.scale,
          m.w * viewport.scale,
          m.h * viewport.scale,
        );
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, page, rot, marks, visible]);

  // pdf.js has ALREADY painted this canvas at the sheet's rotation, so the card must
  // not turn it again in CSS — that is why the strip's rotate transform is scoped to
  // `img` (which the print strip needs, its thumbnails being flat page images).
  return <canvas ref={canvasRef} className="page-strip-canvas" />;
}

/** One PDF page rendered to a canvas at `scale` (× devicePixelRatio for
 *  crispness). Re-renders when the page or scale changes; cancels an in-flight
 *  render on cleanup so rapid zooming doesn't paint stale frames. */
function PdfPageCanvas({
  doc,
  pageNumber,
  rot = 0,
  scale,
  cssSize,
  onSyncClick,
  syncArmed,
  highlight,
  onReveal,
  searchMatches,
  searchScrollNonce,
  onLink,
  destMark,
  marks,
  notes,
  fileNotes,
  noteAuthor,
  noteFocus,
  noteAutosave,
  redacting,
  copySelecting,
  hiddenHighlights = "",
  selBar,
  textItems,
  onRedactAdd,
  onRedactRemove,
  onNeedNotes,
  onNoteAdd,
  onNoteUpdate,
  onNoteDelete,
  onCopySelection,
  markup,
  questionPins,
  tickBadges,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** The turn the viewer has applied to this sheet, on top of the page's own
   *  `/Rotate`. pdf.js takes the TOTAL rotation, so the two are added. */
  rot?: number;
  scale: number;
  /** This page's intrinsic (scale-1) CSS dimensions, if known. Used to RESERVE
   *  the canvas's on-screen size immediately — before its async render fills
   *  pixels — so the page stack reaches its true scroll height right away. Without
   *  this the canvas defaults to ~150px until rendered, so the container height
   *  grows page-by-page and a deep restored scroll position is unreachable until
   *  every page above it has rendered (#viewerpos PDF restore). */
  cssSize?: { w: number; h: number };
  /** SyncTeX reverse search: a click maps to big points on this page. */
  onSyncClick?: (page: number, xBp: number, yBp: number) => void;
  /** True while Ctrl/⌘ is held, so the page shows the reverse-search cursor. */
  syncArmed?: boolean;
  /** SyncTeX forward search: when this page is the target, the box (big points)
   *  to scroll into view and flash. `nonce` re-triggers a repeat reveal.
   *  `phrase`, when set, narrows the box to the clicked word via the page's text
   *  content (using the surrounding words to disambiguate). */
  highlight?: { rect: SyncRect; nonce: number; phrase?: CaretPhrase } | null;
  /** Explicit navigation supersedes a same-path reload's scroll restoration. */
  onReveal?: () => void;
  /** Ctrl+F search hits on THIS page: each match is its constituent boxes (big
   *  points), and `current` marks the one the find bar is parked on (#71).
   *  Painted as translucent overlays over the canvas. */
  searchMatches?: { rects: SyncRect[]; current: boolean }[];
  /** Bumped when the current search match lands on this page, so the current
   *  match's box scrolls into view (mirrors the SyncTeX reveal). */
  searchScrollNonce?: number;
  /** A link on this page was clicked (#pdf-links). Without a handler the page
   *  carries no link layer at all — the rule the rest of this viewer follows for
   *  an action its host cannot honour. */
  onLink?: (link: PdfLink) => void;
  /** A band marking where an internal link just landed, in big points from the
   *  page top; `nonce` re-triggers the fade for a repeat jump to the same spot. */
  destMark?: { top: number; nonce: number } | null;
  /** Areas already marked for blacking out on this sheet (#pdf-redact), in big
   *  points. Drawn solid black whether or not the tool is armed: a mark is what the
   *  saved page will look like, and showing it only in an editing mode would hide
   *  from the reader exactly what is about to be destroyed. */
  marks?: readonly RedactRect[];
  /** The sheet's remarks (#pdf-notes) — sticky notes and highlights alike — where the
   *  arrangement has taken them over. Absent means the file's own are shown, read
   *  lazily here — which is also the BASELINE every edit is applied to, so the first
   *  remark on a page adopts the ones already in the document rather than replacing
   *  them. */
  notes?: readonly PdfNote[];
  /** The file's own remarks on this sheet, as read from its annotations — the
   *  BASELINE every edit adopts. Owned by the viewer rather than read here, because
   *  the remarks panel lists sheets this canvas has never painted and a second read
   *  would mint a second set of ids for the same comments; `undefined` means "not
   *  read yet", which is what withholds the placing action. */
  fileNotes?: readonly PdfNote[];
  /** The name a new remark is signed with (the viewer remembers the last one). */
  noteAuthor?: string;
  /** The remark the panel is walking through, when it is on this sheet: scrolled to
   *  and flashed, and opened for editing when `edit` is set. */
  noteFocus?: { noteId: string; x: number; y: number; nonce: number; edit: boolean } | null;
  /** Remarks are written into the file as they are made — said in the card. */
  noteAutosave?: boolean;
  /** A remark was written on this sheet. `baseline` is the file's own set, so the
   *  handler can adopt it; without a handler the page carries no remark layer at all,
   *  the rule the link layer follows. */
  onNoteAdd?: (note: PdfNote, baseline: readonly PdfNote[]) => void;
  onNoteUpdate?: (
    noteId: string,
    patch: Partial<Omit<PdfNote, "id">>,
    baseline: readonly PdfNote[],
  ) => void;
  onNoteDelete?: (noteId: string, baseline: readonly PdfNote[]) => void;
  /** This sheet is near the viewport and its remarks are wanted. Called instead of
   *  reading them here, so one owner holds one set of ids for one page. */
  onNeedNotes?: () => void;
  /** The blackout tool is armed: a drag over the page marks an area. */
  redacting?: boolean;
  /** The region-capture mode is armed (by the global Screenshot app): a drag
   *  copies that page region as a PNG. */
  copySelecting?: boolean;
  /** The ids of the file's own highlight annotations on this sheet that the viewer
   *  is drawing itself, joined — so the canvas repaints when the set changes. The
   *  suppression itself is a write into the document's annotation storage, made once
   *  by the viewer when a page's remarks are read; this is only what tells the page
   *  that its pixels are out of date because of it. */
  hiddenHighlights?: string;
  /** The bar over a selection on THIS sheet (#pdf-textselect): where it goes, and
   *  what its buttons do. Absent on every sheet the selection did not end on. */
  selBar?: {
    x: number;
    y: number;
    /** The height of the line it hangs off, so it can flip below at the page top. */
    lineHeight: number;
    /** Selecting text copies it by itself; and it just did, for this selection. */
    copyOn: boolean;
    copied: boolean;
    onHighlight: (color: readonly [number, number, number]) => void;
    onRemark: () => void;
    onToggleCopy: () => void;
  } | null;
  /** This page's text runs (big points), so a drag can be snapped out to whole
   *  words. Absent = mark exactly what was dragged. */
  textItems?: readonly TextItemBox[];
  /** A drag finished: `rect` is in big points, already snapped. */
  onRedactAdd?: (rect: Rect) => void;
  /** A mark was clicked while the tool is armed. */
  onRedactRemove?: (markId: string) => void;
  /** A selected page region has been rasterised into a PNG. */
  onCopySelection?: (png: Uint8Array) => void;
  /** Markup mode is on (`usePdfMarkup`): the page carries the markup layer over
   *  everything else, and its remarks take no pointer meanwhile. Only ever set on
   *  a pristine arrangement, where this sheet is the file's page `pageNumber`. */
  markup?: MarkupEdit | null;
  /** The agent's markup questions pinned to this sheet (`PdfMarkupQuestions`),
   *  over the markup layer: a click shows the question in the card. */
  questionPins?: {
    pins: readonly QuestionPin[];
    focus: QuestionFocus | null;
    onPick: (pin: QuestionPin) => void;
  } | null;
  /** The agent's ticks on this sheet's sent marks (`PdfMarkupTicks`), over the
   *  markup layer: a click approves and removes that mark. */
  tickBadges?: {
    badges: readonly TickBadge[];
    disabled: boolean;
    onApprove: (index: number, mark: TickBadge["mark"]) => void;
  } | null;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchCurrentRef = useRef<HTMLDivElement>(null);
  // A SyncTeX box narrowed to the clicked word (when `highlight.phrase` is set and
  // found in this page's text), else null → the original line box is used.
  const [refined, setRefined] = useState<SyncRect | null>(null);
  // A transient marker at the point the user reverse-search-clicked (CSS px within
  // the page wrapper), giving the jump visible feedback on the PDF side; it
  // auto-clears after ~2s. `nonce` re-triggers the fade for a repeat click on the
  // same spot. See `onClick`.
  const [clickMark, setClickMark] = useState<{ left: number; top: number; nonce: number } | null>(null);
  const clickTimer = useRef<number | null>(null);
  useEffect(() => () => { if (clickTimer.current != null) window.clearTimeout(clickTimer.current); }, []);

  // Rasterise LAZILY, the way the page rail's PdfThumb already does. Every page
  // is MOUNTED (so search/scroll-restore/syncTeX can address any of them), but a
  // full-resolution page canvas is several MB of backing store — painting all of
  // a 300-page document at once holds gigabytes and hands the compositor hundreds
  // of large layers to juggle on every scroll frame, which is the scroll jank
  // (and the renderer-memory blowup). An IntersectionObserver paints each page
  // only while it is near the viewport; the wrapper's box stays reserved by
  // `cssSize`, so scroll height, search scroll-into-view and link jumps are
  // unaffected. In jsdom (tests) there is no observer, so it renders eagerly as
  // before.
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      // A generous margin paints a page a screenful or two before it scrolls into
      // view (no blank flash in normal scrolling) and drops it once well past.
      { root: null, rootMargin: "150% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // What is currently ON this canvas: the fingerprint of the content it was
  // painted from, and the geometry it was painted at. A recompile hands the
  // viewer a brand-new document object for the same file, which re-ran this
  // effect for every mounted page — so a build that changed one sentence
  // repainted the whole document, and the reader saw the page blink. With this,
  // a page whose drawing instructions are unchanged at the same size keeps the
  // pixels it already has and the effect does nothing at all.
  const painted = useRef<{
    fp: PageFingerprint | null;
    scale: number;
    rot: number;
    dpr: number;
    /** Which of the file's own highlights were suppressed when these pixels were
     *  painted. Part of the record for the fingerprint's reason: a page that keeps
     *  its pixels because nothing it *draws* changed would otherwise keep painting a
     *  highlight the viewer has since taken over and is now drawing itself. */
    hidden: string;
  } | null>(null);

  useEffect(() => {
    // Scrolled well away: release the backing store (keeping the reserved CSS
    // box) so a long document holds only the pages around the viewport. Repainted
    // on return — and the record of what is painted goes with the pixels, or the
    // page would come back blank and be told it is already up to date.
    if (!near) {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0) {
        canvas.width = 0;
        canvas.height = 0;
      }
      painted.current = null;
      // Give the page's own parse back too, not only its pixels. pdf.js caches what
      // it built to draw a page — the decoded images above all — on the page object,
      // and that cache is what a document made of scanned or figure-heavy pages
      // really costs: dropping the canvas alone left a 130 MB thesis growing by
      // every page ever scrolled past, since nothing here ever asked for it back.
      // `cleanup()` keeps the page itself (so returning to it re-renders from the
      // file rather than reloading the document) and refuses while a render is in
      // flight, which is exactly the case this must not disturb.
      void doc.getPage(pageNumber).then((p) => p.cleanup()).catch(() => {});
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      let page;
      try {
        page = await doc.getPage(pageNumber);
      } catch {
        // Mid-compile read (see PdfThumb): keep the old pixels, the next reload
        // paints the real page. This was an unhandled rejection per page per build.
        return;
      }
      if (cancelled) return;
      const rotation = (((page.rotate + rot) % 360) + 360) % 360;
      // The screen's pixel ratio, capped so one page canvas stays within
      // `PDF_MAX_CANVAS_PIXELS` at high zoom or on a poster-sized page (see
      // `raster.ts`); the canvas is still laid out at its full CSS size.
      const cssBox = page.getViewport({ scale, rotation });
      const dpr = pdfRasterRatio(cssBox.width, cssBox.height, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: scale * dpr, rotation });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);
      const prev = painted.current;
      const sameGeometry =
        prev != null &&
        canvas.width === w &&
        canvas.height === h &&
        prev.scale === scale &&
        prev.rot === rot &&
        prev.dpr === dpr &&
        prev.hidden === hiddenHighlights;
      // Only ask what the page draws when the pixels could actually be reused —
      // a zoom or a turn has to repaint whatever the answer would be.
      const fp = sameGeometry ? await fingerprintPage(page, rot) : null;
      if (cancelled) return;
      if (sameGeometry && samePage(fp, prev.fp)) {
        // Already on screen, at this size, drawing this. Nothing to do — which is
        // the whole point: no clear, no repaint, no flash.
        //
        // Except to hand back what the comparison cost: `getOperatorList()` is the
        // parse half of a render, and it decoded every image on this page into the
        // NEW document's page object on the way to its answer. Nothing will ever
        // paint from that parse — the pixels it matches are already on the canvas
        // — so without this every recompile of an unchanged deck left the fresh
        // document holding the decoded images of every page near the viewport,
        // for the life of that document. (Refused while a render is in flight,
        // which cannot be this effect's — it has not started one.)
        page.cleanup();
        return;
      }
      // From here the canvas is going to change, and any interruption (a zoom
      // mid-render, an unmount, a second build) leaves it holding something no
      // record describes — so give up the record first and re-earn it on success.
      // A missing record only ever costs one extra repaint; a wrong one would
      // skip a page the reader needs to see.
      painted.current = null;
      // Paint OFF SCREEN and swap the finished image in. Rendering straight onto
      // the visible canvas means sizing it first, and sizing a canvas clears it —
      // so the page went blank for however long the render took (a whole second
      // on a dense page) on every zoom step and every build. jsdom has no 2D
      // context to render into, so tests keep the direct path.
      const off = typeof document !== "undefined" ? document.createElement("canvas") : null;
      const offCtx = off ? off.getContext("2d") : null;
      if (off && offCtx) {
        off.width = w;
        off.height = h;
        task = page.render({ canvas: off, canvasContext: offCtx, viewport, annotationMode: ANNOT_MODE });
        try {
          await task.promise;
        } catch {
          /* render cancelled by a newer scale — leave the old pixels up */
          off.width = 0;
          off.height = 0;
          return;
        }
        if (cancelled) {
          off.width = 0;
          off.height = 0;
          return;
        }
        // One synchronous block: resize (which clears) and blit, so the compositor
        // never gets a frame of the cleared canvas.
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        ctx.drawImage(off, 0, 0);
        off.width = 0;
        off.height = 0;
      } else {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        task = page.render({ canvas, canvasContext: ctx, viewport, annotationMode: ANNOT_MODE });
        try {
          await task.promise;
        } catch {
          /* render cancelled by a newer scale — ignore */
          return;
        }
        if (cancelled) return;
      }
      // Record what is up there. The fingerprint is taken from the page that was
      // just painted, so the next document's page is compared against what the
      // reader is actually looking at.
      const finalFp = fp ?? (await fingerprintPage(page, rot));
      if (cancelled) return;
      painted.current = { fp: finalFp, scale, rot, dpr, hidden: hiddenHighlights };
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, rot, scale, near, hiddenHighlights]);

  // The page's own hyperlinks (#pdf-links). Keyed off the sheet and its turn but
  // NOT off `scale` — the boxes are stored in big points and multiplied into CSS
  // pixels at render, exactly as the search hits are, so zooming never re-reads
  // the annotations.
  const [links, setLinks] = useState<PdfLink[]>([]);
  useEffect(() => {
    // Gated on `near` for the render effect's reason: reading every page's
    // annotations on load is wasted work, and a link can't be clicked on a page
    // that isn't near the viewport anyway.
    if (!onLink || !near) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    setLinks([]);
    void loadPageLinks(doc, pageNumber, rot).then((ls) => {
      if (!cancelled) setLinks(ls);
    });
    return () => {
      cancelled = true;
    };
    // `onLink` is only read for its presence; a caller re-creating it must not
    // re-read every page's annotations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageNumber, rot, onLink == null, near]);

  // The page's own remarks (#pdf-notes) — the `/Text` annotations any PDF reader
  // shows as sticky notes. ASKED FOR here, read by the viewer: one owner mints one
  // set of remark ids per sheet, which is what lets the remarks panel address the
  // same comment this page is drawing. (A second read here would produce a second
  // set of ids for the same annotations, and the panel's "go to this one" would
  // then be pointing at a remark the page has never heard of.)
  //
  // The request is gated on `near` exactly as the link read is, and for the same
  // reason: reading every page's annotations at load would cost the whole document
  // on the reload of every recompile. Opening the panel asks for the rest.
  useEffect(() => {
    if (!onNoteAdd || !near) return;
    onNeedNotes?.();
    // `onNoteAdd`/`onNeedNotes` are read for their presence and identity-stable;
    // a caller re-creating one must not re-request every page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageNumber, rot, onNoteAdd == null, near]);

  /** What is shown: the arrangement's set once it has taken this sheet over, else
   *  the file's own. One list, so a marker cannot be drawn twice. */
  const shownNotes = notes ?? fileNotes ?? [];
  /** The page's own remarks have landed. Not cosmetic: that list is the BASELINE a
   *  remark is added to, so placing one before the read would adopt "this page has no
   *  remarks" and quietly delete the ones already in the file at the next save. */
  const notesReady = fileNotes != null;
  const baseline = fileNotes ?? [];
  const [noteMenu, setNoteMenu] = useState<NoteMenuState | null>(null);
  const [noteEdit, setNoteEdit] = useState<NoteEditState | null>(null);
  // Markup coming on closes a remark's menu and card: the remarks take no pointer
  // while it is on, so one left open could not be closed by the page.
  const marking = markup != null;
  useEffect(() => {
    if (!marking) return;
    setNoteMenu(null);
    setNoteEdit(null);
  }, [marking]);

  // The panel asked for a remark to be opened. Consumed by nonce, so asking twice
  // re-opens it; the scroll and the flash are the layer's own.
  useEffect(() => {
    if (noteFocus?.edit) {
      setNoteEdit({ noteId: noteFocus.noteId, x: noteFocus.x, y: noteFocus.y });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteFocus?.nonce]);

  // Narrow the SyncTeX line box to the clicked word: pull this page's text runs
  // (big points, top-left origin, at viewport scale 1) and find the word nearest
  // the line box. Best-effort — on no match (or no word) the original box stands.
  useEffect(() => {
    setRefined(null);
    const phrase = highlight?.phrase;
    if (!highlight || !phrase) return;
    let cancelled = false;
    (async () => {
      try {
        const items = await pageTextItemBoxes(doc, pageNumber);
        if (cancelled) return;
        const r = refineToWord(highlight.rect, phrase, items);
        if (!cancelled && r) setRefined(r);
      } catch {
        /* fall back to the synctex box */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  // Scroll a forward-search target into view on a new nonce. Center the
  // highlight *box*, not the whole page — on a tall page the target line can sit
  // far from page-center, which is what made the jump feel imprecise. Scoped to
  // the reader's own scroller (`scrollIntoPdfBox`): `scrollIntoView` also scrolls
  // the `overflow: hidden` pane and tab hosts above it, which is what displaced
  // the whole pane — and the fit-to-width page inside it — on a jump.
  useEffect(() => {
    if (!highlight) return;
    onReveal?.();
    const target = boxRef.current ?? wrapRef.current;
    if (target) scrollIntoPdfBox(target, "center");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  // Ctrl+F: scroll the current match into view when the find bar parks it on this
  // page (`searchScrollNonce` bumps). All pages are mounted, so the target page's
  // box is always present to scroll to.
  useEffect(() => {
    if (!searchScrollNonce) return;
    if (searchCurrentRef.current) scrollIntoPdfBox(searchCurrentRef.current, "center");
  }, [searchScrollNonce]);

  // Reverse search, by client coordinates rather than by the event's own target:
  // the link layer sits ON TOP of the canvas, so a Ctrl-click that lands on a
  // link box must still map to the same point on the page. Measuring the canvas
  // explicitly is what lets both callers share one implementation.
  const syncClickAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!onSyncClick || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { x, y } = pdfPointToBigPoints(rect, clientX, clientY, scale);
    // Mark the clicked point so the source-jump has feedback on the PDF side; the
    // canvas sits flush at the wrapper's top-left, so canvas-local offsets are
    // wrapper-local. Clear any prior marker's timer and fade out after ~2s.
    setClickMark((m) => ({
      left: clientX - rect.left,
      top: clientY - rect.top,
      nonce: (m?.nonce ?? 0) + 1,
    }));
    if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => setClickMark(null), 2000);
    onSyncClick(pageNumber, x, y);
  };

  // ── Blacking an area out (#pdf-redact) ──────────────────────────────────
  // The gesture is a plain drag over the page, tracked in big points so the box the
  // reader is drawing means the same thing at any zoom. Pointer events, not HTML5
  // DnD (WebKitGTK), with the capture taken by the layer itself — it is mounted for
  // the whole gesture, unlike the canvas underneath, which re-renders on zoom.
  const [dragBox, setDragBox] = useState<Rect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const pointInPage = (clientX: number, clientY: number) => {
    const el = wrapRef.current ?? canvasRef.current;
    const rect = el?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const onRedactDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!redacting || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = pointInPage(e.clientX, e.clientY);
    dragStart.current = start;
    setDragBox({ ...start, w: 0, h: 0 });
  };

  const onRedactMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    setDragBox(rectFromDrag(dragStart.current, pointInPage(e.clientX, e.clientY)));
  };

  // `pointercancel` commits as well as `pointerup`: on this engine a gesture can end
  // with either (the same trap the tab and card drags document), and a drag that
  // silently did nothing would leave the reader believing an area is covered. The
  // commit is safe under both — a box that was not wanted is one click away from
  // gone, and Ctrl+Z covers it too.
  const onRedactUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    dragStart.current = null;
    setDragBox(null);
    if (!start) return;
    const drawn = rectFromDrag(start, pointInPage(e.clientX, e.clientY));
    // The threshold is in CSS pixels, so "that was a click, not a drag" means the
    // same thing whether the page is at 40% or 400%.
    if (!isDraggedFar(drawn, 3 / scale)) return;
    onRedactAdd?.(textItems ? snapToText(drawn, textItems) : drawn);
  };

  // ── Select a region and copy it as an image ──────────────────────────────
  // Geometry stays in big points while dragging, just like redaction, but the
  // copied pixels come from the already-rendered page canvas. That makes the
  // clipboard image exactly as sharp as the visible page (including DPR) without
  // asking pdf.js to render a second full page for every selection.
  const [copyBox, setCopyBox] = useState<Rect | null>(null);
  const copyStart = useRef<{ x: number; y: number } | null>(null);

  const pointInCanvas = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(clientX - rect.left, 0), rect.width) / scale,
      y: Math.min(Math.max(clientY - rect.top, 0), rect.height) / scale,
    };
  };

  const selectionPng = async (selected: Rect): Promise<Uint8Array | null> => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const pxX = canvas.width / rect.width;
    const pxY = canvas.height / rect.height;
    const sx = Math.max(0, Math.floor(selected.x * scale * pxX));
    const sy = Math.max(0, Math.floor(selected.y * scale * pxY));
    const sw = Math.min(canvas.width - sx, Math.max(1, Math.ceil(selected.w * scale * pxX)));
    const sh = Math.min(canvas.height - sy, Math.max(1, Math.ceil(selected.h * scale * pxY)));
    if (sw <= 0 || sh <= 0) return null;

    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    // Pending blackouts are overlays rather than canvas pixels. Burn their
    // intersection into the clipboard crop so copying a page that visibly hides
    // sensitive text cannot reveal that text in the pasted image.
    if (marks?.length) {
      ctx.fillStyle = "#000000";
      for (const mark of marks) {
        const left = Math.max(mark.x, selected.x);
        const top = Math.max(mark.y, selected.y);
        const right = Math.min(mark.x + mark.w, selected.x + selected.w);
        const bottom = Math.min(mark.y + mark.h, selected.y + selected.h);
        if (right <= left || bottom <= top) continue;
        ctx.fillRect(
          (left - selected.x) * scale * pxX,
          (top - selected.y) * scale * pxY,
          (right - left) * scale * pxX,
          (bottom - top) * scale * pxY,
        );
      }
    }

    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };

  const onCopyDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!copySelecting || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = pointInCanvas(e.clientX, e.clientY);
    copyStart.current = start;
    setCopyBox({ ...start, w: 0, h: 0 });
  };
  const onCopyMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!copyStart.current) return;
    setCopyBox(rectFromDrag(copyStart.current, pointInCanvas(e.clientX, e.clientY)));
  };
  const onCopyUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = copyStart.current;
    copyStart.current = null;
    setCopyBox(null);
    if (!start) return;
    const selected = rectFromDrag(start, pointInCanvas(e.clientX, e.clientY));
    if (!isDraggedFar(selected, 3 / scale)) return;
    void selectionPng(selected).then((png) => {
      if (png) onCopySelection?.(png);
    });
  };

  const box = highlight ? bigPointsToCssRect(refined ?? highlight.rect, scale) : null;

  return (
    <div
      className={`file-viewer-pdf-page-wrap${marking ? " is-marking" : ""}`}
      ref={wrapRef}
      // Remarks are placed by right-clicking the page (#pdf-notes) — the gesture
      // every other PDF reader uses, and the one that needs no tool armed first. The
      // handler sits on the WRAPPER rather than on the canvas so a right-click that
      // lands on a link box, a search hit or the blackout layer still means "here on
      // the page", which is the same reasoning `syncClickAt` follows for Ctrl-click.
      // Off while marking up: the remarks are inert then.
      onContextMenu={
        onNoteAdd && !marking
          ? (e) => {
              e.preventDefault();
              const p = pointInPage(e.clientX, e.clientY);
              setNoteMenu({ clientX: e.clientX, clientY: e.clientY, x: p.x, y: p.y });
            }
          : undefined
      }
      // The text layer covers the canvas, so the canvas's own click handler never
      // fires — and reverse search is a gesture over the WHOLE page, not a property
      // of whatever happens to be on top of it. Handled here, where every layer's
      // click bubbles to; the link boxes bow out of a modified click for the same
      // reason, so it arrives exactly once however it entered.
      onClick={
        onSyncClick
          ? (e) => {
              if (e.ctrlKey || e.metaKey) syncClickAt(e.clientX, e.clientY);
            }
          : undefined
      }
    >
      <canvas
        ref={canvasRef}
        className={`file-viewer-pdf-page${onSyncClick && syncArmed ? " is-syncable" : ""}`}
        // Reserve the page's true size up-front (the async render sets the same
        // values once pixels are ready), so the stack's scroll height is correct
        // immediately and a restored scroll position is reachable on the first
        // ResizeObserver tick rather than only after every page has rendered.
        style={cssSize ? { width: cssSize.w * scale, height: cssSize.h * scale } : undefined}
      />
      {/* Selectable text (#pdf-textselect), directly over the canvas and under every
          overlay: it is the page's own words, so it belongs where the words are. It
          is up on every near page and is armed by nothing, because selecting a
          sentence in a document you are reading is not a mode — it is what a pointer
          over text does everywhere else. What used to make it one was that the layer
          takes the pointer over the whole sheet; the layers above it (links, search
          hits, markers, highlights, the blackout and copy surfaces) are stacked over
          it and keep their own clicks, which is the arrangement pdf.js's own viewer
          uses and which leaves the plain drag — the one gesture nothing else wants —
          to the text. */}
      {near && <PdfTextLayer doc={doc} pageNumber={pageNumber} rot={rot} scale={scale} />}
      {searchMatches?.map((m, mi) =>
        m.rects.map((r, ri) => {
          const css = bigPointsToCssRect(r, scale);
          // Anchor the scroll ref on the first box of the current match.
          const ref = m.current && ri === 0 ? searchCurrentRef : undefined;
          return (
            <div
              key={`s-${mi}-${ri}`}
              ref={ref}
              className={`file-viewer-pdf-search-hit${m.current ? " current" : ""}`}
              style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
            />
          );
        }),
      )}
      {/* The link layer (#pdf-links), above the canvas and below the highlights.
          Each box is a real <button>, so a link is reachable by keyboard and
          announced as an action — a bare <div> with an onClick would be neither.
          A Ctrl/⌘-click on one still performs SyncTeX reverse search rather than
          following the link: the modifier is the reverse-search gesture over the
          WHOLE page, and a `\ref` sitting where the user clicked must not steal
          it.

          The boxes are PAINTED, not invisible-until-hovered: a link nobody can
          see is a link nobody clicks, and a reader looking for the equation a
          `\ref` points at should not have to sweep the pointer across the page
          to find out that the number is one. The class carries the link's *role*
          (`ref` / `cite` / external) because that is what the colour says —
          the same three-way split `hyperref`'s own `colorlinks` makes.

          The exception is `nav`, the document's own chrome (beamer's running
          title and navigation bar), which is unpainted at rest: that argument is
          about a mark the reader cannot otherwise find, made once where the
          author wrote it, and a theme's furniture is neither — it is already
          coloured by the theme and it repeats on every sheet. Same box, same
          hover, same click; only the resting mark goes. */}
      {links.map((l) => {
        const css = bigPointsToCssRect(l.rect, scale);
        return (
          <button
            key={l.id}
            type="button"
            className={`file-viewer-pdf-link is-${l.kind}${
              l.kind === "internal" ? ` is-${l.role}` : ""
            }`}
            style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
            title={
              l.kind === "external"
                ? t("pdfLinks.externalTitle", { url: l.url })
                : t(l.role === "cite" ? "pdfLinks.citeTitle" : "pdfLinks.internalTitle", {
                    page: l.dest.page,
                  })
            }
            onClick={(e) => {
              // Ctrl/⌘ is the reverse-search gesture over the whole page, so a `\ref`
              // sitting where the reader clicked must not steal it: the click is left
              // to bubble to the wrapper, which is the one place it is answered.
              if ((e.ctrlKey || e.metaKey) && onSyncClick) return;
              onLink?.(l);
            }}
          />
        );
      })}
      {destMark && (
        <div
          key={`dest-${destMark.nonce}`}
          className="file-viewer-pdf-dest-mark"
          style={{ top: destMark.top * scale }}
          aria-hidden="true"
        />
      )}
      {box && (
        <div
          key={highlight!.nonce}
          ref={boxRef}
          className="file-viewer-pdf-sync-highlight"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
      {clickMark && (
        <div
          key={`click-${clickMark.nonce}`}
          className="file-viewer-pdf-click-mark"
          style={{ left: clickMark.left, top: clickMark.top }}
        />
      )}
      {/* The blackout surface (#pdf-redact), under the marks so an armed click on an
          existing one removes it rather than starting a drag on top of it. */}
      {redacting && (
        <div
          className="file-viewer-pdf-redact-layer"
          onPointerDown={onRedactDown}
          onPointerMove={onRedactMove}
          onPointerUp={onRedactUp}
          onPointerCancel={onRedactUp}
        >
          {dragBox && (
            <div
              className="file-viewer-pdf-redact-draft"
              style={{
                left: dragBox.x * scale,
                top: dragBox.y * scale,
                width: dragBox.w * scale,
                height: dragBox.h * scale,
              }}
            />
          )}
        </div>
      )}
      {copySelecting && (
        <div
          className="file-viewer-pdf-copy-layer"
          style={cssSize ? { width: cssSize.w * scale, height: cssSize.h * scale } : undefined}
          onPointerDown={onCopyDown}
          onPointerMove={onCopyMove}
          onPointerUp={onCopyUp}
          onPointerCancel={onCopyUp}
        >
          {copyBox && (
            <div
              className="file-viewer-pdf-copy-draft"
              style={{
                left: copyBox.x * scale,
                top: copyBox.y * scale,
                width: copyBox.w * scale,
                height: copyBox.h * scale,
              }}
            />
          )}
        </div>
      )}
      {marks?.map((m) => {
        const css = bigPointsToCssRect({ page: pageNumber, ...m }, scale);
        const style = { left: css.left, top: css.top, width: css.width, height: css.height };
        // Armed, a mark is a real <button> so it is removable by keyboard as well as
        // by pointer; otherwise it is inert paint — the page underneath must stay
        // clickable for links and reverse search.
        return redacting ? (
          <button
            key={m.id}
            type="button"
            className="file-viewer-pdf-redact-box is-armed"
            style={style}
            title={t("pdfRedact.removeMarkTitle")}
            aria-label={t("pdfRedact.removeMarkTitle")}
            onClick={() => onRedactRemove?.(m.id)}
          />
        ) : (
          <div key={m.id} className="file-viewer-pdf-redact-box" style={style} aria-hidden="true" />
        );
      })}
      {/* The remark layer (#pdf-notes), above everything else on the page: a marker
          stands for something a person wrote, so it must never end up under a link
          box or a search highlight. */}
      {onNoteAdd && (
        <PdfNoteLayer
          notes={shownNotes}
          scale={scale}
          pageWidth={cssSize?.w}
          pageHeight={cssSize?.h}
          menu={noteMenu}
          edit={noteEdit}
          focus={noteFocus}
          ready={notesReady}
          author={noteAuthor ?? ""}
          autosave={noteAutosave ?? false}
          onMenu={setNoteMenu}
          onCloseMenu={() => setNoteMenu(null)}
          onEdit={setNoteEdit}
          onDelete={(noteId) => onNoteDelete?.(noteId, baseline)}
          onRecolor={(noteId, color) =>
            onNoteUpdate?.(noteId, { color, modified: toPdfDate(new Date()) }, baseline)
          }
          onMove={(noteId, x, y) => {
            onNoteUpdate?.(noteId, { x, y, modified: toPdfDate(new Date()) }, baseline);
            // The card is anchored to the marker, so a remark moved while its card is
            // open takes the card with it rather than leaving it beside the old spot.
            setNoteEdit((cur) => (cur?.noteId === noteId ? { ...cur, x, y } : cur));
          }}
          onSave={(edit, text, author) => {
            const body = text.trim();
            if (edit.noteId) {
              // Emptying a STICKY NOTE deletes it: a marker with nothing behind it is
              // noise in every viewer that opens the file afterwards. Emptying a
              // highlight does not — the mark on the sentence is a complete thing on
              // its own, and the remark was the optional half. Deleting one is the
              // menu's own action, and has to stay that way: a reader clearing a
              // sentence they no longer agree with must not lose the mark with it.
              const held = shownNotes.find((n) => n.id === edit.noteId);
              if (!body && !(held && isHighlight(held))) {
                onNoteDelete?.(edit.noteId, baseline);
                return;
              }
              onNoteUpdate?.(
                edit.noteId,
                { text: body, ...(author ? { author } : {}), modified: toPdfDate(new Date()) },
                baseline,
              );
              return;
            }
            if (!body) return;
            const stamp = toPdfDate(new Date());
            onNoteAdd(
              {
                id: newNoteId(),
                x: edit.x,
                y: edit.y,
                text: body,
                ...(author ? { author } : {}),
                created: stamp,
                modified: stamp,
              },
              baseline,
            );
          }}
        />
      )}
      {/* The bar over a selection (#pdf-textselect), on the sheet the drag ended on.
          Above the remark layer because it is a live control over what the reader is
          doing right now, while a marker stands for something already written. */}
      {/* The markup layer (`usePdfMarkup`), over every other page layer — the
          remarks included, which it leaves visible but out of reach. */}
      {markup && cssSize && (
        <PdfMarkupLayer n={pageNumber} size={[cssSize.w, cssSize.h]} scale={scale} edit={markup} />
      )}
      {tickBadges && tickBadges.badges.length > 0 && cssSize && (
        <PdfTickBadges
          badges={tickBadges.badges}
          size={[cssSize.w, cssSize.h]}
          scale={scale}
          disabled={tickBadges.disabled}
          onApprove={tickBadges.onApprove}
        />
      )}
      {questionPins && questionPins.pins.length > 0 && (
        <PdfQuestionPins
          pins={questionPins.pins}
          scale={scale}
          focus={questionPins.focus}
          onPick={questionPins.onPick}
        />
      )}
      {selBar && !marking && (
        <PdfSelectionBar
          left={selectionBarPos(selBar.x, selBar.y, scale, selBar.lineHeight).left}
          top={selectionBarPos(selBar.x, selBar.y, scale, selBar.lineHeight).top}
          copyOn={selBar.copyOn}
          copied={selBar.copied}
          onHighlight={selBar.onHighlight}
          onRemark={selBar.onRemark}
          onToggleCopy={selBar.onToggleCopy}
        />
      )}
      <div className="file-viewer-pdf-page-gap" aria-hidden="true">
        {pageNumber} / {doc.numPages}
      </div>
    </div>
  );
}

/**
 * One row of the contents sidebar, plus its children. A node with a resolved page
 * is a jump button; one without (an unresolvable destination) is inert text. A
 * node with children carries a ▸/▾ disclosure that toggles its subtree.
 */
/** The leading sign for a leaf row, one per level: a dot for the top tiers, a
 *  dash deeper down — the disclosure caret (a triangle) stands in for it on a row
 *  that has children, so a branch reads as ▸/▾, a mid leaf as •, a deep leaf as –. */
const leafSign = (depth: number) => (depth >= 2 ? "–" : "•");

function OutlineRow({
  node,
  depth,
  collapsed,
  currentId,
  onToggle,
  onJump,
  onHover,
}: {
  node: OutlineNode;
  depth: number;
  collapsed: Set<string>;
  currentId: string | null;
  onToggle: (id: string) => void;
  onJump: (page: number) => void;
  onHover: (page: number | null, rect: DOMRect | null) => void;
}) {
  const t = useT();
  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  return (
    <>
      <div
        className={`file-viewer-pdf-outline-row${node.id === currentId ? " current" : ""}${node.page == null ? " inert" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {hasKids ? (
          <button
            className="file-viewer-pdf-outline-caret"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? t("pdfOutline.expand") : t("pdfOutline.collapse")}
            title={isCollapsed ? t("pdfOutline.expand") : t("pdfOutline.collapse")}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="file-viewer-pdf-outline-caret is-sign" aria-hidden="true">
            {leafSign(depth)}
          </span>
        )}
        <button
          className={`file-viewer-pdf-outline-title depth-${Math.min(depth, 3)}`}
          onClick={() => node.page != null && onJump(node.page)}
          onMouseEnter={(e) =>
            node.page != null && onHover(node.page, e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={() => onHover(null, null)}
          disabled={node.page == null}
          title={node.page != null ? t("pdfOutline.titlePageSuffix", { title: node.title, page: node.page }) : node.title}
        >
          {node.title}
        </button>
      </div>
      {hasKids &&
        !isCollapsed &&
        node.children.map((c) => (
          <OutlineRow
            key={c.id}
            node={c}
            depth={depth + 1}
            collapsed={collapsed}
            currentId={currentId}
            onToggle={onToggle}
            onJump={onJump}
            onHover={onHover}
          />
        ))}
    </>
  );
}

/** Preview card width in CSS px; the thumbnail's height follows the page aspect. */
const OUTLINE_PREVIEW_W = 220;

/**
 * A floating thumbnail of a contents entry's page, shown while its row is
 * hovered. Renders the page once at preview width and memoises it in the shared
 * `cache` (keyed by file page), so re-hovering the same chapter is instant and a
 * long document only rasterises the pages actually pointed at.
 */
function OutlinePreview({
  doc,
  page,
  top,
  left,
  cache,
}: {
  doc: PDFDocumentProxy;
  page: number;
  top: number;
  left: number;
  cache: Map<number, string>;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(() => cache.get(page) ?? null);
  useEffect(() => {
    const hit = cache.get(page);
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(null);
    let cancelled = false;
    void (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1, rotation: p.rotate });
        const dpr = window.devicePixelRatio || 1;
        const scale = (OUTLINE_PREVIEW_W / (base.width || 1)) * dpr;
        const viewport = p.getViewport({ scale, rotation: p.rotate });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await p.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        const data = canvas.toDataURL("image/png");
        cache.set(page, data);
        setUrl(data);
      } catch {
        /* leave the card in its loading state on a render failure */
      }
    })();
    return () => { cancelled = true; };
  }, [doc, page, cache]);

  return (
    <div className="file-viewer-pdf-outline-preview" style={{ top, left, width: OUTLINE_PREVIEW_W }}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <div className="file-viewer-pdf-outline-preview-loading">{t("pdfOutline.renderingPage", { page })}</div>
      )}
      <div className="file-viewer-pdf-outline-preview-cap">{t("pdfOutline.pageCaption", { page })}</div>
    </div>
  );
}

/**
 * The contents sidebar: the PDF's embedded outline (chapters/sections) as a
 * collapsible tree. Clicking an entry jumps the reader to its page; the entry
 * whose page is currently in view is highlighted; hovering an entry shows a
 * thumbnail of its page. A PDF with no outline shows a short notice.
 */
function OutlinePane({
  doc,
  nodes,
  placeholder,
  derived,
  currentId,
  onJump,
}: {
  /** The file's own document, for rendering hover previews (null while loading). */
  doc: PDFDocumentProxy | null;
  /** The chapters to show, or null while they're still being loaded/scanned. */
  nodes: OutlineNode[] | null;
  /** The message to show when there is nothing to render (loading or empty). */
  placeholder: string | null;
  /** True when `nodes` came from the font-size fallback, not an embedded outline. */
  derived: boolean;
  currentId: string | null;
  onJump: (page: number) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Hover preview: a small debounce keeps a quick pass down the list from
  // rasterising every page it crosses; the card is placed just right of the pane
  // at the hovered row's height (clamped to stay on screen).
  const paneRef = useRef<HTMLDivElement>(null);
  const previewCache = useRef<Map<number, string>>(new Map());
  const [preview, setPreview] = useState<{ page: number; top: number; left: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const onHover = useCallback((page: number | null, rect: DOMRect | null) => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    if (page == null || !rect) {
      setPreview(null);
      return;
    }
    hoverTimer.current = window.setTimeout(() => {
      const pane = paneRef.current?.getBoundingClientRect();
      const left = (pane?.right ?? rect.right) + 8;
      // Keep the card on screen: assume up to ~320px tall and nudge up if the row
      // sits near the bottom edge.
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 328));
      setPreview({ page, top, left });
    }, 140);
  }, []);
  useEffect(
    () => () => { if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current); },
    [],
  );

  return (
    <div className="file-viewer-pdf-outline" ref={paneRef}>
      <div className="file-viewer-pdf-outline-head">
        <span>{t("pdfOutline.contentsHeader")}</span>
        <UntestedTag id="pdfViewer.1" />
      </div>
      {derived && nodes && nodes.length > 0 && (
        <div className="file-viewer-pdf-outline-note" title={t("pdfOutline.derivedNoteTitle")}>
          {t("pdfOutline.derivedNote")}
        </div>
      )}
      <div
        className="file-viewer-pdf-outline-body"
        // A stale row rect after a scroll would misplace the card, so drop it.
        onScroll={() => setPreview(null)}
      >
        {placeholder != null ? (
          <div className="file-viewer-pdf-outline-empty">{placeholder}</div>
        ) : (
          nodes!.map((n) => (
            <OutlineRow
              key={n.id}
              node={n}
              depth={0}
              collapsed={collapsed}
              currentId={currentId}
              onToggle={toggle}
              onJump={onJump}
              onHover={onHover}
            />
          ))
        )}
      </div>
      {preview && doc && (
        <OutlinePreview
          doc={doc}
          page={preview.page}
          top={preview.top}
          left={preview.left}
          cache={previewCache.current}
        />
      )}
    </div>
  );
}

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
  onReverseSource,
}: {
  path: string;
  /** When set, an "Open externally" button is shown at the end of the toolbar.
   *  Used by the standalone PDF tab, which has no separate header row. */
  onOpenExternally?: () => void;
  /** This viewer tab's key, for #viewerpos scroll/zoom persistence. */
  tabKey?: string;
  /** Hosting subwindow (group) id, for proportional scroll-linking (scrollSync). */
  groupId?: string | null;
  /** SyncTeX reverse-search host seam. When present, a Ctrl/⌘-click on a page
   *  routes the resolved source location here (with the PDF's main-`.tex`
   *  `anchor`) INSTEAD of the module `jumpToSource` — the TeX workspace uses it
   *  to switch its own center to the producing child rather than open a tab.
   *  Absent ⇒ today's standalone behavior (a real source tab), so the plain PDF
   *  tab and its tests are unaffected. */
  onReverseSource?: (src: SyncSource, anchor: string) => void;
}) {
  const t = useT();
  const chordHint = useChordHint();
  const scope = useFileScope();
  const paneVisible = usePaneVisible();

  // "Present": turn this PDF into a deck — a sidecar of editable layers beside
  // it, plus the fullscreen presenter. Experimental, so the button is absent
  // unless the flag is on. Creating the sidecar is deliberately non-destructive:
  // the PDF is untouched, and an existing deck is opened rather than replaced.
  const deckEnabled = useExperimental("deck_presenter");
  // What an external link in the PDF is routed by (#33). Read here rather than at
  // the click so the routing sees the same settings the rest of the app does.
  const settings = useSettingsStore((s) => s.settings);
  const browserEnabled = useExperimental("web_browser");
  const mailEnabled = useExperimental("mail_client");
  const [makingDeck, setMakingDeck] = useState(false);
  const openAsDeck = useCallback(async () => {
    setMakingDeck(true);
    try {
      const deckPath = deckPathForPdf(path);
      let exists = true;
      try {
        await readFileText(deckPath, scope);
      } catch {
        exists = false;
      }
      if (!exists) {
        const deck = emptyDeck(basename(path));
        await writeFileBytes(
          deckPath,
          new TextEncoder().encode(serializeDeck(deck)),
          scope,
        );
      }
      // Imported lazily: `FileViewerPane` already imports this module, so a
      // static import would close a cycle. The call happens in a callback, long
      // after both modules have initialised, so deferring it costs nothing and
      // keeps the dependency one-way on paper — the same reason
      // `openProjectFilesTab` lives beside its tab rather than in the view.
      const { openLinkedFile } = await import("../FileViewerPane");
      openLinkedFile(tabKey, dirname(path) || "/", {
        path: deckPath,
        viewer: "eldeck",
        label: basename(deckPath),
      });
    } catch (e) {
      setError(t(describeFileErrorKey(e)));
    } finally {
      setMakingDeck(false);
    }
  }, [path, scope, tabKey, t]);
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
  /** The contents sidebar (the PDF's chapters/outline) is showing. */
  const [outlineOpen, setOutlineOpen] = useState(false);
  /** The document's resolved outline: null = not loaded yet, [] = none. */
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  /** The font-size heading fallback, used only when `outline` is empty: null =
   *  not scanned yet, [] = none found. */
  const [headings, setHeadings] = useState<OutlineNode[] | null>(null);
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
  /** The region-capture mode is armed — a drag over a page writes that crop to
   *  the native system clipboard (and into the project's tabtivity-screenshots/
   *  folder).
   *  Armed by the global Screenshot app rather than a toolbar button: pressing
   *  Screenshot while a PDF is on screen means this document, at document
   *  sharpness, not a grab of the screen around it. Mutually exclusive with
   *  redaction because both modes own the same plain drag gesture. */
  const [copySelecting, setCopySelecting] = useState(false);
  /** Markup mode (`usePdfMarkup`, `docs/pdf_markup_rounds_plan.md` §2.6) — the
   *  third mode that owns the plain drag, so it excludes the two above. */
  const [marking, setMarking] = useState(false);
  const markingRef = useRef(false);
  markingRef.current = marking;
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const copyNoticeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyNoticeTimer.current != null) window.clearTimeout(copyNoticeTimer.current);
    },
    [],
  );
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
  const copySelection = useCallback(
    async (png: Uint8Array) => {
      setCopyBusy(true);
      setCopyNotice(null);
      try {
        await invoke("copy_png_bytes_to_clipboard", { png: Array.from(png) });
        // The clipboard copy is unconditional; filing the PNG is not. The crop
        // is handed to the save overlay, which asks for a destination before
        // anything is written — the same consent step an OS-tool capture goes
        // through, and for the same reason: a PDF's project may well have a
        // public remote (see `stores/screenshotPending`). The overlay opens on
        // this PDF's own project, since that is the one it documents.
        useScreenshotPendingStore.getState().show({
          kind: "bytes",
          png,
          name: screenshotFilename(),
          hintDir: pdfProjectDir || null,
        });
        setCopyNotice(t("pdfViewer.copySelectionDone"));
        if (copyNoticeTimer.current != null) window.clearTimeout(copyNoticeTimer.current);
        copyNoticeTimer.current = window.setTimeout(() => setCopyNotice(null), 2500);
        // One press of Screenshot is one shot, like every OS region tool this
        // stands in for — disarm rather than wait for an Esc.
        setCopySelecting(false);
      } catch (e) {
        setEditError(t("pdfViewer.copySelectionFailed", { msg: String(e) }));
      } finally {
        setCopyBusy(false);
      }
    },
    [t, pdfProjectDir],
  );
  // The global Screenshot app offers the shot to visible viewers before it
  // spawns the OS region tool (see `lib/window/screenshot`). Claim it while this pane
  // is the one on screen: `paneVisible` is false for every hidden tab, so of
  // the many mounted viewers only the visible one(s) even listen, and the
  // `claimed` flag keeps two side-by-side PDFs from both arming.
  useEffect(() => {
    if (!paneVisible || !doc) return;
    const onCapture = (e: Event) => {
      const detail = (e as CustomEvent<ScreenshotCaptureDetail>).detail;
      if (!detail || detail.claimed || copyBusy) return;
      detail.claimed = true;
      setRedacting(false);
      setMarking(false);
      setCopyNotice(null);
      setCopySelecting(true);
    };
    window.addEventListener(SCREENSHOT_CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(SCREENSHOT_CAPTURE_EVENT, onCapture);
  }, [paneVisible, doc, copyBusy]);
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

  // ── Deleting the metadata (#pdf-meta) ────────────────────────────────────
  // Unlike a blackout, this is not an edit to the arrangement — there is no page it
  // belongs to — so it rides beside it as one flag on the save. It is deliberately
  // *pending* rather than immediate: nothing is written until Save, so it is as
  // cancellable as every other edit in this viewer, and one Save writes the lot.
  /** The metadata panel is open. */
  const [metaOpen, setMetaOpen] = useState(false);
  /** A save would write the file with no metadata at all. */
  const [stripMeta, setStripMeta] = useState(false);
  /** What the loaded document says about itself, read once per load. `null` while
   *  the read is still out — "nothing found" and "not asked yet" are different
   *  answers, and only the first may be reported as an empty list. */
  const [meta, setMeta] = useState<PdfMetadata | null>(null);

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

  // ── Presenting this PDF fullscreen (`present.ts`) ────────────────────────
  //
  // A window of its own showing the sheet and nothing else — the toolbar, the
  // tab bar and the desktop all gone. It opens the file itself from `path`, so
  // what it shows is the file AS SAVED: an unsaved page arrangement stays in this
  // tab, which the button's tooltip says while there is one.
  const presentLabel = useMemo(() => pdfPresentLabel(path), [path]);
  /** This tab has opened the present window (and so answers its seed requests).
   *  Not proof it is still on screen — the reader may have closed it with Esc —
   *  which costs nothing: an emit at a label with no listener is a no-op. */
  const [presentOpen, setPresentOpen] = useState(false);
  const seedPresent = useCallback(() => {
    const payload: PdfPresentSeed = {
      path,
      scope,
      // Where the reader is now, so Present picks up the sheet on screen — and so
      // pressing it again with the window already open moves it here rather than
      // doing nothing visible.
      page: visiblePage,
    };
    void emit(pdfPresentSeedEvent(presentLabel), payload);
  }, [presentLabel, path, scope, visiblePage]);
  // Read by the subscription below through a ref: `listen()` is async, so
  // re-subscribing drops any request that lands during the round trip — and this
  // one would otherwise re-subscribe on every scroll that changes the sheet
  // number, which is the trap `DeckPresenter` documents.
  const seedPresentRef = useRef(seedPresent);
  seedPresentRef.current = seedPresent;
  const openPresentWindow = useCallback(() => {
    void (async () => {
      try {
        // `fullscreen: true` is what makes this different from the deck's
        // audience window: that one only takes over a SECOND monitor and stays
        // windowed on a single-monitor machine, which is the right default for a
        // talk with a notes view but not for "show me this PDF fullscreen".
        // Opening is idempotent by label, so a second press re-focuses the window
        // already up and the seed below moves it to this sheet.
        await invoke("open_presenter_window", { label: presentLabel, fullscreen: true });
        setPresentOpen(true);
        seedPresent();
      } catch (e) {
        setError(t(describeFileErrorKey(e)));
      }
    })();
  }, [presentLabel, seedPresent, t]);

  // The present window asks until it is answered (it and this listener race on
  // open). Subscribed only once this tab has opened one: a listener per PDF tab
  // for a window nobody asked for is a subscription that never pays for itself.
  useEffect(() => {
    if (!presentOpen) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<PdfPresentReady>(PDF_PRESENT_READY, (e) => {
      if (e.payload.label === presentLabel) seedPresentRef.current();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [presentOpen, presentLabel]);

  /** A metadata field's name. Only the eight standard `/Info` keys are translated —
   *  everything else is a name the producer invented, and printing an i18n key back
   *  at the reader is worse than printing the producer's own word. */
  const metaFieldLabel = useCallback(
    (key: string) => {
      const label = META_FIELD_KEYS[key];
      return label ? t(label) : key;
    },
    [t],
  );

  // Read what the document says about itself, on demand rather than at load: the
  // panel is the only thing that shows it, and pdf.js has to be asked, so a reader
  // who never opens it pays nothing — including on the reload of every recompile.
  useEffect(() => {
    if (!metaOpen || !doc || meta) return;
    let cancelled = false;
    void readPdfMetadata(doc).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [metaOpen, doc, meta]);

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

  // ── Remarks (#pdf-notes) ─────────────────────────────────────────────────
  // Writing, changing and deleting a remark are ordinary arrangement edits, for the
  // blackouts' reason: undo/redo, the dirty flag, the save and a page dragged into
  // another document all cover remarks without knowing anything about them. What each
  // one carries in addition is the `baseline` — the file's own remarks on that sheet,
  // as read by the page — because the first edit on a page ADOPTS them; without it a
  // new remark would be the only one the save wrote out.
  /** The name new remarks are signed with. Remembered for the session only, and only
   *  because it was typed: nothing here invents an author, and the OS login is
   *  deliberately not consulted — a document leaves the machine, a real name with it. */
  const [noteAuthor, setNoteAuthor] = useState("");
  // ── The file's own remarks, read once per sheet ──────────────────────────
  // Hoisted out of the page canvas because two things now need the same list and must
  // agree about it: the page, which draws the markers, and the remarks panel, which
  // lists every remark in the document — including on sheets nobody has scrolled to.
  // Ids are minted at the read (a PDF's annotation reference is document-scoped and
  // is rewritten on every save), so two reads of one page produce two sets of ids for
  // the same comments and "go to this remark" would address one the page has never
  // heard of. One read, one owner.
  //
  // Keyed by what the remarks actually depend on — which page, of which document, at
  // which turn — rather than by position in the arrangement, so reordering the sheets
  // moves nothing here and two copies of one page share the file's set until each is
  // edited.
  const noteKey = useCallback((r: PageRef) => `${r.src}:${r.page}:${r.rot}`, []);
  const [fileNotes, setFileNotes] = useState<Map<string, PdfNote[]>>(() => new Map());
  /** Per sheet, the file's own highlight annotations the viewer has taken over the
   *  drawing of — see where it is written for why it is not derived from the map
   *  above. Read by the page canvas as its repaint key. */
  const [hiddenHl, setHiddenHl] = useState<Map<string, string>>(() => new Map());
  // Bumped on every document load: a read still in flight when the file is replaced
  // belongs to the old bytes and must not land on the new ones.
  const noteGen = useRef(0);
  const noteAsked = useRef<Set<string>>(new Set());
  // Dropped DURING RENDER rather than in an effect, which is the one thing about this
  // that is not obvious. Effects flush child-first, so a page canvas asking for its
  // remarks on the commit that loaded a new document would be asking under the *old*
  // generation — its answer discarded by the guard below, its key already marked as
  // asked, and nothing left to ask again. Resetting here means every request in that
  // commit is already the new document's. (React's own "adjust state when a prop
  // changes" shape: the re-render happens before children are committed.)
  const [notesDoc, setNotesDoc] = useState<PDFDocumentProxy | null>(null);
  if (notesDoc !== doc) {
    setNotesDoc(doc);
    setFileNotes(new Map());
    setHiddenHl(new Map());
    noteGen.current += 1;
    noteAsked.current = new Set();
  }
  /** Read the remarks of every named sheet that has not been read yet. Idempotent and
   *  safe to call from a render effect — a sheet is asked for once. */
  const ensureNotes = useCallback((refs: readonly PageRef[]) => {
    const want = refs.map((r) => `${r.src}:${r.page}:${r.rot}`).filter((k, i, all) => {
      if (noteAsked.current.has(k)) return false;
      return all.indexOf(k) === i;
    });
    if (want.length === 0) return;
    for (const k of want) noteAsked.current.add(k);
    const gen = noteGen.current;
    void (async () => {
      const pairs = await Promise.all(
        want.map(async (k) => {
          const cut = k.lastIndexOf(":");
          const mid = k.lastIndexOf(":", cut - 1);
          const src = k.slice(0, mid);
          const d = sourcesRef.current.get(src)?.doc;
          const notes = d
            ? await loadPageNotes(d, Number(k.slice(mid + 1, cut)), Number(k.slice(cut + 1)))
            : [];
          // The viewer draws the highlights it has just read, so the page render must
          // stop drawing the file's own copies of them — see `ANNOT_MODE`. Written
          // here, at the read, because that is the moment the two would start
          // disagreeing, and because a suppression made anywhere else would have to
          // re-derive which annotation each remark came from.
          if (d) {
            for (const n of notes) {
              if (n.srcId) d.annotationStorage.setValue(n.srcId, { noView: true });
            }
          }
          return [k, notes] as const;
        }),
      );
      if (gen !== noteGen.current) return;
      setFileNotes((prev) => {
        const next = new Map(prev);
        for (const [k, v] of pairs) next.set(k, v);
        return next;
      });
      // The repaint key that goes with the suppression above. Held on its own rather
      // than derived from `fileNotes`, and that is not tidiness: an autosave replaces
      // a sheet's cached remarks with the ones it just WROTE, which carry no `srcId`
      // because they were never read from an annotation — so a derived key would empty
      // itself, the page would repaint without the suppression, and the file's
      // original highlights (still in the document object, which a silent save
      // deliberately does not reload) would come back underneath the ones on screen.
      // It is only ever added to, and only the whole map is dropped, when the document
      // is replaced.
      setHiddenHl((prev) => {
        const next = new Map(prev);
        for (const [k, v] of pairs) {
          const ids = v.filter((n) => n.srcId && isHighlight(n)).map((n) => n.srcId!);
          if (ids.length > 0 || !next.has(k)) next.set(k, ids.join(","));
        }
        return next;
      });
    })();
  }, []);


  // ── The remarks panel (#pdf-notes) ───────────────────────────────────────
  /** The panel is open. While it is, every sheet's remarks are read — that is what
   *  makes it a list of the document rather than of the pages that happen to have
   *  been scrolled past. */
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    if (notesOpen) ensureNotes(pages);
  }, [notesOpen, pages, ensureNotes]);
  /** Every remark in the arrangement, in reading order — the walk's own order. */
  const placed = useMemo(
    () => placedNotes(pages, pages.map((r) => fileNotes.get(noteKey(r)))),
    [pages, fileNotes, noteKey],
  );
  /** The remark the walk is parked on, and the request the page consumes to scroll to
   *  it. Kept as one piece of state so the highlighted row and the flashed marker are
   *  the same remark by construction. */
  const [noteFocus, setNoteFocus] = useState<
    { entryId: string; noteId: string; sheet: number; x: number; y: number; nonce: number; edit: boolean } | null
  >(null);
  const goToNote = useCallback((p: PlacedNote, edit = false) => {
    setNoteFocus((cur) => ({
      entryId: p.entryId,
      noteId: p.note.id,
      sheet: p.sheet,
      x: p.note.x,
      y: p.note.y,
      nonce: (cur?.nonce ?? 0) + 1,
      edit,
    }));
  }, []);
  const stepToNote = useCallback(
    (step: 1 | -1) => {
      const next = stepNote(placed, noteFocus?.noteId ?? null, step);
      if (next) goToNote(next);
    },
    [placed, noteFocus?.noteId, goToNote],
  );

  // ── Autosaving a remark (#pdf-notes) ─────────────────────────────────────
  // A remark is a thing you write while reading, and a reader who writes one has said
  // everything they mean to say about it — so the file is written for them, shortly
  // after they stop, rather than waiting for a Save they have no reason to expect.
  //
  // The safety is entirely in what it REFUSES to carry along. A save writes the whole
  // arrangement, so an autosave that fired with a page move pending would commit the
  // move, and one that fired with a blackout pending would flatten the sheet — the
  // single irreversible edit in this viewer, and one that is deliberately confirmed.
  // Hence the gate: remarks may be the ONLY thing pending (`isPristineExceptNotes`),
  // the file must not have changed underneath, and a pending metadata deletion counts
  // as something else. When it is holding, the panel says so rather than leaving a
  // switch that is on and doing nothing.
  const [autosaveNotes, setAutosaveNotes] = useState(
    () => viewPos.initial?.pdfAutosaveNotes !== false,
  );
  const autosaveRef = useRef(autosaveNotes);
  autosaveRef.current = autosaveNotes;
  const setAutosaveNotesPersisted = useCallback(
    (on: boolean) => {
      setAutosaveNotes(on);
      viewPos.persist({ pdfAutosaveNotes: on });
    },
    [viewPos],
  );
  /** Can an autosave run right now? Read by the panel, and re-derived at the timer
   *  from the refs below — this is the display copy, that one is the decision. */
  const notesAutosavable =
    doc != null && !stripMeta && !staleOnDisk && isPristineExceptNotes(pages, doc.numPages);
  const docRef = useRef(doc);
  docRef.current = doc;
  /** A write is in flight. A ref rather than the `saving` flag, because that one is
   *  now only the *button's* spinner — a silent save deliberately does not raise it —
   *  and the "don't write the same file twice at once" guard has to cover both. */
  const writing = useRef(false);
  /** A silent (remark) save is in flight. Shown in the remarks panel and nowhere
   *  else. */
  const [autosaving, setAutosaving] = useState(false);
  const staleRef = useRef(staleOnDisk);
  staleRef.current = staleOnDisk;
  const stripMetaRef = useRef(stripMeta);
  stripMetaRef.current = stripMeta;
  /** Set after `handleSave` is defined; calling it is what a scheduled autosave does. */
  const noteSaveRef = useRef<(() => void) | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (autosaveTimer.current != null) window.clearTimeout(autosaveTimer.current);
    },
    [],
  );
  /** Write the pending remarks shortly after the last one is made. Debounced rather
   *  than immediate because a remark is typically one of several — moving three
   *  markers should be one write of the file, not three. */
  const scheduleNoteAutosave = useCallback(() => {
    if (!autosaveRef.current) return;
    if (autosaveTimer.current != null) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      if (!autosaveRef.current) return;
      const d = docRef.current;
      const list = pagesRef.current;
      if (!d || notedSheetCount(list) === 0) return;
      if (stripMetaRef.current || staleRef.current) return;
      if (!isPristineExceptNotes(list, d.numPages)) return;
      // A save already running has its own bytes in flight; wait it out rather than
      // queueing a second write of the same file.
      if (writing.current) {
        scheduleNoteAutosave();
        return;
      }
      noteSaveRef.current?.();
    }, NOTE_AUTOSAVE_MS);
  }, []);

  // The three edits themselves. Ordinary arrangement edits (see above), each followed
  // by the autosave nudge — which is where writing-on-its-own is armed for *every*
  // way a remark can change, rather than at the card, which is only one of them.
  const addPdfNote = useCallback(
    (entryId: string, note: PdfNote, baseline: readonly PdfNote[]) => {
      if (note.author) setNoteAuthor(note.author);
      applyEdit(addNote(pagesRef.current, entryId, baseline, note));
      scheduleNoteAutosave();
    },
    [applyEdit, scheduleNoteAutosave],
  );
  const updatePdfNote = useCallback(
    (
      entryId: string,
      noteId: string,
      patch: Partial<Omit<PdfNote, "id">>,
      baseline: readonly PdfNote[],
    ) => {
      if (patch.author) setNoteAuthor(patch.author);
      applyEdit(updateNote(pagesRef.current, entryId, baseline, noteId, patch));
      scheduleNoteAutosave();
    },
    [applyEdit, scheduleNoteAutosave],
  );
  const deletePdfNote = useCallback(
    (entryId: string, noteId: string, baseline: readonly PdfNote[]) => {
      applyEdit(removeNote(pagesRef.current, entryId, baseline, noteId));
      scheduleNoteAutosave();
    },
    [applyEdit, scheduleNoteAutosave],
  );
  /** How many remarks a save would write out. Only sheets the arrangement has taken
   *  over are counted — an untouched page's remarks are the file's own and are copied
   *  across rather than rewritten. */
  const notesTotal = noteCount(pages);
  /** How many sheets a save would rewrite the remarks of. Not the same question as
   *  the count above, and it is the one that decides whether anything is pending at
   *  all: deleting the last remark on a page leaves nothing to count and still has to
   *  be written. */
  const notedSheets = notedSheetCount(pages);
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
  const pendingScroll = useRef<{ top: number; left: number } | null>(null);
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);
  // The diskVersion that produced `doc`. Compile-triggered forward search waits
  // for this to reach the requested fresh version before it scrolls.
  const [loadedDiskVersion, setLoadedDiskVersion] = useState(-1);
  const lastMtime = useRef<number | null>(null);

  // ── Mark up (`usePdfMarkup`, `docs/pdf_markup_rounds_plan.md` §2.6) ─────────
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
  // The agent's questions (`markup_ask`), pinned at the words they quote.
  const questionPins = useQuestionPins(marking ? doc ?? null : null, markup.questions.asks);
  const pinnedQuestions = useMemo(
    () => new Set([...questionPins.values()].flat().map((pin) => pinKey(pin.askId, pin.index))),
    [questionPins],
  );
  const showQuestion = markup.questions.show;
  // The agent's ticks (`markup_done`): a ✓ on each ticked sent mark.
  const tickBadges = useMemo(
    () => tickBadgesByPage(markup.edit.base, markup.ticks.marks),
    [markup.edit.base, markup.ticks.marks],
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
  const linkTarget = marking && markup.round && tabKey ? markup.target : null;
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
    setCopySelecting(false);
    setRailOpen(false);
    setMarking(true);
  }, []);
  /** **Reload PDF** under the marks: the viewer's own same-path reload, which
   *  keeps zoom, scroll and page ids. */
  const reloadUnderMarks = useCallback(() => {
    markupRef.current.beforeReload();
    void fileMtime(path, scope)
      .then((mtime) => { lastMtime.current = mtime; })
      .catch(() => {});
    setDiskVersion((v) => v + 1);
  }, [path, scope]);
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
  // True when the document about to load is a same-path reload (a recompile
  // rewrote this PDF). The fit effect reads it to keep the reader's current zoom
  // instead of snapping back to fit-width. Set at load-start so it reflects the
  // load that produced the current `doc`, regardless of effect timing.
  const reloadKeepZoom = useRef(false);
  // True when a `.synctex(.gz)` sits beside the PDF, enabling reverse search.
  const [syncable, setSyncable] = useState(false);
  // True while Ctrl/⌘ is held: reverse-search clicks fire and pages show the
  // crosshair cursor only then, leaving plain clicks free for text selection.
  const [syncArmed, setSyncArmed] = useState(false);
  useEffect(() => {
    if (!syncable) return;
    const sync = (e: KeyboardEvent | MouseEvent) =>
      setSyncArmed(e.ctrlKey || e.metaKey);
    const clear = () => setSyncArmed(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("mousemove", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("mousemove", sync);
      window.removeEventListener("blur", clear);
    };
  }, [syncable]);

  // Why a reverse-search click did nothing, or may have landed on the wrong
  // line — worded from `synctexStatus` after every click (see `syncNoticeKind`).
  // A Ctrl-click used to fail silently in every one of these cases, which read
  // as "click-to-source is broken" when the answer was "you haven't recompiled".
  // `source` is the file the Recompile button builds from (the resolved input on
  // a hit, the PDF's sibling `.tex` otherwise); `canRecompile` gates the button,
  // since a PDF opened on its own has no workspace to hand the build to.
  const [syncNotice, setSyncNotice] = useState<{
    kind: SyncNoticeKind;
    source: string;
    sources: string[];
    canRecompile: boolean;
  } | null>(null);
  useEffect(() => {
    if (!syncNotice) return;
    const id = window.setTimeout(() => setSyncNotice(null), 10000);
    return () => window.clearTimeout(id);
  }, [syncNotice]);

  // SyncTeX forward search: a pending reveal/highlight request for this PDF.
  // Copied into local state so we can consume the store request immediately
  // (avoiding a re-fire) while keeping the highlight mounted to animate.
  const reveal = usePdfSyncStore((s) => s.byPath[path] ?? null);
  const consumeReveal = usePdfSyncStore((s) => s.consume);
  const [highlight, setHighlight] = useState<{ rect: SyncRect; nonce: number; phrase?: CaretPhrase } | null>(null);
  const [reloadReveal, setReloadReveal] = useState<{
    rect: SyncRect;
    nonce: number;
    phrase?: CaretPhrase;
    targetVersion: number;
  } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    if (reveal.afterReload) {
      // An already-open PDF must read the bytes the compiler just replaced.
      // A newly mounted PDF is already loading those bytes, so wait on its
      // current version instead of starting a redundant second read.
      const targetVersion = doc ? diskVersion + 1 : diskVersion;
      setReloadReveal({
        rect: reveal.rect,
        nonce: reveal.nonce,
        phrase: reveal.phrase,
        targetVersion,
      });
      if (doc) {
        // Keep the ordinary mtime poll from noticing the same compiler write
        // afterward and performing a duplicate reload.
        void fileMtime(path, scope)
          .then((mtime) => { lastMtime.current = mtime; })
          .catch(() => {});
        // Held back like any other disk change (unsaved edits, marks on the
        // pages); the reveal waits for the version the reader then loads.
        diskChanged(() => setDiskVersion(targetVersion));
      }
    } else {
      setHighlight({ rect: reveal.rect, nonce: reveal.nonce, phrase: reveal.phrase });
    }
    consumeReveal(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);
  useEffect(() => {
    if (!doc || !reloadReveal || loadedDiskVersion < reloadReveal.targetVersion) return;
    setHighlight({
      rect: reloadReveal.rect,
      nonce: reloadReveal.nonce,
      phrase: reloadReveal.phrase,
    });
    setReloadReveal(null);
  }, [doc, loadedDiskVersion, reloadReveal]);

  // A plain re-read request (a compile with nothing to reveal — see
  // `requestReload`): re-read the bytes now rather than wait for an mtime
  // advance that, after a latexmk "up-to-date" no-op, never comes. Skipped while
  // the first load is still in flight (it is reading those bytes already) and
  // routed through the stale banner when page edits are pending, exactly like
  // the poll — a reload replaces the arrangement.
  const reloadNonce = usePdfSyncStore((s) => s.reloadByPath[path] ?? 0);
  useEffect(() => {
    if (!reloadNonce || (!doc && !error)) return;
    diskChanged(() => {
      void fileMtime(path, scope)
        .then((mtime) => { lastMtime.current = mtime; })
        .catch(() => {});
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

  // ── Selecting text on the page (#pdf-textselect) ─────────────────────────
  // The selection itself is the browser's — the text layer puts a transparent span
  // over every run of glyphs and an ordinary drag does the rest. What is owned here is
  // everything that happens *because* of one: the words on the clipboard, and the bar
  // that turns a selection into a highlight.
  //
  // It is read in ONE place rather than per page, and that is what makes a drag across
  // a page break work: to the engine that is one selection, to a PDF it is one
  // annotation per sheet, and only something holding all the page boxes at once can
  // divide it up (`selection.ts`).
  const [sel, setSel] = useState<ViewerSelection | null>(null);
  /** Bumped when the current selection was copied — the bar's "Copied" flash, and
   *  nothing else: the copy itself has already happened by then. */
  const [copiedNonce, setCopiedNonce] = useState(0);
  /** The text most recently put on the clipboard by this viewer — the once-per-
   *  selection guard the copy effect below explains. */
  const lastCopied = useRef<string | null>(null);
  const [copyOnSelect, setCopyOnSelect] = useState(
    () => viewPos.initial?.pdfCopyOnSelect !== false,
  );
  const setCopyOnSelectPersisted = useCallback(
    (on: boolean) => {
      setCopyOnSelect(on);
      // Turning it back on has to be able to copy the selection that is up right now:
      // the once-per-selection guard below would otherwise treat it as already done.
      if (on) lastCopied.current = null;
      viewPos.persist({ pdfCopyOnSelect: on });
    },
    [viewPos],
  );
  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  /** Re-read the selection. Cheap enough to run on every `selectionchange` (it is
   *  rectangles off a live range), and it has to be: the bar has to follow a drag
   *  rather than appear where it started. */
  const readSelection = useCallback(() => {
    const host = contentRef.current;
    setSel(host ? readViewerSelection(host, scaleRef.current) : null);
  }, []);

  useEffect(() => {
    if (!doc) return;
    // `selectionchange` is the only event that fires for every way a selection can
    // come about — a drag, a double-click on a word, Shift+arrow, Ctrl+A — which is
    // exactly why the bar is driven off it rather than off pointerup.
    document.addEventListener("selectionchange", readSelection);
    return () => document.removeEventListener("selectionchange", readSelection);
  }, [doc, readSelection]);
  // A zoom does not change the selection, but it changes where it is on screen, so
  // the boxes the bar is placed from have to be measured again.
  useEffect(() => { readSelection(); }, [scale, readSelection]);

  /**
   * Put the selected words on the clipboard, once the gesture has settled.
   *
   * On `mouseup`/`keyup` rather than on `selectionchange`, and that is the whole
   * subtlety: a drag fires the latter on every pixel, so copying there would write the
   * clipboard a hundred times for one sentence and leave whichever partial selection
   * happened to be last if the reader let go outside the window.
   *
   * Each selection is written **once**, and that guard is not an optimization. Both
   * events fire for things that have nothing to do with this viewer — a key pressed in
   * a terminal in the next pane, a button clicked anywhere in the window — while a
   * selection made minutes ago is still up on the page. Without it, everything the
   * reader copied in between would be silently overwritten by the same old sentence,
   * over and over, which is the worst thing a feature like this can do.
   *
   * A failed write is swallowed. The clipboard can be refused (no permission, no
   * clipboard in the environment) and this is a convenience nobody asked for in the
   * moment — reporting it would be an error banner over a document for something the
   * reader did not ask to happen.
   */
  useEffect(() => {
    if (!doc) return;
    const settle = () => {
      if (!copyOnSelectRef.current) return;
      const host = contentRef.current;
      const now = host ? readViewerSelection(host, scaleRef.current) : null;
      if (!now || now.text === lastCopied.current) return;
      lastCopied.current = now.text;
      navigator.clipboard?.writeText(now.text).catch(() => {});
      setCopiedNonce((n) => n + 1);
    };
    window.addEventListener("mouseup", settle);
    window.addEventListener("keyup", settle);
    return () => {
      window.removeEventListener("mouseup", settle);
      window.removeEventListener("keyup", settle);
    };
  }, [doc]);

  /** The flash belongs to the selection that was copied, so a new one starts unflashed
   *  rather than inheriting the last one's "Copied". */
  const copiedFor = useRef<{ nonce: number; text: string } | null>(null);
  if (copiedFor.current?.nonce !== copiedNonce) {
    copiedFor.current = { nonce: copiedNonce, text: sel?.text ?? "" };
  }
  const copiedNow = !!sel && copiedFor.current?.text === sel.text;

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
    [sel, fileNotes, noteKey, noteAuthor, addPdfNote],
  );

  // ── Ctrl+F text search (#71) ───────────────────────────────────────
  // A floating find bar over the page stack with next/previous navigation, a
  // live match count, and a case toggle. Matches are found in each page's
  // extracted text (`getTextContent`) and painted as translucent boxes over the
  // canvases (`pdfPageMatches` → per-page rects), the current one brighter and
  // scrolled into view — the PDF counterpart to the editors' in-text search.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Print: the shared preview arranges the job (paper, margins, sheet order, turns,
  // selection) from page images — the webview can't show a PDF — but what goes to
  // the printer is the real PDF: `native` rebuilds the preview's sheets as vector
  // pages (`layoutPrintPdf`) and hands them to the system print UI
  // (`printPdfNative`; GTK / WebView2 / PDFKit). Only where there is no native
  // path does the preview print its images. `printing` disables the button while
  // the (async) render runs.
  const [printing, setPrinting] = useState(false);
  const handlePrint = useCallback(async () => {
    if (!doc || printing || pages.length === 0) return;
    setPrinting(true);
    setEditError(null);
    try {
      // The ARRANGEMENT, not the file: printing an edited PDF prints what is on
      // screen, without having to save it first. Preview sheet n is `sheets[n-1]`.
      const sheets = pages;
      const title = basename(path);
      const images = await renderPdfPagesToImages(sheets, (id) => sources.get(id)?.doc);
      const body = images
        .map((src) => `<div class="print-page"><img src="${src}" alt=""></div>`)
        .join("");
      const native: NativePrint = async (sequence, opts) => {
        // The bytes Save and a page drag-out write — blackouts burned in, pending
        // metadata deletion applied — one page per viewer sheet, in its order.
        const bytes = await buildPdf(sheets, sources, {
          emptyMsg: t("pdfViewer.pdfBuildEmpty"),
          sourceClosedMsg: t("pdfViewer.pdfSourceClosed"),
          redactDpi,
          stripMetadata: stripMeta,
        });
        const laidOut = await layoutPrintPdf(bytes, sequence, opts);
        return printPdfNative(laidOut, title, { paper: opts.paper, grayscale: opts.grayscale });
      };
      await printHtmlBody(body, PDF_PRINT_CSS, title, native);
    } catch (e) {
      setEditError(
        t("pdfViewer.printFailed", { msg: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setPrinting(false);
    }
  }, [doc, printing, pages, sources, redactDpi, stripMeta, path, t]);

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
  }, [dirty, pages, sources, path, scope, redactDpi, stripMeta, noteKey, t]);

  // What a scheduled remark autosave calls. Through a ref because the timer is armed
  // by an edit made long before this render's `handleSave` exists, and because the
  // save closes over the arrangement it must write — the one from the render that
  // last saw it, not the one from the render that armed the timer.
  noteSaveRef.current = () => void handleSave(false, true);

  // ── Merge: splice another PDF's pages into this arrangement ──────────────
  // (`pdfProjectDir` — the project tree the picker lists — is declared beside the
  // region-capture mode above, which files its screenshots by the same answer.)

  // BOX scope (#41 Phase 5): the merge picker offers EVERY root the scope can
  // read — the box folder plus each member project's tree — with a root
  // selector row, so a merge can pull pages from another member's PDF.
  // Single-project scopes get no `roots` and are unchanged.
  const pdfPickerRoots = useMemo(() => {
    if (!scope || !scope.startsWith(BOX_SCOPE_PREFIX)) return null;
    const { boxes } = useBoxesStore.getState();
    const { projects } = useProjectsStore.getState();
    const box = boxes.find((b) => boxScopeId(b.id) === scope);
    if (!box) return null;
    const roots: { label: string; dir: string }[] = [];
    if (box.folder) roots.push({ label: box.name, dir: box.folder });
    for (const m of boxMembersOfScope(scope, boxes, projects)) {
      roots.push({ label: m.name, dir: m.dir });
    }
    return roots.length > 0 ? roots : null;
  }, [scope]);

  /** Where an insert lands: after the last selected sheet, else at the end. */
  const insertAt = useCallback(() => {
    if (selection.size === 0) return pages.length;
    let last = -1;
    pages.forEach((r, i) => {
      if (selection.has(r.id)) last = i;
    });
    return last < 0 ? pages.length : last + 1;
  }, [pages, selection]);

  /** Open a PDF's bytes as a new source and splice all of its pages in at `at`. */
  const spliceIn = useCallback(
    async (bytes: Uint8Array, at: number) => {
      const src = await openSource(bytes);
      const id = newSourceId();
      // The ref is authoritative (the load effect's cleanup frees from it), so it
      // and the state map are updated together.
      sourcesRef.current = new Map(sourcesRef.current).set(id, src);
      setSources(sourcesRef.current);
      applyEdit(insertPages(pagesRef.current, pagesOf(id, src.doc.numPages), at));
    },
    [applyEdit],
  );

  /** Read a PDF from the project and splice all of its pages in. */
  const mergePdf = useCallback(
    async (abs: string) => {
      setEditError(null);
      try {
        // `readFileBytes` already hands back a fresh `Uint8Array` that owns its
        // buffer, which is what `openSource` needs (pdf.js detaches it) — copying
        // it again would only double a whole document in memory.
        await spliceIn(await readFileBytes(abs, scope), insertAt());
      } catch (e) {
        setEditError(
          t("pdfViewer.insertFailed", { name: basename(abs), msg: e instanceof Error ? e.message : String(e) }),
        );
      }
    },
    [scope, spliceIn, insertAt, t],
  );

  // ── Dragging pages to another PDF viewer, in this window or another ──────
  // The bytes cannot ride a JS object across a window boundary (separate WebViews,
  // separate heaps), so the dragged pages are built into a small PDF and parked in the
  // backend page clipboard; the drag carries only its token. See `stores/drag/pdfDrag`.

  /** Build the dragged pages into a standalone PDF and park it for the drop. */
  const exportPages = useCallback(
    async (ids: string[]): Promise<PageTransfer | null> => {
      const picked = pagesRef.current.filter((r) => ids.includes(r.id));
      if (picked.length === 0) return null;
      try {
        // A dragged-out page carries its blackouts BURNED IN, not as pending marks:
        // the bytes are what lands in the other viewer (or the other window), and a
        // mark that travelled as an editable overlay would arrive as a page whose
        // text is still there under a black box.
        // Pending metadata deletion travels with the pages for the blackouts'
        // reason: these bytes are what lands in the other viewer, and a page that
        // arrived carrying the XMP packet its reader had just asked to be rid of
        // would put it back into a document they never associated it with.
        const bytes = await buildPdf(picked, sourcesRef.current, {
          emptyMsg: t("pdfViewer.pdfBuildEmpty"),
          sourceClosedMsg: t("pdfViewer.pdfSourceClosed"),
          redactDpi,
          stripMetadata: stripMeta,
        });
        const token = await invoke<string>("pdf_clip_set", { bytes: Array.from(bytes) });
        return { token, count: picked.length };
      } catch (e) {
        setEditError(
          t("pdfViewer.copyPagesFailed", { msg: e instanceof Error ? e.message : String(e) }),
        );
        return null;
      }
    },
    [redactDpi, stripMeta, t],
  );

  /** Take pages dragged out of another viewer and splice them in at `index`. */
  const importPages = useCallback(
    (transfer: PageTransfer, index: number) => {
      // Pages landed here, so the rail is now showing something the reader asked for
      // — it stays open when the drag ends, however it came to be open. Set
      // SYNCHRONOUSLY, before the await below: the close is only deferred by a
      // macrotask, and the fetch takes far longer than that.
      railAutoOpenedRef.current = false;
      void (async () => {
        try {
          const bytes = await invoke<number[]>("pdf_clip_get", { token: transfer.token });
          await spliceIn(new Uint8Array(bytes), index);
        } catch (e) {
          setEditError(
            t("pdfViewer.insertPagesFailed", { msg: e instanceof Error ? e.message : String(e) }),
          );
        }
      })();
    },
    [spliceIn, t],
  );

  /** The dragged pages were MOVED (Shift) and the drop was acknowledged: drop them. */
  const dropMovedPages = useCallback(
    (ids: string[]) => {
      applyEdit(deletePages(pagesRef.current, ids));
    },
    [applyEdit],
  );

  // ── The spring-loaded rail ───────────────────────────────────────────────
  // Dragging pages needs a rail at BOTH ends, and the rail starts closed — so the
  // feature used to require arming every document by hand before it could be a
  // destination, which is a setup step nobody discovers. Instead: while a page drag
  // is in flight, every open PDF shows its rail, and puts it away again afterwards
  // unless pages actually landed in it.
  //
  // This lives on the VIEWER, not on the strip, and that is the whole point — the
  // strip only exists while the rail is open, so a strip-level subscription could
  // never hear the drag that ought to open it.
  useEffect(
    () =>
      subscribePageDragActive((active) => {
        if (active) {
          if (railOpenRef.current) return; // already the reader's own choice
          // Marking up holds the arrangement still: no rail, so no drop target.
          if (markingRef.current) return;
          railAutoOpenedRef.current = true;
          setRailOpen(true);
          return;
        }
        if (!railAutoOpenedRef.current) return; // the reader opened it — leave it
        // Deferred by a macrotask because a drop in ANOTHER window is delivered to
        // two listeners on one event — this one and the strip's — in registration
        // order, not in the order the work depends on. Closing here could therefore
        // unmount the very strip that is about to claim the pages. `onImport` clears
        // the flag synchronously, so by the time this runs a claimed rail stays open.
        setTimeout(() => {
          if (!railAutoOpenedRef.current) return;
          railAutoOpenedRef.current = false;
          setRailOpen(false);
        }, 0);
      }),
    [],
  );
  const pageText = useSearchText(pages, sources, paneVisible && (findOpen || redacting));

  // Flat list of matches across all pages, in document order; each carries its
  // 1-based page and the big-point boxes covering it.
  const matches = useMemo(() => {
    if (!findOpen || !query || !pageText) return [];
    const out: { page: number; rects: SyncRect[] }[] = [];
    pageText.forEach((items, i) => {
      for (const rects of pdfPageMatches(items, i + 1, query, caseSensitive)) {
        out.push({ page: i + 1, rects });
      }
    });
    return out;
  }, [findOpen, query, caseSensitive, pageText]);

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

  // Bumped to ask the page holding the current match to scroll it into view.
  const [searchScrollNonce, setSearchScrollNonce] = useState(0);

  // Per-page search overlays passed to each PdfPageCanvas: its matches (with the
  // current one flagged) plus a scroll nonce that only advances for the page the
  // current match sits on.
  const searchByPage = useMemo(() => {
    const map = new Map<number, { rects: SyncRect[]; current: boolean }[]>();
    matches.forEach((m, i) => {
      const list = map.get(m.page) ?? [];
      list.push({ rects: m.rects, current: i === current });
      map.set(m.page, list);
    });
    return map;
  }, [matches, current]);
  const currentPage = matches[current]?.page ?? 0;

  // #71 scrollbar markers: one tick per match positioned over the native
  // scrollbar track at the match's fractional position through the document, so
  // hits scrolled off-screen are still locatable at a glance. Each tick's `top`
  // is px within the track (= the scroll area's visible height); the current
  // match's tick is flagged. Derived from live geometry — the page wraps'
  // on-screen rects plus the match box's y within its page — so it stays correct
  // across zoom and resize (recomputed by the effect below).
  const [markerTops, setMarkerTops] = useState<{ top: number; current: boolean }[]>([]);
  const recomputeMarkers = useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!findOpen || !scroll || !content || matches.length === 0) {
      setMarkerTops((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const wraps = content.children; // page wraps, in page order
    const scrollTop0 = scroll.getBoundingClientRect().top;
    const track = scroll.clientHeight; // scrollbar track height = visible height
    const total = scroll.scrollHeight;
    if (total <= 0) return;
    const tops: { top: number; current: boolean }[] = [];
    matches.forEach((m, i) => {
      const wrap = wraps[m.page - 1] as HTMLElement | undefined;
      if (!wrap) return;
      // The page's top in scroll-content coordinates (independent of the current
      // scroll offset), plus the match box's y within the page.
      const pageTop = wrap.getBoundingClientRect().top - scrollTop0 + scroll.scrollTop;
      const matchTop = pageTop + (m.rects[0]?.y ?? 0) * scale;
      tops.push({ top: (matchTop / total) * track, current: i === current });
    });
    setMarkerTops(tops);
  }, [findOpen, matches, current, scale]);

  // Recompute markers when the match set / zoom / find-bar visibility changes,
  // and whenever the scroll area or page stack resizes (canvases render lazily,
  // growing the stack over several frames; a window/pane resize changes the
  // track height).
  useEffect(() => {
    recomputeMarkers();
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeMarkers());
    ro.observe(scroll);
    ro.observe(content);
    return () => ro.disconnect();
  }, [recomputeMarkers]);

  // Clamp the current index when the match set shrinks (query/case change).
  useEffect(() => {
    if (current > 0 && current >= matches.length) {
      setCurrent(matches.length > 0 ? matches.length - 1 : 0);
    }
  }, [matches.length, current]);

  // Jump to the first match whenever the query/case changes, the bar opens, or
  // the page text finishes extracting (so a query typed before extraction
  // completed still scrolls to its first hit).
  useEffect(() => {
    if (!findOpen) return;
    setCurrent(0);
    setSearchScrollNonce((n) => n + 1);
  }, [query, caseSensitive, findOpen, pageText]);

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      setCurrent((c) => (c + dir + matches.length) % matches.length);
      setSearchScrollNonce((n) => n + 1);
    },
    [matches.length],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    scrollRef.current?.focus();
  }, []);

  // ── Go to page (Ctrl+G) ───────────────────────────────────────────────────
  // Jumps by ARRANGEMENT position — the same "X / N" the toolbar readout and
  // `visiblePage` already count in — so it lands right even after pages have
  // been reordered/merged/deleted, without having to resolve a file page first.
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const jumpToArrangementIndex = useCallback((pos: number) => {
    const count = pagesRef.current.length;
    if (count === 0) return;
    const idx = Math.min(Math.max(Math.trunc(pos), 1), count) - 1;
    const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
    if (wrap) scrollIntoPdfBox(wrap, "start");
  }, []);
  /** ← / → : one sheet per press, the way a deck of slides is read. Returns
   *  false at either end of the document, where the caller leaves the key to the
   *  scroller rather than yanking the reader back to the top of the page they
   *  are already at the bottom of. */
  const stepPage = useCallback(
    (delta: number) => {
      const target = visiblePageRef.current + delta;
      if (target < 1 || target > pagesRef.current.length) return false;
      visiblePageRef.current = target;
      jumpToArrangementIndex(target);
      return true;
    },
    [jumpToArrangementIndex],
  );
  const openPageJump = useCallback(() => {
    if (pages.length === 0) return;
    setPageJumpValue(String(visiblePage));
    setPageJumpOpen(true);
    requestAnimationFrame(() => {
      pageJumpInputRef.current?.focus();
      pageJumpInputRef.current?.select();
    });
  }, [pages.length, visiblePage]);
  const closePageJump = useCallback(() => {
    setPageJumpOpen(false);
    scrollRef.current?.focus();
  }, []);
  const commitPageJump = useCallback(() => {
    const n = parseInt(pageJumpValue, 10);
    if (Number.isFinite(n)) jumpToArrangementIndex(n);
    closePageJump();
  }, [pageJumpValue, jumpToArrangementIndex, closePageJump]);

  // ── The document's own hyperlinks (#pdf-links) ────────────────────────────
  // A `hyperref` PDF is full of them — every `\ref`, `\cite`, `\autoref` and
  // contents row is a GoTo annotation — so following one has to feel like part of
  // reading, not like navigation: the jump lands ON the target rather than at the
  // top of its page, marks where it landed, and leaves a way back.

  /** Where the reader was before each followed internal link (newest last). */
  const [linkBack, setLinkBack] = useState<{ top: number; left: number }[]>([]);
  /** The landing band: which sheet, how far down it (big points), and a nonce so
   *  a repeat jump to the same anchor flashes again. */
  const [destMark, setDestMark] = useState<{ index: number; top: number; nonce: number } | null>(null);
  const destMarkTimer = useRef<number | null>(null);
  /** The external address awaiting the confirm, or null. */
  const [linkConfirm, setLinkConfirm] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (destMarkTimer.current != null) window.clearTimeout(destMarkTimer.current);
    },
    [],
  );
  // A different file is a different document: its back stack and its landing mark
  // are positions in a page stack that no longer exists.
  useEffect(() => {
    setLinkBack([]);
    setDestMark(null);
    setLinkConfirm(null);
  }, [path]);

  /** How far below the viewport top an internal link's target is parked, so the
   *  landing line is not flush against the edge (and, on a `\ref`, the line above
   *  it is readable as context). */
  const DEST_PAD = 24;

  /** Scroll to a resolved destination. Returns false when nothing was moved —
   *  the arrangement may no longer contain the target page at all (it was
   *  deleted), and a back entry must not be pushed for a jump that did nothing. */
  const jumpToDest = useCallback(
    async (dest: PdfDest): Promise<boolean> => {
      const list = pagesRef.current;
      const idx = list.findIndex((r) => r.src === SELF && r.page === dest.page);
      if (idx < 0) return false;
      const scroller = scrollRef.current;
      const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
      if (!scroller || !wrap) return false;
      // Explicit navigation supersedes a same-path reload's scroll restoration —
      // the rule `onReveal` already applies to a SyncTeX jump.
      restoreScroll.current = null;
      const srcDoc = sourcesRef.current.get(SELF)?.doc;
      const top = srcDoc ? await destTopInBigPoints(srcDoc, dest, list[idx].rot ?? 0) : null;
      if (top == null) {
        // A whole-page destination (`/Fit`) names no line to land on.
        scrollIntoPdfBox(wrap, "start");
        return true;
      }
      // Measured rather than read off `offsetTop`: the page stack's offset parent
      // is not guaranteed to be the scroller, and a rect delta is right either way.
      const delta = wrap.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += delta + top * scale - DEST_PAD;
      setDestMark((m) => ({ index: idx, top, nonce: (m?.nonce ?? 0) + 1 }));
      if (destMarkTimer.current != null) window.clearTimeout(destMarkTimer.current);
      destMarkTimer.current = window.setTimeout(() => setDestMark(null), 2200);
      return true;
    },
    [scale],
  );

  /** Step back to where the last internal link was followed from. */
  const linkGoBack = useCallback(() => {
    setLinkBack((s) => {
      const last = s[s.length - 1];
      if (!last) return s;
      const el = scrollRef.current;
      if (el) {
        restoreScroll.current = null;
        el.scrollTop = last.top;
        el.scrollLeft = last.left;
      }
      return s.slice(0, -1);
    });
  }, []);

  const onPdfLink = useCallback(
    (link: PdfLink) => {
      if (link.kind === "external") {
        setLinkConfirm(link.url);
        return;
      }
      const el = scrollRef.current;
      const from = el ? { top: el.scrollTop, left: el.scrollLeft } : null;
      void jumpToDest(link.dest).then((moved) => {
        // Bounded: the stack is a way back from a chain of citations, not a
        // history of the session.
        if (moved && from) setLinkBack((s) => [...s.slice(-19), from]);
      });
    },
    [jumpToDest],
  );

  /** Open a confirmed external address through the app's ONE routing table
   *  (#33). `origin: "viewer"` is the load-bearing argument: a URL that came out
   *  of a file the user is looking at is untrusted, so it can never become a live
   *  in-app page in one click. No `openBrowserTab` hook is passed — this viewer
   *  does not own a tab store — so an in-app target degrades to the user's real
   *  browser rather than to a click that goes nowhere. */
  const openPdfLink = useCallback(
    (url: string) => {
      openRoutedUri(
        url,
        {
          setting: settings?.browser_link_target,
          browserEnabled,
          mailEnabled,
          origin: "viewer",
          browserRoleConfigured: !!settings?.global_apps?.browser?.exec,
        },
        {
          globalApps: settings?.global_apps,
          onRefuse: (reason) => setEditError(t("pdfLinks.refused", { reason })),
        },
      );
    },
    [settings, browserEnabled, mailEnabled, t],
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
      } else if (e.key === "Escape" && copySelecting) {
        e.preventDefault();
        setCopySelecting(false);
      } else if (e.key === "Escape" && marking && !isTextEntry(e.target)) {
        e.preventDefault();
        leaveMarkup();
      }
    },
    [
      marking,
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
      copySelecting,
      linkGoBack,
      stepPage,
      handlePrint,
    ],
  );
  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // Probe for SyncTeX data beside the PDF; re-checked after each disk change
  // (a recompile may have just written it).
  useEffect(() => {
    let cancelled = false;
    const base = path.replace(/\.pdf$/i, "");
    const exists = (p: string) =>
      fileMtime(p, scope).then(() => true).catch(() => false);
    void Promise.all([exists(`${base}.synctex.gz`), exists(`${base}.synctex`)]).then(
      ([gz, raw]) => { if (!cancelled) setSyncable(gz || raw); },
    );
    return () => { cancelled = true; };
  }, [path, scope, diskVersion]);

  // Reverse search: a click on a page → which source line produced it → jump.
  // Resolve the clicked source's root (the main `.tex` that produces this PDF) and
  // pass it as the routing anchor, so a subfile with no tab yet opens in the
  // subwindow that already holds the main `.tex` rather than the focused group.
  //
  // Every outcome is worded: no map beside the PDF (compile with SyncTeX first),
  // a map the PDF or a source outgrew (recompile — the jump still happens, a
  // nearby line beats nothing), or an honest miss on a current map. The status
  // probe runs after the resolve, not before, so a clean hit on a current map
  // costs one extra command answered from the map cache and a few stats.
  const onSyncClick = useCallback(
    async (page: number, x: number, y: number) => {
      setSyncNotice(null);
      const src = syncable ? await synctexEdit(path, page, x, y) : null;
      if (src) {
        const anchor = await resolveTexRoot(src.input).catch(() => src.input);
        // In a TeX workspace the host handles reverse search itself (it switches
        // the docked editor's center to the producing child); standalone falls
        // back to the module jump (open/focus the source tab).
        if (onReverseSource) onReverseSource(src, anchor);
        else jumpToSource(src.input, src.line, src.column, anchor);
      }
      const status = syncable ? await synctexStatus(path) : null;
      const kind = syncable
        ? syncNoticeKind(status, src != null)
        : ("noMap" satisfies SyncNoticeKind);
      if (!kind) return;
      const source = src?.input ?? path.replace(/\.pdf$/i, ".tex");
      const canRecompile = await canRecompileTexSource(source).catch(() => false);
      setSyncNotice({ kind, source, sources: status?.newer_sources ?? [], canRecompile });
    },
    [path, syncable, onReverseSource],
  );

  // Seed the mtime baseline once per file, visible or not, so it pairs with the
  // bytes the load effect read — the re-show catch-up below compares against it.
  useEffect(() => {
    lastMtime.current = null;
    let cancelled = false;
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope]);

  // Poll mtime; on an advance (e.g. a recompile wrote a new PDF), bump
  // diskVersion so the load effect re-reads the fresh bytes (#43-style).
  // Visible panes only — a hidden PDF tab (every backgrounded project's, and a
  // TeX PDF behind another tab in its group) polled an SFTP stat per tick on a
  // remote project forever. The immediate check on re-show catches a recompile
  // that happened while the tab was hidden.
  useEffect(() => {
    if (!paneVisible) return;
    let cancelled = false;
    const check = () => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          // A reload REPLACES the arrangement, so it would silently throw away any
          // unsaved page edits. With edits pending we raise a banner and let the
          // reader choose; without them the old auto-reload stands (a LaTeX
          // recompile must still refresh the PDF on its own). Marks on the pages
          // hold it back the same way, behind the markup strip's Reload.
          diskChanged(() => setDiskVersion((v) => v + 1));
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, paneVisible, diskChanged]);

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
          // through to capturing where the reader actually is.
          (restoreScroll.current ??
            (el ? { top: el.scrollTop, left: el.scrollLeft } : null))
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
  }, [path, scope, diskVersion]);

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
  useEffect(() => {
    const slot = new PdfWorkerSlot();
    workerSlot.current = slot;
    return () => {
      const pending = [...sourcesRef.current.values()].map((s) => s.doc.loadingTask.destroy());
      sourcesRef.current = new Map();
      if (workerSlot.current === slot) workerSlot.current = null;
      slot.dispose(pending);
    };
  }, []);

  // Intrinsic (scale-1) CSS dimensions of every page, computed once per document
  // load. Lets each PdfPageCanvas reserve its true size before rendering so the
  // page stack reaches its full scroll height immediately — without it the
  // restored scroll position (#viewerpos) is unreachable until every page above
  // it has finished rendering, which on a slow startup loses the position to the
  // restore deadline. getPage()/getViewport() read only page metadata (no
  // rasterisation), so this is cheap relative to actually rendering the pages.
  const [pageSizes, setPageSizes] = useState<{ w: number; h: number }[] | null>(null);
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
        if (!cancelled) setPageSizes(sizes);
      } catch {
        /* leave heights unreserved — restore falls back to the old behaviour */
      }
    })();
    return () => { cancelled = true; };
  }, [pages, sources]);

  // Fit the first page to the viewport width when a document loads.
  const fitWidth = useCallback(async (d: PDFDocumentProxy) => {
    const el = scrollRef.current;
    if (!el) return;
    const page = await d.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const avail = el.clientWidth - 24; // leave room for page margins
    if (avail > 0 && vp.width > 0) {
      const nextScale = clampPdfScale(avail / vp.width);
      // Re-express the pending target BEFORE announcing that zoom is ready: the
      // restore layout effect runs before ordinary effects, so leaving this to
      // the scale effect below could apply (and clear) the old-scale offset one
      // frame too early.
      const from = restoreScale.current;
      if (from != null && restoreScroll.current) {
        restoreScroll.current = rescaleScrollTarget(restoreScroll.current, from, nextScale);
        restoreScale.current = nextScale;
      }
      setScale(nextScale);
      fittedRef.current = true;
      setInitialZoomReady(true);
      // Record the baseline here rather than leaving it to the scale-persist
      // effect: fitting when the view is already AT the fit (the "Fit width"
      // button on an untouched document) changes no scale, so that effect never
      // fires — and the flag is the whole point. `viewPos.persist` dedups.
      viewPos.persist({ pdfFitted: true });
    }
  }, [viewPos]);

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

  // ── Contents / outline (#pdf-outline) ────────────────────────────────────
  // Load the PDF's embedded outline (its chapters) when a document loads. Reset
  // to "not loaded" first so a file switch never shows the prior file's chapters.
  useEffect(() => {
    setOutline(null);
    setHeadings(null);
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      try {
        const nodes = await loadOutline(doc, t("pdfOutline.untitled"));
        if (!cancelled) setOutline(nodes);
      } catch {
        if (!cancelled) setOutline([]); // treat an unreadable outline as none
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Font-size heading fallback: when the PDF ships NO embedded outline, infer
  // chapters from the text's typography (`detectHeadings`). Run it lazily — only
  // once the contents pane is opened on an outline-less document — because it
  // reads every page's text content, which is far heavier than `getOutline`.
  useEffect(() => {
    if (!outlineOpen || !doc) return;
    // A lone title bookmark (some LaTeX templates ship exactly that) is not real
    // navigation, so scan for headings as if the outline were absent.
    if (outline == null || outlineIsNavigable(outline)) return; // usable outline present/pending
    if (headings != null) return; // already scanned
    let cancelled = false;
    void (async () => {
      const runs: HeadingRun[] = [];
      // Sequential (not Promise.all): a 500-page document would otherwise fire
      // 500 concurrent text extractions at the pdf.js worker at once.
      for (let p = 1; p <= doc.numPages; p++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          for (const it of content.items) {
            if (!("str" in it) || typeof it.str !== "string" || !it.str.trim()) continue;
            const tx = pdfjs.Util.transform(viewport.transform, it.transform);
            const size = Math.hypot(tx[2], tx[3]);
            runs.push({ str: it.str, size, page: p, x: tx[4], y: tx[5] - size });
          }
          // Hand the page's parse back before moving on. This walks the WHOLE
          // document, so without it a scan of a long one ends holding every page
          // pdf.js had to parse to answer — and the pages the reader is looking at
          // are re-rendered from the file when they are next painted anyway.
          page.cleanup();
        } catch {
          /* skip an unreadable page */
        }
      }
      if (!cancelled) setHeadings(detectHeadings(runs));
    })();
    return () => { cancelled = true; };
  }, [outlineOpen, doc, outline, headings]);

  // The chapters actually shown: the embedded outline if the PDF has one, else
  // the inferred headings. `activeOutline` is null while its source is still
  // loading/scanning; `outlineDerived` says the fallback is in use.
  // A present-but-degenerate outline (a lone title bookmark) is treated as absent:
  // the fallback headings stand in, and the sidebar labels them as derived.
  const outlineUsable = outline != null && outlineIsNavigable(outline);
  const outlineDerived = outline != null && !outlineUsable;
  const activeOutline: OutlineNode[] | null =
    outline == null ? null : outlineUsable ? outline : headings;
  const outlinePlaceholder =
    activeOutline && activeOutline.length > 0
      ? null
      : outline == null
        ? t("pdfOutline.reading")
        : outlineDerived && headings == null
          ? t("pdfOutline.scanning")
          : t("pdfOutline.noChapters");

  // Jump the reader to a 1-based FILE page from the contents sidebar. The reader
  // shows an arrangement, so resolve the file page to whichever sheet is showing
  // it now (a moved/merged page still lands right; a deleted one is a no-op).
  const jumpToPage = useCallback((filePage: number) => {
    const idx = pagesRef.current.findIndex((r) => r.src === SELF && r.page === filePage);
    if (idx < 0) return;
    const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
    if (wrap) scrollIntoPdfBox(wrap, "start");
  }, []);

  // The outline entry to highlight: the last chapter (in document order) whose
  // page is at or before the page currently in view. Recomputed from the flat
  // outline as the reader scrolls (`visiblePage`) — but keyed off the *file* page
  // the visible SHEET shows, so it stays right after pages are rearranged.
  const currentOutlineId = useMemo(() => {
    if (!activeOutline || activeOutline.length === 0) return null;
    const sheet = pages[visiblePage - 1];
    const filePage = sheet && sheet.src === SELF ? sheet.page : visiblePage;
    let best: string | null = null;
    for (const { node } of flattenOutline(activeOutline)) {
      if (node.page != null && node.page <= filePage) best = node.id;
    }
    return best;
  }, [activeOutline, visiblePage, pages]);

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
  // native scrolling). Because the canvases resize asynchronously, we only
  // compute the cursor-anchored scroll target here and let the ResizeObserver
  // below apply it once the content has grown/shrunk.
  const onWheel = useCallback((e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    // A user zoom takes over; abandon any in-flight recompile scroll restore.
    restoreScroll.current = null;
    const rect = el.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    setScale((prev) => {
      const factor = e.deltaY < 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP;
      const next = clampPdfScale(prev * factor);
      if (next === prev) return prev;
      fittedRef.current = false; // manual zoom opts out of resize re-fit
      const eff = next / prev;
      pendingScroll.current = {
        top: (el.scrollTop + cursorY) * eff - cursorY,
        left: (el.scrollLeft + cursorX) * eff - cursorX,
      };
      return next;
    });
  }, []);

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
      const target = pendingScroll.current;
      if (target) {
        pendingScroll.current = null;
        el.scrollTop = target.top;
        el.scrollLeft = target.left;
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
    <div className="file-viewer-pdf-host" onKeyDown={onHostKeyDown}>
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
            setScale((s) => clampPdfScale(s / PDF_ZOOM_STEP));
          }}
          disabled={!doc || scale <= PDF_MIN_SCALE}
          title={t("imageZoom.zoomOutTitle")}
          aria-label={t("imageZoom.zoomOutTitle")}
        >
          −
        </button>
        <span className="file-viewer-zoom-level">{Math.round(scale * 100)}%</span>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => {
            fittedRef.current = false;
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
          onClick={() => doc && void fitWidth(doc)}
          disabled={!doc}
          title={t("pdfViewer.fitPageWidthTitle")}
        >
          {t("pdfViewer.fitWidthButton")}
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
            setCopySelecting(false);
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
              ✎ {t("pdfMarkup.toggle")}
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
      {marking && (
        <PdfMarkupBar markup={markup} page={visiblePage} onReload={reloadUnderMarks} onDone={leaveMarkup} />
      )}
      {marking && <PdfMarkupQuestions questions={markup.questions} pinned={pinnedQuestions} />}
      {/* A successful shot disarms the mode, so the bar outlives it just long
          enough to carry the busy/"copied" feedback the disarm would otherwise
          swallow. */}
      {(copySelecting || copyBusy || copyNotice) && (
        <div
          className="file-viewer-pdf-copy-bar"
          role="status"
          aria-live="polite"
        >
          {copySelecting && <span>{t("pdfViewer.copySelectionHint")}</span>}
          {copyBusy && <span>{t("pdfViewer.copySelectionWorking")}</span>}
          {copyNotice && <span className="file-viewer-pdf-copy-success">{copyNotice}</span>}
          <UntestedTag id="pdfViewer.8" />
        </div>
      )}
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
              ✕
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
              syncNotice.kind === "noMap"
                ? "pdfViewer.syncNoMapMsg"
                : syncNotice.kind === "pdfNewer"
                  ? "pdfViewer.syncPdfNewerMsg"
                  : syncNotice.kind === "stale"
                    ? "pdfViewer.syncStaleMsg"
                    : "pdfViewer.syncMissMsg",
              {
                files: syncNotice.sources.map((f) => basename(f)).join(", "),
              },
            )}
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
            <div className="file-viewer-pdf-pages" ref={contentRef}>
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
                    // SyncTeX only means anything for pages of the file itself: a
                    // page merged in from another PDF has no line in this source.
                    // Wired whether or not a map exists: without one the click
                    // explains itself (a "recompile" notice) instead of doing
                    // nothing. The crosshair cursor still only arms with a map.
                    onSyncClick={ref.src === SELF ? onSyncClick : undefined}
                    syncArmed={syncArmed}
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
                    copySelecting={copySelecting && !copyBusy}
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
                    onCopySelection={copySelection}
                    markup={marking ? markup.edit : null}
                    questionPins={
                      marking && ref.src === SELF && questionPins.has(i + 1)
                        ? { pins: questionPins.get(i + 1)!, focus: markup.questions.focus, onPick: pickQuestionPin }
                        : null
                    }
                    tickBadges={
                      marking && ref.src === SELF && tickBadges.has(i + 1)
                        ? { badges: tickBadges.get(i + 1)!, disabled: markup.sending, onApprove: (index, mark) => approveTick(i + 1, index, mark) }
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
  onReverseSource,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
  /** SyncTeX reverse-search host seam (see `PdfCanvas`). The TeX workspace passes
   *  it to keep a reverse click inside its own tab; a standalone PDF omits it. */
  onReverseSource?: (src: SyncSource, anchor: string) => void;
}) {
  // No ViewerHeader: the tab already shows the file name, so a filename row would
  // be redundant. The "Open externally" action lives in the PdfCanvas toolbar.
  return (
    <div className="file-viewer">
      <div className="file-viewer-body">
        <PdfCanvas
          path={path}
          onOpenExternally={onOpenExternally}
          tabKey={tabKey}
          groupId={groupId}
          onReverseSource={onReverseSource}
        />
      </div>
    </div>
  );
}
