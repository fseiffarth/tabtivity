/**
 * The TeX editor's **hover preview** (#tex-hover-preview), frontend half: rest
 * the pointer on a formula and see it typeset, without compiling the paper.
 *
 * The backend (`commands/tex.rs`'s `tex_preview_snippet`) turns a preamble plus a
 * fragment into a one-page cropped PDF; this module is everything around that
 * call, and the three things here are all about *not* running the engine:
 *
 *  - **A cache keyed by what was compiled**, not by where it sits. The key is the
 *    preamble + the snippet text, so scrolling back to a formula, or hovering the
 *    same `$\alpha$` in four paragraphs, is free — and an edit anywhere else in
 *    the document does not invalidate a single entry, which is what makes the
 *    feature usable while writing rather than only while reading.
 *  - **One compile at a time, and the newest wins.** A pointer crossing a page of
 *    equations must not queue twelve latexmk-sized jobs; a hover that has been
 *    superseded is dropped before it starts.
 *  - **Failures are cached too.** A snippet with a typo in it would otherwise be
 *    recompiled every time the pointer passed over it, which is exactly when the
 *    author is moving around fixing it.
 *
 * pdf.js is loaded with a dynamic import so a TeX tab does not pull the whole
 * renderer into its chunk (see the code-split note in `App.tsx`); a document with
 * a PDF tab open has it already.
 */

import { invoke } from "@tauri-apps/api/core";

/** What the backend returns for one preview attempt. Mirrors `TexPreviewResult`. */
interface TexSnippetResponse {
  success: boolean;
  log: string;
  pdf_b64: string | null;
  fallback: boolean;
}

/** A rendered (or failed) preview, as the hover card consumes it. */
export interface TexPreview {
  /** PNG data URL of the cropped first page, when it typeset. */
  url?: string;
  /** Pixel size of that PNG, so the card can size itself to the formula. */
  width?: number;
  height?: number;
  /** Set when nothing was produced: one line, already trimmed for a card. */
  error?: string;
  /** True when the author's own preamble could not be used (see the backend's
   *  fallback pass) — the card says so, because a macro-heavy formula rendered
   *  without its macros is a different formula. */
  fallback?: boolean;
}

/** How many rendered previews to keep. Each is a small PNG blob URL; forty
 *  covers the equations of a chapter without the cache becoming the reason a
 *  long session grows. */
const CACHE_MAX = 40;

/** How wide a preview may get, in CSS px, before the card scales it down. Also
 *  the raster scale's ceiling: a formula is typeset at 4× its point size so it
 *  stays crisp, but a `tikzpicture` the width of a page must not become a 6000px
 *  canvas nobody sees at full size. */
const RASTER_SCALE = 4;
const RASTER_MAX_PX = 2400;

/** The cache key for a preview: what was actually handed to the engine. Two
 *  documents with the same preamble share entries; the same formula under a
 *  changed preamble does not. */
export function texPreviewKey(preamble: string, body: string): string {
  return `${hash(preamble)}:${hash(body)}:${body.length}`;
}

/** FNV-1a, 32 bit, as hex. Not a security hash — a cache key, where the cost of
 *  a collision is one formula previewed as another and the cost of comparing
 *  whole preambles on every pointer move is real. Combined with the body length
 *  in the key above, which no cheap hash can be made to collide with by accident. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Insertion-ordered, so the oldest entry is the first key `Map` yields. */
const cache = new Map<string, TexPreview>();
/** Compiles already in flight, so two hovers of one formula share a run. */
const inFlight = new Map<string, Promise<TexPreview | null>>();
/** The compile queue's tail — one engine run at a time, see the header. Each
 *  run chains behind the previous one, so a queued hover starts the moment the
 *  slot frees rather than on the next tick of a poll. Never rejects: a run's
 *  own failure is its caller's business, not the next hover's. */
let queueTail: Promise<void> = Promise.resolve();

/** Drop the least-recently-inserted entries past {@link CACHE_MAX}, revoking the
 *  blob URLs they hold so the renderer does not keep the PNGs alive forever. */
