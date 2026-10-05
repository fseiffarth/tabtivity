import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar, CalendarEvent } from "../../types";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: () => undefined,
}));

import { useAlarmStore } from "../../stores/calendar/alarms";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";

const cal = (id: string, over: Partial<Calendar> = {}): Calendar => ({
  id, name: id, color: "#4aa3df", visible: true, readonly: false, ...over,
});

const event = (id: string, calendarId: string): CalendarEvent => ({
  id,
  calendar_id: calendarId,
  start: "2026-07-08T09:00",
  end: "2026-07-08T10:00",
  all_day: false,
  title: id,
  location: "Room 2",
  alarms: [{ minutes_before: 15 }],
});

/** 08:50 — the 15-minute reminders came due five minutes ago. */
const NOW = new Date(2026, 6, 8, 8, 50);

const notices = () => invoke.mock.calls
  .filter(([command]) => command === "mobile_admin")
  .map(([, args]) => (args as { request: Record<string, unknown> }).request);

beforeEach(() => {
  _grantTimerLeaseForTest();
  localStorage.clear();
  invoke.mockClear();
  useAlarmStore.setState({ active: [], snoozed: [], fired: new Set() });
});

describe("reminders on the phone", () => {
  it("sends each fresh reminder once, for calendars whose alerts are on", async () => {
    useCalendarStore.setState({
      loaded: true,
      calendars: [cal("work", { alerts_off: true }), cal("home")],
      events: [event("work-standup", "work"), event("home-dentist", "home")],
    });
    await useAlarmStore.getState().tick(NOW);
    await useAlarmStore.getState().tick(NOW);

    const sent = notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "notify", kind: "calendar", title: "home-dentist" });
    expect(sent[0].body).toContain("Room 2");
    expect(sent[0].tag).toBe("home-dentist@2026-07-08T09:00@15");
  });

  it("does not push a snoozed reminder again when it wakes", async () => {
    useCalendarStore.setState({ loaded: true, calendars: [cal("home")], events: [event("home-dentist", "home")] });
    await useAlarmStore.getState().tick(NOW);
    const key = useAlarmStore.getState().active[0].key;
    useAlarmStore.getState().snooze(key, 5);
    // `snooze` stamps from the real clock, so the wake-up tick does too.
    await useAlarmStore.getState().tick(new Date(Date.now() + 10 * 60_000));

    expect(useAlarmStore.getState().active.map((a) => a.key)).toEqual([key]);
    expect(notices()).toHaveLength(1);
  });
});
