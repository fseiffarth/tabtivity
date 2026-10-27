/**
 * A desktop reminder that comes due during a talk pops up on the shared
 * screen whichever window is shared, so while the privacy curtain's
 * presentation runs it waits, and goes out when the talk ends. The phone's
 * copy is not held.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar, CalendarEvent } from "../../types";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const sendNotification = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: (n: unknown) => sendNotification(n),
}));

import { useAlarmStore } from "../../stores/calendar/alarms";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";
import { usePrivacyCurtainStore } from "../../lib/window/privacyCurtain";

const cal: Calendar = { id: "home", name: "home", color: "#4aa3df", visible: true, readonly: false };
const event: CalendarEvent = {
  id: "home-dentist",
  calendar_id: "home",
  start: "2026-07-08T09:00",
  end: "2026-07-08T10:00",
  all_day: false,
  title: "home-dentist",
  alarms: [{ minutes_before: 15 }],
};
const NOW = new Date(2026, 6, 8, 8, 50);
const flush = () => new Promise((r) => setTimeout(r, 0));
const phoneNotices = () => invoke.mock.calls.filter(([command]) => command === "mobile_admin");

beforeEach(() => {
  _grantTimerLeaseForTest();
  localStorage.clear();
  invoke.mockClear();
  sendNotification.mockClear();
  useAlarmStore.setState({ active: [], snoozed: [], fired: new Set() });
  useCalendarStore.setState({ loaded: true, calendars: [cal], events: [event] });
  usePrivacyCurtainStore.setState({ presenting: false, auto: true, up: false });
});

describe("reminders during a presentation", () => {
  it("holds the desktop notice until the talk ends, but not the phone's", async () => {
    usePrivacyCurtainStore.getState().applyPresenting({ presenting: true, kind: "pdf", curtain: true });
    await useAlarmStore.getState().tick(NOW);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(phoneNotices()).toHaveLength(1);

    usePrivacyCurtainStore.getState().applyPresenting({ presenting: false, kind: null, curtain: true });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ title: "home-dentist" });
  });

  it("holds nothing with the curtain setting off", async () => {
    usePrivacyCurtainStore.getState().applyPresenting({ presenting: true, kind: "pdf", curtain: false });
    await useAlarmStore.getState().tick(NOW);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
