import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CalendarSidebar } from "../../components/calendar/CalendarSidebar";
import { activateRegionCursor, clearRegionCursor, pointRegionCursor, regionTargets } from "../../lib/shortcuts/steeringRegion";

afterEach(() => { cleanup(); clearRegionCursor(); vi.restoreAllMocks(); });
it("steering opens the accessible calendar rename and the inline editor saves or cancels", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 10, height: 10, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}),
  });
  const update = vi.fn();
  const { container } = render(<CalendarSidebar calendars={[{ id: "c", name: "Work", color: "#336699", visible: true, readonly: false }]}
    selected="2026-11-10" weekStart={1} onSelect={vi.fn()} onToggleVisible={vi.fn()} onCreateCalendar={vi.fn()}
    onUpdateCalendar={update} onDeleteCalendar={vi.fn()} onSubscribeCalendar={vi.fn()} onRefreshCalendar={vi.fn()}
    onSyncCaldav={vi.fn()} onOpenCaldav={vi.fn()} />);
  const rename = screen.getByRole("button", { name: "Work" });
  expect(regionTargets(container)).toContain(rename);
  pointRegionCursor(container, rename);
  act(() => { activateRegionCursor(); });
  const input = container.querySelector<HTMLInputElement>(".cal-list-rename")!;
  fireEvent.change(input, { target: { value: "Team" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Team" }));
  update.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  const cancelled = container.querySelector<HTMLInputElement>(".cal-list-rename")!;
  fireEvent.change(cancelled, { target: { value: "Discard" } });
  fireEvent.keyDown(cancelled, { key: "Escape" });
  expect(update).not.toHaveBeenCalled();
});
