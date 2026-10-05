import { describe, expect, it } from "vitest";
import { HEX_ASPECT, HUB_R, MAX_ASPECT, orbitLayout } from "../../lib/shortcuts/steeringOrbit";

const sizes = [
  { w: 120, h: 90 },
  { w: 100, h: 40 },
  { w: 140, h: 110 },
  { w: 90, h: 20 },
  { w: 110, h: 60 },
  { w: 80, h: 20 },
  { w: 100, h: 40 },
];

describe("steering orbit layout", () => {
  it("gives every group a hexagon that holds its key list", () => {
    const { hexes } = orbitLayout(sizes, 1920, 1080);
    hexes.forEach((c, i) => {
      const a = sizes[i].w / 2;
      const b = sizes[i].h / 2;
      // Pointy-topped: clear of the flat sides and of the slanted edges.
      expect(a).toBeLessThanOrEqual(c.w / 2);
      expect(a / c.w + (2 * b) / c.h).toBeLessThanOrEqual(1);
      expect(c.w / c.h).toBeGreaterThanOrEqual(HEX_ASPECT - 0.01);
      expect(c.w / c.h).toBeLessThanOrEqual(MAX_ASPECT + 0.01);
    });
  });

  it("stands the hexagons side by side, left to right, clear of the hub", () => {
    const { hexes } = orbitLayout(sizes, 1920, 1080);
    for (let i = 1; i < hexes.length; i++) {
      expect(hexes[i].x - hexes[i].w / 2).toBeGreaterThan(hexes[i - 1].x + hexes[i - 1].w / 2);
    }
    for (const c of hexes) {
      // Over the hub, a hexagon starts above its top point.
      if (Math.abs(c.x) < c.w / 2 + HUB_R) expect(c.y - c.h / 2).toBeGreaterThan(HUB_R);
    }
  });

  it("keeps the legend low and inside the window", () => {
    for (const [vw, vh] of [
      [1920, 1080],
      [1366, 768],
      [800, 600],
    ]) {
      const { bottom, scale, hexes } = orbitLayout(sizes, vw, vh);
      for (const c of hexes) {
        expect(bottom + scale * (c.y - c.h / 2)).toBeGreaterThanOrEqual(0);
        expect(scale * (Math.abs(c.x) + c.w / 2)).toBeLessThanOrEqual(vw / 2);
        // The upper half of the window, where the tab bars are, stays clear.
        expect(bottom + scale * (c.y + c.h / 2)).toBeLessThanOrEqual(vh / 2);
      }
    }
  });

  it("puts a lone hexagon straight above the hub", () => {
    const [c] = orbitLayout([{ w: 80, h: 20 }], 1920, 1080).hexes;
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeGreaterThan(0);
  });
});
