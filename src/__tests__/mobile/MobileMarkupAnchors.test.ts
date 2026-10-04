/**
 * What each mark is on (`mobile-web/src/markup/anchors.ts`): the page's own
 * words under a stroke, a box or beside a note, read off its text runs and
 * sent with a Submit so the agent can go straight to them — and the sealed
 * frame's two Submit messages (`snapshot`, `text`) that feed it on the phone.
 */
import { describe, expect, it } from "vitest";

import { anchorsFor, MAX_ANCHOR_WORDS } from "../../../mobile-web/src/markup/anchors";
import type { TextRun } from "../../../mobile-web/src/markup/findText";
import { acceptFrameMessage, acceptToFrame, MAX_TEXT_RUNS } from "../../../mobile-web/src/markup/frameProtocol";
import type { InkMark, Mark, PageLayer } from "../../../mobile-web/src/markup/layer";

/** A run of `str` at `x`, `y` (its box's top), 6 points per character, 12 high. */
const run = (str: string, x: number, y: number, extra: Partial<TextRun> = {}): TextRun => ({ str, x, y, w: 6 * str.length, h: 12, ...extra });
const RUNS: TextRun[] = [
  run("The quick brown fox jumps", 72, 100),
  // A second column on the same baseline: never part of the line's context.
  run("right column", 400, 100),
  run("over the lazy dog.", 72, 120),
];
const stroke = (points: [number, number][]): InkMark => ({ kind: "ink", color: "red", width: 1.5, points: points.map(([x, y]) => [x, y, 0.5]) });
const page = (...marks: Mark[]): PageLayer => ({ size: [612, 792], marks });

describe("anchorsFor", () => {
  it("reads a stroke through words, with the line around them", () => {
    expect(anchorsFor(page(stroke([[98, 105], [160, 106]])), RUNS)).toEqual([
      { mark: 0, how: "through", words: "quick brown", line: "The quick brown fox jumps" },
    ]);
  });

  it("tells a line under the words from one through them", () => {
    expect(anchorsFor(page(stroke([[168, 110.5], [184, 110.5]])), RUNS)).toEqual([
      { mark: 0, how: "under", words: "fox", line: "The quick brown fox jumps" },
    ]);
  });

  it("reads a circle as around its words, not the line it grazes above", () => {
    const circle = stroke([[124, 117], [152, 117], [154, 126], [152, 135], [124, 135], [122, 126], [124, 117]]);
    expect(anchorsFor(page(circle), RUNS)).toEqual([{ mark: 0, how: "around", words: "lazy", line: "over the lazy dog." }]);
  });

  it("reads a caret between words as the two words beside it", () => {
    expect(anchorsFor(page(stroke([[122, 137], [124, 133], [126, 137]])), RUNS)).toEqual([
      { mark: 0, how: "at", words: "the lazy", line: "over the lazy dog." },
    ]);
  });

  it("puts a highlighter box on its words and a margin note beside its line", () => {
    const marks: Mark[] = [
      { kind: "box", color: "yellow", rect: [168, 100, 18, 12] },
      { kind: "text", color: "blue", at: [10, 98], size: 10, text: "cite\nSmith" },
    ];
    expect(anchorsFor(page(...marks), RUNS)).toEqual([
      { mark: 0, how: "on", words: "fox", line: "The quick brown fox jumps" },
      { mark: 1, how: "beside", words: "The quick brown fox jumps" },
    ]);
  });

  it("leaves out marks with no text near them, and pages with no text", () => {
    expect(anchorsFor(page(stroke([[300, 600], [320, 610]])), RUNS)).toEqual([]);
    expect(anchorsFor(page(stroke([[98, 105], [160, 106]])), [])).toEqual([]);
  });

  it("keeps the PDF's text to one bounded line", () => {
    const hostile = [run(`bad\u0007words\nhere ${"x".repeat(400)}`, 72, 100)];
    const [anchor] = anchorsFor(page({ kind: "box", color: "yellow", rect: [60, 98, 3000, 16] }), hostile);
    expect(anchor.words).not.toMatch(/[\u0000-\u001f]/);
    expect([...anchor.words].length).toBeLessThanOrEqual(MAX_ANCHOR_WORDS);
    expect(anchor.words.endsWith("…")).toBe(true);
  });
});

describe("the frame's Submit messages", () => {
  const holder = document.createElement("iframe");
  document.body.append(holder);
  const frame = holder.contentWindow!;
  const from = (data: unknown) => new MessageEvent("message", { data, origin: "null", source: frame });

  it("asks for a snapshot and a page's text in range only", () => {
    expect(acceptToFrame({ type: "snapshot", id: 1, n: 2, width: 1200 })).toEqual({ type: "snapshot", id: 1, n: 2, width: 1200 });
    expect(acceptToFrame({ type: "snapshot", id: 1, n: 0, width: 1200 })).toBeNull();
    expect(acceptToFrame({ type: "text", id: 3, page: 4 })).toEqual({ type: "text", id: 3, page: 4 });
    expect(acceptToFrame({ type: "text", id: -1, page: 4 })).toBeNull();
  });

  it("takes text runs of the right shape and size, and a snapshot that failed", () => {
    const runs = [{ str: "fox", x: 1, y: 2, w: 3, h: 4, eol: true }];
    expect(acceptFrameMessage(from({ type: "text", id: 1, page: 2, runs }), frame, 3)).toEqual({ type: "text", id: 1, page: 2, runs });
    expect(acceptFrameMessage(from({ type: "text", id: 1, page: 4, runs }), frame, 3)).toBeNull();
    expect(acceptFrameMessage(from({ type: "text", id: 1, page: 2, runs: [{ ...runs[0], str: 5 }] }), frame, 3)).toBeNull();
    expect(acceptFrameMessage(from({ type: "text", id: 1, page: 2, runs: [{ ...runs[0], x: Infinity }] }), frame, 3)).toBeNull();
    const many = Array.from({ length: MAX_TEXT_RUNS + 1 }, () => runs[0]);
    expect(acceptFrameMessage(from({ type: "text", id: 1, page: 2, runs: many }), frame, 3)).toBeNull();
    expect(acceptFrameMessage(from({ type: "snapshot", id: 7, n: 2 }), frame, 3)).toEqual({ type: "snapshot", id: 7, n: 2 });
    expect(acceptFrameMessage(from({ type: "snapshot", id: 7, n: 2, bitmap: "not one" }), frame, 3)).toBeNull();
  });
});
