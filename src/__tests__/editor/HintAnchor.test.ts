import { describe, expect, it } from "vitest";
import { BUBBLE_W, placeBubble } from "../../lib/shortcuts/hintAnchor";

const VW = 1200;
const VH = 800;

describe("placeBubble", () => {
  it("sits below a header control", () => {
    const spot = placeBubble({ left: 400, top: 10, bottom: 40 }, "bottom", VW, VH);
    expect(spot).toEqual({ left: 400, top: 48, above: false });
  });

  it("flips above when there is no room below", () => {
    const spot = placeBubble({ left: 400, top: 760, bottom: 790 }, "bottom", VW, VH);
    expect(spot.above).toBe(true);
    expect(spot.top).toBe(752);
  });

  it("flips below when a top-placed target is at the window's top edge", () => {
    const spot = placeBubble({ left: 400, top: 5, bottom: 30 }, "top", VW, VH);
    expect(spot.above).toBe(false);
  });

  it("clamps horizontally inside the window", () => {
    expect(placeBubble({ left: 1190, top: 10, bottom: 40 }, "bottom", VW, VH).left).toBe(VW - BUBBLE_W - 8);
    expect(placeBubble({ left: -50, top: 10, bottom: 40 }, "bottom", VW, VH).left).toBe(8);
  });

  it("tucks the bubble inside a target that fills the window", () => {
    const spot = placeBubble({ left: 0, top: 0, bottom: VH }, "bottom", VW, VH);
    expect(spot.above).toBe(false);
    expect(spot.top).toBe(8);
  });
});
