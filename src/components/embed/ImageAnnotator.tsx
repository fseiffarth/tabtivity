/**
 * Image annotation / markup overlay (Dev F). Mounts over the image viewer when
 * the user clicks "Annotate". Draws the source image onto a base <canvas> sized
 * to the image's natural pixels, with a transparent overlay <canvas> on top for
 * live drawing. Tools: freehand pen, rectangle, arrow, text. Colour + stroke
 * width controls, Clear + Undo. On save it flattens base + annotations and
 * writes a PNG via `write_file_bytes` ("Save a copy" → "…-annotated.png", or
 * "Overwrite" when the source is already a .png), then closes the overlay.
 *
 * Props are the lead-fixed contract; do not change without updating the ImageView
 * call site in FileViewerPane.tsx.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFileScope, writeFileBytes } from "./fileAccess";
import { useT } from "../../lib/i18n";
import { usePaneSleepHold } from "../../lib/sleepWhenHidden";
import "./ImageAnnotator.css";
import { ArrowUpRightIcon, PencilIcon } from "../common/icons/Icon";
import { useDialogs } from "../common/PromptDialogs";

type Tool = "pen" | "rect" | "arrow" | "text";

const PRESET_COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];
const STROKE_WIDTHS = [2, 4, 8, 16];

/** Insert `-annotated` before the extension; force `.png` extension. */
function annotatedCopyPath(srcPath: string): string {
  const slash = Math.max(srcPath.lastIndexOf("/"), srcPath.lastIndexOf("\\"));
  const dir = srcPath.slice(0, slash + 1);
  const base = srcPath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${dir}${stem}-annotated.png`;
}

function isPng(srcPath: string): boolean {
  return /\.png$/i.test(srcPath);
}

export function ImageAnnotator({
  src,
  path,
  fileName,
  onClose,
}: {
  /** Object URL of the image being annotated (already loaded by ImageView). */
  src: string;
  /** Absolute path of the source image, for the default save target. */
  path: string;
  /** Bare file name, for the save dialog / window title. */
  fileName: string;
  /** Close the overlay and return to the plain image viewer. */
  onClose: () => void;
}) {
  const t = useT();
  const scope = useFileScope();
  // The text tool asks for its words in the app's own prompt. While it is open
  // Escape belongs to the prompt (cancel the text), not to this overlay's
  // capture-phase "discard everything and close".
  const { promptText, dialogs } = useDialogs();
  const askingRef = useRef(false);
  // While open, the drawing lives only on this component's canvas: keep a
  // sleepable pane awake (performance plan §5.3), or a hidden image tab left
  // mid-annotation would unmount and lose it. Released on Save/Close (unmount).
  usePaneSleepHold(true);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // Annotation strokes are kept as a committed-pixels stack for undo. Each entry
  // is a full snapshot of the overlay canvas BEFORE the corresponding op was
  // drawn, so undo = pop and restore.
  const undoStackRef = useRef<ImageData[]>([]);

  // Live-gesture state.
  const drawingRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // Snapshot of the overlay at gesture start, used to redraw shapes live.
  const gestureBaseRef = useRef<ImageData | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(PRESET_COLORS[0]);
  const [width, setWidth] = useState<number>(STROKE_WIDTHS[1]);
  const [loaded, setLoaded] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep refs of mutable tool state for use inside stable pointer handlers.
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const widthRef = useRef(width);
  toolRef.current = tool;
  colorRef.current = color;
  widthRef.current = width;

  // Load the image and size both canvases to natural pixels.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      imageRef.current = img;
      const base = baseRef.current;
      const overlay = overlayRef.current;
      if (base) {
        base.width = w;
        base.height = h;
        const ctx = base.getContext("2d");
        if (ctx) ctx.drawImage(img, 0, 0, w, h);
      }
      if (overlay) {
        overlay.width = w;
        overlay.height = h;
      }
      undoStackRef.current = [];
      setDims({ w, h });
      setLoaded(true);
    };
    img.onerror = () => {
      if (!cancelled) setError(t("imageAnnotator.loadFailed"));
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, t]);

  const overlayCtx = useCallback((): CanvasRenderingContext2D | null => {
    return overlayRef.current?.getContext("2d") ?? null;
  }, []);

  // Map a pointer event (CSS space) to overlay canvas (natural pixel) coords.
  const toCanvas = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = overlayRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width;
    const sy = c.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    const ctx = overlayCtx();
    const c = overlayRef.current;
    if (!ctx || !c) return null;
    const snap = ctx.getImageData(0, 0, c.width, c.height);
    undoStackRef.current.push(snap);
    // Cap the stack to keep memory bounded on large images.
    if (undoStackRef.current.length > 40) undoStackRef.current.shift();
    return snap;
  }, [overlayCtx]);

  const drawArrow = useCallback(
    (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, lw: number) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(12, lw * 4);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - head * Math.cos(angle - Math.PI / 6),
        y2 - head * Math.sin(angle - Math.PI / 6),
      );
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - head * Math.cos(angle + Math.PI / 6),
        y2 - head * Math.sin(angle + Math.PI / 6),
      );
      ctx.stroke();
    },
    [],
  );

  const applyStroke = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.strokeStyle = colorRef.current;
    ctx.fillStyle = colorRef.current;
    ctx.lineWidth = widthRef.current;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!loaded || saving) return;
      const ctx = overlayCtx();
      if (!ctx) return;
      const pt = toCanvas(e);

      if (toolRef.current === "text") {
        if (askingRef.current) return;
        askingRef.current = true;
        void promptText({
          title: t("imageAnnotator.annotationTextTitle"),
          label: t("imageAnnotator.annotationTextPrompt"),
          confirmLabel: t("common.add"),
        })
          .then((text) => {
            if (!text) return;
            pushUndoSnapshot();
            applyStroke(ctx);
            const fontPx = Math.max(14, widthRef.current * 6);
            ctx.font = `${fontPx}px sans-serif`;
            ctx.textBaseline = "top";
            ctx.fillText(text, pt.x, pt.y);
          })
          .finally(() => {
            askingRef.current = false;
          });
        return;
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      drawingRef.current = true;
      startRef.current = pt;
      pushUndoSnapshot();
      // Stash the post-snapshot pixels so shape previews can redraw cleanly.
      gestureBaseRef.current = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);

      if (toolRef.current === "pen") {
        applyStroke(ctx);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
      }
    },
    [loaded, saving, overlayCtx, toCanvas, pushUndoSnapshot, applyStroke, promptText, t],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const ctx = overlayCtx();
      const start = startRef.current;
      if (!ctx || !start) return;
      const pt = toCanvas(e);
      const tool = toolRef.current;

      if (tool === "pen") {
        applyStroke(ctx);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        return;
      }

      // Shape tools: restore the pre-gesture pixels then draw the live preview.
      const baseSnap = gestureBaseRef.current;
      if (baseSnap) ctx.putImageData(baseSnap, 0, 0);
      applyStroke(ctx);
      if (tool === "rect") {
        ctx.strokeRect(start.x, start.y, pt.x - start.x, pt.y - start.y);
      } else if (tool === "arrow") {
        drawArrow(ctx, start.x, start.y, pt.x, pt.y, widthRef.current);
      }
    },
    [overlayCtx, toCanvas, applyStroke, drawArrow],
  );

  const endGesture = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      startRef.current = null;
      gestureBaseRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
    },
    [],
  );

  const undo = useCallback(() => {
    const ctx = overlayCtx();
    const snap = undoStackRef.current.pop();
    if (!ctx) return;
    if (snap) {
      ctx.putImageData(snap, 0, 0);
    } else {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
  }, [overlayCtx]);

  const clear = useCallback(() => {
    const ctx = overlayCtx();
    if (!ctx) return;
    pushUndoSnapshot();
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }, [overlayCtx, pushUndoSnapshot]);

  // Flatten base image + overlay annotations into a single PNG blob.
  const flatten = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const base = baseRef.current;
      const overlay = overlayRef.current;
      if (!base || !overlay) {
        resolve(null);
        return;
      }
      const out = document.createElement("canvas");
      out.width = base.width;
      out.height = base.height;
      const ctx = out.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(base, 0, 0);
      ctx.drawImage(overlay, 0, 0);
      out.toBlob((blob) => resolve(blob), "image/png");
    });
  }, []);

  const save = useCallback(
    async (targetPath: string) => {
      if (saving) return;
      setError(null);
      setSaving(true);
      try {
        const blob = await flatten();
        if (!blob) {
          setError(t("imageAnnotator.renderFailed"));
          setSaving(false);
          return;
        }
        const buf = await blob.arrayBuffer();
        await writeFileBytes(targetPath, new Uint8Array(buf), scope);
        onClose();
      } catch (err) {
        setError(t("imageAnnotator.saveFailed", { msg: err instanceof Error ? err.message : String(err) }));
        setSaving(false);
      }
    },
    [saving, flatten, onClose, scope, t],
  );

  // Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !askingRef.current) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const sourceIsPng = isPng(path);
  const copyTarget = annotatedCopyPath(path);

  return (
    <div className="image-annotator" role="dialog" aria-label={t("imageAnnotator.dialogLabel", { fileName })}>
      <div className="image-annotator__toolbar">
        <span className="image-annotator__title" title={path}>
          ✎ {fileName}
        </span>

        <div className="image-annotator__group" role="group" aria-label={t("imageAnnotator.toolsGroup")}>
          {(["pen", "rect", "arrow", "text"] as Tool[]).map((tl) => (
            <button
              key={tl}
              className={`image-annotator__btn${tool === tl ? " is-active" : ""}`}
              onClick={() => setTool(tl)}
              title={
                tl === "pen"
                  ? t("imageAnnotator.toolPen")
                  : tl === "rect"
                    ? t("imageAnnotator.toolRect")
                    : tl === "arrow"
                      ? t("imageAnnotator.toolArrow")
                      : t("imageAnnotator.toolText")
              }
            >
              {tl === "pen" ? <PencilIcon /> : tl === "rect" ? "▢" : tl === "arrow" ? <ArrowUpRightIcon /> : "T"}
            </button>
          ))}
        </div>

        <div className="image-annotator__group" role="group" aria-label={t("imageAnnotator.colourGroup")}>
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              className={`image-annotator__swatch${color === c ? " is-active" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
              aria-label={t("imageAnnotator.colourLabel", { c })}
            />
          ))}
          <input
            type="color"
            className="image-annotator__color-input"
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#ff3b30"}
            onChange={(e) => setColor(e.target.value)}
            title={t("imageAnnotator.customColourTitle")}
            aria-label={t("imageAnnotator.customColourTitle")}
          />
        </div>

        <div className="image-annotator__group" role="group" aria-label={t("imageAnnotator.strokeWidthGroup")}>
          {STROKE_WIDTHS.map((w) => (
            <button
              key={w}
              className={`image-annotator__btn image-annotator__width${width === w ? " is-active" : ""}`}
              onClick={() => setWidth(w)}
              title={`${w}px`}
            >
              <span
                className="image-annotator__width-dot"
                style={{ width: Math.min(w + 2, 18), height: Math.min(w + 2, 18) }}
              />
            </button>
          ))}
        </div>

        <div className="image-annotator__group">
          <button className="image-annotator__btn" onClick={undo} title={t("imageAnnotator.undoTitle")}>
            {t("imageAnnotator.undoLabel")}
          </button>
          <button className="image-annotator__btn" onClick={clear} title={t("imageAnnotator.clearTitle")}>
            {t("imageAnnotator.clearLabel")}
          </button>
        </div>

        <div className="image-annotator__group image-annotator__group--right">
          <button
            className="image-annotator__btn image-annotator__btn--primary"
            onClick={() => save(copyTarget)}
            disabled={!loaded || saving}
            title={t("imageAnnotator.saveCopyTitle", { target: copyTarget })}
          >
            {saving ? t("common.saving") : t("imageAnnotator.saveCopy")}
          </button>
          {sourceIsPng && (
            <button
              className="image-annotator__btn"
              onClick={() => save(path)}
              disabled={!loaded || saving}
              title={t("imageAnnotator.overwriteTitle", { path })}
            >
              {t("imageAnnotator.overwrite")}
            </button>
          )}
          <button
            className="image-annotator__btn"
            onClick={onClose}
            disabled={saving}
            title={t("imageAnnotator.discardTitle")}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>

      {error != null && <div className="image-annotator__error">{error}</div>}

      <div className="image-annotator__stage">
        <div
          className="image-annotator__canvas-wrap"
          style={dims ? { aspectRatio: `${dims.w} / ${dims.h}` } : undefined}
        >
          <canvas ref={baseRef} className="image-annotator__canvas image-annotator__canvas--base" />
          <canvas
            ref={overlayRef}
            className="image-annotator__canvas image-annotator__canvas--overlay"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
          {!loaded && error == null && (
            <div className="image-annotator__loading">{t("imageAnnotator.loadingImage")}</div>
          )}
        </div>
      </div>
      {dialogs}
    </div>
  );
}
