import { describe, expect, it } from "vitest";
import { isCursorTab, readCursorPicker } from "../../../mobile-web/src/terminal/cursorAgent";
import { mergeSelectRows, readSelectPrompt, revealSelectRow } from "../../../mobile-web/src/terminal/selectPrompt";
import { BRAND } from "../../lib/brand";

const lines = (...texts: string[]) => texts.map((text) => ({ text }));

/** The screens below are what `cursor-agent` 2026.09.26 paints for `/model`,
 * captured from a live session and read through `readableScreen`. */
const ABOVE = [
  "  Cursor Agent",
  "  v2026.09.26-dd393fe",
  "",
  "  → Plan, search, build anything",
  "",
];
const FOOTER = ["", " Type to filter • Enter to select • Tab to edit"];

/** 60 columns, the highlight walked down to the thirteenth of 39 rows. */
const WALKED = lines(
  ...ABOVE,
  " Available models                             Max mode: OFF",
  "",
  " Filter:",
  "",
  "    Composer 2.5             Fast",
  "    Claude Opus 5.5          300K Medium",
  "    Claude Opus 5            300K High",
  "    Claude Opus 4.8          300K High",
  "    GPT-5.6 Sol              272K Medium",
  "    GPT-5.5                  272K Medium",
  "    Claude Fable 5.1         300K High",
  "    Claude Fable 5           300K High",
  "    Grok 4.5                 High Fast",
  " →  Gemini 3.8 Flash         High (Tab to modify)",
  "",
  " 4-13 of 39",
  ...FOOTER,
);

/** 36 columns: notes wrap onto rows of their own, the indent drifts, the
 * highlighted row's hint is interleaved with its note, and a blank row sits
 * inside the list. */
const NARROW = lines(
  ...ABOVE,
  " Available models     Max mode: OFF",
  "",
  " Filter:",
  "",
  "    Auto",
  "   Grok 4.7                 256K",
  "                            High",
  "                            Fast",
  " → Grok 4.6                Hig(Tab",
  "                           h Fto mo",
  "                           astdify)",
  "",
  "    Composer 2.5             Fast",
  "   Claude Opus 5.5          300K",
  "                            Medium",
  "   Claude Opus 5            300K",
  "                            High",
  "   Claude Opus 4.8          300K",
  "                            High",
  "   GPT-5.6 Sol              272K",
  "                            Medium",
  "   GPT-5.5                  272K",
  "                            Medium",
  "   Claude Fable 5.1         300K",
  "                            High",
  "",
  " 1-10 of 39",
  "",
  " Type to filter • Enter to select •",
  " Tab to edit",
);

