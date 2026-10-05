/**
 * Which reminders are due, and which have already been shown.
 *
 * Pure logic, kept out of the store so it can be tested without a clock or a
 * notification backend. `stores/calendar/alarms.ts` drives it on a ticker.
 *
 * The invariant that matters: **an alarm fires exactly once.** Every fired alarm
 * is recorded under a stable key — the event, the specific occurrence, and the
 * offset — and that record is persisted, so a reminder does not fire again on the
 * next tick, nor on the next launch. Occurrences are keyed by their
 * *rule-generated* start, so moving one does not resurrect its alarm.
 */

import type { Alarm, Calendar, Occurrence } from "../../types";
import { addDays, addMinutes, minutesBetween, toStamp } from "./calendarTime";
import type { TranslationKey } from "../i18n";

/** A reminder that has come due and wants showing. */
export interface DueAlarm {
  /** Stable identity — the dedup key and the React key. */
  key: string;
  eventId: string;
  /** The calendar it belongs to — what a per-calendar mute is matched against. */
  calendarId: string;
  occurrenceStart: string;
  minutesBefore: number;
  title: string;
  location: string;
  /** The occurrence's real start, for the "in 15 minutes" line. */
  start: string;
  allDay: boolean;
}

/** The key an alarm is remembered by, once fired. */
export function alarmKey(
  eventId: string,
  occurrenceStart: string,
  minutesBefore: number,
): string {
  return `${eventId}@${occurrenceStart}@${minutesBefore}`;
}

/**
 * When an alarm should go off: the occurrence's start, less its offset.
 *
 * An all-day event has no meaningful time-of-day, so its reminders are measured
 * from 09:00 on the day it starts rather than from midnight — a "1 day before"
 * reminder on a birthday should arrive at a civilized hour the day before, not at
 * 00:00.
 */
export function alarmTime(occurrence: Occurrence, minutesBefore: number): string {
  const anchor = occurrence.allDay
    ? `${occurrence.start.split("T")[0]}T09:00`
    : occurrence.start;
  return addMinutes(anchor, -minutesBefore);
}

/**
 * The alarms that are due at `now` and have not been shown yet.
 *
 * "Due" means its time has arrived — including one that arrived while Tabtivity was
 * closed, which is why this looks backwards as well as at this instant. It does
 * not look back forever, though: `graceMinutes` bounds how stale a reminder may
 * be and still be worth showing (a week-old reminder is noise, not information).
 */
export function dueAlarms(
  occurrences: Occurrence[],
  fired: Set<string>,
  now: Date = new Date(),
  graceMinutes = 24 * 60,
): DueAlarm[] {
  const nowStamp = toStamp(now);
  const out: DueAlarm[] = [];

  for (const occ of occurrences) {
    for (const alarm of occ.alarms ?? []) {
      const key = alarmKey(occ.eventId, occ.occurrenceStart, alarm.minutes_before);
      if (fired.has(key)) continue;

      const at = alarmTime(occ, alarm.minutes_before);
      const lateBy = minutesBetween(at, nowStamp);
      // Not yet due.
      if (lateBy < 0) continue;
      // Due, but so long ago that showing it now would just be noise.
      if (lateBy > graceMinutes) continue;

      out.push({
        key,
        eventId: occ.eventId,
        calendarId: occ.calendarId,
        occurrenceStart: occ.occurrenceStart,
        minutesBefore: alarm.minutes_before,
        title: occ.title,
        location: occ.location,
        start: occ.start,
        allDay: occ.allDay,
      });
    }
  }

  // Soonest-starting first, so the most imminent reminder is at the top of the stack.
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * The calendars whose reminders are switched off (`Calendar.alerts_off`).
 *
 * A mute, not a filter on visibility: a hidden calendar still reminds, and a
 * muted one still shows its events — the two switches answer different
 * questions ("do I want to see this" / "do I want to be interrupted by it").
 */
export function mutedCalendarIds(calendars: Calendar[]): Set<string> {
  return new Set(calendars.filter((c) => c.alerts_off).map((c) => c.id));
}

/**
 * The window an alarm scan needs to expand occurrences over.
 *
 * It must reach far enough back to catch a reminder that came due while the app
 * was closed, and far enough forward to catch the longest lead time any event
 * asks for — a "1 day before" reminder on an event next week is not due yet, but
 * a scan that only looked at today would never see the event at all.
 */
export function alarmWindow(
  events: { alarms?: Alarm[] }[],
  now: Date = new Date(),
): { start: string; end: string } {
  const maxLead = events.reduce((max, e) => {
    for (const a of e.alarms ?? []) max = Math.max(max, a.minutes_before);
    return max;
  }, 0);
  // Round the lead up to whole days, plus a day of slack on each side.
  const leadDays = Math.ceil(maxLead / (24 * 60)) + 1;
  const today = toStamp(now).split("T")[0];
  return { start: addDays(today, -1), end: addDays(today, leadDays + 1) };
}

/** A snooze: the alarm comes back this many minutes from now. */
export interface Snoozed {
  key: string;
  /** When it should reappear. */
  at: string;
  alarm: DueAlarm;
}

/** Snooze `alarm` for `minutes` from `now`. */
export function snooze(alarm: DueAlarm, minutes: number, now: Date = new Date()): Snoozed {
  return { key: alarm.key, at: addMinutes(toStamp(now), minutes), alarm };
}

/** The snoozed alarms whose time has come back around. */
export function wokenSnoozes(snoozes: Snoozed[], now: Date = new Date()): Snoozed[] {
  const nowStamp = toStamp(now);
  return snoozes.filter((s) => s.at <= nowStamp);
}

/** A human lead-in for the notification body: "in 15 minutes", "now", "2 hours ago". */
export function describeLead(
  minutesBefore: number,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (minutesBefore === 0) return t("alarms.now");
  const before = minutesBefore > 0;
  const abs = Math.abs(minutesBefore);
  const unit =
    abs >= 1440
      ? t(Math.round(abs / 1440) === 1 ? "alarms.dayOne" : "alarms.dayMany", { n: Math.round(abs / 1440) })
      : abs >= 60
        ? t(Math.round(abs / 60) === 1 ? "alarms.hourOne" : "alarms.hourMany", { n: Math.round(abs / 60) })
        : t(abs === 1 ? "alarms.minuteOne" : "alarms.minuteMany", { n: abs });
  return before ? t("alarms.inUnit", { unit }) : t("alarms.unitAgo", { unit });
}
