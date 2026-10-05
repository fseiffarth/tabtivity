import { describe, expect, it } from "vitest";
import { PDF_MAX_CANVAS_PIXELS, pdfRasterRatio } from "../../components/embed/pdf/raster";

// A4's box at 100 %: pdf.js's getViewport maps one point to one CSS px at scale 1.
const A4 = { w: 595, h: 842 };

describe("pdfRasterRatio", () => {
  it("keeps the screen's own ratio for an ordinary page at ordinary zoom", () => {
    expect(pdfRasterRatio(A4.w, A4.h, 1)).toBe(1);
    expect(pdfRasterRatio(A4.w * 2, A4.h * 2, 2)).toBe(2);
    // 800 % on a 1× screen still fits: 4760 × 6736 ≈ 32 M px.
    expect(pdfRasterRatio(A4.w * 8, A4.h * 8, 1)).toBe(1);
  });

  it("lowers the ratio just enough to stay within the pixel cap", () => {
    // 800 % on a 2× screen would be ~128 M px.
    const w = A4.w * 8;
    const h = A4.h * 8;
    const r = pdfRasterRatio(w, h, 2);
    expect(r).toBeLessThan(2);
    const pixels = Math.floor(w * r) * Math.floor(h * r);
    expect(pixels).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
    expect(pixels).toBeGreaterThan(PDF_MAX_CANVAS_PIXELS * 0.99);
  });

  it("caps a poster-sized page at 100 %", () => {
    // A0: 2384 × 3370 pt, at 200 % on a 2× screen.
    const r = pdfRasterRatio(2384 * 2, 3370 * 2, 2);
    expect(Math.floor(2384 * 2 * r) * Math.floor(3370 * 2 * r)).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
  });

  it("never raises the ratio above the screen's", () => {
    expect(pdfRasterRatio(10, 10, 1.5)).toBe(1.5);
    expect(pdfRasterRatio(0, 0, 2)).toBe(2);
  });
});
