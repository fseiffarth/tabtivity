/**
 * The eraser's culling and counting (`layer.ts`): a mark out of reach is
 * skipped by its box, and the ceilings are checked against counts kept per
 * page — neither may change what the eraser does.
 */
import { describe, expect, it } from "vitest";
import {
  addMark, cutStroke, cutStrokeByRect, EMPTY_LAYER, eraseAlong, eraseAt, eraseRect, inkWidth, LIMITS, markCount, moveMarks, touches,
  type InkMark, type Layer, type Mark,
} from "../../../mobile-web/src/markup/layer";

const SIZE: [number, number] = [600, 800];

/** A small seeded generator, so a failure repeats. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strokeFrom(rand: () => number): InkMark {
  const count = 1 + Math.floor(rand() * 7);
  const points = Array.from({ length: count }, (): [number, number, number] => [Math.round(rand() * 6000) / 10, Math.round(rand() * 8000) / 10, 0.5]);
  const style = [undefined, "marker", "dashed", "arrow"][Math.floor(rand() * 4)] as InkMark["style"];
  return { kind: "ink", color: "red", width: [1, 3, 14][Math.floor(rand() * 3)], points, ...(style ? { style } : {}) };
}

/** Distance from `p` to the segment `a`→`b`, the plain way. */
function distance(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function nearest(mark: InkMark, x: number, y: number): number {
  if (mark.points.length === 1) return Math.hypot(mark.points[0][0] - x, mark.points[0][1] - y);
  let best = Infinity;
  for (let i = 1; i < mark.points.length; i++) best = Math.min(best, distance([x, y], mark.points[i - 1], mark.points[i]));
  return best;
}

describe("eraser culling", () => {
  it("never skips a stroke the eraser reaches, and skips only ones it misses", () => {
    const rand = random(7);
    let reached = 0;
    for (let i = 0; i < 1500; i++) {
      const mark = strokeFrom(rand);
      // Near the stroke half the time, anywhere on the page otherwise.
      const near = rand() < 0.5;
      const at = mark.points[Math.floor(rand() * mark.points.length)];
      const x = near ? at[0] + (rand() - 0.5) * 80 : rand() * 600;
      const y = near ? at[1] + (rand() - 0.5) * 80 : rand() * 800;
      const radius = 1 + rand() * 40;
      const reach = radius + inkWidth(mark.width, 1) / 2;
      const gap = nearest(mark, x, y);
      if (gap <= reach) reached++;
      expect(touches(mark, x, y, radius)).toBe(gap <= reach);
      // A cut is made wherever a segment runs under the eraser; out of reach, none.
      if (gap > reach + 1e-6) expect(cutStroke(mark, x, y, radius)).toBeNull();
      if (gap < reach - 1e-6) expect(cutStroke(mark, x, y, radius)).not.toBeNull();
    }
    // The cases were not all misses.
    expect(reached).toBeGreaterThan(200);
  });

  it("culls the area eraser by the stroke's box as exactly as by its segments", () => {
    const rand = random(11);
    let cut = 0;
    for (let i = 0; i < 1500; i++) {
      const mark = strokeFrom(rand);
      const x0 = rand() * 560;
      const y0 = rand() * 760;
      const rect: [number, number, number, number] = [x0, y0, x0 + 5 + rand() * 120, y0 + 5 + rand() * 120];
      const half = inkWidth(mark.width, 1) / 2;
      const grown = [rect[0] - half, rect[1] - half, rect[2] + half, rect[3] + half];
      // A sample of the stroke strictly inside the grown rectangle means a cut.
      let inside = false;
      let outside = true;
      for (let s = 0; s < mark.points.length; s++) {
        const a = mark.points[s];
        const b = mark.points[Math.min(s + 1, mark.points.length - 1)];
        // A sample every half unit: a segment cannot slip past a corner.
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2));
        for (let t = 0; t <= steps; t++) {
          const px = a[0] + ((b[0] - a[0]) * t) / steps;
          const py = a[1] + ((b[1] - a[1]) * t) / steps;
          if (px > grown[0] + 1e-6 && px < grown[2] - 1e-6 && py > grown[1] + 1e-6 && py < grown[3] - 1e-6) inside = true;
          if (px >= grown[0] - 1e-6 && px <= grown[2] + 1e-6 && py >= grown[1] - 1e-6 && py <= grown[3] + 1e-6) outside = false;
        }
      }
      const result = cutStrokeByRect(mark, rect);
      if (inside) { expect(result).not.toBeNull(); cut++; }
      if (outside) expect(result).toBeNull();
    }
    expect(cut).toBeGreaterThan(100);
  });
});

describe("eraser counting", () => {
  /** What `markCount` must say, counted from the marks. */
  const recount = (layer: Layer) => {
    let marks = 0;
    let points = 0;
    for (const page of Object.values(layer.pages)) {
      marks += page.marks.length;
      for (const mark of page.marks) if (mark.kind === "ink") points += mark.points.length;
    }
    return { marks, points };
  };

  it("keeps the count true through every kind of change to a layer", () => {
    const rand = random(3);
    let layer: Layer = EMPTY_LAYER;
    for (let i = 0; i < 40; i++) layer = addMark(layer, 1 + (i % 3), SIZE, strokeFrom(rand));
    layer = addMark(layer, 2, SIZE, { kind: "box", color: "yellow", rect: [10, 10, 100, 40] });
    // Counted once, so the steps below derive their counts from this one.
    expect(markCount(layer)).toEqual(recount(layer));
    for (let step = 0; step < 60; step++) {
      const page = 1 + Math.floor(rand() * 3);
      const x = rand() * 600;
      const y = rand() * 800;
      const options = { whole: rand() < 0.4 };
      const choice = step % 4;
      if (choice === 0) layer = eraseAt(layer, page, x, y, 30, options);
      else if (choice === 1) layer = eraseAlong(layer, page, [x, y], [x + 200, y + 100], 20, options);
      else if (choice === 2) layer = eraseRect(layer, page, [x, y], [x + 150, y + 150]);
      else layer = moveMarks(layer, page, [0, 1], 5, 5);
      expect(markCount(layer)).toEqual(recount(layer));
    }
  });

  it("measures the ceilings by the totals, so a layer already over one takes whole strokes", () => {
    const stroke = addMark(EMPTY_LAYER, 1, SIZE, { kind: "ink", color: "red", width: 3, points: [[0, 300, 0.5], [600, 300, 0.5]] });
    const crowded: Mark[] = Array.from({ length: LIMITS.marks + 5 }, (): Mark => ({ kind: "ink", color: "red", width: 3, points: [[5, 5, 0.5]] }));
    const layer: Layer = { ...stroke, pages: { ...stroke.pages, 2: { size: SIZE, marks: crowded } } };
    // Shortened at its end the stroke would still be one stroke — but the
    // layer is over the ceiling already, so the whole stroke goes.
    expect(eraseAt(layer, 1, 600, 300, 4).pages[1]).toBeUndefined();
    // The same under the ceiling cuts it.
    expect(eraseAt(stroke, 1, 600, 300, 4).pages[1].marks).toHaveLength(1);
  });
});
