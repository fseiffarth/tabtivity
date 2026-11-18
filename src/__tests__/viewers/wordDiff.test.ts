import { describe, it, expect } from "vitest";
import type { DiffLine } from "../../lib/viewers/diff";
import {
  HUNK_CELL_BUDGET,
  MAX_LINE_CHARS,
  hunkWordMarks,
  splitByMarks,
  tokenize,
  wordMarks,
  type WordMark,
} from "../../lib/viewers/wordDiff";

/** The text each mark covers. */
const covered = (text: string, marks: readonly WordMark[]): string[] => marks.map((m) => text.slice(m.start, m.end));

const del = (text: string, oldNo = 1): DiffLine => ({ type: "del", text, oldNo, newNo: null });
const add = (text: string, newNo = 1): DiffLine => ({ type: "add", text, oldNo: null, newNo });
const ctx = (text: string): DiffLine => ({ type: "context", text, oldNo: 1, newNo: 1 });
const noNewline = (): DiffLine => ({ type: "nonewline", text: "\\ No newline at end of file", oldNo: null, newNo: null });

describe("tokenize", () => {
  it("splits words, whitespace runs and single punctuation characters", () => {
    expect(tokenize("foo(bar,  baz_1)")).toEqual(["foo", "(", "bar", ",", "  ", "baz_1", ")"]);
  });

  it("keeps unicode letters together and astral characters whole", () => {
    expect(tokenize("café 😀!")).toEqual(["café", " ", "😀", "!"]);
  });

  it("round-trips: the tokens re-join to the text", () => {
    const text = "  const x = a.b[0] ?? 'it\\'s';\t// ünï";
    expect(tokenize(text).join("")).toBe(text);
  });

  it("is empty for an empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("wordMarks", () => {
  it("marks the one word that changed on both sides", () => {
    const a = "const total = price * count;";
    const b = "const total = cost * count;";
    const marks = wordMarks(a, b)!;
    expect(covered(a, marks.old)).toEqual(["price"]);
    expect(covered(b, marks.new)).toEqual(["cost"]);
  });

  it("marks an insertion only on the new side", () => {
    const a = "call(x)";
    const b = "call(x, y)";
    const marks = wordMarks(a, b)!;
    expect(marks.old).toEqual([]);
    expect(covered(b, marks.new)).toEqual([", y"]);
  });

  it("marks a deletion only on the old side", () => {
    const a = "call(x, y)";
    const b = "call(x)";
    const marks = wordMarks(a, b)!;
    expect(covered(a, marks.old)).toEqual([", y"]);
    expect(marks.new).toEqual([]);
  });

  it("joins changed words across a single blank into one mark", () => {
    const a = "return alpha beta end";
    const b = "return gamma delta end";
    const marks = wordMarks(a, b)!;
    expect(covered(a, marks.old)).toEqual(["alpha beta"]);
    expect(covered(b, marks.new)).toEqual(["gamma delta"]);
  });

  it("keeps separate marks apart when unchanged words lie between", () => {
    const a = "one two three four five";
    const b = "ONE two three four FIVE";
    const marks = wordMarks(a, b)!;
    expect(covered(a, marks.old)).toEqual(["one", "five"]);
    expect(covered(b, marks.new)).toEqual(["ONE", "FIVE"]);
  });

  it("marks a whitespace-only change", () => {
    const marks = wordMarks("a = 1", "a  =  1")!;
    expect(marks).not.toBeNull();
    expect(marks.new.length).toBeGreaterThan(0);
  });

  it("marks changed indentation without calling the line a rewrite", () => {
    const a = "    return value;";
    const b = "        return value;";
    const marks = wordMarks(a, b)!;
    expect(marks.old.length + marks.new.length).toBeGreaterThan(0);
    expect(covered(b, marks.new)).toEqual([" ".repeat(8)]);
  });

  it("gives up on identical text", () => {
    expect(wordMarks("same", "same")).toBeNull();
  });

  it("gives up on lines that share almost nothing", () => {
    expect(wordMarks("alpha beta gamma", "zzz yyy xxx")).toBeNull();
  });

  it("gives up on a one-word rewrite", () => {
    expect(wordMarks("  foo", "  bar")).toBeNull();
  });

  it("gives up on very long lines instead of stalling", () => {
    const long = "x ".repeat(MAX_LINE_CHARS);
    expect(wordMarks(long, long + "y")).toBeNull();
  });

  it("gives up when too many tokens differ in the middle", () => {
    const a = "a ".repeat(900);
    const b = "b ".repeat(900);
    expect(a.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(wordMarks(a, b)).toBeNull();
  });

  it("marks inside a long line when only a small stretch differs", () => {
    const head = "word ".repeat(300);
    const marks = wordMarks(`${head}old end`, `${head}new end`)!;
    expect(covered(`${head}old end`, marks.old)).toEqual(["old"]);
  });

  it("keeps offsets in UTF-16 units, so slicing the text lines up", () => {
    const a = "😀 name = 'x'";
    const b = "😀 name = 'yy'";
    const marks = wordMarks(a, b)!;
    expect(covered(a, marks.old)).toEqual(["x"]);
    expect(covered(b, marks.new)).toEqual(["yy"]);
  });

  it("returns marks that never overlap and stay in order", () => {
    const a = "a b c d e f g h i j k l m n o p";
    const b = "a B c D e F g H i J k L m N o P";
    const marks = wordMarks(a, b)!;
    for (const side of [marks.old, marks.new]) {
      for (let i = 1; i < side.length; i++) expect(side[i].start).toBeGreaterThanOrEqual(side[i - 1].end);
    }
  });
});

describe("hunkWordMarks", () => {
  it("pairs a del run with the following add run, line by line", () => {
    const d1 = del("let a = 1;");
    const d2 = del("let b = 2;");
    const a1 = add("let a = 10;");
    const a2 = add("let b = 20;");
    const marks = hunkWordMarks([ctx("top"), d1, d2, a1, a2, ctx("bottom")]);
    expect(covered(d1.text, marks.get(d1)!)).toEqual(["1"]);
    expect(covered(a1.text, marks.get(a1)!)).toEqual(["10"]);
    expect(covered(d2.text, marks.get(d2)!)).toEqual(["2"]);
    expect(covered(a2.text, marks.get(a2)!)).toEqual(["20"]);
    expect(marks.size).toBe(4);
  });

  it("pairs only as many lines as both runs have", () => {
    const d1 = del("x = 1;");
    const a1 = add("x = 2;");
    const a2 = add("brand new line");
    const marks = hunkWordMarks([d1, a1, a2]);
    expect(marks.has(d1)).toBe(true);
    expect(marks.has(a2)).toBe(false);
  });

  it("marks nothing for a pure addition or a pure deletion", () => {
    expect(hunkWordMarks([ctx("a"), add("b"), ctx("c")]).size).toBe(0);
    expect(hunkWordMarks([ctx("a"), del("b"), ctx("c")]).size).toBe(0);
  });

  it("does not pair across context", () => {
    const d = del("value = 1");
    const a = add("value = 2");
    expect(hunkWordMarks([d, ctx("between"), a]).size).toBe(0);
  });

  it("does not pair an add run that comes before the del run", () => {
    expect(hunkWordMarks([add("value = 2"), del("value = 1")]).size).toBe(0);
  });

  it("looks through a `\\ No newline` marker between the runs", () => {
    const d = del("end = 1");
    const a = add("end = 2");
    const marks = hunkWordMarks([d, noNewline(), a, noNewline()]);
    expect(marks.has(d) && marks.has(a)).toBe(true);
  });

  it("leaves rewritten lines to the whole-line tint", () => {
    const d = del("completely different words here");
    const a = add("1 2 3 4 5 6 7 8 9");
    expect(hunkWordMarks([d, a]).size).toBe(0);
  });

  it("stops once the hunk's work budget is spent", () => {
    // Each pair costs about (tokens+1)^2 cells; many wide pairs exhaust it.
    const wide = (tag: string): string => Array.from({ length: 300 }, (_, i) => (i % 2 ? `${tag}${i}` : `w${i}`)).join(" ");
    const lines: DiffLine[] = [];
    const pairs = 40;
    for (let i = 0; i < pairs; i++) lines.push(del(wide("o"), i), add(wide("n"), i));
    const marks = hunkWordMarks(lines);
    expect(marks.size).toBeGreaterThan(0);
    expect(marks.size).toBeLessThan(pairs * 2);
    expect(HUNK_CELL_BUDGET).toBeLessThan(pairs * 300 * 300 * 4);
  });
});

describe("splitByMarks", () => {
  it("cuts the text at mark boundaries and loses nothing", () => {
    const segments = splitByMarks("hello brave world", [
      { start: 6, end: 11 },
    ]);
    expect(segments).toEqual([
      { text: "hello ", marked: false },
      { text: "brave", marked: true },
      { text: " world", marked: false },
    ]);
  });

  it("returns one plain segment without marks", () => {
    expect(splitByMarks("abc", undefined)).toEqual([{ text: "abc", marked: false }]);
    expect(splitByMarks("abc", [])).toEqual([{ text: "abc", marked: false }]);
    expect(splitByMarks("", [])).toEqual([{ text: "", marked: false }]);
  });

  it("handles marks at the very start and end", () => {
    const segments = splitByMarks("abcd", [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe("abcd");
    expect(segments.filter((s) => s.marked).map((s) => s.text)).toEqual(["a", "d"]);
  });

  it("clamps out-of-range and ignores empty or overlapping marks", () => {
    const segments = splitByMarks("abcdef", [
      { start: 2, end: 2 },
      { start: 1, end: 4 },
      { start: 3, end: 5 },
      { start: 5, end: 99 },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe("abcdef");
    expect(segments.filter((s) => s.marked).map((s) => s.text)).toEqual(["bcd", "e", "f"]);
  });

  it("round-trips real marks", () => {
    const a = "if (user.isAdmin && flag) {";
    const b = "if (user.isOwner && flag) {";
    const marks = wordMarks(a, b)!;
    expect(splitByMarks(a, marks.old).map((s) => s.text).join("")).toBe(a);
    expect(splitByMarks(b, marks.new).filter((s) => s.marked).map((s) => s.text)).toEqual(["isOwner"]);
  });
});
