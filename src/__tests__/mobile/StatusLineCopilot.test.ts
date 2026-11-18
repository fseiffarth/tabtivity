import { describe, expect, it } from "vitest";
import { copilotFooter, isCopilotTab, readCopilotFrame } from "../../../mobile-web/src/terminal/copilotStatus";
import { currentMode, modeChoices, modeOffered } from "../../../mobile-web/src/terminal/agentModes";
import { inputFrameStart, sessionStatus, statusModelTag } from "../../../mobile-web/src/terminal/statusLine";
import { BRAND } from "../../lib/brand";

/**
 * GitHub Copilot CLI's frame as the phone and the desktop Reader read it. The
 * rows are real ones: GitHub Copilot CLI 1.0.106 to 1.0.112, driven through a
 * pty against a stub model and replayed through the app's emulator, after
 * `readableScreen` (the box's rules, the sidebar's `┃` edge and blank edge rows
 * are gone). Its path and branch sit over the box, the mode and model under it.
 */

const LABEL = "Copilot";
const rows = (...texts: string[]) => texts.map((text) => ({ text }));

/** 1.0.112, 110 columns, a fresh session. */
const IDLE = [
  " ● MCP Servers reloaded: 0 servers connected",
  "",
  " ~/work [⎇ develop]                                           Run on: This computer ctrl+e change environment",
  "❯",
  " ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab                     stub",
];

/** 1.0.112, 60 columns, after a turn: the hints shorten, the gap narrows. */
const NARROW = [
  " ● Operation cancelled by user",
  " ~/work [⎇ develop]",
  "❯",
  " Interactive · Manual Approval · / commands            stub",
];

/** 1.0.112 while a turn runs: the hints are replaced by the working one. */
const BUSY = [
  " ● stub answer done",
  " ❯ STUB:CALL bash {\"command\": \"sleep 8\", \"description\": \"wait\"}                                        12:13",
  " ○ Shell wait",
  "   sleep 8",
  " ~/work [⎇ master]",
  "❯",
  " ○ Working · 49 B ctrl+c interrupt                                                                       stub",
];

describe(`${BRAND.display} Copilot CLI status line`, () => {
  it("reads the path and branch over the box, and the mode and model under it", () => {
    expect(sessionStatus(rows(...IDLE), LABEL)).toEqual({
      path: "~/work",
      branch: "develop",
      mode: "interactive",
      model: "stub",
    });
  });

  it("reads a narrow pane's frame", () => {
    expect(sessionStatus(rows(...NARROW), LABEL)).toEqual({
      path: "~/work",
      branch: "develop",
      mode: "interactive",
      model: "stub",
    });
  });

  it("keeps the model while a turn runs and does not make the working hint a mode", () => {
    const status = sessionStatus(rows(...BUSY), LABEL);
    expect(status).toEqual({ path: "~/work", branch: "master", model: "stub" });
    expect(status?.mode).toBeUndefined();
    expect(copilotFooter(" ● Waiting for background shells · 65 B ctrl+c interrupt                                                 stub"))
      .toEqual({ working: true, model: "stub" });
  });

  it("reads Plan and Autopilot, the Shift+Tab cycle, and the approval beside them", () => {
    const footer = (hints: string) => copilotFooter(` ← open sidebar · ${hints} · / commands · ? help · tab next tab                            stub`);
    expect(footer("Plan · Manual Approval")).toMatchObject({ mode: "plan", approval: "Manual Approval", model: "stub" });
    expect(footer("Autopilot · Manual Approval")).toMatchObject({ mode: "autopilot" });
    expect(footer("Interactive · Assisted Permissions")).toMatchObject({ mode: "interactive", approval: "Assisted Permissions" });
    expect(footer("Plan · Allow All")).toMatchObject({ mode: "plan", approval: "Allow All" });
    // The approval is not the mode: a session in Allow All is not in a mode of that name.
    expect(footer("Interactive · Allow All")?.mode).toBe("interactive");
  });

  it("reads a real model name and the branch without git's marks, with a single-space gap", () => {
    // 1.0.106 at 60 columns: the hint is cut to its ellipsis and the model follows after one space.
    const status = sessionStatus(rows(
      " ~/work [⎇ develop*%]",
      "❯",
      " Interactive · Manual Approval · / comma… claude-sonnet-4.5",
    ), LABEL);
    expect(status).toEqual({ path: "~/work", branch: "develop", mode: "interactive", model: "claude-sonnet-4.5" });
  });

  it("reads the effort and the context used (flipped to left) that /statusline can add", () => {
    // 1.0.112 with the effort and context-used items on; the preview prints `Agent · GPT-5.4 · Medium · (42%)`.
    const status = sessionStatus(rows(
      " octocat:~/workspace/demo-project +128 -42",
      " [⎇ feature/footer-preview] [#1234]      Plan: 76% used · sandbox enabled · YOLO · 2 scheduled",
      "❯",
      " ← open sidebar · Plan · Manual Approval · @ files/sessions · # issues             Agent · GPT-5.4 · Medium · (42%)",
    ), LABEL);
    expect(status).toEqual({
      path: "~/workspace/demo-project",
      branch: "feature/footer-preview",
      mode: "plan",
      model: "GPT-5.4",
      effort: "medium",
      context: "58%",
    });
    expect(statusModelTag(status)).toBe("GPT-5.4 · medium");
    expect(sessionStatus(rows("~/work [⎇ master]".padStart(18), "❯", " Interactive · Manual Approval · / commands     stub · (18%)"), LABEL)?.context).toBe("82%");
  });

  it("reads a pane narrow enough to wrap the info rows item by item", () => {
    const screen = rows(
      " ● MCP Servers reloaded: 0 servers connected",
      " ~/work",
      " [⎇ worktree-agent-a3be6b9936175ca62]",
      " +0 -0      Run on: This computer ctrl+e change environment",
      "❯ ",
      " Autopilot · Allow All · / commands · tab next tab     stub · (18%)",
    );
    expect(sessionStatus(screen, LABEL)).toEqual({
      path: "~/work",
      branch: "worktree-agent-a3be6b9936175ca62",
      mode: "autopilot",
      model: "stub",
      context: "82%",
    });
    expect(inputFrameStart(screen, LABEL)).toBe(1);
  });

  it("reads a draft in the box, whose footer swaps its hints for the completions", () => {
    const status = sessionStatus(rows(
      " ~/work [⎇ master]",
      "❯ rename the helper",
      "  and add a test",
      " Interactive · Manual Approval · @ files/sessions · # issues                                             stub",
    ), LABEL);
    expect(status).toEqual({ path: "~/work", branch: "master", mode: "interactive", model: "stub" });
  });

  it("shows the folder when no git branch is drawn", () => {
    expect(sessionStatus(rows(" ~/notes", "❯", " Interactive · Manual Approval · / commands · ? help                  stub"), LABEL))
      .toEqual({ path: "~/notes", mode: "interactive", model: "stub" });
  });
});

