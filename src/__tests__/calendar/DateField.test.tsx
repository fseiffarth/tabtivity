/**
 * The day-entry field as the user meets it: a button that reads as a date, a
 * calendar Tabtivity draws itself, and a value on the wire the native input's
 * callers would not notice a change in.
 *
 * What it is here to prove is what the native `<input type="date">` could not
 * be made to do: dismiss its own popover (WebKitGTK's is a grabbing widget that
 * never does — the click that picks a day does not even reach the document), and
 * take its segment order from the app's language rather than from the process
 * locale. Plus the two rules that make it usable without a mouse: the arrows
 * walk days and months, and a day outside `min` is not pickable.
 */
import { useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

import { DateField } from "../../components/common/DateField";
import { DateTimeField, inHours, nextMonday } from "../../components/common/DateTimeField";

afterEach(cleanup);

/** Controlled, the way every caller renders it — a fixed `value` would test a
 *  component that does not exist. */
function field(initial: string, props: Partial<Parameters<typeof DateField>[0]> = {}) {
  const onChange = vi.fn();
  function Harness() {
    const [v, setV] = useState(initial);
    return (
      <DateField
        value={v}
        onChange={(next) => { onChange(next); setV(next); }}
        aria-label="day"
        {...props}
      />
    );
  }
  const r = render(<Harness />);
  return { r, onChange, trigger: () => r.getByLabelText("day") as HTMLButtonElement };
}

describe("DateField", () => {
  it("shows the stored day and hands back a plain YYYY-MM-DD", () => {
    const f = field("2026-09-03");
    expect(f.trigger().textContent).toContain("2026");
    fireEvent.click(f.trigger());
    fireEvent.click(document.querySelector('[data-date="2026-09-10"]')!);
    expect(f.onChange).toHaveBeenCalledWith("2026-09-10");
  });

  it("closes the calendar once a day is picked — no widget left grabbing the screen", () => {
    const f = field("2026-09-03");
    fireEvent.click(f.trigger());
    expect(document.querySelector(".date-pop")).not.toBeNull();
    fireEvent.click(document.querySelector('[data-date="2026-09-10"]')!);
    expect(document.querySelector(".date-pop")).toBeNull();
  });

  it("walks days, weeks and months from the keyboard", () => {
    const f = field("2026-09-03");
    fireEvent.click(f.trigger());
    const grid = document.querySelector(".date-pop-grid")!;
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(document.querySelector('[data-date="2026-09-11"]')?.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(document.querySelector(".date-pop-title")?.textContent).toContain("2026");
    expect(document.querySelector('[data-date="2026-10-11"]')?.getAttribute("tabindex")).toBe("0");
  });

  it("refuses a day before `min` instead of reporting one nothing can use", () => {
    const f = field("2026-09-03", { min: "2026-09-03" });
    fireEvent.click(f.trigger());
    const blocked = document.querySelector('[data-date="2026-09-01"]')!;
    expect(blocked.className).toContain("is-blocked");
    fireEvent.click(blocked);
    expect(f.onChange).not.toHaveBeenCalled();
    expect(document.querySelector(".date-pop")).not.toBeNull();
  });
});

describe("DateTimeField", () => {
  it("carries the hour across a change of day and clears whole when the day goes", () => {
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState("2026-09-03T14:30");
      return <DateTimeField value={v} clearable onChange={(next) => { onChange(next); setV(next); }} />;
    }
    const r = render(<Harness />);
    fireEvent.click(r.getByLabelText("Date"));
    fireEvent.click(document.querySelector('[data-date="2026-09-10"]')!);
    expect(onChange).toHaveBeenLastCalledWith("2026-09-10T14:30");
    fireEvent.click(r.getByLabelText("Date"));
    fireEvent.click(r.getByText("Clear"));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("puts the common instants one click away", () => {
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState("");
      return <DateTimeField value={v} onChange={(next) => { onChange(next); setV(next); }} />;
    }
    const r = render(<Harness />);
    fireEvent.click(r.getByText("Tomorrow morning"));
    expect(onChange.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}T09:00$/);
  });

  it("computes its shortcuts as local wall clock, never epoch-shifted", () => {
    expect(inHours(new Date(2026, 8, 3, 23, 30), 1)).toBe("2026-09-04T00:30");
    // Strictly after today: a Monday's "next Monday" is a week away, not today.
    expect(nextMonday("2026-09-07")).toBe("2026-09-14");
    expect(nextMonday("2026-09-03")).toBe("2026-09-07");
  });
});
