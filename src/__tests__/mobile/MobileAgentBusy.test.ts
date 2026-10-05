import { describe, expect, it } from "vitest";
import { agentWork, agentWorking } from "../../../mobile-web/src/terminal/agentBusy";
import { BRAND } from "../../lib/brand";

const rows = (...text: string[]) => text.map((line) => ({ text: line }));

describe(`${BRAND.display} Mobile agent busy reader`, () => {
  it("reads each family's working hint", () => {
    expect(agentWorking(rows("⏺ Reading files", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"))).toBe(true);
    expect(agentWorking(rows("✻ Pondering… (esc to interrupt)", "> "))).toBe(true);
    expect(agentWorking(rows("› fix the tests", "• Working (0s • esc to interrupt)"))).toBe(true);
    expect(agentWorking(rows("⠏ Thinking about it (esc to cancel, 3s)", "> Type your message"))).toBe(true);
    expect(agentWorking(rows(" BUILD  ⬝⬝■■  esc interrupt"))).toBe(true);
    // OpenCode's full TUI: the hint is a column, with context and keys after it.
    expect(agentWorking(rows(" ⬝⬝■■■⬝⬝⬝ esc interrupt          12.3K (5%)  ctrl+p commands"))).toBe(true);
    expect(agentWorking(rows(" ⬝⬝■■■⬝⬝⬝ esc again to interrupt          ctrl+p commands"))).toBe(true);
    // Claude Code 2.1.278: no hint in the spinner row any more.
    expect(agentWorking(rows("✶ Cascading… (36s · ↓ 2.1k tokens)", "  ⎿  Tip: Use /permissions to pre-approve", "❯ ", "  ⏵⏵ auto mode on (shift+tab to cycle)"))).toBe(true);
    expect(agentWorking(rows("✢ Reticulating… (1m 4s · ↑ 310 tokens · thinking)", "❯ "))).toBe(true);
  });

  it("stays idle for a finished turn, a dialog, and prose about the key", () => {
    expect(agentWorking(rows("⏺ Done.", "> ", "  ? for shortcuts"))).toBe(false);
    expect(agentWorking(rows("Pick a model", "❯ 1. Opus", "  2. Sonnet", "Esc to cancel"))).toBe(false);
    expect(agentWorking(rows("⏺ Press Esc to interrupt is the one you want.", "> "))).toBe(false);
    expect(agentWorking(rows("✻ Worked for 7m 59s · done 18:36", "❯ "))).toBe(false);
    expect(agentWorking(rows("  · Next: wire the loader…", "* Pending… (see above)", "❯ "))).toBe(false);
  });

  it("only reads the bottom of the screen", () => {
    const stale = ["✻ Thinking… (2s · esc to interrupt)", ...Array.from({ length: 30 }, () => "output")];
    expect(agentWorking(rows(...stale))).toBe(false);
  });

  it("reads the elapsed time and the tokens the busy row prints", () => {
    expect(agentWork(rows("✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> "))).toEqual({ elapsed: "9s", tokens: "1.2k" });
    expect(agentWork(rows("✶ Cascading… (36s · ↓ 2.1k tokens)", "❯ "))).toEqual({ elapsed: "36s", tokens: "2.1k" });
    expect(agentWork(rows("✢ Reticulating… (1m 4s · ↑ 310 tokens · thinking)", "❯ "))).toEqual({ elapsed: "1m 4s", tokens: "310" });
    expect(agentWork(rows("✻ Pondering… (12s · ↓ 3.4k tokens · thinking with high effort)", "❯ "))).toEqual({ elapsed: "12s", tokens: "3.4k", effort: "high" });
    expect(agentWork(rows("› fix the tests", "• Working (0s • esc to interrupt)"))).toEqual({ elapsed: "0s", tokens: undefined });
    expect(agentWork(rows("⠏ Thinking about it (esc to cancel, 3s)", "> Type your message"))).toEqual({ elapsed: "3s", tokens: undefined });
  });

  it("leaves the facts out when the row carries none", () => {
    // A hint with no timer, and OpenCode's status row — whose `223.0K` is the
    // context it holds, not what this turn spent.
    expect(agentWork(rows("✻ Pondering… (esc to interrupt)", "> "))).toEqual({ elapsed: undefined, tokens: undefined });
    expect(agentWork(rows(" BUILD  223.0K (21%) · ctrl+p cmd  ⬝⬝■■  esc interrupt"))).toEqual({ elapsed: undefined, tokens: undefined });
    expect(agentWork(rows("⏺ Done.", "> ", "  ? for shortcuts"))).toBeNull();
  });
});
