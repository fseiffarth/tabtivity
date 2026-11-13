/**
 * `printImposition` — the pure arithmetic behind "pages per sheet" and the
 * booklet: which page of the print sequence goes in which cell of which sheet,
 * and where the cells are. The preview and the vector PDF both read this plan.
 */
import { describe, it, expect } from "vitest";
import {
  NUP_CHOICES,
  autoTurn,
  autoTurns,
  bookletSides,
  cellRects,
  gridFor,
  isImposed,
  pagesPerSheet,
  planImposition,
  sheetCount,
} from "../../lib/viewers/printImposition";

/** 1-based, so a plan reads like the page numbers a person would write. */
const pageNumbers = (count: number, nup: number, booklet = false, landscape = false) =>
  planImposition(count, { nup, booklet }, landscape).sheets.map((cells) =>
    cells.map((at) => (at === null ? null : at + 1)),
  );

describe("gridFor", () => {
  it("stacks 2 and 6 on an upright sheet, so their cells are landscape-ish", () => {
    expect(gridFor(2, false)).toEqual({ cols: 1, rows: 2 });
    expect(gridFor(6, false)).toEqual({ cols: 2, rows: 3 });
  });

  it("puts 2 and 6 side by side on a landscape sheet", () => {
    expect(gridFor(2, true)).toEqual({ cols: 2, rows: 1 });
    expect(gridFor(6, true)).toEqual({ cols: 3, rows: 2 });
  });

  it("keeps the square grids square whatever the sheet", () => {
    for (const per of [1, 4, 9, 16]) {
      const up = gridFor(per, false);
      expect(up.cols).toBe(up.rows);
      expect(gridFor(per, true)).toEqual(up);
    }
  });

  it("has a cell for every page it offers", () => {
    for (const per of NUP_CHOICES) {
      for (const landscape of [false, true]) {
        const { cols, rows } = gridFor(per, landscape);
        expect(cols * rows).toBe(per);
      }
    }
  });
});

describe("N-up", () => {
  it("is the identity at one page per sheet", () => {
    expect(pageNumbers(3, 1)).toEqual([[1], [2], [3]]);
  });

  it("fills sheets in reading order and leaves the tail blank", () => {
    expect(pageNumbers(5, 4)).toEqual([
      [1, 2, 3, 4],
      [5, null, null, null],
    ]);
    expect(pageNumbers(7, 2)).toEqual([[1, 2], [3, 4], [5, 6], [7, null]]);
  });

  it("takes the grid from the sheet's orientation", () => {
    const upright = planImposition(6, { nup: 6, booklet: false }, false);
    const wide = planImposition(6, { nup: 6, booklet: false }, true);
    expect([upright.cols, upright.rows]).toEqual([2, 3]);
    expect([wide.cols, wide.rows]).toEqual([3, 2]);
  });

  it("plans nothing for an empty sequence", () => {
    expect(planImposition(0, { nup: 4, booklet: false }, false).sheets).toEqual([]);
    expect(sheetCount(0, { nup: 4, booklet: false })).toBe(0);
  });

  it("counts the sheets a job takes", () => {
    expect(sheetCount(9, { nup: 4, booklet: false })).toBe(3);
    expect(sheetCount(9, { nup: 1, booklet: false })).toBe(9);
    expect(sheetCount(9, { nup: 16, booklet: false })).toBe(1);
  });

  it("falls back to one page per sheet on a value it does not offer", () => {
    expect(pagesPerSheet({ nup: 5, booklet: false })).toBe(1);
    expect(isImposed({ nup: 5, booklet: false })).toBe(false);
  });
});

