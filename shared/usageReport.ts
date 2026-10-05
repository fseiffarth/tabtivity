/**
 * Reads the usage panel an agent CLI prints, so a reader can show it as bars
 * rather than as a paragraph — and can say *when* a full window rolls over.
 *
 * Shared because both surfaces need the same reading: the phone's status sheet
 * draws the bars (`mobile-web/src/screens/StatusSheet.tsx`), and the desktop's
 * per-tab auto-continue arms itself off the reset time
 * (`components/layout/AgentContinueHost.tsx`). One parser, so a panel that
 * reads one way on the phone cannot read another way on the laptop.
 *
 * The text comes from the desktop exactly as the CLI printed it
 * (`services::agent_usage`), and this is the *only* place that pretends to know
 * its shape. That shape belongs to somebody else's CLI and can change in any
 * release, so every rule here is a positive match on a line that already looks
 * like a readout: a line nothing claims is passed through as a note, and a panel
 * nothing claimed at all is reported as `unparsed` — at which point the sheet
 * shows the raw block, which is still the whole answer. Nothing is ever
 * invented, and no figure is dropped without appearing somewhere.
 *
 * The shapes matched are Claude Code's, read off real `/usage` runs:
 *
 *     Current session: 71% used · resets 6:20pm
 *     Current week (all models): 38% used · resets Mon 9am
 *     Current week (Fable): 12% used
 *     Last 24h: 41 requests · 6 sessions
 *
 * and, from 2.1.272 at the latest (2026-09-15), the dated form carrying the
 * CLI's own timezone — with a year only when it is not the current one:
 *
 *     Current session: 39% used · resets Sep 15, 10:30pm (Europe/Berlin)
 *     Current week (all models): 54% used · resets Sep 17, 2pm (Europe/Berlin)
 */

/** One window with a percentage — drawn as a labelled bar. */
export interface UsageMeter {
  label: string;
  /** 0–100, clamped. */
  percent: number;
  /** When the window rolls over, in the CLI's own words ("6:20pm", "Mon 9am"). */
  resets?: string;
}

/** A readout with no percentage in it ("Last 24h" → "41 requests · 6 sessions"),
 * or any line the parser could not claim. Rendered as a plain row. */
export interface UsageNote {
  label?: string;
  value: string;
}

export interface UsageReport {
  meters: UsageMeter[];
  notes: UsageNote[];
  /** True when no line looked like a readout at all — the formatted view then
   * says so and points at the raw text rather than showing an empty panel. */
  unparsed: boolean;
}

/** `71% used`, `45.2 % used`, or a bare `71%` when the line already said what it
 * is about. The `used` suffix is optional because Gemini omits the word and
 * Claude may reword it; the percentage itself is the thing being matched. The
 * sign is captured so a negative figure is clamped to an empty bar rather than
 * silently becoming a positive one.
 *
 * Anchored to the start of the value: a limit window *is* its figure
 * (`Current session: 11% used · resets …`), while Claude 2.1.284's "What's
 * contributing" breakdown names things first and puts a share after them
 * (`Top subagents: general-purpose 39%, Explore 1%`) — a share of usage, not a
 * window that fills up, so it stays a note. */
const PERCENT = /^(-?\d{1,3}(?:\.\d+)?)\s?%/u;

/** `resets 6:20pm`, `resets Mon 9am`, `Resets: tomorrow 09:00`,
 * `resets Sep 15, 10:30pm (Europe/Berlin)`. Stops at a separator so a trailing
 * segment does not end up inside the time — except a comma followed by a
 * figure, which belongs to the date (`Sep 15, 10:30pm`, `Jan 3, 2027, 9am`). */
const RESETS = /\bresets\b:?\s*((?:[^·•|,;]|,(?=\s*\d))+)/iu;

/** `Label: value`, where the label is short enough to be one — not a sentence
 * that happens to contain a colon. */
const LABELLED = /^([^:]{1,48}):\s*(.+)$/u;

/** Separators the CLIs put between facts on one line. */
const SEGMENTS = /\s+[·•|]\s+/u;

/** The characters a box-drawn panel's frame is made of. Stripped from the ends
 * of a line, and a line that is *only* frame is skipped — a corner piece is not
 * a readout, and passing one through as a note is how a tidy panel ends up with
 * two empty rows around it. */
const FRAME_EDGE = /^[\s│|╎┃┆┊┌┐└┘├┤╭╮╰╯╠╣║]+|[\s│|╎┃┆┊┌┐└┘├┤╭╮╰╯╠╣║]+$/gu;
const FRAME_ONLY = /^[─━═╌┄┈╍\-=_·.\s]*$/u;