describe(`${BRAND.display} Mobile — Cursor agent's model dialog`, () => {
  it("names the Cursor tab by its registry label", () => {
    expect(isCursorTab("Cursor")).toBe(true);
    expect(isCursorTab("Claude")).toBe(false);
    expect(isCursorTab(undefined)).toBe(false);
  });

  it("numbers the unnumbered rows by their place in the whole list", () => {
    // The numbered-dialog reader sees nothing here: that was the bug.
    expect(readSelectPrompt(WALKED, "Cursor")).toBeNull();
    const picker = readCursorPicker(WALKED)!;
    expect(picker.title).toBe("Available models");
    expect(picker.options.map((option) => `${option.number} ${option.label}`)).toEqual([
      "4 Composer 2.5",
      "5 Claude Opus 5.5",
      "6 Claude Opus 5",
      "7 Claude Opus 4.8",
      "8 GPT-5.6 Sol",
      "9 GPT-5.5",
      "10 Claude Fable 5.1",
      "11 Claude Fable 5",
      "12 Grok 4.5",
      "13 Gemini 3.8 Flash",
    ]);
    expect(picker.current).toBe(9);
    expect(picker.hidden).toBe(29);
    // The Tab hint is the dialog's, not the model's.
    expect(picker.options[9].description).toBe("High");
    expect(picker.options[1].description).toBe("300K Medium");
    expect(picker.question).toBe(picker.context);
    expect(WALKED[picker.question].text).toContain("Available models");
  });

  it("reads a phone-width dialog, dropping a note it cannot read cleanly", () => {
    const picker = readCursorPicker(NARROW)!;
    expect(picker.options.map((option) => option.label)).toEqual([
      "Auto", "Grok 4.7", "Grok 4.6", "Composer 2.5", "Claude Opus 5.5",
      "Claude Opus 5", "Claude Opus 4.8", "GPT-5.6 Sol", "GPT-5.5", "Claude Fable 5.1",
    ]);
    expect(picker.options[0].number).toBe(1);
    expect(picker.current).toBe(2);
    expect(picker.options[0].description).toBeUndefined();
    expect(picker.options[1].description).toBe("256K High Fast");
    expect(picker.options[2].description).toBeUndefined();
  });

  it("recognizes nothing that is not a whole dialog", () => {
    // Closed: the session is back at its input box.
    expect(readCursorPicker(lines(...ABOVE, "  Grok 4.6 High Fast", "  ~/project"))).toBeNull();
    // A heading somebody printed, with no filter field under it.
    expect(readCursorPicker(lines("Available models", "", "  Auto", "→ Grok 4.7"))).toBeNull();
    // Mid-repaint: the window note counts rows the frame does not hold.
    const torn = WALKED.filter((line) => !line.text.includes("Claude Opus 5 "));
    expect(readCursorPicker(torn)).toBeNull();
    // No highlight.
    expect(readCursorPicker(WALKED.map((line) => ({ text: line.text.replace(" →  ", "    ") })))).toBeNull();
  });

  it("names the rows it cannot see yet by walking to the farthest of them in one run", () => {
    const dialog = (from: number, marked: number, labels: string[]) => lines(
      " Available models",
      "",
      " Filter:",
      "",
      ...labels.map((label, at) => `${from + at === marked ? " →  " : "    "}${label}`),
      "",
      ` ${from}-${from + labels.length - 1} of 12`,
    );
    const MODELS = ["Auto", "Grok 4.7", "Grok 4.6", "Composer 2.5", "Claude Opus 5.5", "Claude Opus 5",
      "Claude Opus 4.8", "GPT-5.6 Sol", "GPT-5.5", "Claude Fable 5.1", "Claude Fable 5", "Grok 4.5"];
    const top = readCursorPicker(dialog(1, 3, MODELS.slice(0, 6)))!;
    let step = mergeSelectRows(null, top);
    expect(revealSelectRow(step, top)).toBe(12);
    // A frame skipped rows 7–9 on the way: the walk goes back for them.
    const bottom = readCursorPicker(dialog(10, 12, MODELS.slice(9)))!;
    // Sharing no row with what is known, it is the same list only mid-walk.
    expect(mergeSelectRows(step, bottom).options).toHaveLength(3);
    step = mergeSelectRows(step, bottom, true);
    expect(step.options).toHaveLength(9);
    expect(revealSelectRow(step, bottom)).toBe(7);
    const back = readCursorPicker(dialog(7, 7, MODELS.slice(6, 12)))!;
    step = mergeSelectRows(step, back, true);
    expect(step.options.map((option) => option.label)).toEqual(MODELS);
    expect(revealSelectRow(step, back)).toBeUndefined();
  });
});

describe(`${BRAND.display} Mobile — revealing a windowed dialog`, () => {
  const prompt = (numbers: number[], current: number, hidden: number) => ({
    options: numbers.map((number, index) => ({ index, number, label: `Row ${number}` })),
    current,
    hidden,
    start: 0,
    question: 0,
    context: 0,
  });

  it("walks to the farthest unseen row, above the window first", () => {
    // Opened on the last page: straight up to the first row.
    const last = prompt([30, 31, 32, 33, 34, 35, 36, 37, 38, 39], 9, 29);
    expect(revealSelectRow(mergeSelectRows(null, last), last)).toBe(1);
    // A windowed Claude Code picker, three rows of five: straight to the last
    // row, not a row per round trip.
    const claude = prompt([1, 2, 3], 0, 2);
    expect(revealSelectRow(mergeSelectRows(null, claude), claude)).toBe(5);
  });

  it("has nothing to reveal once every row is known", () => {
    const window = prompt([1, 2, 3], 0, 0);
    expect(revealSelectRow(mergeSelectRows(null, window), window)).toBeUndefined();
  });
});
