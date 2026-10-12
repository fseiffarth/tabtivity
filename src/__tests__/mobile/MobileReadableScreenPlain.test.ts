/**
 * `readableScreen`'s caller-selected plain path (performance plan §3.2): a
 * reader that only wants the words — the status line, a Codex `/status` card,
 * the mode marks — skips the per-cell style walk, whatever the buffer offers.
 */
import { describe, expect, it, vi } from "vitest";
import {
  readableRange,
  readableScreen,
  type ReadableBufferLike,
  type ReadableCellLike,
} from "../../../mobile-web/src/terminal/readableScreen";

/** A styled buffer whose every `getCell` call is counted. */
function countingBuffer(rows: string[]) {
  const getCell = vi.fn((_x: number): ReadableCellLike => ({
    getChars: () => "x",
    getWidth: () => 1,
    isBold: () => 1,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isStrikethrough: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isFgDefault: () => false,
    isBgDefault: () => true,
    isFgPalette: () => true,
    isBgPalette: () => false,
    isFgRGB: () => false,
    isBgRGB: () => false,
    getFgColor: () => 2,
    getBgColor: () => 0,
  }));
  const buffer: ReadableBufferLike = {
    length: rows.length,
    getLine(row) {
      const text = rows[row];
      if (text === undefined) return undefined;
      return { length: text.length, translateToString: () => text, getCell };
    },
  };
  return { buffer, getCell };
}

describe("readableScreen — plain path", () => {
  it("reads the words without touching a cell when asked to", () => {
    const { buffer, getCell } = countingBuffer(["Opus 4.1 · 42% context", "› "]);
    const { lines } = readableScreen(buffer, 100, { plain: true });
    expect(lines.map((line) => line.text)).toEqual(["Opus 4.1 · 42% context", "›"]);
    expect(lines[0].spans).toEqual([{ text: "Opus 4.1 · 42% context" }]);
    expect(getCell).not.toHaveBeenCalled();
  });

  it("keeps the styled walk by default", () => {
    const { buffer, getCell } = countingBuffer(["abc"]);
    const { lines } = readableScreen(buffer);
    expect(getCell).toHaveBeenCalled();
    expect(lines[0].spans[0].className).toBe("b");
  });

  it("offers the same choice on a range", () => {
    const { buffer, getCell } = countingBuffer(["one", "two", "three"]);
    const lines = readableRange(buffer, 1, 3, undefined, { plain: true });
    expect(lines.map((line) => line.text)).toEqual(["two", "three"]);
    expect(getCell).not.toHaveBeenCalled();
  });

  it("still drops the sparkle cells on the plain path", () => {
    const { buffer } = countingBuffer(["›⠁Ask Codex"]);
    const { lines } = readableScreen(buffer, 100, { plain: true });
    expect(lines[0].text).toBe("› Ask Codex");
  });
});
