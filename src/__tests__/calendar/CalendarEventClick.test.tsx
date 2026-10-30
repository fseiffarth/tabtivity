/**
 * A single click opens a calendar event, in every view that draws one.
 *
 * The time grid is the one that needs care: a press on a block already starts a
 * move-drag, so "click" there means a press released where it landed. A press
 * that travels is still a move and must not open the editor on top of it.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { TimeGrid } from "../../components/calendar/TimeGrid";
import { MonthView } from "../../components/calendar/MonthView";
import { AgendaView } from "../../components/calendar/AgendaView";
import type { Occurrence } from "../../types";

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

beforeAll(() => {
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture ??= () => {};
});

afterEach(cleanup);

function grid() {
  const onOpen = vi.fn();
  const onMove = vi.fn();
  const onCreate = vi.fn();
  const view = render(
    <TimeGrid
      dates={["2026-09-16"]}
      occurrences={[occ]}
      calendars={[]}
      prefs={{ use24h: true, dayStartHour: 8 }}
      onOpen={onOpen}
      onCreate={onCreate}
      onMove={onMove}
      onResize={vi.fn()}
      onMenu={vi.fn()}
    />,
  );
  const block = view.container.querySelector(".cal-block") as HTMLElement;
  return { block, onOpen, onMove, onCreate };
}

describe("calendar event click", () => {
  it("opens a time-grid block on a press released in place", () => {
    const { block, onOpen, onMove, onCreate } = grid();
    fireEvent.pointerDown(block, { button: 0, clientX: 50, clientY: 100 });
    fireEvent.pointerUp(block, { button: 0, clientX: 51, clientY: 101 });
    expect(onOpen).toHaveBeenCalledWith(occ);
    expect(onMove).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not open a time-grid block that was dragged", () => {
    const { block, onOpen } = grid();
    fireEvent.pointerDown(block, { button: 0, clientX: 50, clientY: 100 });
    fireEvent.pointerMove(block, { clientX: 50, clientY: 180 });
    fireEvent.pointerUp(block, { button: 0, clientX: 50, clientY: 180 });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not open on a cancelled press", () => {
    const { block, onOpen } = grid();
    fireEvent.pointerDown(block, { button: 0, clientX: 50, clientY: 100 });
    fireEvent.pointerCancel(block, { clientX: 50, clientY: 100 });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens a month bar on click, without the cell's double-click create", () => {
    const onOpen = vi.fn();
    const onCreateOn = vi.fn();
    const view = render(
      <MonthView
        weeks={[["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]]}
        month={9}
        occurrences={[occ]}
        calendars={[]}
        use24h
        selected="2026-09-16"
        onSelect={vi.fn()}
        onCreateOn={onCreateOn}
        onOpen={onOpen}
        onMoveDays={vi.fn()}
        onMenu={vi.fn()}
        weekStart={1}
      />,
    );
    const bar = view.container.querySelector(".cal-month-bar") as HTMLElement;
    fireEvent.click(bar);
    expect(onOpen).toHaveBeenCalledWith(occ);
    fireEvent.doubleClick(bar);
    expect(onCreateOn).not.toHaveBeenCalled();
  });

  it("opens an agenda row on click", () => {
    const onOpen = vi.fn();
    const view = render(
      <AgendaView
        occurrences={[occ]}
        calendars={[]}
        use24h
        onOpen={onOpen}
        onMenu={vi.fn()}
        emptyLabel=""
      />,
    );
    fireEvent.click(view.container.querySelector(".cal-agenda-row") as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(occ);
  });
});
