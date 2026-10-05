/**
 * iCalendar (RFC 5545) import/export — the subset Tabtivity's model actually holds.
 *
 * Parsing lives here, in tested TypeScript, rather than in Rust: the backend
 * stays a dumb store, and the format's real complexity (line folding, escaping,
 * the DTSTART/DTEND value-type dance) is all string work that is far cheaper to
 * unit-test on this side.
 *
 * **Times are read and written as local wall-clock**, matching the rest of the
 * calendar. A `Z`-suffixed (UTC) timestamp in an imported file is converted to
 * local time on the way in; everything is written back as floating local time.
 * `VTIMEZONE` blocks are ignored — a `TZID` we do not understand would otherwise
 * silently shift an event, and dropping to floating local is the honest failure.
 *
 * Supported: VEVENT, VTODO, VALARM (display, minute-offset triggers), RRULE
 * (FREQ/INTERVAL/BYDAY incl. numbered weekdays/BYMONTHDAY/UNTIL/COUNT, and
 * BYSETPOS/BYMONTH where they spell a numbered weekday; any other rule keeps
 * its text to be written back as it came), EXDATE, CATEGORIES, LOCATION,
 * DESCRIPTION, SUMMARY, STATUS, PRIORITY, PERCENT-COMPLETE, COMPLETED.
 */

import type {
  Alarm,
  CalendarEvent,
  CalendarTask,
  EventStatus,
  Freq,
  Rrule,
} from "../../types";
import { addDays, addMinutes, datePart, minutesBetween, parseStamp } from "./calendarTime";
import { stripFormatControls } from "../textSafety";
import { BRAND, PINNED_ICS_UID_DOMAIN } from "../brand";

const ICS_WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// ── Line handling ───────────────────────────────────────────────────────────

/**
 * Unfold the content lines. RFC 5545 wraps long lines by inserting CRLF followed
 * by a single space or tab, which must be stitched back before anything is parsed.
 */
export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.trim() !== "");
}

/** The UTF-8 length of one code point. */
function octetsOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * Fold a content line at 75 octets, per RFC 5545 — octets, not UTF-16 units, so
 * a line of non-ASCII text folds where the RFC says and never splits a code
 * point (which no reader could stitch back).
 */
export function fold(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let octets = 0;
  for (const ch of line) {
    const n = octetsOf(ch);
    if (octets + n > 75) {
      parts.push(cur);
      cur = " ";
      octets = 1;
    }
    cur += ch;
    octets += n;
  }
  parts.push(cur);
  return parts.join("\r\n");
}

/**
 * Escape a TEXT value: backslash, semicolon, comma and newline are special. A
 * CR (a note pasted from Windows) has no TEXT form at all — written raw it would
 * read back as a line break and take the rest of the value with it — so line
 * endings are normalised to `\n` first.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Reverse `escapeText`. */
export function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      const next = value[++i];
      if (next === "n" || next === "N") out += "\n";
      else out += next; // \\ \; \, and anything else → the literal char
    } else {
      out += value[i];
    }
  }
  return out;
}

/** One parsed content line: `NAME;PARAM=X:VALUE`. */
interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Split a content line, honouring quoted parameter values (which may hold `:`). */
export function parseLine(line: string): Line | null {
  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  // Parameters split on `;` outside quotes: a quoted value may hold one
  // (`CN="Doe; Jane"`) as well as a `:`.
  const segments: string[] = [];
  let seg = "";
  let quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      segments.push(seg);
      seg = "";
    } else {
      seg += c;
    }
  }
  segments.push(seg);
  const name = segments[0].toUpperCase();

  const params: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

// ── Date/time values ────────────────────────────────────────────────────────

/**
 * An ICS DATE or DATE-TIME → a local stamp.
 *
 * `20260708`         → `"2026-07-08"`      (a date; all-day)
 * `20260708T090000`  → `"2026-07-08T09:00"` (floating local)
 * `20260708T070000Z` → converted from UTC into local time
 */
export function parseIcsDate(value: string): { stamp: string; dateOnly: boolean } | null {
  const v = value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { stamp: `${y}-${m}-${d}`, dateOnly: true };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!dt) return null;
  const [, y, mo, d, h, mi, , z] = dt;

  if (z) {
    // UTC → local. This is the one place an epoch conversion is correct: the
    // source really is an absolute instant.
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    const local = new Date(utc);
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      stamp: `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())}T${p(local.getHours())}:${p(local.getMinutes())}`,
      dateOnly: false,
    };
  }

  return { stamp: `${y}-${mo}-${d}T${h}:${mi}`, dateOnly: false };
}

