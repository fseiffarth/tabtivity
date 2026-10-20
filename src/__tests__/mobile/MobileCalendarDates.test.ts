import { describe, expect, it } from "vitest";
import { blankEventAt, dayGroupTitle, defaultEnd, hourOf, shownAllDayEnd, startOfWeekDate, storedAllDayEnd, weekDates, weekTitle } from "../../../mobile-web/src/screens/Calendar";

/** The desktop stores an all-day end as the day after the last day (iCal's
 * exclusive DTEND); the editor shows the last day itself. Without the
 * conversion a single-day all-day event was sent with `end == start`, which
 * the desktop bridge rejects, so it could never be created from the phone. */
describe("mobile calendar all-day end conversion", () => {
  it("shows the inclusive last day of a stored exclusive end", () => {
    // A single-day event on the 26th is stored as end = the 27th.
    expect(shownAllDayEnd("2026-08-26", "2026-08-27")).toBe("2026-08-26");
    // A two-day event covering the 26th and 27th is stored as end = the 28th.
    expect(shownAllDayEnd("2026-08-26", "2026-08-28")).toBe("2026-08-27");
  });

  it("round-trips the edited last day back to the exclusive form", () => {
    expect(storedAllDayEnd("2026-08-26")).toBe("2026-08-27");
    expect(storedAllDayEnd(shownAllDayEnd("2026-08-26", "2026-08-27"))).toBe("2026-08-27");
  });

  it("crosses month boundaries in both directions", () => {
    expect(shownAllDayEnd("2026-08-31", "2026-09-01")).toBe("2026-08-31");
    expect(storedAllDayEnd("2026-08-31")).toBe("2026-09-01");
  });

  it("never shows an end before the start for a degenerate stored span", () => {
    // `end == start` should not exist on disk, but a shown end before the
    // start would immediately re-save as an invalid span.
    expect(shownAllDayEnd("2026-08-26", "2026-08-26")).toBe("2026-08-26");
  });
});

describe("mobile calendar default event length", () => {
  it("ends a new event one hour after its start", () => {
    expect(defaultEnd("2026-08-26T09:30")).toBe("2026-08-26T10:30");
  });

  it("rolls past midnight into the next day, and across months", () => {
    expect(defaultEnd("2026-08-26T23:15")).toBe("2026-08-27T00:15");
    expect(defaultEnd("2026-08-31T23:00")).toBe("2026-09-01T00:00");
  });

  it("leaves a half-typed stamp alone", () => {
    expect(defaultEnd("2026-08-26T")).toBeNull();
    expect(defaultEnd("T09:00")).toBeNull();
  });
});

describe("mobile calendar day/week view dates", () => {
  it("starts the week on Monday or Sunday around the selected day", () => {
    // 2026-09-30 is a Wednesday.
    expect(weekDates("2026-09-30", 1)).toEqual([
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
    expect(weekDates("2026-09-30", 0)).toEqual([
      "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03",
    ]);
  });

  it("keeps a Sunday on the ending week, not the next one", () => {
    expect(startOfWeekDate("2026-10-04", 1)).toBe("2026-09-28");
    expect(startOfWeekDate("2026-10-04", 0)).toBe("2026-10-04");
  });

  it("labels a week spanning two months with both ends", () => {
    const title = weekTitle(weekDates("2026-09-30", 1), "en");
    expect(title).toContain("–");
    expect(title).toContain("28");
    expect(title).toContain("4");
    expect(weekTitle([], "en")).toBe("");
  });

  it("labels a day group with the weekday and date", () => {
    expect(dayGroupTitle("2026-09-30", "en")).toContain("30");
  });

  it("reads the hour out of a timed stamp, and none out of a bare date", () => {
    expect(hourOf("2026-10-03T09:00")).toBe(9);
    expect(hourOf("2026-10-03T23:15")).toBe(23);
    expect(hourOf("2026-10-03")).toBeNull();
    expect(hourOf("")).toBeNull();
  });

  it("drafts an hour-tapped event for that hour, rolling past midnight", () => {
    expect(blankEventAt("2026-10-03", 9, [])).toMatchObject({ start: "2026-10-03T09:00", end: "2026-10-03T10:00" });
    expect(blankEventAt("2026-10-03", 23, [])).toMatchObject({ start: "2026-10-03T23:00", end: "2026-10-04T00:00" });
  });
});
