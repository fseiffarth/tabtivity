import { describe, expect, it } from "vitest";
import { readAntigravitySteps, sameAntigravitySteps } from "../../../mobile-web/src/terminal/antigravity";
import { readableScreen, type ReadableBufferLike, type ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

/**
 * The step checklist `agy` 1.5.16 draws above its input box while a turn
 * runs (the model's `update_steps` tool). The rows of the first screen are a
 * real capture at 100x32 (held mid-turn by a stub model, ANSI stripped); the
 * others are the shapes the release notes describe, built from it.
 */

const RULE = "─".repeat(100);
const FOOTER = "esc to cancel                                                                   Gemini 3.1 Pro · low";

const CAPTURED = [
  "      ▄▀▀▄        Antigravity CLI 1.5.16",
  "                  ~/work",
  RULE,
  "> hello",
  "",
  "  stub answer done",
  "",
  RULE,
  `> STUB:HOLD 8 STUB:CALL update_steps {"steps": [{"title": "Read the config", "status": "done"},`,
  `  {"title": "Patch the reader", "status": "in_progress"}, {"title": "Run the tests", "status":`,
  `  "pending"}]}`,
  "⣟  1/3 steps · Generating...",
  "  ⎿  ✓ Read the config",
  "     ● Patch the reader",
  "     ○ Run the tests",
  RULE,
  ">",
  RULE,
  FOOTER,
];

let seq = 0;
const lines = (...texts: string[]): ReadableLine[] =>
  texts.map((text) => ({ key: `l${seq += 1}`, text, spans: text ? [{ text }] : [] }));

/** Through the app's own `readableScreen`, as the cockpit reads a terminal. */
function screenOf(rows: string[]): ReadableLine[] {
  const buffer: ReadableBufferLike = {
    length: rows.length,
    getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }),
  };
  return readableScreen(buffer).lines;
}

const BOX = [RULE, ">", RULE, FOOTER];

describe(`${BRAND.display} Antigravity step checklist, 1.5.16`, () => {
  it("reads the captured checklist", () => {
    const expected = {
      done: 1,
      total: 3,
      steps: [
        { title: "Read the config", status: "done" },
        { title: "Patch the reader", status: "in_progress" },
        { title: "Run the tests", status: "pending" },
      ],
    };
    expect(readAntigravitySteps(lines(...CAPTURED))).toEqual(expected);
    expect(readAntigravitySteps(screenOf(CAPTURED))).toEqual(expected);
  });

  it("does not care which spinner glyph or activity the line carries", () => {
    for (const head of ["⡿  1/3 steps · Thinking... 12s", "⢿  1/3 steps · Running command... 18s", "   1/3 steps"]) {
      const rows = CAPTURED.map((row) => (row.includes("1/3 steps") ? head : row));
      expect(readAntigravitySteps(lines(...rows))?.steps).toHaveLength(3);
    }
  });

  it("reads nothing when the turn is over", () => {
    const after = [...CAPTURED.slice(0, 8), "", ...BOX.slice(0, 3), "? for shortcuts                                                                 Gemini 3.1 Pro · low"];
    expect(readAntigravitySteps(lines(...after))).toBeNull();
    expect(readAntigravitySteps(lines())).toBeNull();
  });

  it("reads nothing from the same words in the answer above the box", () => {
    expect(readAntigravitySteps(lines(
      "  I finished 3/3 steps of the plan.",
      "  1/3 steps are left, I will continue.",
      "", ...BOX,
    ))).toBeNull();
    // A status-looking line that is not followed by the input box is not the frame's.
    expect(readAntigravitySteps(lines(
      "⣟  1/3 steps · Generating...",
      "  ⎿  ✓ Read the config",
      "  and then some prose the model wrote",
      "More prose.",
      ...BOX,
    ))).toBeNull();
  });

  it("reads the skipped and failed counts the status line adds", () => {
    const read = readAntigravitySteps(lines(
      "⣟  2/6 steps · 1 skipped · 1 failed · Generating...",
      "  ⎿  ✓ One",
      "     ✓ Two",
      "     ○ Three",
      ...BOX,
    ));
    expect(read).toMatchObject({ done: 2, total: 6, skipped: 1, failed: 1 });
  });

  it("reports a glyph it has not seen as unknown, never as a known state", () => {
    const read = readAntigravitySteps(lines(
      "⣟  1/4 steps · Generating...",
      "  ⎿  ✓ One",
      "     ⊘ Two",
      "     ✗ Three",
      "     ◆ Four",
      ...BOX,
    ));
    expect(read?.steps.map((step) => step.status)).toEqual(["done", "skipped", "failed", "unknown"]);
  });

  it("reads the cut markers of a longer list", () => {
    const read = readAntigravitySteps(lines(
      "⣟  6/12 steps · Generating...",
      "  ⎿  ⋮ 3 earlier",
      "     ✓ Four",
      "     ✓ Five",
      "     ✓ Six",
      "     ● Seven",
      "     ○ Eight",
      "     ○ Nine",
      "     ○ Ten",
      "     ⋮ 2 more",
      ...BOX,
    ));
    expect(read).toMatchObject({ done: 6, total: 12, moreBefore: 3, moreAfter: 2 });
    expect(read?.steps).toHaveLength(7);
    expect(read?.steps[3]).toEqual({ title: "Seven", status: "in_progress" });
  });

  it("reads a finished list the box has not yet cleared", () => {
    const read = readAntigravitySteps(lines(
      "⣟  2/2 steps · Generating...",
      "  ⎿  ✓ One",
      "     ✓ Two",
      ...BOX,
    ));
    expect(read).toMatchObject({ done: 2, total: 2 });
  });

  it("joins a wrapped title back into one", () => {
    const read = readAntigravitySteps(lines(
      "⣟  0/2 steps · Generating...",
      "  ⎿  ● Update the reader so that a very long",
      "       title wraps onto a second row",
      "     ○ Run the tests",
      ...BOX,
    ));
    expect(read?.steps).toEqual([
      { title: "Update the reader so that a very long title wraps onto a second row", status: "in_progress" },
      { title: "Run the tests", status: "pending" },
    ]);
  });

  it("rejects an impossible count", () => {
    expect(readAntigravitySteps(lines("⣟  5/3 steps · Generating...", "  ⎿  ✓ One", ...BOX))).toBeNull();
    expect(readAntigravitySteps(lines("⣟  1/2 steps · Generating...", "  ⎿  ✓ A", "     ✓ B", "     ✓ C", ...BOX))).toBeNull();
  });

  it("compares two readings by what they say", () => {
    const a = readAntigravitySteps(lines(...CAPTURED));
    const b = readAntigravitySteps(lines(...CAPTURED.map((row) => row.replace("Generating...", "Thinking... 12s"))));
    expect(sameAntigravitySteps(a, b)).toBe(true);
    const c = readAntigravitySteps(lines(...CAPTURED.map((row) => row.replace("● Patch", "✓ Patch").replace("1/3", "2/3"))));
    expect(sameAntigravitySteps(a, c)).toBe(false);
    expect(sameAntigravitySteps(null, null)).toBe(true);
    expect(sameAntigravitySteps(a, null)).toBe(false);
  });
});
