import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar, CalendarEvent } from "../../types";

const sendNotification = vi.fn();
const invoke = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

import { useAlarmStore } from "../../stores/calendar/alarms";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";

const cal = (id: string): Calendar => ({ id, name: id, color: "#4aa3df", visible: true, readonly: false });

const event = (id: string): CalendarEvent => ({
  id,
  calendar_id: "home",
  start: "2026-07-08T09:00",
  end: "2026-07-08T10:00",
  all_day: false,
  title: id,
  location: "",
  alarms: [{ minutes_before: 15 }],
});

/** 08:50 — the 15-minute reminders came due five minutes ago. */
const NOW = new Date(2026, 6, 8, 8, 50);
const KEYS = ["a@2026-07-08T09:00@15", "b@2026-07-08T09:00@15"];

const claims = () => invoke.mock.calls.filter(([command]) => command === "calendar_alarms_claim");
const pushed = () => invoke.mock.calls.filter(([command]) => command === "mobile_admin");

beforeEach(() => {
  _grantTimerLeaseForTest();
  localStorage.clear();
  invoke.mockClear();
  sendNotification.mockClear();
  invoke.mockImplementation(() => Promise.resolve(null));
  useAlarmStore.setState({ active: [], snoozed: [], fired: new Set() });
  useCalendarStore.setState({ loaded: true, calendars: [cal("home")], events: [event("a"), event("b")] });
});

describe("reminders are claimed before they show (headless owner plan, H2)", () => {
  it("shows only the reminders the backend granted, and never asks about the rest again", async () => {
    // Another window, or the sidecar with no window open, already showed `b`.
    invoke.mockImplementation((command: unknown, args?: unknown) =>
      Promise.resolve(command === "calendar_alarms_claim"
        ? (args as { keys: string[] }).keys.filter((key) => key.startsWith("a@"))
        : null));
    await useAlarmStore.getState().tick(NOW);

    expect(claims()).toHaveLength(1);
    expect((claims()[0][1] as { keys: string[] }).keys.sort()).toEqual(KEYS);
    const state = useAlarmStore.getState();
    expect(state.active.map((a) => a.key)).toEqual(["a@2026-07-08T09:00@15"]);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(pushed()).toHaveLength(1);
    expect([...state.fired].sort()).toEqual(KEYS);

    // The next tick has nothing left to claim: both keys are this window's
    // fired set now, the shown one and the one shown elsewhere.
    await useAlarmStore.getState().tick(NOW);
    expect(claims()).toHaveLength(1);
    expect(useAlarmStore.getState().active).toHaveLength(1);
  });

  it("decides alone on a backend without the command", async () => {
    invoke.mockImplementation((command: unknown) =>
      command === "calendar_alarms_claim" ? Promise.reject(new Error("command calendar_alarms_claim not found")) : Promise.resolve(null));
    await useAlarmStore.getState().tick(NOW);
    expect(useAlarmStore.getState().active.map((a) => a.key).sort()).toEqual(KEYS);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });
});
