import { describe, expect, it } from "vitest";
import { readReaderLive } from "../../lib/agents/readerLive";
import { changesOffered, readerOffered, readerRequest } from "../../lib/agents/agentReader";
import { busyRow } from "../../../mobile-web/src/terminal/agentBusy";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

const RULE = "─".repeat(120);
const row = (left: string, right = "") => `${left.padEnd(120 - right.length)}${right}`;

/** Copilot CLI 1.0.103's alternate screen after a prompt, drawn through xterm
 * from a pty capture (a stub model answering slowly): the echoed prompt with
 * its time, the folder, the boxed input and the footer, whose first cell is the
 * cycling working glyph and the verb with Copilot's own key hint. */
const WORKING = [
  row(" [Current]  Sessions   Issues   Pull requests   Gists"),
  "",
  row(" ❯ count to ten", "08:34"),
  "",
  " /work",
  RULE,
  "❯",
  RULE,
  row(" ◎ Working esc esc edit prompt", "stub"),
];

/** The same screen once the answer is in: the footer is the idle key hints. */
const IDLE = [
  row(" [Current]  Sessions   Issues   Pull requests   Gists"),
  "",
  row(" ❯ count to ten", "08:34"),
  "",
  " ● Slow answer.",
  "",
  " /work",
  RULE,
  "❯",
  RULE,
  row(" ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab", "stub"),
];

/** A `bash` call waiting on approval (Manual Approval mode). */
const APPROVAL = [
  row(" ❯ make a file", "08:36"),
  "",
  " ● Let me run a command.",
  "",
  row(" $ Shell Say hello", "6s"),
  "   touch approve-me.txt && echo done",
  "",
  "╭" + "─".repeat(118) + "╮",
  "│ " + "Say hello".padEnd(116) + " │",
  "│ " + "─".repeat(116) + " │",
  "│ ╭" + "─".repeat(114) + "╮ │",
  "│ │ " + "touch approve-me.txt && echo done".padEnd(112) + " │ │",
  "│ ╰" + "─".repeat(114) + "╯ │",
  "│ " + " ".repeat(116) + " │",
  "│ " + "Do you want to run this command?".padEnd(116) + " │",
  "│ " + " ".repeat(116) + " │",
  "│ " + "❯ 1. Yes".padEnd(116) + " │",
  "│ " + "  2. Yes, and don't ask again for `touch` in this directory (/work)".padEnd(116) + " │",
  "│ " + "  3. No, and tell Copilot what to do differently (Esc to stop)".padEnd(116) + " │",
  "│ " + " ".repeat(116) + " │",
  "│ " + "↑/↓ to navigate · enter to select · esc to cancel".padEnd(116) + " │",
  "╰" + "─".repeat(118) + "╯",
];

describe("Copilot's screen in the Reader", () => {
  it("reads the footer's working row as work, and the idle footer as none", () => {
    expect(busyRow(" ◎ Working esc esc edit prompt                        stub")).toBe(true);
    expect(busyRow(" ○ Reading files esc esc edit prompt")).toBe(true);
    expect(busyRow(" ← open sidebar · Interactive · Manual Approval · / commands · ? help")).toBe(false);
    expect(readReaderLive(plainBuffer(WORKING), "Copilot", 120).working).not.toBeNull();
    const idle = readReaderLive(plainBuffer(IDLE), "Copilot", 120);
    expect(idle.working).toBeNull();
    expect(idle.question).toBeNull();
    expect(idle.stray).toBe(false);
  });

  it("reads the approval dialog as a question with its three answers", () => {
    const live = readReaderLive(plainBuffer(APPROVAL), "Copilot", 120);
    expect(live.ask).toEqual(["Do you want to run this command?"]);
    expect(live.question?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, and don't ask again for `touch` in this directory (/work)",
      "No, and tell Copilot what to do differently (Esc to stop)",
    ]);
    expect(live.working).toBeNull();
  });
});

describe("Copilot as a Reader agent", () => {
  const tab: Parameters<typeof readerRequest>[1] = {
    kind: "agent", cmd: "copilot", sessionId: "11111111-2222-4333-8444-555555555555", launchedAt: 1, args: [], cwd: "/work",
  };

  it("offers the Chat view, Diffs and a read by the tab's session id", () => {
    expect(readerOffered(tab)).toBe(true);
    expect(changesOffered("copilot")).toBe(true);
    const request = readerRequest("p1", tab, undefined, undefined, 60);
    expect(request).toMatchObject({ agent: "copilot", sessionId: tab.sessionId, tabDir: "/work", projectId: "p1", chat: null });
    // No session id minted yet: nothing to name.
    expect(readerRequest("p1", { ...tab, sessionId: undefined }, undefined, undefined, 60)).toBeNull();
  });
});
