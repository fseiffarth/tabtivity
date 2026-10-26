/**
 * Tests for the image-viewer zoom-to-cursor math (#52): the pure `zoomOffset`
 * helper keeps the anchor point (the cursor) fixed on screen across a zoom.
 */
import { describe, it, expect } from "vitest";
import { zoomOffset } from "../../components/embed/fileViewer/ImageView";

/** Map an image point to a screen point under (scale, offset). */
const project = (scale: number, off: { x: number; y: number }, p: { x: number; y: number }) => ({
  x: off.x + p.x * scale,
  y: off.y + p.y * scale,
});
/** Inverse: screen point → image point. */
const unproject = (scale: number, off: { x: number; y: number }, s: { x: number; y: number }) => ({
  x: (s.x - off.x) / scale,
  y: (s.y - off.y) / scale,
});

describe("zoomOffset", () => {
  it("keeps the anchor's underlying image point fixed on screen", () => {
    const prev = 1;
    const next = 2;
    const offset = { x: 10, y: 20 };
    const anchor = { x: 100, y: 50 };
    // The image point currently under the anchor…
    const imgPt = unproject(prev, offset, anchor);
    const newOffset = zoomOffset(prev, next, offset, anchor);
    // …must still project to the same anchor screen point after zooming.
    const after = project(next, newOffset, imgPt);
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });

  it("zooming out keeps the anchor fixed too", () => {
    const prev = 4;
    const next = 1.5;
    const offset = { x: -30, y: 12 };
    const anchor = { x: 240, y: 160 };
    const imgPt = unproject(prev, offset, anchor);
    const newOffset = zoomOffset(prev, next, offset, anchor);
    const after = project(next, newOffset, imgPt);
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });

  it("is a no-op when the scale is unchanged", () => {
    const offset = { x: 7, y: 9 };
    expect(zoomOffset(2, 2, offset, { x: 50, y: 50 })).toEqual(offset);
  });
});