/** A local stamp → an ICS DATE (all-day) or floating DATE-TIME. */
export function formatIcsDate(stamp: string, allDay: boolean): string {
  const c = parseStamp(stamp);
  if (!c) return stamp;
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${String(c.year).padStart(4, "0")}${p(c.month)}${p(c.day)}`;
  if (allDay) return date;
  return `${date}T${p(c.hour)}${p(c.minute)}00`;
}

/** A UTC stamp for DTSTAMP, which must be absolute. */
function icsNowUtc(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

// ── RRULE ───────────────────────────────────────────────────────────────────

/**
 * The RRULE parts the model holds. Anything else in a rule — `BYHOUR`,
 * `BYYEARDAY`, `BYSETPOS` over several days… — cannot be expanded here, so the
 * rule keeps its original text (`ics_value`) to write back unreduced.
 * `WKST` only moves which day a week starts on, which Tabtivity's weekly expansion
 * does not consult either way.
 */
const HELD_RRULE_PARTS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "UNTIL", "COUNT", "WKST"]);

/** `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=10` → an `Rrule`. */
export function parseRrule(value: string): Rrule | null {
  const parts: Record<string, string> = {};
  for (const chunk of value.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq > 0) parts[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1);
  }

  const freqRaw = (parts.FREQ ?? "").toUpperCase();
  const freq = (
    { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" } as const
  )[freqRaw as "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"];
  // An unsupported FREQ (SECONDLY/MINUTELY/HOURLY) is dropped rather than guessed
  // at — the event still imports, just without its rule.
  if (!freq) return null;

  const rule: Rrule = { freq: freq as Freq, interval: Number(parts.INTERVAL) || 1 };
  // Set wherever the model reads the rule as something narrower than it says.
  let reduced = Object.keys(parts).some((k) => !HELD_RRULE_PARTS.has(k) && k !== "BYMONTH" && k !== "BYSETPOS");

  if (parts.BYDAY) {
    // `2MO` = the 2nd Monday, `-1FR` = the last Friday, `TU` = every Tuesday.
    const tokens = parts.BYDAY.split(",")
      .map((d) => /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(d.trim().toUpperCase()))
      .filter((m): m is RegExpExecArray => !!m && ICS_WEEKDAYS.includes(m[2]))
      .map((m) => ({ n: m[1] ? Number(m[1]) : 0, day: ICS_WEEKDAYS.indexOf(m[2]) }));
    const numbered = tokens.filter((t) => t.n !== 0);
    const setpos = parts.BYSETPOS !== undefined ? Number(parts.BYSETPOS) : null;
    // Yearly ordinals count within a month only when BYMONTH names one; without
    // it "20MO" is the 20th Monday of the YEAR, which the model does not hold.
    const inMonth =
      freq === "monthly" ||
      (freq === "yearly" && parts.BYMONTH !== undefined && /^\d{1,2}$/.test(parts.BYMONTH.trim()));
    const validN = (n: number) => n !== 0 && Math.abs(n) <= 5;

    if (inMonth && numbered.length > 0 && numbered.length === tokens.length && tokens.every((t) => validN(t.n)) && setpos === null) {
      rule.bynthweekday = tokens;
    } else if (inMonth && numbered.length === 0 && tokens.length === 1 && setpos !== null && validN(setpos)) {
      // Outlook/Exchange's spelling of the same thing: `BYDAY=TU;BYSETPOS=2`.
      rule.bynthweekday = [{ n: setpos, day: tokens[0].day }];
    } else {
      // Plain weekdays — or ordinals the model cannot place, which degrade to
      // their weekday. Only a weekly rule expands them as written.
      const days = tokens.map((t) => t.day);
      if (days.length) rule.byweekday = days;
      if (tokens.length && (freq !== "weekly" || numbered.length > 0)) reduced = true;
      if (setpos !== null) reduced = true;
    }
    if (parts.BYMONTH !== undefined && !(freq === "yearly" && rule.bynthweekday)) reduced = true;
  } else if (parts.BYSETPOS !== undefined || parts.BYMONTH !== undefined) {
    // A single BYMONTH on a yearly rule restates the start's own month.
    if (!(freq === "yearly" && parts.BYSETPOS === undefined && /^\d{1,2}$/.test(parts.BYMONTH!.trim()))) {
      reduced = true;
    }
  }

  if (parts.BYMONTHDAY) {
    const list = parts.BYMONTHDAY.split(",");
    const day = Number(list[0]);
    if (day >= 1 && day <= 31) rule.bymonthday = day;
    // Several days, or one counted from the month's end (`-1` = the last day).
    if (list.length > 1 || (day < 0 && day >= -31)) reduced = true;
    // BYMONTHDAY with BYDAY means their intersection (Friday the 13th).
    if (parts.BYDAY) reduced = true;
  }

  if (parts.COUNT) {
    const n = Number(parts.COUNT);
    if (n > 0) rule.count = n;
  }

  if (parts.UNTIL) {
    const until = parseIcsDate(parts.UNTIL);
    if (until) rule.until = datePart(until.stamp);
  }

  if (reduced) rule.ics_value = value.trim();
  return rule;
}

/**
 * Whether two rules say the same thing, by the fields the model expands — the
 * imported `ics_value` aside. How an editor tells "the user changed the rule"
 * from "the user saved an event whose rule came from a server".
 */
export function sameRule(a: Rrule, b: Rrule): boolean {
  return formatRuleFields(a) === formatRuleFields(b);
}

/**
 * An `Rrule` → an RRULE value.
 *
 * `start` is the event's start: a yearly rule on a numbered weekday names its
 * month from it (`FREQ=YEARLY;BYMONTH=11;BYDAY=4TH`). An imported rule the
 * model could not fully hold is written back as it arrived, as long as it still
 * reads the same — an edit that changed it writes the model instead.
 */
export function formatRrule(rule: Rrule, start?: string): string {
  if (rule.ics_value) {
    const imported = parseRrule(rule.ics_value);
    if (imported && sameRule(imported, rule)) return rule.ics_value;
  }
  return formatRuleFields(rule, start);
}

function formatRuleFields(rule: Rrule, start?: string): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval && rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  const nth = (rule.freq === "monthly" || rule.freq === "yearly") ? rule.bynthweekday ?? [] : [];
  if (nth.length) {
    const month = start ? parseStamp(start)?.month : undefined;
    if (rule.freq === "yearly" && month) parts.push(`BYMONTH=${month}`);
    parts.push(`BYDAY=${nth.map((e) => `${e.n}${ICS_WEEKDAYS[e.day]}`).join(",")}`);
  } else {
    if (rule.byweekday?.length) {
      parts.push(`BYDAY=${rule.byweekday.map((d) => ICS_WEEKDAYS[d]).join(",")}`);
    }
    if (rule.bymonthday) parts.push(`BYMONTHDAY=${rule.bymonthday}`);
  }
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${formatIcsDate(rule.until, true)}`);
  return parts.join(";");
}

