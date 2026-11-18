import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampRootOverlayFrame,
  filledRootOverlayFrame,
  rootOverlayFrameDrag,
  type RootOverlayDragMode,
  type RootOverlayFrame,
} from "../../lib/window/floatingFrame";
import { bindDragRelease } from "../../lib/window/dragPlatform";
import { useT } from "../../lib/i18n";

/**
 * The move / resize / fill of the root console and the header overlays (mail,
 * calendar, to-do board, models & agents) — one frame math
 * (`lib/window/floatingFrame`), the same eight grips, the same "drag the title
 * bar to move, double-click to fill".
 *
 * Local state rather than a store: nothing outside the overlay reads its frame.
 * It is remembered per overlay in localStorage — where a window sits on one
 * desk, never `settings.json` — and re-clamped against the window it opens in.
 */

/** Pixels a press on the title bar must travel before it is a move, not a click. */
const DRAG_THRESHOLD_PX = 5;

/** Presses on the title bar that keep their own meaning — a tab in an
 *  overlay's strip included, and the console's ⚿ badge (not a button, but not a
 *  handle either). */
const BAR_NO_DRAG = "button, input, a, .untested-tag, .tab, .root-overlay-rights";

const FRAME_GRIPS: RootOverlayDragMode[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

interface PersistedFrame {
  frame: RootOverlayFrame | null;
  filled: boolean;
}

function readFrame(key: string): PersistedFrame {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { frame: null, filled: false };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { frame: null, filled: false };
    const { frame, filled } = parsed as Record<string, unknown>;
    const nums = frame as Record<string, unknown> | undefined;
    const ok =
      !!nums &&
      typeof nums === "object" &&
      (["x", "y", "width", "height"] as const).every((k) => Number.isFinite(nums[k] as number));
    return { frame: ok ? (frame as RootOverlayFrame) : null, filled: filled === true };
  } catch {
    return { frame: null, filled: false };
  }
}

function writeFrame(key: string, row: PersistedFrame) {
  try {
    localStorage.setItem(key, JSON.stringify(row));
  } catch {
    // localStorage unavailable — the frame still holds while the overlay is open.
  }
}

export function useFloatingFrame(storageKey: string) {
  const t = useT();
  const [saved, setSaved] = useState<PersistedFrame>(() => readFrame(storageKey));
  const [liveFrame, setLiveFrame] = useState<RootOverlayFrame | null>(null);
  const [framing, setFraming] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === "undefined" ? 0 : window.innerWidth,
    h: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const frame = useMemo(
    () =>
      liveFrame ??
      (saved.filled
        ? filledRootOverlayFrame(viewport.w, viewport.h)
        : saved.frame
          ? clampRootOverlayFrame(saved.frame, viewport.w, viewport.h)
          : null),
    [liveFrame, saved, viewport.w, viewport.h],
  );

  const toggleFilled = useCallback(() => {
    setSaved((s) => {
      const next = { frame: s.frame, filled: !s.filled };
      writeFrame(storageKey, next);
      return next;
    });
  }, [storageKey]);

  /** The root console's gesture: release bound inside pointerdown (WebKitGTK),
   *  start rect read off the element so the stylesheet's size hands over. */
  const beginFrameDrag = useCallback(
    (e: React.PointerEvent, mode: RootOverlayDragMode) => {
      if (e.button !== 0) return;
      const el = frameRef.current;
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const start: RootOverlayFrame = { x: r.left, y: r.top, width: r.width, height: r.height };
      const sx = e.clientX;
      const sy = e.clientY;
      let latest = start;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        if (!moved && mode === "move" && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
        moved = true;
        latest = rootOverlayFrameDrag(
          start,
          mode,
          ev.clientX - sx,
          ev.clientY - sy,
          window.innerWidth,
          window.innerHeight,
        );
        setLiveFrame(latest);
      };
      const teardown = () => {
        window.removeEventListener("pointermove", onMove);
        setLiveFrame(null);
        setFraming(false);
      };
      setFraming(true);
      bindDragRelease({
        onCommit: () => {
          const committed = moved ? latest : null;
          teardown();
          if (committed) {
            // A drag on a filled overlay is the user sizing it by hand again.
            const next = { frame: committed, filled: false };
            writeFrame(storageKey, next);
            setSaved(next);
          }
        },
        onAbort: teardown,
      });
      window.addEventListener("pointermove", onMove);
    },
    [storageKey],
  );

  const frameStyle: React.CSSProperties | undefined = frame
    ? {
        position: "fixed",
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
      }
    : undefined;

  /** Spread onto the title row: it moves the frame, double-click fills. */
  const barProps = {
    className: "floating-frame-bar",
    title: t("floatingFrame.moveHint"),
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest(BAR_NO_DRAG)) return;
      beginFrameDrag(e, "move");
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest(BAR_NO_DRAG)) return;
      toggleFilled();
    },
  };

  // Withheld while filled — there is nothing to drag them into.
  const grips = saved.filled
    ? null
    : FRAME_GRIPS.map((mode) => (
        <div
          key={mode}
          className={`root-overlay-grip grip-${mode}`}
          title={t("floatingFrame.resizeHint")}
          onPointerDown={(e) => beginFrameDrag(e, mode)}
        />
      ));

  // The root console's own fill button (RootOverlay's ⤢/⤡), not a window-manager glyph.
  const fillButton = (
    <button
      type="button"
      className="subwindow-hide floating-frame-fill"
      title={saved.filled ? t("floatingFrame.restore") : t("floatingFrame.fill")}
      aria-label={saved.filled ? t("floatingFrame.restore") : t("floatingFrame.fill")}
      aria-pressed={saved.filled}
      onClick={toggleFilled}
    >
      {saved.filled ? "⤡" : "⤢"}
    </button>
  );

  return {
    frameRef,
    frameStyle,
    /** Extra class for the frame element while a gesture is in flight. */
    frameClass: `floating-frame${framing ? " framing" : ""}`,
    /** A move or resize gesture is in flight — an Escape then is the gesture's. */
    framing,
    barProps,
    grips,
    fillButton,
  };
}
