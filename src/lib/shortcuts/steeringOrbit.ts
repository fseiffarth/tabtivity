/**
 * Where the steering legend's key hexagons sit round its hub (`SteeringLegend`'s
 * `OrbitLegend`). Pure, so the geometry is testable without a layout engine.
 * Every hexagon is pointy-topped: the regular one's outline (`--steer-hex`)
 * scaled to its box, which is never narrower than the regular hexagon's and at
 * most MAX_ASPECT wide for its height.
 */

export interface Orbit {
  /** The hub centre's distance from the window's bottom edge. */
  bottom: number;
  scale: number;
  /** Per hexagon, in input order: its box, its centre relative to the hub
   *  centre (y up), the spoke's angle (radians, counter-clockwise from +x)
   *  and length. */
  hexes: { w: number; h: number; x: number; y: number; phi: number; r: number }[];
}

/** The hub hexagon's circumradius: its box is HUB_R·√3 wide, 2·HUB_R tall. */
export const HUB_R = 20;
/** A pointy-topped regular hexagon's width over its height. */
export const HEX_ASPECT = Math.sqrt(3) / 2;
/** The widest a key hexagon may be for its height. A regular hexagon round a
 *  short, wide key list is mostly empty above and below it; this much
 *  squashing saves about a quarter of the area and of the height on the
 *  busiest levels, and still reads as a hexagon next to regular ones. */
export const MAX_ASPECT = 1.25;
export const HUB_BOTTOM = 10;
const EDGE = 8;
const GAP = 6;
const MIN_H = 48;
const PAD = 4;
/** How far above the hub centre a hexagon over it must start: the hub's top
 *  point (HUB_R) with the level pill on it (to 30px) and a gap. */
const HUB_CLEAR = 36;
/** Half the width a hexagon must keep off to sink below HUB_CLEAR: the level
 *  pill's, for a long level name. */
const HUB_CLEAR_HALF = 60;

/**
 * The smallest hexagon box holding a w×h rectangle (plus padding) at its
 * centre. With half-sizes a, b and box W×H, the rectangle clears the flat
 * sides when a ≤ W/2 and the slanted edges when a/W + 2b/H ≤ 1; the box's
 * aspect stays between HEX_ASPECT and MAX_ASPECT. The regular hexagon always
 * fits, so the search stops at widths whose MAX_ASPECT height alone would
 * cover more.
 */
export function hexBox(w: number, h: number): { w: number; h: number } {
  const a = w / 2 + PAD;
  const b = h / 2 + PAD;
  const r = Math.max(a / HEX_ASPECT, a / Math.sqrt(3) + b, MIN_H / 2);
  let best = { w: 2 * r * HEX_ASPECT, h: 2 * r };
  for (let bw = Math.ceil(2 * a); (bw * bw) / MAX_ASPECT < best.w * best.h; bw++) {
    const bh = Math.max(MIN_H, (2 * b) / (1 - a / bw), bw / MAX_ASPECT);
    if (bw / bh >= HEX_ASPECT && bw * bh < best.w * best.h) best = { w: bw, h: bh };
  }
  return { w: Math.ceil(best.w), h: Math.ceil(best.h) };
}

/**
 * Each hexagon just holds its key list (`hexBox`), and they stand side by
 * side in input order, left to right, centred on the hub, in a low arch along
 * the window's bottom edge: the ones over the hub clear it and its level pill,
 * the outer ones sink to the edge. Kept low on purpose — the legend must not
 * hide the subwindows' tab bars it steers over (an arc fanned round the hub
 * reached 60–85% up a 1366×768 window; this stays under 40%). The whole row
 * scales down when the window is too narrow or short.
 */
export function orbitLayout(sizes: { w: number; h: number }[], vw: number, vh: number): Orbit {
  const boxes = sizes.map((s) => hexBox(s.w, s.h));
  const total = boxes.reduce((sum, b) => sum + b.w, 0) + GAP * Math.max(0, boxes.length - 1);
  const half = Math.max(1, total / 2);
  const bottom = HUB_BOTTOM + HUB_R;
  const floor = EDGE - bottom;
  let at = -total / 2;
  const hexes = boxes.map(({ w, h }) => {
    const x = at + w / 2;
    at += w + GAP;
    let low = floor + (HUB_CLEAR - floor) * Math.max(0, 1 - (x / half) ** 2);
    if (Math.abs(x) - w / 2 < HUB_CLEAR_HALF) low = Math.max(low, HUB_CLEAR);
    const y = low + h / 2;
    return { w, h, x, y, phi: Math.atan2(y, x), r: Math.hypot(x, y) };
  });
  const tall = Math.max(HUB_R, ...hexes.map((c) => c.y + c.h / 2));
  const wide = Math.max(total, 2 * HUB_R);
  const scale = Math.max(0.4, Math.min(1, (vw - 2 * EDGE) / wide, (vh - bottom - 48) / tall));
  return { bottom, scale, hexes };
}