// ── Alarms ──────────────────────────────────────────────────────────────────

/**
 * A VALARM TRIGGER duration → minutes *before* the start.
 *
 * `-PT15M` → 15, `-PT1H` → 60, `-P1D` → 1440, `PT0S` → 0. A positive trigger
 * (after the start) comes back negative, which is exactly how `Alarm` stores it.
 */
export function parseTrigger(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, d, h, min, s] = m;
  const total =
    (Number(d) || 0) * 1440 +
    (Number(h) || 0) * 60 +
    (Number(min) || 0) +
    Math.round((Number(s) || 0) / 60);
  // A negative duration fires BEFORE the start → a positive minutes_before.
  const minutes = sign === "-" ? total : -total;
  // Negating zero yields -0, which is === 0 but not Object.is-equal to it and
  // would serialize as "-0". Normalize it away.
  return minutes === 0 ? 0 : minutes;
}

/** Minutes-before → a TRIGGER duration. */
export function formatTrigger(minutesBefore: number): string {
  const sign = minutesBefore >= 0 ? "-" : "";
  const abs = Math.abs(minutesBefore);
  if (abs === 0) return "PT0S";
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const mins = abs % 60;
  let out = sign + "P";
  if (days) out += `${days}D`;
  if (hours || mins) {
    out += "T";
    if (hours) out += `${hours}H`;
    if (mins) out += `${mins}M`;
  }
  return out;
}