describe(`${BRAND.display} Copilot CLI frame start`, () => {
  it("cuts the info rows and the box out of the reading view, and nothing above them", () => {
    const screen = rows(...IDLE);
    expect(inputFrameStart(screen, LABEL)).toBe(1);
    const busy = rows(...BUSY);
    expect(busy.slice(0, inputFrameStart(busy, LABEL)).map((row) => row.text)).toEqual([
      " ● stub answer done",
      " ❯ STUB:CALL bash {\"command\": \"sleep 8\", \"description\": \"wait\"}                                        12:13",
      " ○ Shell wait",
      "   sleep 8",
    ]);
    const narrow = rows(...NARROW);
    expect(narrow.slice(0, inputFrameStart(narrow, LABEL)).map((row) => row.text)).toEqual([" ● Operation cancelled by user"]);
  });
});

describe(`${BRAND.display} Copilot CLI: output is never status`, () => {
  it("does not take a path in an answer, or an echoed prompt's ❯, for the frame", () => {
    const screen = rows(
      " ❯ where is the config?                                                                                12:13",
      " ● It lives in",
      "   /etc/app/config.toml",
      "   ~/work [⎇ not-this]  Run on: elsewhere",
      " ● stub answer done",
      "",
      " ~/work [⎇ develop]",
      "❯",
      " ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab                     stub",
    );
    expect(sessionStatus(screen, LABEL)).toEqual({ path: "~/work", branch: "develop", mode: "interactive", model: "stub" });
    expect(inputFrameStart(screen, LABEL)).toBe(5);
  });

  it("does not read the answer above a box that has no info rows as a path", () => {
    const status = sessionStatus(rows(
      " ● Done:",
      "   /etc/app/config.toml",
      "❯",
      " Interactive · Manual Approval · / commands                    stub",
    ), LABEL);
    expect(status).toEqual({ mode: "interactive", model: "stub" });
  });

  it("reads nothing off a dialog: an approval question, the folder trust, the /statusline preview", () => {
    expect(sessionStatus(rows(
      " Do you want to create a.txt?",
      "",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for file operations when in this repo",
      "   3. No, and tell Copilot what to do differently (Esc to stop)",
      " ↑/↓ to navigate · enter to select · esc to cancel",
    ), LABEL)).toBeNull();
    expect(sessionStatus(rows(
      "  [⎇ feature/footer-preview] [#1234]      Plan: 76% used · sandbox enabled · YOLO · 2 scheduled",
      " ❯ Summarize the footer preview changes",
      "  @ files/sessions · # issues                                  Agent · GPT-5.4 · Medium · (42%)",
      " ~~~~~~~~~~~~~~~~~~~~ CUSTOM ~~~~~~~~~~~~~~~~~~~~",
      " ↑/↓ nav · enter toggle · esc close",
    ), LABEL)).toBeNull();
    const dialog = rows(" ❯ 1. Yes", "   2. No", " ↑/↓ to navigate · enter to select · esc to cancel");
    expect(inputFrameStart(dialog, LABEL)).toBe(dialog.length);
  });

  it("is a Copilot reader only for a Copilot tab", () => {
    expect(isCopilotTab("Copilot")).toBe(true);
    expect(isCopilotTab("Claude")).toBe(false);
    expect(readCopilotFrame(rows(...IDLE), "Claude")).toBeNull();
    expect(readCopilotFrame(rows(...IDLE))).toBeNull();
    // The same screen in another tab keeps the generic reading (no model token there).
    expect(sessionStatus(rows(...IDLE), "Claude")?.mode).toBeUndefined();
  });
});

describe(`${BRAND.display} Copilot CLI mode choices`, () => {
  it("offers the Shift+Tab cycle and names the mode the footer shows", () => {
    expect(modeOffered("Copilot")).toBe(true);
    const choices = modeChoices("interactive", "Copilot");
    expect(choices.map((choice) => choice.value)).toEqual(["interactive", "plan", "autopilot"]);
    expect(currentMode(choices, "autopilot", true)).toBe("autopilot");
    // A Copilot tab in Plan gets Copilot's list, not Claude Code's.
    expect(modeChoices("plan", "Copilot").map((choice) => choice.value)).toEqual(["interactive", "plan", "autopilot"]);
    expect(modeChoices("plan", "Claude").map((choice) => choice.value)).not.toContain("autopilot");
    // No mode on screen (a turn running) is not a state of the family.
    expect(modeChoices(undefined, "Copilot")).toEqual([]);
  });
});
