/**
 * One sheet of the PDF viewer: the lazily rasterised page canvas and every layer
 * over it (links, remarks, text, SyncTeX and search highlights, blackout drag,
 * markup, question pins and ticks).
 */
import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PdfHighlight } from "../../../stores/viewers/pdfSync";
import { usePaneVisible } from "../../../lib/files/fileAccess";
import type { RedactRect, PdfNote } from "../../../lib/viewers/pageModel";
import { newNoteId, toPdfDate, isHighlight } from "../../../lib/viewers/pdfNotes";
import { fingerprintPage, samePage, type PageFingerprint } from "./pageFingerprint";
import { rectFromDrag, isDraggedFar, snapToText, type Rect } from "../../../lib/viewers/redact";
import { loadPageLinks, type PdfLink } from "./links";
import { pageTextItemBoxesUnturned } from "./pageText";
import { PdfNoteLayer, type NoteMenuState, type NoteEditState } from "./PdfNoteLayer";
import { PdfTextLayer } from "./PdfTextLayer";
import { PdfSelectionBar, selectionBarPos } from "./PdfSelectionBar";
import { scrollIntoPdfBox } from "./scrollBox";
import { PdfMarkupLayer } from "./PdfMarkupLayer";
import { PdfQuestionPins } from "./PdfMarkupQuestions";
import { PdfTickBadges, type TickBadge } from "./PdfMarkupTicks";
import type { MarkupEdit, QuestionFocus } from "./usePdfMarkup";
import type { QuestionPin } from "../../../lib/viewers/markupQuestions";
import { UntestedTag } from "../../common/UntestedTag";
import {
  viewportToSyncPoint,
  syncRectToViewport,
  bigPointsToCssRect,
  refineToWord,
  type SyncRect,
  type TextItemBox,
} from "../../../lib/viewers/tex/tex";
import { useT } from "../../../lib/i18n";
import { pdfRasterRatio } from "./raster";

/** How long a painted page keeps its canvas after its pane is hidden. Long
 *  enough that flipping to another tab and back repaints nothing; short enough
 *  that a PDF left behind a terminal for a while does give its memory up (a
 *  near page at fit width on a 2× screen is tens of MB). Mirrors the terminal's
 *  `RENDERER_RELEASE_MS`. */
export const PDF_PAGE_RELEASE_MS = 30_000;

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
export const ANNOT_MODE = pdfjs.AnnotationMode.ENABLE_STORAGE;

/** The two viewports SyncTeX geometry converts between (`syncRectToViewport`,
 *  `viewportToSyncPoint`): the page as drawn at `scale` — its own `/Rotate` (a
 *  `pdflscape` sheet) plus the viewer's turn `rot` — and the page's unturned
 *  space at scale 1, where SyncTeX's big points live. */
function syncViewports(page: PDFPageProxy, scale: number, rot: number) {
  return {
    turned: page.getViewport({ scale, rotation: (((page.rotate + rot) % 360) + 360) % 360 }),
    unturned: page.getViewport({ scale: 1, rotation: 0 }),
  };
}

/** One PDF page rendered to a canvas at `scale` (× devicePixelRatio for
 *  crispness). Re-renders when the page or scale changes; cancels an in-flight
 *  render on cleanup so rapid zooming doesn't paint stale frames. */
