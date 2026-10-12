import { describe, expect, it } from "vitest";
import { inputFrameStart, sessionStatus, statusFrameLines } from "../../../mobile-web/src/terminal/statusLine";
import {
  antigravityEffortKeys,
  antigravityFooter,
  isAntigravityTab,
  readAntigravityEffort,
  readAntigravityPicker,
} from "../../../mobile-web/src/terminal/antigravity";
import {
  readableScreen,
  type ReadableBufferLike,
  type ReadableLine,
} from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

/**
 * Google Antigravity as the phone reads it. Every screen below is a real one:
 * the rows come from captures of an `agy` 1.2.7 session driven through a pty
 * at 80×24 and replayed through the phone's own emulator, after
 * `readableScreen` — so the box's rules are gone, trailing padding with them.
 */

let seq = 0;
const line = (text: string): ReadableLine => ({
  key: `l${seq += 1}`,
  text,
  spans: text ? [{ text }] : [],
});
const lines = (...texts: string[]) => texts.map((text) => line(text));

const LABEL = "Google Antigravity";

/** The bottom of an idle frame: the input box, then the one row Antigravity
 * keeps under it. */
const IDLE = [
  ">",
  "? for shortcuts                                          Gemini 3.8 Flash · high",
];

/** `/model`, with a Gemini model highlighted: the dialog is drawn *under* the
 * box, its rows carry no numbers, its highlight is the box's own `>`, and the
 * slider under them belongs to the highlighted row. Seven models exist and six
 * are drawn — the slider takes the seventh row's place. */
const PICKER = [
  ">",
  "Switch Model",
  "",
  "  Search:",
  "",
  "  Gemini 3.8 Flash",
  "  Gemini 3.7 Flash",
  "> Gemini 3.6 Flash             (current)",
  "  Gemini 3.1 Pro",
  "  Claude Sonnet 4.6 (Thinking)",
  "  Claude Opus 4.6 (Thinking)",
  "",
  "  Effort  ◂        ●━━━━━━━━━━━━━━◉──────────────○        ▸",
  "                  low          medium          high",
  "            Balanced speed and reasoning quality for most tasks",
  "  [1-6 of 7 items]",
  "",
  "Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back",
  "",
  "                                                       Gemini 3.6 Flash · medium",
];

/** The same dialog with a model that has no effort highlighted: the slider is
 * gone, and every row fits. */
const PICKER_NO_EFFORT = [
  ">",
  "Switch Model",
  "",
  "  Search:",
  "",
  "  Gemini 3.8 Flash",
  "  Gemini 3.7 Flash",
  "  Gemini 3.6 Flash             (current)",
  "  Gemini 3.1 Pro",
  "> Claude Sonnet 4.6 (Thinking)",
  "  Claude Opus 4.6 (Thinking)",
  "  GPT-OSS 120B (Medium)",
  "",
  "Keyboard: ↑/↓ Navigate  enter Select  esc Go Back",
  "",
  "                                                       Gemini 3.6 Flash · medium",
];

