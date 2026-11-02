import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { surfaceExitMs } from "../../lib/motion";

/**
 * The one context-menu/popover portal. Every right-click menu and click-opened
 * popover that portals to <body> renders through this instead of hand-rolling
 * the pattern, because the hand-rolled copies drifted: no viewport clamping
 * (menus opened near an edge rendered off-screen), inconsistent z-indexes
 * (one sat *below* the modal backdrop), and catchers that missed the
 * second-right-click case (a native menu stacked on top of the open one).
 *
 * What it provides:
 * - a full-viewport dismiss catcher that closes on any pointer-down AND on a
 *   right-click (preventDefault, so no native menu stacks on top);
 * - Escape closes it, wherever focus is;
 * - viewport clamping via useClampToViewport — the same hook the in-flow
 *   siblings (FileTree, TabBar, PageStrip) use;
 * - class-level layering (`.context-menu-catcher` / `.context-menu-portal`,
 *   `--z-menu*` tokens in themes.css) — call sites pass NO z-index.
 *
 * `className` styles the menu chrome (default `context-menu`); the portal
 * always adds `context-menu-portal`, which owns position:fixed + z-index and
 * wins over a chrome class's own positioning (e.g. `.tab-new-menu`).
 *
 * `keepBelow` is for a menu dropped from a button rather than from the cursor
 * (the tab "+" menu): it stays put under its anchor instead of being shifted
 * up to fit — a tall one slid up lands ON the bar it dropped from and no longer
 * reads as belonging to that button — and is capped to the room below it, so
 * the overflow scrolls inside the menu (`.menu-scroll-region`) instead.
 *
 * A click away or Escape fades the menu for `--motion-exit` before `onClose`
 * (`.is-leaving`, and at once under reduced motion). A pick inside it closes it
 * outright: the row's action is the answer, there is nothing left to watch.
 *
 * `dismiss={false}` suspends both halves (no catcher, no Escape) for a stretch
 * where the menu must NOT close itself — while a dialog it opened is up and
 * owns the screen, and closing would take the pending answer with it.
 */
/** Breathing room kept between a menu and the window edge (the clamp's own). */
const MARGIN = 8;

export function ContextMenuPortal({
  x,
  y,
  onClose,
  className = "context-menu",
  style,
  dismiss = true,
  keepBelow = false,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  dismiss?: boolean;
  keepBelow?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>({ x, y });
  // Re-seed when the caller moves the anchor (a second right-click elsewhere
  // while the menu is open re-opens it at the new point).
  useLayoutEffect(() => {
    setPos({ x, y });
  }, [x, y]);
  useClampToViewport(ref, pos, setPos, keepBelow ? { margin: MARGIN, axis: "x" } : undefined);
  // Escape is the other half of "click away": the menu is not focus-trapped, so
  // the key is taken on the document. An Escape some other handler already
  // claimed (an editor cancelling its own mode) is left alone, and the one this
  // menu eats is marked handled so it doesn't also back out of what's behind it.
  useEffect(() => {
    if (!dismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      leaveRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  const leave = () => {
    if (leaving) return;
    const ms = ref.current ? surfaceExitMs(ref.current) : 0;
    if (ms <= 0) {
      onClose();
      return;
    }
    setLeaving(true);
    leaveTimer.current = window.setTimeout(onClose, ms);
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const left = pos?.x ?? x;
  const top = pos?.y ?? y;
  // Anchored menus give up height, not position: whatever is left between the
  // anchor and the bottom edge is the cap, and the menu's own scroll region
  // takes the rest. A call site's `style` still wins over it.
  const fit: CSSProperties | undefined = keepBelow
    ? { maxHeight: `calc(100vh - ${Math.round(top) + MARGIN}px)` }
    : undefined;
  return createPortal(
    <>
      {dismiss && !leaving && (
        <div
          className="context-menu-catcher"
          onPointerDown={leave}
          onContextMenu={(e) => {
            e.preventDefault();
            leave();
          }}
        />
      )}
      <div
        ref={ref}
        className={`${className} context-menu-portal${leaving ? " is-leaving" : ""}`}
        style={{ left, top, ...fit, ...style }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
