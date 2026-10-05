/**
 * Edge cases for `lib/calendar/ics.ts` beyond `Ics.test.ts`: empty and BOM-prefixed
 * files, CR-only line endings, unicode through fold/unfold and the full
 * round-trip, malformed content lines and values (no `=` in a parameter, a
 * lone trailing backslash, weeks in a TRIGGER, out-of-range BYMONTHDAY /
 * PERCENT-COMPLETE / PRIORITY), a timed event with no DTEND crossing
 * midnight, alarms with no usable trigger, and the format-control strip on
 * every text field.
 */
import { describe, expect, it } from "vitest";
import {
  escapeText,
  fold,
  formatRrule,
  formatTrigger,
  icsUid,
  parseIcs,
  parseIcsDate,
  parseLine,
  parseRrule,
  parseTrigger,
  serializeIcs,
  unescapeText,
  unfold,
} from "../../lib/calendar/ics";
import type { CalendarEvent } from "../../types";
import { BRAND, LEGACY_BRAND } from "../../lib/brand";

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

const AT = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe("lines", () => {
  it("empty input unfolds to nothing and parses to nothing", () => {
    expect(unfold("")).toEqual([]);
    expect(parseIcs("")).toEqual({ events: [], tasks: [], skipped: 0 });
  });

  it("unfolds a CR-only file like any other", () => {
    expect(unfold("A:1\r B\rC:2\r")).toEqual(["A:1B", "C:2"]);
  });

  it("a continuation on the very first line has nothing to join and is kept, not dropped", () => {
    expect(unfold(" X:1\nY:2")).toEqual([" X:1", "Y:2"]);
  });

  it("folds at exactly 75, never earlier, and every continuation is at most 75", () => {
    expect(fold("x".repeat(75))).toBe("x".repeat(75));
    const folded = fold("x".repeat(76));
    expect(folded).toBe(`${"x".repeat(75)}\r\n x`);
    for (const part of fold("y".repeat(400)).split("\r\n")) expect(part.length).toBeLessThanOrEqual(75);
  });

  it("fold → unfold is the identity on ASCII and on unicode alike", () => {
    for (const s of ["ä".repeat(200), "🎉".repeat(80), `${"a".repeat(74)}🎉${"b".repeat(80)}`]) {
      expect(unfold(fold(`X:${s}`))).toEqual([`X:${s}`]);
    }
  });

  // Suspected bug: fold() slices by UTF-16 unit, not octet, so a line of
  // two-byte characters folds at ~150 octets — twice RFC 5545's 75.

  it("folds at 75 OCTETS, so a non-ASCII line does not exceed the RFC's limit", () => {
    const folded = fold(`X:${"ä".repeat(200)}`);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
  });

  it("parseLine uppercases the name and parameter keys, and ignores a parameter with no `=`", () => {
    expect(parseLine("dtstart;value=date;junk:20260708")).toEqual({
      name: "DTSTART", params: { VALUE: "date" }, value: "20260708",
    });
    expect(parseLine("X:")).toEqual({ name: "X", params: {}, value: "" });
    expect(parseLine(":v")).toEqual({ name: "", params: {}, value: "v" });
  });

  // Suspected bug: parseLine splits the parameter list on every `;`, so a
  // quoted value holding one (RFC 5545 §3.2 allows it) is cut at the `;`.

  // RFC 5545 §3.2: a quoted parameter value may contain `;` and `:`.
  it("a quoted parameter value may hold a `;` as well as a `:`", () => {
    expect(parseLine('ATTENDEE;CN="Doe; Jane":mailto:j@example.org')).toEqual({
      name: "ATTENDEE", params: { CN: "Doe; Jane" }, value: "mailto:j@example.org",
    });
  });
});

