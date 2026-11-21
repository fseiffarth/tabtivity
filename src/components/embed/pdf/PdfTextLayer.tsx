/**
 * Selectable text over a rendered page (#pdf-textselect).
 *
 * The reader paints pages to a canvas, and a canvas has no text in it: until this
 * layer existed the only way to get a sentence out of a PDF was to retype it, or to
 * copy the *region* as an image (the ✂ tool next door, which is a picture of the
 * words rather than the words). What sits here is pdf.js's own {@link TextLayer} —
 * one transparent, correctly-placed span per text run — so the browser's ordinary
 * selection lands on the glyphs the reader sees and Ctrl+C copies what the file
 * actually says.
 *
 * Three things are worth saying about it.
 *
 * **It is not a mode.** It was, briefly, and that was wrong: selecting words in a
 * document is what a pointer over text does everywhere else, and a reader who has to
 * find and arm a tool first will simply retype the sentence. What made it a mode is
 * that the layer takes the pointer over the whole sheet — so the answer is the one
 * pdf.js's own viewer uses: everything that needs its own click (the link boxes, the
 * search hits, the markers, the highlights, the blackout and region-copy surfaces) is
 * stacked ABOVE it by z-index, which leaves the plain drag — the one gesture nothing
 * else wants — to the text. The stack is in `themes.css`, and it is load-bearing: drop
 * a `z-index` from one of those layers and it silently stops being clickable.
 *
 * **Only near pages build one.** Same gate as the canvas render and the annotation
 * reads: `getTextContent` on a 300-page document is the whole file's text, and a
 * selection cannot start on a sheet that is nowhere near the viewport. That gate is
 * what makes always-on affordable at all — the cost is one text read per page the
 * reader actually scrolls to, which is what Ctrl+F already pays.
 *
 * **Selecting is pdf.js's viewer behaviour, not the bare layer's.** The spans alone
 * make a drag jump to the page's end at every gap between words — the whole of a
 * LaTeX page — so the `endOfContent` block and the selection tracking pdf.js keeps in
 * its viewer are ported in `textSelection.ts` and attached once the spans are in.
 *
 * **Zoom costs nothing.** pdf.js lays the spans out in the page's own units and
 * multiplies by `--total-scale-factor` in CSS, so a zoom is one custom property away and
 * the text content is never re-read. That is the same bargain the link boxes and the
 * search hits strike by storing big points and multiplying at render.
 */
import { useEffect, useRef } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { attachTextSelection, TEXT_LAYER_CLASS } from "./textSelection";

export function PdfTextLayer({
  doc,
  pageNumber,
  rot,
  scale,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** The turn the viewer has applied, added to the page's own `/Rotate` exactly as
   *  the canvas render adds it — or the spans land on an unturned page. */
  rot: number;
  scale: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let cancelled = false;
    let layer: { cancel: () => void } | null = null;
    let detach: (() => void) | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled || !ref.current) return;
        const viewport = page.getViewport({
          scale: 1,
          rotation: (((page.rotate + rot) % 360) + 360) % 360,
        });
        container.style.setProperty("--user-unit", String(page.userUnit ?? 1));
        const source = await page.getTextContent();
        if (cancelled || !ref.current) return;
        // Built at scale 1 with the zoom carried by `--scale-factor` (set below):
        // every position pdf.js writes is `calc(var(--scale-factor) * Npx)`, so the
        // layer follows the zoom without being rebuilt.
        const built = new pdfjs.TextLayer({
          textContentSource: source,
          container,
          viewport,
        });
        layer = built;
        await built.render();
        if (cancelled) return;
        // What makes a drag across the spans select like text rather than jump to
        // the page's end at every gap between words (`textSelection.ts`).
        detach = attachTextSelection(container);
      } catch {
        /* A page whose text cannot be read simply offers no selection — the same
           best-effort footing the link and remark reads stand on. */
      }
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
      detach?.();
      // pdf.js appends into the container and never clears it, so a re-render (a
      // turned page, a different document) would stack a second set of spans on the
      // first and every selection would come back doubled.
      container.replaceChildren();
    };
  }, [doc, pageNumber, rot]);

  return (
    <div
      ref={ref}
      className={TEXT_LAYER_CLASS}
      // Zoom changes in CSS while the page's text runs stay mounted.
      style={{ "--scale-factor": scale } as React.CSSProperties}
    />
  );
}
