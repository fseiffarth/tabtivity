/**
 * Moving an event to another calendar from the event dialog, and the save that
 * carries a synced row's server identity along.
 *
 * A row a CalDAV server holds is a resource in ONE collection. Moved with its
 * `caldav_href`, it would be pushed straight back into the calendar it left; so
 * the move drops the address (the new calendar's push is a create) and deletes
 * the old copy — the path a root agent's `calendar_move_events` takes too. And
 * an ordinary edit must keep the address, or every save would push the event
 * as a new appointment beside the old one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { EventDialog } from "../../components/calendar/EventDialog";
import { setCalendarWriteHandler, type CalendarWriteEvent } from "../../lib/calendar/calendarWriteHook";
import { useCalendarStore } from "../../stores/calendar/calendar";
import type { Calendar, CalendarEvent } from "../../types";

const SYNCED: CalendarEvent = {
  id: "e1",
  calendar_id: "cal-a",
  start: "2026-09-18T09:00",
  end: "2026-09-18T10:00",
  all_day: false,
  title: "Standup",
  uid: "abc@server",
  caldav_href: "/dav/a/abc.ics",
  caldav_etag: '"7"',
};

let announced: CalendarWriteEvent[] = [];

beforeEach(() => {
  announced = [];
  invoke.mockReset();
  // `update_event` hands back what it stored.
  invoke.mockImplementation(async (_cmd: string, args: { event: CalendarEvent }) =>
    JSON.parse(JSON.stringify(args.event)),
  );
  setCalendarWriteHandler(async (event) => {
    announced.push(event);
  });
  useCalendarStore.setState({ events: [SYNCED], calendars: [], tasks: [], loaded: true });
});

afterEach(() => {
  setCalendarWriteHandler(null);
  cleanup();
});

describe("updateEvent", () => {
  it("moves a synced row: the address is dropped and the old copy deleted", async () => {
    await useCalendarStore.getState().updateEvent({ ...SYNCED, calendar_id: "cal-b" });

    const [, { event: written }] = invoke.mock.calls[0] as [string, { event: CalendarEvent }];
    expect(written.calendar_id).toBe("cal-b");
    expect(written.caldav_href).toBeUndefined();
    expect(written.caldav_etag).toBeUndefined();
    expect(written.uid).toBe("abc@server");

    expect(announced.map((a) => [a.op, a.row.calendar_id])).toEqual([
      ["delete", "cal-a"],
      ["upsert", "cal-b"],
    ]);
    expect(announced[0].row.caldav_href).toBe("/dav/a/abc.ics");
    expect(useCalendarStore.getState().events[0].calendar_id).toBe("cal-b");
  });

  it("keeps the move when the server refuses the delete of the old copy", async () => {
    setCalendarWriteHandler(async (event) => {
      announced.push(event);
      if (event.op === "delete") throw new Error("caldav-conflict");
    });
    await expect(
      useCalendarStore.getState().updateEvent({ ...SYNCED, calendar_id: "cal-b" }),
    ).resolves.toBeUndefined();
    expect(announced.map((a) => a.op)).toEqual(["delete", "upsert"]);
    expect(useCalendarStore.getState().events[0].calendar_id).toBe("cal-b");
  });

  it("keeps the address on an edit that stays in its calendar", async () => {
    await useCalendarStore.getState().updateEvent({ ...SYNCED, title: "Standup (short)" });
    expect(announced).toHaveLength(1);
    expect(announced[0].op).toBe("upsert");
    expect(announced[0].row.caldav_href).toBe("/dav/a/abc.ics");
  });

  it("refuses to split a series whose occurrences were edited on the server", async () => {
    const override: CalendarEvent = {
      ...SYNCED,
      id: "e2",
      recurrence_id: "2026-09-25T09:00",
      start: "2026-09-25T10:00",
      end: "2026-09-25T11:00",
    };
    useCalendarStore.setState({ events: [SYNCED, override] });
    await expect(
      useCalendarStore.getState().updateEvent({ ...SYNCED, calendar_id: "cal-b" }),
    ).rejects.toThrow("Standup");
    expect(invoke).not.toHaveBeenCalled();
    expect(announced).toHaveLength(0);
  });

  it("moves a local row with nothing to delete anywhere", async () => {
    const local: CalendarEvent = { ...SYNCED, caldav_href: undefined, caldav_etag: undefined };
    useCalendarStore.setState({ events: [local] });
    await useCalendarStore.getState().updateEvent({ ...local, calendar_id: "cal-b" });
    expect(announced.map((a) => a.op)).toEqual(["upsert"]);
  });
});

describe("EventDialog", () => {
  const calendars: Calendar[] = [
    { id: "cal-a", name: "Work", color: "#36c", visible: true, readonly: false },
    { id: "cal-b", name: "Home", color: "#c63", visible: true, readonly: false },
  ];

  it("saves what the form does not edit, the server identity included", () => {
    const onSave = vi.fn();
    render(
      <EventDialog
        target={{ event: SYNCED, occurrence: null }}
        calendars={calendars}
        defaultCalendarId="cal-a"
        defaultReminderMinutes={0}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Save"));
    const saved = onSave.mock.calls[0][0] as CalendarEvent;
    expect(saved.caldav_href).toBe("/dav/a/abc.ics");
    expect(saved.caldav_etag).toBe('"7"');
    expect(saved.uid).toBe("abc@server");
    expect(saved.title).toBe("Standup");
  });
});

describe("a mail-made event's provenance", () => {
  const calendars: Calendar[] = [
    { id: "cal-a", name: "Work", color: "#36c", visible: true, readonly: false },
    { id: "cal-b", name: "Home", color: "#c63", visible: true, readonly: false },
  ];
  const STAMPED: CalendarEvent = { ...SYNCED, from_mail: { message_id: "m1", account_id: "a1" } };

  it("survives an edit in the dialog and the store's write, a move included", async () => {
    useCalendarStore.setState({ events: [STAMPED] });
    const onSave = vi.fn();
    render(
      <EventDialog
        target={{ event: STAMPED, occurrence: null }}
        calendars={calendars}
        defaultCalendarId="cal-a"
        defaultReminderMinutes={0}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("Standup"), { target: { value: "Standup (moved)" } });
    fireEvent.click(screen.getByText("Save"));
    const saved = onSave.mock.calls[0][0] as CalendarEvent;
    expect(saved.title).toBe("Standup (moved)");
    expect(saved.from_mail).toEqual({ message_id: "m1", account_id: "a1" });

    await useCalendarStore.getState().updateEvent({ ...saved, calendar_id: "cal-b" });
    const [, { event: written }] = invoke.mock.calls[0] as [string, { event: CalendarEvent }];
    expect(written.from_mail).toEqual({ message_id: "m1", account_id: "a1" });
    expect(useCalendarStore.getState().events[0].from_mail).toEqual({ message_id: "m1", account_id: "a1" });
  });
});
