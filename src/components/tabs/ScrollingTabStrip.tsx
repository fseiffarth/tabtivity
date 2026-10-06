import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { observeStripResize } from "../../lib/observeStripResize";

/**
 * The horizontally-scrolling tab strip + flanking chevrons — the SAME overflow
 * behaviour as the main window's `TabBar` (click-scroll, continuous hover-scroll,
 * wheel-to-horizontal, chevrons that appear only on overflow). Its own component
 * so each bar gets its own strip ref + scroll state, exactly as each main-window
 * `TabBar` instance does: every group's bar in a (possibly multi-pane) popout
 * (`DetachedCenterPanel`) and the mail window's bar (`MailOverlay`). The bar div
 * and its drag handling stay with the caller; this only owns the scroll chrome.
 */
export function ScrollingTabStrip({
  children,
  revision,
  className,
  role,
  activeKey,
}: {
  children: React.ReactNode;
  /** Changes whenever the group's tab set (or its drop placeholder) changes, so
   *  overflow is re-evaluated — adding/removing tabs alters the strip's
   *  scrollWidth without resizing its own box, which the ResizeObserver misses. */
  revision: string;
  /** Extra classes on the `.tab-strip` itself. */
  className?: string;
  role?: string;
  /** Identity of the current tab, for a bar whose new tabs open active: each
   *  change scrolls the strip's `.tab.active` into view. */
  activeKey?: string;
}) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = stripRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Track overflow so the chevrons toggle with the strip's size/content (mirrors
  // the main-window `TabBar`): Resize catches the strip shrinking, the revision
  // effect below catches scrollWidth changes from adding/removing tabs.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    updateScrollState();
    const onScroll = () => updateScrollState();
    el.addEventListener("scroll", onScroll, { passive: true });
    // Children too: a tab growing inside a capped strip changes no strip box.
    const stopResize = observeStripResize(el, updateScrollState);
    return () => {
      el.removeEventListener("scroll", onScroll);
      stopResize();
    };
  }, [updateScrollState]);
  useEffect(() => {
    updateScrollState();
  }, [revision, updateScrollState]);
  useEffect(() => {
    if (activeKey === undefined) return;
    stripRef.current
      ?.querySelector<HTMLElement>(".tab.active")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, revision]);

  // Scroll one chevron-press worth (most of the visible width) toward `dir`.
  const scrollStrip = useCallback((dir: number) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  }, []);

  // Continuous scroll while a chevron is hovered: rAF loop nudges the strip each
  // frame until the pointer leaves (mirrors the main window's chevrons).
  const hoverScrollRef = useRef<number | null>(null);
  const stopHoverScroll = useCallback(() => {
    if (hoverScrollRef.current !== null) {
      cancelAnimationFrame(hoverScrollRef.current);
      hoverScrollRef.current = null;
    }
  }, []);
  const startHoverScroll = useCallback((dir: number) => {
    stopHoverScroll();
    const step = () => {
      const el = stripRef.current;
      if (!el) return;
      el.scrollLeft += dir * 6;
      // The chevrons unmount at the edges (canScroll*), so onMouseLeave may never
      // fire — stop once we can't scroll further in `dir` rather than spin forever.
      const atEdge =
        dir < 0
          ? el.scrollLeft <= 0
          : el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if (atEdge) {
        hoverScrollRef.current = null;
        return;
      }
      hoverScrollRef.current = requestAnimationFrame(step);
    };
    hoverScrollRef.current = requestAnimationFrame(step);
  }, [stopHoverScroll]);
  useEffect(() => stopHoverScroll, [stopHoverScroll]);

  // Translate a vertical wheel into horizontal strip scrolling so the tabs can be
  // panned while hovering anywhere over them, not just via the (hidden) scrollbar.
  const onStripWheel = useCallback((e: React.WheelEvent) => {
    const el = stripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    el.scrollLeft += delta;
  }, []);

  return (
    <>
      {canScrollLeft && (
        <button
          className="tab-scroll-btn left"
          title={t("detachedTabs.scrollLeft")}
          // Keep the chevron out of the bar's window-move/dock drag flow.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => startHoverScroll(-1)}
          onMouseLeave={stopHoverScroll}
          onClick={() => scrollStrip(-1)}
        >
          ‹
        </button>
      )}
      <div
        className={className ? `tab-strip ${className}` : "tab-strip"}
        role={role}
        ref={stripRef}
        onWheel={onStripWheel}
      >
        {children}
      </div>
      {canScrollRight && (
        <button
          className="tab-scroll-btn right"
          title={t("detachedTabs.scrollRight")}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => startHoverScroll(1)}
          onMouseLeave={stopHoverScroll}
          onClick={() => scrollStrip(1)}
        >
          ›
        </button>
      )}
    </>
  );
}
