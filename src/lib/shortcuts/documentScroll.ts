/**
 * Scrolling a document tab from the keyboard — steering's scroll level on a
 * tab that is not a terminal (a PDF, Markdown, code, a table…).
 *
 * Every viewer draws its document in its own scrolling box, so rather than
 * know each one, steering scrolls the largest box in the tab's pane that
 * scrolls vertically. Toolbars, outlines and thumbnail strips scroll too, but
 * the document's box is the biggest. The box keeps its place when steering
 * leaves the level: unlike a terminal, nothing types into it.
 */

/** How many elements the search for the scrolling box looks at, at most —
 *  a PDF's text layers hold thousands of spans, none of them the box. */
const SEARCH_LIMIT = 3000;

function scrolls(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
}

/** The active tab's pane on screen: a tab key can sit in several scopes'
 *  panes (the hidden ones are zero-sized), and the root overlay's attach-only
 *  panes carry no scope. */
function paneFor(scope: string, tabKey: string): HTMLElement | null {
  const panes = Array.from(
    document.querySelectorAll<HTMLElement>(`.center-pane[data-tab-key="${CSS.escape(tabKey)}"]`),
  );
  return (
    panes.find((el) => {
      const own = el.dataset.scopeKey;
      if (own !== undefined && own !== scope) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) ?? null
  );
}

/**
 * The document's scrolling box in the tab's pane — the largest that can
 * scroll now — or null when nothing in it scrolls (a short file, a picture,
 * a page in a frame).
 */
export function documentScroller(scope: string, tabKey: string): HTMLElement | null {
  const pane = paneFor(scope, tabKey);
  if (!pane) return null;
  let best: HTMLElement | null = null;
  let bestArea = 0;
  // Breadth first and never into a box already found: the document's box sits
  // near the top, and what it holds is the document itself.
  const queue: HTMLElement[] = [pane];
  for (let seen = 0; queue.length > 0 && seen < SEARCH_LIMIT; seen++) {
    const el = queue.shift()!;
    if (el !== pane && scrolls(el)) {
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea || !best) {
        best = el;
        bestArea = area;
      }
      continue;
    }
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) queue.push(child);
    }
  }
  return best;
}

/** Scroll the document `pages` screens (negative = up). False when nothing
 *  in the tab scrolls. */
export function scrollDocument(scope: string, tabKey: string, pages: number): boolean {
  const box = documentScroller(scope, tabKey);
  if (!box || pages === 0) return false;
  // A little under a whole screen, so a line read last stays in sight.
  box.scrollTop += Math.sign(pages) * Math.max(1, Math.round(box.clientHeight * Math.abs(pages) * 0.9));
  return true;
}

/** To the document's end. */
export function scrollDocumentToEnd(scope: string, tabKey: string): void {
  const box = documentScroller(scope, tabKey);
  if (box) box.scrollTop = box.scrollHeight;
}
