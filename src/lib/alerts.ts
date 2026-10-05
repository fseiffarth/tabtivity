import type { CalendarEvent, CalendarTask } from "../types";
import type { MailHeader } from "../types/mail";
import { conferenceLink } from "./calendar/conference";
import {
  MINUTES_PER_DAY,
  addDays,
  datePart,
  daysBetween,
  minutesBetween,
  parseStamp,
  toStamp,
} from "./calendar/calendarTime";
import { formatAddress } from "./mail";
import { stripFormatControls } from "./textSafety";
import { selectUrgentMail } from "./todoBoard";

/**
 * **The alert feed behind the side panel's opt-in "Alerts" group.**
 *
 * One merged, time-ordered list of the three things that can need the user
 * *now*: mail they themselves marked Urgent, calendar entries about to start,
 * and to-do cards whose due date is here or past. The group sits in the file
 * viewer — the surface that is open all day — so the deadline reaches the user
 * without a second window.
 *
 * **A read, never a write.** Every selector here is pure: it takes the store
 * snapshots plus an explicit `now` and returns rows. Nothing in this module
 * loads, mutates or persists — the caller (`useAlertsFeed`) owns the reads, and
 * the sources stay the single stores that already own them (`calendar.json`'s
 * events/tasks, the mail priority index). There is deliberately no fourth store
 * and no cached copy of an alert: a stale duplicate of a deadline is worse than
 * no alert at all.
 *
 * `now` is a parameter rather than a `Date.now()` call for the same reason the
 * board's selectors take `today`: the interesting cases are all boundary cases
 * (an event starting in four minutes, a task due at midnight), and they are only
 * testable if the clock is an input.
 */

/** Which source a row came from. Drives the icon and the open action. */
export type AlertKind = "mail" | "event" | "task";

/**
 * How loud the row is. Drives the dot colour (the CSS class is the same
 * string) and the `mailSeverity` floor; the row *order* is due time, not this
 * — see `compareAlerts`. `SEVERITY_ORDER` still ranks the values worst-first
 * for that floor comparison.
 *
 * - `overdue` — the due date/start is in the past and the thing is not done.
 * - `now` — happening inside the imminent window (`IMMINENT_MINUTES`).
 * - `soon` — inside the next 24h.
 * - `upcoming` — inside the lookahead window but further out.
 */
export type AlertSeverity = "overdue" | "now" | "soon" | "upcoming";

export const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  overdue: 0,
  now: 1,
  soon: 2,
  upcoming: 3,
};

/** Minutes ahead that still count as `now` rather than `soon`. */
export const IMMINENT_MINUTES = 60;

/** Default lookahead for events/tasks, in days. */
export const DEFAULT_LOOKAHEAD_DAYS = 7;

/**
 * The **hard** cut for a to-do card, in days — strictly less than this many days
 * off, whatever `lookaheadDays` says.
 *
 * A card and a meeting are not the same kind of future. A meeting next month is
 * a fact about the calendar and shows up in a long lookahead legitimately; a
 * card due next month is a *plan*, and a strip of them is what turns the alerts
 * group from "what needs doing" into a second board — the failure the whole
 * feature is built to avoid. So the setting can only ever make this window
 * *smaller*: the shorter of the two wins.
 */
export const TASK_LOOKAHEAD_DAYS = 7;

/** Default cap on rendered rows (the group is an alert strip, not a list view). */
export const DEFAULT_ALERT_LIMIT = 12;

/**
 * What the row's open action needs. Exactly one of the three id sets is
 * populated, matching `kind` — the consumer switches on `kind`, never on which
 * field happens to be present.
 */
