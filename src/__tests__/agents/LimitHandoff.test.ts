import { describe, expect, it } from "vitest";
import { cliLimitNoticeLine, hasCliLimitNotice, nextLimitCli } from "../../lib/agents/limitHandoff";

describe("CLI limit handoff", () => {
  it("recognizes the live Claude 429 notice and Codex usage exhaustion", () => {
    expect(hasCliLimitNotice("You've hit your 5-hour limit · resets 10:20pm (Europe/Berlin)")).toBe(true);
    expect(hasCliLimitNotice("  ⎿  You've hit your usage limit. Try again later.")).toBe(true);
    expect(hasCliLimitNotice("Usage limit exceeded.")).toBe(true);
  });
  it("ignores low quota, context warnings and quoted discussion", () => {
    for (const text of ["Less than 5% of your weekly limit left", "Context limit reached", "Explain why you've hit your usage limit", '> Example: usage limit exceeded', "Current session: 99% used"]) {
      expect(hasCliLimitNotice(text)).toBe(false);
    }
  });
  it("returns the matched line cleaned of escapes, control and bidi characters and cut at 160", () => {
    expect(cliLimitNoticeLine("working...\n  \u001b[1mYou've hit your 5-hour limit\u202E · resets 10:20pm\u0007\nnext")).toBe("You've hit your 5-hour limit · resets 10:20pm");
    expect(cliLimitNoticeLine(`Usage limit reached ${"y".repeat(300)}`)?.length).toBe(160);
    expect(cliLimitNoticeLine("Context limit reached")).toBeNull();
  });
  const rows = [
    { bin: "claude", label: "Claude", installed: true },
    { bin: "codex", label: "Codex", installed: true },
    { bin: "gemini", label: "Gemini", installed: false },
    { bin: "vibe", label: "Mistral", installed: true },
  ];
  it("uses the configured order and skips missing CLIs", () => {
    expect(nextLimitCli("claude", rows, ["claude", "gemini", "vibe", "codex"], "claude")?.bin).toBe("vibe");
    expect(nextLimitCli("claude", rows, undefined, "claude")?.bin).toBe("codex");
  });
  it("stops at the end without wrapping or guessing an unknown CLI", () => {
    expect(nextLimitCli("vibe", rows, undefined, "claude")).toBeUndefined();
    expect(nextLimitCli("unknown", rows, undefined, "claude")).toBeUndefined();
  });
});
