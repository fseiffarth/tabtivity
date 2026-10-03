/**
 * The messages between the markup view and the sealed pdf.js frame
 * (`mobile-web/pdf-frame.html`, `docs/mobile_pdf_markup_plan.md` §2.2).
 *
 * The frame parses the PDF — attacker-controlled bytes — in an opaque origin
 * with no cookie, no storage and no network, so whatever it says is treated
 * as hostile too: a message counts only when it comes from that frame's
 * window, has one of these shapes, and every number is in range. Nothing
 * from the frame is ever inserted as HTML; a page arrives as an
 * `ImageBitmap` and is drawn onto a canvas.
 */

/** PWA → frame. `bytes` is transferred, not copied. */
export type ToFrame =
  | { type: "open"; bytes: ArrayBuffer }
  /** Render page `n` (1-based) `width` device pixels wide. */
  | { type: "render"; n: number; width: number }
  /** Where `quote` sits on `page` — an agent's markup question's pin
   * (`findText.ts`). `id` pairs the answer with the ask. */
  | { type: "findText"; id: number; page: number; quote: string };

/** Frame → PWA. */
export type FromFrame =
  /** The frame's script runs and waits for the bytes. */
  | { type: "ready" }
  /** The document opened: each page's displayed size, in PDF points. */
  | { type: "meta"; pages: { w: number; h: number }[] }
  | { type: "page"; n: number; width: number; bitmap: ImageBitmap }
  /** The boxes of a `findText` quote, page points from the top-left; empty
   * when it is not on the page. */
  | { type: "found"; id: number; page: number; rects: { x: number; y: number; w: number; h: number }[] }
  | { type: "failed"; code: FrameFailure; n?: number };

export const FRAME_FAILURES = ["unreadable", "encrypted", "render", "unsupported"] as const;
export type FrameFailure = typeof FRAME_FAILURES[number];

/** Most pages a document may announce, and the largest page side, in points. */
export const MAX_FRAME_PAGES = 10_000;
export const MAX_PAGE_SIDE = 20_000;
/** The widest page picture the view asks for (Safari's canvas memory). */
export const MAX_RENDER_WIDTH = 2_048;
/** A `findText` quote's longest length (an ask's quote is ≤ 200 characters),
 * the most boxes one answer may carry, and the largest request id. */
export const MAX_FIND_QUOTE = 400;
export const MAX_FOUND_RECTS = 32;
export const MAX_FIND_ID = 1_000_000_000;

const isCount = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
const isSide = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= MAX_PAGE_SIDE;
const isFindId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_FIND_ID;
/** A coordinate on a page, with room for a run that starts just off it. */
const isCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= -MAX_PAGE_SIDE && value <= 2 * MAX_PAGE_SIDE;
const isExtent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PAGE_SIDE;

/**
 * The frame's message, if `event` is one: from `frame` itself (an opaque
 * origin reads as `"null"`), of a known shape, numbers in range. `pages` is
 * the page count already announced, which a page picture must fall within.
 */
export function acceptFrameMessage(event: MessageEvent, frame: Window | null | undefined, pages = MAX_FRAME_PAGES): FromFrame | null {
  if (!frame || event.source !== frame || event.origin !== "null") return null;
  const data: unknown = event.data;
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "meta": {
      const list = message.pages;
      if (!Array.isArray(list) || list.length < 1 || list.length > MAX_FRAME_PAGES) return null;
      const sizes: { w: number; h: number }[] = [];
      for (const entry of list as unknown[]) {
        if (!entry || typeof entry !== "object") return null;
        const { w, h } = entry as { w?: unknown; h?: unknown };
        if (!isSide(w) || !isSide(h)) return null;
        sizes.push({ w, h });
      }
      return { type: "meta", pages: sizes };
    }
    case "page": {
      const bitmap = message.bitmap;
      if (!isCount(message.n, pages) || !isCount(message.width, MAX_RENDER_WIDTH)) return null;
      if (typeof ImageBitmap === "undefined" || !(bitmap instanceof ImageBitmap)) return null;
      if (bitmap.width < 1 || bitmap.width > MAX_RENDER_WIDTH || bitmap.height < 1 || bitmap.height > MAX_RENDER_WIDTH * 4) return null;
      return { type: "page", n: message.n, width: message.width, bitmap };
    }
    case "found": {
      const list = message.rects;
      if (!isFindId(message.id) || !isCount(message.page, pages) || !Array.isArray(list) || list.length > MAX_FOUND_RECTS) return null;
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      for (const entry of list as unknown[]) {
        if (!entry || typeof entry !== "object") return null;
        const { x, y, w, h } = entry as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
        if (!isCoordinate(x) || !isCoordinate(y) || !isExtent(w) || !isExtent(h)) return null;
        rects.push({ x, y, w, h });
      }
      return { type: "found", id: message.id, page: message.page, rects };
    }
    case "failed": {
      if (!FRAME_FAILURES.includes(message.code as FrameFailure)) return null;
      const n = message.n;
      if (n !== undefined && !isCount(n, pages)) return null;
      return { type: "failed", code: message.code as FrameFailure, ...(n !== undefined ? { n } : {}) };
    }
    default:
      return null;
  }
}

/** What the frame accepts from the PWA — the frame side's own check. */
export function acceptToFrame(data: unknown): ToFrame | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.type === "open" && message.bytes instanceof ArrayBuffer) return { type: "open", bytes: message.bytes };
  if (message.type === "render" && isCount(message.n, MAX_FRAME_PAGES) && isCount(message.width, MAX_RENDER_WIDTH)) {
    return { type: "render", n: message.n, width: message.width };
  }
  if (message.type === "findText" && isFindId(message.id) && isCount(message.page, MAX_FRAME_PAGES)
    && typeof message.quote === "string" && message.quote.trim() && message.quote.length <= MAX_FIND_QUOTE) {
    return { type: "findText", id: message.id, page: message.page, quote: message.quote };
  }
  return null;
}
