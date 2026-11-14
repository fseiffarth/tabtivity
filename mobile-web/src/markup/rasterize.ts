/**
 * Draws a page's marks onto a 2D canvas context — the one drawing routine
 * behind the layer on screen, the page pictures Submit sends (or the
 * transparent layer where a page could not be drawn), and a picture with its
 * marks drawn on. Strokes are quadratic curves through the
 * midpoints of their samples, one piece per sample at that sample's width:
 * the same curves the desktop writes into the marked PDF (`markup_pdf.rs`).
 */

import { arrowHead, inkWidth, LEADING, markBox, stampLines, STAMP_WIDTH, type InkMark, type Mark, type MarkColor, type PageLayer } from "./layer";

export const INK: Record<MarkColor, string> = {
  red: "#db2626",
  blue: "#2663eb",
  black: "#121212",
  yellow: "#ffd91a",
  green: "#16a34a",
  orange: "#ea7a0c",
  purple: "#7c3aed",
  pink: "#ec4899",
};
/** How strongly a highlighter box — and the marker — covers the page. */
export const HIGHLIGHT_ALPHA = 0.4;
/** A dashed stroke's dash and gap, in multiples of its width (round caps
 * close a width of the gap). The desktop's `markup_pdf.rs` dashes alike. */
export const DASH = [2.5, 3.5] as const;
/** The layer PNG's width; its height follows the page's aspect. */
export const LAYER_WIDTH = 1200;
/** The widest a picture with its marks is composed at. */
export const MAX_COMPOSED = 4096;

/** The 2D context calls drawing needs — narrow, so tests can record them. */
export type Paint = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "scale" | "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "stroke" | "fillRect" | "fillText"
> & {
  lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin; strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern; globalAlpha: number; globalCompositeOperation: GlobalCompositeOperation;
  font: string; textBaseline: CanvasTextBaseline;
  /** Only dashed strokes call it; a recording test context may leave it out. */
  setLineDash?: (segments: number[]) => void;
  /** Only a comment badge's tail calls these; without them it is drawn as an
   * outline instead. */
  fill?: () => void;
  closePath?: () => void;
};

/** The pieces of one stroke: from, curve control and to, and the pressure
 * the piece is drawn at. A one-sample stroke is a dot. */
export function strokePieces(points: [number, number, number][]): { from: [number, number]; control?: [number, number]; to: [number, number]; pressure: number }[] {
  const at = (i: number): [number, number] => [points[i][0], points[i][1]];
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [{ from: at(0), to: at(0), pressure: points[0][2] }];
  if (n === 2) return [{ from: at(0), to: at(1), pressure: (points[0][2] + points[1][2]) / 2 }];
  const pieces: { from: [number, number]; control?: [number, number]; to: [number, number]; pressure: number }[] = [
    { from: at(0), to: mid(at(0), at(1)), pressure: points[0][2] },
  ];
  for (let i = 1; i < n - 1; i++) {
    pieces.push({ from: mid(at(i - 1), at(i)), control: at(i), to: mid(at(i), at(i + 1)), pressure: points[i][2] });
  }
  pieces.push({ from: mid(at(n - 2), at(n - 1)), to: at(n - 1), pressure: points[n - 1][2] });
  return pieces;
}

/** A styled stroke (`marker`, `dashed`, `arrow`): one even path through the
 * same curves as the pen's, so a see-through marker does not darken where its
 * pieces meet and dashes run on across them; an arrow adds its head. */
function drawStyled(ctx: Paint, mark: InkMark): void {
  const style = mark.style ?? "pen";
  ctx.lineWidth = mark.width;
  if (style === "marker") {
    // Times the alpha around it: sent marks are drawn dimmed as a whole.
    ctx.globalAlpha *= HIGHLIGHT_ALPHA;
    ctx.globalCompositeOperation = "multiply";
  }
  if (style === "dashed") ctx.setLineDash?.([DASH[0] * mark.width, DASH[1] * mark.width]);
  const pieces = strokePieces(mark.points);
  ctx.beginPath();
  ctx.moveTo(pieces[0].from[0], pieces[0].from[1]);
  for (const piece of pieces) {
    if (piece.control) ctx.quadraticCurveTo(piece.control[0], piece.control[1], piece.to[0], piece.to[1]);
    else ctx.lineTo(piece.to[0], piece.to[1]);
  }
  ctx.stroke();
  const head = style === "arrow" ? arrowHead(mark.points, mark.width) : null;
  if (head) {
    ctx.beginPath();
    ctx.moveTo(head[0][0], head[0][1]);
    ctx.lineTo(head[1][0], head[1][1]);
    ctx.lineTo(head[2][0], head[2][1]);
    ctx.stroke();
  }
}

