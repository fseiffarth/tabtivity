/**
 * The most pixels one PDF page canvas may hold — pdf.js's own viewer default
 * (`maxCanvasPixels`, 2^25 ≈ 33.5 M px, 128 MB of backing store).
 *
 * A page canvas is rasterised at zoom × devicePixelRatio, and the zoom goes to
 * 800 %: an A4 page there on a 2× screen is 9520 × 13472 px — 512 MB for one
 * canvas, twice that while the off-screen render is swapped in, for each of the
 * pages near the viewport. A poster-sized page gets there at 100 %. Past the cap
 * the page is painted at the largest resolution that fits and stretched to its
 * CSS size, exactly as pdf.js does it: a little softer at extreme zoom, instead
 * of gigabytes of renderer memory (or a canvas the engine refuses to allocate,
 * which paints nothing at all).
 */
export const PDF_MAX_CANVAS_PIXELS = 2 ** 25;

/**
 * The device-pixel ratio to rasterise a page at: the screen's own `dpr`, lowered
 * just enough that a page of `cssWidth` × `cssHeight` CSS px stays within
 * {@link PDF_MAX_CANVAS_PIXELS}. Never raised above `dpr`.
 */
export function pdfRasterRatio(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxPixels: number = PDF_MAX_CANVAS_PIXELS,
): number {
  const area = cssWidth * cssHeight * dpr * dpr;
  if (!(area > maxPixels)) return dpr;
  return dpr * Math.sqrt(maxPixels / area);
}