export interface AlertSource {
  /** `kind === "mail"`: the store key (`{folder_id}-{uid}`) and its account. */
  mailId?: string;
  mailAccountId?: string;
  mailPriority?: "urgent" | "important";
  /** `kind === "event"`: `CalendarEvent.id`. */
  eventId?: string;
  /**
   * `kind === "event"`: the event's video-call link and the service behind it,
   * when it has one. Computed once here through `lib/calendar/conference`'s
   * `conferenceLink` — the same verdict the header's 🗓 dropdown and the event
   * dialog reach — so the row's Join button cannot disagree with theirs about
   * the same meeting. Absent when the event has no joinable link.
   */
  conferenceUrl?: string;
  conferenceProvider?: string;
  /** `kind === "task"`: `CalendarTask.id`. */
  taskId?: string;
  /** Calendar owning the event/task, for the colour chip. */
  calendarId?: string;
  /** `ProjectEntry.id` a task is filed under, when it carries one. */
  projectId?: string;
}

/** One row in the alert group. */
export interface AlertItem {
  /** Stable across refreshes: `"{kind}:{sourceId}"`. The React key. */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** Subject / event title / card title. Never empty — falls back to a dash. */
  title: string;
  /** Secondary line: sender for mail, location/time for an event, project for a task. */
  detail: string;
  /**
   * The stamp the row sorts on (what it counts down to is `minutesAway`'s
   * business, which for a date-only row is the *end* of this day), as a local
   * wall-clock string
   * (`"YYYY-MM-DDTHH:MM"`, or `"YYYY-MM-DD"` when `allDay`). Null only for an
   * urgent mail with no usable date, which sorts to the end of its severity.
   */
  at: string | null;
  /** `at` carries no time component (an all-day event, a date-only task due). */
  allDay: boolean;
  /**
   * Whole minutes from `now` to the row's **moment**; negative when past. Null
   * when `at` is null.
   *
   * For a timed row the moment is `at` itself. For a date-only one it is the
   * **end** of that day — see `dayEnd`: a card due Friday is due by the end of
   * Friday, not at midnight as Friday begins, and anchoring on the start is what
   * made a Wednesday-afternoon reading of a Friday deadline say "in 1 d".
   */
  minutesAway: number | null;
  /**
   * Whole **calendar** days from today to `at`'s date; negative when past, `0`
   * for today. Null when `at` is null.
   *
   * The day-granular readout is this and never `minutesAway / 1440`: dividing
   * mixes the hour into a figure that is supposed to name a *day*, so the same
   * Friday deadline read at 02:00 and at 22:00 would come out as two different
   * numbers of days.
   */
  daysAway: number | null;
  source: AlertSource;
}

/** Everything `selectAlerts` reads, so the caller does the loading. */
export interface AlertInput {
  /** Local wall-clock "now" (`"YYYY-MM-DDTHH:MM"` or a full ISO stamp). */
  now: string;
  /** Urgent-marked mail, as `useTodoStore` already holds it. Only the marks the
   *  user made by hand become rows — see `selectAlerts`' mail block. */
  urgentMail?: MailHeader[];
  /** `useCalendarStore`'s events — recurring series are expanded by the caller. */
  events?: CalendarEvent[];
  /** `useCalendarStore`'s tasks (the board's cards). */
  tasks?: CalendarTask[];
  /** How far ahead events/tasks may be to still show. Default `DEFAULT_LOOKAHEAD_DAYS`. */
  lookaheadDays?: number;
  /** Max rows returned. Default `DEFAULT_ALERT_LIMIT`. */
  limit?: number;
  /** Per-source opt-outs; all default on. */
  include?: { mail?: boolean; events?: boolean; tasks?: boolean };
  /**
   * `AlertItem.id`s the user has muted. Dropped **before** the cap, which is the
   * whole point of doing it here rather than in the component: a muted row that
   * still consumed one of `limit` slots would let three silenced meetings hide
   * an overdue card, i.e. muting one thing would quietly mute another.
   */
  muted?: readonly string[];
}

/**
 * Everything that decides whether a source may contribute at all, resolved in
 * one place because two surfaces now ask the question and they disagree about
 * exactly one input.
 */
