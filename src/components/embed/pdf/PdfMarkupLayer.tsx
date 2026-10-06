/**
 * One page's markup layer in the desktop PDF viewer (`usePdfMarkup`): a canvas
 * over the page that draws the layer's vectors at the viewer's zoom and turns
 * pointer gestures into marks in the page's own units — its points after
 * `/Rotate`, the units the phone draws in and the backend bakes from.
 *
 * Mounted inside `PdfPageCanvas` like the blackout and copy surfaces, above
 * every other page layer while markup is on, so links, highlights, remarks and
 * the text layer take no pointer meanwhile. Mouse draws with the chosen tool;
 * a pen adds its pressure, and its eraser end erases; touch draws too. Redrawn from the vectors on every
 * zoom, so a mark stays sharp at any scale.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../../lib/i18n";
import {
  clampToPage,
  eraseAlong,
  eraseAt,
  finishStroke,
  inkWidth,
  moveNote,
  noteAt,
  replaceMark,
  round,
  stylusErases,
  type BoxMark,
  type InkMark,
  type Mark,
  type MarkColor,
  type PageLayer,
  type TextMark,
} from "../../../../mobile-web/src/markup/layer";
import { drawMark, drawPage, INK, type Paint } from "../../../../mobile-web/src/markup/rasterize";
import type { MarkupEdit, NoteDraft } from "./usePdfMarkup";

/** How strongly the marks of earlier rounds show — sent, never sent again. */
export const SENT_ALPHA = 0.35;
/** The widest the layer canvas is backed at, in device pixels. */
const MAX_BACKING = 8192;
/** How far a pointer travels on a note before it is a drag, not a click. */
const DRAG_SLOP = 4;
/** The eraser's reach, CSS pixels. */
const ERASE_PX = 10;

type Size = [number, number];

/** What a pointer is doing on the page between down and up. */
type Gesture =
  | { kind: "ink"; pointerId: number; mark: InkMark; last: [number, number] }
  | { kind: "box"; pointerId: number; start: [number, number] }
  | { kind: "erase"; pointerId: number; layer: MarkupEdit["base"]; last: [number, number] }
  | {
      kind: "text";
      pointerId: number;
      start: [number, number];
      clientX: number;
      clientY: number;
      index: number;
      grab: [number, number];
      moved: boolean;
    };

/** The sent marks dimmed, then the unsent ones over them. */
function paintLayer(ctx: Paint, page: PageLayer | undefined, sent: PageLayer | undefined, scale: number) {
  if (sent) {
    ctx.save();
    ctx.globalAlpha = SENT_ALPHA;
    drawPage(ctx, sent, scale);
    ctx.restore();
  }
  if (page) drawPage(ctx, page, scale);
}

function boxOf(a: [number, number], b: [number, number], color: MarkColor): BoxMark {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { kind: "box", color, rect: [round(x), round(y), round(Math.abs(a[0] - b[0])), round(Math.abs(a[1] - b[1]))] };
}

/** A pointer's spot on the page, in page units, kept on the page. Measured off
 *  the layer's own box, so it holds at any zoom; `scale` stands in where the
 *  box has no size yet. */
export function pagePoint(
  box: { left: number; top: number; width: number; height: number },
  size: Size,
  scale: number,
  clientX: number,
  clientY: number,
): [number, number] {
  const width = box.width || size[0] * scale;
  const height = box.height || size[1] * scale;
  return clampToPage(((clientX - box.left) * size[0]) / width, ((clientY - box.top) * size[1]) / height, size);
}

