/**
 * Numbered weekdays in a recurrence — "the 2nd Tuesday", "the last Friday",
 * "the 4th Thursday of November" — and the imported RRULE text a rule keeps when
 * the model cannot hold all of it (todo/group-x-caldav.md #2318).
 */
import { describe, expect, it } from "vitest";
import { formatRrule, parseIcs, parseRrule, sameRule, serializeIcs } from "../../lib/calendar/ics";
import { describeRrule, expandEvent, nthWeekdayOfMonth } from "../../lib/calendar/recurrence";
import { translate, type TranslationKey } from "../../lib/i18n";
// Registers the lazy dictionaries, so `translate("de", …)` answers in German.
import "../../lib/i18nDicts/all";
import type { CalendarEvent, Rrule } from "../../types";
import { BRAND } from "../../lib/brand";

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  translate("en", key, params);
const tDe = (key: TranslationKey, params?: Record<string, string | number>) =>
  translate("de", key, params);

function event(start: string, rrule: Rrule): CalendarEvent {
  const end = start.includes("T") ? `${start.slice(0, 11)}${String(Number(start.slice(11, 13)) + 1).padStart(2, "0")}:00` : start;
  return { id: "e1", calendar_id: "default", start, end, all_day: !start.includes("T"), title: "x", rrule };
}

const monthly = (over: Partial<Rrule> = {}): Rrule => ({ freq: "monthly", interval: 1, ...over });
const days = (e: CalendarEvent, a: string, b: string) =>
  expandEvent(e, a, b).map((o) => o.occurrenceStart.slice(0, 10));

describe("nthWeekdayOfMonth", () => {
  it("counts from the start and from the end, and refuses a day the month lacks", () => {
    expect(nthWeekdayOfMonth(2026, 9, 1, 2)).toBe(1); // Sep 1 2026 is a Tuesday
    expect(nthWeekdayOfMonth(2026, 9, 2, 2)).toBe(8);
    expect(nthWeekdayOfMonth(2026, 9, 5, 2)).toBe(29);
    expect(nthWeekdayOfMonth(2026, 9, -1, 5)).toBe(25);
    expect(nthWeekdayOfMonth(2026, 9, -2, 5)).toBe(18);
    expect(nthWeekdayOfMonth(2026, 11, 5, 4)).toBeNull(); // four Thursdays
    expect(nthWeekdayOfMonth(2027, 2, 4, 1)).toBe(22);
    expect(nthWeekdayOfMonth(2026, 9, 0, 1)).toBeNull();
  });
});

describe("expanding numbered weekdays", () => {
  it("fires on the 2nd Tuesday of each month, not every Tuesday", () => {
    const e = event("2026-09-08T10:00", monthly({ bynthweekday: [{ n: 2, day: 2 }] }));
    expect(days(e, "2026-09-01", "2027-01-01")).toEqual(["2026-09-08", "2026-10-13", "2026-11-10", "2026-12-08"]);
    expect(expandEvent(e, "2026-10-01", "2026-11-01")[0].start).toBe("2026-10-13T10:00");
  });

  it("fires on the last Friday", () => {
    const e = event("2026-09-25", monthly({ bynthweekday: [{ n: -1, day: 5 }] }));
    expect(days(e, "2026-09-01", "2027-01-01")).toEqual(["2026-09-25", "2026-10-30", "2026-11-27", "2026-12-25"]);
  });

  it("skips the months without a 5th Thursday", () => {
    const e = event("2026-10-29T18:00", monthly({ bynthweekday: [{ n: 5, day: 4 }] }));
    expect(days(e, "2026-10-01", "2027-04-01")).toEqual(["2026-10-29", "2026-12-31"]);
  });

  it("fires on several numbered weekdays in date order", () => {
    const e = event("2026-09-07T09:00", monthly({ bynthweekday: [{ n: 3, day: 1 }, { n: 1, day: 1 }] }));
    expect(days(e, "2026-09-01", "2026-11-01")).toEqual(["2026-09-07", "2026-09-21", "2026-10-05", "2026-10-19"]);
  });

  it("honours an interval, a count, and never fires before the master", () => {
    const every2 = event("2026-09-08T10:00", monthly({ interval: 2, bynthweekday: [{ n: 2, day: 2 }] }));
    expect(days(every2, "2026-09-01", "2027-02-01")).toEqual(["2026-09-08", "2026-11-10", "2027-01-12"]);

    const three = event("2026-09-08T10:00", monthly({ count: 3, bynthweekday: [{ n: 2, day: 2 }] }));
    expect(days(three, "2026-09-01", "2027-06-01")).toEqual(["2026-09-08", "2026-10-13", "2026-11-10"]);

    // Starts the day after September's 2nd Tuesday: October's is the first.
    const late = event("2026-09-09T10:00", monthly({ bynthweekday: [{ n: 2, day: 2 }] }));
    expect(days(late, "2026-09-01", "2026-11-01")).toEqual(["2026-10-13"]);
  });

  it("stops at UNTIL", () => {
    const e = event("2026-09-08T10:00", monthly({ until: "2026-11-09", bynthweekday: [{ n: 2, day: 2 }] }));
    expect(days(e, "2026-09-01", "2027-06-01")).toEqual(["2026-09-08", "2026-10-13"]);
  });

  it("takes a numbered weekday over a day of month", () => {
    const e = event("2026-09-08T10:00", monthly({ bymonthday: 15, bynthweekday: [{ n: 2, day: 2 }] }));
    expect(days(e, "2026-09-01", "2026-11-01")).toEqual(["2026-09-08", "2026-10-13"]);
  });

  it("fires yearly on the 4th Thursday of the master's month", () => {
    const e = event("2026-11-26", { freq: "yearly", interval: 1, bynthweekday: [{ n: 4, day: 4 }] });
    expect(days(e, "2026-01-01", "2029-01-01")).toEqual(["2026-11-26", "2027-11-25", "2028-11-23"]);
  });
});

