import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Pixel coordinates of a group's pane region, relative to its panel. */
export interface PaneRegionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type RectMap = Record<string, PaneRegionRect>;

function sameRects(a: RectMap, b: RectMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (!y || x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) {
      return false;
    }
  }
  return true;
}

/**
 * The measured pane regions of a split layout — the one copy of what the main
 * `CenterPanel`, the popout's `DetachedCenterPanel` and the root console each
 * carried. Every group body's rect (relative to `panelRef`) feeds the flat pane
 * layer, the split-preview overlay and the focus frame.
 *
 * `groupRects` are the bodies (the pane region); `groupFrameRects` span the
 * enclosing `.subwindow` (tab bar + body) with the right edge clamped to the
 * body's, so a docked files sidebar in the same body is left out of the focus
 * frame. A state write is skipped when a map is unchanged (a write re-renders
 * every pane).
 *
 * Re-measured after `layoutKey` / `scopeKey` change (the layout tree, the
 * scope), on panel/body resize, and on the DOM `resize` event — the
 * ResizeObserver misses OS-level window resizes on older WebKitGTK builds, and
 * `AppShell` bridges Tauri's reliable onResized/onScaleChanged into that event.
 * `measure` is returned for callers that know a layout settled (a divider drag).
 */
export function usePaneRects(
  panelRef: RefObject<HTMLElement | null>,
  bodyRefs: { readonly current: Map<string, HTMLElement> },
  layoutKey: unknown,
  scopeKey?: unknown,
): {
  groupRects: RectMap;
  groupFrameRects: RectMap;
  measure: () => void;
} {
  const [groupRects, setGroupRects] = useState<RectMap>({});
  const [groupFrameRects, setGroupFrameRects] = useState<RectMap>({});

  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const base = panel.getBoundingClientRect();
    const next: RectMap = {};
    const frames: RectMap = {};
    for (const [id, el] of bodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
      };
      // The enclosing subwindow box spans the tab header bar + body, so the
      // focus frame drawn from it wraps the current tab strip too. Clamp the
      // right edge to the pane region's right (`r`) so a docked files sidebar —
      // which lives in the same body, to the right of the pane — is excluded.
      const sub = el.closest(".subwindow");
      if (sub) {
        const sr = sub.getBoundingClientRect();
        frames[id] = {
          left: sr.left - base.left,
          top: sr.top - base.top,
          width: r.right - sr.left,
          height: sr.height,
        };
      }
    }
    setGroupRects((prev) => (sameRects(next, prev) ? prev : next));
    setGroupFrameRects((prev) => (sameRects(frames, prev) ? prev : frames));
  }, [panelRef, bodyRefs]);

  // Re-measure when the rendered layout tree changes — including a live drag's
  // collapse/restore, so siblings' reflowed rects are picked up immediately.
  useLayoutEffect(() => {
    measure();
  }, [measure, layoutKey, scopeKey]);

  // Re-measure on panel/body resize (split drags resize children without remount).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    for (const el of bodyRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, panelRef, bodyRefs, layoutKey, scopeKey]);

  // Re-measure on OS-window resize (see above).
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  return { groupRects, groupFrameRects, measure };
}
