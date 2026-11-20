import { describe, expect, it } from "vitest";
import { cliLimitNoticeLine, hasCliLimitNotice, limitNoticeReset, nextLimitCli } from "../../lib/agents/limitHandoff";

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

describe("limitNoticeReset", () => {
  /** Tuesday 14:00 local. */
  const NOW = new Date(2026, 8, 1, 14, 0, 0, 0);
  const COMPOSER = ["╭────╮", "│ >  │", "╰────╯", "  ? for shortcuts"];

  it("reads a clock time, and Codex's ordinal date form", () => {
    expect(limitNoticeReset(["■ You've hit your usage limit. Upgrade to Plus (https://example.invalid/pricing), or try again at 4:30 PM.", ...COMPOSER].join("\n"), NOW))
      .toMatchObject({ resets: "4:30 PM", at: new Date(2026, 8, 1, 16, 30) });
    expect(limitNoticeReset("You've hit your usage limit. Try again at Sep 3rd, 2026 9:05 AM.", NOW)?.at)
      .toEqual(new Date(2026, 8, 3, 9, 5));
    expect(limitNoticeReset("You've hit your 5-hour limit · resets 6pm (UTC)", NOW)?.at)
      .toEqual(new Date(Date.UTC(2026, 8, 1, 18, 0)) > NOW ? new Date(Date.UTC(2026, 8, 1, 18, 0)) : new Date(Date.UTC(2026, 8, 2, 18, 0)));
  });

  it("reads a duration, including one wrapped onto the next line", () => {
    expect(limitNoticeReset("Rate limit exceeded. Retry in 2h 5m.", NOW)?.at).toEqual(new Date(NOW.getTime() + 125 * 60_000));
    expect(limitNoticeReset(["Quota exceeded for this model. Please try again", "in 1 hour and 30 minutes.", ...COMPOSER].join("\n"), NOW)?.at)
      .toEqual(new Date(NOW.getTime() + 90 * 60_000));
    expect(limitNoticeReset("Rate limit exceeded, retry in 45s", NOW)?.at).toEqual(new Date(NOW.getTime() + 45_000));
  });

  it("finds a notice without a time, and says it named none", () => {
    expect(limitNoticeReset(["  ⎿  You've hit your usage limit. Try again later.", ...COMPOSER].join("\n"), NOW)).toEqual({ line: "⎿ You've hit your usage limit. Try again later." });
  });

  it("ignores a notice the session has scrolled past, and non-notices", () => {
    const past = ["Usage limit reached. Try again at 4:30 PM.", ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join("\n");
    expect(limitNoticeReset(past, NOW)).toBeNull();
    expect(limitNoticeReset("Context limit reached", NOW)).toBeNull();
    expect(limitNoticeReset("Explain why you've hit your usage limit at 4:30 PM", NOW)).toBeNull();
  });
});