// ── Parse ───────────────────────────────────────────────────────────────────

export interface ParsedIcs {
  events: Omit<CalendarEvent, "id" | "calendar_id">[];
  tasks: Omit<CalendarTask, "id" | "calendar_id">[];
  /** Components that could not be understood, for a "skipped N" report. */
  skipped: number;
}

const STATUSES: Record<string, EventStatus> = {
  CONFIRMED: "confirmed",
  TENTATIVE: "tentative",
  CANCELLED: "cancelled",
};

/**
 * Parse an .ics file into events and tasks.
 *
 * Unknown components (VTIMEZONE, VFREEBUSY, VJOURNAL) and unparseable ones are
 * skipped and counted, never guessed at — a partial import that reports what it
 * dropped beats one that invents data.
 */
export function parseIcs(text: string): ParsedIcs {
  const lines = unfold(text);
  const events: ParsedIcs["events"] = [];
  const tasks: ParsedIcs["tasks"] = [];
  let skipped = 0;

  // The component stack; only VEVENT/VTODO (and a VALARM inside one) are entered.
  let mode: "none" | "event" | "todo" = "none";
  let inAlarm = false;
  let cur: Record<string, Line[]> = {};
  let alarms: Alarm[] = [];
  let alarmTrigger: number | null = null;

  const reset = () => {
    cur = {};
    alarms = [];
    inAlarm = false;
    alarmTrigger = null;
  };

  const first = (name: string): Line | undefined => cur[name]?.[0];
  // Every text field of an event or a task comes through here, which is why the
  // format-control strip lives here rather than on the three or four fields
  // somebody remembered. An imported `.ics` is a file another person wrote — the
  // same trust level as a mail subject or a page title, both of which are
  // stripped — and a `SUMMARY` carrying U+202E renders in the agenda as an event
  // it is not. Unescaping first is deliberate: ICS escaping is the transport, so
  // a disguise hidden behind it would otherwise appear only after this ran.
  const val = (name: string): string =>
    first(name) ? stripFormatControls(unescapeText(first(name)!.value)) : "";

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;

    if (line.name === "BEGIN") {
      const comp = line.value.toUpperCase();
      if (comp === "VEVENT") {
        mode = "event";
        reset();
      } else if (comp === "VTODO") {
        mode = "todo";
        reset();
      } else if (comp === "VALARM" && mode !== "none") {
        inAlarm = true;
        alarmTrigger = null;
      }
      continue;
    }

    if (line.name === "END") {
      const comp = line.value.toUpperCase();

      if (comp === "VALARM" && inAlarm) {
        if (alarmTrigger !== null) alarms.push({ minutes_before: alarmTrigger });
        inAlarm = false;
        continue;
      }

      if (comp === "VEVENT" && mode === "event") {
        const event = buildEvent(cur, alarms, val);
        if (event) events.push(event);
        else skipped++;
        mode = "none";
        reset();
        continue;
      }

      if (comp === "VTODO" && mode === "todo") {
        const task = buildTask(cur, alarms, val);
        if (task) tasks.push(task);
        else skipped++;
        mode = "none";
        reset();
        continue;
      }
      continue;
    }

    if (mode === "none") continue;

    if (inAlarm) {
      if (line.name === "TRIGGER") alarmTrigger = parseTrigger(line.value);
      continue;
    }

    (cur[line.name] ??= []).push(line);
  }

  return { events, tasks, skipped };
}

