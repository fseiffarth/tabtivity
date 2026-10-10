/**
 * Tests for looksLikeDecisionPrompt: classifying a quiet agent tab as blocked on
 * a decision (a selection menu in its output) vs simply finished — including off
 * the raw PTY stream, escape codes and all, which is the only view of the screen
 * available for a tab whose pane has never been opened.
 */
import { describe, it, expect } from "vitest";
import { looksLikeDecisionPrompt, stripAnsi } from "../../lib/agents/prompt/prompt";

describe("looksLikeDecisionPrompt", () => {
  it("detects a pointer + numbered choice (Claude/Codex approval menu)", () => {
    const screen = [
      "Do you want to make this edit to activity.ts?",
      "❯ 1. Yes",
      "  2. No, and tell Claude what to do differently",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
  });

  it("detects a yes/no numbered menu without the pointer glyph", () => {
    const screen = ["Allow this command?", "1. Yes  2. No"].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
  });

  it("detects a Codex menu whose deny option is third", () => {
    // Codex offers two flavours of yes before the no, so an index-locked
    // "1. yes" + "2. no" pair never matched it.
    const screen = [
      "Would you like to run the following command?",
      "  1. Yes, just this once",
      "  2. Yes, and don't ask again for this command in this session",
      "  3. No, and tell Codex what to do differently",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
  });

  it("detects a Codex menu the TUI's diff renderer stripped the spaces out of", () => {
    // Ratatui repaints by jumping the cursor over unchanged cells, so the gaps
    // between words never reach the wire and rows glue to their predecessor.
    const raw =
      "\x1b[7;1H\x1b[38;5;6;49m› 1. Yes, just this once\x1b[8;3H\x1b[39;49m" +
      "2.Yes,and\x1b[8;14Hdon't\x1b[8;20Hask\x1b[8;24Hagain\x1b[9;3H" +
      "3.No,and\x1b[9;12Htell\x1b[9;17HCodex\r\n";
    expect(looksLikeDecisionPrompt(raw)).toBe(true);
  });

  it("treats a finished turn (no prompt) as not-a-decision", () => {
    const screen = [
      "Done. I updated the activity store and the tests pass.",
      "",
      "> ",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(false);
  });

  it("does not fire on ordinary numbered prose", () => {
    const screen = [
      "Here are the steps:",
      "1. Read the file",
      "2. Edit it",
      "3. Run the tests",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(false);
  });

  it("is false for empty text", () => {
    expect(looksLikeDecisionPrompt("")).toBe(false);
  });

  it("sees through the escape codes of a raw PTY chunk", () => {
    // What a colour-coded approval menu actually looks like on the wire: cursor
    // moves, SGR colour runs, and an OSC title update wrapped around the text.
    const raw =
      "\x1b]0;claude\x07\x1b[2J\x1b[H\x1b[1mDo you want to make this edit?\x1b[0m\r\n" +
      "\x1b[32m❯ \x1b[1m1.\x1b[0m\x1b[32m Yes\x1b[0m\r\n" +
      "\x1b[2m  2. No, and tell Claude what to do differently\x1b[0m\r\n";
    expect(looksLikeDecisionPrompt(raw)).toBe(true);
  });

  it("does not mistake a colour-coded finished turn for a prompt", () => {
    const raw = "\x1b[32m✔\x1b[0m Done — \x1b[1m12 tests\x1b[0m pass.\r\n\x1b[2m❯ \x1b[0m";
    expect(looksLikeDecisionPrompt(raw)).toBe(false);
  });

  it("detects a bare pointer + word binary confirmation (no numbering)", () => {
    const screen = ["Allow this command?", "❯ Yes", "  No"].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
  });

  it("sees through escape codes on a bare pointer + word prompt", () => {
    const raw =
      "\x1b[2J\x1b[H\x1b[1mAllow this command?\x1b[0m\r\n" +
      "\x1b[32m❯ Yes\x1b[0m\r\n\x1b[2m  No\x1b[0m\r\n";
    expect(looksLikeDecisionPrompt(raw)).toBe(true);
  });

  it("does not fire on a bare idle input-line cursor", () => {
    expect(looksLikeDecisionPrompt("❯ ")).toBe(false);
  });

  it("does not mistake the user's own prompts in Codex's history for a menu", () => {
    // Codex marks every sent prompt with "›", so a sent "continue" read as a
    // pointer on a "Continue" option and lit a finished tab as a question.
    const screen = [
      "› continue",
      "",
      "• I'll collect the final check results and resolve anything still failing.",
      "",
      "› 1. fix the lint warnings",
      "",
      "• Implemented autocomplete roadmap items 6–9.",
      "  done 1:27 PM",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(false);
  });

  it("detects Codex's startup hook-trust menu, which has no deny option", () => {
    // Captured live from Codex 0.161.0.
    const screen = [
      "  Hooks need review",
      "  2 hooks are new or changed.",
      "  Hooks can run outside the sandbox after you trust them.",
      "› 1. Review hooks",
      "  2. Trust all and continue",
      "  3. Continue without trusting (hooks won't run)",
      "  enter confirm · esc skip",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
    // The diff renderer's dropped spaces.
    expect(looksLikeDecisionPrompt("Hooksneedreview\r\n› 1.Review hooks2.Trustall")).toBe(true);
    // A numbered "Trust" item in an answer is not that menu.
    expect(looksLikeDecisionPrompt("• Steps:\n  1. Trust the proxy\n  2. Continue the rollout")).toBe(false);
  });
});

describe("stripAnsi", () => {
  it("removes SGR, cursor and OSC sequences but keeps the text", () => {
    const raw = "\x1b]0;title\x07\x1b[2J\x1b[1;1H\x1b[31mhello\x1b[0m world\x1b(B";
    expect(stripAnsi(raw)).toBe("hello world");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("❯ 1. Yes\n  2. No")).toBe("❯ 1. Yes\n  2. No");
  });
});
