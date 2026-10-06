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
 * Returns a cleanup. No-op where ResizeObserver is absent (jsdom).
 */
export function observeStripResize(el: HTMLElement, onChange: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const ro = new ResizeObserver(() => onChange());
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
    mo?.disconnect();
    ro.disconnect();
  };
}