describe("parsing numbered weekdays", () => {
  it("holds an ordinal BYDAY on a monthly rule", () => {
    expect(parseRrule("FREQ=MONTHLY;BYDAY=2TU")).toEqual(monthly({ bynthweekday: [{ n: 2, day: 2 }] }));
    expect(parseRrule("FREQ=MONTHLY;BYDAY=-1FR")).toEqual(monthly({ bynthweekday: [{ n: -1, day: 5 }] }));
    expect(parseRrule("FREQ=MONTHLY;BYDAY=+1MO,3MO")).toEqual(
      monthly({ bynthweekday: [{ n: 1, day: 1 }, { n: 3, day: 1 }] }),
    );
  });

  it("reads Outlook's BYSETPOS spelling as the same rule", () => {
    expect(parseRrule("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2")).toEqual(monthly({ bynthweekday: [{ n: 2, day: 2 }] }));
    expect(parseRrule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR")).toEqual(monthly({ bynthweekday: [{ n: -1, day: 5 }] }));
  });

  it("holds a yearly one when BYMONTH names its month", () => {
    expect(parseRrule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")).toEqual({
      freq: "yearly", interval: 1, bynthweekday: [{ n: 4, day: 4 }],
    });
  });

  it("keeps the text of a rule the model can only reduce", () => {
    // The 20th Monday of the YEAR: no month to count in.
    const yearWeek = parseRrule("FREQ=YEARLY;BYDAY=20MO")!;
    expect(yearWeek.bynthweekday).toBeUndefined();
    expect(yearWeek.ics_value).toBe("FREQ=YEARLY;BYDAY=20MO");
    // The last weekday of the month.
    expect(parseRrule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")!.ics_value).toBeTruthy();
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=1,15")!.ics_value).toBeTruthy();
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=-1")!.ics_value).toBeTruthy();
    expect(parseRrule("FREQ=DAILY;BYHOUR=9,17")!.ics_value).toBeTruthy();
    expect(parseRrule("FREQ=MONTHLY;BYDAY=TU")!.ics_value).toBeTruthy(); // every Tuesday of the month
    expect(parseRrule("FREQ=MONTHLY;BYDAY=6TU")!.ics_value).toBeTruthy();
    expect(parseRrule("FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13")!.ics_value).toBeTruthy();
  });

  it("keeps no text for a rule it holds whole", () => {
    for (const r of ["FREQ=WEEKLY;BYDAY=MO,FR", "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=4", "FREQ=YEARLY;BYMONTH=3", "FREQ=WEEKLY;WKST=MO"]) {
      expect(parseRrule(r)!.ics_value, r).toBeUndefined();
    }
  });
});

describe("formatting numbered weekdays", () => {
  it("writes an ordinal BYDAY, naming a yearly rule's month from the start", () => {
    expect(formatRrule(monthly({ bynthweekday: [{ n: 2, day: 2 }] }))).toBe("FREQ=MONTHLY;BYDAY=2TU");
    expect(formatRrule(monthly({ bynthweekday: [{ n: -1, day: 5 }], count: 6 }))).toBe("FREQ=MONTHLY;BYDAY=-1FR;COUNT=6");
    expect(formatRrule({ freq: "yearly", interval: 1, bynthweekday: [{ n: 4, day: 4 }] }, "2026-11-26"))
      .toBe("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH");
  });

  it("round-trips through parse", () => {
    for (const rule of [
      monthly({ bynthweekday: [{ n: 2, day: 2 }] }),
      monthly({ interval: 3, bynthweekday: [{ n: 1, day: 1 }, { n: -1, day: 1 }], until: "2027-06-30" }),
    ]) {
      expect(parseRrule(formatRrule(rule))).toEqual(rule);
    }
    const yearly: Rrule = { freq: "yearly", interval: 1, bynthweekday: [{ n: 4, day: 4 }] };
    expect(parseRrule(formatRrule(yearly, "2026-11-26"))).toEqual(yearly);
  });

  it("writes an imported rule back verbatim until it is edited", () => {
    const value = "FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=6";
    const imported = parseRrule(value)!;
    expect(formatRrule(imported)).toBe(value);
    // An edit that changes what the rule says writes the model, not stale text.
    expect(formatRrule({ ...imported, count: 3 })).toBe("FREQ=MONTHLY;BYMONTHDAY=1;COUNT=3");
  });

  it("compares rules by what they expand to, not the kept text", () => {
    const imported = parseRrule("FREQ=MONTHLY;BYMONTHDAY=1,15")!;
    expect(sameRule(imported, monthly({ bymonthday: 1, byweekday: [] }))).toBe(true);
    expect(sameRule(imported, monthly({ bymonthday: 2 }))).toBe(false);
  });
});

describe("an .ics round trip", () => {
  it("survives export and re-import — the CalDAV push path", () => {
    const e = event("2026-11-26T12:00", { freq: "yearly", interval: 1, bynthweekday: [{ n: 4, day: 4 }] });
    const text = serializeIcs([e], [], new Date("2026-09-18T00:00:00Z"));
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH");
    expect(parseIcs(text).events[0].rrule).toEqual(e.rrule);
  });

  it(`pushes a rule ${BRAND.display} could not hold back unreduced`, () => {
    const src = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a@b", "DTSTART:20260930T090000",
      "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "SUMMARY:report", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseIcs(src).events[0];
    const text = serializeIcs([{ ...parsed, id: "e1", calendar_id: "default", title: "renamed" }], [], new Date("2026-09-18T00:00:00Z"));
    expect(text).toContain("RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1");
  });
});

describe("describing numbered weekdays", () => {
  it("names the ordinal and the weekday", () => {
    expect(describeRrule(monthly({ bynthweekday: [{ n: 2, day: 2 }] }), t, "en")).toBe("Monthly on the 2nd Tuesday");
    expect(describeRrule(monthly({ bynthweekday: [{ n: -1, day: 5 }] }), t, "en")).toBe("Monthly on the last Friday");
    expect(describeRrule(monthly({ bynthweekday: [{ n: -2, day: 5 }] }), t, "en"))
      .toBe("Monthly on the 2nd-to-last Friday");
    expect(describeRrule(monthly({ bynthweekday: [{ n: 1, day: 1 }, { n: 3, day: 1 }], interval: 2 }), t, "en"))
      .toBe("Every 2 months on the 1st Monday, 3rd Monday");
    expect(describeRrule(monthly({ bynthweekday: [{ n: 2, day: 2 }] }), tDe, "de")).toBe("Monatlich am 2. Dienstag");
  });

  it("names a yearly rule's month from the start", () => {
    const rule: Rrule = { freq: "yearly", interval: 1, bynthweekday: [{ n: 4, day: 4 }], count: 3 };
    expect(describeRrule(rule, t, "en", "2026-11-26")).toBe("Yearly on the 4th Thursday of November, 3 times");
  });
});
