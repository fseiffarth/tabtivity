/**
 * Unit tests for the change-tint trail helpers: `diffRange`/`editSpan` (the
 * inserted/replaced run between two drafts), `remapChangeRange` (re-mapping an
 * older run through a fresh edit), and `decorateChangeRanges` (the transparent
 * overlay that tints those runs, sequenced new→old by tier). Mirrors the
 * search-decoration tests.
 */
import { describe, it, expect } from "vitest";
import {
  diffRange,
  editSpan,
  remapChangeRange,
  decorateChangeRanges,
} from "../../components/embed/fileViewer/decorations";

describe("diffRange", () => {
  it("returns null when the text is unchanged", () => {
    expect(diffRange("hello", "hello")).toBeNull();
  });

  it("locates a single inserted run (in `next` coordinates)", () => {
    // "ab|cd" → typed "XY" → "abXYcd"
    expect(diffRange("abcd", "abXYcd")).toEqual({ start: 2, end: 4 });
  });

  it("locates an append at the end of the file", () => {
    expect(diffRange("foo", "foobar")).toEqual({ start: 3, end: 6 });
  });

  it("locates an insert at the very start", () => {
    expect(diffRange("bar", "foobar")).toEqual({ start: 0, end: 3 });
  });

  it("spans the replaced run when text is swapped", () => {
    // common prefix "a", common suffix "d"; middle "bc" → "XYZ"
    expect(diffRange("abcd", "aXYZd")).toEqual({ start: 1, end: 4 });
  });

  it("returns null for a pure deletion (zero-width in `next`)", () => {
    expect(diffRange("abXYcd", "abcd")).toBeNull();
  });

  it("handles repeated characters without drifting the suffix past the prefix", () => {
    // inserting one more "a" into "aaa": prefix/suffix both made of the same
    // char must still yield a single-char range, not a negative/overlapping one.
    const r = diffRange("aaa", "aaaa");
    expect(r).not.toBeNull();
    expect(r!.end - r!.start).toBe(1);
  });
});

describe("editSpan", () => {
  it("returns null for equal strings", () => {
    expect(editSpan("hi", "hi")).toBeNull();
  });

  it("reports the inserted run's prev/next ends (equal for a pure insert)", () => {
    // "ab|cd" → "abXYcd": replaces prev[2,2] with next[2,4]
    expect(editSpan("abcd", "abXYcd")).toEqual({ start: 2, endPrev: 2, endNext: 4 });
  });

  it("reports a pure deletion as a zero-width run in `next`", () => {
    // remove "XY" from "abXYcd": replaces prev[2,4] with next[2,2]
    expect(editSpan("abXYcd", "abcd")).toEqual({ start: 2, endPrev: 4, endNext: 2 });
  });

  it("reports a replacement spanning both prev and next runs", () => {
    expect(editSpan("abcd", "aXYZd")).toEqual({ start: 1, endPrev: 3, endNext: 4 });
  });
});

describe("remapChangeRange", () => {
  // An insert of "XY" at offset 2: prev[2,2] → next[2,4], delta +2.
  const insert = { start: 2, endPrev: 2, endNext: 4 };

  it("leaves a range entirely before the edit untouched", () => {
    expect(remapChangeRange({ start: 0, end: 2 }, insert)).toEqual({ start: 0, end: 2 });
  });

  it("shifts a range entirely after the edit by the length delta", () => {
    expect(remapChangeRange({ start: 2, end: 4 }, insert)).toEqual({ start: 4, end: 6 });
  });

  it("drops a range overlapping the edited region", () => {
    expect(remapChangeRange({ start: 1, end: 3 }, insert)).toBeNull();
  });

  it("shifts later ranges left through a deletion", () => {
    // remove "XY" from offset 2: prev[2,4] → next[2,2], delta -2.
    const del = { start: 2, endPrev: 4, endNext: 2 };
    expect(remapChangeRange({ start: 6, end: 8 }, del)).toEqual({ start: 4, end: 6 });
  });
});

describe("decorateChangeRanges", () => {
  it("wraps a single run in a tiered change-mark span, escaping the rest", () => {
    expect(decorateChangeRanges("a<b>c", [{ start: 1, end: 4, tier: 0 }])).toBe(
      'a<span class="file-viewer-change-mark tier-0">&lt;b&gt;</span>c',
    );
  });

  it("tints several runs in source order with their own tiers", () => {
    expect(
      decorateChangeRanges("abcde", [
        { start: 3, end: 4, tier: 0 },
        { start: 0, end: 1, tier: 1 },
      ]),
    ).toBe(
      '<span class="file-viewer-change-mark tier-1">a</span>bc' +
        '<span class="file-viewer-change-mark tier-0">d</span>e',
    );
  });

  it("escapes HTML inside a marked run too", () => {
    expect(decorateChangeRanges("x&y", [{ start: 1, end: 2, tier: 2 }])).toBe(
      'x<span class="file-viewer-change-mark tier-2">&amp;</span>y',
    );
  });

  it("clamps an out-of-range end to the source length", () => {
    expect(decorateChangeRanges("hi", [{ start: 0, end: 99, tier: 0 }])).toBe(
      '<span class="file-viewer-change-mark tier-0">hi</span>',
    );
  });

  it("emits plain escaped text when there are no usable ranges", () => {
    expect(decorateChangeRanges("a<b", [{ start: 2, end: 2, tier: 0 }])).toBe("a&lt;b");
  });
});

/**
 * A coupled `\begin{env}`/`\end{env}` rename changes the document in two places
 * at once. `editSpan` can only report ONE run, so read directly it returns
 * everything between the two — which is what the editor books its trail through,
 * hence the two-stage booking (typed run, then mirrored run) in `CodeEditor`'s
 * `edit`. These pin the reason down.
 */
describe("a two-place edit through editSpan", () => {
  const prev = "\\begin{item}\nbody\n\\end{item}";
  // What the user typed: "ize" into the \begin name only.
  const typed = "\\begin{itemize}\nbody\n\\end{item}";
  // What is committed: the mirrored rename on top of it.
  const next = "\\begin{itemize}\nbody\n\\end{itemize}";

  it("read in one step, swallows the whole environment body", () => {
    const span = editSpan(prev, next)!;
    // The run reaches from inside the \begin name to inside the \end name, so a
    // trail booked from it would tint the body as freshly typed.
    expect(prev.slice(span.start, span.endPrev)).toContain("body");
    expect(next.slice(span.start, span.endNext)).toContain("body");
  });

  it("read as its two stages, is two small runs", () => {
    const typedSpan = editSpan(prev, typed)!;
    expect(next.slice(typedSpan.start, typedSpan.endNext)).toBe("ize");
    // Neither stage removes anything — both are pure inserts.
    expect(prev.slice(typedSpan.start, typedSpan.endPrev)).toBe("");
    const mirrorSpan = editSpan(typed, next)!;
    expect(next.slice(mirrorSpan.start, mirrorSpan.endNext)).toBe("ize");
    expect(typed.slice(mirrorSpan.start, mirrorSpan.endPrev)).toBe("");
    // The typed run, remapped through the mirrored one, still points at the
    // \begin name — the mirrored insertion lands after it.
    const remapped = remapChangeRange(
      { start: typedSpan.start, end: typedSpan.endNext },
      mirrorSpan,
    )!;
    expect(remapped).toEqual({ start: typedSpan.start, end: typedSpan.endNext });
  });
});
