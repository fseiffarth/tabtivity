/**
 * The PLAN / GOAL marks on an agent tab: read off the session's own footer
 * with the parser the phone's Mode chip uses, so the tab is marked exactly
 * while the CLI says so — and an unreadable screen says nothing either way.
 */
import { describe, expect, it } from "vitest";
import { screenModeMarks, textScreenModeMarks } from "../../lib/agents/agentModel";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

function screen(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

describe("an agent tab's plan / goal marks", () => {
  it("reads Claude Code's plan mode", () => {
    expect(screenModeMarks(screen(["● Done.", "", ">", "⏸ plan mode on (shift+tab to cycle)"]), "Claude"))
      .toEqual({ plan: true, goal: false });
  });

  it("reads a running /goal beside the mode, without taking it for a path", () => {
    const rows = [">", "⏵⏵ accept edits on (shift+tab to cycle) · ◎ /goal active (3m)"];
    expect(screenModeMarks(screen(rows), "Claude")).toEqual({ plan: false, goal: true });
    expect(sessionStatus(rows.map((text) => ({ text })))).toEqual({ mode: "accept edits", goal: true });
    expect(screenModeMarks(screen([">", "⏸ plan mode on (shift+tab to cycle) · ◎ /goal active"]), "Claude"))
      .toEqual({ plan: true, goal: true });
  });

  it("reads the goal right-aligned under a custom statusline that wrapped", () => {
    const rows = [
      "● Checking the footer.",
      "────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────",
      `  me@box:~/work/projects/project${BRAND.slug} (develop*) · Opus 5.5`,
      "  [high] ⏵ auto · ctx 64% · 5h 71%/2h10m · 7d 40%/3d2h · +12",
      "  0/-30",
      "  ⏵⏵ auto mode on (shift+tab to cycle)     ◎ /goal active (4m)",
    ];
    expect(textScreenModeMarks(rows.join("\n"), "Claude")).toEqual({ plan: false, goal: true });
    // Only the footer's own phrase: a `/` menu row naming the command is not one.
    expect(textScreenModeMarks(["❯ /go", "  /goal   Keep working until a goal is met"].join("\n"), "Claude"))
      .toEqual({ plan: false, goal: false });
  });

  it("reads Codex's plan mode and its pursued goal", () => {
    expect(textScreenModeMarks("› \nPlan mode (shift+tab to cycle) · Pursuing goal (4m)\n", "Codex"))
      .toEqual({ plan: true, goal: true });
    // A paused goal is not a running one.
    expect(textScreenModeMarks("› \nGoal paused (/goal resume)\n", "Codex"))
      .toEqual({ plan: false, goal: false });
  });

  it("is neither on an ordinary footer, and unreadable without an input box", () => {
    expect(screenModeMarks(screen(["> ", "? for shortcuts · 85% context left"]), "Claude"))
      .toEqual({ plan: false, goal: false });
    expect(screenModeMarks(screen(["● Plan mode is on, /goal active"]), "Claude")).toBeNull();
  });
});
