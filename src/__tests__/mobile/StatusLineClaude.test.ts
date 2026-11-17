import { describe, expect, it } from "vitest";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { BRAND } from "../../lib/brand";

// Rows are copied from Claude Code 2.1.318-2.1.325 frames (tmux harness,
// 100-120 columns), with the user, host and folders made up.
const RULE = "─".repeat(100);
const lines = (...texts: string[]) => texts.map((text) => ({ text }));
/** `readableScreen` drops a rule and keeps its label as a row of its own, the
 * rule itself in `frameText`. */
const ruleLabel = (label: string) => ({ text: label, frameText: `${RULE} ${label} ─` });

describe(`${BRAND.display} Claude Code status line`, () => {
  it("reads the effort hint over the box, under a custom statusline", () => {
    const frame = [
      { text: "● Done." },
      { text: "" },
      { text: "                                                  ● high · /effort" },
      ruleLabel("probe-model"),
      { text: '❯ Try "how do I log an error?"' },
      { text: "  me@box:~/work (develop) · Opu…" },
      { text: "  ⏵⏵ auto mode on (shift+tab to cycle) · gh auth login for PR status · ← 1 agent" },
    ];
    // The model is cut by the statusline's own width: nothing to read, and the
    // name in the box's rule is the session's, never the model's.
    expect(sessionStatus(frame, "Claude")).toEqual({
      path: "~/work", branch: "develop", mode: "auto", effort: "high",
    });
    // The hint and the rule's label are the frame's, not the answer's.
    expect(inputFrameStart(frame, "Claude")).toBe(1);
  });

  it("reads the hint over a busy frame without the spinner", () => {
    const frame = lines(
      "✽ Creating… (running UserPromptSubmit hooks… 2/3 · 2s)",
      "                                  ◐ medium · /effort",
      "❯",
      "  me@box:~/work (develop*) · Opus 5.5",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
    );
    expect(sessionStatus(frame, "Claude")).toEqual({
      path: "~/work", branch: "develop", model: "Opus 5.5", mode: "auto", effort: "medium",
    });
    expect(inputFrameStart(frame, "Claude")).toBe(1);
  });

  it("reads the hint at the end of the stock footer, and not as a path", () => {
    const frame = lines(
      "▝▜██████▀  Haiku 5.5 · Claude Max",
      "",
      '❯ Try "refactor untested.ts"',
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents                           ◐ medium · /effort",
    );
    expect(sessionStatus(frame, "Claude")).toEqual({ mode: "auto", effort: "medium" });
  });

  it("reads `manual mode on` as the default mode", () => {
    expect(sessionStatus(lines(
      "❯ ",
      "  me@box:~/work (develop) · Ha…",
      "  ⏸ manual mode on · gh auth login for PR status · ← 1 agent",
    ), "Claude")).toEqual({ path: "~/work", branch: "develop", mode: "default" });
  });

  it("leaves a path the statusline cut at the pane's width out", () => {
    // 44 columns: the path and the rest of the row end in an ellipsis.
    expect(sessionStatus(lines(
      '❯ Try "write a test for en.ts"',
      "  me@box:~/work/pro…",
      "  ⏵⏵ auto mode on · gh auth login for PR",
    ), "Claude")).toEqual({ mode: "auto" });
  });

  it("does not take tmux's notice under the footer for a path", () => {
    expect(sessionStatus(lines(
      "❯",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · gh auth login for PR status · ← 1 agent",
      "  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tra…",
    ), "Claude")).toEqual({ mode: "auto" });
  });

  it("takes the `/model` picker's More models row for a dialog, not the box", () => {
    const picker = lines(
      "  Select model",
      "    1.  Default (recommended)  Fable 5.2",
      "    2.  Opus 5.5 ✔             For complex work and everyday tasks",
      "  ❯ ▸   More models",
      "",
      "  Enter to expand · Esc to cancel",
    );
    expect(sessionStatus(picker, "Claude")).toBeNull();
    expect(inputFrameStart(picker, "Claude")).toBe(picker.length);
  });

  it("does not read a mention of the command in output as the hint", () => {
    const frame = lines(
      "● Run it as ◐ medium · /effort and compare",
      "",
      "❯",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    );
    expect(sessionStatus(frame, "Claude")?.effort).toBeUndefined();
    // Only the blank row above the box joins the frame; the sentence stays.
    expect(inputFrameStart(frame, "Claude")).toBe(1);
  });

  it("keeps the effort off a row higher up the conversation", () => {
    const frame = lines(
      "                                  ◐ medium · /effort",
      "● Here is the answer.",
      "",
      "❯",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    );
    expect(sessionStatus(frame, "Claude")?.effort).toBeUndefined();
  });
});
