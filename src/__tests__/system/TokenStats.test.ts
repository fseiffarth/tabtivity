/**
 * Locks the recap's Tokens section folding (`lib/tokenStats`).
 *
 * The backend hands over `tokens.<kind>.<cli>.<model>` counters whose model is
 * everything after the third `.`, so a model name with dots must stay whole.
 * A CLI Tabtivity cannot read must say "not reported" — never a zero row — while a
 * readable CLI that wrote nothing is an honest zero. And a first scan that is
 * still partial is asked again a bounded number of times, never polled.
 */
import { describe, expect, it } from "vitest";
import {
  fetchTokenReport,
  foldTokens,
  formatShare,
  formatTokens,
  grandTotal,
  outputShare,
  parseTokenKey,
  usedAgentClis,
  type TokenReport,
} from "../../lib/tokenStats";
import { sumCounters } from "../../lib/usageRollup";

const SOURCES = ["claude", "codex"];

describe("parseTokenKey", () => {
  it("splits kind, cli and model", () => {
    expect(parseTokenKey("tokens.out.claude.claude-opus-5")).toEqual({
      kind: "output",
      cli: "claude",
      model: "claude-opus-5",
    });
    expect(parseTokenKey("tokens.cache_w.claude.x")?.kind).toBe("cacheWrite");
    expect(parseTokenKey("tokens.cache_r.claude.x")?.kind).toBe("cacheRead");
    expect(parseTokenKey("tokens.in.codex.unknown")?.kind).toBe("fresh");
    expect(parseTokenKey("tokens.total.codex.unknown")?.kind).toBe("total");
  });

  it("keeps a model name with dots whole", () => {
    expect(parseTokenKey("tokens.in.codex.gpt-6.1-sol")).toEqual({
      kind: "fresh",
      cli: "codex",
      model: "gpt-6.1-sol",
    });
    expect(parseTokenKey("tokens.cache_r.claude.claude-opus-4.5.1")?.model).toBe("claude-opus-4.5.1");
  });

  it("rejects other metrics and keys with no model", () => {
    expect(parseTokenKey("agent.prompt.claude")).toBeNull();
    expect(parseTokenKey("tokens.in.claude")).toBeNull();
    expect(parseTokenKey("tokens.in.claude.")).toBeNull();
    expect(parseTokenKey("tokens.bogus.claude.x")).toBeNull();
    // `tokens.in` must not swallow a longer kind that merely shares its start.
    expect(parseTokenKey("tokens.input.claude.x")).toBeNull();
  });
});

describe("foldTokens", () => {
  it("folds by CLI and by model, largest first", () => {
    const rows = foldTokens(
      {
        "tokens.in.claude.opus": 10,
        "tokens.cache_w.claude.opus": 20,
        "tokens.cache_r.claude.opus": 300,
        "tokens.out.claude.opus": 70,
        "tokens.out.claude.haiku": 5,
        "tokens.in.codex.gpt-6.1-sol": 50,
        "tokens.out.codex.gpt-6.1-sol": 50,
        "agent.prompt.claude": 3,
      },
      SOURCES,
    );
    expect(rows.reported.map((r) => r.cli)).toEqual(["claude", "codex"]);
    const claude = rows.reported[0];
    expect(claude.split).toEqual({ fresh: 10, cacheWrite: 20, cacheRead: 300, output: 75, total: 0 });
    expect(claude.models.map((m) => m.model)).toEqual(["opus", "haiku"]);
    expect(claude.models[1].split.output).toBe(5);
    expect(rows.reported[1].models[0].model).toBe("gpt-6.1-sol");
    expect(rows.notReported).toEqual([]);
  });

  it("keeps a Codex total-only row apart from the split", () => {
    const rows = foldTokens({ "tokens.total.codex.unknown": 1234 }, SOURCES);
    const codex = rows.reported[0];
    expect(codex.split).toEqual({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 1234 });
    expect(grandTotal(codex.split)).toBe(1234);
    expect(outputShare(codex.split)).toBeNull();
  });

  it("says not reported for a used CLI it cannot read, zero for one it can", () => {
    const counters = { "agent.tab.gemini": 1, "agent.prompt.opencode": 4, "agent.tab.codex": 1 };
    const rows = foldTokens({}, SOURCES, usedAgentClis(counters));
    expect(rows.notReported).toEqual(["gemini", "opencode"]);
    // Codex is readable and simply wrote nothing: an honest zero row.
    expect(rows.reported).toHaveLength(1);
    expect(rows.reported[0].cli).toBe("codex");
    expect(grandTotal(rows.reported[0].split)).toBe(0);
    // A not-reported CLI never appears as a row at all, so never as 0.
    expect(rows.reported.some((r) => r.cli === "gemini")).toBe(false);
  });

  it("does not list a CLI as not reported once it has tokens", () => {
    // Should a future backend add a source, its tokens win over the list.
    const rows = foldTokens({ "tokens.out.gemini.gemini-3": 9 }, SOURCES, ["gemini"]);
    expect(rows.notReported).toEqual([]);
    expect(rows.reported[0].cli).toBe("gemini");
  });

  it("sums the period's day buckets with the recap's window helper", () => {
    const report: TokenReport = {
      days: {
        "2026-09-29": { "tokens.out.claude.opus": 5 },
        "2026-09-30": { "tokens.out.claude.opus": 7 },
        "2026-10-01": { "tokens.out.claude.opus": 100 },
      },
      hours: {},
      partial: false,
      sources: SOURCES,
    };
    const rows = foldTokens(sumCounters(report.days, ["2026-09-29", "2026-09-30"]), report.sources);
    expect(rows.reported[0].split.output).toBe(12);
  });
});

