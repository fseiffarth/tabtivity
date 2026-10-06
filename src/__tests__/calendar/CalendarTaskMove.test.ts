/**
 * Moving a to-do card to another calendar (the card dialog's Calendar field):
 * a card a CalDAV server holds is a resource in ONE collection, so the move
 * drops its address and deletes the old copy, as `updateEvent` does for an
 * event and `todo_update`'s `calendar` does for a root agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { setCalendarWriteHandler, type CalendarWriteEvent } from "../../lib/calendar/calendarWriteHook";
import { useCalendarStore } from "../../stores/calendar/calendar";
import type { CalendarTask } from "../../types";

const SYNCED: CalendarTask = {
  id: "t1",
  calendar_id: "cal-a",
  title: "Report",
  priority: 0,
  percent: 0,
  caldav_href: "/dav/a/t1.ics",
  caldav_etag: '"3"',
};

let announced: CalendarWriteEvent[] = [];

beforeEach(() => {
  announced = [];
  invoke.mockReset();
  // `update_task` hands back what it stored.
  invoke.mockImplementation(async (_cmd: string, args: { task: CalendarTask }) =>
    JSON.parse(JSON.stringify(args.task)),
  );
  setCalendarWriteHandler(async (event) => {
    announced.push(event);
  });
  useCalendarStore.setState({ events: [], calendars: [], tasks: [SYNCED], loaded: true });
});

afterEach(() => {
  setCalendarWriteHandler(null);
});

describe("updateTask", () => {
  it("moves a synced card: the address is dropped and the old copy deleted", async () => {
    await useCalendarStore.getState().updateTask({ ...SYNCED, calendar_id: "cal-b" });

    const [, { task: written }] = invoke.mock.calls[0] as [string, { task: CalendarTask }];
    expect(written.calendar_id).toBe("cal-b");
    expect(written.caldav_href).toBeUndefined();
    expect(written.caldav_etag).toBeUndefined();

    expect(announced.map((a) => [a.op, a.row.calendar_id])).toEqual([
      ["delete", "cal-a"],
      ["upsert", "cal-b"],
    ]);
    expect(announced[0].row.caldav_href).toBe("/dav/a/t1.ics");
    expect(useCalendarStore.getState().tasks[0].calendar_id).toBe("cal-b");
  });

  it("keeps the move when the server refuses the delete of the old copy", async () => {
    setCalendarWriteHandler(async (event) => {
      announced.push(event);
      if (event.op === "delete") throw new Error("caldav-conflict");
    });
    await expect(
      useCalendarStore.getState().updateTask({ ...SYNCED, calendar_id: "cal-b" }),
    ).resolves.toBeUndefined();
    expect(announced.map((a) => a.op)).toEqual(["delete", "upsert"]);
  });

  it("keeps the address on an edit that stays in its calendar", async () => {
    await useCalendarStore.getState().updateTask({ ...SYNCED, title: "Report v2" });
    expect(announced.map((a) => a.op)).toEqual(["upsert"]);
    expect(announced[0].row.caldav_href).toBe("/dav/a/t1.ics");
  });

  it("moves a local card with nothing to delete anywhere", async () => {
    const local: CalendarTask = { ...SYNCED, caldav_href: undefined, caldav_etag: undefined };
    useCalendarStore.setState({ tasks: [local] });
    await useCalendarStore.getState().updateTask({ ...local, calendar_id: "cal-b" });
    expect(announced.map((a) => a.op)).toEqual(["upsert"]);
  });
});