/** How large a comment badge is by default, in page units — about 10 pt;
 * `drawPage` sizes it to the page instead. */
export const COMMENT_BADGE = 10;

/** A small speech bubble at the top-right corner of a commented mark's box
 * (`markBox`), `size` page units wide, in the mark's colour with two white
 * lines of "text" — on screen and in the pictures Submit sends, so the agent
 * sees which mark the prompt's comment belongs to. */
export function drawCommentBadge(ctx: Paint, mark: Mark, size = COMMENT_BADGE): void {
  const [x, y, w] = markBox(mark);
  const left = x + w - size * 0.3;
  const top = y - size * 0.85;
  const height = size * 0.62;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = INK[mark.color];
  ctx.strokeStyle = INK[mark.color];
  ctx.fillRect(left, top, size, height);
  // The tail, down towards the mark's corner.
  ctx.beginPath();
  ctx.moveTo(left + size * 0.15, top + height);
  ctx.lineTo(left + size * 0.15, top + height + size * 0.28);
  ctx.lineTo(left + size * 0.45, top + height);
  if (ctx.fill && ctx.closePath) {
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.lineWidth = size * 0.08;
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(left + size * 0.18, top + height * 0.28, size * 0.64, height * 0.12);
  ctx.fillRect(left + size * 0.18, top + height * 0.6, size * 0.44, height * 0.12);
  ctx.restore();
}

/** Draws one mark; `badge` is the size of the comment badge a commented mark
 * gets (`drawCommentBadge`). */
export function drawMark(ctx: Paint, mark: Mark, badge = COMMENT_BADGE): void {
  ctx.save();
  if (mark.kind === "stamp") {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK[mark.color];
    ctx.lineWidth = mark.size * STAMP_WIDTH;
    for (const line of stampLines(mark)) {
      ctx.beginPath();
      ctx.moveTo(line[0][0], line[0][1]);
      for (const [x, y] of line.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
    }
  } else if (mark.kind === "ink" && mark.style && mark.style !== "pen" && mark.points.length > 0) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK[mark.color];
    drawStyled(ctx, mark);
  } else if (mark.kind === "ink") {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK[mark.color];
    for (const piece of strokePieces(mark.points)) {
      ctx.lineWidth = inkWidth(mark.width, piece.pressure);
      ctx.beginPath();
      ctx.moveTo(piece.from[0], piece.from[1]);
      if (piece.control) ctx.quadraticCurveTo(piece.control[0], piece.control[1], piece.to[0], piece.to[1]);
      else ctx.lineTo(piece.to[0], piece.to[1]);
      ctx.stroke();
    }
  } else if (mark.kind === "box") {
    // Times the alpha around it: sent marks are drawn dimmed as a whole.
    ctx.globalAlpha *= HIGHLIGHT_ALPHA;
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = INK[mark.color];
    ctx.fillRect(mark.rect[0], mark.rect[1], mark.rect[2], mark.rect[3]);
  } else {
    ctx.fillStyle = INK[mark.color];
    ctx.font = `${mark.size}px Helvetica, Arial, sans-serif`;
    ctx.textBaseline = "alphabetic";
    mark.text.split("\n").forEach((line, i) => {
      ctx.fillText(line, mark.at[0], mark.at[1] + mark.size * (0.9 + LEADING * i));
    });
  }
  ctx.restore();
  if (mark.kind !== "text" && mark.comment) drawCommentBadge(ctx, mark, badge);
}

/** A comment badge's size on a page: about 10 pt on A4, alike on a picture. */
export function badgeSize(page: PageLayer): number {
  return Math.max(page.size[0], page.size[1]) / 84;
}

/** Draws the marks of `page` from the `from`-th up to the `to`-th (all by
 * default), `scale` canvas pixels per page unit. */
export function drawPage(ctx: Paint, page: PageLayer, scale: number, from = 0, to = page.marks.length): void {
  ctx.save();
  ctx.scale(scale, scale);
  const badge = badgeSize(page);
  for (let i = from; i < to; i++) drawMark(ctx, page.marks[i], badge);
  ctx.restore();
}

/** How strongly the marks of earlier rounds show — sent, never sent again. */
export const SENT_ALPHA = 0.35;

/** The sent marks dimmed, then the unsent ones over them — the layer both
 * hosts show while marking. */
export function paintLayer(ctx: Paint, page: PageLayer | undefined, sent: PageLayer | undefined, scale: number): void {
  if (sent) {
    ctx.save();
    ctx.globalAlpha = SENT_ALPHA;
    drawPage(ctx, sent, scale);
    ctx.restore();
  }
  if (page) drawPage(ctx, page, scale);
}

/** `paintLayer` for the length of a gesture that repaints a page on every
 * pointer move: the sent marks and the page's marks the gesture has not
 * changed are painted once, onto a copy, and each move copies that and draws
 * only the rest — in the layer's own paint order, so overlapping and
 * see-through marks come out as a whole repaint would. The copy is rebuilt
 * (never patched) when the unchanged marks shrink, the sent side or the size
 * changes; `drop` gives its backing store back as the gesture ends. */
export class CommittedMarks {
  private held: { sent: PageLayer | undefined; source: readonly Mark[]; count: number; w: number; h: number; canvas: HTMLCanvasElement } | null = null;

  /** `paintLayer(ctx, page, sent, scale)` onto `canvas`' context `ctx`.
   * `base` is the page as it stood before the gesture: the marks `page`
   * shares with it, from the first, are the unchanged ones. */
  paint(ctx: CanvasRenderingContext2D, canvas: { width: number; height: number }, page: PageLayer | undefined, base: PageLayer | undefined, sent: PageLayer | undefined, scale: number): void {
    const marks = page?.marks ?? [];
    let held = this.held;
    if (!held || held.sent !== sent || held.w !== canvas.width || held.h !== canvas.height || !sharesPrefix(held.source, held.count, marks)) {
      this.drop();
      const count = page && base ? commonPrefix(marks, base.marks) : 0;
      if (count === 0 && !sent) {
        paintLayer(ctx, page, sent, scale);
        return;
      }
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const copyCtx = copy.getContext("2d");
      if (!copyCtx) {
        paintLayer(ctx, page, sent, scale);
        return;
      }
      if (sent) {
        copyCtx.save();
        copyCtx.globalAlpha = SENT_ALPHA;
        drawPage(copyCtx, sent, scale);
        copyCtx.restore();
      }
      if (page && count) drawPage(copyCtx, page, scale, 0, count);
      held = { sent, source: marks, count, w: canvas.width, h: canvas.height, canvas: copy };
      this.held = held;
    }
    ctx.drawImage(held.canvas, 0, 0);
    if (page && held.count < marks.length) drawPage(ctx, page, scale, held.count);
  }

  drop(): void {
    const held = this.held;
    if (held) {
      held.canvas.width = 0;
      held.canvas.height = 0;
    }
    this.held = null;
  }
}

/** How many marks `a` and `b` share, object for object, from the first. */
function commonPrefix(a: readonly Mark[], b: readonly Mark[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Whether `marks` still begin with the first `count` of `source`. */
function sharesPrefix(source: readonly Mark[], count: number, marks: readonly Mark[]): boolean {
  if (marks.length < count) return false;
  for (let i = 0; i < count; i++) if (source[i] !== marks[i]) return false;
  return true;
}

/** The newest piece of a stroke in progress, `scale` canvas pixels per page
 * unit: the curve from the midpoint before the last sample, through it, to
 * the midpoint after it — the curves `drawPage` draws the finished stroke
 * with, so nothing jumps when the pen lifts. The first sample is a dot. */
export function paintStrokePiece(ctx: Paint, scale: number, mark: InkMark): void {
  const points = mark.points;
  if (!points.length) return;
  const at = points.length - 1;
  const mid = (a: readonly number[], b: readonly number[]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.save();
  ctx.scale(scale, scale);
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
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode_failed"))), "image/png");
  });
}

/** The page's layer alone — transparent, `LAYER_WIDTH` wide at the page's
 * aspect — as the PNG the agent reads beside the marked copy. */
export function layerPng(page: PageLayer, width = LAYER_WIDTH): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(width * page.size[1] / page.size[0]));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no_canvas"));
  drawPage(ctx, page, width / page.size[0]);
  return toPng(canvas);
}

/** A PDF page's picture with its marks drawn on, `width` wide — what Submit
 * sends for a page the viewer could draw, so the agent sees each mark on the
 * words it is about in one picture. `picture` is the page drawn at any
 * width; it is stretched to this one. */
export function pagePng(picture: CanvasImageSource, page: PageLayer, width = LAYER_WIDTH): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(width * page.size[1] / page.size[0]));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no_canvas"));
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
  drawPage(ctx, page, width / page.size[0]);
  return toPng(canvas).finally(() => { canvas.width = 0; canvas.height = 0; });
}

/** A picture with its marks drawn on, at the picture's own size (bounded) —
 * what a picture source sends in place of a marked PDF. The browser decoded
 * the picture already; the desktop never does. */
export function composedPng(picture: CanvasImageSource, page: PageLayer): Promise<Blob> {
  const fit = Math.min(1, MAX_COMPOSED / Math.max(page.size[0], page.size[1]));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(page.size[0] * fit));
  canvas.height = Math.max(1, Math.round(page.size[1] * fit));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no_canvas"));
  ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
  drawPage(ctx, page, fit);
  return toPng(canvas);
}
