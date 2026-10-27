/**
 * Call `onChange` whenever a horizontally-scrolling strip's overflow can have
 * changed size-wise: the strip's own box resizing, AND any of its children
 * resizing. Observing only the strip misses the second case — once the strip
 * has shrunk to its cap, a child growing (a tab's width transition, a badge
 * or spinner appearing, a renamed title, a drop slot opening) raises
 * `scrollWidth` without resizing the strip, so its overflow chevron/fade never
 * turned on while the last item sat half hidden. Children added later are
 * observed too (MutationObserver), so this also covers items arriving.
 *
 * A strip that sits at its far end stays there while its content resizes:
 * closing the rightmost tab clamps the scroll position, and the new last tab
 * (now active, so bolder and wider, with a `max-width` transition) keeps
 * growing afterwards — without this it ends up half hidden past the edge.
 * Scrolling away from the end by any means lifts the pin.
 *
 * Returns a cleanup. No-op where ResizeObserver is absent (jsdom).
 */
export function observeStripResize(el: HTMLElement, onChange: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const isAtEnd = () => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
  let pinnedToEnd = isAtEnd();
  const onScroll = () => {
    pinnedToEnd = isAtEnd();
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  const ro = new ResizeObserver(() => {
    if (pinnedToEnd && !isAtEnd()) el.scrollLeft = el.scrollWidth;
    onChange();
  });
  ro.observe(el);
  for (const child of Array.from(el.children)) ro.observe(child);
  const mo =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          for (const r of records) {
            r.addedNodes.forEach((n) => {
              if (n instanceof Element) ro.observe(n);
            });
            r.removedNodes.forEach((n) => {
              if (n instanceof Element) ro.unobserve(n);
            });
          }
          onChange();
        });
  mo?.observe(el, { childList: true });
  return () => {
    el.removeEventListener("scroll", onScroll);
    mo?.disconnect();
    ro.disconnect();
  };
}