export interface AlertGateInput {
  /** `files_alerts` — the file viewer's Alerts group *is* this key (the header's
   *  🔔 writes it), so it is the group's visibility rather than a preference
   *  above one. */
  visible: boolean;
  /**
   * Ignore `visible`. Because that key is the desktop group's visibility, a
   * surface the file viewer does not own — Tabtivity Mobile's own Alerts screen —
   * must not go dark because the strip beside the tree was closed on the
   * laptop. The source switches, the lookahead and the mutes still apply: those
   * say *which alerts exist*, which is a different question from which window
   * is currently showing them.
   */
  ignoreVisible?: boolean;
  /** `files_alerts_sources`. */
  mail: boolean;
  events: boolean;
  tasks: boolean;
  /** Mail's second gate, the `mail_client` experiment. */
  mailClient: boolean;
}

/** Which sources survived their gates, and whether anything is left. */
export interface AlertGates {
  wantMail: boolean;
  wantEvents: boolean;
  wantTasks: boolean;
  /** At least one source survived. All-off is reported as disabled rather than
   *  as an empty list: an empty strip reads as "nothing is due", which is a
   *  different and possibly wrong statement. */
  enabled: boolean;
}

export function alertGates(input: AlertGateInput): AlertGates {
  const on = input.visible || input.ignoreVisible === true;
  const wantMail = on && input.mail && input.mailClient;
  const wantEvents = on && input.events;
  const wantTasks = on && input.tasks;
  return { wantMail, wantEvents, wantTasks, enabled: wantMail || wantEvents || wantTasks };
}

/**
 * Classify a stamp against `now`: past → `overdue`, within `IMMINENT_MINUTES`
 * → `now`, within 24h → `soon`, else `upcoming`.
 *
 * `minutesAway` for a date-only row counts to the **end** of its day (`dayEnd`),
 * so the all-day thresholds are the timed ones shifted by exactly one day: it is
 * `overdue` only once the day itself is over — a task due today is not late at
 * 09:00 — `now` for the whole of its own day, and `soon` for the whole of the
 * day before.
 */
export function severityFor(
  minutesAway: number | null,
  allDay: boolean,
): AlertSeverity {
  if (minutesAway === null) return "now";
  if (allDay) {
    if (minutesAway < 0) return "overdue";
    if (minutesAway <= MINUTES_PER_DAY) return "now";
    return minutesAway <= 2 * MINUTES_PER_DAY ? "soon" : "upcoming";
  }
  if (minutesAway < 0) return "overdue";
  if (minutesAway <= IMMINENT_MINUTES) return "now";
  return minutesAway <= MINUTES_PER_DAY ? "soon" : "upcoming";
}

/**
 * The instant a date-only stamp runs out: midnight at the *start of the next
 * day*, i.e. the exclusive end of the day it names.
 *
 * This is the whole of the date-only bargain. "Due Friday" is a deadline that
 * expires when Friday does, so measuring it from Friday 00:00 under-reports the
 * time left by up to a full day — from Wednesday afternoon a Friday deadline
 * came out as 34 h and rounded to "in 1 d". The same instant is what the
 * calendar already treats as an all-day span's exclusive end
 * (`allDayEndToLastDay`), so nothing here invents a second convention.
 */
function dayEnd(date: string): string {
  return `${addDays(datePart(date), 1)}T00:00`;
}

/** What a row shows when the thing it came from has no title at all. */
const NO_TITLE = "—";

/**
 * `now` may arrive as a bare wall-clock stamp or as a full ISO one (the caller
 * usually has a `Date`), so it is cut back to the minute the rest of this module
 * works in. Seconds are *truncated*, not rounded: `minutesAway` counts whole
 * minutes from the top of the current minute, which is also what makes a fixture
 * clock and a real one behave identically.
 *
 * Null for a stamp that does not parse — see `selectAlerts`, which refuses to
 * guess rather than classifying everything against a broken clock.
 */
