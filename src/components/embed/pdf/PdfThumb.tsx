/** The PDF viewer's page rail thumbnail. */
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePaneVisible } from "../../../lib/files/fileAccess";
import type { RedactRect } from "../../../lib/viewers/pageModel";
import { ANNOT_MODE } from "./PdfPageCanvas";

/** Height in CSS px of a page rail thumbnail. The width follows the page's aspect. */
const RAIL_THUMB_H = 96;

/**
 * One page rail thumbnail.
 *
 * Rendered LAZILY: a rail over a 500-page document would otherwise rasterise 500
 * pages the moment it opens. An IntersectionObserver paints each thumbnail only once
 * it is near the visible part of the rail, and the card reserves its box beforehand
 * so the rail's scroll height is right from the start.
 */
export function PdfThumb({
  doc,
  page,
  rot,
  marks,
}: {
  doc?: PDFDocumentProxy;
  page: number;
  rot: number;
  /** Pending blackouts on this sheet (#pdf-redact) — painted onto the thumbnail so
   *  the rail shows the same page the reader does. */
  marks?: readonly RedactRect[];
}) {
  const visible = usePaneVisible();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true); // no observer (tests/jsdom): just render
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        setNear(entries.some((e) => e.isIntersecting));
      },
      { root: null, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !near || !doc) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      let p;
      try {
        p = await doc.getPage(page);
      } catch {
        // A page tree the compiler has not finished writing ("Page dictionary kid
        // reference points to wrong type of object"): the next mtime poll brings
        // the finished file, and an unpainted thumbnail is the right face for now.
        return;
      }
      if (cancelled) return;
      const rotation = (((p.rotate + rot) % 360) + 360) % 360;
      const base = p.getViewport({ scale: 1, rotation });
      const viewport = p.getViewport({
        scale: RAIL_THUMB_H / (base.height || 1),
        rotation,
      });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      // `ANNOT_MODE`, like every other render in this viewer. Without it pdf.js
      // defaults to `ENABLE`, which ignores the `{noView: true}` suppression the
      // storage carries for a highlight the viewer has taken over — so the rail
      // painted the file's own copy UNDER ours and showed a marked sentence at
      // double strength beside a page showing it once.
      task = p.render({ canvas, canvasContext: ctx, viewport, annotationMode: ANNOT_MODE });
      try {
        await task.promise;
      } catch {
        /* superseded by a newer render — ignore */
      }
      // Hand the page back on EVERY path, not just the painted one. A superseded
      // render — a fast rail scroll, a recompile swapping the document, `marks`
      // changing, the rail closing — rejects above, and the old `painted &&`
      // guard then skipped the cleanup and left that page holding every image it
      // had decoded. That is the same ~660 MB / 4.7 GB leak the comment below
      // describes, on the one branch it did not cover.
      {
        // Hand the page's parse back now that the thumbnail has its pixels. A
        // render decodes every image on the page at full size and caches the
        // bitmaps on the page object until something asks for them back — and
        // for the rail nothing ever did, so a thumbnailed deck kept every page's
        // decoded images alive for the document's whole life: measured at
        // ~660 MB for a 57-page talk with 97 megapixel-plus figures, re-paid on
        // every recompile (a fresh document, the rail repainting each page).
        // That is what a popout showing such a deck was at 4.7 GB of (2026-09-01).
        // A page the main view is rendering right now is left alone by pdf.js
        // (the cleanup is refused and retried once that render completes) — it
        // then re-decodes on its next repaint, a one-time cost, since the rail
        // paints each thumbnail once.
        p.cleanup();
      }
      if (cancelled || !marks?.length) return;
      ctx.fillStyle = "#000000";
      for (const m of marks) {
        ctx.fillRect(
          m.x * viewport.scale,
          m.y * viewport.scale,
          m.w * viewport.scale,
          m.h * viewport.scale,
        );
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, page, rot, marks, visible]);

  // pdf.js has ALREADY painted this canvas at the sheet's rotation, so the card must
  // not turn it again in CSS — that is why the strip's rotate transform is scoped to
  // `img` (which the print strip needs, its thumbnails being flat page images).
  return <canvas ref={canvasRef} className="page-strip-canvas" />;
}
