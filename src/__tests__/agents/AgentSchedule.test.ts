import { afterAll, describe, expect, it } from "vitest";
import {
  latestScheduleOccurrence,
  localWallClock,
  nextScheduleOccurrence,
  relativeToNow,
  scheduleStatus,
  scheduleSummary,
  scheduleVerdict,
  upcomingSchedules,
  type ScheduledAgentPrompt,
} from "../../lib/agents/agentSchedule";

// The DST case needs Europe/Berlin. The zone is set for this file only (vitest
// forks a process per file and Node re-reads `TZ` on assignment), the same way
// `AgentPromptTimelineDst.test.ts` does it. Windows does not honour a runtime
// `TZ` everywhere, so there, and only there, the DST case is skipped.
const { process } = globalThis as unknown as {
  process: { env: Record<string, string | undefined>; platform: string };
};
const previousZone = process.env.TZ;
process.env.TZ = "Europe/Berlin";
const zoneApplied = new Date(2026, 2, 29, 12).getTimezoneOffset() === -120;
const unsupported = !zoneApplied && process.platform === "win32";
if (unsupported) {
  console.warn("AgentSchedule: this platform ignores a runtime TZ, so the Europe/Berlin DST case is skipped");
}

afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

function prompt(rule: ScheduledAgentPrompt["rule"], last?: ScheduledAgentPrompt["last"]): ScheduledAgentPrompt {
  return { id: "schedule-1", enabled: true, message: "Continue", rule, last };
}

describe("per-tab agent schedules", () => {
  it("finds a one-time occurrence and stops it after a receipt", () => {
    const schedule = prompt({ type: "once", at: "2026-09-01T10:00" });
    expect(scheduleVerdict(schedule, new Date(2026, 8, 1, 10, 30)).kind).toBe("wait");
    expect(scheduleVerdict(schedule, new Date(2026, 8, 1, 11, 1)).kind).toBe("missed");
    expect(scheduleVerdict({ ...schedule, last: { occurrence: "2026-09-01T10:00", result: "failed", at: new Date().toISOString() } }, new Date(2026, 8, 1, 10, 30)).kind).toBe("none");
  });

  it("selects only the latest daily occurrence instead of bursting a backlog", () => {
    const schedule = prompt({ type: "daily", time: "09:15" });
    expect(latestScheduleOccurrence(schedule, new Date(2026, 8, 4, 8, 0))?.key).toBe("2026-09-03T09:15");
    expect(latestScheduleOccurrence(schedule, new Date(2026, 8, 4, 12, 0))?.key).toBe("2026-09-04T09:15");
  });

  it("uses ISO weekdays and crosses midnight", () => {
    const schedule = prompt({ type: "weekdays", weekdays: [1, 5], time: "00:00" });
    const friday = new Date(2026, 8, 4, 0, 20);
    expect(latestScheduleOccurrence(schedule, friday)?.key).toBe("2026-09-04T00:00");
    expect(nextScheduleOccurrence(schedule, new Date(2026, 8, 5, 12, 0))?.key).toBe("2026-09-07T00:00");
  });

  it("does not offer a receipt's occurrence twice", () => {
    const schedule = prompt(
      { type: "daily", time: "09:00" },
      { occurrence: "2026-09-01T09:00", result: "delivered", at: "2026-09-01T09:00:10Z" },
    );
    expect(scheduleVerdict(schedule, new Date(2026, 8, 1, 9, 10)).kind).toBe("none");
    expect(scheduleVerdict(schedule, new Date(2026, 8, 2, 9, 10)).kind).toBe("wait");
  });

  it("does not replay an older wall-clock slot after the host clock moves back", () => {
    const schedule = prompt(
      { type: "daily", time: "09:00" },
      { occurrence: "2026-09-02T09:00", result: "delivered", at: "2026-09-02T09:00:10Z" },
    );
    expect(scheduleVerdict(schedule, new Date(2026, 8, 1, 9, 30)).kind).toBe("none");
  });

  it("rejects a calendar-normalized wall-clock value", () => {
    expect(localWallClock("2026-02-30T10:00")).toBeNull();
  });

  it.skipIf(unsupported)("rejects a wall-clock time inside the spring-forward gap, keeps the repeated hour (Europe/Berlin)", () => {
    // Canary: the zone really applied, so the gap below exists.
    expect(new Date(2026, 2, 28, 12).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 2, 29, 12).getTimezoneOffset()).toBe(-120);
    expect(localWallClock("2026-03-29T02:30")).toBeNull();
    expect(localWallClock("2026-10-25T02:30")).not.toBeNull();
  });
});

