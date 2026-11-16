/**
 * A PDF page's positioned text runs — the one extraction every overlay in this
 * viewer measures itself against.
 *
 * It lives in its own module because three unrelated features need the *same*
 * boxes and must not each grow their own: the SyncTeX word refinement, the
 * Ctrl+F highlight, and the link layer's "is there anything under this
 * annotation?" test (`links.ts`). Two extractions that disagree about where a
 * word sits would put a search hit and a link box on different halves of the
 * same glyph.
 */
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { TextItemBox } from "../../../lib/viewers/tex/tex";

/** Each document's page reads, by page and turn: a document object never
 * changes its bytes (a reload makes a new one), so the markup tools and the
 * question pins share one read of a page instead of one each. The arrays are
 * shared: callers read them. */
const reads = new WeakMap<PDFDocumentProxy, Map<string, Promise<TextItemBox[]>>>();

/**
 * Extract a PDF page's positioned text runs as {@link TextItemBox}es in big
 * points (scale-1 viewport, top-left origin). Each box hugs the glyph band
 * (ascender→descender, ≈0.8 em up / 0.2 em down of the baseline) so an overlay
 * sits on the text rather than riding high over it. Shared by SyncTeX word
 * refinement, Ctrl+F search and the link layer so all three box the text
 * identically.
 *
 * The read is made once per document, page and turn (`reads`); the result is
 * shared, never changed by a caller.
 *
 * `rot` is the turn the viewer has applied to this sheet. The boxes are measured in
 * the SAME rotated space the canvas is painted in, so a search hit still lands on its
 * word after the page has been turned.
 */
export function pageTextItemBoxes(
  doc: PDFDocumentProxy,
  pageNumber: number,
  rot = 0,
): Promise<TextItemBox[]> {
  let entries = reads.get(doc);
  if (!entries) {
    entries = new Map();
    reads.set(doc, entries);
  }
  const key = `${pageNumber}:${rot}`;
  let work = entries.get(key);
  if (!work) {
    work = readBoxes(doc, pageNumber, rot);
    entries.set(key, work);
    const mine = work;
    // A failed read is asked again next time.
    mine.catch(() => {
      if (entries.get(key) === mine) entries.delete(key);
    });
  }
  return work;
}

async function readBoxes(doc: PDFDocumentProxy, pageNumber: number, rot: number): Promise<TextItemBox[]> {
  const page = await doc.getPage(pageNumber);
  return boxesIn(
    page,
    page.getViewport({ scale: 1, rotation: (((page.rotate + rot) % 360) + 360) % 360 }),
  );
}

/**
 * The same runs in the page's **own, unturned** space — the one place they are
 * unconditionally true.
 *
 * A run's extent along the baseline comes from pdf.js's `item.width`, which is a
 * *horizontal* advance measured before any rotation is applied. That is why the
 * boxes above are usable for a search highlight (which only has to land near the
 * word) but not for a geometric test on a turned sheet, where a run advancing
 * downwards would still be boxed as though it ran across. A question about the
 * page itself — is there text under this annotation? — has no business being
 * asked in the viewer's rotated space anyway, so the link layer asks it here.
 */
export async function pageTextItemBoxesUnturned(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<TextItemBox[]> {
  const page = await doc.getPage(pageNumber);
  return boxesIn(page, page.getViewport({ scale: 1, rotation: 0 }));
}

async function boxesIn(page: PDFPageProxy, viewport: PageViewport): Promise<TextItemBox[]> {
  const content = await page.getTextContent();
  const items: TextItemBox[] = [];
  for (const it of content.items) {
    // Skip marked-content markers (no `str`/`transform`).
    if (!("str" in it) || typeof it.str !== "string") continue;
    if (!it.str) {
      // An empty run is pdf.js's bare end-of-line marker. It has no geometry to keep,
      // but the fact that a line ended there is exactly what the search needs to join
      // a word split across two lines — so it is folded into the run before it rather
      // than dropped with the rest of the empty runs.
      if (it.hasEOL && items.length > 0) items[items.length - 1].eol = true;
      continue;
    }
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    const em = Math.hypot(tx[2], tx[3]); // scaled font size (em) in big points
    const ascent = em * 0.8;
    const descent = em * 0.2;
    items.push({
      str: it.str,
      x: tx[4],
      y: tx[5] - ascent,
      w: it.width,
      h: ascent + descent,
      ...(it.hasEOL ? { eol: true } : {}),
    });
  }
  return items;
}
