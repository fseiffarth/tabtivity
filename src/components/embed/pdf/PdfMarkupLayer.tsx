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
 *
 * Beside the pen, box, note and eraser: the text marks (a drag over the
 * page's words, snapped to its lines), the stamp (a click places the
 * symbol), and the select tool (a click or a dragged box picks marks, a drag
 * of the selection moves them; a lone mark takes a comment in a card). A pen
 * stroke held still at its end snaps to a line or an ellipse (`snapStroke`).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useT, type TranslationKey } from "../../../lib/i18n";
import { textMarks } from "../../../../mobile-web/src/markup/anchors";
import {
  clampToPage,
  selectionBox,
  eraseAlong,
  eraseAt,
  eraseRect,
  finishStroke,
  inkWidth,
  markAt,
  markBox,
  marksIn,
  marksInLoop,
  MAX_COMMENT,
  moveMarks,
  moveNote,
  noteAt,
  replaceMark,
  round,
  resizeMarks,
  snapStroke,
  straightenStroke,
  stampSize,
  stylusErases,
  type BoxMark,
  type InkMark,
  type Mark,
  type MarkColor,
  type PageLayer,
  PEN_STYLES,
  type PenStyle,
  type StampMark,
  type TextMark,
} from "../../../../mobile-web/src/markup/layer";
import { drawMark, drawPage, INK, type Paint } from "../../../../mobile-web/src/markup/rasterize";
import { colorsFor, eraserPx, inkStyle, penCursor, SNAP_HOLD_MS, SNAP_SLOP_PX, strokePressure, strokeWidth } from "../../../../mobile-web/src/markup/pen";
import { selectionColors } from "./PdfMarkupBar";
import { PEN_STYLE_KEYS, SwatchButtons } from "./PdfMarkupDock";
import type { CommentDraft, MarkupEdit, NoteDraft } from "./usePdfMarkup";

/** How strongly the marks of earlier rounds show — sent, never sent again. */
export const SENT_ALPHA = 0.35;
/** The widest the layer canvas is backed at, in device pixels. */
const MAX_BACKING = 8192;
/** How far a pointer travels on a note before it is a drag, not a click. */
const DRAG_SLOP = 4;
/** The eraser's reach at its medium size, CSS pixels (`eraserPx`). */
const ERASE_PX = 10;
/** How near a click must come to a mark to select it, CSS pixels. */
const PICK_PX = 6;
/** A pen has drawn in this window: from then on a finger pans the pages and
 *  only the pen (or the mouse) marks — the phone's rule, for a touch screen
 *  with a pen. Kept for the window's life. */
let penSeen = false;
/** The selection's resize handle: its side and how near a press must come, CSS px. */
const HANDLE_PX = 9;

type Size = [number, number];

/** The select tool's drag: from where, and whether Shift adds to the selection. */
type SelectDrag = { pointerId: number; start: [number, number]; clientX: number; clientY: number; moved: boolean; add: boolean };

/** What a pointer is doing on the page between down and up. */
type Gesture =
  | {
      kind: "ink";
      pointerId: number;
      mark: InkMark;
      last: [number, number];
      /** Where the pointer came to rest (client px) and the snap's timer. */
      hold: [number, number];
      timer: number | null;
      /** The stroke as the hold snapped it, kept on release. */
      snapped: InkMark | null;
      /** Unsnapped by moving on: from then on shown whole, not piecewise. */
      whole: boolean;
    }
  | { kind: "box"; pointerId: number; start: [number, number] }
  | { kind: "textmark"; pointerId: number; start: [number, number] }
  | { kind: "stamp"; pointerId: number }
  /** The select tool: a click or a dragged box picking marks (`pick`), or a
   *  drag of the selection moving it (`move`). */
  | ({ kind: "pick" } & SelectDrag)
  | ({ kind: "move" } & SelectDrag)
  /** The lasso's freehand loop, page units. */
  | ({ kind: "loop"; loop: [number, number][] } & SelectDrag)
  /** The selection's corner handle dragged: resized about its top-left. */
  | { kind: "scale"; pointerId: number; origin: [number, number]; from: number }
  | { kind: "erase"; pointerId: number; layer: MarkupEdit["base"]; last: [number, number] }
  /** The area eraser's rectangle, from where it was pressed. */
  | { kind: "area"; pointerId: number; start: [number, number] }
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

