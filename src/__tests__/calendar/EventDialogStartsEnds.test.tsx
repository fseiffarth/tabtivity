/**
 * The event editor's Starts/Ends fields: each is a group of the shared
 * `common/DateField` and `common/TimeField`, never one `<label>` around both —
 * WebKit hands a click anywhere in a label to its first control, so the start
 * time could only be reached by tabbing over from the date.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { EventDialog } from "../../components/calendar/EventDialog";
import type { Calendar, CalendarEvent } from "../../types";

afterEach(cleanup);

const calendars: Calendar[] = [{ id: "c1", name: "Work", color: "#36c", visible: true, readonly: false }];

function open() {
  const event: CalendarEvent = {
    id: "e1", calendar_id: "c1", start: "2026-09-08T10:00", end: "2026-09-08T11:00", all_day: false, title: "Sync",
  };
  const onSave = vi.fn();
  render(
    <EventDialog
      target={{ event, occurrence: null }}
      calendars={calendars}
      defaultCalendarId="c1"
      defaultReminderMinutes={0}
      onClose={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
    />,
  );
  const save = () => {
    fireEvent.click(screen.getByText("Save"));
    return onSave.mock.calls[0][0] as CalendarEvent;
  };
  return { save };
}

describe("EventDialog starts/ends", () => {
  it("puts no label around the date and the clock", () => {
    open();
    const starts = screen.getByRole("group", { name: "Starts" });
    expect(starts.tagName).toBe("DIV");
    for (const hour of screen.getAllByLabelText("Time (h)")) {
      expect(hour.closest("label")).toBeNull();
    }
  });

  it("takes a start hour typed straight into the clock", () => {
    const { save } = open();
    const [startHour] = screen.getAllByLabelText("Time (h)") as HTMLInputElement[];
    startHour.focus();
    fireEvent.change(startHour, { target: { value: "09" } });
    expect(save().start).toBe("2026-09-08T09:00");
  });

  it("picks the end day from the drawn calendar", () => {
    const { save } = open();
    const [, endDay] = screen.getAllByRole("button", { name: "Date" });
    fireEvent.click(endDay);
    fireEvent.click(document.querySelector('[data-date="2026-09-10"]')!);
    expect(save().end).toBe("2026-09-10T11:00");
  });
});
