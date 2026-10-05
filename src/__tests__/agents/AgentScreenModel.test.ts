/**
 * The model tag read off an agent pane's own screen — what the phone's tab
 * cards show, and the same parse their Focus chip uses, so the two surfaces
 * cannot say two different models about one session.
 */
import { describe, expect, it } from "vitest";
import { screenModelTag } from "../../lib/agents/agentModel";
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