function evict(): void {
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    const stale = cache.get(oldest.value);
    if (stale?.url) URL.revokeObjectURL(stale.url);
    cache.delete(oldest.value);
  }
}

/** The cached preview for this exact preamble+snippet, if there is one. Lets a
 *  caller paint instantly on re-hover instead of showing a spinner it is about
 *  to replace. */
export function cachedTexPreview(preamble: string, body: string): TexPreview | undefined {
  return cache.get(texPreviewKey(preamble, body));
}

/**
 * Typeset `body` with `preamble`, cached.
 *
 * `dir` is the document's own folder — the backend runs the engine there so the
 * preamble's relative `\usepackage`/`\input` resolve — and `stillWanted` is asked
 * again right before the engine would run, so a pointer that has moved on cancels
 * the compile instead of paying for it. A cancelled call resolves to `undefined`;
 * it is not an error, and nothing is cached for it.
 */
export async function renderTexPreview(
  dir: string,
  preamble: string,
  body: string,
  engine: string | null,
  stillWanted: () => boolean,
): Promise<TexPreview | undefined> {
  const key = texPreviewKey(preamble, body);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inFlight.get(key);
  if (pending) return (await pending) ?? undefined;

  // One engine run at a time, and a hover that has been superseded while queued
  // never starts one: `null` means exactly that — cancelled, nothing compiled,
  // nothing to remember.
  const turn = queueTail;
  let release!: () => void;
  queueTail = new Promise((r) => (release = r));
  const run = (async (): Promise<TexPreview | null> => {
    await turn;
    try {
      if (!stillWanted()) return null;
      const res = await invoke<TexSnippetResponse>("tex_preview_snippet", {
        dir,
        preamble,
        body,
        engine,
      });
      if (!res.success || !res.pdf_b64) return { error: firstTexErrorLine(res.log) };
      const raster = await rasterize(base64Bytes(res.pdf_b64));
      if (!raster) return { error: "render failed" };
      return { ...raster, fallback: res.fallback };
    } catch (e) {
      return { error: String(e) };
    } finally {
      release();
    }
  })();

  inFlight.set(key, run);
  try {
    const result = await run;
    if (!result) return undefined;
    // Cache whatever came back — including a failure. A snippet with a typo is
    // hovered again and again while it is being fixed, and recompiling it each
    // time is the one case where the feature would cost most and say least.
    cache.set(key, result);
    evict();
    // The pointer may have moved on while this was in the engine. The work is
    // kept; the card it was for is not reopened.
    return stillWanted() ? result : undefined;
  } finally {
    inFlight.delete(key);
  }
}

/** The line of a TeX log a card should show: the first `!` error, else the last
 *  non-empty line. A build log's tail is where TeX's own summary sits, but an
 *  error line names the actual problem. */
export function firstTexErrorLine(log: string): string {
  const lines = log.split("\n").map((l) => l.trimEnd());
  const bang = lines.find((l) => l.startsWith("!"));
  if (bang) return bang.replace(/^!\s*/, "").slice(0, 200);
  const last = [...lines].reverse().find((l) => l.trim() !== "");
  return (last ?? "compile failed").slice(0, 200);
}

/** Decode a base64 payload into bytes. */
function base64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Render page 1 of a preview PDF to a PNG blob URL. Its own tiny renderer
 *  rather than the deck's `renderPdfPageToPng`: this one loads pdf.js lazily
 *  (a TeX tab must not carry the renderer just in case) and clamps the raster,
 *  which a figure destined for a slide deliberately does not. */
async function rasterize(
  bytes: Uint8Array,
): Promise<{ url: string; width: number; height: number } | null> {
  // The loader module brings pdf.js and its worker script in with it, so the
  // import is deferred to the first preview.
  const { loadPdf } = await import("../pdfLoad");
  const doc = await loadPdf(bytes);
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(RASTER_SCALE, RASTER_MAX_PX / Math.max(1, base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // `preview`'s tightpage crop leaves a transparent page; the card's own plate
    // supplies the paper, so the ink is composited over whatever the theme is.
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    return { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
  } finally {
    await doc.loadingTask.destroy();
  }
}
