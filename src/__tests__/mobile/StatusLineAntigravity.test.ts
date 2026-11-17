import { describe, expect, it } from "vitest";
import { currentMode, modeChoices, modeOffered } from "../../../mobile-web/src/terminal/agentModes";
import { antigravityFooter } from "../../../mobile-web/src/terminal/antigravity";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import type { ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

/**
 * Antigravity 1.5.9's whole live frame, rows copied from captures at 80, 56,
 * 44 and 42 columns (`tmux` pane, `--mode`/Shift+Tab, offline stub). The frame
 * draws the model, the effort and — off the default mode — the permission mode
 * in its footer, and nothing else: no path, branch or context (the folder is
 * only in the startup banner, which scrolls away, and is not read).
 */

let seq = 0;
const lines = (...texts: string[]): ReadableLine[] =>
  texts.map((text) => ({ key: `l${seq += 1}`, text, spans: text ? [{ text }] : [] }));

const LABEL = "Google Antigravity";

describe(`${BRAND.display} Mobile — Antigravity's footer: model, effort and mode`, () => {
  it("reads the idle footer of the default mode with no mode", () => {
    expect(sessionStatus(lines(">", "? for shortcuts                                             Gemini 3.1 Pro · low"), LABEL))
      .toEqual({ model: "Gemini 3.1 Pro", effort: "low" });
  });

  it("reads plan and accept-edits off the footer's first column, idle and busy", () => {
    // Shift+Tab walks default -> accept-edits -> plan -> default; the box's
    // placeholder names the mode too, the footer is the reading.
    expect(sessionStatus(lines(
      "> Plan mode: research & plan only (shift+tab to cycle)",
      "? for shortcuts                                      plan · Gemini 3.1 Pro · low",
    ), LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low", mode: "plan" });
    expect(sessionStatus(lines(
      "> Accept-edits mode: file edits auto-approved (shift+tab to cycle)",
      "? for shortcuts                              accept-edits · Gemini 3.1 Pro · low",
    ), LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low", mode: "accept-edits" });
    expect(sessionStatus(lines(
      "> /plan STUB:SLOW 6 hello",
      "⣽  Generating...",
      ">",
      "esc to cancel                                        plan · Gemini 3.1 Pro · low",
    ), LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low", mode: "plan" });
  });

  it("reads a busy footer on a narrow pane, where a two-space gap is all the mode has", () => {
    expect(sessionStatus(lines(
      "> /plan STUB:SLOW 6 hello",
      "⣽  Generating...",
      ">",
      "esc to cancel  plan · Gemini 3.1 Pro · low",
    ), LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low", mode: "plan" });
    expect(sessionStatus(lines(
      ">",
      "esc to cancel           Gemini 3.1 Pro · low",
    ), LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low" });
  });

  it("reads nothing where a narrow pane drops the model and the mode with it", () => {
    // 42 columns, plan mode, idle: only the hint fits. The mode is simply not
    // on screen; it is not guessed from the box's truncated placeholder.
    expect(sessionStatus(lines("> Plan mode: research & plan only (shi...", "? for shortcuts"), LABEL)).toEqual({});
    expect(sessionStatus(lines(">", "  Press up to edit queued messages"), LABEL)).toEqual({});
  });

  it("reads a mode and a model that has no effort", () => {
    expect(antigravityFooter("? for shortcuts                       plan · Claude Sonnet 4.6 (Thinking)"))
      .toEqual({ model: "Claude Sonnet 4.6 (Thinking)", mode: "plan" });
    expect(antigravityFooter("? for shortcuts                                    Gemini 4 Hydrogen · high"))
      .toEqual({ model: "Gemini 4 Hydrogen", effort: "high" });
  });

  it("does not take output text, the gauge or a banner row for a mode", () => {
    // Prose above the frame never reaches the footer reader, and a lowercase
    // word beside a lowercase word is not a model.
    expect(antigravityFooter("plan · low")).toBeNull();
    expect(antigravityFooter("  stub answer done")).toBeNull();
    expect(antigravityFooter("        low      medium      high       xhigh")).toBeNull();
    expect(sessionStatus(lines(
      "I will switch to plan · Gemini 3.1 Pro · low and continue.",
      "",
      ">",
      "? for shortcuts                                             Gemini 3.1 Pro · low",
    ), LABEL)).toEqual({ model: "Gemini 3.1 Pro", effort: "low" });
    // Another family's tab keeps its own reader.
    expect(sessionStatus(lines(">", "? for shortcuts      plan · Gemini 3.1 Pro · low"), "Google Gemini")?.mode).not.toBe("plan");
  });

  it("cuts the frame at the box, whether the mode placeholder or the output is above it", () => {
    expect(inputFrameStart(lines("Done.", "", "> Plan mode: research & plan only (shift+tab to cycle)",
      "? for shortcuts                                      plan · Gemini 3.1 Pro · low"), LABEL)).toBe(1);
    expect(inputFrameStart(lines("  stub answer done", "", ">", "? for shortcuts                                             Gemini 3.1 Pro · low"), LABEL)).toBe(1);
  });
});

describe(`${BRAND.display} Mobile — Antigravity's mode chip`, () => {
  it("offers its three-mode cycle for a tab that names it, plan being a labelled word", () => {
    expect(modeOffered(LABEL)).toBe(true);
    expect(modeChoices("plan", LABEL).map((choice) => choice.value)).toEqual(["default", "accept-edits", "plan"]);
    expect(modeChoices("accept-edits", LABEL).map((choice) => choice.value)).toEqual(["default", "accept-edits", "plan"]);
    // No word on a framed screen is the default mode; unlabelled, "plan" stays Claude's.
    expect(currentMode(modeChoices(undefined, LABEL), undefined, true)).toBe("default");
    expect(currentMode(modeChoices("plan", LABEL), "plan", true)).toBe("plan");
    expect(modeChoices("plan").map((choice) => choice.value)).toContain("accept edits");
    expect(modeChoices("accept-edits")).toEqual([]);
  });
});
