import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UntestedTag } from "../common/UntestedTag";
import { usePresentationStore } from "../../stores/viewers/presentation";
import { useT, type TranslationKey } from "../../lib/i18n";
import { TrashIcon } from "../common/icons/Icon";
import { type LaserPoint, paintLaserFrame } from "./laserPaint";

/**
 * A presentation / walkthrough aid layered over EVERY native viewer (image,
 * PDF, markdown, code, table, …). It gives two ephemeral, non-persisted tools:
 *
 *  - **Marker** — a highlighter pen. Drag to lay down a translucent colored
 *    stroke (six highlighter colors); undo the last stroke or clear them all.
 *    Strokes live on a `<canvas>` in NORMALIZED (0..1) pane coordinates, so they
 *    rescale when the pane is resized rather than drifting off the content.
 *  - **Laser** — a glowing dot that follows the cursor with a short fading
 *    trail, drawn on its own transient canvas driven by rAF. Nothing it draws
 *    is kept; it exists only while the pointer moves.
 *
 * It is mounted ONCE by `FileViewerPane` over the chosen viewer, so no
 * per-viewer wiring is needed. When no tool is active the whole overlay is
 * `pointer-events: none` and every click falls straight through to the viewer;
 * only the small floating toolbar keeps pointer events so it can be reopened.
 * Marker strokes are session-only (component state) — a presentation aid, not a
 * saved annotation — and reset when the viewer tab closes.
 */

type Tool = "off" | "marker" | "laser";

/** One completed marker stroke: it carries the color, width and opacity it was
 *  drawn WITH, so changing the menu never restyles marks already on the page. */
interface Stroke {
  color: string;
  /** Stroke width in CSS px at device-pixel-ratio 1. */
  width: number;
  /** Ink opacity, 0..1. */
  alpha: number;
  /** Points as [x,y] fractions of the pane's width/height (0..1). */
  pts: Array<[number, number]>;
}

/** Highlighter palette — translucent, so overlapping strokes read as ink. */
const PALETTE: Array<{ nameKey: TranslationKey; value: string }> = [
  { nameKey: "presentationOverlay.colorYellow", value: "#ffe14d" },
  { nameKey: "presentationOverlay.colorGreen", value: "#7cf06a" },
  { nameKey: "presentationOverlay.colorPink", value: "#ff6ec7" },
  { nameKey: "presentationOverlay.colorBlue", value: "#5cc8ff" },
  { nameKey: "presentationOverlay.colorOrange", value: "#ffa63d" },
  { nameKey: "presentationOverlay.colorRed", value: "#ff5252" },
];

/** Default highlighter stroke width, in CSS px, at device-pixel-ratio 1. */
const MARKER_WIDTH = 16;
const MIN_WIDTH = 4;
const MAX_WIDTH = 48;
/** Default ink opacity (0..1) and its adjustable range. */
const MARKER_ALPHA = 0.38;
const MIN_ALPHA = 0.1;
const MAX_ALPHA = 1;