/**
 * The status column: one word per row for what a schedule is *doing*, which the
 * bare rule + next-run stamp could never say. The two states that were entirely
 * invisible before — switched off, and due-but-waiting for the agent to fall
 * idle — are the ones pinned hardest here, and so is the precedence between a
 * recorded result and a future occurrence (a daily rule that failed this morning
 * is "scheduled" for tomorrow, not "failed" forever).
 */
describe("schedule status", () => {
  it("reads an off switch before anything else, and still names the hour it would run", () => {
    const schedule = { ...prompt({ type: "daily", time: "09:00" }), enabled: false };
    const status = scheduleStatus(schedule, new Date(2026, 8, 1, 12, 0));
    expect(status.kind).toBe("paused");
    expect(status.at?.getHours()).toBe(9);
  });

  it("says due while the occurrence waits inside the catch-up window", () => {
    const schedule = prompt({ type: "daily", time: "09:00" });
    expect(scheduleStatus(schedule, new Date(2026, 8, 1, 9, 30)).kind).toBe("due");
  });

  it("prefers the next occurrence over a recorded result", () => {
    const schedule = prompt(
      { type: "daily", time: "09:00" },
      { occurrence: "2026-09-01T09:00", result: "failed", at: "2026-09-01T09:00:10Z" },
    );
    expect(scheduleStatus(schedule, new Date(2026, 8, 1, 12, 0)).kind).toBe("armed");
  });

  it("reports a finished one-time prompt by its result, and an un-run past one as expired", () => {
    const done = prompt(
      { type: "once", at: "2026-09-01T09:00" },
      { occurrence: "2026-09-01T09:00", result: "delivered", at: "2026-09-01T09:00:10Z" },
    );
    expect(scheduleStatus(done, new Date(2026, 8, 2, 9, 0)).kind).toBe("delivered");
    const stale = prompt({ type: "once", at: "2026-09-01T09:00" });
    expect(scheduleStatus(stale, new Date(2026, 8, 3, 9, 0)).kind).toBe("expired");
  });

  it("summarizes a tab as enabled-of-total plus the first hour anything fires", () => {
    const now = new Date(2026, 8, 1, 12, 0);
    const summary = scheduleSummary([
      { ...prompt({ type: "daily", time: "09:00" }), id: "a" },
      { ...prompt({ type: "daily", time: "23:00" }), id: "b" },
      { ...prompt({ type: "daily", time: "13:00" }), id: "c", enabled: false },
    ], now);
    expect([summary.total, summary.enabled]).toEqual([3, 2]);
    expect(summary.next?.getHours()).toBe(23);
  });

  it("lists the enabled schedules still to fire, soonest first, up to the limit", () => {
    const now = new Date(2026, 8, 1, 12, 0);
    const upcoming = upcomingSchedules([
      { ...prompt({ type: "daily", time: "09:00" }), id: "a", message: "morning" },
      { ...prompt({ type: "daily", time: "23:00" }), id: "b", message: "night" },
      { ...prompt({ type: "daily", time: "13:00" }), id: "c", message: "off", enabled: false },
      { ...prompt({ type: "once", at: "2026-09-01T08:00" }), id: "d", message: "missed" },
      { ...prompt({ type: "once", at: "2026-09-01T14:00" }), id: "e", message: "soon" },
    ], now, 2);
    expect(upcoming.map((row) => row.message)).toEqual(["soon", "night"]);
  });

  it("counts down in the largest unit that still says something", () => {
    const now = new Date(2026, 8, 1, 12, 0);
    expect(relativeToNow(new Date(2026, 8, 1, 12, 40), now, "en")).toBe("in 40 minutes");
    expect(relativeToNow(new Date(2026, 8, 1, 20, 0), now, "en")).toBe("in 8 hours");
    expect(relativeToNow(new Date(2026, 8, 5, 12, 0), now, "en")).toBe("in 4 days");
    expect(relativeToNow(new Date(2026, 7, 30, 12, 0), now, "en")).toBe("2 days ago");
  });
});
