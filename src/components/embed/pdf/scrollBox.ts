/**
 * Scrolling the PDF reader to a spot on a page — inside the PDF's own scroll box
 * and NOWHERE else.
 *
 * `Element.scrollIntoView` is the obvious way to do this and the wrong one here:
 * it walks up and scrolls EVERY scrollable ancestor, and an `overflow: hidden`
 * box counts as one. The PDF pane sits inside several (`.file-viewer` itself,
 * and the tab host above it), which scroll perfectly well programmatically and
 * then show no scrollbar to scroll back with — so a SyncTeX jump that had to
 * move the view at all pushed the toolbar, the page, and the pane's own chrome
 * off their container and left them there, with the fit-to-width page no longer
 * centred in a pane that was itself displaced. Nothing short of a resize or a
 * re-render put it back.
 *
 * So: address the scroller directly, and move only what has to move — the
 * vertical axis, plus a horizontal nudge only when the target is genuinely out
 * of view (what `inline: "nearest"` is for, and what a zoomed-in page still
 * needs). At fit-to-width there is no horizontal overflow, so `scrollLeft`
 * stays where it is and the page stays centred.
 */

/** The reader's scroll box: the one element in the chain allowed to move. */
const SCROLL_BOX = ".file-viewer-pdf-scroll";

/** Sub-pixel slack, so a rounding-width difference is not a reason to scroll. */
const EPS = 1;

/**
 * Bring `el` into view within the PDF scroll box that contains it.
 *
 * `block: "center"` centres it in the scrollport (the SyncTeX highlight and the
 * current search hit — a target line means nothing parked at the very edge);
 * `block: "start"` puts its top at the scrollport's top (a page jump). Both
 * mirror the `scrollIntoView` options they replace. No-op when `el` is not
 * inside a scroll box (a detached node, or the present window, which mounts its
 * own single-sheet view). Returns whether it could place `el` — false for no
 * scroll box or one not laid out (a hidden pane), so a caller can retry on show.
 */
export function scrollIntoPdfBox(el: HTMLElement, block: "center" | "start"): boolean {
  const box = el.closest<HTMLElement>(SCROLL_BOX);
  if (!box) return false;
  // Not laid out (a pane still hidden behind another tab): every rect below reads
  // zero, and scrolling to "0" would throw the reader's position away for a jump
  // that cannot be shown yet. `scrollIntoView` was a no-op here too.
  if (box.clientHeight === 0) return false;
  const elRect = el.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();

  // Padding-box coordinates: `scrollTop`/`scrollLeft` are measured from the
  // padding edge, which is `clientTop`/`clientLeft` inside the border box the
  // rects report.
  const top = elRect.top - boxRect.top - box.clientTop + box.scrollTop;
  box.scrollTop =
    block === "center" ? top - (box.clientHeight - elRect.height) / 2 : top;

  // Horizontal: "nearest" — leave the axis alone unless the target is off the
  // edge, and then move by the least that shows it. A target wider than the
  // scrollport aligns to its left edge, as the native behaviour does.
  const left = elRect.left - boxRect.left - box.clientLeft + box.scrollLeft;
  const right = left + elRect.width;
  if (left < box.scrollLeft - EPS) box.scrollLeft = left;
  else if (right > box.scrollLeft + box.clientWidth + EPS) {
    box.scrollLeft = Math.min(left, right - box.clientWidth);
  }
  return true;
}
