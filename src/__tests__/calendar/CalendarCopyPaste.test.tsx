/**
 * Right-click → Copy, right-click a day → Paste.
 *
 * The promise being tested is a narrow one: the pasted entry is the copied one
 * again somewhere else, and the ONLY thing that differs is when it happens.
 * Everything typed into the event rides along; the identity fields (`id`, the
 * CalDAV address, the iCalendar `UID`) and the repeat rule deliberately do not,
 * because carried over they would make the paste overwrite the original on the
 * server, or clone a whole series from one click.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CalendarContextMenu } from "../../components/calendar/CalendarContextMenu";
import { copyOfOccurrence, pastedAt } from "../../lib/calendar/calendarClipboard";
import type { CalendarEvent, Occurrence } from "../../types";

const SERIES: CalendarEvent = {
  id: "e1",
  calendar_id: "cal-a",
  start: "2026-09-16T10:00",
  end: "2026-09-16T11:00",
  all_day: false,
  title: "Standup",
  location: "Lab 2",
  notes: "bring the numbers",
  conference: "https://meet.example/abc",
  category: "work",
  status: "confirmed",
  rrule: { freq: "weekly", interval: 1 },
  exdates: ["2026-09-30T10:00"],
  overrides: [],
  alarms: [{ minutes_before: 10 }],
  uid: "abc@server",
  caldav_href: "/dav/a/abc.ics",
  caldav_etag: '"7"',
};

const OCC: Occurrence = {
  eventId: "e1",
  occurrenceStart: "2026-09-23T10:00",
  start: "2026-09-23T10:00",
  end: "2026-09-23T11:00",
  allDay: false,
  title: "Standup",
  location: "Lab 2",
  notes: "bring the numbers",
  conference: "https://meet.example/abc",
  category: "work",
  status: "confirmed",
  calendarId: "cal-a",
  recurring: true,
  alarms: [{ minutes_before: 10 }],
};

afterEach(cleanup);

describe("copying a calendar entry", () => {
  it("keeps everything the user typed", () => {
    const { draft } = copyOfOccurrence(SERIES, OCC);
    expect(draft.title).toBe("Standup");
    expect(draft.location).toBe("Lab 2");
    expect(draft.notes).toBe("bring the numbers");
    expect(draft.conference).toBe("https://meet.example/abc");
    expect(draft.category).toBe("work");
    expect(draft.status).toBe("confirmed");
    expect(draft.alarms).toEqual([{ minutes_before: 10 }]);
    expect(draft.calendar_id).toBe("cal-a");
  });

  it("carries no identity and no repeat rule", () => {
    const { draft } = copyOfOccurrence(SERIES, OCC);
    const carried = draft as Partial<CalendarEvent>;
    expect(carried.id).toBeUndefined();
    expect(carried.uid).toBeUndefined();
    expect(carried.caldav_href).toBeUndefined();
    expect(carried.caldav_etag).toBeUndefined();
    expect(carried.recurrence_id).toBeUndefined();
    expect(carried.rrule).toBeUndefined();
    expect(carried.exdates).toBeUndefined();
    expect(carried.overrides).toBeUndefined();
  });

  it("carries a mail-made event's provenance on, so a paste cannot launder it", () => {
    const fromMail = { message_id: "m1", account_id: "a1" };
    expect(copyOfOccurrence({ ...SERIES, from_mail: fromMail }, OCC).draft.from_mail).toEqual(fromMail);
    expect("from_mail" in copyOfOccurrence(SERIES, OCC).draft).toBe(false);
  });

  it("copies the occurrence that was clicked, not the master", () => {
    const { draft, fromSeries } = copyOfOccurrence(SERIES, {
      ...OCC,
      title: "Standup (short)",
      start: "2026-09-23T09:30",
      end: "2026-09-23T09:45",
    });
    expect(draft.title).toBe("Standup (short)");
    expect(draft.start).toBe("2026-09-23T09:30");
    expect(fromSeries).toBe(true);
  });
});

describe("pasting it", () => {
  it("changes the date and nothing else", () => {
    const entry = copyOfOccurrence(SERIES, OCC);
    const pasted = pastedAt(entry, { date: "2026-10-05" });
    expect(pasted.start).toBe("2026-10-05T10:00");
    expect(pasted.end).toBe("2026-10-05T11:00");
    expect({ ...pasted, start: "", end: "" }).toEqual({ ...entry.draft, start: "", end: "" });
  });

  it("takes the minute it was dropped at on the hour grid, keeping the length", () => {
    const entry = copyOfOccurrence(SERIES, OCC);
    const pasted = pastedAt(entry, { date: "2026-10-05", start: "2026-10-05T14:45" });
    expect(pasted.start).toBe("2026-10-05T14:45");
    expect(pasted.end).toBe("2026-10-05T15:45");
  });

  it("rolls a late copy past midnight rather than clipping it", () => {
    const entry = copyOfOccurrence(SERIES, {
      ...OCC,
      start: "2026-09-23T23:30",
      end: "2026-09-24T00:30",
    });
    const pasted = pastedAt(entry, { date: "2026-10-05" });
    expect(pasted.start).toBe("2026-10-05T23:30");
    expect(pasted.end).toBe("2026-10-06T00:30");
  });

  it("keeps an all-day copy's length in whole days", () => {
    const entry = copyOfOccurrence(
      { ...SERIES, all_day: true, start: "2026-09-16", end: "2026-09-19" },
      { ...OCC, allDay: true, start: "2026-09-16", end: "2026-09-19" },
    );
    const pasted = pastedAt(entry, { date: "2026-12-24" });
    expect(pasted.all_day).toBe(true);
    expect(pasted.start).toBe("2026-12-24");
    expect(pasted.end).toBe("2026-12-27");
  });
});

describe("the right-click menu", () => {
  const handlers = () => ({
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
    onPaste: vi.fn(),
    onCreate: vi.fn(),
  });

  it("offers a series' two delete scopes, never a bare delete", () => {
    const h = handlers();
    render(
      <CalendarContextMenu
        target={{ x: 10, y: 10, occ: OCC, slot: { date: "2026-09-23" } }}
        clipboard={null}
        {...h}
      />,
    );
    fireEvent.click(screen.getByText("Delete this occurrence"));
    expect(h.onDelete).toHaveBeenCalledWith(OCC, "this");
    expect(h.onClose).toHaveBeenCalled();
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("deletes a plain event outright", () => {
    const h = handlers();
    render(
      <CalendarContextMenu
        target={{ x: 10, y: 10, occ: { ...OCC, recurring: false }, slot: null }}
        clipboard={null}
        {...h}
      />,
    );
    fireEvent.click(screen.getByText("Delete"));
    expect(h.onDelete).toHaveBeenCalledWith({ ...OCC, recurring: false }, "all");
  });

  it("names what it will paste, and pastes at the clicked slot", () => {
    const h = handlers();
    const entry = copyOfOccurrence(SERIES, OCC);
    render(
      <CalendarContextMenu
        target={{ x: 10, y: 10, occ: null, slot: { date: "2026-10-05", start: "2026-10-05T14:45" } }}
        clipboard={entry}
        {...h}
      />,
    );
    // The copied title is the caption over Paste, not part of the button's
    // label — a menu must not be as wide as whatever was copied.
    expect(screen.getByText("Standup", { selector: ".context-menu-quote" })).toBeTruthy();
    fireEvent.click(screen.getByText("Paste"));
    expect(h.onPaste).toHaveBeenCalledWith({ date: "2026-10-05", start: "2026-10-05T14:45" });
  });

  it("shows Paste disabled, and says what to do, when nothing was copied", () => {
    const h = handlers();
    render(
      <CalendarContextMenu
        target={{ x: 10, y: 10, occ: null, slot: { date: "2026-10-05" } }}
        clipboard={null}
        {...h}
      />,
    );
    const paste = screen.getByText("Paste") as HTMLButtonElement;
    expect(paste.disabled).toBe(true);
    fireEvent.click(paste);
    expect(h.onPaste).not.toHaveBeenCalled();
    expect(screen.getByText("Right-click an event and choose Copy first.")).toBeTruthy();
  });
});