function clampPercent(text: string): number {
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Strip a trailing `used`/`used.` from the value half so a bar's own label does
 * not repeat the word the bar already means. */
function tidyLabel(label: string): string {
  return label.replace(/\s+/gu, " ").trim();
}

/**
 * Parse one usage panel. Never throws and never returns a figure the text did
 * not contain: an unrecognized panel comes back with `unparsed` set and its
 * lines kept as notes, so the reader loses nothing the CLI said.
 */
export function parseUsageReport(raw: string): UsageReport {
  const meters: UsageMeter[] = [];
  const notes: UsageNote[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    // Panels are often drawn inside a box; the frame is not content.
    const text = line.replace(FRAME_EDGE, "").trim();
    if (!text || FRAME_ONLY.test(text)) continue;
    const labelled = LABELLED.exec(text);
    const label = labelled ? tidyLabel(labelled[1]) : undefined;
    const body = labelled ? labelled[2].trim() : text;
    const percent = PERCENT.exec(body);
    if (percent && label) {
      const resets = RESETS.exec(body);
      meters.push({
        label,
        percent: clampPercent(percent[1]),
        resets: resets ? tidyLabel(resets[1]) : undefined,
      });
      continue;
    }
    // A percentage with nothing naming it is still a fact, but it is not a bar:
    // an unlabelled meter would be a bar the reader cannot attribute.
    notes.push({ label, value: body });
  }
  return { meters, notes, unparsed: meters.length === 0 };
}

/** The segments of a note's value, for rendering "41 requests · 6 sessions" as
 * separate chips instead of one run-on string. */
export function noteParts(value: string): string[] {
  return value.split(SEGMENTS).map((part) => part.trim()).filter(Boolean);
}

/* ── When a window rolls over ──────────────────────────────────────────────── */

/**
 * The CLI writes a reset as a wall-clock phrase, not an instant: `6:20pm` or
 * `Sep 15, 10:30pm (Europe/Berlin)` for the session window, `Mon 9am` or
 * `Sep 17, 2pm (Europe/Berlin)` for the weekly one. Turning that into a real
 * time is the only place in this file that adds information the text does not
 * literally contain, so it is deliberately narrow — it recognizes the shapes
 * Claude Code prints and answers `null` for anything else. A caller that needs
 * an instant (auto-continue) then says it cannot read the panel, which is the
 * truth, rather than arming itself off a guess.
 */
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** `6:20pm`, `9am`, `9 AM`, `18:20`, `09:00`. Either a `:mm` or a meridiem is
 *  REQUIRED — a bare number in a date phrase (`Feb 3`) is a day, not an hour,
 *  and reading it as one is how a rollover ends up eight hours out. Without a
 *  meridiem the figure is 24-hour, which is what `18:20` and `09:00` mean. */
const CLOCK = /(?:^|[\s,])(\d{1,2})(?::(\d{2})\s*(am|pm)?|\s*(am|pm))(?=$|[\s,.])/iu;

/** A month name anywhere in the phrase. Only a whole `MONTH_DAY` is read; a
 *  month without its day is refused outright, since placing it on the next
 *  time that comes round would be a wrong instant stated confidently. */
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/iu;

/** `Sep 15`, `Sept 15`, `Jan 3, 2027`: a calendar date, with the year only
 *  where the CLI printed one — Claude Code prints it only when it is not the
 *  current year, so an absent year is this one. */
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?(?=$|[\s,])/iu;

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** The zone Claude Code appends — its own resolved IANA name, `(Europe/Berlin)`,
 *  or `(UTC)`. Anything else in parentheses is not a zone and is left alone. */
const ZONE = /\(\s*([A-Za-z_]+(?:\/[\w+-]+)+|UTC|GMT)\s*\)\s*$/u;

const DAY_WORD = /\b(today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/iu;

/** The wall-clock fields `at` shows in `zone`. */
function wallIn(at: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: field("year"),
    month: field("month") - 1,
    day: field("day"),
    // Some engines write midnight as 24 under `hour12: false`.
    hour: field("hour") % 24,
    minute: field("minute"),
    second: field("second"),
  };
}

/** The instant a wall-clock time names — on `zone`'s clock, or the local one
 *  when there is none. An out-of-range day rolls over (`day + 7`), as
 *  `new Date(y, m, d)` does. The zone's offset is settled in two passes, so a
 *  time on the far side of a DST change takes the offset in force then. */
function wallClockInstant(year: number, month: number, day: number, hour: number, minute: number, zone?: string): Date {
  if (!zone) return new Date(year, month, day, hour, minute, 0, 0);
  const wanted = Date.UTC(year, month, day, hour, minute);
  let guess = wanted;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = wallIn(new Date(guess), zone);
    guess += wanted - Date.UTC(shown.year, shown.month, shown.day, shown.hour, shown.minute, shown.second);
  }
  return new Date(guess);
}

/** Today's date and weekday on `zone`'s clock (the local one when none). */
function todayIn(now: Date, zone?: string) {
  if (!zone) return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate(), weekday: now.getDay() };
  const shown = wallIn(now, zone);
  return { ...shown, weekday: new Date(Date.UTC(shown.year, shown.month, shown.day)).getUTCDay() };
}

/** The zone a phrase is placed on: `undefined` for the reader's own (the usual
 *  case — the CLI runs on this machine), the name for another, and `null` for a
 *  name this engine does not know, which is refused rather than read locally. */
function resolveZone(name: string): string | undefined | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name === new Intl.DateTimeFormat().resolvedOptions().timeZone ? undefined : name;
  } catch {
    return null;
  }
}

