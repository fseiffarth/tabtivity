import { describe, it, expect } from "vitest";
import type { DiffFile, DiffLine } from "../../lib/viewers/diff";
import {
  DIFF_LEAD_LINES,
  DIFF_LINE_BUDGET,
  capDiffFiles,
  clampLineWindow,
  countDiffLines,
  firstChangeIndex,
  growLineWindow,
  initialLineWindow,
  isNotARepoError,
  shortenDiffFiles,
  shortenLongLines,
  shortenText,
} from "../../lib/viewers/diffBudget";

const line = (text: string, type: DiffLine["type"] = "context"): DiffLine => ({
  type,
  text,
  oldNo: null,
  newNo: null,
});

const file = (name: string, ...hunkSizes: number[]): DiffFile => ({
  oldPath: name,
  newPath: name,
  status: "modified",
  binary: false,
  combined: false,
  crlf: false,
  hunks: hunkSizes.map((n, h) => ({
    header: `@@ ${h} @@`,
    lines: Array.from({ length: n }, (_, i) => line(`${name}:${h}:${i}`)),
  })),
});

describe("capDiffFiles", () => {
  it("returns a diff that fits untouched, same objects", () => {
    const files = [file("a", 3), file("b", 4)];
    const r = capDiffFiles(files, 10);
    expect(r.files).toBe(files);
    expect(r).toMatchObject({ total: 7, shown: 7 });
  });

  it("cuts at a line inside a hunk and drops the files after it", () => {
    const files = [file("a", 5), file("b", 5, 5), file("c", 5)];
    const r = capDiffFiles(files, 8);
    expect(r.total).toBe(20);
    expect(r.shown).toBe(8);
    expect(countDiffLines(r.files)).toBe(8);
    expect(r.files.map((f) => f.newPath)).toEqual(["a", "b"]);
    // File a fits whole and keeps its identity; b is the one cut.
    expect(r.files[0]).toBe(files[0]);
    expect(r.files[1].hunks[0].lines).toHaveLength(3);
  });

  it("splits a hunk across the budget and keeps whole hunks before it", () => {
    const files = [file("a", 4, 6)];
    const r = capDiffFiles(files, 7);
    expect(r.files[0].hunks.map((h) => h.lines.length)).toEqual([4, 3]);
    expect(r.files[0].hunks[0]).toBe(files[0].hunks[0]);
  });

  it("a zero budget shows nothing of a non-empty diff", () => {
    const r = capDiffFiles([file("a", 2)], 0);
    expect(r.files).toEqual([]);
    expect(r).toMatchObject({ total: 2, shown: 0 });
  });

  it("the default budget caps a lockfile-sized diff", () => {
    const big = [file("package-lock.json", 60_000)];
    const r = capDiffFiles(big, DIFF_LINE_BUDGET);
    expect(countDiffLines(r.files)).toBe(DIFF_LINE_BUDGET);
    expect(r.total).toBe(60_000);
  });
});

describe("line windows", () => {
  it("shows everything when it fits", () => {
    expect(initialLineWindow(900, 400, 1500)).toEqual({ start: 0, end: 900 });
  });

  it("opens a little above the first change", () => {
    const w = initialLineWindow(100_000, 50_000, 1500);
    expect(w).toEqual({ start: 50_000 - DIFF_LEAD_LINES, end: 50_000 - DIFF_LEAD_LINES + 1500 });
  });

  it("keeps the window inside the file when the change is near an end", () => {
    expect(initialLineWindow(100_000, 10, 1500)).toEqual({ start: 0, end: 1500 });
    const last = initialLineWindow(100_000, 99_990, 1500);
    expect(last.end).toBe(100_000);
    expect(last.start).toBe(98_500);
  });

  it("grows up, down and to the whole, never past the ends", () => {
    const w = { start: 5000, end: 6500 };
    expect(growLineWindow(w, 100_000, "up", 3000)).toEqual({ start: 2000, end: 6500 });
    expect(growLineWindow({ start: 1000, end: 6500 }, 100_000, "up", 3000).start).toBe(0);
    expect(growLineWindow(w, 7000, "down", 3000)).toEqual({ start: 5000, end: 7000 });
    expect(growLineWindow(w, 100_000, "all")).toEqual({ start: 0, end: 100_000 });
  });

  it("clamps a window to a file that shrank", () => {
    expect(clampLineWindow({ start: 5000, end: 6500 }, 4000)).toEqual({ start: 4000, end: 4000 });
    expect(clampLineWindow({ start: 0, end: 10 }, 100)).toEqual({ start: 0, end: 10 });
  });

  it("finds the first changed line", () => {
    expect(firstChangeIndex([line("a"), line("b"), line("c", "del"), line("d", "add")])).toBe(2);
    expect(firstChangeIndex([line("a")])).toBe(-1);
  });
});

describe("shortening long lines", () => {
  it("leaves a line that fits alone", () => {
    expect(shortenText("abc", 5)).toBe("abc");
  });

  it("cuts a long line with an ellipsis, not through a surrogate pair", () => {
    expect(shortenText("abcdefgh", 5)).toBe("abcde…");
    const pair = "ab😀cd"; // the emoji is two UTF-16 units at index 2-3
    expect(shortenText(pair, 3)).toBe("ab…");
  });

  it("counts the lines it cut and passes the rest through", () => {
    const short = line("x");
    const r = shortenLongLines([short, line("y".repeat(50))], 10);
    expect(r.shortened).toBe(1);
    expect(r.lines[0]).toBe(short);
    expect(r.lines[1].text).toBe(`${"y".repeat(10)}…`);
  });

  it("a megabyte line costs a bounded row", () => {
    const r = shortenLongLines([line("z".repeat(1_000_000))]);
    expect(r.lines[0].text.length).toBeLessThan(2100);
  });

  it("shortens inside files, keeping untouched hunks and files as they were", () => {
    const a = file("a", 2);
    const b: DiffFile = { ...file("b", 1), hunks: [{ header: "@@", lines: [line("q".repeat(30))] }] };
    const r = shortenDiffFiles([a, b], 10);
    expect(r.shortened).toBe(1);
    expect(r.files[0]).toBe(a);
    expect(r.files[1].hunks[0].lines[0].text).toHaveLength(11);
  });
});

describe("isNotARepoError", () => {
  it("matches the backend's phrase and git's own", () => {
    expect(isNotARepoError("not a git repository")).toBe(true);
    expect(isNotARepoError("fatal: not a git repository (or any of the parent directories): .git")).toBe(true);
    expect(isNotARepoError("permission denied")).toBe(false);
  });
});