function buildEvent(
  cur: Record<string, Line[]>,
  alarms: Alarm[],
  val: (n: string) => string,
): Omit<CalendarEvent, "id" | "calendar_id"> | null {
  const dtstart = cur.DTSTART?.[0];
  if (!dtstart) return null;
  const start = parseIcsDate(dtstart.value);
  if (!start) return null;

  const allDay =
    start.dateOnly || (dtstart.params.VALUE ?? "").toUpperCase() === "DATE";

  // DTEND is exclusive in ICS, exactly as we store it. A missing DTEND means a
  // DURATION or a default: an all-day event is one day, a timed one an hour.
  let end: string;
  const dtend = cur.DTEND?.[0];
  const parsedEnd = dtend ? parseIcsDate(dtend.value) : null;
  if (parsedEnd) {
    end = parsedEnd.stamp;
  } else if (allDay) {
    end = addDays(start.stamp, 1);
  } else {
    const c = parseStamp(start.stamp)!;
    const mins = c.hour * 60 + c.minute + 60;
    const p = (n: number) => String(n).padStart(2, "0");
    end = `${addDays(datePart(start.stamp), Math.floor(mins / 1440))}T${p(Math.floor((mins % 1440) / 60))}:${p(mins % 60)}`;
  }

  const exdates: string[] = [];
  for (const line of cur.EXDATE ?? []) {
    for (const piece of line.value.split(",")) {
      const d = parseIcsDate(piece);
      if (d) exdates.push(d.stamp);
    }
  }

  const rruleLine = cur.RRULE?.[0];
  const rrule = rruleLine ? parseRrule(rruleLine.value) : null;

  return {
    start: start.stamp,
    end,
    all_day: allDay,
    title: val("SUMMARY"),
    location: val("LOCATION"),
    notes: val("DESCRIPTION"),
    // RFC 7986's `CONFERENCE` first, then Google's older `X-GOOGLE-CONFERENCE`,
    // which is what a Meet invitation actually arrives with. Neither is trusted
    // on sight: `conferenceLink` still refuses anything that is not `http(s)`,
    // so a `zoommtg:` URL in an imported file cannot become a Join button. What
    // is NOT read here is the link most invitations really carry — the one
    // inside LOCATION or DESCRIPTION — because copying it into the field at
    // import time would freeze a guess into the user's own data; it is derived
    // at render time instead, where it can be corrected by editing the event.
    conference: val("CONFERENCE") || val("X-GOOGLE-CONFERENCE"),
    // ICS allows several categories; the model holds one, so the first wins.
    category: (val("CATEGORIES").split(",")[0] ?? "").trim().toLowerCase(),
    status: STATUSES[val("STATUS").toUpperCase()] ?? "",
    rrule,
    exdates,
    overrides: [],
    alarms,
    // ── The two round-trip fields (CalDAV push, `docs/caldav_plan.md` Phase 3)
    //
    // Neither is displayed anywhere, and both exist because a row that came from
    // a server has to be able to go *back* as the same resource it arrived as.
    //
    // `UID` is the calendar object's identity everywhere except this app, and
    // re-minting it on a write is how one appointment becomes two: the server
    // keeps what it has under the old UID and accepts ours as something new.
    //
    // `RECURRENCE-ID` is the harder one. CalDAV has no separate object for an
    // occurrence, so a "this event only" edit rides in the *same resource* as its
    // master, as a second VEVENT naming the slot it replaces. This parser keeps
    // those as separate rows (the href group is what holds them together — see
    // `merge_caldav_calendar_at`), so without this field the row would remember
    // that it is an override but not *of what*, and pushing the series back would
    // write two masters with one UID.
    uid: val("UID"),
    recurrence_id: cur["RECURRENCE-ID"]?.[0]
      ? (parseIcsDate(cur["RECURRENCE-ID"][0].value)?.stamp ?? "")
      : "",
  };
}

function buildTask(
  cur: Record<string, Line[]>,
  alarms: Alarm[],
  val: (n: string) => string,
): Omit<CalendarTask, "id" | "calendar_id"> | null {
  const summary = val("SUMMARY");
  if (!summary) return null;

  const due = cur.DUE?.[0] ? parseIcsDate(cur.DUE[0].value) : null;
  const start = cur.DTSTART?.[0] ? parseIcsDate(cur.DTSTART[0].value) : null;
  const completed = cur.COMPLETED?.[0] ? parseIcsDate(cur.COMPLETED[0].value) : null;

  // `Number("")` is 0, which would make an absent PERCENT-COMPLETE look like an
  // explicit 0 % and hide a COMPLETED status; only a present value counts.
  const percentText = val("PERCENT-COMPLETE").trim();
  const percentRaw = percentText === "" ? NaN : Number(percentText);
  const status = val("STATUS").toUpperCase();
  const percent = Number.isFinite(percentRaw)
    ? Math.max(0, Math.min(100, percentRaw))
    : status === "COMPLETED"
      ? 100
      : 0;

  const priorityRaw = Number(val("PRIORITY"));

  return {
    title: summary,
    notes: val("DESCRIPTION"),
    due: due?.stamp ?? null,
    start: start?.stamp ?? null,
    priority: Number.isFinite(priorityRaw) ? Math.max(0, Math.min(9, priorityRaw)) : 0,
    // A COMPLETED stamp means done, whatever PERCENT-COMPLETE claims.
    percent: completed ? 100 : percent,
    completed: completed?.stamp ?? (status === "COMPLETED" ? datePart(new Date().toISOString()) : null),
    category: (val("CATEGORIES").split(",")[0] ?? "").trim().toLowerCase(),
    alarms,
    // The server's own identity for this VTODO — see `buildEvent`. A task has no
    // recurrence-override case worth carrying (nothing in this app edits a single
    // occurrence of a repeating to-do), so only the UID travels.
    uid: val("UID"),
  };
}