describe("usedAgentClis", () => {
  it("reads tab and prompt leaves, skipping local models", () => {
    const used = usedAgentClis({
      "agent.tab.claude": 2,
      "agent.tab.local.qwen3:8b": 1,
      "agent.prompt.local.llama3.1:8b": 3,
      "agent.prompt.codex": 1,
      "agent.prompt.gemini": 0,
      "agent.active.aider": 1,
    });
    expect(used.sort()).toEqual(["claude", "codex"]);
  });
});

describe("output share and formatting", () => {
  it("is output over all four split kinds", () => {
    expect(outputShare({ fresh: 10, cacheWrite: 20, cacheRead: 50, output: 20, total: 999 })).toBe(0.2);
    expect(outputShare({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 })).toBeNull();
  });

  it("formats shares", () => {
    expect(formatShare(0.2)).toBe("20%");
    expect(formatShare(0.004)).toBe("0.4%");
    expect(formatShare(0)).toBe("0%");
  });

  it("formats compact numbers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(34_400)).toBe("34k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(999_700)).toBe("1M");
    expect(formatTokens(2_500_000_000)).toBe("2.5B");
  });
});

describe("fetchTokenReport", () => {
  const report = (partial: boolean): TokenReport => ({ hours: {}, days: {}, partial, sources: SOURCES });

  it("asks once when the scan is complete", async () => {
    let calls = 0;
    const seen: boolean[] = [];
    const tries = await fetchTokenReport(
      async () => { calls++; return report(false); },
      (_r, more) => seen.push(more),
      { sleep: async () => {} },
    );
    expect(tries).toBe(1);
    expect(calls).toBe(1);
    expect(seen).toEqual([false]);
  });

  it("asks again while partial, and stops once complete", async () => {
    const answers = [true, true, false];
    const sleeps: number[] = [];
    const seen: boolean[] = [];
    const tries = await fetchTokenReport(
      async () => report(answers.shift()!),
      (_r, more) => seen.push(more),
      { delayMs: 10, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(tries).toBe(3);
    expect(seen).toEqual([true, true, false]);
    expect(sleeps).toEqual([10, 10]);
  });

  it("gives up after the cap even when still partial", async () => {
    let calls = 0;
    const seen: boolean[] = [];
    const tries = await fetchTokenReport(
      async () => { calls++; return report(true); },
      (r, more) => seen.push(more && r.partial),
      { maxTries: 5, sleep: async () => {} },
    );
    expect(tries).toBe(5);
    expect(calls).toBe(5);
    expect(seen).toEqual([true, true, true, true, false]);
  });

  it("stops between asks once cancelled", async () => {
    let cancelled = false;
    let calls = 0;
    await fetchTokenReport(
      async () => { calls++; return report(true); },
      () => {},
      { sleep: async () => { cancelled = true; }, isCancelled: () => cancelled },
    );
    expect(calls).toBe(1);
  });

  it("rejects when an ask fails", async () => {
    await expect(
      fetchTokenReport(async () => { throw new Error("boom"); }, () => {}, { sleep: async () => {} }),
    ).rejects.toThrow("boom");
  });
});
