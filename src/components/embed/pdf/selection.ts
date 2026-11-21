/**
 * What the reader has selected on a page, as geometry this viewer can act on
 * (#pdf-textselect).
 *
 * Selecting text in a PDF is the browser's own job here — the text layer puts a
 * transparent, correctly-placed span over every run of glyphs, and from there an
 * ordinary drag, a double-click on a word and Ctrl+A are the engine's. What this
 * module adds is the translation back: a DOM `Range` is a set of client rectangles on
 * screen, and everything downstream of a selection in this viewer (a highlight
 * annotation, the boxes it is drawn as, the `/QuadPoints` it is saved as) is measured
 * in **big points from a page's top-left**, the space the blackout marks, the search
 * hits and the link boxes already live in.
 *
 * Three things about it are decisions rather than mechanics.
 *
 * **A selection is read per page, not per document.** A drag that crosses a page break
 * is one selection to the browser and two annotations to a PDF, because an annotation
 * belongs to a page. So the rects are sorted into the page wrappers they land in and
 * clipped to them, which makes the cross-page case fall out of the same code as the
 * ordinary one rather than being a case nobody tested.
 *
 * **Line rects are merged, and only along a line.** `Range.getClientRects()` hands
 * back one rectangle per *text node fragment*, so a sentence that crosses a font
 * change, a `\emph` or a ligature run arrives as four or five boxes on the same line —
 * which as `/QuadPoints` would be four or five overlapping quads, drawn on top of one
 * another and, at 40% opacity each, several shades darker at every seam. Merging by
 * line fixes both the appearance and the annotation. Merging *across* lines is
 * deliberately not done: a highlight's quads are per line by definition, and a box
 * spanning two of them would paint the margin between them.
 *
 * **Nothing here reads the page's text content.** The words come out of the DOM
 * selection the reader made, which is the same string Ctrl+C would put on the
 * clipboard — so what a highlight quotes and what a copy produces cannot disagree.
 */
import type { PdfQuad } from "../../../lib/viewers/pageModel";

/** The class the viewer's page wrappers carry. Kept here rather than passed in: this
 *  module's whole job is to map screen rectangles onto those elements, so it is not
 *  reusable without them and pretending otherwise would only hide the coupling. */
export const PAGE_WRAP_CLASS = "file-viewer-pdf-page-wrap";

/** One page's share of a selection. */
export interface PageSelection {
  /** The page's index in the arrangement — what the caller maps to an entry. */
  index: number;
  /** The selected boxes on that sheet, in big points from its top-left. */
  quads: PdfQuad[];
}

/** A selection, sorted onto the sheets it covers. */
export interface ViewerSelection {
  /** Every sheet the selection touches, in document order. Never empty. */
  pages: PageSelection[];
  /** The selected words, exactly as the engine reports them. */
  text: string;
  /** The sheet the drag *ended* on — where the bar belongs, because that is where
   *  the pointer was let go and where the reader is looking. */
  focusIndex: number;
  /** Where on that sheet to hang the bar (big points): the middle of the last line's
   *  top edge, so it sits over the end of what was selected. */
  barX: number;
  barY: number;
}

/** Two boxes are on the same line when they overlap vertically by most of the shorter
 *  one's height. A ratio rather than an absolute tolerance, so it means the same for a
 *  footnote and for a title. */
function sameLine(a: DOMRect, b: DOMRect): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlap > 0.5 * Math.min(a.height, b.height);
}

/**
 * Merge a page's client rectangles into one box per line.
 *
 * The gap tolerance is in CSS pixels *before* the scale is divided out, i.e. a
 * distance on screen: two fragments of one word are a hair apart at 40% and a
 * centimetre apart at 400%, and the question being asked ("is there a space between
 * these?") is about the document, so the threshold is scaled with it.
 */
function mergeLine(rects: DOMRect[], gap: number): DOMRect[] {
  const out: DOMRect[] = [];
  for (const r of [...rects].sort((a, b) => a.left - b.left)) {
    const last = out[out.length - 1];
    if (last && r.left <= last.right + gap) {
      const right = Math.max(last.right, r.right);
      const top = Math.min(last.top, r.top);
      const bottom = Math.max(last.bottom, r.bottom);
      out[out.length - 1] = new DOMRect(last.left, top, right - last.left, bottom - top);
      continue;
    }
    out.push(r);
  }
  return out;
}

/** Group a page's rectangles into lines, top to bottom, and merge each. */
export function mergeSelectionRects(rects: DOMRect[], gap: number): DOMRect[] {
  const lines: DOMRect[][] = [];
  for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines.find((l) => sameLine(l[0], r));
    if (line) line.push(r);
    else lines.push([r]);
  }
  return lines.flatMap((l) => mergeLine(l, gap));
}

/** The class of the text layer whose spans are the selectable words. */
const TEXT_LAYER_SELECTOR = ".file-viewer-pdf-text-layer";

