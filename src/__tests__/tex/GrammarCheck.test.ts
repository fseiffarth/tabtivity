/**
 * Unit tests for the spell-check overlay helpers: `resolveGrammarRanges`
 * (mapping reported issues to concrete `{start,end}` ranges in the draft)
 * and `decorateGrammarRanges` (the transparent overlay that underlines them).
 * Mirrors the search/change-decoration tests.
 */
import { describe, it, expect } from "vitest";
import {
  resolveGrammarRanges,
  decorateGrammarRanges,
  type GrammarRange,
} from "../../components/embed/fileViewer/decorations";
import type { GrammarIssue } from "../../types";

const issue = (over: Partial<GrammarIssue>): GrammarIssue => ({
  line: 1,
  bad: "",
  suggestion: "",
  category: "grammar",
  message: "",
  ...over,
});

describe("resolveGrammarRanges", () => {
  it("returns no ranges for no issues", () => {
    expect(resolveGrammarRanges("hello", [])).toEqual([]);
  });

  it("locates a misspelling on its reported line", () => {
    const text = "The quick brown fox\njumps over teh lazy dog";
    const ranges = resolveGrammarRanges(text, [
      issue({ line: 2, bad: "teh", suggestion: "the", category: "spelling" }),
    ]);
    expect(ranges).toHaveLength(1);
    const start = text.indexOf("teh");
    expect(ranges[0].start).toBe(start);
    expect(ranges[0].end).toBe(start + 3);
    expect(ranges[0].issue.category).toBe("spelling");
  });

  it("uses the line hint to disambiguate duplicate words", () => {
    // "is" appears on both lines; the issue on line 2 must map to the 2nd one.
    const text = "this is fine\nthis is wrong";
    const ranges = resolveGrammarRanges(text, [
      issue({ line: 2, bad: "is" }),
    ]);
    expect(ranges).toHaveLength(1);
    // Second "is" is after the newline.
    expect(ranges[0].start).toBeGreaterThan(text.indexOf("\n"));
  });

  it("maps two issues on the same line to distinct occurrences", () => {
    const text = "na na na";
    const ranges = resolveGrammarRanges(text, [
      issue({ line: 1, bad: "na" }),
      issue({ line: 1, bad: "na" }),
    ]);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].start).toBe(0);
    expect(ranges[1].start).toBe(3);
  });

  it("falls back to a whole-document search when the line drifted", () => {
    const text = "alpha\nbeta\ngamma";
    // Report "gamma" on a line that no longer holds it; it should still resolve.
    const ranges = resolveGrammarRanges(text, [issue({ line: 1, bad: "gamma" })]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(text.indexOf("gamma"));
  });

  it("skips an issue whose text is nowhere in the draft", () => {
    expect(resolveGrammarRanges("clean text", [issue({ bad: "zzz" })])).toEqual([]);
  });

  it("sorts by start and prunes overlapping ranges", () => {
    const text = "overlapping";
    const ranges = resolveGrammarRanges(text, [
      issue({ line: 1, bad: "lapp" }), // starts at 4
      issue({ line: 1, bad: "over" }), // starts at 0
      issue({ line: 1, bad: "verlap" }), // 1..7 overlaps "over" → dropped
    ]);
    const starts = ranges.map((r) => r.start);
    // Sorted ascending, no overlap with a prior range's end.
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBeGreaterThanOrEqual(ranges[i - 1].end);
    }
  });
});

describe("decorateGrammarRanges", () => {
  const r = (start: number, end: number, category: GrammarRange["issue"]["category"]): GrammarRange => ({
    start,
    end,
    issue: issue({ category, bad: "x" }),
  });

  it("returns plain escaped text when there are no ranges", () => {
    expect(decorateGrammarRanges("a<b", [])).toBe("a&lt;b");
  });

  it("wraps each range in a category-tagged mark span, escaping the rest", () => {
    // "ab cd" — mark "ab" (spelling) and "cd" (grammar).
    const html = decorateGrammarRanges("ab cd", [r(0, 2, "spelling"), r(3, 5, "grammar")]);
    expect(html).toBe(
      '<span class="file-viewer-grammar-mark cat-spelling" data-gi="0">ab</span>' +
        " " +
        '<span class="file-viewer-grammar-mark cat-grammar" data-gi="1">cd</span>',
    );
  });

  it("escapes HTML inside a marked run", () => {
    expect(decorateGrammarRanges("<x>", [r(0, 3, "style")])).toBe(
      '<span class="file-viewer-grammar-mark cat-style" data-gi="0">&lt;x&gt;</span>',
    );
  });
});
