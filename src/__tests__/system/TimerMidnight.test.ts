/**
 * The time tracker books a run only for the part of it that falls on today
 * (UTC — the backend's `time_log.json` day). `flush` always clamped at
 * midnight; `toggle` (pause) and `setProject` (switch) used to book the whole
 * `now - startedAt`, so pausing in the morning after a run left going overnight
 * filed yesterday evening's hours under today.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { elapsedToday, useTimerStore } from "../../stores/timer";

const MIDNIGHT = Date.UTC(2026, 9, 12); // 2026-10-12T00:00:00Z
const HOUR = 3_600_000;

/** The seconds each flush command booked, by command. */
function booked(cmd: string): number[] {
  return invoke.mock.calls
    .filter((c) => c[0] === cmd)
    .map((c) => (c[1] as { secs: number }).secs);
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "get_time_today" ? 0 : undefined),
  );
  // Started at 22:00 yesterday with 5 h already on yesterday's books.
  useTimerStore.setState({
    paused: false,
    appStartedAt: MIDNIGHT - 2 * HOUR,
    appCommittedSecs: 5 * 3600,
    projectStartedAt: MIDNIGHT - 2 * HOUR,
    projectCommittedSecs: 4 * 3600,
    activeProjectId: "p1",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("elapsedToday", () => {
  it("is the whole run when it started today", () => {
    expect(elapsedToday(MIDNIGHT + HOUR, MIDNIGHT + 3 * HOUR)).toBe(2 * 3600);
  });

  it("is only the part since UTC midnight for a run started yesterday", () => {
    expect(elapsedToday(MIDNIGHT - 2 * HOUR, MIDNIGHT + HOUR)).toBe(3600);
  });

  it("is zero for no run, and never negative", () => {
    expect(elapsedToday(null, MIDNIGHT)).toBe(0);
    expect(elapsedToday(MIDNIGHT + HOUR, MIDNIGHT)).toBe(0);
  });
});

describe("timer across midnight", () => {
  it("toggle (pause) books only today's hour, and today's total starts fresh", async () => {
    vi.setSystemTime(MIDNIGHT + HOUR); // 01:00, three hours after the start
    await useTimerStore.getState().toggle();

    expect(booked("timer_flush_app")).toEqual([3600]);
    expect(booked("timer_flush_project")).toEqual([3600]);
    const s = useTimerStore.getState();
    expect(s.paused).toBe(true);
    // Yesterday's committed 5 h / 4 h are not today's.
    expect(s.appCommittedSecs).toBe(3600);
    expect(s.projectCommittedSecs).toBe(3600);
    expect(s.getAppSecs()).toBe(3600);
  });

  it("setProject books only today's part of the old project's run", async () => {
    vi.setSystemTime(MIDNIGHT + 30 * 60_000); // 00:30
    await useTimerStore.getState().setProject("p2");

    expect(invoke).toHaveBeenCalledWith("timer_flush_project", { projectId: "p1", secs: 1800 });
    // The app counter keeps running through a switch: nothing booked for it.
    expect(booked("timer_flush_app")).toEqual([]);
    const s = useTimerStore.getState();
    expect(s.activeProjectId).toBe("p2");
    expect(s.projectStartedAt).toBe(MIDNIGHT + 30 * 60_000);
  });

  it("flush clamps the same way", async () => {
    vi.setSystemTime(MIDNIGHT + 2 * HOUR);
    await useTimerStore.getState().flush();
    expect(booked("timer_flush_app")).toEqual([2 * 3600]);
    expect(booked("timer_flush_project")).toEqual([2 * 3600]);
  });

  it("the live totals do not add yesterday's committed time to today's", () => {
    vi.setSystemTime(MIDNIGHT + HOUR);
    expect(useTimerStore.getState().getAppSecs()).toBe(3600);
    expect(useTimerStore.getState().getProjectSecs()).toBe(3600);
  });

  it("a same-day pause books the whole run on top of today's total", async () => {
    useTimerStore.setState({ appStartedAt: MIDNIGHT + HOUR, projectStartedAt: MIDNIGHT + HOUR });
    vi.setSystemTime(MIDNIGHT + 2 * HOUR);
    await useTimerStore.getState().toggle();
    expect(booked("timer_flush_app")).toEqual([3600]);
    expect(useTimerStore.getState().appCommittedSecs).toBe(5 * 3600 + 3600);
    expect(useTimerStore.getState().projectCommittedSecs).toBe(4 * 3600 + 3600);
  });

  it("a paused store books nothing on a switch", async () => {
    useTimerStore.setState({ paused: true, appStartedAt: null, projectStartedAt: null });
    vi.setSystemTime(MIDNIGHT + HOUR);
    await useTimerStore.getState().setProject("p2");
    expect(booked("timer_flush_project")).toEqual([]);
    expect(useTimerStore.getState().projectStartedAt).toBeNull();
  });
});