export function PdfMarkupLayer({ n, size, scale, edit }: { n: number; size: Size; scale: number; edit: MarkupEdit }) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Mark | null>(null);

  const cssW = size[0] * scale;
  const cssH = size[1] * scale;
  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const pixelW = Math.max(1, Math.min(MAX_BACKING, Math.round(cssW * dpr)));
  const pixelH = Math.max(1, Math.round((pixelW * size[1]) / size[0]));
  const page = edit.layer.pages[n];
  const sent = edit.showSent ? edit.layer.sent?.pages[n] : undefined;

  const redraw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = canvas.width / size[0];
    paintLayer(ctx, page, sent, k);
    if (preview) {
      ctx.save();
      ctx.scale(k, k);
      drawMark(ctx, preview);
      ctx.restore();
    }
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = pixelW;
    canvas.height = pixelH;
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sent, preview, pixelW, pixelH]);
  // A canvas gives its backing store back the moment it goes.
  useEffect(
    () => () => {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    [],
  );

  const toPage = (clientX: number, clientY: number): [number, number] => {
    const rect = wrapRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
    return pagePoint(rect, size, scale, clientX, clientY);
  };
  const unitsPerPixel = () => {
    const width = wrapRef.current?.getBoundingClientRect().width || cssW;
    return size[0] / width;
  };

  /** One piece of the stroke in progress, straight onto the canvas — the
   *  whole layer is redrawn, curved, when the stroke ends. */
  const paintPiece = (mark: InkMark, from: [number, number], to: [number, number], pressure: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const k = canvas.width / size[0];
    ctx.save();
    ctx.scale(k, k);
    ctx.lineCap = "round";
    ctx.strokeStyle = INK[mark.color];
    ctx.lineWidth = inkWidth(mark.width, pressure);
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
    ctx.restore();
  };

  const pressureOf = (event: { pointerType: string; pressure: number }) =>
    event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A pen's eraser end presses button 5.
    if (edit.busy || (event.button !== 0 && !stylusErases(event))) return;
    if (edit.note) {
      // A click away from an open note keeps what was typed, as Done would.
      edit.saveNote(edit.note.text);
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = toPage(event.clientX, event.clientY);
    if (edit.tool === "eraser" || stylusErases(event)) {
      const next = eraseAt(edit.base, n, at[0], at[1], ERASE_PX * unitsPerPixel(), edit.showSent);
      gesture.current = { kind: "erase", pointerId: event.pointerId, layer: next, last: at };
      if (next !== edit.base) edit.scratch(next);
    } else if (edit.tool === "ink") {
      const pressure = pressureOf(event);
      const mark: InkMark = {
        kind: "ink",
        color: edit.color,
        width: round(Math.min(100, Math.max(0.1, size[0] / 350))),
        points: [[at[0], at[1], pressure]],
      };
      gesture.current = { kind: "ink", pointerId: event.pointerId, last: at, mark };
      paintPiece(mark, at, at, pressure);
    } else if (edit.tool === "box") {
      gesture.current = { kind: "box", pointerId: event.pointerId, start: at };
    } else {
      const index = noteAt(edit.base.pages[n], at[0], at[1]);
      const grabbed = index >= 0 ? (edit.base.pages[n].marks[index] as TextMark) : null;
      gesture.current = {
        kind: "text",
        pointerId: event.pointerId,
        start: at,
        clientX: event.clientX,
        clientY: event.clientY,
        index,
        grab: grabbed ? [at[0] - grabbed.at[0], at[1] - grabbed.at[1]] : [0, 0],
        moved: false,
      };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    if (g.kind === "ink") {
      const native = event.nativeEvent as PointerEvent;
      const samples = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
      for (const sample of samples.length ? samples : [native]) {
        const at = toPage(sample.clientX, sample.clientY);
        const pressure = pressureOf(sample);
        paintPiece(g.mark, g.last, at, pressure);
        g.mark.points.push([at[0], at[1], pressure]);
        g.last = at;
      }
    } else if (g.kind === "box") {
      setPreview(boxOf(g.start, toPage(event.clientX, event.clientY), edit.color));
    } else if (g.kind === "erase") {
      const at = toPage(event.clientX, event.clientY);
      const next = eraseAlong(g.layer, n, g.last, at, ERASE_PX * unitsPerPixel(), edit.showSent);
      g.last = at;
      if (next !== g.layer) {
        g.layer = next;
        edit.scratch(next);
      }
    } else if (g.index >= 0) {
      if (!g.moved && Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < DRAG_SLOP) return;
      g.moved = true;
      const grabbed = edit.base.pages[n]?.marks[g.index];
      if (grabbed?.kind !== "text") return;
      const at = toPage(event.clientX, event.clientY);
      edit.scratch(replaceMark(edit.base, n, g.index, moveNote(grabbed, [at[0] - g.grab[0], at[1] - g.grab[1]], size)));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.type === "pointercancel" && g.kind !== "erase") {
      // A gesture the engine took over is not a mark, nor a move.
      setPreview(null);
      if (g.kind === "text") edit.scratch(null);
      redraw();
      return;
    }
    if (g.kind === "ink") {
      // Kept, the stroke is redrawn curved with the layer; refused, its pieces go.
      if (!edit.add(n, size, finishStroke(g.mark, size))) redraw();
    } else if (g.kind === "box") {
      setPreview(null);
      const box = boxOf(g.start, toPage(event.clientX, event.clientY), edit.color);
      if (box.rect[2] >= 2 && box.rect[3] >= 2) edit.add(n, size, box);
    } else if (g.kind === "erase") {
      if (g.layer !== edit.base) edit.commit(g.layer);
      else edit.scratch(null);
    } else if (g.moved) {
      if (edit.layer !== edit.base) edit.commit(edit.layer);
    } else {
      // A click: edit the note under it, or start a new one there.
      const existing = g.index >= 0 ? (edit.base.pages[n].marks[g.index] as TextMark) : null;
      const draft: NoteDraft = existing
        ? { n, pageSize: size, at: existing.at, index: g.index, text: existing.text, color: existing.color, size: existing.size }
        : {
            n,
            pageSize: size,
            at: [round(g.start[0]), round(g.start[1])],
            index: null,
            text: "",
            color: edit.color,
            size: Math.min(200, Math.max(4, Math.round(size[0] / 40))),
          };
      edit.openNote(draft);
    }
  };

  const note = edit.note?.n === n ? edit.note : null;
  return (
    <div
      ref={wrapRef}
      className={`file-viewer-pdf-markup-layer is-${edit.tool}`}
      style={{ width: cssW, height: cssH }}
      aria-label={t("pdfMarkup.layerLabel", { n })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Right-click is not a markup gesture, and the page's own (place a remark)
      // is off while marking.
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="file-viewer-pdf-markup-canvas" aria-hidden="true" />
      {note && <MarkupNoteEditor note={note} scale={scale} pageWidth={size[0]} edit={edit} />}
    </div>
  );
}

/** The width of the note card, CSS pixels — the remark card's. */
const CARD_W = 260;

/** The typed note, edited where it sits on the page — the remark card's chrome. */
function MarkupNoteEditor({ note, scale, pageWidth, edit }: { note: NoteDraft; scale: number; pageWidth: number; edit: MarkupEdit }) {
  const t = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The viewer's own keys (undo, page steps, leaving markup) stay out of a
    // note being typed.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      edit.cancelNote();
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (note.text.trim()) edit.saveNote(note.text);
    }
  };
  return (
    <div
      className="file-viewer-pdf-note-card file-viewer-pdf-markup-note"
      style={{ left: Math.max(0, Math.min(note.at[0] * scale, pageWidth * scale - CARD_W)), top: note.at[1] * scale }}
      role="group"
      aria-label={t("pdfMarkup.noteLabel")}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <textarea
        autoFocus
        className="file-viewer-pdf-note-text"
        value={note.text}
        rows={3}
        maxLength={2000}
        placeholder={t("mobile.markup.notePlaceholder")}
        aria-label={t("mobile.markup.notePlaceholder")}
        style={{ color: INK[note.color] }}
        onChange={(event) => edit.editNote(event.target.value)}
      />
      <div className="file-viewer-pdf-note-actions">
        <button
          type="button"
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={() => edit.saveNote(note.text)}
          disabled={!note.text.trim()}
        >
          {t("mobile.markup.noteDone")}
        </button>
        <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={edit.cancelNote}>
          {t("mobile.markup.noteCancel")}
        </button>
        {note.index !== null && (
          <button
            type="button"
            className="file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-note-del"
            onClick={() => edit.saveNote(null)}
          >
            {t("mobile.markup.noteDelete")}
          </button>
        )}
      </div>
    </div>
  );
}