export function PresentationOverlay() {
  const t = useT();
  const [tool, setTool] = useState<Tool>("off");
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState(PALETTE[0].value);
  const [width, setWidth] = useState(MARKER_WIDTH);
  const [alpha, setAlpha] = useState(MARKER_ALPHA);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLCanvasElement | null>(null);
  const laserRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);

  // The in-progress marker stroke (mutated during a drag; committed on release).
  const drawing = useRef<Stroke | null>(null);
  // Transient laser trail: recent pointer samples with a birth timestamp.
  const trail = useRef<LaserPoint[]>([]);
  // The laser's current resting position (pane-local px). Kept separate from the
  // fading trail so the dot stays lit while the pointer is STILL; null once the
  // cursor leaves the pane.
  const laserPos = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  // Latest tool/strokes/color/width/alpha for callbacks that close over stale state.
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const colorRef = useRef(color);
  colorRef.current = color;
  const widthRef = useRef(width);
  widthRef.current = width;
  const alphaRef = useRef(alpha);
  alphaRef.current = alpha;

  const active = tool !== "off";

  // ── Canvas sizing ─────────────────────────────────────────────────────────
  // Keep both canvases matched to the pane's pixel size (× DPR for crispness);
  // redraw the marker layer whenever the box changes so normalized strokes
  // re-lay out at the new size.
  const sizeCanvases = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const w = root.clientWidth;
    const h = root.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [markerRef.current, laserRef.current]) {
      if (!c) continue;
      const pw = Math.max(1, Math.round(w * dpr));
      const ph = Math.max(1, Math.round(h * dpr));
      if (c.width !== pw || c.height !== ph) {
        c.width = pw;
        c.height = ph;
      }
    }
  }, []);

  const drawMarker = useCallback(() => {
    const c = markerRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const paint = (s: Stroke) => {
      if (s.pts.length === 0) return;
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = s.alpha;
      ctx.lineWidth = s.width * dpr;
      ctx.beginPath();
      const [x0, y0] = s.pts[0];
      ctx.moveTo(x0 * c.width, y0 * c.height);
      if (s.pts.length === 1) {
        // A tap: draw a dot so a single click still marks something.
        ctx.lineTo(x0 * c.width + 0.01, y0 * c.height);
      }
      for (let i = 1; i < s.pts.length; i++) {
        ctx.lineTo(s.pts[i][0] * c.width, s.pts[i][1] * c.height);
      }
      ctx.stroke();
    };
    for (const s of strokesRef.current) paint(s);
    if (drawing.current) paint(drawing.current);
    ctx.globalAlpha = 1;
  }, []);

  useLayoutEffect(() => {
    sizeCanvases();
    drawMarker();
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      sizeCanvases();
      drawMarker();
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [sizeCanvases, drawMarker]);

  // Redraw the committed strokes whenever they change.
  useEffect(() => {
    drawMarker();
  }, [strokes, drawMarker]);

  // ── Laser animation ───────────────────────────────────────────────────────
  useEffect(() => {
    if (tool !== "laser") {
      trail.current = [];
      laserPos.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const c = laserRef.current;
      const ctx = c?.getContext("2d");
      if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
      return;
    }
    const tick = () => {
      const c = laserRef.current;
      if (c) trail.current = paintLaserFrame(c, trail.current, laserPos.current, colorRef.current, performance.now());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [tool]);

  // ── Pointer handling on the capture surface ───────────────────────────────
  const relPoint = (e: React.PointerEvent): [number, number] => {
    const root = rootRef.current;
    if (!root) return [0, 0];
    const r = root.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const pushLaser = (e: React.PointerEvent) => {
    const r = rootRef.current!.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    laserPos.current = p;
    trail.current.push({ ...p, t: performance.now() });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (toolRef.current === "off") return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (toolRef.current === "marker") {
      drawing.current = {
        color: colorRef.current,
        width: widthRef.current,
        alpha: alphaRef.current,
        pts: [relPoint(e)],
      };
      drawMarker();
    } else if (toolRef.current === "laser") {
      pushLaser(e);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (toolRef.current === "marker") {
      if (!drawing.current) return;
      drawing.current.pts.push(relPoint(e));
      drawMarker();
    } else if (toolRef.current === "laser") {
      pushLaser(e);
    }
  };

  const onPointerUp = () => {
    if (toolRef.current === "marker" && drawing.current) {
      const s = drawing.current;
      drawing.current = null;
      if (s.pts.length > 0) setStrokes((prev) => [...prev, s]);
    }
  };

  // Cursor left the pane: drop the resting laser dot so it doesn't hover over
  // whatever the mouse moved on to.
  const onPointerLeave = () => {
    laserPos.current = null;
  };

  // The capture surface sits over the whole pane to receive marker/laser drags,
  // but that same `pointer-events: auto` swallows the wheel — so a viewer no
  // longer scrolls while a tool is armed. Forward the wheel through to whatever
  // scrollable element is under the cursor: momentarily make the surface
  // transparent to hit-testing, find the element beneath, scroll its nearest
  // scrollable ancestor ourselves. Native + non-passive so `preventDefault`
  // takes. (Marker strokes stay screen-anchored, which is expected for a
  // presentation aid — you scroll to new content, then keep marking.)
  useEffect(() => {
    const cap = captureRef.current;
    if (!cap || !active) return;
    const onWheel = (e: WheelEvent) => {
      const prev = cap.style.pointerEvents;
      cap.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      cap.style.pointerEvents = prev;
      const scroller = findScrollable(under, e.deltaX, e.deltaY);
      if (scroller) {
        scroller.scrollBy({ left: e.deltaX, top: e.deltaY });
        e.preventDefault();
      }
    };
    cap.addEventListener("wheel", onWheel, { passive: false });
    return () => cap.removeEventListener("wheel", onWheel);
  }, [active]);

  // Publish "a tool is armed" app-wide while one is. The deck presenter reads it
  // to keep Escape from ending the talk when all the speaker meant was to put the
  // laser away — see `stores/viewers/presentation` for why this cannot be a prop or a
  // context.
  useEffect(() => {
    if (!active) return;
    const { setArmed } = usePresentationStore.getState();
    setArmed(true);
    return () => setArmed(false);
  }, [active]);

  // Esc leaves the active tool (back to click-through) without closing the bar.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTool("off");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const undo = () => setStrokes((prev) => prev.slice(0, -1));
  const clear = () => setStrokes([]);

  const showSwatches = open && (tool === "marker" || tool === "laser");

  return (
    <div
      ref={rootRef}
      className={`presentation-overlay${active ? " active" : ""}`}
      // The whole layer is inert unless a tool is active; only the toolbar
      // (which re-enables pointer events on itself) stays clickable.
      style={{ pointerEvents: "none" }}
    >
      <canvas ref={markerRef} className="presentation-canvas" />
      <canvas ref={laserRef} className="presentation-canvas" />
      {active && (
        <div
          ref={captureRef}
          className="presentation-capture"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          style={{ cursor: tool === "laser" ? "none" : "crosshair" }}
        />
      )}

      <div className="presentation-toolbar" style={{ pointerEvents: "auto" }}>
        {!open ? (
          <button
            className="presentation-fab"
            title={t("presentationOverlay.toolsTitle")}
            aria-label={t("presentationOverlay.toolsLabel")}
            onClick={() => setOpen(true)}
          >
            <PenIcon />
          </button>
        ) : (
          <div className="presentation-tools" role="toolbar" aria-label={t("presentationOverlay.toolsLabel")}>
            <button
              className={`presentation-tool${tool === "marker" ? " on" : ""}`}
              title={t("presentationOverlay.markerTitle")}
              aria-pressed={tool === "marker"}
              onClick={() => setTool((cur) => (cur === "marker" ? "off" : "marker"))}
            >
              <MarkerIcon />
            </button>
            <button
              className={`presentation-tool${tool === "laser" ? " on" : ""}`}
              title={t("presentationOverlay.laserTitle")}
              aria-pressed={tool === "laser"}
              onClick={() => setTool((cur) => (cur === "laser" ? "off" : "laser"))}
            >
              <LaserIcon />
            </button>

            {showSwatches && (
              <div className="presentation-swatches">
                {PALETTE.map((c) => (
                  <button
                    key={c.value}
                    className={`presentation-swatch${color === c.value ? " on" : ""}`}
                    style={{ background: c.value }}
                    title={t(c.nameKey)}
                    aria-label={t(c.nameKey)}
                    aria-pressed={color === c.value}
                    onClick={() => setColor(c.value)}
                  />
                ))}
              </div>
            )}

            {tool === "marker" && (
              <div className="presentation-settings-wrap">
                <button
                  className={`presentation-tool${settingsOpen ? " on" : ""}`}
                  title={t("presentationOverlay.thicknessOpacityTitle")}
                  aria-label={t("presentationOverlay.thicknessOpacityTitle")}
                  aria-pressed={settingsOpen}
                  onClick={() => setSettingsOpen((o) => !o)}
                >
                  <SlidersIcon />
                </button>
                {settingsOpen && (
                  <div className="presentation-settings" role="group" aria-label={t("presentationOverlay.markerSettingsLabel")}>
                    <label className="presentation-slider">
                      <span className="presentation-slider-label">
                        {t("presentationOverlay.thickness")} <b>{width}px</b>
                      </span>
                      <input
                        type="range"
                        min={MIN_WIDTH}
                        max={MAX_WIDTH}
                        step={1}
                        value={width}
                        onChange={(e) => setWidth(Number(e.target.value))}
                      />
                    </label>
                    <label className="presentation-slider">
                      <span className="presentation-slider-label">
                        {t("presentationOverlay.opacity")} <b>{Math.round(alpha * 100)}%</b>
                      </span>
                      <input
                        type="range"
                        min={Math.round(MIN_ALPHA * 100)}
                        max={Math.round(MAX_ALPHA * 100)}
                        step={5}
                        value={Math.round(alpha * 100)}
                        onChange={(e) => setAlpha(Number(e.target.value) / 100)}
                      />
                    </label>
                    <div
                      className="presentation-preview"
                      style={{ background: color, opacity: alpha, height: `${Math.max(4, Math.min(width, MAX_WIDTH))}px` }}
                      aria-hidden="true"
                    />
                  </div>
                )}
              </div>
            )}

            <span className="presentation-sep" aria-hidden="true" />
            <button
              className="presentation-tool"
              title={t("presentationOverlay.undoTitle")}
              aria-label={t("presentationOverlay.undoTitle")}
              disabled={strokes.length === 0}
              onClick={undo}
            >
              ↶
            </button>
            <button
              className="presentation-tool"
              title={t("presentationOverlay.clearTitle")}
              aria-label={t("presentationOverlay.clearTitle")}
              disabled={strokes.length === 0}
              onClick={clear}
            >
              <TrashIcon />
            </button>
            <button
              className="presentation-tool"
              title={t("presentationOverlay.closeTitle")}
              aria-label={t("presentationOverlay.closeTitle")}
              onClick={() => {
                setTool("off");
                setOpen(false);
              }}
            >
              ✕
            </button>
            <UntestedTag id="presentationOverlay.1" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Nearest ancestor of `el` that can actually scroll in the wheel's direction,
 *  so a wheel forwarded through the capture surface moves the right container. */
function findScrollable(el: Element | null, dx: number, dy: number): Element | null {
  let node: Element | null = el;
  while (node && node !== document.body && node !== document.documentElement) {
    const st = getComputedStyle(node);
    const scrollableY =
      (st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight;
    const scrollableX =
      (st.overflowX === "auto" || st.overflowX === "scroll" || st.overflowX === "overlay") &&
      node.scrollWidth > node.clientWidth;
    if ((dy !== 0 && scrollableY) || (dx !== 0 && scrollableX)) return node;
    node = node.parentElement;
  }
  return null;
}

// ── Icons (inline SVG so no icon dependency is pulled in) ─────────────────────

function PenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <path d="M2 2l7.586 7.586" />
      <circle cx="11" cy="11" r="2" />
    </svg>
  );
}

function MarkerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l-6 6v3h3l6-6" />
      <path d="M12 8l3 3" />
      <path d="M17 3l4 4-8 8-4-4z" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="15" cy="6" r="2" fill="currentColor" />
      <circle cx="9" cy="12" r="2" fill="currentColor" />
      <circle cx="17" cy="18" r="2" fill="currentColor" />
    </svg>
  );
}

function LaserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </svg>
  );
}
