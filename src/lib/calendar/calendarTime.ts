/**
 * Local wall-clock date/time math for the native calendar.
 *
 * Every timestamp the calendar stores is *local wall-clock*, never UTC:
 * `"YYYY-MM-DDTHH:MM"` for a timed event, `"YYYY-MM-DD"` for an all-day one
 * (mirroring `schema::calendar`). Keeping it wall-clock is what makes "09:00
 * standup" stay at 09:00 across timezone changes, and it is why nothing here
 * ever touches `Date.getTime()` epoch math for calendar arithmetic — a `Date` is
 * only ever used as a *civil* (y, m, d, h, min) carrier.
 *
 * Ends are **exclusive**: an all-day event on the 8th is `start "2026-07-08"`,
 * `end "2026-07-09"`. This is the iCalendar convention and it makes duration,
 * overlap and multi-day slicing fall out as plain subtraction.
 *
 * Pure — no React components, no Tauri. All of it is unit-tested. The one
 * outside read is the app language, as the default for the display helpers'
 * `lang`/`locale` (AM/PM marker, long date).
 */
import { dateLocale, translate, useI18nStore, type Language } from "../i18n";

/** Minutes in a day; the unit the time grid positions blocks in. */
export const MINUTES_PER_DAY = 24 * 60;

/** `0` = Sunday … `6` = Saturday, matching `Date.getDay()` and `Rrule.byweekday`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// ── Parse / format ──────────────────────────────────────────────────────────

/** The civil fields of a stored stamp. `hour`/`minute` are 0 for a date-only stamp. */
export interface Civil {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  /** True when the stamp carried no `T…` part (i.e. it is a bare date). */
  dateOnly: boolean;
}

/** Parse `"YYYY-MM-DD"` or `"YYYY-MM-DDTHH:MM"`. Returns null on garbage. */
export function parseStamp(stamp: string): Civil | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const civil: Civil = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: h === undefined ? 0 : Number(h),
    minute: mi === undefined ? 0 : Number(mi),
    dateOnly: h === undefined,
  };
  if (civil.month < 1 || civil.month > 12) return null;
  if (civil.day < 1 || civil.day > daysInMonth(civil.year, civil.month)) return null;
  if (civil.hour > 23 || civil.minute > 59) return null;
  return civil;
}

/** The date half of a stamp: `"2026-07-08T09:00"` → `"2026-07-08"`. */
export function datePart(stamp: string): string {
  return stamp.split("T")[0];
}

/** The time half, or `""` for a date-only stamp. */
export function timePart(stamp: string): string {
  const t = stamp.split("T")[1];
  return t ?? "";
}

