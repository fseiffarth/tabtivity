/**
 * Edge cases for `lib/calendar/recurrence.ts` beyond `Recurrence.test.ts`: weekday
 * lists the wild produces (duplicates, out-of-range, a list that skips the
 * master's own day), rule ends that fall before or on the master, the
 * month-pinning and leap-year corners, an occurrence that straddles midnight
 * and the window boundary, override fields at their edges (end only, empty
 * start, explicit null), and the merge/dedupe behaviour of the two series
 * edits.
 */
import { describe, expect, it } from "vitest";
import {
  describeRrule,
  excludeOccurrence,
  expandEvent,
  expandEvents,
  occurrencesOn,
  overrideOccurrence,
  sortOccurrences,
  sortOccurrencesByDay,
} from "../../lib/calendar/recurrence";
import { translate, type TranslationKey } from "../../lib/i18n";
import type { CalendarEvent, Rrule } from "../../types";

const t = (key: TranslationKey, params?: Record<string, string | number>) => translate("en", key, params);

/** 2026-07-08 is a Wednesday. */
function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    calendar_id: "default",
    start: "2026-07-08T09:00",
    end: "2026-07-08T10:00",
    all_day: false,
    title: "standup",
    ...over,
  };
}

function rule(over: Partial<Rrule> = {}): Rrule {
  return { freq: "daily", interval: 1, ...over };
}

const starts = (e: CalendarEvent, a: string, b: string) => expandEvent(e, a, b).map((o) => o.occurrenceStart);

describe("weekly byweekday lists", () => {
  it("does not fire on the master's own day when that weekday is not selected", () => {
    const e = event({ rrule: rule({ freq: "weekly", byweekday: [1] }) }); // Mondays only
    expect(starts(e, "2026-07-01", "2026-07-20")).toEqual(["2026-07-13T09:00"]);
  });

  it("dedupes and drops out-of-range weekdays", () => {
    const e = event({ rrule: rule({ freq: "weekly", byweekday: [3, 1, 1, 7, -1, 3] }) });
    expect(starts(e, "2026-07-08", "2026-07-15")).toEqual(["2026-07-08T09:00", "2026-07-13T09:00"]);
  });

  it("a list with nothing valid in it degrades to the master alone", () => {
    const e = event({ rrule: rule({ freq: "weekly", byweekday: [7, 9] }) });
    expect(starts(e, "2026-07-01", "2026-09-01")).toEqual(["2026-07-08T09:00"]);
  });

  it("`count` counts fired days, not weeks", () => {
    const e = event({ rrule: rule({ freq: "weekly", byweekday: [1, 3, 5], count: 4 }) });
    expect(starts(e, "2026-07-01", "2026-08-01")).toEqual([
      "2026-07-08T09:00", "2026-07-10T09:00", "2026-07-13T09:00", "2026-07-15T09:00",
    ]);
  });
});

describe("rule ends at the edges", () => {
  it("an `until` before the master yields nothing; on the master's date, the master alone", () => {
    expect(starts(event({ rrule: rule({ until: "2026-07-01" }) }), "2026-07-01", "2026-08-01")).toEqual([]);
    expect(starts(event({ rrule: rule({ until: "2026-07-08" }) }), "2026-07-01", "2026-08-01"))
      .toEqual(["2026-07-08T09:00"]);
  });

  it("a count of one is the master alone; a negative count is no limit", () => {
    expect(starts(event({ rrule: rule({ count: 1 }) }), "2026-07-01", "2026-08-01")).toEqual(["2026-07-08T09:00"]);
    expect(starts(event({ rrule: rule({ count: -5 }) }), "2026-07-08", "2026-07-11")).toHaveLength(3);
  });

  it("a window ending on the master's date shows nothing, since the end is exclusive", () => {
    expect(expandEvent(event({ rrule: rule() }), "2026-07-01", "2026-07-08")).toEqual([]);
  });
});

