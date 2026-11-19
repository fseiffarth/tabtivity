import { describe, expect, it } from "vitest";
import { limitWarning, usageBandRows, usageTone, type UsageResetMark } from "../../lib/agents/agentUsageResets";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { snapToReset, timelineWindow, timelineX } from "../../lib/agents/prompt/timeline";

const now = new Date(2026, 8, 4, 12, 2);
const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute);
const mark = (agent: string, kind: "session" | "week", when: Date, percent = 50): UsageResetMark =>
  ({ key: `${agent}:${kind}:${when.getTime()}`, agent, kind, at: when, labels: [], percent, resets: "" });
const day = timelineWindow("day", "2026-09-04", 1);

describe("usageTone", () => {
  it("is calm below 70, warm from 70, hot from 90", () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(usageTone)).toEqual(["ok", "ok", "warn", "warn", "high", "high"]);
  });
});

describe("usageBandRows", () => {
  it("makes one row per agent: the 5h window from reset - 5h, cut at the view's start, and weekly ticks", () => {
    const rows = usageBandRows([
      mark("claude", "session", at(14, 20), 94),
      mark("claude", "week", at(17)),
      mark("codex", "session", at(2), 20),
      mark("claude", "week", new Date(2026, 8, 7, 9)),
    ], day);
    expect(rows.map((row) => row.agent)).toEqual(["claude", "codex"]);
    expect(rows[0].sessions[0]).toMatchObject({ start: at(9, 20), end: at(14, 20), tone: "high" });
    expect(rows[0].weekly.map((m) => m.at)).toEqual([at(17)]);
    // 02:00 - 5 h is before the day: the bar starts at the view's edge.
    expect(rows[1].sessions[0].start).toEqual(day.start);
    expect(usageBandRows([], day)).toEqual([]);
  });
});

describe("snapToReset", () => {
  const marks = [mark("claude", "session", at(14, 20)), mark("codex", "session", at(14, 20))];
  // 1000px: 41.67px an hour, 10px is 14.4 minutes.
  const near = (minutes: number) => snapToReset(at(14, 20 + minutes), marks, "claude", day, 1000, now);

  it("lands a snapped instant within 10 px of its agent's reset at the first snap minute after it", () => {
    expect(near(5)).toEqual({ at: at(14, 20), reset: "session" });
    expect(near(-10)).toEqual({ at: at(14, 20), reset: "session" });
  });

  it("leaves an instant further than 10 px, another agent's reset and a reset already gone alone", () => {
    expect(near(20)).toBeNull();
    expect(snapToReset(at(14, 20), marks, "gemini", day, 1000, now)).toBeNull();
    expect(snapToReset(at(14, 20), marks, undefined, day, 1000, now)).toBeNull();
    expect(snapToReset(at(11, 20), [mark("claude", "week", at(11, 20))], "claude", day, 1000, now)).toBeNull();
  });

  it("rounds a reset between two minutes up, and measures in px on the folded scale too", () => {
    expect(snapToReset(at(14, 20), [mark("claude", "session", at(14, 21))], "claude", day, 1000, now)?.at).toEqual(at(14, 25));
    const folded = { ...day, fold: { start: day.start, end: at(6), px: 40 } };
    const x = timelineX(at(14, 20), folded, 1000);
    expect(x).toBeCloseTo(40 + 8 * (960 / 18) + (20 / 60) * (960 / 18), 6);
    expect(snapToReset(at(14, 25), marks, "claude", folded, 1000, now)?.at).toEqual(at(14, 20));
  });
});

describe("limitWarning", () => {
  const rule = (when: Date | null, agent = "claude", over: Partial<PromptChartCard> = {}) => ({
    state: "scheduled" as const,
    at: when,
    schedule: { id: "r", enabled: true, message: "m", rule: { type: "once" as const, at: "x" } },
    autoTags: [`agent:${agent}`],
    ...over,
  });
  const marks = [mark("claude", "session", at(14, 20), 94), mark("codex", "session", at(15, 45), 20)];

  it("warns a scheduled card due before its agent's nearly used-up reset, and says where to move it", () => {
    const warning = limitWarning(rule(at(13)), marks, now)!;
    expect(warning.mark.percent).toBe(94);
    expect(warning.moveTo).toEqual(at(14, 20));
  });

  it("does not warn below 90%, after the reset, in the past, for another agent or for a queued card", () => {
    expect(limitWarning(rule(at(13)), [mark("claude", "session", at(14, 20), 89)], now)).toBeNull();
    expect(limitWarning(rule(at(15)), marks, now)).toBeNull();
    expect(limitWarning(rule(at(11)), marks, now)).toBeNull();
    expect(limitWarning(rule(at(13), "codex"), marks, now)).toBeNull();
    expect(limitWarning(rule(at(12), "claude", { state: "queued" }), marks, now)).toBeNull();
    expect(limitWarning(rule(null), marks, now)).toBeNull();
    // A reset already past is no window to wait for.
    expect(limitWarning(rule(at(13)), [mark("claude", "session", at(11), 94)], now)).toBeNull();
    // The weekly window is not the 5h one.
    expect(limitWarning(rule(at(13)), [mark("claude", "week", at(14, 20), 99)], now)).toBeNull();
  });
});
