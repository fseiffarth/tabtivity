import { describe, expect, it } from "vitest";
import { overviewMeters, planLabel, type CliOverviewRow } from "../../../shared/cliOverview";

describe("planLabel", () => {
  it("names Claude's Max multiple from its tier", () => {
    expect(planLabel({ name: "max", tier: "default_claude_max_5x" })).toBe("Max 5x");
    expect(planLabel({ name: "max", tier: "default_claude_max_20x" })).toBe("Max 20x");
  });

  it("title-cases every other plan, unknown ones too", () => {
    expect(planLabel({ name: "pro" })).toBe("Pro");
    expect(planLabel({ name: "plus" })).toBe("Plus");
    expect(planLabel({ name: "team_plus" })).toBe("Team Plus");
  });
});

describe("overviewMeters", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const base: CliOverviewRow = { id: "codex", label: "Codex", signedIn: true };

  it("reads every window Claude's panel names", () => {
    const row: CliOverviewRow = {
      ...base,
      id: "claude",
      usage: { raw: "Current session: 41% used · resets 6:20pm\nCurrent week (all models): 22% used · resets Mon 9am\nCurrent week (Fable): 5% used", cached: false },
    };
    expect(overviewMeters(row, now).map((m) => [m.label, m.percent])).toEqual([
      ["Current session", 41],
      ["Current week (all models)", 22],
      ["Current week (Fable)", 5],
    ]);
  });

  it("drops a Codex window that has rolled over since its last turn", () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    const row: CliOverviewRow = {
      ...base,
      limits: { session: { used: 80, resetsAt: at("2026-10-28T11:00:00Z") }, week: { used: 30, resetsAt: at("2026-11-01T00:00:00Z") }, readAt: at("2026-10-28T09:00:00Z") },
    };
    const meters = overviewMeters(row, now);
    expect(meters).toHaveLength(1);
    expect(meters[0].percent).toBe(30);
    expect(meters[0].resets).toBeTruthy();
  });

  it("is empty for a CLI that reports nothing", () => {
    expect(overviewMeters(base, now)).toEqual([]);
  });
});
