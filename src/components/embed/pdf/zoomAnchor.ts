/**
 * The PDF viewer's zoom bounds, the cursor-anchored zoom preview's geometry, and
 * how a reopened PDF restores its zoom and scroll position.
 */


export const PDF_MIN_SCALE = 0.1;
export const PDF_MAX_SCALE = 8;
export const PDF_ZOOM_STEP = 1.2;
export const clampPdfScale = (s: number) => Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, s));

/** A zoom in progress: the scale the reader has wheeled to, previewed by scaling
 *  the page stack with CSS around the point under the cursor (in the stack's own
 *  untransformed coordinates), until it is committed (`PDF_ZOOM_COMMIT_MS`).
 *  Everything but `scale` is measured on the gesture's first tick and kept: it
 *  is what the commit anchors the scroll offset to (`commitZoomPreview`). */
export interface ZoomPreview {
  scale: number;
  originX: number;
  originY: number;
  /** The cursor at the first tick, relative to the scroller's padding box. */
  cursorX: number;
  cursorY: number;
  /** The scroll offset at the first tick: a plain scroll while the preview is
   *  up moves the origin point on screen by the difference. */
  scrollLeft: number;
  scrollTop: number;
  /** The stack's offset inside the scroll content (the scroller's padding) —
   *  the fallback anchor when no page wrap could be found under the cursor. */
  stackLeft: number;
  stackTop: number;
  /** The origin point as a fraction of the page wrap it lies on (or the nearest
   *  wrap's edge, when it lies in a gap). The inter-page gaps do not scale with
   *  the zoom, so a target expressed against the whole stack drifts by a gap
   *  per page above the cursor; one expressed against the page itself does not. */
  anchor: { wrap: HTMLElement; fx: number; fy: number } | null;
}

/** The scroll offset the page stack is moved to once it has relaid out after a
 *  zoom commit: either absolute, or "put this point of this page wrap under the
 *  cursor", resolved against the wrap's box at apply time (`anchoredScrollTarget`). */
export type PendingScroll =
  | { top: number; left: number }
  | { wrap: HTMLElement; fx: number; fy: number; cursorX: number; cursorY: number };

/** The page wrap under (`clientX`, `clientY`) in the stack, with the point as
 *  fractions of its box — or, for a point in a gap or beside the pages, the
 *  nearest wrap with the fraction clamped to its edge. `null` with no wraps. */
export function pageAnchorAt(
  stack: HTMLElement,
  clientX: number,
  clientY: number,
): { wrap: HTMLElement; fx: number; fy: number } | null {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  let below: HTMLElement | null = null;
  let last: HTMLElement | null = null;
  for (const wrap of stack.querySelectorAll<HTMLElement>(":scope > .file-viewer-pdf-page-wrap")) {
    const r = wrap.getBoundingClientRect();
    if (r.height <= 0 || r.width <= 0) continue;
    if (clientY >= r.top && clientY < r.bottom) {
      return { wrap, fx: clamp01((clientX - r.left) / r.width), fy: (clientY - r.top) / r.height };
    }
    if (clientY < r.top && !below) below = wrap;
    last = wrap;
  }
  const wrap = below ?? last;
  if (!wrap) return null;
  const r = wrap.getBoundingClientRect();
  return { wrap, fx: clamp01((clientX - r.left) / r.width), fy: below ? 0 : 1 };
}

/** Resolve an anchored scroll target against the wrap's live, relaid-out box.
 *  `null` when the wrap is gone (a reload replaced the pages meanwhile). */
export function anchoredScrollTarget(
  el: HTMLElement,
  a: Extract<PendingScroll, { wrap: HTMLElement }>,
): { top: number; left: number } | null {
  if (!a.wrap.isConnected) return null;
  const er = el.getBoundingClientRect();
  const wr = a.wrap.getBoundingClientRect();
  return {
    top: wr.top - er.top - el.clientTop + el.scrollTop + a.fy * wr.height - a.cursorY,
    left: wr.left - er.left - el.clientLeft + el.scrollLeft + a.fx * wr.width - a.cursorX,
  };
}

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