/**
 * The instant a `resets …` phrase names, read against `now`. A phrase ending in
 * a zone (`(Europe/Berlin)`) is placed on that zone's clock; one without is read
 * in the reader's own timezone — the CLI printed it in local wall-clock, and
 * this is the same clock.
 *
 * Rules, in the order they apply:
 *  - a calendar date (`Sep 15, 10:30pm`) is that date at that time, in the
 *    current year unless one is printed; a date already past comes back in the
 *    past, which the caller reads as a stale panel;
 *  - a weekday (`Mon 9am`) is the NEXT such weekday at that time; today counts
 *    only while the time is still ahead;
 *  - `tomorrow` / `today` mean what they say (a `today` time already past comes
 *    back in the past, which the caller reads as a stale panel — inventing
 *    tomorrow there would arm a continue a day late);
 *  - a bare time (`6:20pm`) is the next occurrence of that time, rolling to
 *    tomorrow once it has passed today. A session window is hours long, so its
 *    next occurrence is always the one meant.
 */
export function resolveResetAt(text: string, now: Date): Date | null {
  let phrase = text;
  let zone: string | undefined;
  const named = ZONE.exec(phrase);
  if (named) {
    const resolved = resolveZone(named[1]);
    if (resolved === null) return null;
    zone = resolved;
    phrase = phrase.slice(0, named.index);
  }

  // The date is cut out before the clock is looked for, so its day and year
  // can never be read as an hour.
  const date = MONTH_DAY.exec(phrase);
  if (date) phrase = `${phrase.slice(0, date.index)} ${phrase.slice(date.index + date[0].length)}`;
  else if (MONTH.test(phrase)) return null;

  const clock = CLOCK.exec(phrase);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] === undefined ? 0 : Number(clock[2]);
  const meridiem = (clock[3] ?? clock[4])?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  const today = todayIn(now, zone);
  if (date) {
    const month = MONTH_INDEX[date[1].toLowerCase()];
    const dayOfMonth = Number(date[2]);
    const year = date[3] === undefined ? today.year : Number(date[3]);
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (dayOfMonth < 1 || dayOfMonth > daysInMonth) return null;
    return wallClockInstant(year, month, dayOfMonth, hour, minute, zone);
  }

  const at = (dayOffset: number) =>
    wallClockInstant(today.year, today.month, today.day + dayOffset, hour, minute, zone);
  const day = DAY_WORD.exec(phrase)?.[1]?.toLowerCase();
  if (day === "today") return at(0);
  if (day === "tomorrow") return at(1);
  if (day !== undefined) {
    const weekday = WEEKDAYS[day];
    if (weekday === undefined) return null;
    const offset = (weekday - today.weekday + 7) % 7;
    const candidate = at(offset);
    return candidate.getTime() > now.getTime() ? candidate : at(offset + 7);
  }

  const later = at(0);
  return later.getTime() > now.getTime() ? later : at(1);
}

/** One window's rollover: the meter it came from, the CLI's own words, and the
 *  instant those words resolve to. */
export interface UsageReset {
  label: string;
  resets: string;
  at: Date;
}

/**
 * The soonest rollover the panel names, or `null` when it names none this
 * reader can place in time.
 *
 * "Soonest" and not "the exhausted one": a caller waiting on quota wants the
 * next moment anything frees up, and a window that is not the binding one
 * simply comes round again on the following pass. Resets already in the past
 * are dropped — they belong to a panel read before the rollover, and treating
 * one as due would fire immediately and then again at the real reset.
 */
export function nextUsageReset(report: UsageReport, now: Date): UsageReset | null {
  let best: UsageReset | null = null;
  for (const meter of report.meters) {
    if (!meter.resets) continue;
    const at = resolveResetAt(meter.resets, now);
    if (!at || at.getTime() <= now.getTime()) continue;
    if (!best || at.getTime() < best.at.getTime()) {
      best = { label: meter.label, resets: meter.resets, at };
    }
  }
  return best;
}

/* ── The two windows a glance shows ────────────────────────────────────────── */

/** The rolling session window (Claude's 5-hour one) and the account's weekly
 *  window, when the panel names them. */
export interface LimitMeters {
  session?: UsageMeter;
  week?: UsageMeter;
}

/**
 * Pick the session and weekly meters out of a parsed panel, for a one-line
 * readout next to the context figure. The weekly pick prefers the all-models
 * line over a per-model one (`Current week (Fable)`), which is a sub-limit and
 * not the one that stops the account. A panel that names neither returns an
 * empty object — the caller then shows nothing rather than a guess.
 */
export function limitMeters(report: UsageReport): LimitMeters {
  const session = report.meters.find((meter) => /\bsession\b|\b5\s?-?\s?h(?:ours?)?\b/iu.test(meter.label));
  const weekly = report.meters.filter((meter) => /\bweek(?:ly)?\b/iu.test(meter.label));
  const week = weekly.find((meter) => /\ball\b/iu.test(meter.label)) ?? weekly[0];
  return { session, week };
}