export function PdfPageCanvas({
  doc,
  pageNumber,
  rot = 0,
  scale,
  cssSize,
  onSyncClick,
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
  hiddenHighlights = "",
  selBar,
  textItems,
  onRedactAdd,
  onRedactRemove,
  onNeedNotes,
  onNoteAdd,
  onNoteUpdate,
  onNoteDelete,
  markup,
  questionPins,
  tickBadges,
  onSize,
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
  /** The page's own scale-1 size turned out to differ from `cssSize`: a reload
   *  kept the reserved sizes (same page count, same first and last page) and
   *  this page, in the middle, was the one the build resized. Reported from the
   *  fetch the render needs anyway, so the reservation and every layer laid out
   *  by it (remarks, markup, copy region) follow the page as drawn. */
  onSize?: (size: { w: number; h: number }) => void;
  /** SyncTeX reverse search: a click maps to big points in this page's own,
   *  unturned space. */
  onSyncClick?: (page: number, xBp: number, yBp: number) => void;
  /** SyncTeX forward search: when this page is the target, the box (big points,
   *  the page's unturned space) to scroll into view and flash. `nonce`
   *  re-triggers a repeat reveal.
   *  `phrase`, when set, narrows the box to the clicked word via the page's text
   *  content (using the surrounding words to disambiguate). */
  highlight?: PdfHighlight | null;
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
    onApprove: (marks: TickBadge["marks"]) => void;
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
  const [clickMark, setClickMark] = useState<{
    left: number;
    top: number;
    nonce: number;
    /** The page is drawn turned (its `/Rotate`, or a turn in the viewer). */
    turned?: boolean;
  } | null>(null);
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
  // Whether the pane this page sits in is on screen. A hidden pane
  // (`display:none`) reports every page as not intersecting, which used to
  // release every painted page the moment the reader switched tabs — and
  // re-decode and repaint all of them on the way back. Read through a ref by the
  // observer callback and the render effect, so neither re-runs on a tab switch.
  const paneVisible = usePaneVisible();
  const paneVisibleRef = useRef(paneVisible);
  paneVisibleRef.current = paneVisible;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // A page that leaves the margin because its PANE was hidden keeps its pixels
    // for `PDF_PAGE_RELEASE_MS` (the terminal's `RENDERER_RELEASE_MS` pattern):
    // flipping to another tab and back costs nothing, a tab left behind for a
    // while still gives its canvases up. On show the observer reports again —
    // a page still near is kept, one the pane is no longer near is released
    // then, as a scroll-away would have.
    let holdTimer: number | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          if (holdTimer != null) window.clearTimeout(holdTimer);
          holdTimer = null;
          setNear(true);
          return;
        }
        if (!paneVisibleRef.current) {
          if (holdTimer == null) {
            holdTimer = window.setTimeout(() => {
              holdTimer = null;
              setNear(false);
            }, PDF_PAGE_RELEASE_MS);
          }
          return;
        }
        if (holdTimer != null) window.clearTimeout(holdTimer);
        holdTimer = null;
        setNear(false);
      },
      // A screenful either side paints a page before it scrolls into view (no
      // blank flash in normal scrolling) and drops it once well past — about
      // three pages at fit width, rather than the four or five a wider margin
      // held (and rebuilt) at once.
      { root: null, rootMargin: "100% 0px" },
    );
    io.observe(el);
    return () => {
      if (holdTimer != null) window.clearTimeout(holdTimer);
      io.disconnect();
    };
  }, []);

  // A near page whose document changed while its pane was hidden is NOT
  // repainted there (work in a hidden pane); the render effect notes it and
  // this re-runs it on show, where the fingerprint decides whether the pixels
  // can stay. A counter rather than `paneVisible` in the effect's deps, so a
  // plain tab flip with nothing changed re-runs nothing.
  const [catchUp, setCatchUp] = useState(0);
  const hiddenStale = useRef(false);
  useEffect(() => {
    if (!paneVisible || !hiddenStale.current) return;
    hiddenStale.current = false;
    setCatchUp((n) => n + 1);
  }, [paneVisible]);

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
  // The document whose page this canvas last fetched to draw (or compare) —
  // the one a scroll-away's `cleanup()` has something to give back for.
  const touchedDoc = useRef<PDFDocumentProxy | null>(null);
  // Read by the render effect without being among its deps: a corrected
  // reservation must not repaint the page that corrected it.
  const cssSizeRef = useRef(cssSize);
  cssSizeRef.current = cssSize;
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;

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
      //
      // Only for a document this canvas has actually drawn from: a reload hands
      // every page a fresh document, and fetching a page this canvas never
      // touched just to clean it was a worker round trip per page per build.
      if (touchedDoc.current === doc) {
        touchedDoc.current = null;
        void doc.getPage(pageNumber).then((p) => p.cleanup()).catch(() => {});
      }
      return;
    }
    if (!paneVisibleRef.current) {
      // Held while its pane is hidden (see the observer above): whatever changed
      // — a recompile's new document, a turn — is painted on show, not now.
      hiddenStale.current = true;
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
      touchedDoc.current = doc;
      const rotation = (((page.rotate + rot) % 360) + 360) % 360;
      // The reserved box was measured once per document, or kept across a
      // reload whose ends did not change (`measuredRef` in the viewer); a page
      // the build resized in between is caught here, from the page already in
      // hand, and the viewer corrects the reservation.
      const reserved = cssSizeRef.current;
      if (reserved) {
        const natural = page.getViewport({ scale: 1, rotation });
        if (reserved.w !== natural.width || reserved.h !== natural.height) {
          onSizeRef.current?.({ w: natural.width, h: natural.height });
        }
      }
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
  }, [doc, pageNumber, rot, scale, near, hiddenHighlights, catchUp]);

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

  // SyncTeX speaks the page's own, unturned space; the canvas is drawn turned.
  // The page proxy gives both viewports (`syncViewports`). Fetched while a
  // highlight is up here — pdf.js hands back the page it already holds — and
  // `page: null` when the fetch failed (a read mid-compile), which falls back to
  // the plain scale mapping rather than showing nothing.
  // Held with the document it came from: a recompile's reveal arrives with the
  // NEW document, whose page may be turned or sized differently, so a geometry
  // from the old one is not ready for it.
  const [syncGeom, setSyncGeom] = useState<{
    doc: PDFDocumentProxy;
    page: PDFPageProxy | null;
  } | null>(null);
  const wantSyncGeom = highlight != null;
  useEffect(() => {
    if (!wantSyncGeom) return;
    let cancelled = false;
    doc.getPage(pageNumber).then(
      (page) => { if (!cancelled) setSyncGeom({ doc, page }); },
      () => { if (!cancelled) setSyncGeom({ doc, page: null }); },
    );
    return () => { cancelled = true; };
  }, [doc, pageNumber, wantSyncGeom]);
  const geom = syncGeom?.doc === doc ? syncGeom : null;

  // Narrow the SyncTeX line box to the clicked word: pull this page's text runs
  // (big points, top-left origin, at viewport scale 1, UNTURNED — the space the
  // SyncTeX box is in) and find the word nearest the line box. Best-effort — on
  // no match (or no word) the original box stands.
  useEffect(() => {
    setRefined(null);
    const phrase = highlight?.phrase;
    if (!highlight || !phrase) return;
    let cancelled = false;
    (async () => {
      try {
        const items = await pageTextItemBoxesUnturned(doc, pageNumber);
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

  // Scroll a forward-search target into view on a new nonce, once its box can be
  // placed (the page geometry above is a fetch away). Center the highlight
  // *box*, not the whole page — on a tall page the target line can sit far from
  // page-center, which is what made the jump feel imprecise. Scoped to the
  // reader's own scroller (`scrollIntoPdfBox`): `scrollIntoView` also scrolls
  // the `overflow: hidden` pane and tab hosts above it, which is what displaced
  // the whole pane — and the fit-to-width page inside it — on a jump.
  // A pane hidden behind another tab cannot scroll (`scrollIntoPdfBox` says so),
  // so the reveal is retried when the pane is shown; `onReveal` still fires once.
  const revealedNonce = useRef<number | null>(null);
  const announcedNonce = useRef<number | null>(null);
  const syncGeomReady = geom != null;
  useEffect(() => {
    if (!highlight || !syncGeomReady || !paneVisible || revealedNonce.current === highlight.nonce) return;
    if (announcedNonce.current !== highlight.nonce) {
      announcedNonce.current = highlight.nonce;
      onReveal?.();
    }
    const target = boxRef.current ?? wrapRef.current;
    if (target && scrollIntoPdfBox(target, "center")) revealedNonce.current = highlight.nonce;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce, syncGeomReady, paneVisible]);

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
    const left = clientX - rect.left;
    const top = clientY - rect.top;
    // Mark the clicked point so the source-jump has feedback on the PDF side; the
    // canvas sits flush at the wrapper's top-left, so canvas-local offsets are
    // wrapper-local. Clear any prior marker's timer and fade out after ~2s.
    setClickMark((m) => ({ left, top, nonce: (m?.nonce ?? 0) + 1 }));
    if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => setClickMark(null), 2000);
    // The point as drawn → the page's unturned space, through the page's own
    // viewports (a turned sheet, a crop box off the origin). A failed page read
    // falls back to the plain scale mapping, right for an unturned page.
    void doc.getPage(pageNumber).then(
      (page) => {
        const { turned, unturned } = syncViewports(page, scale, rot);
        const p = viewportToSyncPoint(turned, unturned, left, top);
        if (turned.rotation !== 0) setClickMark((m) => (m ? { ...m, turned: true } : m));
        onSyncClick(pageNumber, p.x, p.y);
      },
      () => onSyncClick(pageNumber, left / scale, top / scale),
    );
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

  const syncTarget = highlight ? refined ?? highlight.rect : null;
  const syncView = geom?.page ? syncViewports(geom.page, scale, rot) : null;
  const box =
    syncTarget && geom
      ? syncView
        ? syncRectToViewport(syncTarget, syncView.turned, syncView.unturned)
        : bigPointsToCssRect(syncTarget, scale)
      : null;

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
        // The reverse-search cursor shows only while the reader's scroller is
        // armed (`data-sync-armed`, Ctrl/⌘ held) — CSS, so arming renders nothing.
        className={`file-viewer-pdf-page${onSyncClick ? " is-syncable" : ""}`}
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
      {box && (
        // Untested pills ride the mark they are about, for as long as it is up.
        <span className="file-viewer-pdf-sync-pills" style={{ left: box.left, top: box.top + box.height + 2 }}>
          <UntestedTag id="pdfViewer.syncHighlightClears" />
          {syncView && syncView.turned.rotation !== 0 && <UntestedTag id="pdfViewer.syncTurnedPage" />}
        </span>
      )}
      {clickMark && (
        <div
          key={`click-${clickMark.nonce}`}
          className="file-viewer-pdf-click-mark"
          style={{ left: clickMark.left, top: clickMark.top }}
        />
      )}
      {clickMark?.turned && (
        <span className="file-viewer-pdf-sync-pills" style={{ left: clickMark.left, top: clickMark.top + 12 }}>
          <UntestedTag id="pdfViewer.syncTurnedPage" />
        </span>
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
          remarks included, which it leaves visible but out of reach. Only on a
          near page: its canvas is a full-resolution backing store. */}
      {markup && cssSize && near && (
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
