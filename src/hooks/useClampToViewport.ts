import { useLayoutEffect, type RefObject } from "react";

/**
 * Keeps a fixed-position popup (context menu, dropdown) inside the viewport.
 * Popups are positioned at a cursor/anchor point and grow right/down, so one
 * opened near the window's right or bottom edge clips off-screen. Measures
 * the rendered element once mounted, and again whenever it resizes, and shifts
 * it back in. Guarded so the corrective set doesn't loop (it re-runs, finds
 * nothing to fix, stops).
 *
 * `axis: "x"` clamps horizontally only — for a popup that must stay visually
 * attached to the button below which it opened (the tab "+" menu). Shifting
 * such a menu up detaches it from its anchor and lays it over the bar it came
 * from; the caller instead caps its height so the content scrolls in place.
 */
export function useClampToViewport<T extends { x: number; y: number }>(
  ref: RefObject<HTMLElement | null>,
  pos: T | null,
  setPos: (updater: (p: T | null) => T | null) => void,
  { margin = 8, axis = "both" }: { margin?: number; axis?: "both" | "x" } = {},
) {
  useLayoutEffect(() => {
    if (!pos) return;
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      let nx = pos.x;
      let ny = pos.y;
      if (rect.right > window.innerWidth - margin) {
        nx = Math.max(margin, window.innerWidth - margin - rect.width);
      }
      if (axis === "both" && rect.bottom > window.innerHeight - margin) {
        ny = Math.max(margin, window.innerHeight - margin - rect.height);
      }
      if (nx !== pos.x || ny !== pos.y) {
        setPos((p) => (p ? { ...p, x: nx, y: ny } : p));
      }
    };
    clamp();
    // A popup can grow after it mounts (an async option list widening a
    // <select>, a field gaining lines); re-clamp whenever its box changes.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pos, ref, setPos, margin, axis]);
}