/** The marks at `indices` of `page` boxed together `[x0, y0, x1, y1]`, or `null`. */
const boxAround = selectionBox;

/** A dashed outline, white under dark so it shows on any page — the area
 *  eraser's rectangle, the select tool's box and its selection. */
function dashedRect(ctx: CanvasRenderingContext2D, rect: readonly number[], k: number, dpr: number) {
  const [x0, y0, x1, y1] = rect.map((v) => v * k);
  ctx.save();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = "white";
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#333";
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

/** The lasso's loop as it is drawn, dashed like the select tool's box. */
function dashedLoop(ctx: CanvasRenderingContext2D, loop: readonly [number, number][], k: number, dpr: number) {
  if (loop.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(loop[0][0] * k, loop[0][1] * k);
    for (const [x, y] of loop.slice(1)) ctx.lineTo(x * k, y * k);
  };
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = "white";
  trace();
  ctx.stroke();
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#333";
  trace();
  ctx.stroke();
  ctx.restore();
}

/** The selection's resize handle at its bottom-right corner. */
function handleSquare(ctx: CanvasRenderingContext2D, at: [number, number], dpr: number) {
  const side = HANDLE_PX * dpr;
  ctx.save();
  ctx.fillStyle = "white";
  ctx.strokeStyle = "#333";
  ctx.lineWidth = dpr;
  ctx.fillRect(at[0] - side / 2, at[1] - side / 2, side, side);
  ctx.strokeRect(at[0] - side / 2, at[1] - side / 2, side, side);
  ctx.restore();
}

export function PdfMarkupLayer({ n, size, scale, edit }: { n: number; size: Size; scale: number; edit: MarkupEdit }) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** What a gesture in flight will add: a stroke, a box, a stamp, the lines a
   *  text-mark drag covers. */
  const [preview, setPreview] = useState<Mark[]>([]);
  /** The area eraser's or the select tool's rectangle while it is dragged,
   *  `[x0, y0, x1, y1]`. */
  const [area, setArea] = useState<[number, number, number, number] | null>(null);
  /** The lasso's loop while it is drawn. */
  const [loop, setLoop] = useState<[number, number][] | null>(null);
  const [fingersPan, setFingersPan] = useState(penSeen);

  const cssW = size[0] * scale;
  const cssH = size[1] * scale;
  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const pixelW = Math.max(1, Math.min(MAX_BACKING, Math.round(cssW * dpr)));
  const pixelH = Math.max(1, Math.round((pixelW * size[1]) / size[0]));
  const page = edit.layer.pages[n];
  const sent = edit.showSent ? edit.layer.sent?.pages[n] : undefined;
  const selection = edit.selection?.n === n ? edit.selection : null;
  /** The selection's outline, following a move in flight. */
  const selBox = selection ? boxAround(page, selection.indices) : null;
  /** The selection's outline as drawn, padded a little off the marks. */
  const selPad = 3 / scale;
  const selKey = selBox?.join(",") ?? "";

  /** The committed marks drawn once, for the length of a gesture that repaints
   *  the layer on every pointer move (a box, an arrow, a stamp, an area): each
   *  move then copies this instead of redrawing every mark. Dropped as the
   *  gesture ends, so it holds no second backing store at rest. */
  const committed = useRef<{ page: PageLayer | undefined; sent: PageLayer | undefined; w: number; h: number; canvas: HTMLCanvasElement } | null>(null);
  const dropCommitted = () => {
    const held = committed.current;
    if (held) {
      held.canvas.width = 0;
      held.canvas.height = 0;
    }
    committed.current = null;
  };
  /** Paints the committed marks onto `ctx`, from the copy while a gesture is
   *  in flight. */
  const paintCommitted = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, k: number, gesturing: boolean) => {
    if (!gesturing) {
      dropCommitted();
      paintLayer(ctx, page, sent, k);
      return;
    }
    let held = committed.current;
    if (!held || held.page !== page || held.sent !== sent || held.w !== canvas.width || held.h !== canvas.height) {
      dropCommitted();
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const copyCtx = copy.getContext("2d");
      if (!copyCtx) {
        paintLayer(ctx, page, sent, k);
        return;
      }
      paintLayer(copyCtx, page, sent, k);
      held = { page, sent, w: canvas.width, h: canvas.height, canvas: copy };
      committed.current = held;
    }
    ctx.drawImage(held.canvas, 0, 0);
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = canvas.width / size[0];
    paintCommitted(ctx, canvas, k, preview.length > 0 || area !== null || loop !== null);
    if (preview.length) {
      ctx.save();
      ctx.scale(k, k);
      for (const mark of preview) drawMark(ctx, mark);
      ctx.restore();
    }
    if (selBox) {
      const pad = 3 / (k / dpr);
      dashedRect(ctx, [selBox[0] - pad, selBox[1] - pad, selBox[2] + pad, selBox[3] + pad], k, dpr);
      handleSquare(ctx, [(selBox[2] + pad) * k, (selBox[3] + pad) * k], dpr);
    }
    if (area) dashedRect(ctx, area, k, dpr);
    if (loop) dashedLoop(ctx, loop, k, dpr);
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = pixelW;
    canvas.height = pixelH;
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sent, preview, area, loop, selKey, pixelW, pixelH]);
  // A canvas gives its backing store back the moment it goes; a snap's timer
  // goes with the layer.
  useEffect(
    () => () => {
      const g = gesture.current;
      if (g?.kind === "ink" && g.timer !== null) window.clearTimeout(g.timer);
      dropCommitted();
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

  /** The newest piece of the stroke in progress, straight onto the canvas:
   *  the curve from the midpoint before the last sample, through it, to the
   *  midpoint after it — the curves `rasterize.ts` draws the finished stroke
   *  with, so nothing jumps when the pen lifts. The first sample is a dot. */
  const paintPiece = (mark: InkMark) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const points = mark.points;
    if (!canvas || !ctx || !points.length) return;
    const k = canvas.width / size[0];
    const at = points.length - 1;
    const mid = (a: readonly number[], b: readonly number[]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    ctx.save();
    ctx.scale(k, k);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK[mark.color];
    ctx.beginPath();
    if (at === 0) {
      ctx.lineWidth = inkWidth(mark.width, points[0][2]);
      ctx.moveTo(points[0][0], points[0][1]);
      ctx.lineTo(points[0][0], points[0][1]);
    } else {
      const control = points[at - 1];
      const from = at >= 2 ? mid(points[at - 2], control) : [control[0], control[1]];
      const to = mid(control, points[at]);
      ctx.lineWidth = inkWidth(mark.width, control[2]);
      ctx.moveTo(from[0], from[1]);
      ctx.quadraticCurveTo(control[0], control[1], to[0], to[1]);
    }
    ctx.stroke();
    ctx.restore();
  };

  /** A real pen's reading bends by the pressure curve; a mouse or a finger
   *  draws at the even base width. */
  /** The style the armed pen or highlighter draws in. */
  const style = inkStyle(edit.pen);
  const pressureOf = (event: { pointerType: string; pressure: number }) =>
    event.pointerType === "pen" && event.pressure > 0
      ? strokePressure(style, event.pressure, edit.pen.pressure)
      : strokePressure(style, 0.5);
  /** Only the plain pen paints its pieces as they come; a styled stroke is
   *  one path (see-through, dashed, headed), shown whole as it grows. */
  const piecewise = style === "pen";
  const eraseReach = () => eraserPx(ERASE_PX, edit.pen.eraser) * unitsPerPixel();
  /** How the eraser takes marks: whole strokes unless it rubs (Partial) — a
   *  pen's eraser end or side button rubs as the eraser's mode says, whole
   *  strokes for the area mode. */
  const eraseHow = () => ({ sent: edit.showSent, whole: edit.pen.eraser !== "partial", highlights: edit.pen.eraseHighlights });
  /** A highlighter stroke with Straight lines on is shown — and kept — as its
   *  straight line. */
  const straight = edit.tool === "highlight" && edit.pen.straight;
  const shaped = (mark: InkMark): InkMark => (straight ? straightenStroke(mark) : mark);
  const areaOf = (a: [number, number], b: [number, number]): [number, number, number, number] =>
    [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  /** What a text-mark drag from `start` to `at` covers; none until the page's
   *  text is read. */
  const textMarksTo = (start: [number, number], at: [number, number]): Mark[] => {
    const runs = edit.text(n);
    if (!runs?.length) return [];
    return textMarks(runs, start, at, edit.pen.textMark, edit.color, strokeWidth(size[0], { size: edit.pen.size, style: "pen" }));
  };
  const stampAt = (at: [number, number]): StampMark => ({
    kind: "stamp",
    color: edit.color,
    at: [round(at[0]), round(at[1])],
    size: stampSize(size[0]),
    symbol: edit.pen.stamp,
  });
  /** (Re)starts the wait for a held stroke to snap: held still that long, the
   *  stroke shows as the shape it almost is, and is kept so on release. */
  const holdFor = (g: Extract<Gesture, { kind: "ink" }>) => {
    if (g.timer !== null) window.clearTimeout(g.timer);
    g.timer = null;
    // A straight highlighter stroke is a line already.
    if (!edit.pen.snap || straight) return;
    g.timer = window.setTimeout(() => {
      g.timer = null;
      if (gesture.current !== g) return;
      const snapped = snapStroke(finishStroke(g.mark, size));
      if (!snapped) return;
      g.snapped = snapped;
      setPreview([snapped]);
    }, SNAP_HOLD_MS);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "pen" && !penSeen) {
      penSeen = true;
      setFingersPan(true);
    }
    // Once a pen has drawn, a finger scrolls: the browser takes it.
    if (event.pointerType === "touch" && penSeen) return;
    // A pen's eraser end presses button 5.
    if (edit.busy || (event.button !== 0 && !stylusErases(event))) return;
    if (edit.note) {
      // A click away from an open note keeps what was typed, as Done would.
      edit.saveNote(edit.note.text);
      return;
    }
    if (edit.comment) {
      // The same for a comment being typed.
      edit.saveComment(edit.comment.text);
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = toPage(event.clientX, event.clientY);
    if (edit.tool === "eraser" && edit.pen.eraser === "area" && !stylusErases(event)) {
      gesture.current = { kind: "area", pointerId: event.pointerId, start: at };
      setArea(areaOf(at, at));
    } else if (edit.tool === "eraser" || stylusErases(event)) {
      const next = eraseAt(edit.base, n, at[0], at[1], eraseReach(), eraseHow());
      gesture.current = { kind: "erase", pointerId: event.pointerId, layer: next, last: at };
      if (next !== edit.base) edit.scratch(next);
    } else if (edit.tool === "ink" || edit.tool === "highlight") {
      const pressure = pressureOf(event);
      const mark: InkMark = {
        kind: "ink",
        color: edit.color,
        width: strokeWidth(size[0], { size: edit.pen.size, style }),
        points: [[at[0], at[1], pressure]],
      };
      if (style !== "pen") mark.style = style;
      const g: Gesture = {
        kind: "ink",
        pointerId: event.pointerId,
        last: at,
        mark,
        hold: [event.clientX, event.clientY],
        timer: null,
        snapped: null,
        whole: false,
      };
      gesture.current = g;
      if (!straight) holdFor(g);
      if (piecewise) paintPiece(mark);
      else setPreview([shaped({ ...mark, points: mark.points.slice() })]);
    } else if (edit.tool === "box") {
      gesture.current = { kind: "box", pointerId: event.pointerId, start: at };
    } else if (edit.tool === "textmark") {
      edit.wantText(n);
      gesture.current = { kind: "textmark", pointerId: event.pointerId, start: at };
      setPreview(textMarksTo(at, at));
    } else if (edit.tool === "stamp") {
      gesture.current = { kind: "stamp", pointerId: event.pointerId };
      setPreview([stampAt(at)]);
    } else if (edit.tool === "select") {
      // On the selection's corner handle: a drag resizes it; on its outline:
      // a drag moves it. Elsewhere: a click picks the mark under it, a drag a
      // loop (or, in rectangle mode, a box) of marks; Shift adds to them.
      const units = unitsPerPixel();
      const pad = PICK_PX * units;
      const corner: [number, number] | null = selBox ? [selBox[2] + selPad, selBox[3] + selPad] : null;
      if (corner && selBox && !event.shiftKey && Math.max(Math.abs(at[0] - corner[0]), Math.abs(at[1] - corner[1])) <= HANDLE_PX * units) {
        const origin: [number, number] = [selBox[0], selBox[1]];
        gesture.current = { kind: "scale", pointerId: event.pointerId, origin, from: Math.max(1e-6, Math.hypot(at[0] - origin[0], at[1] - origin[1])) };
        return;
      }
      const onSelection = !!selBox && !event.shiftKey
        && at[0] >= selBox[0] - pad && at[0] <= selBox[2] + pad && at[1] >= selBox[1] - pad && at[1] <= selBox[3] + pad;
      const drag: SelectDrag = { pointerId: event.pointerId, start: at, clientX: event.clientX, clientY: event.clientY, moved: false, add: event.shiftKey };
      gesture.current = onSelection
        ? { kind: "move", ...drag }
        : edit.pen.lasso === "free"
          ? { kind: "loop", loop: [at], ...drag }
          : { kind: "pick", ...drag };
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
      // Moving on past the hold's slop: a snapped stroke is itself again,
      // and the wait starts over.
      if (Math.hypot(event.clientX - g.hold[0], event.clientY - g.hold[1]) > SNAP_SLOP_PX) {
        g.hold = [event.clientX, event.clientY];
        if (g.snapped) {
          g.snapped = null;
          g.whole = true;
        }
        holdFor(g);
      }
      const pieces = piecewise && !g.whole;
      for (const sample of samples.length ? samples : [native]) {
        const at = toPage(sample.clientX, sample.clientY);
        const pressure = pressureOf(sample);
        g.mark.points.push([at[0], at[1], pressure]);
        if (pieces && !g.snapped) paintPiece(g.mark);
        g.last = at;
      }
      if (!pieces && !g.snapped) setPreview([shaped({ ...g.mark, points: g.mark.points.slice() })]);
    } else if (g.kind === "area") {
      setArea(areaOf(g.start, toPage(event.clientX, event.clientY)));
    } else if (g.kind === "box") {
      setPreview([boxOf(g.start, toPage(event.clientX, event.clientY), edit.color)]);
    } else if (g.kind === "textmark") {
      setPreview(textMarksTo(g.start, toPage(event.clientX, event.clientY)));
    } else if (g.kind === "stamp") {
      setPreview([stampAt(toPage(event.clientX, event.clientY))]);
    } else if (g.kind === "scale") {
      if (!selection) return;
      const at = toPage(event.clientX, event.clientY);
      edit.scratch(resizeMarks(edit.base, n, selection.indices, g.origin, Math.hypot(at[0] - g.origin[0], at[1] - g.origin[1]) / g.from));
    } else if (g.kind === "pick" || g.kind === "move" || g.kind === "loop") {
      if (!g.moved && Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < DRAG_SLOP) return;
      g.moved = true;
      const at = toPage(event.clientX, event.clientY);
      if (g.kind === "pick") setArea(areaOf(g.start, at));
      else if (g.kind === "loop") {
        g.loop.push(at);
        setLoop(g.loop.slice());
      } else if (selection) edit.scratch(moveMarks(edit.base, n, selection.indices, at[0] - g.start[0], at[1] - g.start[1]));
    } else if (g.kind === "erase") {
      const at = toPage(event.clientX, event.clientY);
      const next = eraseAlong(g.layer, n, g.last, at, eraseReach(), eraseHow());
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
    if (g.kind === "ink" && g.timer !== null) window.clearTimeout(g.timer);
    if (event.type === "pointercancel" && g.kind !== "erase") {
      // A gesture the engine took over is not a mark, nor a move.
      setPreview([]);
      setArea(null);
      setLoop(null);
      if (g.kind === "text" || g.kind === "move" || g.kind === "scale") edit.scratch(null);
      redraw();
      return;
    }
    if (g.kind === "ink") {
      // Kept, the stroke is redrawn curved with the layer; refused, its pieces go.
      setPreview([]);
      if (!edit.add(n, size, g.snapped ?? shaped(finishStroke(g.mark, size)))) redraw();
    } else if (g.kind === "area") {
      setArea(null);
      const next = eraseRect(edit.base, n, g.start, toPage(event.clientX, event.clientY), { sent: edit.showSent, highlights: edit.pen.eraseHighlights });
      if (next !== edit.base) edit.commit(next);
    } else if (g.kind === "box") {
      setPreview([]);
      const box = boxOf(g.start, toPage(event.clientX, event.clientY), edit.color);
      if (box.rect[2] >= 2 && box.rect[3] >= 2) edit.add(n, size, box);
    } else if (g.kind === "textmark") {
      setPreview([]);
      edit.addAll(n, size, textMarksTo(g.start, toPage(event.clientX, event.clientY)));
    } else if (g.kind === "stamp") {
      setPreview([]);
      edit.add(n, size, stampAt(toPage(event.clientX, event.clientY)));
    } else if (g.kind === "scale") {
      if (edit.layer !== edit.base) edit.commitSelection(edit.layer);
      else edit.scratch(null);
    } else if (g.kind === "pick" || g.kind === "loop") {
      setArea(null);
      setLoop(null);
      const at = toPage(event.clientX, event.clientY);
      const picked = !g.moved
        ? [markAt(edit.base.pages[n], at[0], at[1], PICK_PX * unitsPerPixel())].filter((i) => i >= 0)
        : g.kind === "loop"
          ? marksInLoop(edit.base.pages[n], g.loop)
          : marksIn(edit.base.pages[n], areaOf(g.start, at));
      // Shift adds to (a click on a selected mark: takes from) this page's selection.
      const kept = g.add && selection ? selection.indices : [];
      const toggled = g.add && !g.moved && picked.length === 1 && kept.includes(picked[0]);
      const next = toggled ? kept.filter((i) => i !== picked[0]) : [...new Set([...kept, ...picked])].sort((a, b) => a - b);
      if (next.length) edit.select(n, next);
      else edit.clearSelection();
    } else if (g.kind === "move") {
      const at = toPage(event.clientX, event.clientY);
      const next = g.moved && selection ? moveMarks(edit.base, n, selection.indices, at[0] - g.start[0], at[1] - g.start[1]) : edit.base;
      if (next !== edit.base) edit.commitSelection(next);
      else edit.scratch(null);
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

  /** A move, a resize, a loop or a box in flight: the selection bar waits. */
  const gesturing = edit.layer !== edit.base || area !== null || loop !== null;
  const note = edit.note?.n === n ? edit.note : null;
  const comment = edit.comment?.n === n ? edit.comment : null;
  const commented = comment ? edit.base.pages[n]?.marks[comment.index] : undefined;
  /** The cursor shows what the next stroke draws: a dot of the pen's colour
   *  at its width, the eraser's ring at its reach; the area eraser, the box
   *  and the note keep the strip's own cursors. */
  const cursor =
    edit.tool === "ink" || edit.tool === "highlight"
      ? penCursor("dot", strokeWidth(size[0], { size: edit.pen.size, style }) * scale, INK[edit.color])
      : edit.tool === "eraser" && edit.pen.eraser !== "area"
        ? penCursor("ring", 2 * eraserPx(ERASE_PX, edit.pen.eraser), "")
        : undefined;
  return (
    <div
      ref={wrapRef}
      className={`file-viewer-pdf-markup-layer is-${edit.tool}${edit.tool === "eraser" && edit.pen.eraser === "area" ? " is-area" : ""}${fingersPan || penSeen ? " is-fingers-pan" : ""}`}
      style={{ width: cssW, height: cssH, cursor }}
      aria-label={t("pdfMarkup.layerLabel", { n })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // The text marks need the page's words: read as the pointer comes over it.
      onPointerEnter={edit.tool === "textmark" ? () => edit.wantText(n) : undefined}
      // Right-click is not a markup gesture, and the page's own (place a remark)
      // is off while marking.
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="file-viewer-pdf-markup-canvas" aria-hidden="true" />
      {note && <MarkupNoteEditor note={note} scale={scale} pageWidth={size[0]} edit={edit} />}
      {comment && commented && (
        <MarkupCommentEditor comment={comment} mark={commented} scale={scale} pageWidth={size[0]} edit={edit} />
      )}
      {selection && selBox && !comment && !gesturing && (
        <MarkupSelectionBar box={selBox} scale={scale} pageWidth={size[0]} edit={edit} />
      )}
    </div>
  );
}

/** The pen styles' names, the highlighter's (`marker`) by its tool's name. */
const STYLE_NAME_KEYS: Record<PenStyle, TranslationKey> = { ...PEN_STYLE_KEYS, marker: "mobile.markup.tool.highlight" };
/** How far a copy lands from the marks it copies, CSS pixels. */
const COPY_PX = 16;
/** The selection bar's height and its gap to the marks, CSS pixels. */
const BAR_H = 34;

/** The selected marks' own bar, just above them (below where the page ends
 *  above): their colours, Copy, Comment for a lone mark, Delete. */
function MarkupSelectionBar({ box, scale, pageWidth, edit }: { box: [number, number, number, number]; scale: number; pageWidth: number; edit: MarkupEdit }) {
  const t = useT();
  const selection = edit.selection;
  if (!selection) return null;
  const marks = selection.indices.flatMap((i) => edit.base.pages[selection.n]?.marks[i] ?? []);
  const shared = marks.length && marks.every((mark) => mark.color === marks[0].color) ? marks[0].color : null;
  const inks = marks.flatMap((mark) => (mark.kind === "ink" ? [mark] : []));
  const style = inks.length && inks.every((mark) => (mark.style ?? "pen") === (inks[0].style ?? "pen")) ? inks[0].style ?? "pen" : null;
  const top = box[1] * scale - BAR_H - 8 >= 0 ? box[1] * scale - BAR_H - 8 : box[3] * scale + 8;
  const left = Math.max(0, Math.min(box[0] * scale, pageWidth * scale - 280));
  return (
    <div
      className="context-menu file-viewer-pdf-markup-selbar"
      style={{ left, top }}
      role="toolbar"
      aria-label={t("mobile.markup.selected", { count: selection.indices.length })}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="file-viewer-pdf-markup-colors" role="group" aria-label={t("mobile.markup.color")}>
        <SwatchButtons colors={selectionColors(edit.base, selection)} chosen={shared} onPick={(color) => edit.restyleSelection({ color })} />
      </span>
      {inks.length > 0 && (
        <select
          className="file-viewer-pdf-markup-selstyle"
          value={style ?? ""}
          aria-label={t("mobile.markup.style")}
          title={t("mobile.markup.style")}
          onChange={(event) => event.target.value && edit.restyleSelection({ style: event.target.value as PenStyle })}
        >
          {style === null && <option value="">{t("mobile.markup.style")}</option>}
          {PEN_STYLES.map((option) => (
            <option key={option} value={option}>
              {t(STYLE_NAME_KEYS[option])}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={() => edit.copySelection(COPY_PX / scale)}>
        {t("pdfMarkup.copy")}
      </button>
      {edit.canComment && (
        <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={edit.openComment}>
          {t("mobile.markup.comment")}
        </button>
      )}
      <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-note-del" onClick={edit.deleteSelection}>
        {t("mobile.markup.deleteSelected")}
      </button>
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
      {/* The note's colour — the prompt names it unless black. */}
      <div className="file-viewer-pdf-markup-colors file-viewer-pdf-markup-note-colors" role="group" aria-label={t("mobile.markup.noteColor")}>
        <SwatchButtons colors={colorsFor("text", "pen")} chosen={note.color} onPick={edit.editNoteColor} />
      </div>
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

/** A selected mark's comment, typed in a card under the mark — the note
 *  card's chrome. One line: Enter saves, Escape lets it be. */
function MarkupCommentEditor({
  comment,
  mark,
  scale,
  pageWidth,
  edit,
}: {
  comment: CommentDraft;
  mark: Mark;
  scale: number;
  pageWidth: number;
  edit: MarkupEdit;
}) {
  const t = useT();
  const [x, y, , h] = markBox(mark);
  const had = mark.kind !== "text" && !!mark.comment;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The viewer's own keys (Delete deletes the selection) stay out of it.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      edit.cancelComment();
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      edit.saveComment(comment.text);
    }
  };
  return (
    <div
      className="file-viewer-pdf-note-card file-viewer-pdf-markup-comment"
      style={{ left: Math.max(0, Math.min(x * scale, pageWidth * scale - CARD_W)), top: (y + h) * scale + 6 }}
      role="group"
      aria-label={t("mobile.markup.comment")}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <textarea
        autoFocus
        className="file-viewer-pdf-note-text"
        value={comment.text}
        rows={2}
        maxLength={MAX_COMMENT}
        placeholder={t("mobile.markup.commentPlaceholder")}
        aria-label={t("mobile.markup.commentPlaceholder")}
        onChange={(event) => edit.editComment(event.target.value)}
      />
      <div className="file-viewer-pdf-note-actions">
        <button
          type="button"
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={() => edit.saveComment(comment.text)}
          disabled={!comment.text.trim() && !had}
        >
          {t("mobile.markup.commentSave")}
        </button>
        <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={edit.cancelComment}>
          {t("mobile.markup.noteCancel")}
        </button>
        {had && (
          <button
            type="button"
            className="file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-note-del"
            onClick={() => edit.saveComment(null)}
          >
            {t("mobile.markup.commentRemove")}
          </button>
        )}
      </div>
    </div>
  );
}
