/**
 * Dragging a bar in the month grid moves the event to another day and nothing
 * else: the view reports whole days, never a new time of day.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MonthView } from "../../components/calendar/MonthView";
import type { Occurrence } from "../../types";

const WEEK = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"];

const occ: Occurrence = {
  eventId: "e1",
  occurrenceStart: "2026-09-16T10:00",
  start: "2026-09-16T10:00",
  end: "2026-09-16T11:00",
  allDay: false,
  title: "Standup",
  location: "",
  notes: "",
  conference: "",
  category: "",
  status: "",
  calendarId: "c1",
  recurring: false,
  alarms: [],
};

afterEach(() => {
  cleanup();
  // @ts-expect-error — test shim
  delete document.elementsFromPoint;
});

function setup() {
  const onOpen = vi.fn();
  const onMoveDays = vi.fn();
  const view = render(
    <MonthView
      weeks={[WEEK]}
      month={9}
      occurrences={[occ]}
      calendars={[]}
      use24h
      selected="2026-09-16"
      onSelect={vi.fn()}
      onCreateOn={vi.fn()}
      onOpen={onOpen}
      onMoveDays={onMoveDays}
      onMenu={vi.fn()}
      weekStart={1}
    />,
  );
  const row = view.container.querySelector(".cal-month-week") as HTMLElement;
  // jsdom has no layout: give the row a 700px width so column = x / 100.
  row.getBoundingClientRect = () => ({ left: 0, width: 700, top: 0, height: 100, right: 700, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  // Whichever day cell the cursor "is over" is chosen by x.
  document.elementsFromPoint = ((x: number) => {
    const col = Math.min(6, Math.floor(x / 100));
    return [view.container.querySelector(`[data-date="${WEEK[col]}"]`)];
  }) as typeof document.elementsFromPoint;
  const bar = view.container.querySelector(".cal-month-bar") as HTMLElement;
  return { bar, onOpen, onMoveDays };
}

describe("month view drag to another day", () => {
  it("reports the day delta, not a new time", () => {
    const { bar, onOpen, onMoveDays } = setup();
    fireEvent.pointerDown(bar, { button: 0, clientX: 250, clientY: 10 }); // Wed (col 2)
    fireEvent.pointerMove(window, { clientX: 450, clientY: 12 }); // Fri (col 4)
    fireEvent.pointerUp(window, { clientX: 450, clientY: 12 });
    fireEvent.click(bar);
    expect(onMoveDays).toHaveBeenCalledWith(occ, 2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("drops on the same day: nothing moves", () => {
    const { bar, onMoveDays } = setup();
    fireEvent.pointerDown(bar, { button: 0, clientX: 250, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 40 });
    fireEvent.pointerUp(window, { clientX: 260, clientY: 40 });
    expect(onMoveDays).not.toHaveBeenCalled();
  });

  it("a press that never travels is still a click", () => {
    const { bar, onOpen, onMoveDays } = setup();
    fireEvent.pointerDown(bar, { button: 0, clientX: 250, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 10 });
    fireEvent.click(bar);
    expect(onMoveDays).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(occ);
  });
});
