/**
 * DOM helpers for the contextual hints: which element a hint's selector means
 * right now, whether the user can see it, and where its bubble goes. Kept apart
 * from `HintHost` (timing) and `HintBubble` (painting) so the geometry is pure
 * and unit-testable.
 */

/** Room the bubble needs when it is placed above or below its target. */
export const BUBBLE_W = 280;
const BUBBLE_H = 170;
const EDGE = 8;

/** First element matching `selector` that has a box on screen, or null. The
 *  first match alone is not enough: a selector like `.tab-bar` hits every
 *  subwindow, and hidden panes (`display:none`) keep their DOM. */
export function firstVisibleAnchor(selector: string, doc: Document = document): Element | null {
  let nodes: NodeListOf<Element>;
  try {
    nodes = doc.querySelectorAll(selector);
  } catch {
    return null;
  }
  const win = doc.defaultView;
  const vw = win?.innerWidth ?? 0;
  const vh = win?.innerHeight ?? 0;
  for (const el of Array.from(nodes)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
    return el;
  }
  return null;
}

/** A dialog is open: the hint layer sits below `.modal-backdrop`, so a bubble
 *  would be painted behind it. */
export function modalOpen(doc: Document = document): boolean {
  return doc.querySelector(".modal-backdrop") !== null;
}

/** True while the user can actually see the hint's target and nothing covers it
 *  with a dialog. */
export function anchorOnScreen(selector: string, doc: Document = document): boolean {
  return !modalOpen(doc) && firstVisibleAnchor(selector, doc) !== null;
}

export interface BubblePlacement {
  left: number;
  top: number;
  /** Shift the bubble up by its own height (it sits above the target). */
  above: boolean;
}

/** Where the bubble goes for a target `rect`. Prefers `placement`, flips to the
 *  other side when that one would leave the window, and for a target that fills
 *  the window (a pane, a rail) tucks the bubble inside its top edge. */
export function placeBubble(
  rect: Pick<DOMRect, "left" | "top" | "bottom">,
  placement: "top" | "bottom",
  vw: number,
  vh: number,
): BubblePlacement {
  const left = Math.max(EDGE, Math.min(rect.left, vw - BUBBLE_W - EDGE));
  const fitsBelow = rect.bottom + EDGE + BUBBLE_H <= vh;
  const fitsAbove = rect.top - EDGE - BUBBLE_H >= 0;
  const above: BubblePlacement = { left, top: rect.top - EDGE, above: true };
  const below: BubblePlacement = { left, top: rect.bottom + EDGE, above: false };
  const order = placement === "top" ? [[fitsAbove, above], [fitsBelow, below]] as const
    : [[fitsBelow, below], [fitsAbove, above]] as const;
  for (const [fits, spot] of order) if (fits) return spot;
  // Neither side has room: sit just inside the target's top edge.
  return { left, top: Math.max(EDGE, Math.min(rect.top + EDGE, vh - BUBBLE_H - EDGE)), above: false };
}