function normalizeNow(now: string): string | null {
  const c = parseStamp(now);
  if (!c) return null;
  return `${datePart(now)}T${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/**
 * A mail header's RFC 3339 `date` → the local wall-clock stamp everything else
 * here sorts on.
 *
 * This is the one place a `Date` is the *right* tool: an RFC 3339 stamp names a
 * real instant with an offset attached, so converting it to the user's local
 * civil time is exactly what `new Date(...)` + `toStamp` do. The calendar's own
 * stamps are already local wall clock and must never go through `Date.parse` —
 * see `lib/calendar/calendarTime`.
 */
function mailStamp(date: string): string | null {
  if (!date) return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : toStamp(d);
}

/** Titles are somebody else's text — a subject, an invitation's SUMMARY. */
function displayText(text: string | undefined | null): string {
  return stripFormatControls(text ?? "").trim();
}

/**
 * The instant a row actually sorts on — **not always `at`**.
 *
 * For a timed row and an all-day *event* this is `at` itself: an all-day event
 * has no deadline inside it (it is "a fact about the calendar", `readsInHours`'s
 * words), so it is ranked at the *start* of its day, ahead of that day's timed
 * rows — the bare date string sorts before every timed stamp on the same day.
 *
 * For an all-day **task** this is `dayEnd(at)`, the same midnight `minutesAway`
 * already counts to. A card due "today" with no hour is not due at the day's
 * *start* — it is due at its *end* — and the strip already reads it that way
 * (`readsInHours` keeps a task's hour countdown even when it has none of its
 * own). Sorting it by the bare date instead put a card reading "due in 15h"
 * ahead of a meeting reading "in 2h", which is backwards: ranking it by `at`
 * alone was measuring a different instant than the one the row displays.
 */
function sortMoment(item: AlertItem): string | null {
  if (item.at === null) return null;
  return item.kind === "task" && item.allDay ? dayEnd(item.at) : item.at;
}

/**
 * Order two rows: `sortMoment` ascending with nulls last, then kind, then id.
 * Total and deterministic — the same snapshot always renders in the same
 * order, which is what stops a one-minute refresh from reshuffling rows the
 * user is reading.
 *
 * Due time is the sort key, not severity — the strip reads top-to-bottom as a
 * timeline (what is due soonest is first), and severity stays what it always
 * was otherwise: the dot colour, nothing more. The two agree in the
 * overwhelming case anyway (a past moment is a smaller string than a future
 * one, so an overdue row already sorts ahead of everything upcoming without
 * severity's help); where they can part is the mail severity floor
 * (`mailSeverity`), which raises a skew-dated urgent message's *dot* to `now`
 * without moving its `at` — that row now sorts on the date on the message,
 * same as everything else.
 *
 * The kind and id tie-breaks are alphabetic and arbitrary; they exist only so
 * two rows on the same minute cannot swap between renders.
 */
function compareAlerts(a: AlertItem, b: AlertItem): number {
  const am = sortMoment(a);
  const bm = sortMoment(b);
  if (am !== bm) {
    if (am === null) return 1;
    if (bm === null) return -1;
    return am < bm ? -1 : 1;
  }
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge the three sources into one due-time-ordered list, capped at `limit`.
 *
 * Ordering is `at` ascending, then kind, then id — total and deterministic, so
 * a refresh that changes nothing renders the same rows in the same order. See
 * `compareAlerts` for why due time rather than severity is the key.
 *
 * Filtered out: done cards (`percent >= 100`), cancelled events, anything past
 * the lookahead window, and mail already converted into a card (a deadline the
 * user has already acted on is not an alert).
 *
 * **Two window rules, and only one of them is symmetric.** `lookaheadDays` cuts
 * the future off at a whole day boundary (a `lookaheadDays`-th-day event is in
 * whatever the hour), because "next week" is a count of days and a rolling
 * 7×24h cut would show the 15th at 08:00 and hide it at 10:00. A **card** is cut
 * again at `TASK_LOOKAHEAD_DAYS`, the shorter of the two winning — see that
 * constant for why a card's future is not a meeting's. There is
 * deliberately **no backward limit**: an overdue thing does not stop being
 * overdue after a fortnight, and dropping it would make the group quietly go
 * green while the deadline is still missed. What bounds the past is the source
 * — a done card and a cancelled event both leave on their own.
 *
 * **Recurring series are the caller's problem.** `events` is taken as a flat
 * list of *occurrences*: `useAlertsFeed` expands the store's `rrule` rows before
 * calling (the calendar already owns that expansion, and doing it twice is how
 * two surfaces start disagreeing about which Tuesday it is). A plain
 * non-recurring row passes straight through, which is what the fixtures use.
 */
function buildAlerts(input: AlertInput): AlertItem[] {
  const now = normalizeNow(input.now);
  // No usable clock, no alerts. Every severity here is a statement about how
  // near a deadline is, so classifying against a broken `now` would not degrade
  // gracefully — it would paint next month's meeting red.
  if (!now) return [];

  const lookaheadDays = input.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;
  const limit = input.limit ?? DEFAULT_ALERT_LIMIT;
  const include = input.include ?? {};
  const tasks = input.tasks ?? [];

  const rows: AlertItem[] = [];

  /**
   * How far off a row is, three ways: minutes to its moment (the end of the day
   * for a date-only one — see `dayEnd`), whole calendar days to its date, and
   * whether it is inside the lookahead.
   *
   * The window test is the *day* count in both cases, which is the asymmetry the
   * module header describes: `lookaheadDays` cuts the future at a day boundary,
   * so a day-7 item is in whatever the hour.
   */
  const timing = (at: string, allDay: boolean) => {
    const daysAway = daysBetween(now, at);
    return {
      minutesAway: minutesBetween(now, allDay ? dayEnd(at) : at),
      daysAway,
      inWindow: daysAway <= lookaheadDays,
    };
  };

  if (include.mail !== false) {
    // The already-converted-to-a-card rule is `selectUrgentMail`'s, reused rather
    // than restated: the rail and this group must agree about which marked mail
    // is still asking for something, or "make todo" would clear one surface and
    // leave the other shouting. The mail feed is pre-capped at `limit` because no
    // more than that many rows can render however the merge falls out.
    // The pre-cap is `limit` *plus* the muted ids: a muted message is dropped
    // downstream, so pre-capping at `limit` alone would let a silenced mail
    // consume the slot a live one was supposed to take.
    //
    // Only an Urgent mark the *user* made reaches this group. A keyword rule or
    // the local classifier may file mail into Urgent, but an alert is an
    // interruption, and the user alone decides what may interrupt them —
    // an automatic mark stays in the mail client and the to-do rail. Important
    // is not an alert at all. A mark with no recorded source (a store that
    // predates the column) cannot prove it was the user's, so it stays out too.
    const userUrgent = (input.urgentMail ?? []).filter(
      (h) => h.priority_source === "user",
    );
    for (const header of selectUrgentMail(
      userUrgent,
      [],
      tasks,
      limit + (input.muted?.length ?? 0),
    )) {
      const priority = "urgent";
      const at = mailStamp(header.date);
      const minutesAway = at === null ? null : minutesBetween(now, at);
      const severity = mailSeverity(minutesAway, priority);
      rows.push({
        id: `mail:${header.id}`,
        kind: "mail",
        severity,
        title: displayText(header.subject) || NO_TITLE,
        // The addr-spec is never dropped in favour of a display name — the mail
        // client's rule (`formatAddress`), and it does not get to lapse because
        // the row is small: `From: "IT Helpdesk" <x@evil.example>` is precisely
        // the message that would be marked urgent.
        detail: formatAddress(header.from),
        at,
        allDay: false,
        minutesAway,
        daysAway: at === null ? null : daysBetween(now, at),
        source: {
          mailId: header.id,
          mailAccountId: header.account_id,
          mailPriority: priority,
        },
      });
      // No lookahead test: a message has an arrival time, not a deadline, so
      // there is no future for the window to cut off.
    }
  }

  if (include.events !== false) {
    for (const event of input.events ?? []) {
      if (event.status === "cancelled") continue;
      const start = parseStamp(event.start);
      if (!start) continue;
      const allDay = event.all_day || start.dateOnly;
      const at = allDay ? datePart(event.start) : event.start;
      const { minutesAway, daysAway, inWindow } = timing(at, allDay);
      if (!inWindow) continue;
      // The video call, if any, is derived the one way every Join button reaches
      // it — the explicit field, else a location/notes link from a recognized
      // meeting host — so the strip's door and the calendar's are the same door.
      const call = conferenceLink({
        conference: event.conference,
        location: event.location,
        notes: event.notes,
      });
      rows.push({
        id: `event:${event.id}`,
        kind: "event",
        severity: severityFor(minutesAway, allDay),
        title: displayText(event.title) || NO_TITLE,
        detail: displayText(event.location) || displayText(event.category),
        at,
        allDay,
        minutesAway,
        daysAway,
        source: {
          eventId: event.id,
          calendarId: event.calendar_id,
          conferenceUrl: call?.url,
          conferenceProvider: call?.provider,
        },
      });
    }
  }

  if (include.tasks !== false) {
    for (const task of tasks) {
      if (task.percent >= 100 || task.completed) continue;
      // `due` is the deadline; `start` is the fallback for a card that was given
      // a begin date and no end. A card with neither is a someday — a real and
      // common thing on a board, and never an alert.
      //
      // A `due` carrying a time (`2026-07-31T17:00`) is an **hour** deadline and
      // is treated as one: `allDay` is false, so it counts down in hours and
      // minutes and goes overdue at 17:00 rather than at midnight. A bare date
      // is the whole day, ending when the day does.
      const stamp = task.due || task.start || "";
      const civil = parseStamp(stamp);
      if (!civil) continue;
      const allDay = civil.dateOnly;
      const at = allDay ? datePart(stamp) : stamp;
      const { minutesAway, daysAway, inWindow } = timing(at, allDay);
      // Both windows, and a card has to pass both: the user's lookahead, and the
      // hard `TASK_LOOKAHEAD_DAYS` cut that keeps a long one from filling the
      // strip with next month's plans. Overdue is untouched — `daysAway` is
      // negative there, which no forward cut can exclude.
      if (!inWindow || daysAway >= TASK_LOOKAHEAD_DAYS) continue;
      rows.push({
        id: `task:${task.id}`,
        kind: "task",
        severity: severityFor(minutesAway, allDay),
        title: displayText(task.title) || NO_TITLE,
        detail: taskDetail(task),
        at,
        allDay,
        minutesAway,
        daysAway,
        source: {
          taskId: task.id,
          calendarId: task.calendar_id,
          projectId: task.project_id,
        },
      });
    }
  }

  rows.sort(compareAlerts);
  return rows;
}

/**
 * The rows the group shows: everything `buildAlerts` found, minus what the user
 * muted, capped at `limit`.
 *
 * A plain truncation, not a per-severity quota. The sort has already put what
 * is due soonest first — which, `at` being a timeline, means overdue rows are
 * already at the front on their own (see `compareAlerts`) — so a quota could
 * only *evict* one of them to guarantee a slot for something merely upcoming,
 * the wrong trade in a strip whose whole job is what needs doing now. The
 * counts in `alertCounts` are taken from the capped list for the same reason: a
 * badge must describe the rows on screen, not a list nobody can see.
 */
export function selectAlerts(input: AlertInput): AlertItem[] {
  const limit = input.limit ?? DEFAULT_ALERT_LIMIT;
  const muted = new Set(input.muted ?? []);
  const rows = buildAlerts(input);
  return (muted.size ? rows.filter((row) => !muted.has(row.id)) : rows).slice(
    0,
    Math.max(0, limit),
  );
}

/**
 * The muted half of the same feed — what "🔕 3" in the header counts, and what
 * the reveal renders so a mute can be taken back.
 *
 * Only rows that are **still live** come back: a muted id whose mail was
 * unmarked, whose meeting has passed or whose card was ticked simply produces no
 * row, so the count reads as "3 things you silenced that still apply" rather
 * than as a tally of every mute ever made. That is also the only liveness signal
 * this module has, and it is why nothing here prunes the stored list — a row is
 * absent both when it is gone for good and when its source is merely switched
 * off for the afternoon, and those must not be treated alike.
 */
export function selectMutedAlerts(input: AlertInput): AlertItem[] {
  const muted = new Set(input.muted ?? []);
  if (muted.size === 0) return [];
  const limit = input.limit ?? DEFAULT_ALERT_LIMIT;
  return buildAlerts(input)
    .filter((row) => muted.has(row.id))
    .slice(0, Math.max(0, limit));
}

/**
 * How many ids the muted list keeps, newest last.
 *
 * It is bounded rather than pruned because there is no honest way to prune it:
 * see `selectMutedAlerts` — an id with no row today may well have one tomorrow.
 * A bound is the safe direction (the oldest mute is the one whose reason has
 * most likely expired) and it keeps `settings.json` from growing without end.
 */
export const MAX_MUTED_ALERTS = 200;

/** Add an id to the muted list: idempotent, newest last, bounded. */
export function addMutedAlert(muted: readonly string[], id: string): string[] {
  const next = muted.filter((existing) => existing !== id);
  next.push(id);
  return next.slice(Math.max(0, next.length - MAX_MUTED_ALERTS));
}

/**
 * A marked message's severity. Its `at` is when it *arrived*, so the ordinary
 * classification already reads correctly — an urgent mail from this morning is
 * overdue in the only sense mail has, namely still unanswered.
 *
 * The floor exists for the other direction: a message dated in the future (a
 * skewed sender clock, a broken `Date` header — both routine) would otherwise be
 * classified `soon` or `upcoming` and sort *below* next Friday's meeting. A mark
 * the user applied by hand outranks the sender's arithmetic.
 */
function mailSeverity(
  minutesAway: number | null,
  priority: "urgent" | "important",
): AlertSeverity {
  const severity = severityFor(minutesAway, false);
  if (priority !== "urgent") return severity;
  return SEVERITY_ORDER[severity] > SEVERITY_ORDER.now ? "now" : severity;
}

/**
 * A card's secondary line: the project it is filed under, else its category,
 * else its tags.
 *
 * Ordered by how well each answers "what is this about" from a strip in the file
 * viewer — the project is the strongest, since that is the thing the user is
 * probably looking at. Built from **the card's own data and no words**, the rule
 * `todoBoard`'s converters follow: no label to translate means the row reads the
 * same in every UI language, and the caller is free to render the project id as
 * the chip it already has.
 */
function taskDetail(task: CalendarTask): string {
  if (task.project_id) return task.project_id;
  const category = displayText(task.category);
  if (category) return category;
  return (task.tags ?? []).map(displayText).filter(Boolean).join(" · ");
}

/**
 * Whether a row's distance is worth reading in **hours** as well as days.
 *
 * Timed rows always are — they name a moment. The interesting case is the
 * date-only **card**: it has no hour of its own, but it does have a deadline,
 * namely the midnight its day runs out at (`dayEnd`, the same instant
 * `minutesAway` already counts to and the same one the severities are cut on).
 * "In 3 d" hides which side of that midnight you are on, and for a card due
 * *today* the whole-day reading collapses to a bare "today" — precisely when
 * the hours left are the only number that matters.
 *
 * An all-day **event** is deliberately excluded: a holiday or a conference day
 * is a fact about the calendar with no deadline inside it, so "in 9 h" would be
 * a precision it does not have. That is also why this is a predicate here
 * rather than a change to `allDay`, which stays a statement about the *stamp*.
 */
export function readsInHours(item: AlertItem): boolean {
  return !item.allDay || item.kind === "task";
}

/** Rows per severity, for the group header's badge. */
export function alertCounts(items: AlertItem[]): Record<AlertSeverity, number> {
  const counts: Record<AlertSeverity, number> = {
    overdue: 0,
    now: 0,
    soon: 0,
    upcoming: 0,
  };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}