describe("month and year pinning", () => {
  it("a bymonthday before the master's day first fires the NEXT month", () => {
    const e = event({ rrule: rule({ freq: "monthly", bymonthday: 5 }) });
    expect(starts(e, "2026-07-01", "2026-09-01")).toEqual(["2026-08-05T09:00"]);
  });

  it("a pinned 31st skips the short months across a year end", () => {
    const e = event({ start: "2026-10-31T09:00", end: "2026-10-31T10:00", rrule: rule({ freq: "monthly", bymonthday: 31 }) });
    expect(starts(e, "2026-10-01", "2027-04-01").map((s) => s.slice(0, 10))).toEqual([
      "2026-10-31", "2026-12-31", "2027-01-31", "2027-03-31",
    ]);
  });

  it("a Feb 29 master every 4 years lands on Feb 29 again", () => {
    const e = event({ start: "2024-02-29T09:00", end: "2024-02-29T10:00", rrule: rule({ freq: "yearly", interval: 4 }) });
    expect(starts(e, "2024-01-01", "2029-01-01")).toEqual(["2024-02-29T09:00", "2028-02-29T09:00"]);
  });

  it("an unknown freq steps daily rather than throwing or looping", () => {
    const e = event({ rrule: { freq: "hourly" as never, interval: 1 } });
    expect(expandEvent(e, "2026-07-08", "2026-07-15")).toHaveLength(7);
    expect(describeRrule(e.rrule, t, "en")).toBe(t("recurrence.repeats"));
  });
});

describe("an occurrence straddling midnight", () => {
  const late = event({ start: "2026-07-08T23:30", end: "2026-07-09T00:30" });

  it("is visible in a window that opens on the day it ends", () => {
    expect(expandEvent(late, "2026-07-09", "2026-07-10")).toHaveLength(1);
  });

  it("a daily series shows yesterday's occurrence on today's window too", () => {
    const out = expandEvent({ ...late, rrule: rule() }, "2026-07-09", "2026-07-10");
    expect(out.map((o) => o.occurrenceStart)).toEqual(["2026-07-08T23:30", "2026-07-09T23:30"]);
  });

  it("occurrencesOn finds it on both days", () => {
    const [occ] = expandEvent(late, "2026-07-08", "2026-07-10");
    expect(occurrencesOn([occ], "2026-07-08")).toHaveLength(1);
    expect(occurrencesOn([occ], "2026-07-09")).toHaveLength(1);
    expect(occurrencesOn([occ], "2026-07-10")).toHaveLength(0);
  });
});

describe("override fields at their edges", () => {
  const series = event({ rrule: rule() });
  const key = "2026-07-09T09:00";
  const at = (e: CalendarEvent) => expandEvent(e, "2026-07-08", "2026-07-11").find((o) => o.occurrenceStart === key)!;

  it("an end-only override keeps the start and takes the end", () => {
    const occ = at(overrideOccurrence(series, key, { end: "2026-07-09T11:00" }));
    expect(occ).toMatchObject({ start: key, end: "2026-07-09T11:00" });
  });

  it("an empty-string start is not a move", () => {
    const occ = at({ ...series, overrides: [{ occurrence_start: key, start: "" }] });
    expect(occ).toMatchObject({ start: key, end: "2026-07-09T10:00" });
  });

  it("an explicit null title falls back to the master's", () => {
    const occ = at({ ...series, overrides: [{ occurrence_start: key, title: null }] });
    expect(occ.title).toBe("standup");
  });

  // Suspected bug: generateStarts stops once a generated start passes
  // windowEnd, so an occurrence generated AFTER the window but moved INTO it by
  // an override is never expanded — next week's standup moved to this Friday
  // does not show on this week's view.

  // Generated after the window, moved into it: generation must reach the slot.
  it("a moved override that lands in the window from outside is still drawn", () => {
    // Generated on Jul 12 (outside the window), moved to Jul 10 (inside).
    const e = overrideOccurrence(series, "2026-07-12T09:00", { start: "2026-07-10T15:00" });
    const out = expandEvent(e, "2026-07-10", "2026-07-11");
    expect(out.map((o) => [o.occurrenceStart, o.start])).toEqual([
      ["2026-07-10T09:00", "2026-07-10T09:00"],
      ["2026-07-12T09:00", "2026-07-10T15:00"],
    ]);
  });

  it("re-overriding merges the new fields onto the existing override", () => {
    let e = overrideOccurrence(series, key, { title: "retro" });
    e = overrideOccurrence(e, key, { start: "2026-07-09T14:00" });
    expect(e.overrides).toEqual([{ occurrence_start: key, title: "retro", start: "2026-07-09T14:00" }]);
  });

  it("overrides stay sorted by their slot however they were added", () => {
    let e = overrideOccurrence(series, "2026-07-10T09:00", { title: "b" });
    e = overrideOccurrence(e, key, { title: "a" });
    expect(e.overrides!.map((o) => o.occurrence_start)).toEqual([key, "2026-07-10T09:00"]);
  });

  it("excluding twice keeps one sorted exdate and never touches the master's other fields", () => {
    let e = excludeOccurrence(series, "2026-07-10T09:00");
    e = excludeOccurrence(e, key);
    e = excludeOccurrence(e, key);
    expect(e.exdates).toEqual([key, "2026-07-10T09:00"]);
    expect(e.rrule).toBe(series.rrule);
    expect(series.exdates).toBeUndefined(); // the input was not mutated
  });
});

