/**
 * What a desktop Mark up Submit sends for one marked page (`usePdfMarkup`):
 * the page drawn with its marks on it, and the page's words each mark is on —
 * the phone's own routines (`mobile-web/src/markup/rasterize.ts`,
 * `anchors.ts`) fed from this viewer's document instead of the sealed frame.
 * A page that cannot be drawn goes as its marks alone; one whose text cannot
 * be read goes without words. The words under each mark (`words`) are kept
 * in the round log for a ✓ group's before/after caption.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import { anchorsFor, wordsIn, type Anchor } from "../../../../mobile-web/src/markup/anchors";
import { markBox, type PageLayer } from "../../../../mobile-web/src/markup/layer";
import { LAYER_WIDTH, layerPng, pagePng } from "../../../../mobile-web/src/markup/rasterize";
import { pageTextItemBoxes } from "./pageText";

/** `words`: by mark, the page's words under it (`null` where none); absent
 *  when the page's text could not be read. */
export type MarkupPagePicture = { png: Blob; composed: boolean; anchors: Anchor[]; words?: (string | null)[] };

/** Page `n` of `doc` drawn `LAYER_WIDTH` wide after its `/Rotate` — the units
 * the marks are in — or `null`. */
async function drawPage(doc: PDFDocumentProxy, n: number): Promise<HTMLCanvasElement | null> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: LAYER_WIDTH / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = LAYER_WIDTH;
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

export async function markupPagePicture(doc: PDFDocumentProxy | null, n: number, layer: PageLayer): Promise<MarkupPagePicture> {
  let png: Blob | null = null;
  let anchors: Anchor[] = [];
  let words: (string | null)[] | undefined;
  if (doc) {
    try {
      const canvas = await drawPage(doc, n);
      if (canvas) {
        png = await pagePng(canvas, layer);
        canvas.width = 0;
        canvas.height = 0;
      }
    } catch {
      png = null;
    }
    try {
      const runs = await pageTextItemBoxes(doc, n);
      anchors = anchorsFor(layer, runs);
      words = layer.marks.map((mark) => wordsIn(runs, markBox(mark)) || null);
    } catch {
      anchors = [];
      words = undefined;
    }
  }
  return { png: png ?? (await layerPng(layer)), composed: png !== null, anchors, ...(words ? { words } : {}) };
}
