import { describe, expect, it } from "vitest";
import type { DiffFile, DiffLine } from "../../lib/viewers/diff";
import {
  changeAnchors,
  changeStarts,
  fileLabel,
  fileStats,
  foldRanges,
  foldSegments,
  scrollTopFor,
  splitDiffRows,
  stepChange,
} from "../../lib/viewers/diffRows";

const ctx = (n: number): DiffLine => ({ type: "context", text: `c${n}`, oldNo: n, newNo: n });
const add = (n: number): DiffLine => ({ type: "add", text: `a${n}`, oldNo: null, newNo: n });
const del = (n: number): DiffLine => ({ type: "del", text: `d${n}`, oldNo: n, newNo: null });
const run = (count: number, from = 1): DiffLine[] => Array.from({ length: count }, (_, i) => ctx(from + i));

describe("splitDiffRows", () => {
  it("marks the first row of each replacement run as a change start", () => {
    const rows = splitDiffRows([ctx(1), del(2), del(3), add(2), ctx(4), add(5)]);
    expect(rows.map((r) => [r.before?.text, r.after?.text, r.start === true, r.at])).toEqual([
      ["c1", "c1", false, 0],
      ["d2", "a2", true, 1],
      ["d3", undefined, false, 1],
      ["c4", "c4", false, 4],
      [undefined, "a5", true, 5],
    ]);
  });

  it("keeps metadata lines as notes at their index", () => {
    const rows = splitDiffRows([{ type: "hunk", text: "@@ -1 +1 @@", oldNo: null, newNo: null }, ctx(1)]);
    expect(rows[0]).toMatchObject({ note: "@@ -1 +1 @@", at: 0 });
    expect(rows[1].note).toBeUndefined();
  });
});

describe("changeStarts / changeAnchors", () => {
  it("finds the first line of each run of changes", () => {
    expect(changeStarts([add(1), add(2), ctx(3), del(4), add(4), ctx(6), add(7)])).toEqual([0, 3, 6]);
    expect(changeStarts(run(3))).toEqual([]);
  });

  it("lists every change of every file in reading order, with stable ids", () => {
    const files: Pick<DiffFile, "hunks">[] = [
      { hunks: [{ header: "", lines: [ctx(1), add(2)] }, { header: "", lines: [del(9), ctx(10), add(11)] }] },
      { hunks: [{ header: "", lines: [add(1)] }] },
    ];
    expect(changeAnchors(files).map((a) => a.id)).toEqual(["0:0:1", "0:1:0", "0:1:2", "1:0:0"]);
    expect(changeAnchors(files)[3]).toMatchObject({ file: 1, hunk: 0, line: 0 });
    expect(changeAnchors([])).toEqual([]);
  });
});

describe("stepChange", () => {
  it("wraps around in both directions", () => {
    expect(stepChange(2, 3, 1)).toBe(0);
    expect(stepChange(0, 3, -1)).toBe(2);
    expect(stepChange(1, 3, 1)).toBe(2);
  });

  it("starts at the first for next and at the last for previous", () => {
    expect(stepChange(-1, 4, 1)).toBe(0);
    expect(stepChange(-1, 4, -1)).toBe(3);
    expect(stepChange(9, 4, 1)).toBe(0);
  });

  it("is -1 without any change", () => {
    expect(stepChange(-1, 0, 1)).toBe(-1);
  });
});

describe("foldRanges", () => {
  it("folds nothing in a file without a change", () => {
    expect(foldRanges(run(50))).toEqual([]);
  });

  it("keeps the margin around a change and folds the stretches beyond it", () => {
    // 20 unchanged, one change, 20 unchanged.
    const lines = [...run(20), add(21), ...run(20, 21)];
    // Leading stretch [0,20): no margin at the file's start, 4 next to the change.
    // Trailing stretch [21,41): 4 next to the change, none at the end.
    expect(foldRanges(lines, 4, 6)).toEqual([
      { from: 0, to: 16 },
      { from: 25, to: 41 },
    ]);
  });

  it("keeps a margin on both sides of a stretch between two changes", () => {
    const lines = [add(1), ...run(20, 1), add(22)];
    expect(foldRanges(lines, 3, 6)).toEqual([{ from: 4, to: 18 }]);
  });

  it("leaves a stretch alone when it would hide fewer than the minimum", () => {
    const lines = [add(1), ...run(10, 1), add(12)];
    expect(foldRanges(lines, 4, 6)).toEqual([]); // 10 - 8 = 2 hidden
    expect(foldRanges(lines, 4, 2)).toEqual([{ from: 5, to: 7 }]);
  });

  it("never folds a change or a marker line", () => {
    const lines = [...run(30), del(31), { type: "nonewline", text: "\\ No newline", oldNo: null, newNo: null } as DiffLine, ...run(30, 31)];
    for (const range of foldRanges(lines)) {
      for (let i = range.from; i < range.to; i++) expect(lines[i].type).toBe("context");
    }
  });
});

describe("foldSegments", () => {
  it("cuts the lines into shown stretches and folds", () => {
    expect(foldSegments(30, [{ from: 5, to: 12 }, { from: 20, to: 30 }])).toEqual([
      { fold: false, from: 0, to: 5 },
      { fold: true, from: 5, to: 12 },
      { fold: false, from: 12, to: 20 },
      { fold: true, from: 20, to: 30 },
    ]);
    expect(foldSegments(4, [])).toEqual([{ fold: false, from: 0, to: 4 }]);
    expect(foldSegments(0, [])).toEqual([]);
  });
});

describe("fileStats / fileLabel", () => {
  it("counts added and deleted lines over every hunk", () => {
    const file = { hunks: [{ header: "", lines: [add(1), add(2), del(3)] }, { header: "", lines: [ctx(4), del(5)] }] };
    expect(fileStats(file)).toEqual({ added: 2, removed: 2 });
  });

  it("names a file by its new path, a deleted one by its old", () => {
    expect(fileLabel({ oldPath: "a.ts", newPath: "a.ts" })).toEqual({ path: "a.ts" });
    expect(fileLabel({ oldPath: "/dev/null", newPath: "new.ts" })).toEqual({ path: "new.ts" });
    expect(fileLabel({ oldPath: "gone.ts", newPath: "/dev/null" })).toEqual({ path: "gone.ts" });
  });

  it("shows where a renamed file came from", () => {
    expect(fileLabel({ oldPath: "src/old.ts", newPath: "src/new.ts" })).toEqual({ path: "src/new.ts", from: "src/old.ts" });
  });
});

describe("scrollTopFor", () => {
  const scroller = { top: 100, scrollTop: 400, height: 300 };
  it("puts an element at the top of the scroller", () => {
    expect(scrollTopFor("start", scroller, { top: 250, height: 20 })).toBe(550);
  });
  it("centres an element in the scroller", () => {
    expect(scrollTopFor("center", scroller, { top: 250, height: 20 })).toBe(410);
  });
  it("never goes above the start", () => {
    expect(scrollTopFor("center", { top: 0, scrollTop: 0, height: 500 }, { top: 10, height: 10 })).toBe(0);
  });
});
