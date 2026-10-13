/**
 * The model tag read off an agent pane's own screen — what the phone's tab
 * cards show, and the same parse their Focus chip uses, so the two surfaces
 * cannot say two different models about one session.
 */
import { describe, expect, it } from "vitest";
import { screenModelTag, transcriptModelTag } from "../../lib/agents/agentModel";
import { statusModelTag } from "../../../mobile-web/src/terminal/statusLine";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

function screen(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

describe("the model an agent tab's screen is showing", () => {
  it("is the status line's own words, not the transcript's model id", () => {
    expect(screenModelTag(screen([
      "● Done.",
      "",
      ">",
      `~/${BRAND.slug}/projects/project${BRAND.slug} (develop) · Opus 4.1 · 85% context left`,
    ]), "Claude")).toBe("Opus 4.1");
  });

  it("carries the reasoning effort where the session prints one beside it", () => {
    expect(screenModelTag(screen([
      "The tests pass.",
      "",
      ">",
      "? for shortcuts                                          Gemini 3.8 Flash · high",
    ]), "Google Antigravity")).toBe("Gemini 3.8 Flash · high");
  });

  it("says nothing at all where the session's line names no model", () => {
    // Claude Code's default footer: a context figure and nothing else. The
    // caller then falls back to what the tab last answered with.
    expect(screenModelTag(screen(["> ", "? for shortcuts · 85% context left"]), "Claude")).toBeUndefined();
    // No input box on screen is no status at all.
    expect(screenModelTag(screen(["● Hello."]), "Claude")).toBeUndefined();
  });
});

// The phone's tab card carries the desktop's tag; the phone's model chip reads
// its own screen. Both go through these two functions, so one session cannot
// be one model on its card and another over its keyboard.
describe("the one model tag both phone surfaces show", () => {
  it("composes a status the same way wherever it is read", () => {
    expect(statusModelTag({ model: "Sonnet 5.5" })).toBe("Sonnet 5.5");
    expect(statusModelTag({ model: "Gemini 3.8 Flash", effort: "high" })).toBe("Gemini 3.8 Flash · high");
    expect(statusModelTag({ mode: "plan" })).toBeUndefined();
    expect(statusModelTag(null)).toBeUndefined();
  });

  it("names a stored session's model in the status line's words, never by family alone", () => {
    expect(transcriptModelTag("claude-fable-5-1-20260801", true)).toBe("Fable 5.1");
    // The desktop holds the id already shortened; it reads the same.
    expect(transcriptModelTag("fable-5-1", true)).toBe("Fable 5.1");
    expect(transcriptModelTag("gpt-5-codex", false)).toBe("gpt-5-codex");
  });
});