// ── Serialize ───────────────────────────────────────────────────────────────

/**
 * The UID a row is written under.
 *
 * A row that came from a server keeps **its** UID; one written here derives a
 * stable synthetic one from the row id, which never changes for the life of the
 * row. Re-minting a UID on a write is how one appointment becomes two — the
 * server keeps what it holds under the old identity and files ours as new.
 */
/**
 * The end an override lands on when it moved the start and said nothing about
 * the end.
 *
 * This is `expandEvents`' rule ("an override that moves the start but not the
 * end keeps the duration"), applied to the serialized form. It has to be the
 * same rule: the grid draws the occurrence from that expansion, and a file whose
 * DTEND disagreed with what the user is looking at would be wrong in the one way
 * nobody would think to check.
 */
function shiftedEnd(event: CalendarEvent, occurrenceStart: string, newStart: string): string {
  if (event.all_day) return addDays(newStart, 1);
  const durationMin = minutesBetween(event.start, event.end);
  if (newStart === occurrenceStart) return addMinutes(occurrenceStart, durationMin);
  return addMinutes(newStart, durationMin);
}

/**
 * The UID of a row that carries none: `<row id>@<domain>`. The domain is
 * pinned (`PINNED_ICS_UID_DOMAIN`): the UID is what an importer and a CalDAV
 * server know the event by, so a UID that followed a rename would make every
 * such event a new one on the next export or push.
 */
export function icsUid(row: { id: string; uid?: string }): string {
  const uid = (row.uid ?? "").trim();
  return uid || `${row.id}@${PINNED_ICS_UID_DOMAIN}`;
}

/**
 * Write events and tasks as an .ics file.
 *
 * `now` is injected rather than read from the clock so the output is
 * deterministic and the round-trip is testable.
 *
 * A recurring event's **occurrence edits** are written the only way iCalendar
 * has to express them: extra `VEVENT` components sharing the master's UID and
 * naming the slot they replace with `RECURRENCE-ID`. Tabtivity stores those in the
 * master's `overrides[]`, and until this existed they were simply dropped from
 * every export — a series exported and re-imported came back with each moved
 * occurrence silently back in its original place.
 */