/**
 * The on-screen boxes of the *selected text* in `range`, inside the text layers under
 * `container` — and nothing else.
 *
 * Not `range.getClientRects()`, which also returns the border box of every element
 * the range fully contains: while a drag is under way each layer's `endOfContent`
 * block (`textSelection.ts`) covers its whole page, so a selection crossing a page
 * break would have handed back a page-sized rectangle — and a page-sized highlight.
 * Measuring each selected text node on its own leaves every element box out by
 * construction. Only the text layers are walked: they exist on near pages only, and
 * nothing outside a page survives the clipping below anyway.
 */
export function selectedTextRects(container: HTMLElement, range: Range): DOMRect[] {
  const out: DOMRect[] = [];
  for (const layer of Array.from(container.querySelectorAll(TEXT_LAYER_SELECTOR))) {
    if (!range.intersectsNode(layer)) continue;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      const part = document.createRange();
      part.selectNodeContents(n);
      if (n === range.startContainer) part.setStart(n, range.startOffset);
      if (n === range.endContainer) part.setEnd(n, range.endOffset);
      if (part.collapsed) continue;
      out.push(...Array.from(part.getClientRects()));
    }
  }
  return out;
}

/** The page wrapper an element sits in, or null. Walks up rather than matching a
 *  parent directly: the selection's focus is usually a text node inside a span. */
function wrapOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest(`.${PAGE_WRAP_CLASS}`) ?? null;
}

/**
 * The selection is in something the reader is *writing in* rather than on the page.
 *
 * This is not a nicety. A remark card is a child of the page wrapper it belongs to, so
 * selecting a word inside its textarea to retype it lands squarely inside that
 * wrapper's box — and without this the bar would appear over the page offering to
 * highlight the sentence the reader is in the middle of editing. Checked on both ends
 * of the selection, since a drag can start in a field and finish outside it.
 */
function inEditableChrome(sel: Selection): boolean {
  const isChrome = (node: Node | null) => {
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    return !!el?.closest("input, textarea, [contenteditable], .file-viewer-pdf-note-card");
  };
  return isChrome(sel.anchorNode) || isChrome(sel.focusNode);
}

/**
 * The current selection, sorted onto the page wrappers inside `container`, or null
 * when there is nothing usable selected.
 *
 * "Nothing usable" covers more than an empty selection: a collapsed caret, a selection
 * of only whitespace (a drag through the gap between two paragraphs), and one whose
 * boxes all miss the pages — which is what a selection in the toolbar or in a remark
 * card looks like from here, and which must not be mistaken for a selection on paper.
 */
export function readViewerSelection(
  container: HTMLElement,
  scale: number,
): ViewerSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  if (inEditableChrome(sel)) return null;

  const wraps = Array.from(container.querySelectorAll<HTMLElement>(`.${PAGE_WRAP_CLASS}`));
  if (wraps.length === 0) return null;
  // One rect list for the whole selection (its text only — `selectedTextRects`),
  // then sorted onto the sheets: a range's rectangles are in screen space and know nothing about pages, so the boxes are the
  // only thing that can say which sheet a fragment of the drag landed on.
  const rects: DOMRect[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    rects.push(...selectedTextRects(container, sel.getRangeAt(i)));
  }
  if (rects.length === 0) return null;

  const focusWrap = wrapOf(sel.focusNode) ?? wrapOf(sel.anchorNode);
  const pages: PageSelection[] = [];
  let focusIndex = -1;
  let barX = 0;
  let barY = 0;

  wraps.forEach((wrap, index) => {
    const box = wrap.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    // Clipped to the sheet, so a rect that straddles the gap between two pages
    // contributes to each of them only what actually lies on paper.
    const onPage: DOMRect[] = [];
    for (const r of rects) {
      const left = Math.max(r.left, box.left);
      const top = Math.max(r.top, box.top);
      const right = Math.min(r.right, box.right);
      const bottom = Math.min(r.bottom, box.bottom);
      if (right - left <= 0.5 || bottom - top <= 0.5) continue;
      onPage.push(new DOMRect(left, top, right - left, bottom - top));
    }
    if (onPage.length === 0) return;
    const merged = mergeSelectionRects(onPage, 2);
    const quads = merged.map((r) => ({
      x: (r.left - box.left) / scale,
      y: (r.top - box.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    }));
    pages.push({ index, quads });
    // The bar hangs off the last line of the sheet the drag ended on — or, when the
    // focus is somewhere this loop cannot see (a selection restored by Ctrl+A, whose
    // focus node is the container), off the last sheet with anything on it.
    if (wrap === focusWrap || focusIndex < 0 || focusWrap == null) {
      const last = merged[merged.length - 1];
      focusIndex = index;
      barX = (last.left + last.width / 2 - box.left) / scale;
      barY = (last.top - box.top) / scale;
    }
  });

  if (pages.length === 0 || focusIndex < 0) return null;
  return { pages, text, focusIndex, barX, barY };
}