describe("escaping", () => {
  it("a trailing lone backslash survives unescaping", () => {
    expect(unescapeText("a\\")).toBe("a\\");
    expect(unescapeText("")).toBe("");
  });

  it("a literal backslash-n sequence round-trips as two characters, not a newline", () => {
    const literal = "a\\nb";
    expect(escapeText(literal)).toBe("a\\\\nb");
    expect(unescapeText(escapeText(literal))).toBe(literal);
  });

  it("round-trips unicode untouched", () => {
    const s = "Zoë; 田中, 🎉\nnext";
    expect(unescapeText(escapeText(s))).toBe(s);
  });

  // Suspected bug: escapeText escapes "\n" but leaves a bare "\r" raw in the
  // content line; unfold() then treats that CR as a line break on re-import,
  // and everything after it in the note is lost.

  // TEXT has no form for a CR, so a Windows line ending is normalised to `\n`
  // on the way out — the rest of the note must survive, where a raw CR used to
  // read back as a line break and drop everything after it.
  it("a bare CR in a text value survives the serialize → parse round-trip", () => {
    const original = event({ notes: "line one\r\nline two" });
    const { events } = parseIcs(serializeIcs([original], [], AT));
    expect(events[0].notes).toBe("line one\nline two");
  });
});

describe("date and duration values", () => {
  it("accepts a DATE-TIME without seconds and with surrounding whitespace", () => {
    expect(parseIcsDate(" 20260708T0900 ")).toEqual({ stamp: "2026-07-08T09:00", dateOnly: false });
  });

  it("rejects ISO-8601 with separators and a bare time", () => {
    expect(parseIcsDate("2026-07-08")).toBeNull();
    expect(parseIcsDate("T090000")).toBeNull();
    expect(parseIcsDate("")).toBeNull();
  });

  it("rounds seconds to minutes and adds days and hours", () => {
    expect(parseTrigger("-PT90S")).toBe(2);
    expect(parseTrigger("-PT29S")).toBe(0);
    expect(parseTrigger("-P1DT2H")).toBe(1560);
    expect(parseTrigger("  -PT5M  ")).toBe(5);
  });

  it("refuses a week duration and an absolute trigger rather than guessing", () => {
    expect(parseTrigger("-P1W")).toBeNull();
    expect(parseTrigger("20260708T090000Z")).toBeNull();
    expect(parseTrigger("")).toBeNull();
  });

  it("formats an after-the-start alarm without a sign and reads it back negative", () => {
    expect(formatTrigger(-15)).toBe("PT15M");
    expect(parseTrigger(formatTrigger(-15))).toBe(-15);
    expect(formatTrigger(1500)).toBe("-P1DT1H");
  });
});

describe("RRULE values the wild produces", () => {
  it("is case-insensitive on keys, FREQ and BYDAY", () => {
    expect(parseRrule("freq=weekly;byday=mo,fr")).toEqual({ freq: "weekly", interval: 1, byweekday: [1, 5] });
  });

  it("drops an unknown weekday token and an empty BYDAY, keeping the rest", () => {
    expect(parseRrule("FREQ=WEEKLY;BYDAY=XX")).toEqual({ freq: "weekly", interval: 1 });
    expect(parseRrule("FREQ=WEEKLY;BYDAY=XX,TU")).toEqual({ freq: "weekly", interval: 1, byweekday: [2] });
  });

  it("treats a zero, negative or non-numeric INTERVAL as 1", () => {
    expect(parseRrule("FREQ=DAILY;INTERVAL=0")!.interval).toBe(1);
    expect(parseRrule("FREQ=DAILY;INTERVAL=abc")!.interval).toBe(1);
    expect(parseRrule("FREQ=DAILY;INTERVAL=-3")!.interval).toBe(-3);
  });

  it("ignores a COUNT of zero and a BYMONTHDAY outside 1..31, taking the first of a list", () => {
    expect(parseRrule("FREQ=MONTHLY;COUNT=0;BYMONTHDAY=0")).toEqual({ freq: "monthly", interval: 1 });
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=32")).toEqual({ freq: "monthly", interval: 1 });
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=15,20")!.bymonthday).toBe(15);
  });

  it("reduces a DATE-TIME UNTIL to its date, and drops a garbage one", () => {
    expect(parseRrule("FREQ=DAILY;UNTIL=20260710T235959")!.until).toBe("2026-07-10");
    expect(parseRrule("FREQ=DAILY;UNTIL=soon")!.until).toBeUndefined();
  });

  it("returns null for an empty rule, one with no FREQ, and a stray `;`", () => {
    expect(parseRrule("")).toBeNull();
    expect(parseRrule("INTERVAL=2")).toBeNull();
    expect(parseRrule("FREQ=")).toBeNull();
    expect(parseRrule(";FREQ=DAILY;")).toEqual({ freq: "daily", interval: 1 });
  });

  it("round-trips a monthly rule with a day and an UNTIL", () => {
    const rule = { freq: "monthly" as const, interval: 3, bymonthday: 15, until: "2027-01-31" };
    expect(parseRrule(formatRrule(rule))).toEqual(rule);
    expect(formatRrule(rule)).toBe("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;UNTIL=20270131");
  });
});

