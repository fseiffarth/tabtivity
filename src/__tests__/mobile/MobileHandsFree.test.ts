import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handsFreeTurnOver, questionSpeech, voicePick, voicePickable } from "../../../mobile-web/src/handsFree";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import { readSelectPrompt, UNNUMBERED } from "../../../mobile-web/src/terminal/selectPrompt";
import type { ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";

const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const prompt = (labels: string[], extra: Partial<SelectPrompt> = {}): SelectPrompt => ({
  current: 0,
  start: 0,
  question: 0,
  context: 0,
  options: labels.map((label, index) => ({ index, number: index + 1, label })),
  ...extra,
} as SelectPrompt);

describe("the phone's hands-free loop", () => {
  it("ends a wait on a reading command at once: no turn was started", () => {
    const idle = { busy: false, sawWork: false, question: false, answerAtSend: "a1", answerNow: "a1" };
    expect(handsFreeTurnOver(idle)).toBe(false);
    expect(handsFreeTurnOver({ ...idle, reading: true })).toBe(true);
  });

  it("picks a question's row by the number it printed", () => {
    const colours = prompt(["Red", "Green", "Blue", "Type something."]);
    expect(voicePick("two", colours)?.label).toBe("Green");
    expect(voicePick("Option 1.", colours)?.label).toBe("Red");
    expect(voicePick("die Dritte", colours)?.label).toBe("Blue");
    expect(voicePick("four", colours)).toBeNull();
    expect(voicePick("I think two is fine", colours)).toBeNull();
  });

  it("never picks a free-text row or an unnumbered Submit row", () => {
    const withFree = prompt(["Red", "Blue", "Type something."]);
    expect(voicePick("three", withFree)).toBeNull();
    expect(voicePick("two", withFree)?.label).toBe("Blue");
    const submit: SelectPrompt = {
      ...prompt(["A", "B"]),
      options: [{ index: 0, number: 1, label: "A" }, { index: 1, number: 2, label: "B" }, { index: 2, number: UNNUMBERED, label: "Submit" }],
    };
    expect(voicePick("three", submit)).toBeNull();
  });

  it("reads a question out with its rows by number", () => {
    const yesNo = prompt(["Yes", "No", "Type something."]);
    expect(questionSpeech(["Do you want to make this edit", "to app.ts?"], yesNo))
      .toBe("Do you want to make this edit to app.ts? 1: Yes. 2: No.");
    expect(questionSpeech([], prompt(["Opus"], { title: "Select Model" }))).toBe("Select Model 1: Opus.");
  });

  it("opens the mic only once the turn is over", () => {
    const base = { busy: false, sawWork: false, question: false, answerAtSend: "a1", answerNow: "a1" };
    // Nothing seen yet: the agent may not have started.
    expect(handsFreeTurnOver(base)).toBe(false);
    expect(handsFreeTurnOver({ ...base, busy: true, sawWork: true })).toBe(false);
    expect(handsFreeTurnOver({ ...base, sawWork: true })).toBe(true);
    // Too quick for its busy row: a new answer while idle ends it.
    expect(handsFreeTurnOver({ ...base, answerNow: "a2" })).toBe(true);
    // A mid-turn answer while still busy does not.
    expect(handsFreeTurnOver({ ...base, busy: true, answerNow: "a2" })).toBe(false);
    // A question waits on the user.
    expect(handsFreeTurnOver({ ...base, busy: true, question: true })).toBe(true);
  });

  it("never lets a voice answer a permission dialog (gap 80)", () => {
    // Claude Code's edit prompt, as the parser reads it off the screen.
    const permission = readSelectPrompt(lines(
      "Edit file", "  src/lib/i18n.ts", "",
      "Do you want to make this edit to i18n.ts?",
      "❯ 1. Yes",
      "  2. Yes, allow all edits during this session (shift+tab)",
      "  3. No, and tell Claude what to do differently (esc)",
    ), "Claude Code")!;
    expect(permission).not.toBeNull();
    expect(voicePickable(permission)).toBe(false);
    expect(voicePick("one", permission)).toBeNull();
    expect(voicePick("two", permission)).toBeNull();
    const bash = readSelectPrompt(lines(
      "Bash command", "  rm -rf build", "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for rm commands in /work",
      "  3. No, and tell Claude what to do differently (esc)",
    ), "Claude Code")!;
    expect(voicePickable(bash)).toBe(false);
    expect(voicePick("two", bash)).toBeNull();
  });

  it("refuses an unrecognised shape and a Codex picker", () => {
    const picker = readSelectPrompt(lines(
      "Select Model", "", "❯ 1. Default (recommended)   Opus", "  2. Opus   For complex tasks", "", "Esc to cancel",
    ), "Claude Code")!;
    expect(voicePickable(picker)).toBe(false);
    const codex = readSelectPrompt(lines("› 1. gpt-5-codex", "  2. gpt-5"), "Codex")!;
    expect(voicePickable(codex)).toBe(false);
    expect(voicePick("one", codex)).toBeNull();
    // A hand-built prompt with no kind the parser could name.
    expect(voicePickable(prompt(["Yes", "No"]))).toBe(false);
    expect(voicePickable(prompt(["Yes", "No"], { review: true }))).toBe(false);
  });

  it("lets a voice answer a question the agent asks, never a row that saves a rule", () => {
    // Claude Code's AskUserQuestion always ends its answers in a free-text row.
    const question = readSelectPrompt(lines(
      "←  ☐ Color  ☐ Size  ✔ Submit  →", "",
      "Which color should the banner use?", "",
      "❯ 1. Red", "  2. Green", "  3. Blue", "  4. Type something.", "", "  5. Chat about this", "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ), "Claude Code")!;
    expect(voicePickable(question)).toBe(true);
    expect(voicePick("two", question)?.label).toBe("Green");
    // A screen-drawn question that offers a grant is refused all the same.
    expect(voicePickable(prompt(["Allow once", "Allow always", "Type something."]))).toBe(false);
    expect(voicePickable(prompt(["Yes", "Yes, and don't ask again", "Type something."]))).toBe(false);
  });

  it("lets a voice answer OpenCode's question", () => {
    // The shape MobileOpenCodeQuestion.test.ts captures: a tab row, the
    // question on its own background, answers with notes, the custom row.
    const line = (text: string, background?: string): ReadableLine => ({ key: text, text, spans: [{ text, background }] });
    const tabs: ReadableLine = {
      key: "tabs",
      text: " Which model picker fails   Failure symptoms   Confirm ",
      spans: ["Which model picker fails", "Failure symptoms", "Confirm"].flatMap((text, index) => [
        { text: ` ${text} `, background: index === 0 ? "#cc8800" : "#222222" },
        { text: " ", background: "#222222" },
      ]),
    };
    const screen: ReadableLine[] = [
      line("Asked 2 questions"), line("▣ Build · Muse Spark 1.3 Free"), line(""), tabs, line(""),
      line("Which OpenCode model picker do you mean?", "#222222"), line(""),
      line("1. Desktop Reader Chat view", "#333333"), line("   Chat/Terminal switch facts-row model chip", "#222222"),
      line("2. Steering prompt chip", "#222222"), line("   Keyboard-steering prompt box", "#222222"),
      line("3. Phone model sheet", "#222222"), line("   Mobile Focus model chip sheet", "#222222"),
      line("4. Local-model OpenCode tab", "#222222"),
      line("5. Type your own answer", "#222222"), line(""),
      line("⇆ tab  ↑↓ select  enter confirm  esc dismiss", "#222222"),
    ];
    const opencode = readSelectPrompt(screen, "OpenCode");
    expect(opencode?.source).toBe("opencode");
    expect(voicePickable(opencode!)).toBe(true);
  });

  it("keeps both callers on the staged path: a pick is never answered inside the utterance", () => {
        const phone = readFileSync("mobile-web/src/screens/terminal/useHandsFree.ts", "utf8");
    const desktop = readFileSync("src/components/terminal/TerminalReaderView.tsx", "utf8");
    const voice = readFileSync("src/components/terminal/ReaderVoice.tsx", "utf8");
    for (const source of [phone, desktop]) expect(source).toContain("voicePickable(");
    // The pick only stages; the window's close answers (commit*).
    expect(phone).toMatch(/staged\.current\.stage\(/);
    expect(voice).toMatch(/staged\.current\.stage\(/);
    expect(desktop).not.toMatch(/const pickByVoice[\s\S]{0,600}answer\(option\.index\)/);
    expect(phone).not.toMatch(/voicePickRef\.current = [\s\S]{0,900}answerQuestion\(option\)[\s\S]{0,200}return "staged"/);
  });
});
