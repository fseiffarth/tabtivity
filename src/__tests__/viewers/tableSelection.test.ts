import { describe, it, expect } from "vitest";
import {
  resolveRange,
  selectionValues,
  valuesToTsv,
  rangeSize,
  selectAllRows,
  moveFocus,
  type GridSelection,
} from "../../lib/viewers/tableSelection";
import type { RowRef } from "../../lib/viewers/table";

const header = ["id", "name", "note"];
// Source order 1,2,3 — shown here in a sorted order 3,1,2 to prove the range
// follows the screen while the selection stays keyed by source index.
const visible: RowRef[] = [
  { index: 3, cells: ["3", "c", "z"] },
  { index: 1, cells: ["1", "a", "x"] },
  { index: 2, cells: ["2", "b", "y"] },
];
const cols = [0, 1, 2];

describe("resolveRange", () => {
  it("is null with nothing selected or nothing shown", () => {
    expect(resolveRange(null, visible, cols)).toBeNull();
    expect(resolveRange({ kind: "rows", anchor: 1, focus: 1 }, [], cols)).toBeNull();
    expect(resolveRange({ kind: "rows", anchor: 1, focus: 1 }, visible, [])).toBeNull();
  });

  it("maps a cell rectangle to screen positions whichever way it was dragged", () => {
    const sel: GridSelection = {
      kind: "cells",
      anchor: { row: 2, col: 2 },
      focus: { row: 1, col: 1 },
    };
    expect(resolveRange(sel, visible, cols)).toEqual({ rowLo: 1, rowHi: 2, colLo: 1, colHi: 2 });
  });

  it("spans every column for rows and every row for columns", () => {
    expect(resolveRange({ kind: "rows", anchor: 3, focus: 2 }, visible, cols)).toEqual({
      rowLo: 0,
      rowHi: 2,
      colLo: 0,
      colHi: 2,
    });
    expect(resolveRange({ kind: "cols", anchor: 1, focus: 1 }, visible, cols)).toEqual({
      rowLo: 0,
      rowHi: 2,
      colLo: 1,
      colHi: 1,
    });
  });

  it("closes the gap over a hidden column", () => {
    const shown = [0, 2];
    const r = resolveRange({ kind: "cols", anchor: 0, focus: 2 }, visible, shown)!;
    expect(rangeSize(r)).toEqual({ rows: 3, cols: 2 });
  });

  it("is null while an end is filtered out or hidden", () => {
    expect(resolveRange({ kind: "rows", anchor: 9, focus: 1 }, visible, cols)).toBeNull();
    expect(resolveRange({ kind: "cols", anchor: 1, focus: 7 }, visible, cols)).toBeNull();
  });
});

describe("selectionValues / valuesToTsv", () => {
  it("copies a cell rectangle in screen order, without the header", () => {
    const sel: GridSelection = {
      kind: "cells",
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
    };
    const range = resolveRange(sel, visible, cols)!;
    expect(selectionValues(sel, range, visible, cols, header)).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });

  it("labels a copied column with its header", () => {
    const sel: GridSelection = { kind: "cols", anchor: 1, focus: 1 };
    const range = resolveRange(sel, visible, cols)!;
    expect(selectionValues(sel, range, visible, cols, header)).toEqual([
      ["name"],
      ["c"],
      ["a"],
      ["b"],
    ]);
  });

  it("copies only the visible columns of a row", () => {
    const sel: GridSelection = { kind: "rows", anchor: 1, focus: 1 };
    const shown = [0, 2];
    const range = resolveRange(sel, visible, shown)!;
    expect(selectionValues(sel, range, visible, shown, header)).toEqual([["1", "x"]]);
  });

  it("quotes only the fields that need it", () => {
    expect(valuesToTsv([["a", "b c"], ['say "hi"', "x\ty"], ["l1\nl2", ""]])).toBe(
      'a\tb c\n"say ""hi"""\t"x\ty"\n"l1\nl2"\t',
    );
  });
});

describe("selectAllRows", () => {
  it("covers the visible rows, first to last", () => {
    expect(selectAllRows(visible)).toEqual({ kind: "rows", anchor: 3, focus: 2 });
    expect(selectAllRows([])).toBeNull();
  });
});

describe("moveFocus", () => {
  it("starts at the first visible cell", () => {
    expect(moveFocus(null, 1, 0, false, visible, cols)).toEqual({
      kind: "cells",
      anchor: { row: 3, col: 0 },
      focus: { row: 3, col: 0 },
    });
    expect(moveFocus(null, 1, 0, false, [], cols)).toBeNull();
  });

  it("moves a cell and drags the anchor with it, clamped at the edges", () => {
    const sel: GridSelection = {
      kind: "cells",
      anchor: { row: 2, col: 2 },
      focus: { row: 2, col: 2 },
    };
    expect(moveFocus(sel, 1, 1, false, visible, cols)).toEqual(sel);
    expect(moveFocus(sel, -1, 0, false, visible, cols)).toEqual({
      kind: "cells",
      anchor: { row: 1, col: 2 },
      focus: { row: 1, col: 2 },
    });
  });

  it("keeps the anchor when extending", () => {
    const sel: GridSelection = {
      kind: "cells",
      anchor: { row: 3, col: 0 },
      focus: { row: 3, col: 0 },
    };
    expect(moveFocus(sel, 1, 1, true, visible, cols)).toEqual({
      kind: "cells",
      anchor: { row: 3, col: 0 },
      focus: { row: 1, col: 1 },
    });
  });

  it("moves a row or column selection along its own axis", () => {
    expect(moveFocus({ kind: "rows", anchor: 3, focus: 3 }, 1, 0, false, visible, cols)).toEqual({
      kind: "rows",
      anchor: 1,
      focus: 1,
    });
    expect(moveFocus({ kind: "cols", anchor: 0, focus: 0 }, 0, 1, true, visible, cols)).toEqual({
      kind: "cols",
      anchor: 0,
      focus: 1,
    });
  });

  it("restarts at the first cell when the focus is off screen", () => {
    const sel: GridSelection = { kind: "rows", anchor: 9, focus: 9 };
    expect(moveFocus(sel, 1, 0, false, visible, cols)?.kind).toBe("cells");
  });
});
