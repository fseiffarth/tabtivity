import { describe, expect, it } from "vitest";
import { readPromptSuggestion } from "../../../mobile-web/src/terminal/promptSuggestion";
import { readableScreen, type ReadableBufferLike, type ReadableCellLike } from "../../../mobile-web/src/terminal/readableScreen";
import { NO_LIVE, readReaderLive, sameReaderLive } from "../../lib/agents/readerLive";

/** A row, or a row whose cells from `dimFrom` on are dim (xterm's `isDim`). */
type Row = string | [text: string, dimFrom: number];

function cell(char: string, dim: boolean): ReadableCellLike {
  return {
    getChars: () => char, getWidth: () => 1, isBold: () => 0, isItalic: () => 0, isDim: () => (dim ? 1 : 0),
    isUnderline: () => 0, isStrikethrough: () => 0, isInverse: () => 0, isInvisible: () => 0,
    isFgDefault: () => true, isBgDefault: () => true, isFgPalette: () => false, isBgPalette: () => false,
    isFgRGB: () => false, isBgRGB: () => false, getFgColor: () => 0, getBgColor: () => 0,
  };
}

function buffer(rows: Row[]): ReadableBufferLike {
  return {
    length: rows.length,
    getLine(row) {
      const source = rows[row];
      if (source === undefined) return undefined;
      const [text, dimFrom] = typeof source === "string" ? [source, Infinity] : source;
      const chars = [...text];
      return {
        length: chars.length,
        translateToString: () => text,
        getCell: (x) => (x < chars.length ? cell(chars[x], x >= dimFrom) : undefined),
      };
    },
  };
}

const RULE = "─".repeat(100);
/** The bottom of a Claude Code 2.1.310 screen after a turn, probed live: the
 * suggestion is dim from the first character after the `❯ `. */
const idle = (box: Row[]): Row[] => [
  "● Done. hello.py prints hello.",
  "",
  "✻ Cooked for 9s",
  "",
  RULE,
  ...box,
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

const read = (rows: Row[], label = "claude") => readPromptSuggestion(readableScreen(buffer(rows), 300).lines, label);

describe("Claude's prompt suggestion", () => {
  it("reads the dim text after the box's marker", () => {
    expect(read(idle([["❯ make it ask for my name", 2]]))).toBe("make it ask for my name");
  });

  it("joins a long suggestion wrapped onto indented dim rows", () => {
    const rows = idle([["❯ make it ask for my name and greet", 2], ["  them by it, then add a test", 2]]);
    expect(read(rows)).toBe("make it ask for my name and greet them by it, then add a test");
  });

  it("is not a typed draft (not dim)", () => {
    expect(read(idle(["❯ make it ask for my name"]))).toBe("");
  });

  it("is not a draft that is only partly dim", () => {
    // Typed words ahead of a dim run: the row holds the user's own text.
    expect(read(idle([["❯ typed make it", 8]]))).toBe("");
    // A non-dim row under a dim one is not part of the suggestion.
    expect(read(idle([["❯ make it ask for my name", 2], "  and typed"]))).toBe("make it ask for my name");
  });

  it("is not the empty box's own hints", () => {
    expect(read(idle([['❯ Try "fix lint errors"', 2]]))).toBe("");
    expect(read(idle([["❯ Press up to edit queued messages", 2]]))).toBe("");
  });

  it("is none for an empty box and for other CLIs", () => {
    expect(read(idle(["❯ "]))).toBe("");
    expect(read(idle([["❯ make it ask for my name", 2]]), "codex")).toBe("");
  });

  it("rides the live reading, and a change redraws", () => {
    const live = readReaderLive(buffer(idle([["❯ make it ask for my name", 2]])), "claude");
    expect(live.suggestion).toBe("make it ask for my name");
    expect(sameReaderLive(live, NO_LIVE)).toBe(false);
    expect(sameReaderLive(live, { ...live })).toBe(true);
    expect(readReaderLive(buffer(idle(["❯ "])), "claude").suggestion).toBe("");
  });
});
