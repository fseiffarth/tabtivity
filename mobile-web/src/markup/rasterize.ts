/**
 * Draws a page's marks onto a 2D canvas context — the one drawing routine
 * behind the layer on screen, the page pictures Submit sends (or the
 * transparent layer where a page could not be drawn), and a picture with its
 * marks drawn on. Strokes are quadratic curves through the
 * midpoints of their samples, one piece per sample at that sample's width:
 * the same curves the desktop writes into the marked PDF (`markup_pdf.rs`).
 */

import { inkWidth, LEADING, type Mark, type MarkColor, type PageLayer } from "./layer";

export const INK: Record<MarkColor, string> = {
  red: "#db2626",
  blue: "#2663eb",
  black: "#121212",
  yellow: "#ffd91a",
};
/** How strongly a highlighter box covers the page. */
export const HIGHLIGHT_ALPHA = 0.4;
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

export function drawMark(ctx: Paint, mark: Mark): void {
  ctx.save();
  if (mark.kind === "ink") {
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
}

/** Draws every mark of `page`, `scale` canvas pixels per page unit. */
export function drawPage(ctx: Paint, page: PageLayer, scale: number): void {
  ctx.save();
  ctx.scale(scale, scale);
  for (const mark of page.marks) drawMark(ctx, mark);
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
