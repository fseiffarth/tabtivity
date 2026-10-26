import { describe, expect, it } from "vitest";
import { pdfFitScale } from "../../components/embed/pdf/fitScale";

describe("pdfFitScale", () => {
  it("fits a landscape slide whole when its width fit is taller than the viewport", () => {
    // 16:9 slide, 1896 × 966 viewport: by width 4.18, by height ~3.79.
    const r = pdfFitScale(1896, 966, 453.5, 255.1, true);
    expect(r.fitsPage).toBe(true);
    expect(r.scale).toBeCloseTo(966 / 255.1, 5);
  });

  it("keeps the width fit when the landscape page already fits the height", () => {
    const r = pdfFitScale(800, 900, 400, 200, true);
    expect(r).toEqual({ scale: 2, fitsPage: false });
  });

  it("always fits a portrait page by width", () => {
    expect(pdfFitScale(800, 500, 595, 842, true)).toEqual({ scale: 800 / 595, fitsPage: false });
  });

  it("fits by width when whole-page is not asked for", () => {
    expect(pdfFitScale(1896, 966, 453.5, 255.1, false).fitsPage).toBe(false);
  });
});
