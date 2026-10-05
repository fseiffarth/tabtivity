import { describe, expect, it } from "vitest";
import { answerKeys, readReaderLive, sameReaderLive, tabStepKeys } from "../../lib/agents/readerLive";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

/** Claude Code's permission prompt, as the phone's Focus tests paint it. */
const PERMISSION = [
  "> fix the strings",
  "",
  "⏺ I'll update the file.",
  "",
  "Edit file",
  "  src/lib/i18n.ts",
  "",
  "Do you want to make this edit to i18n.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
  "",
  "  esc to cancel",
];

/** An agent's own question (`AskUserQuestion`), as the phone's Focus tests
 * paint it: its message, the tab row naming the question, the question —
 * both wrapped by Claude Code itself at the pane's width — and the options. */
const AGENT_QUESTION = [
  "> push it",
  "",
  "● My fix is ready and verified, but pushing develop now would also push four",
  "  other commits. I need your call before pushing.",
  "",
  "☐ Push scope",
  "",
  "Four other-session commits sit unpushed on develop. How should I land my",
  "Windows/CodeQL fix?",
  "",
  "❯ 1. Fix only (Recommended)",
  "     Put my fix directly on the pushed main.",
  "  2. Push everything",
  "     Push develop with all four commits.",
  "  3. Type something.",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

describe("the desktop Reader's live screen", () => {
  it("reads a permission prompt as its question, its context and its options", () => {
    const live = readReaderLive(plainBuffer(PERMISSION), "Claude");
    expect(live.question?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, allow all edits during this session",
      "No, and tell Claude what to do differently",
    ]);
    expect(live.ask.join("\n")).toMatch(/Do you want to make this edit/);
    expect(live.context.join("\n")).toMatch(/src\/lib\/i18n\.ts/);
    expect(live.working).toBeNull();
    expect(live.signature).not.toBe("");
  });

  it("reads an agent's own question: its header as a tab, its question as one paragraph", () => {
    const live = readReaderLive(plainBuffer(AGENT_QUESTION), "Claude");
    expect(live.tabs).toEqual([{ label: "Push scope", answered: false }]);
    expect(live.ask).toEqual([
      "Four other-session commits sit unpushed on develop. How should I land my Windows/CodeQL fix?",
    ]);
    // The agent's message is the conversation's last turn already; neither it
    // nor the tab row's checkbox is repeated as a screen dump.
    expect(live.context).toEqual([]);
    expect(live.question?.options[0]).toMatchObject({ label: "Fix only (Recommended)", description: "Put my fix directly on the pushed main." });
  });

  it("lifts the tab row of a question that asks several, answered ones ticked", () => {
    const live = readReaderLive(plainBuffer([
      "> tag it",
      "",
      "←  ☒ Scope  ☐ Release tag  ✔ Submit  →",
      "",
      "Which tag should the release get?",
      "",
      "❯ 1. v0.2.0",
      "  2. v0.1.100",
      "  3. Type something.",
      "",
      "  4. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]), "Claude");
    expect(live.tabs).toEqual([{ label: "Scope", answered: true }, { label: "Release tag", answered: false }]);
    expect(live.ask).toEqual(["Which tag should the release get?"]);
    expect(live.context).toEqual([]);
    const next = readReaderLive(plainBuffer([
      "> tag it", "", "←  ☒ Scope  ☒ Release tag  ✔ Submit  →", "", "Which tag should the release get?",
      "", "❯ 1. v0.2.0", "  2. v0.1.100",
    ]), "Claude");
    expect(sameReaderLive(live, next)).toBe(false);
    expect(live.tabSubmit).toBe(true);
    // A plain buffer paints no chip: the step on screen is unknown.
    expect(live.tabFocus).toBeNull();
  });

  it("tells two questions of one dialog apart when they offer the same rows", () => {
    const step = (tabRow: string, ask: string) => readReaderLive(plainBuffer([
      "> ask me", "", tabRow, "", ask, "", "❯ 1. Yes", "  2. No", "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]), "Claude");
    const first = step("←  ☐ Tests  ☐ Docs  ✔ Submit  →", "Run the tests?");
    const second = step("←  ☒ Tests  ☐ Docs  ✔ Submit  →", "Update the docs?");
    expect(first.signature).not.toBe(second.signature);
  });

  it("reads Codex's several questions off its heading, with no Submit step", () => {
    const live = readReaderLive(plainBuffer([
      "› plan it", "",
      "  Question 2/3 (2 unanswered)",
      "  Which store should the cache use?",
      "",
      "  › 1. Redis (Recommended)    Shared across workers.",
      "    2. In-process LRU         Simplest.",
      "",
      "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
    ]), "Codex");
    expect(live.question).not.toBeNull();
    expect(live.tabs.map((tab) => tab.label)).toEqual(["Q1", "Q2", "Q3"]);
    expect(live.tabFocus).toBe(1);
    expect(live.tabSubmit).toBe(false);
    expect(live.tabKeys).toBe("pages");
  });

  it("keeps Gemini's Review page as a card that submits with Enter and walks back with Shift+Tab", () => {
    const live = readReaderLive(plainBuffer([
      "> plan the release", "",
      "← ✓ Scope │ □ Release tag │ ≡ Review →", "",
      "Review your answers:", "",
      "⚠ You have 1 unanswered question", "",
      "Scope → Fix only",
      "Release tag → (not answered)",
      "Enter to submit · Tab/Shift+Tab to edit answers · Esc to cancel",
    ]), "Gemini");
    const question = live.question!;
    expect(question.options.map((option) => option.label)).toEqual(["Submit"]);
    expect(answerKeys(question, question.options[0])).toEqual(["\r"]);
    expect(live.tabs).toEqual([{ label: "Scope", answered: true }, { label: "Release tag", answered: false }]);
    expect(live.tabSubmit).toBe(true);
    expect(live.tabKeys).toBe("tabs");
    expect(live.ask).toEqual(["Review your answers:", "", "⚠ You have 1 unanswered question", "", "Scope → Fix only", "Release tag → (not answered)"]);
    expect(tabStepKeys(live, 2, 1)).toEqual(["\u001b[Z"]);
  });

  it("walks a several-question dialog's tabs with the arrows", () => {
    expect(tabStepKeys({ tabKeys: "arrows" }, 2, 1)).toEqual(["\u001b[D"]);
    expect(tabStepKeys({ tabKeys: "arrows" }, 0, 2)).toEqual(["\u001b[C", "\u001b[C"]);
    // Codex: PageUp/PageDown, which also work while a notes field is open.
    expect(tabStepKeys({ tabKeys: "pages" }, 0, 2)).toEqual(["\u001b[6~", "\u001b[6~"]);
    expect(tabStepKeys({ tabKeys: "pages" }, 1, 0)).toEqual(["\u001b[5~"]);
  });

  it("answers with the arrows from the highlight, then Enter", () => {
    const live = readReaderLive(plainBuffer(PERMISSION), "Claude");
    const question = live.question!;
    expect(answerKeys(question, question.options[2])).toEqual(["\u001b[B", "\u001b[B", "\r"]);
    expect(answerKeys(question, question.options[0])).toEqual(["\r"]);
  });

  it("reads the agent at work, with its timer and tokens, and nothing when idle", () => {
    const busy = readReaderLive(plainBuffer(["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"]), "Claude");
    expect(busy.question).toBeNull();
    expect(busy.working).toEqual({ elapsed: "9s", tokens: "1.2k" });
    const idle = readReaderLive(plainBuffer(["> fix it", "", "⏺ Done.", "", "> ", "  ? for shortcuts"]), "Claude");
    expect(idle.question).toBeNull();
    expect(idle.working).toBeNull();
  });

  it("leaves a dialog answered before the last prompt alone", () => {
    const answered = readReaderLive(plainBuffer([
      "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "> and now the tests", "", "⏺ Running them.", "> ",
    ]), "Claude");
    expect(answered.question).toBeNull();
  });

  it("tells a redraw of the same state from a change", () => {
    const a = readReaderLive(plainBuffer(PERMISSION), "Claude");
    const b = readReaderLive(plainBuffer(PERMISSION), "Claude");
    expect(sameReaderLive(a, b)).toBe(true);
    const busy = readReaderLive(plainBuffer(["✻ Thinking… (9s · esc to interrupt)", "> "]), "Claude");
    const later = readReaderLive(plainBuffer(["✻ Thinking… (10s · esc to interrupt)", "> "]), "Claude");
    expect(sameReaderLive(busy, later)).toBe(false);
  });
});