describe("expandEvents and ordering", () => {
  it("an empty visible set hides everything; no set shows everything", () => {
    const events = [event(), event({ id: "e2", calendar_id: "other" })];
    expect(expandEvents(events, "2026-07-01", "2026-08-01", new Set())).toEqual([]);
    expect(expandEvents(events, "2026-07-01", "2026-08-01")).toHaveLength(2);
  });

  it("puts all-day first even when a timed one starts earlier, then breaks ties by title", () => {
    const out = sortOccurrences(expandEvents([
      event({ id: "t", start: "2026-07-08T00:30", end: "2026-07-08T01:00", title: "early" }),
      event({ id: "b", start: "2026-07-08", end: "2026-07-09", all_day: true, title: "b" }),
      event({ id: "a", start: "2026-07-08", end: "2026-07-09", all_day: true, title: "a" }),
    ], "2026-07-08", "2026-07-09"));
    expect(out.map((o) => o.title)).toEqual(["a", "b", "early"]);
  });

  it("orders day by day for a cap, so a daily all-day series no longer outranks later timed events", () => {
    const out = sortOccurrencesByDay(expandEvents([
      event({ id: "d", start: "2026-07-08", end: "2026-07-09", all_day: true, title: "daily", rrule: rule() }),
      event({ id: "t", start: "2026-07-09T08:00", end: "2026-07-09T09:00", title: "dentist" }),
    ], "2026-07-08", "2026-07-11"));
    expect(out.map((o) => `${o.start.slice(0, 10)} ${o.title}`)).toEqual([
      "2026-07-08 daily", "2026-07-09 daily", "2026-07-09 dentist", "2026-07-10 daily",
    ]);
  });

  it("occurrencesOn covers every day of a multi-day all-day block but not its exclusive end", () => {
    const out = expandEvent(event({ start: "2026-07-08", end: "2026-07-11", all_day: true }), "2026-07-01", "2026-08-01");
    expect(occurrencesOn(out, "2026-07-10")).toHaveLength(1);
    expect(occurrencesOn(out, "2026-07-11")).toHaveLength(0);
  });
});

describe("describeRrule at the edges", () => {
  it("treats a zero interval as one", () => {
    expect(describeRrule(rule({ interval: 0 }), t, "en")).toBe(describeRrule(rule({ interval: 1 }), t, "en"));
  });

  it("names the count when a rule carries both a count and an until", () => {
    const text = describeRrule(rule({ count: 3, until: "2026-12-31" }), t, "en");
    expect(text).toContain("3");
    expect(text).not.toContain("2026-12-31");
  });

  it("ignores out-of-range weekdays in the summary", () => {
    expect(describeRrule(rule({ freq: "weekly", byweekday: [9, -1] }), t, "en"))
      .toBe(describeRrule(rule({ freq: "weekly" }), t, "en"));
  });
});