export function serializeIcs(
  events: CalendarEvent[],
  tasks: CalendarTask[] = [],
  now: Date = new Date(),
): string {
  const stamp = icsNowUtc(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${BRAND.display}//Calendar//EN`,
    "CALSCALE:GREGORIAN",
  ];

  const push = (name: string, value: string) => lines.push(fold(`${name}:${value}`));

  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    push("UID", icsUid(e));
    push("DTSTAMP", stamp);
    // A row that *is* an override (one parsed out of a CalDAV resource, where
    // master and overrides arrive as separate rows sharing one href) names the
    // slot it replaces. A row that merely *has* overrides emits them below, as
    // components of its own.
    if (e.recurrence_id) {
      lines.push(
        fold(
          e.all_day
            ? `RECURRENCE-ID;VALUE=DATE:${formatIcsDate(e.recurrence_id, true)}`
            : `RECURRENCE-ID:${formatIcsDate(e.recurrence_id, false)}`,
        ),
      );
    }
    lines.push(
      fold(
        e.all_day
          ? `DTSTART;VALUE=DATE:${formatIcsDate(e.start, true)}`
          : `DTSTART:${formatIcsDate(e.start, false)}`,
      ),
    );
    lines.push(
      fold(
        e.all_day
          ? `DTEND;VALUE=DATE:${formatIcsDate(e.end, true)}`
          : `DTEND:${formatIcsDate(e.end, false)}`,
      ),
    );
    push("SUMMARY", escapeText(e.title));
    if (e.location) push("LOCATION", escapeText(e.location));
    if (e.notes) push("DESCRIPTION", escapeText(e.notes));
    // RFC 7986's property, with the params every reader expects: a URI value,
    // and the features that say what kind of call it is. Not escaped — a URI is
    // not a TEXT value, and escaping it would put backslashes in the link.
    if (e.conference) {
      lines.push(fold(`CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO:${e.conference}`));
    }
    if (e.category) push("CATEGORIES", escapeText(e.category));
    if (e.status) push("STATUS", e.status.toUpperCase());
    if (e.rrule) push("RRULE", formatRrule(e.rrule, e.start));
    for (const ex of e.exdates ?? []) {
      lines.push(
        fold(
          e.all_day
            ? `EXDATE;VALUE=DATE:${formatIcsDate(ex, true)}`
            : `EXDATE:${formatIcsDate(ex, false)}`,
        ),
      );
    }
    for (const alarm of e.alarms ?? []) {
      lines.push("BEGIN:VALARM");
      push("ACTION", "DISPLAY");
      push("DESCRIPTION", escapeText(e.title));
      push("TRIGGER", formatTrigger(alarm.minutes_before));
      lines.push("END:VALARM");
    }
    lines.push("END:VEVENT");

    // Each "this event only" edit, as its own component. It inherits everything
    // the override does not restate — an occurrence moved by an hour is still
    // the same meeting, and a reader that saw only the changed field would show
    // it with no title.
    for (const ov of e.overrides ?? []) {
      const start = ov.start || ov.occurrence_start;
      const end = ov.end || shiftedEnd(e, ov.occurrence_start, start);
      lines.push("BEGIN:VEVENT");
      push("UID", icsUid(e));
      push("DTSTAMP", stamp);
      lines.push(
        fold(
          e.all_day
            ? `RECURRENCE-ID;VALUE=DATE:${formatIcsDate(ov.occurrence_start, true)}`
            : `RECURRENCE-ID:${formatIcsDate(ov.occurrence_start, false)}`,
        ),
      );
      lines.push(
        fold(
          e.all_day
            ? `DTSTART;VALUE=DATE:${formatIcsDate(start, true)}`
            : `DTSTART:${formatIcsDate(start, false)}`,
        ),
      );
      lines.push(
        fold(
          e.all_day
            ? `DTEND;VALUE=DATE:${formatIcsDate(end, true)}`
            : `DTEND:${formatIcsDate(end, false)}`,
        ),
      );
      push("SUMMARY", escapeText(ov.title ?? e.title));
      const location = ov.location ?? e.location;
      if (location) push("LOCATION", escapeText(location));
      const notes = ov.notes ?? e.notes;
      if (notes) push("DESCRIPTION", escapeText(notes));
      if (e.category) push("CATEGORIES", escapeText(e.category));
      if (e.status) push("STATUS", e.status.toUpperCase());
      lines.push("END:VEVENT");
    }
  }

  for (const t of tasks) {
    lines.push("BEGIN:VTODO");
    push("UID", icsUid(t));
    push("DTSTAMP", stamp);
    push("SUMMARY", escapeText(t.title));
    if (t.notes) push("DESCRIPTION", escapeText(t.notes));
    if (t.start) push("DTSTART", formatIcsDate(t.start, !t.start.includes("T")));
    if (t.due) push("DUE", formatIcsDate(t.due, !t.due.includes("T")));
    if (t.priority) push("PRIORITY", String(t.priority));
    if (t.percent) push("PERCENT-COMPLETE", String(t.percent));
    if (t.percent >= 100) push("STATUS", "COMPLETED");
    if (t.completed) push("COMPLETED", formatIcsDate(t.completed, false));
    if (t.category) push("CATEGORIES", escapeText(t.category));
    for (const alarm of t.alarms ?? []) {
      lines.push("BEGIN:VALARM");
      push("ACTION", "DISPLAY");
      push("DESCRIPTION", escapeText(t.title));
      push("TRIGGER", formatTrigger(alarm.minutes_before));
      lines.push("END:VALARM");
    }
    lines.push("END:VTODO");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