describe(`${BRAND.display} Mobile — Antigravity's model and effort`, () => {
  it("reads the model and the effort out of the footer's right-hand column", () => {
    expect(sessionStatus(lines("The tests pass.", "", ...IDLE), LABEL))
      .toEqual({ model: "Gemini 3.8 Flash", effort: "high" });
  });

  it("reads a model that has no effort as a model alone", () => {
    expect(sessionStatus(lines(
      ">",
      "? for shortcuts                                     Claude Sonnet 4.6 (Thinking)",
    ), LABEL)).toEqual({ model: "Claude Sonnet 4.6 (Thinking)" });
  });

  it("leaves another family's screen to the reader it belongs to", () => {
    // The same rows on a Gemini CLI tab: the phrase is not this family's.
    expect(sessionStatus(lines(...IDLE), "Google Gemini")).toEqual({ model: "Gemini" });
    expect(isAntigravityTab("Google Gemini")).toBe(false);
    expect(isAntigravityTab(undefined)).toBe(false);
  });

  it("reads no status out of a row whose columns are key hints", () => {
    expect(antigravityFooter("Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back")).toBeNull();
    expect(antigravityFooter("  ↑/↓ Navigate · enter Select · tab Complete")).toBeNull();
    // The banner's own rows: a path is not a model, and neither is an address.
    expect(antigravityFooter(`   ▄▀▀    ▀▀▄     ~/${BRAND.slug}/projects/project${BRAND.slug}`)).toBeNull();
    expect(antigravityFooter("     ▀▀▀▀▀▀       someone@example.com (Antigravity Starter Quota)")).toBeNull();
  });

  it("numbers the dialog's rows by their place in its whole list", () => {
    const picker = readAntigravityPicker(lines(...PICKER));
    expect(picker).toBeTruthy();
    expect(picker!.title).toBe("Switch Model");
    expect(picker!.options.map((option) => `${option.number}. ${option.label}`)).toEqual([
      "1. Gemini 3.8 Flash",
      "2. Gemini 3.7 Flash",
      "3. Gemini 3.6 Flash",
      "4. Gemini 3.1 Pro",
      "5. Claude Sonnet 4.6 (Thinking)",
      "6. Claude Opus 4.6 (Thinking)",
    ]);
    // The row the session is on is marked as the dialog marks it, and the
    // window note says one more model exists than is drawn.
    expect(picker!.options[2].description).toBe("(current)");
    expect(picker!.current).toBe(2);
    expect(picker!.hidden).toBe(1);
  });

  it("lists every row once the dialog draws the whole list", () => {
    const picker = readAntigravityPicker(lines(...PICKER_NO_EFFORT));
    expect(picker!.options.map((option) => option.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(picker!.options[6].label).toBe("GPT-OSS 120B (Medium)");
    expect(picker!.current).toBe(4);
    expect(picker!.hidden).toBeUndefined();
  });

  it("reads nothing where the heading is a line of output", () => {
    expect(readAntigravityPicker(lines(
      "Switch Model",
      "",
      "  Gemini 3.8 Flash",
      "> Gemini 3.7 Flash",
      ...IDLE,
    ))).toBeNull();
  });

  it("reads the slider's stops, and which one it sits on", () => {
    expect(readAntigravityEffort(lines(...PICKER))).toEqual({
      current: 1,
      stops: [
        { label: "low" },
        { label: "medium", description: "Balanced speed and reasoning quality for most tasks" },
        { label: "high" },
      ],
    });
    // Gemini 3.1 Pro offers two stops, not three.
    expect(readAntigravityEffort(lines(
      "  Effort  ◂            ◉──────────────────────○            ▸",
      "                      low                   high",
      "            Faster responses, lighter reasoning — great for simpler tasks",
      "  [1-6 of 7 items]",
    ))).toEqual({
      current: 0,
      stops: [
        { label: "low", description: "Faster responses, lighter reasoning — great for simpler tasks" },
        { label: "high" },
      ],
    });
    // A model with no slider: the dialog draws none, and none is invented.
    expect(readAntigravityEffort(lines(...PICKER_NO_EFFORT))).toBeNull();
  });

  it("moves the slider with the arrows the dialog's own keyboard row names", () => {
    expect(antigravityEffortKeys(1, 2)).toEqual(["\u001b[C"]);
    expect(antigravityEffortKeys(2, 0)).toEqual(["\u001b[D", "\u001b[D"]);
    expect(antigravityEffortKeys(1, 1)).toEqual([]);
  });

  it("cuts the reading view at the box the dialog is drawn under", () => {
    const screen = lines("The tests pass.", "", ...PICKER);
    // Not at the `>` of a model row, and not below the dialog either: the
    // whole of it is the frame the model sheet is showing.
    expect(inputFrameStart(screen, LABEL)).toBe(1);
    expect(statusFrameLines(screen, LABEL))
      .toEqual(["                                                       Gemini 3.6 Flash · medium"]);
    // The status the chips read is the session's, not the highlighted row's.
    expect(sessionStatus(screen, LABEL)).toEqual({ model: "Gemini 3.6 Flash", effort: "medium" });
  });

  it("cuts an idle frame at its own box, blank row and all", () => {
    expect(inputFrameStart(lines("The tests pass.", "", ...IDLE), LABEL)).toBe(1);
  });

  it("reads the efforts past high that `--effort` takes", () => {
    // `max` has its own gauge colour since at least 1.2.14, and 1.3 added
    // `xhigh`: a footer naming either still names the session's model.
    expect(antigravityFooter("? for shortcuts                                Claude Opus 4.6 (Thinking) · xhigh"))
      .toEqual({ model: "Claude Opus 4.6 (Thinking)", effort: "xhigh" });
    expect(antigravityFooter("? for shortcuts                                Claude Opus 4.6 (Thinking) · max"))
      .toEqual({ model: "Claude Opus 4.6 (Thinking)", effort: "max" });
    // The gauge's own label row is not a model called "max".
    expect(antigravityFooter("            low       medium       high       xhigh       max")).toBeNull();
  });
});

/** Raw rows as tmux's `capture-pane` printed them, fed through the phone's
 * own `readableScreen` — so the box's rules and the underline under `Search:`
 * are dropped by the code that drops them in the app, not by the fixture. */
function capturedScreen(rows: string[]): ReadableLine[] {
  const buffer: ReadableBufferLike = {
    length: rows.length,
    getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }),
  };
  return readableScreen(buffer).lines;
}

