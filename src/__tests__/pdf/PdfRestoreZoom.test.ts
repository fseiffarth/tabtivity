/**
 * Reopening a PDF (#viewerpos): which saved zoom is a zoom, and which is just the
 * fit of a pane that no longer exists.
 *
 * The viewer persists its scale on every change, so a saved `scale` is usually
 * the fit-to-width value the last pane's width produced — not something the
 * reader chose. Restoring one of those as an absolute zoom is how a PDF came back
 * badly rescaled after a restart, and, because it also cleared the fit baseline,
 * the resize re-fit that would have corrected it stayed off for the session.
 * `pdfFitted` is the evidence that separates the two cases; these tests lock the
 * rule and the scroll-target rescaling that follows a re-fit.
 */
import { describe, it, expect } from "vitest";

import {
  restoredPdfZoom,
  rescaleScrollTarget,
  shouldArmPdfRestoreDeadline,
} from "../../components/embed/pdf/zoomAnchor";

describe("restoredPdfZoom", () => {
  it("starts at the fit baseline when there is no saved state", () => {
    expect(restoredPdfZoom(undefined)).toEqual({ scale: 1.2, fitted: true });
  });

  it("treats a saved scale as the fit baseline when the flag says so", () => {
    // Seeded so the first paint is not a jump, but `fitted` means the load
    // effect re-fits it to THIS pane instead of freezing the old pane's width.
    expect(restoredPdfZoom({ scale: 0.87, pdfFitted: true })).toEqual({
      scale: 0.87,
      fitted: true,
    });
  });

  it("honours a scale the reader actually chose", () => {
    expect(restoredPdfZoom({ scale: 2.5, pdfFitted: false })).toEqual({
      scale: 2.5,
      fitted: false,
    });
  });

  it("re-fits state written before the flag existed", () => {
    // No flag is no evidence of a deliberate zoom: every pre-flag session wrote
    // its fit values here too, and those are the ones that came back wrong.
    expect(restoredPdfZoom({ scale: 1.63 }).fitted).toBe(true);
  });

  it("clamps a saved scale that is out of range", () => {
    const huge = restoredPdfZoom({ scale: 9999, pdfFitted: false }).scale;
    const tiny = restoredPdfZoom({ scale: 0.0001, pdfFitted: false }).scale;
    expect(huge).toBeLessThan(9999);
    expect(tiny).toBeGreaterThan(0.0001);
    expect(huge).toBeGreaterThan(tiny);
  });
});

describe("rescaleScrollTarget", () => {
  it("moves the target with the zoom", () => {
    expect(rescaleScrollTarget({ top: 1000, left: 40 }, 1, 2)).toEqual({
      top: 2000,
      left: 80,
    });
  });

  it("is identity at an unchanged zoom", () => {
    expect(rescaleScrollTarget({ top: 640, left: 0 }, 1.4, 1.4)).toEqual({
      top: 640,
      left: 0,
    });
  });

  it("leaves the target alone rather than dividing by a nonsense scale", () => {
    const target = { top: 300, left: 12 };
    expect(rescaleScrollTarget(target, 0, 1.5)).toEqual(target);
    expect(rescaleScrollTarget(target, 1.5, 0)).toEqual(target);
  });
});

describe("PDF restore deadline", () => {
  const target = { top: 9542, left: 0 };

  it("does not expire a saved position while its restored tab is hidden", () => {
    // TeX workspaces normally restore with the editor active and their compiled
    // PDF as a hidden sibling. display:none gives that PDF no scroll range; the
    // target must remain pending until the reader actually opens it.
    expect(shouldArmPdfRestoreDeadline(false, target)).toBe(false);
  });

  it("bounds retries once the PDF is visible", () => {
    expect(shouldArmPdfRestoreDeadline(true, target)).toBe(true);
    expect(shouldArmPdfRestoreDeadline(true, null)).toBe(false);
  });
});
