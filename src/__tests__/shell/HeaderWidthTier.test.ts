/** The top bar's width tiers: badges, then the clock, then the cluster. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { boxPillBudget, headerWidthTier } from "../../lib/headerPins";
import { boxPillsShown } from "../../components/projects/BoxScopeChip";
import type { ProjectBox } from "../../types";

describe("headerWidthTier", () => {
  it("folds nothing on a wide bar", () => {
    expect(headerWidthTier(1920)).toBe(0);
    expect(headerWidthTier(1280)).toBe(0);
  });

  it("gives way one step at a time as the bar narrows", () => {
    expect(headerWidthTier(1279)).toBe(1);
    expect(headerWidthTier(1100)).toBe(1);
    expect(headerWidthTier(1099)).toBe(2);
    expect(headerWidthTier(900)).toBe(2);
    expect(headerWidthTier(899)).toBe(3);
    expect(headerWidthTier(0)).toBe(3);
  });
});

describe("boxPillBudget", () => {
  it("is 6 on a wide bar, 3 at tier 2 and 1 at tier 3", () => {
    expect(([0, 1, 2, 3] as const).map(boxPillBudget)).toEqual([6, 6, 3, 1]);
  });

  it("follows the bar's own tiers", () => {
    expect([1920, 1280, 1100, 1099, 900, 899].map((w) => boxPillBudget(headerWidthTier(w)))).toEqual([
      6, 6, 6, 3, 3, 1,
    ]);
  });
});

describe("boxPillsShown", () => {
  const boxes = (n: number): ProjectBox[] =>
    Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `b${i}`, member_ids: [], position: i }));
  const ids = (list: ProjectBox[]) => list.map((b) => b.id);

  it("takes the first budget-many boxes in order", () => {
    expect(ids(boxPillsShown(boxes(8), null, 3))).toEqual(["b0", "b1", "b2"]);
    expect(ids(boxPillsShown(boxes(2), null, 6))).toEqual(["b0", "b1"]);
  });

  it("seats a selected box that would be off the row in its own place, in the last slot", () => {
    expect(ids(boxPillsShown(boxes(8), "b6", 3))).toEqual(["b0", "b1", "b6"]);
    expect(ids(boxPillsShown(boxes(8), "b1", 3))).toEqual(["b0", "b1", "b2"]);
  });

  it("skips boxes hidden from the row, but never the selected one", () => {
    const list = boxes(4).map((b) => (b.id === "b0" || b.id === "b2" ? { ...b, hide_pill: true } : b));
    expect(ids(boxPillsShown(list, null, 6))).toEqual(["b1", "b3"]);
    expect(ids(boxPillsShown(list, "b2", 6))).toEqual(["b1", "b2", "b3"]);
  });

  it("holds the selected box alone on a budget of 1, and nothing without one", () => {
    expect(ids(boxPillsShown(boxes(8), "b5", 1))).toEqual(["b5"]);
    expect(ids(boxPillsShown(boxes(8), null, 1))).toEqual([]);
    expect(ids(boxPillsShown(boxes(8), "gone", 1))).toEqual([]);
  });
});
