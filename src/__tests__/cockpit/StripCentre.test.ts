/** The view strip's middle group on the title bar's centre (`lib/cockpit/stripCentre`). */
import { describe, expect, it } from "vitest";
import { stripCentreWeights } from "../../lib/cockpit/stripCentre";

describe("stripCentreWeights", () => {
  it("puts the middle block on the bar's centre when the title side is wider than the controls side", () => {
    // Bar 0..1000, centre 500; block 200 wide → its left edge belongs at 400.
    const [a, b] = stripCentreWeights({ barLeft: 0, barRight: 1000, freeLeft: 300, freeRight: 800, blockWidth: 200 });
    expect(a).toBe(100);
    expect(b).toBe(200);
    expect(300 + a + 200 / 2).toBe(500);
  });

  it("is measured against the bar, wherever the frame sits on screen", () => {
    const [a] = stripCentreWeights({ barLeft: 200, barRight: 1200, freeLeft: 500, freeRight: 1000, blockWidth: 200 });
    expect(500 + a + 100).toBe(700);
  });

  it("gives a side with too little room nothing, so the block moves over instead of overlapping", () => {
    expect(stripCentreWeights({ barLeft: 0, barRight: 1000, freeLeft: 450, freeRight: 900, blockWidth: 200 })).toEqual([0, 250]);
    expect(stripCentreWeights({ barLeft: 0, barRight: 1000, freeLeft: 100, freeRight: 520, blockWidth: 200 })).toEqual([220, 0]);
  });

  it("falls back to equal spacers when there is no room or nothing measured", () => {
    expect(stripCentreWeights({ barLeft: 0, barRight: 1000, freeLeft: 300, freeRight: 500, blockWidth: 200 })).toEqual([1, 1]);
    expect(stripCentreWeights({ barLeft: 0, barRight: 0, freeLeft: 0, freeRight: 0, blockWidth: 0 })).toEqual([1, 1]);
  });
});
