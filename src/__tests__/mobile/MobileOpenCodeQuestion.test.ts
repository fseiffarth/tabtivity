import { describe, expect, it } from "vitest";
import { readSelectPrompt, answerRowKeys, freeTextRow, freeTextWrites, questionTabKeys, selectSignature, dialogFooterShown } from "../../../mobile-web/src/terminal/selectPrompt";
import { questionParts } from "../../../mobile-web/src/terminal/questionParts";
import type { ReadableBufferLike, ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { answerKeys, answerTextKeys, readReaderLive } from "../../lib/agents/readerLive";

const line = (text: string, background?: string): ReadableLine => ({ key: text, text, spans: [{ text, background }] });
const tabs = (focus: number): ReadableLine => {
  const spans = ["Which model picker fails", "Failure symptoms", "Confirm"].flatMap((text, index) => [
    { text: ` ${text} `, background: index === focus ? "#cc8800" : "#222222" },
    { text: " ", background: "#222222" },
  ]);
  return { key: "tabs", text: spans.map((span) => span.text).join(""), spans };
};

/** The screenshot's question, with the full tab row retained from the TUI.
 * Colours and Confirm/custom-input behaviour follow QuestionPrompt 1.18.34. */
const screenshot = (multi = false): ReadableLine[] => [
  line("Asked 2 questions"), line("▣ Build · Muse Spark 1.3 Free"), line(""), tabs(0), line(""),
  line(`Which OpenCode model picker do you mean?${multi ? " (select all that apply)" : ""}`, "#222222"), line(""),
  line(`1. ${multi ? "[ ] " : ""}Desktop Reader Chat view`, "#333333"),
  line("   Chat/Terminal switch facts-row model chip", "#222222"),
  line(`2. ${multi ? "[✓] " : ""}Steering prompt chip`, "#222222"),
  line("   Keyboard-steering prompt box", "#222222"),
  line(`3. ${multi ? "[ ] " : ""}Phone model sheet`, "#222222"),
  line("   Mobile Focus model chip sheet", "#222222"),
  line(`4. ${multi ? "[ ] " : ""}Local-model OpenCode tab`, "#222222"),
  line(`5. ${multi ? "[ ] " : ""}Type your own answer`, "#222222"), line(""),
  line(`⇆ tab  ↑↓ select  enter ${multi ? "toggle" : "confirm"}  esc dismiss`, "#222222"),
];

const read = (screen: ReadableLine[]) => readSelectPrompt(screen, "OpenCode")!;

/** Feed the same styles through the actual cell reader used on desktop. */
function bufferFor(rows: ReadableLine[]): ReadableBufferLike {
  return {
    length: rows.length,
    getLine: (row) => {
      const line = rows[row];
      if (!line) return undefined;
      const cells = line.spans.flatMap((span) => Array.from(span.text, (char) => ({
        getChars: () => char, getWidth: () => 1,
        isBold: () => 0, isItalic: () => 0, isDim: () => 0, isUnderline: () => 0,
        isStrikethrough: () => 0, isInverse: () => 0, isInvisible: () => 0,
        isFgDefault: () => true, isBgDefault: () => !span.background,
        isFgPalette: () => false, isBgPalette: () => false,
        isFgRGB: () => false, isBgRGB: () => !!span.background,
        getFgColor: () => 0, getBgColor: () => Number.parseInt(span.background?.slice(1) ?? "0", 16),
      })));
      return { length: cells.length, translateToString: () => line.text, getCell: (column) => cells[column] };
    },
  };
}


describe("OpenCode live questions shared by phone Chat and desktop Reader", () => {
  it("reads the screenshot's choices, descriptions, own question and active header", () => {
    const screen = screenshot();
    const prompt = read(screen);
    expect(prompt.source).toBe("opencode");
    expect(prompt.current).toBe(0);
    expect(prompt.options).toHaveLength(5);
    expect(prompt.options[0]).toMatchObject({ label: "Desktop Reader Chat view", description: "Chat/Terminal switch facts-row model chip" });
    expect(questionParts(screen, prompt)).toMatchObject({
      ask: [{ text: "Which OpenCode model picker do you mean?" }], context: [],
      tabs: [{ label: "Which model picker fails" }, { label: "Failure symptoms" }],
      tabFocus: 0, tabSubmit: true, tabKeys: "tabs",
    });
    expect(answerRowKeys(prompt, prompt.options[2])).toEqual(["3"]);
    expect(questionTabKeys(0, 2, prompt.navigation?.keys)).toEqual(["\t", "\t"]);
    expect(questionTabKeys(2, 0, prompt.navigation?.keys)).toEqual(["\u001b[Z", "\u001b[Z"]);
  });

  it("reads coloured question headers through the desktop's cell and frame parsers", () => {
    const live = readReaderLive(bufferFor(screenshot()), "OpenCode", 100);
    expect(live.question?.source).toBe("opencode");
    expect(live.ask).toEqual(["Which OpenCode model picker do you mean?"]);
    expect(live.tabFocus).toBe(0);
    expect(live.tabKeys).toBe("tabs");
    expect(live.tabSubmit).toBe(true);
    expect(live.context).toEqual([]);
    expect(live.question?.options[0].description).toBe("Chat/Terminal switch facts-row model chip");
  });

  it("opens the custom editor before typing, and saves multi-select custom answers with Enter", () => {
    for (const multi of [false, true]) {
      const prompt = read(screenshot(multi));
      const custom = prompt.options[4];
      expect(freeTextRow(custom)).toBe(true);
      expect(answerKeys(prompt, custom)).toEqual([]);
      expect(freeTextWrites(prompt.current, custom, "Phone\nmodel chip")).toEqual(["5", "Phone model chip", "\r"]);
      expect(answerTextKeys(prompt, custom, " ")).toEqual([]);
      expect(freeTextWrites(prompt.current, { ...custom, description: "Earlier answer" }, "Replacement")).toEqual(["5", "\u0015", "Replacement", "\r"]);
      if (multi) expect(freeTextWrites(prompt.current, { ...custom, label: "[✓] Type your own answer", description: "Earlier answer" }, "Replacement")).toEqual(["5", "5", "\u0015", "Replacement", "\r"]);
    }
  });

  it("retains the answer tick when returning to a single-choice question", () => {
    const prompt = read(screenshot().map((row) => line(row.text.replace("3. Phone model sheet", "3. Phone model sheet ✓").replace("5. Type your own answer", "5. Type your own answer ✓"))));
    expect(prompt.options[2].label).toBe("Phone model sheet ✓");
    expect(freeTextRow(prompt.options[4])).toBe(true);
  });

  it("keeps checkbox state in the signature so a toggle can be answered again", () => {
    const before = read(screenshot(true));
    const after = read(screenshot(true).map((row) => line(row.text.replace("[ ] Desktop", "[✓] Desktop"))));
    expect(before.options[1].label).toBe("[✓] Steering prompt chip");
    expect(selectSignature(before)).not.toBe(selectSignature(after));
    expect(answerRowKeys(before, before.options[1])).toEqual(["2"]);
  });

  it("keeps Confirm as a Submit card, with review answers and working back navigation", () => {
    const screen = [line("1. Earlier prose"), line("2. More prose"), line(""), tabs(2), line(""), line("Review", "#222222"), line("Which model picker fails: Phone model sheet"), line("Failure symptoms: (not answered)"), line(""), line("⇆ tab  enter submit  esc dismiss")];
    const prompt = read(screen);
    expect(prompt.review).toBe(true);
    expect(dialogFooterShown(screen)).toBe(true);
    expect(questionParts(screen, prompt)).toMatchObject({ tabFocus: 2, tabSubmit: true, tabKeys: "tabs" });
    expect(questionParts(screen, prompt).ask.map((row) => row.text).join(" ")).toContain("Phone model sheet");
    expect(answerRowKeys(prompt, prompt.options[0])).toEqual(["\r"]);
  });

  it("supports single questions with no header, including a one-option question", () => {
    const screen = [line("Proceed?"), line(""), line("1. Yes"), line("   Continue the change"), line(""), line("↑↓ select  enter submit  esc dismiss")];
    expect(read(screen)).toMatchObject({ current: 0, title: "Proceed?", options: [{ label: "Yes", keys: ["1"] }] });
    const buffer = { length: screen.length, getLine: (row: number) => ({ translateToString: () => screen[row].text }) };
    const live = readReaderLive(buffer, "OpenCode", 80);
    expect(live.ask).toEqual(["Proceed?"]);
    expect(live.question?.source).toBe("opencode");
    expect(answerKeys(live.question!, live.question!.options[0])).toEqual(["1"]);
  });

  it("ignores earlier numbered prose and refuses ordinary lists, other agents and stale dialogs", () => {
    expect(read([line("1. Earlier item"), line("2. Another item"), line(""), ...screenshot()]).options).toHaveLength(5);
    expect(readSelectPrompt(screenshot(), "Claude Code")).toBeNull();
    expect(readSelectPrompt(screenshot().slice(0, -1), "OpenCode")).toBeNull();
    expect(readSelectPrompt([...screenshot(), line("The agent continued.")], "OpenCode")).toBeNull();
    expect(dialogFooterShown(screenshot())).toBe(true);
  });
});