describe("booklet", () => {
  it("folds eight pages as [8,1] [2,7] [6,3] [4,5]", () => {
    expect(pageNumbers(8, 1, true)).toEqual([
      [8, 1],
      [2, 7],
      [6, 3],
      [4, 5],
    ]);
  });

  it("pads to a multiple of four with blanks at the back cover", () => {
    // Five pages are eight: pages 6-8 do not exist.
    expect(pageNumbers(5, 1, true)).toEqual([
      [null, 1],
      [2, null],
      [null, 3],
      [4, 5],
    ]);
    expect(bookletSides(1)).toEqual([
      [null, 0],
      [null, null],
    ]);
  });

  it("is two to a side whatever the N-up says, on a landscape grid", () => {
    const plan = planImposition(4, { nup: 9, booklet: true }, false);
    expect([plan.cols, plan.rows]).toEqual([2, 1]);
    expect(plan.sheets).toHaveLength(2);
    expect(pagesPerSheet({ nup: 9, booklet: true })).toBe(2);
  });

  it("puts every page on exactly one side, in nesting order", () => {
    for (const count of [1, 2, 3, 4, 5, 9, 12, 13]) {
      const sides = bookletSides(count);
      const padded = Math.ceil(count / 4) * 4;
      expect(sides).toHaveLength(padded / 2);
      const seen = sides.flat().filter((at): at is number => at !== null);
      expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
      // Both pages of a side are the same distance from the two covers: their
      // 1-based numbers sum to padded+1 — on the back of a sheet as on the front.
      for (const [l, r] of sides) {
        if (l !== null && r !== null) expect(l + 1 + (r + 1)).toBe(padded + 1);
      }
    }
  });

  it("has an even number of sides, so every copy of a two-sided job ends on a back", () => {
    for (const count of [1, 3, 4, 7, 20]) expect(bookletSides(count).length % 2).toBe(0);
  });

  it("is empty for nothing", () => {
    expect(bookletSides(0)).toEqual([]);
  });
});

describe("cellRects", () => {
  it("is one cell filling the area at one page per sheet", () => {
    expect(cellRects(1, 1, 500, 800, 0)).toEqual([{ x: 0, y: 0, w: 500, h: 800 }]);
  });

  it("lays cells out in reading order from the top, y up", () => {
    const [a, b, c, d] = cellRects(2, 2, 210, 300, 10);
    expect(a).toEqual({ x: 0, y: 155, w: 100, h: 145 });
    expect(b).toEqual({ x: 110, y: 155, w: 100, h: 145 });
    expect(c).toEqual({ x: 0, y: 0, w: 100, h: 145 });
    expect(d).toEqual({ x: 110, y: 0, w: 100, h: 145 });
  });

  it("keeps all cells inside the area with the gutter between them", () => {
    for (const per of NUP_CHOICES) {
      const { cols, rows } = gridFor(per, false);
      const cells = cellRects(cols, rows, 400, 600, 8);
      expect(cells).toHaveLength(per);
      for (const c of cells) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(400 + 1e-9);
        expect(c.y + c.h).toBeLessThanOrEqual(600 + 1e-9);
      }
    }
  });
});

describe("autoTurn", () => {
  it("turns an upright page into the landscape cell of a 2-up", () => {
    // A4 on an A4 sheet's half: 210×(297−3)/2.
    expect(autoTurn(210, 297, 210, 147)).toBe(270);
  });

  it("leaves a page that already fits its cell", () => {
    expect(autoTurn(297, 210, 210, 147)).toBe(0);
    expect(autoTurn(210, 297, 105, 148)).toBe(0);
  });

  it("does not flip a page for a hair in a near-square cell", () => {
    expect(autoTurn(210, 297, 105, 99)).toBe(0);
  });

  it("ignores sizes it cannot read", () => {
    expect(autoTurn(0, 0, 100, 100)).toBe(0);
  });

  it("is only used for 2 and 6 to a sheet", () => {
    expect(autoTurns({ nup: 2, booklet: false })).toBe(true);
    expect(autoTurns({ nup: 6, booklet: false })).toBe(true);
    expect(autoTurns({ nup: 4, booklet: false })).toBe(false);
    expect(autoTurns({ nup: 1, booklet: false })).toBe(false);
    expect(autoTurns({ nup: 2, booklet: true })).toBe(false);
  });
});
