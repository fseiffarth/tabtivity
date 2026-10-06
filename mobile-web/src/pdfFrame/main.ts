/**
 * The sealed pdf.js frame (`mobile-web/pdf-frame.html`): PDF bytes in, page
 * pictures out, nothing else (`docs/mobile_pdf_markup_plan.md` §2.2).
 *
 * Loaded as `<iframe sandbox="allow-scripts">`, so this runs in an opaque
 * origin: no session cookie, no storage, no API, and the sidecar's policy for
 * this one page allows no network at all. The PWA never parses a PDF itself —
 * a hostile file can at worst wedge or crash this frame, which the markup
 * view then removes.
 *
 * Built as a classic script (IIFE): a module script from an opaque origin is
 * a CORS request the static route does not answer. pdf.js runs without a
 * Worker — an opaque origin cannot start one from the server — through its
 * main-thread fallback, `globalThis.pdfjsWorker`. The legacy build carries
 * the polyfills the newest language features pdf.js leans on need on an
 * older phone browser. Canvas only: no text layer, no annotation layer, no
 * links, no forms — PDF content never becomes DOM. The page's text is read
 * for two things only: where an agent's markup question quotes it
 * (`findText`), answered as boxes in page points, and the runs a Submit reads
 * the words under each mark from (`text`).
 */

import * as worker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { acceptToFrame, MAX_FRAME_PAGES, MAX_PAGE_CHARS, MAX_RENDER_WIDTH, MAX_RUN_CHARS, MAX_TEXT_RUNS, type FromFrame } from "../markup/frameProtocol";
import { findQuote, type TextRun } from "../markup/findText";

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
// pdf.js paints a page in animation-frame slices, and a browser starves the
// animation frames of a frame nobody sees; plain tasks keep it drawing.
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

/** The tallest page picture the PWA takes, and the most pixels one may have. */
const MAX_HEIGHT = 4 * MAX_RENDER_WIDTH;
const MAX_PIXELS = 16_000_000;

let task: PDFDocumentLoadingTask | null = null;
let doc: PDFDocumentProxy | null = null;
/** One thing at a time: a page renders on the UI thread the PWA shares. */
let queue: Promise<void> = Promise.resolve();

function post(message: FromFrame, transfer: Transferable[] = []): void {
  // The parent is the PWA; an opaque origin has no name to address it by.
  window.parent.postMessage(message, "*", transfer);
}

async function open(bytes: ArrayBuffer): Promise<void> {
  if (task) return;
  task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    enableXfa: false,
    stopAtErrors: false,
  });
  try {
    doc = await task.promise;
  } catch (error) {
    // A failed load still owns its loading task.
    void task.destroy().catch(() => {});
    post({ type: "failed", code: (error as { name?: string })?.name === "PasswordException" ? "encrypted" : "unreadable" });
    return;
  }
  const pages: { w: number; h: number }[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, MAX_FRAME_PAGES); n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      pages.push({ w: width, h: height });
      page.cleanup();
    }
  } catch {
    post({ type: "failed", code: "unreadable" });
    return;
  }
  post({ type: "meta", pages });
}

/** Page `n` drawn about `width` pixels wide, as a bitmap. */
async function draw(n: number, width: number): Promise<ImageBitmap> {
  const canvas = document.createElement("canvas");
  try {
    const page = await doc!.getPage(n);
    const base = page.getViewport({ scale: 1 });
    // As wide as asked, unless that makes a long page taller (or bigger)
    // than the PWA accepts — then narrower.
    const scale = Math.min(width / base.width, MAX_HEIGHT / base.height, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const bitmap = await createImageBitmap(canvas);
    page.cleanup();
    return bitmap;
  } finally {
    // Free the backing store now rather than at the next collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function render(n: number, width: number): Promise<void> {
  if (!doc || n > doc.numPages) return;
  try {
    const bitmap = await draw(n, width);
    post({ type: "page", n, width, bitmap }, [bitmap]);
  } catch {
    post({ type: "failed", code: "render", n });
  }
}

/** Submit's own picture of a page — never one of the view's. */
async function snapshot(id: number, n: number, width: number): Promise<void> {
  if (!doc || n > doc.numPages) { post({ type: "snapshot", id, n }); return; }
  try {
    const bitmap = await draw(n, width);
    post({ type: "snapshot", id, n, bitmap }, [bitmap]);
  } catch {
    post({ type: "snapshot", id, n });
  }
}

/** The page's text runs in its own viewport at scale 1 — the units the
 * `meta` sizes are in — as the desktop's `pageText.ts` boxes them. */
async function textRuns(n: number): Promise<TextRun[]> {
  const page = await doc!.getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item) || typeof item.str !== "string") continue;
    if (!item.str) {
      // pdf.js's bare end-of-line marker: the run before it ends a line.
      if (item.hasEOL && runs.length > 0) runs[runs.length - 1].eol = true;
      continue;
    }
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const em = Math.hypot(tx[2], tx[3]);
    runs.push({ str: item.str, x: tx[4], y: tx[5] - em * 0.8, w: item.width, h: em, ...(item.hasEOL ? { eol: true } : {}) });
  }
  page.cleanup();
  return runs;
}

/** A page's runs for Submit's words under each mark (`anchors.ts`). */
async function text(id: number, n: number): Promise<void> {
  let runs: TextRun[] = [];
  try {
    if (doc && n <= doc.numPages) runs = await textRuns(n);
  } catch {
    // A page whose text cannot be read sends its marks without words.
  }
  let chars = 0;
  const bounded = runs.slice(0, MAX_TEXT_RUNS).filter((run) => run.str.length <= MAX_RUN_CHARS && (chars += run.str.length) <= MAX_PAGE_CHARS);
  post({ type: "text", id, page: n, runs: bounded });
}

async function findText(id: number, n: number, quote: string): Promise<void> {
  if (!doc || n > doc.numPages) return;
  let rects: { x: number; y: number; w: number; h: number }[] = [];
  try {
    rects = findQuote(await textRuns(n), quote);
  } catch {
    // A page whose text cannot be read pins its question in the margin.
  }
  post({ type: "found", id, page: n, rects });
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = acceptToFrame(event.data);
  if (!message) return;
  queue = queue.then(() => (message.type === "open" ? open(message.bytes)
    : message.type === "render" ? render(message.n, message.width)
      : message.type === "snapshot" ? snapshot(message.id, message.n, message.width)
        : message.type === "text" ? text(message.id, message.page)
          : findText(message.id, message.page, message.quote)));
});

post({ type: "ready" });
