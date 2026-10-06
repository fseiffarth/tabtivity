/**
 * "Flying in": a row a root agent wrote gets the `arrived` class for a short
 * while (`stores/calendar/arrivals`), in every view that draws one. The store
 * keeps only live marks — one sweep timer clears them — and the views read
 * the mark by the row's (master) id.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { ARRIVAL_MS, resetArrivals, useArrivalsStore } from "../../stores/calendar/arrivals";
import { TimeGrid } from "../../components/calendar/TimeGrid";
import { MonthView } from "../../components/calendar/MonthView";
import { AgendaView } from "../../components/calendar/AgendaView";
import { TasksView } from "../../components/calendar/TasksView";
import { TodoCard } from "../../components/todo/TodoCard";
import type { CalendarTask, Occurrence } from "../../types";

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

const task: CalendarTask = { id: "t1", calendar_id: "c1", title: "Ship", priority: 0, percent: 0 };

const marks = () => Object.keys(useArrivalsStore.getState().until);

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
});

beforeEach(() => {
  vi.useFakeTimers();
  resetArrivals();
});

afterEach(() => {
  cleanup();
  resetArrivals();
  vi.useRealTimers();
});

describe("the arrivals store", () => {
  it("marks ids, answers per id, and forgets them when they expire", () => {
    useArrivalsStore.getState().markArrived(["a", "b"]);
    expect(marks().sort()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(ARRIVAL_MS - 1);
    expect(marks()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(marks()).toEqual([]);
  });

  it("re-arms for a later batch and never grows past the live marks", () => {
    useArrivalsStore.getState().markArrived(["a"]);
    vi.advanceTimersByTime(1000);
    useArrivalsStore.getState().markArrived(["b"]);
    vi.advanceTimersByTime(ARRIVAL_MS - 1000);
    expect(marks()).toEqual(["b"]);
    vi.advanceTimersByTime(1000);
    expect(marks()).toEqual([]);
    for (let i = 0; i < 50; i++) {
      useArrivalsStore.getState().markArrived([`x${i}`]);
      vi.advanceTimersByTime(ARRIVAL_MS);
    }
    expect(marks()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an empty batch changes nothing", () => {
    const before = useArrivalsStore.getState().until;
    useArrivalsStore.getState().markArrived([]);
    expect(useArrivalsStore.getState().until).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Mark `id`, check `el()` carries `arrived`, then that it drops it on expiry. */
function expectArrives(id: string, el: () => Element | null) {
  expect(el()?.classList.contains("arrived")).toBe(false);
  act(() => useArrivalsStore.getState().markArrived([id]));
  expect(el()?.classList.contains("arrived")).toBe(true);
  act(() => vi.advanceTimersByTime(ARRIVAL_MS));
  expect(el()?.classList.contains("arrived")).toBe(false);
}

describe("the views mark an arrived row", () => {
  it("a time-grid block", () => {
    const view = render(
      <TimeGrid
        dates={["2026-09-16"]}
        occurrences={[occ]}
        calendars={[]}
        prefs={{ use24h: true, dayStartHour: 8 }}
        onOpen={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onResize={vi.fn()}
        onMenu={vi.fn()}
      />,
    );
    expectArrives("e1", () => view.container.querySelector(".cal-block"));
  });

  it("a month bar", () => {
    const view = render(
      <MonthView
        weeks={[["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]]}
        month={9}
        occurrences={[occ]}
        calendars={[]}
        use24h
        selected="2026-09-16"
        onSelect={vi.fn()}
        onCreateOn={vi.fn()}
        onOpen={vi.fn()}
        onMenu={vi.fn()}
        weekStart={1}
      />,
    );
    expectArrives("e1", () => view.container.querySelector(".cal-month-bar"));
  });

  it("an agenda row", () => {
    const view = render(
      <AgendaView occurrences={[occ]} calendars={[]} use24h onOpen={vi.fn()} onMenu={vi.fn()} />,
    );
    expectArrives("e1", () => view.container.querySelector(".cal-agenda-row"));
  });

  it("a task row, and only that one", () => {
    const view = render(
      <TasksView
        tasks={[task, { ...task, id: "t2", title: "Other" }]}
        calendars={[]}
        visibleCalendars={new Set(["c1"])}
        search=""
        onCreate={vi.fn(async () => {})}
        onUpdate={vi.fn(async () => {})}
        onDelete={vi.fn(async () => {})}
        defaultCalendarId="c1"
        use24h
      />,
    );
    const rows = () => view.container.querySelectorAll(".cal-task-row");
    expect(rows()).toHaveLength(2);
    act(() => useArrivalsStore.getState().markArrived(["t1"]));
    expect(view.container.querySelectorAll(".cal-task-row.arrived")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(ARRIVAL_MS));
    expect(view.container.querySelectorAll(".cal-task-row.arrived")).toHaveLength(0);
  });

  it("a board card", () => {
    const view = render(
      <TodoCard task={task} columns={[]} onPointerDown={vi.fn()} onEdit={vi.fn()} onOpenMail={vi.fn()} />,
    );
    expectArrives("t1", () => view.container.querySelector(".todo-card"));
  });
});
