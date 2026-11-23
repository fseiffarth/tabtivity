import { describe, expect, it } from "vitest";
import { boxHidesDialog, readLiveQuestion } from "../../../mobile-web/src/terminal/liveDialog";
import { isLiveEcho } from "../../../mobile-web/src/terminal/chatTurns";
import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { inputFrameStart } from "../../../mobile-web/src/terminal/statusLine";

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

/** What the phone's Focus makes of a screen (`Terminal.tsx`'s `liveTail` and
 * `liveQuestion`): the rows after the last echoed prompt with the input frame
 * cut off, read with the whole screen beside them. */
function phoneReads(rows: string[], agentLabel: string) {
  const { lines } = readableScreen(plainBuffer(rows), 300);
  const screen = lines.slice(0, inputFrameStart(lines, agentLabel));
  let start = 0;
  screen.forEach((line, index) => { if (isLiveEcho(line, agentLabel)) start = index + 1; });
  return readLiveQuestion(screen.slice(start), lines, agentLabel, 76);
}

const BOX = [`${"─".repeat(60)} my-project ─`, "❯ ", "─".repeat(76), "  ? for shortcuts"];

describe("the phone's live question", () => {
  it("reads a `>`-led numbered list above Claude Code's input box as output", () => {
    const rows = ["❯ which container?", "", "⏺ Three options:", "", "  > 1. Use a map", "    2. Use a vec", "    3. Use a set", "", ...BOX];
    expect(phoneReads(rows, "Claude")).toBeNull();
    expect(phoneReads(rows, "claude")).toBeNull();
  });

  it("reads the same rows as a dialog where the box is gone", () => {
    const rows = ["❯ which container?", "", "⏺ Which one?", "", "  ❯ 1. Use a map", "    2. Use a vec", "    3. Use a set", "", "  Enter to select · ↑/↓ to navigate · Esc to cancel"];
    expect(phoneReads(rows, "Claude")?.options.map((option) => option.label)).toEqual(["Use a map", "Use a vec", "Use a set"]);
  });

  it("reads a permission prompt under the session's labelled rule", () => {
    const rows = [
      "❯ remove the old file", "", "  Removing probe-file", "", "─".repeat(76), " Bash command", " rm -f probe-file", "",
      " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend", `${"─".repeat(60)} my-project ─`,
    ];
    expect(phoneReads(rows, "Claude")?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  it("reads a first-run screen that holds no box as a question", () => {
    const rows = ["Choose the text style that looks best with your terminal", "", " ❯ 1. Dark mode ✔", "   2. Light mode", "", " Enter to confirm · Esc to cancel"];
    expect(phoneReads(rows, "Claude")?.options).toHaveLength(2);
  });

  it("only Claude Code's box rules a dialog out", () => {
    expect(boxHidesDialog("Claude", true)).toBe(true);
    expect(boxHidesDialog("Claude", false)).toBe(false);
    for (const label of ["Codex", "OpenCode", "Copilot", "Gemini", undefined]) expect(boxHidesDialog(label, true)).toBe(false);
  });
});

describe("the phone's live question on OpenCode's notice", () => {
  it("reads 2.4.0's What's new as a one-row dialog with its own text", () => {
    const pad = " ".repeat(33);
    const box = " ".repeat(23);
    const rows = [
      "",
      `${pad}What's new in 2.4.0${" ".repeat(32)}esc   `,
      "",
      `${pad}Built-In Desktop Browser`,
      `${box}┃  Ask    automation. Set "automations": false in your config if`,
      `${box}~/work:   When a connected provider has a video model, the agent   commands`,
      "",
      `${" ".repeat(79)}ok enter   `,
      "",
      `${" ".repeat(113)}2.4.0`,
    ];
    const question = phoneReads(rows, "OpenCode");
    expect(question?.title).toBe("What's new in 2.4.0");
    expect(question?.options.map((option) => [option.label, option.keys])).toEqual([["OK", ["\r"]]]);
    expect(question?.body).toEqual([
      "Built-In Desktop Browser",
      "automation. Set \"automations\": false in your config if",
      "When a connected provider has a video model, the agent",
    ]);
  });
});