const RULE = "─".repeat(80);

describe(`${BRAND.display} Mobile — Antigravity 1.3.3, captured`, () => {
  // `agy` 1.3.3 at 80×24 in a private tmux server, signed in with a Gemini
  // API key (its four-model catalog, so every row fits and no window note is
  // drawn). 1.2.14 drew these screens byte for byte the same; only the
  // banner's version differs. The banner's folder row is shortened here.
  const BANNER = ["  Antigravity CLI 1.3.3", "  Gemini API key", "  Gemini 3.1 Pro (Low)", "  ~/work", ""];
  const BOX = [RULE, ">", RULE];

  it("reads the idle footer", () => {
    const screen = capturedScreen([
      ...BANNER, ...BOX,
      "? for shortcuts                                             Gemini 3.1 Pro · low",
    ]);
    expect(sessionStatus(screen, LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low" });
  });

  it("reads the /model dialog and its three-stop gauge", () => {
    const screen = capturedScreen([
      ...BANNER, ...BOX,
      "Switch Model",
      "",
      "  Search:",
      `          ${"─".repeat(20)}`,
      "",
      "> Gemini 3.8 Flash",
      "  Gemini 3.7 Flash",
      "  Gemini 3.6 Flash",
      "  Gemini 3.1 Pro   (current)",
      "",
      "  Effort  ◂        ●━━━━━━━━━━━━━━◉──────────────○        ▸",
      "                  low          medium          high",
      "            Balanced speed and reasoning quality for most tasks",
      "",
      "Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back",
      "",
      "                                                            Gemini 3.1 Pro · low",
    ]);
    const picker = readAntigravityPicker(screen);
    expect(picker!.options.map((option) => `${option.number}. ${option.label}`)).toEqual([
      "1. Gemini 3.8 Flash",
      "2. Gemini 3.7 Flash",
      "3. Gemini 3.6 Flash",
      "4. Gemini 3.1 Pro",
    ]);
    expect(picker!.options[3].description).toBe("(current)");
    expect(picker!.current).toBe(0);
    expect(picker!.hidden).toBeUndefined();
    expect(readAntigravityEffort(screen)).toEqual({
      current: 1,
      stops: [
        { label: "low" },
        { label: "medium", description: "Balanced speed and reasoning quality for most tasks" },
        { label: "high" },
      ],
    });
    // The chips read the session's own status, not the highlighted row's.
    expect(sessionStatus(screen, LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low" });
  });

  it("reads the footer once Enter has applied model and effort together", () => {
    const screen = capturedScreen([
      "  ⎿  Model set to Gemini 3.8 Flash (High)",
      "", ...BOX,
      "? for shortcuts                                          Gemini 3.8 Flash · high",
    ]);
    expect(sessionStatus(screen, LABEL)).toEqual({ model: "Gemini 3.8 Flash", effort: "high" });
  });
});
