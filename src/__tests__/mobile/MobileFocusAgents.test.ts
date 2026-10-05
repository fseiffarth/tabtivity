import { describe, expect, it } from "vitest";
import { chatTurns, isPromptEcho } from "../../../mobile-web/src/terminal/chatTurns";
import { currentMode, modeChoices } from "../../../mobile-web/src/terminal/agentModes";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import type { ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

// Screen shapes of the agent CLIs other than Claude Code, each taken from the
// published bundle rather than a live capture (docs/mobile_focus_cli_survey.md).

let seq = 0;
const line = (text: string): ReadableLine => ({ key: `a${seq += 1}`, text, spans: text ? [{ text }] : [] });
const lines = (...texts: string[]) => texts.map(line);
const rows = (...texts: string[]) => texts.map((text) => ({ text }));
const cut = (...texts: string[]) => {
  const screen = rows(...texts);
  return screen.slice(0, inputFrameStart(screen)).map((row) => row.text);
};

describe(`${BRAND.display} Mobile Focus chat turns beyond Claude Code`, () => {
  it("reads Gemini CLI's ✦ answer as an answer, marker removed", () => {
    const turns = chatTurns(lines(
      " > fix the flaky test",
      "   and add a regression case",
      "",
      "✦ The test races the watcher; I'll add a wait.",
      "  Done.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["The test races the watcher; I'll add a wait.", "Done."]);
  });

  it("reads Qwen Code's ◆︎ bullet with or without its variation selector", () => {
    const turns = chatTurns(lines("> refactor utils", "", "◆︎ Split into two modules.", "◆ And added a test."));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent", "agent"]);
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Split into two modules."]);
    expect(turns[2].answer?.map((row) => row.text)).toEqual(["And added a test."]);
  });

  it("reads Kimi Code's ✨ echo as the prompt and its ● as the answer", () => {
    // Only for a tab whose label names Kimi Code: `✨` opens ordinary output
    // on every other session, a custom statusline row included.
    expect(isPromptEcho({ text: "✨ refactor the parser" }, "Kimi Code")).toBe(true);
    expect(isPromptEcho({ text: "✨" }, "Kimi Code")).toBe(false);
    expect(isPromptEcho({ text: "✨ refactor the parser" })).toBe(false);
    const turns = chatTurns(lines("✨ refactor the parser", "", "● I'll start by reading src/parse.ts."), "Kimi Code");
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["refactor the parser"]);
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["I'll start by reading src/parse.ts."]);
  });
});

describe(`${BRAND.display} Mobile input line beyond Claude Code`, () => {
  it("does not take a markdown bullet at the bottom of the screen for a YOLO prompt", () => {
    const screen = rows("Here is the plan:", "* read the parser", "* fix the off-by-one");
    expect(sessionStatus(screen)).toBeNull();
    expect(inputFrameStart(screen)).toBe(screen.length);
  });

  it("still reads a YOLO prompt with a draft in it, next to the word", () => {
    // Qwen Code prints its YOLO line under the box, Gemini CLI over it.
    expect(sessionStatus(rows("* half-typed draft", "YOLO mode (shift + tab to cycle)"))?.mode).toBe("yolo");
    expect(sessionStatus(rows("YOLO Ctrl+Y", "* half-typed draft"))?.mode).toBe("yolo");
    // A bare `*` is the empty prompt, as before.
    expect(sessionStatus(rows("* ", "YOLO mode (shift + tab to cycle)"))?.mode).toBe("yolo");
  });

  it("reads a context figure labelled ctx", () => {
    expect(sessionStatus(rows("❯ ", "proj · 42% ctx · $0.12"))?.context).toBe("42%");
  });
});

describe(`${BRAND.display} Mobile Gemini CLI approval mode`, () => {
  const family = ["default", "accept edits", "plan", "yolo"];

  it("reads the mode from the row above the input box", () => {
    expect(sessionStatus(rows(
      "✦ Done.",
      "auto-accept edits Shift+Tab to plan",
      "> ",
      "~/proj  main  gemini-2.5-pro  25% used",
    ))).toMatchObject({ mode: "accept edits", context: "75%" });
    expect(sessionStatus(rows("auto-accept edits Shift+Tab to manual", "> "))?.mode).toBe("accept edits");
    expect(sessionStatus(rows("plan Shift+Tab to manual", "", "> "))?.mode).toBe("plan");
  });

  it("reads the default hint as no mode, which the Gemini family reads as default", () => {
    const status = sessionStatus(rows("Shift+Tab to accept edits", "> "));
    expect(status).toEqual({});
    const gemini = modeChoices(status?.mode, "Google Gemini");
    expect(gemini.map((choice) => choice.value)).toEqual(family);
    expect(currentMode(gemini, status?.mode, status != null)).toBe("default");
  });

  it("never reads prose above the box as a mode", () => {
    expect(sessionStatus(rows("plan the migration to manual steps first", "> "))?.mode).toBeUndefined();
    expect(sessionStatus(rows("The plan: Shift+Tab to manual", "> "))?.mode).toBeUndefined();
  });

  it("cuts the indicator row out of the chat together with the box", () => {
    expect(cut("✦ Done.", "", "Shift+Tab to accept edits", "", "> ", "~/proj  25% used")).toEqual(["✦ Done."]);
    expect(cut("✦ Done.", "YOLO Ctrl+Y", "* ")).toEqual(["✦ Done."]);
  });

  it("keeps unlabelled mode words with the families that always had them", () => {
    expect(modeChoices("accept edits")[0].value).toBe("default");
    expect(modeChoices("yolo")[0].value).toBe("ask permissions");
    expect(modeChoices("yolo", "Gemini").map((choice) => choice.value)).toEqual(family);
    expect(currentMode(modeChoices("accept edits", "Gemini"), "accept edits", true)).toBe("accept edits");
    // A Gemini tab showing a mode its family does not list earns no list.
    expect(modeChoices("full access", "Gemini")).toEqual([]);
  });
});
