import { describe, it, expect } from "vitest";
import {
  clampRootOverlayFrame,
  filledRootOverlayFrame,
  rootOverlayFrameDrag,
  MIN_ROOT_OVERLAY_HEIGHT,
  MIN_ROOT_OVERLAY_WIDTH,
} from "../../lib/window/floatingFrame";

/** The pure frame math every floating window (the root console, the header
 *  overlays) moves, resizes and fills through. */
describe("the floating frame math", () => {
  it("clamps a remembered frame into the window it actually opens in", () => {
    // Sized on a wide external display, opened on a laptop panel.
    expect(clampRootOverlayFrame({ x: 2400, y: 1300, width: 1600, height: 900 }, 1280, 800)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
    // A window smaller than the minimum still yields a usable console at 0,0.
    expect(clampRootOverlayFrame({ x: 10, y: 10, width: 300, height: 100 }, 320, 200)).toEqual({
      x: 0,
      y: 0,
      width: MIN_ROOT_OVERLAY_WIDTH,
      height: MIN_ROOT_OVERLAY_HEIGHT,
    });
    expect(filledRootOverlayFrame(1000, 600)).toEqual({ x: 16, y: 16, width: 968, height: 568 });
  });

  it("moves, resizes, and pins the far edge past the minimum", () => {
    const start = { x: 100, y: 100, width: 800, height: 500 };
    expect(rootOverlayFrameDrag(start, "move", 40, -30, 1920, 1080)).toEqual({
      x: 140,
      y: 70,
      width: 800,
      height: 500,
    });
    // A south-east corner grows both axes; a north-west one moves the origin.
    expect(rootOverlayFrameDrag(start, "se", 60, 40, 1920, 1080)).toEqual({
      x: 100,
      y: 100,
      width: 860,
      height: 540,
    });
    expect(rootOverlayFrameDrag(start, "nw", 50, 20, 1920, 1080)).toEqual({
      x: 150,
      y: 120,
      width: 750,
      height: 480,
    });
    // The left edge dragged far right stops at the minimum with the RIGHT edge
    // where it was — it must not start pushing the console across the screen.
    const pinned = rootOverlayFrameDrag(start, "w", 700, 0, 1920, 1080);
    expect(pinned.width).toBe(MIN_ROOT_OVERLAY_WIDTH);
    expect(pinned.x + pinned.width).toBe(start.x + start.width);
  });
});