/** A `Date` (local) → `"YYYY-MM-DD"`. Mirrors `ActivityCalendar.toDateStr`. */
export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A `Date` (local) → `"YYYY-MM-DDTHH:MM"`. */
export function toStamp(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${toDateStr(d)}T${h}:${mi}`;
}

/** `"YYYY-MM-DD"` (or a full stamp) → a local `Date` at that civil moment. */
export function toDate(stamp: string): Date {
  const c = parseStamp(stamp);
  if (!c) return new Date(NaN);
  return new Date(c.year, c.month - 1, c.day, c.hour, c.minute, 0, 0);
}

/** Today as `"YYYY-MM-DD"`. */
export function todayStr(now: Date = new Date()): string {
  return toDateStr(now);
}

// ── Civil arithmetic ────────────────────────────────────────────────────────

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Days in a 1-indexed month. */
export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/**
 * Add `n` days to a date/stamp, preserving whichever form came in (a bare date
 * stays a bare date; a timed stamp keeps its time).
 *
 * Goes through `Date` with the time pinned to noon. Midnight would be the obvious
 * choice, but on a spring-forward DST day midnight may not exist locally and the
 * `Date` constructor shifts it into the previous day — which would silently drop
 * a day from every recurrence crossing a DST boundary. Noon is never ambiguous.
 */
export function addDays(stamp: string, n: number): string {
  const c = parseStamp(stamp);
  if (!c) return stamp;
  const d = new Date(c.year, c.month - 1, c.day, 12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const date = toDateStr(d);
  return c.dateOnly
    ? date
    : `${date}T${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/** Add `n` months, clamping the day to the target month's length (Jan 31 +1mo → Feb 28). */
export function addMonths(stamp: string, n: number): string {
  const c = parseStamp(stamp);
  if (!c) return stamp;
  const total = (c.year * 12 + (c.month - 1)) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(c.day, daysInMonth(year, month));
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return c.dateOnly
    ? date
    : `${date}T${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/** Add `n` years, clamping Feb 29 → Feb 28 in a common year. */
export function addYears(stamp: string, n: number): string {
  return addMonths(stamp, n * 12);
}

/** Add `n` minutes to a timed stamp, rolling the date over. Date-only stamps pass through. */
export function addMinutes(stamp: string, n: number): string {
  const c = parseStamp(stamp);
  if (!c) return stamp;
  if (c.dateOnly) return stamp;
  const total = c.hour * 60 + c.minute + n;
  const dayShift = Math.floor(total / MINUTES_PER_DAY);
  const within = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const date = addDays(datePart(stamp), dayShift);
  return `${date}T${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
}

/** Minutes from local midnight. A date-only stamp is 0. */
export function minutesIntoDay(stamp: string): number {
  const c = parseStamp(stamp);
  if (!c) return 0;
  return c.hour * 60 + c.minute;
}

/** Whole days between two dates (`b - a`), ignoring any time part. */
export function daysBetween(a: string, b: string): number {
  const ca = parseStamp(a);
  const cb = parseStamp(b);
  if (!ca || !cb) return 0;
  // Noon again, so a DST transition inside the span cannot round the division wrong.
  const da = new Date(ca.year, ca.month - 1, ca.day, 12).getTime();
  const db = new Date(cb.year, cb.month - 1, cb.day, 12).getTime();
  return Math.round((db - da) / 86_400_000);
}

/** Minutes between two timed stamps (`b - a`). Used for durations. */
export function minutesBetween(a: string, b: string): number {
  return daysBetween(a, b) * MINUTES_PER_DAY + (minutesIntoDay(b) - minutesIntoDay(a));
}

/** Weekday of a date/stamp, `0` = Sunday. */
export function weekdayOf(stamp: string): Weekday {
  const c = parseStamp(stamp);
  if (!c) return 0;
  return new Date(c.year, c.month - 1, c.day, 12).getDay() as Weekday;
}

// ── Ranges ──────────────────────────────────────────────────────────────────

/**
 * The date the containing week starts on. `weekStart` is 0 (Sunday) or 1 (Monday)
 * — the two options the settings expose.
 */
export function startOfWeek(stamp: string, weekStart: 0 | 1): string {
  const dow = weekdayOf(stamp);
  const back = (dow - weekStart + 7) % 7;
  return addDays(datePart(stamp), -back);
}

/** The `n` consecutive dates starting at `start` (inclusive). */
export function dateRange(start: string, n: number): string[] {
  const out: string[] = [];
  let cur = datePart(start);
  for (let i = 0; i < n; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** The 7 dates of the week containing `stamp`. */
export function weekDates(stamp: string, weekStart: 0 | 1): string[] {
  return dateRange(startOfWeek(stamp, weekStart), 7);
}

/**
 * The weeks covering a month's grid: whole weeks from the one containing the 1st
 * through the one containing the last day, so the grid never clips the month.
 * `weeks` forces a fixed count (6 gives the stable-height month grid the pane
 * already renders; the multiweek view passes its own N).
 */
export function monthGrid(
  year: number,
  month: number,
  weekStart: 0 | 1,
  weeks = 6,
): string[][] {
  const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const gridStart = startOfWeek(first, weekStart);
  const out: string[][] = [];
  for (let w = 0; w < weeks; w++) {
    out.push(dateRange(addDays(gridStart, w * 7), 7));
  }
  return out;
}

// ── Event geometry ──────────────────────────────────────────────────────────

/** Anything with a start/end/all-day — an event or one expanded occurrence. */
export interface Span {
  start: string;
  end: string;
  allDay: boolean;
}

/**
 * Normalize a span whose end is missing, malformed, or not after its start.
 * A zero/negative-length event is unrenderable (and, in the time grid, invisible),
 * so it is given a minimum length instead of being dropped: a timed event gets
 * `minMinutes`, an all-day one gets its single day back.
 */
export function normalizeSpan(span: Span, minMinutes = 15): Span {
  const { start, allDay } = span;
  if (!parseStamp(start)) return span;

  if (allDay) {
    const end = parseStamp(span.end) ? datePart(span.end) : "";
    const oneDay = addDays(datePart(start), 1);
    return {
      start: datePart(start),
      end: end && end > datePart(start) ? end : oneDay,
      allDay: true,
    };
  }

  const end = parseStamp(span.end) ? span.end : "";
  const ok = end && minutesBetween(start, end) >= minMinutes;
  return { start, end: ok ? end : addMinutes(start, minMinutes), allDay: false };
}

/** Whether the span covers any part of `date` (exclusive end). */
export function spanCoversDate(span: Span, date: string): boolean {
  const s = normalizeSpan(span);
  const d = datePart(date);
  const startDate = datePart(s.start);
  // An exclusive end lands on the day AFTER the last covered one — except for a
  // timed event ending exactly at midnight, which must not claim the next day.
  const endDate = s.allDay
    ? datePart(s.end)
    : minutesIntoDay(s.end) === 0
      ? datePart(s.end)
      : addDays(datePart(s.end), 1);
  return d >= startDate && d < endDate;
}

/** Every date the span touches. A single-day event yields one date. */
export function spanDates(span: Span): string[] {
  const s = normalizeSpan(span);
  const startDate = datePart(s.start);
  const endDate = s.allDay
    ? datePart(s.end)
    : minutesIntoDay(s.end) === 0
      ? datePart(s.end)
      : addDays(datePart(s.end), 1);
  const n = Math.max(1, daysBetween(startDate, endDate));
  return dateRange(startDate, n);
}

/**
 * An all-day event's stored (exclusive) end → the inclusive last day a date
 * picker should show. Stored `"2026-07-09"` displays as `"2026-07-08"`.
 *
 * The pair below is the only place the exclusive-end convention is translated for
 * a human. Getting the direction wrong lands the end a day before the start, so
 * they are kept together and round-trip-tested.
 */
export function allDayEndToLastDay(end: string): string {
  const d = datePart(end);
  return parseStamp(d) ? addDays(d, -1) : end;
}

/** The inclusive last day from a picker → the exclusive end to store. */
export function lastDayToAllDayEnd(lastDay: string): string {
  const d = datePart(lastDay);
  return parseStamp(d) ? addDays(d, 1) : lastDay;
}

/**
 * The span's vertical extent within one day of the time grid, as minutes from
 * that day's midnight. A multi-day event is clipped to the day: it starts at 0
 * on any day after its first, and runs to `MINUTES_PER_DAY` on any day before
 * its last. Returns null when the span does not touch the day at all.
 */
export function daySlice(
  span: Span,
  date: string,
): { startMin: number; endMin: number } | null {
  const s = normalizeSpan(span);
  if (!spanCoversDate(s, date)) return null;

  const d = datePart(date);
  const startsHere = datePart(s.start) === d;
  const lastDay = s.allDay
    ? addDays(datePart(s.end), -1)
    : minutesIntoDay(s.end) === 0
      ? addDays(datePart(s.end), -1)
      : datePart(s.end);
  const endsHere = lastDay === d;

  return {
    startMin: startsHere ? minutesIntoDay(s.start) : 0,
    endMin: endsHere ? minutesIntoDay(s.end) || MINUTES_PER_DAY : MINUTES_PER_DAY,
  };
}

// ── Overlap layout ──────────────────────────────────────────────────────────

/** An item to lay out in the time grid: its day-slice plus whatever payload. */
export interface Placeable {
  startMin: number;
  endMin: number;
}

/** Where a laid-out block sits horizontally, as fractions of the day column. */
export interface Placement {
  /** Left edge, 0-1. */
  left: number;
  /** Width, 0-1. */
  width: number;
  /** Index within its overlap cluster, useful for z-order/debug. */
  column: number;
  /** How many columns its cluster was split into. */
  columns: number;
}

/**
 * Lay overlapping blocks side by side, the way every day/week grid does it.
 *
 * Blocks are grouped into *clusters* of transitively-overlapping items; within a
 * cluster each block takes the leftmost column free at its start, and the cluster
 * is divided into as many columns as its busiest moment needs. Two events that do
 * not overlap therefore each keep the full width, while three that all collide
 * each get a third.
 *
 * Returns placements positionally aligned with `items`.
 */
export function layoutOverlaps(items: Placeable[]): Placement[] {
  const order = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.startMin - b.item.startMin || a.item.endMin - b.item.endMin);

  const placements = new Array<Placement>(items.length);

  // Walk in start order, accumulating a cluster until a gap appears (a block that
  // starts at/after every open block has ended).
  let cluster: { i: number; column: number; endMin: number }[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const columns = Math.max(...cluster.map((c) => c.column)) + 1;
    for (const c of cluster) {
      placements[c.i] = {
        left: c.column / columns,
        width: 1 / columns,
        column: c.column,
        columns,
      };
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  // Column end-times within the current cluster; a column is free once its last
  // block has ended.
  let columnEnds: number[] = [];

  for (const { item, i } of order) {
    if (item.startMin >= clusterEnd) {
      flush();
      columnEnds = [];
    }
    let column = columnEnds.findIndex((end) => end <= item.startMin);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.endMin);
    } else {
      columnEnds[column] = item.endMin;
    }
    cluster.push({ i, column, endMin: item.endMin });
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  flush();

  return placements;
}

// ── Display ─────────────────────────────────────────────────────────────────

/**
 * `"09:00"` → `"9:00 AM"` when `use24h` is false; unchanged when it is true.
 *
 * Anything that is not an `HH:MM` comes back untouched — including the empty
 * string, which is what `timePart` returns for a date-only stamp and therefore
 * the single most common argument at the call sites that print an *optional*
 * hour (a to-do card's deadline, an all-day row). It has to be checked as a
 * shape rather than with `isNaN(h)`: `"".split(":")` is `[""]`, and `Number("")`
 * is `0`, not `NaN`, so a laxer guard renders an absent time as "12:undefined AM".
 */
export function formatTime(
  hhmm: string,
  use24h: boolean,
  lang: Language = useI18nStore.getState().lang,
): string {
  if (use24h) return hhmm;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  if (hour > 23) return hhmm;
  // The day-period marker is the app language's ("a. m." in Spanish), never
  // the browser's: the rest of the row around it is in the app language too.
  const suffix = translate(lang, hour < 12 ? "calendarTime.am" : "calendarTime.pm");
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m[2]} ${suffix}`;
}

/** The clock label for a stamp, or `""` for an all-day one. */
export function formatStampTime(
  stamp: string,
  use24h: boolean,
  lang: Language = useI18nStore.getState().lang,
): string {
  const t = timePart(stamp);
  return t ? formatTime(t, use24h, lang) : "";
}

/** A long, human date: `"Wednesday, July 8, 2026"`. Without a `locale` it is
 *  spelled in the app language (keeping the browser's region when the two
 *  agree — `dateLocale`), never a fixed English. */
export function formatLongDate(date: string, locale: string | undefined = dateLocale()): string {
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Full month name (1-based) in the given locale, via `Intl` — no hand-rolled
 * translation table, so it's correct (spelling, casing convention) for any
 * locale the browser supports without maintaining one.
 */
export function monthName(locale: string, month: number): string {
  return new Date(Date.UTC(2000, month - 1, 1)).toLocaleDateString(locale, {
    month: "long",
    timeZone: "UTC",
  });
}

/**
 * Weekday label for a day-of-week index (0 = Sunday .. 6 = Saturday), in the
 * given form ("long"/"short"/"narrow"), via `Intl`. 2023-01-01 is a Sunday
 * (UTC), so UTC day `1 + dayIndex` always lands on the right weekday.
 */
export function weekdayLabel(
  locale: string,
  dayIndex: number,
  form: "long" | "short" | "narrow" = "long",
): string {
  return new Date(Date.UTC(2023, 0, 1 + dayIndex)).toLocaleDateString(locale, {
    weekday: form,
    timeZone: "UTC",
  });
}