describe("parseIcs on awkward files", () => {
  it("still imports the events of a BOM-prefixed file", () => {
    const text = `\uFEFF${wrap("BEGIN:VEVENT\r\nDTSTART:20260708T090000\r\nSUMMARY:x\r\nEND:VEVENT")}`;
    expect(parseIcs(text).events).toHaveLength(1);
  });

  it("a timed event with no DTEND that starts at 23:30 ends at 00:30 the next day", () => {
    const { events } = parseIcs(wrap("BEGIN:VEVENT\r\nDTSTART:20260708T233000\r\nSUMMARY:late\r\nEND:VEVENT"));
    expect(events[0]).toMatchObject({ start: "2026-07-08T23:30", end: "2026-07-09T00:30" });
  });

  it("a garbage DTEND falls back to the default duration rather than importing garbage", () => {
    const { events } = parseIcs(wrap("BEGIN:VEVENT\r\nDTSTART:20260708T090000\r\nDTEND:tomorrow\r\nSUMMARY:x\r\nEND:VEVENT"));
    expect(events[0].end).toBe("2026-07-08T10:00");
  });

  it("an alarm with no TRIGGER, an absolute one, or one outside a component is not imported", () => {
    const { events } = parseIcs(wrap([
      "BEGIN:VALARM", "TRIGGER:-PT5M", "END:VALARM",
      "BEGIN:VEVENT", "DTSTART:20260708T090000", "SUMMARY:x",
      "BEGIN:VALARM", "ACTION:DISPLAY", "END:VALARM",
      "BEGIN:VALARM", "TRIGGER;VALUE=DATE-TIME:20260708T085000Z", "END:VALARM",
      "BEGIN:VALARM", "TRIGGER:-PT10M", "END:VALARM",
      "END:VEVENT",
    ].join("\r\n")));
    expect(events[0].alarms).toEqual([{ minutes_before: 10 }]);
  });

  it("strips format controls from every text field after unescaping", () => {
    const { events } = parseIcs(wrap([
      "BEGIN:VEVENT", "DTSTART:20260708T090000",
      "SUMMARY:pay\u202Etnemetats", "LOCATION:room\u200B1", "DESCRIPTION:a\\,\u202Eb",
      "END:VEVENT",
    ].join("\r\n")));
    expect(events[0]).toMatchObject({ title: "paytnemetats", location: "room1", notes: "a,b" });
  });

  it("takes the first of several categories, lowercased and trimmed; an unknown STATUS is blank", () => {
    const { events } = parseIcs(wrap([
      "BEGIN:VEVENT", "DTSTART:20260708", "SUMMARY:x",
      "CATEGORIES: Work ,Home", "STATUS:maybe",
      "END:VEVENT",
    ].join("\r\n")));
    expect(events[0]).toMatchObject({ category: "work", status: "", all_day: true });
  });

  it("drops a garbage EXDATE piece and keeps the rest across several lines", () => {
    const { events } = parseIcs(wrap([
      "BEGIN:VEVENT", "DTSTART:20260708T090000", "SUMMARY:x",
      "EXDATE:20260709T090000,nope", "EXDATE:20260710T090000",
      "END:VEVENT",
    ].join("\r\n")));
    expect(events[0].exdates).toEqual(["2026-07-09T09:00", "2026-07-10T09:00"]);
  });

  it("clamps a task's PERCENT-COMPLETE and PRIORITY, and skips a task with no SUMMARY", () => {
    const { tasks } = parseIcs(wrap([
      "BEGIN:VTODO", "SUMMARY:a", "PERCENT-COMPLETE:150", "PRIORITY:12", "END:VTODO",
      "BEGIN:VTODO", "SUMMARY:b", "PERCENT-COMPLETE:-5", "PRIORITY:-1", "END:VTODO",
    ].join("\r\n")));
    expect(tasks.map((t) => [t.percent, t.priority])).toEqual([[100, 9], [0, 0]]);
    expect(parseIcs(wrap("BEGIN:VTODO\r\nDESCRIPTION:no summary\r\nEND:VTODO")).skipped).toBe(1);
  });

  // Suspected bug: `Number(val("PERCENT-COMPLETE"))` is 0 (finite) when the
  // property is absent, so buildTask's `status === "COMPLETED" ? 100` branch
  // never runs — a VTODO with STATUS:COMPLETED and no PERCENT-COMPLETE imports
  // at 0% while still getting a completed date.

  it("a COMPLETED status with no PERCENT-COMPLETE means 100%", () => {
    const { tasks } = parseIcs(wrap("BEGIN:VTODO\r\nSUMMARY:c\r\nSTATUS:COMPLETED\r\nEND:VTODO"));
    expect(tasks[0].percent).toBe(100);
    expect(tasks[0].completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("an END with no matching BEGIN, and a property outside any component, are ignored", () => {
    const { events, skipped } = parseIcs(wrap("END:VEVENT\r\nSUMMARY:orphan\r\nBEGIN:VEVENT\r\nDTSTART:20260708\r\nEND:VEVENT"));
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("");
    expect(skipped).toBe(0);
  });
});

describe("serialize → parse round-trips", () => {
  it("keeps unicode in every text field, folded lines included", () => {
    const original = event({
      title: "Zoë 🎉", location: "田中's 🏠", notes: `${"ü".repeat(120)}\n🎉`, category: "arbeit",
    });
    const { events } = parseIcs(serializeIcs([original], [], AT));
    expect(events[0]).toMatchObject({
      title: original.title, location: original.location, notes: original.notes, category: original.category,
    });
  });

  it("keeps the UID, the conference link and a RECURRENCE-ID, and mints a stable UID otherwise", () => {
    const original = event({
      uid: "abc@server", conference: "https://meet.example.org/x?y=1,2;3", recurrence_id: "2026-07-01T09:00",
    });
    const out = serializeIcs([original], [], AT);
    expect(out).toContain("CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO:https://meet.example.org/x?y=1,2;3");
    const { events } = parseIcs(out);
    expect(events[0]).toMatchObject({ uid: "abc@server", conference: original.conference, recurrence_id: "2026-07-01T09:00" });
    expect(icsUid({ id: "row-9", uid: "  " })).toBe(`row-9@${LEGACY_BRAND.slug}`);
    expect(parseIcs(serializeIcs([event({ id: "row-9" })], [], AT)).events[0].uid).toBe(`row-9@${LEGACY_BRAND.slug}`);
  });

  it("writes an all-day series' exdates as dates and reads them back as dates", () => {
    const original = event({
      start: "2026-07-08", end: "2026-07-09", all_day: true,
      rrule: { freq: "daily", interval: 1 }, exdates: ["2026-07-10"],
    });
    const out = serializeIcs([original], [], AT);
    expect(out).toContain("EXDATE;VALUE=DATE:20260710");
    expect(parseIcs(out).events[0].exdates).toEqual(["2026-07-10"]);
  });

  it("writes a moved occurrence as a second VEVENT that inherits the master's title", () => {
    const original = event({
      title: "weekly", location: "r1",
      rrule: { freq: "weekly", interval: 1 },
      overrides: [{ occurrence_start: "2026-07-15T09:00", start: "2026-07-15T11:00" }],
    });
    const { events } = parseIcs(serializeIcs([original], [], AT));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      title: "weekly", location: "r1", start: "2026-07-15T11:00", end: "2026-07-15T12:00",
      recurrence_id: "2026-07-15T09:00", uid: events[0].uid,
    });
  });

  it("an empty calendar is still a well-formed, CRLF-terminated file", () => {
    const out = serializeIcs([], [], AT);
    expect(out.split("\r\n").filter(Boolean)).toEqual([
      "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${BRAND.display}//Calendar//EN`, "CALSCALE:GREGORIAN", "END:VCALENDAR",
    ]);
    expect(out.endsWith("\r\n")).toBe(true);
  });
});
