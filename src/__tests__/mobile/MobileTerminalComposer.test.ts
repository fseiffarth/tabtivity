import { describe, expect, it } from "vitest";
import {
  AGENT_LINE_RESET,
  PASTE_END,
  PASTE_START,
  agentInputWrites,
  bracketsAgentMessage,
} from "../../../mobile-web/src/terminal/composer";
import { BRAND } from "../../lib/brand";

describe(`${BRAND.display} Mobile agent composer writes`, () => {
  it("keeps the line reset, the text and the submit in separate writes", () => {
    expect(agentInputWrites("fix the mobile terminal")).toEqual([
      AGENT_LINE_RESET,
      "fix the mobile terminal",
      "\r",
    ]);
  });

  it("sends an embedded newline as Ctrl-J so a multi-line draft stays one message", () => {
    expect(agentInputWrites("first line\nsecond line")).toEqual([
      AGENT_LINE_RESET,
      "first line",
      "\n",
      "second line",
      "\r",
    ]);
    // Only the final write may be a carriage return: a `\r` between the lines
    // would submit the draft one line at a time.
    expect(agentInputWrites("a\nb\nc").filter((write) => write === "\r")).toHaveLength(1);
  });

  it("normalizes CRLF, keeps a deliberate blank line, and drops trailing ones", () => {
    expect(agentInputWrites("a\r\n\r\nb")).toEqual([AGENT_LINE_RESET, "a", "\n", "\n", "b", "\r"]);
    expect(agentInputWrites("only line\n\n  ")).toEqual([AGENT_LINE_RESET, "only line", "\r"]);
  });

  it("drops blank lines before the first words, so the first write after the reset is text", () => {
    expect(agentInputWrites("\nfix it")).toEqual([AGENT_LINE_RESET, "fix it", "\r"]);
    expect(agentInputWrites("\r\n  \n\n  indented\nnext")).toEqual([AGENT_LINE_RESET, "  indented", "\n", "next", "\r"]);
    expect(agentInputWrites("\nfix it", true)).toEqual([AGENT_LINE_RESET, `${PASTE_START}fix it${PASTE_END}`, "\r"]);
  });

  it("wraps the draft in bracketed paste markers where the pane has the mode on", () => {
    // The whole message is one write and the submit is another: the closing
    // marker is what keeps a coalesced `text CR` from being read as one paste,
    // which is how a phone's send arrived at a Codex TUI and never submitted.
    expect(agentInputWrites("fix the mobile terminal", true)).toEqual([
      AGENT_LINE_RESET,
      `${PASTE_START}fix the mobile terminal${PASTE_END}`,
      "\r",
    ]);
    expect(agentInputWrites("first line\nsecond line", true)).toEqual([
      AGENT_LINE_RESET,
      `${PASTE_START}first line\nsecond line${PASTE_END}`,
      "\r",
    ]);
  });

  it("types a one-character message as a key press even where the pane pastes", () => {
    // Codex's pager ("q close") only reads keys; a pasted `q` left the phone
    // stuck in it (2026-09-27).
    expect(agentInputWrites("q", true)).toEqual([AGENT_LINE_RESET, "q", "\r"]);
    expect(agentInputWrites("y\n", true)).toEqual([AGENT_LINE_RESET, "y", "\r"]);
    expect(agentInputWrites("ok", true)).toEqual([AGENT_LINE_RESET, `${PASTE_START}ok${PASTE_END}`, "\r"]);
  });

  it("types a Claude Code message instead of pasting it", () => {
    // Claude Code shows any bracketed paste as a `[Pasted text]` block and the
    // model receives it as pasted content, not as the user's own words.
    expect(bracketsAgentMessage("Claude", true)).toBe(false);
    expect(bracketsAgentMessage("claude code", true)).toBe(false);
    expect(bracketsAgentMessage("Codex", true)).toBe(true);
    expect(bracketsAgentMessage(undefined, true)).toBe(true);
    expect(bracketsAgentMessage("Codex", false)).toBe(false);
  });

  it("drops control bytes so a draft cannot close the paste or press keys of its own", () => {
    const hostile = `end\u001b[201~ and \u001b[A up\u0001`;
    expect(agentInputWrites(hostile, true)).toEqual([
      AGENT_LINE_RESET,
      `${PASTE_START}end[201~ and [A up${PASTE_END}`,
      "\r",
    ]);
    expect(agentInputWrites(hostile)).toEqual([AGENT_LINE_RESET, "end[201~ and [A up", "\r"]);
    // A tab would ask the agent's composer to complete rather than indent.
    expect(agentInputWrites("a\tb")).toEqual([AGENT_LINE_RESET, "ab", "\r"]);
  });
});
