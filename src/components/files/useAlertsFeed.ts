import { useCallback, useEffect, useMemo, useState } from "react";

import type { AlertItem } from "../../lib/alerts";
import {
  DEFAULT_ALERT_LIMIT,
  DEFAULT_LOOKAHEAD_DAYS,
  addMutedAlert,
  alertGates,
  selectAlerts,
  selectMutedAlerts,
} from "../../lib/alerts";
import type { Calendar, CalendarEvent, CalendarTask, Occurrence } from "../../types";
import type { MailHeader } from "../../types/mail";
import { addDays, datePart, toStamp } from "../../lib/calendar/calendarTime";
import { expandEvents } from "../../lib/calendar/recurrence";
import { useExperimental } from "../../lib/experimental";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import {
  releaseUrgentMailPoll,
  retainUrgentMailPoll,
  useTodoStore,
} from "../../stores/todo";

/**
 * **The data feed behind the side panel's opt-in "Alerts" group.**
 *
 * It owns the *reads*; `lib/alerts`' `selectAlerts` owns the merging, and the
 * two stores that already hold this data (`stores/calendar/calendar` for events and
 * tasks, `stores/todo` for the priority-marked mail) stay the only owners of it.
 * There is no fourth store and no cached copy of an alert.
 *
 * **Disabled means nothing happens — no interval, no load, no store read.** That
 * is not an optimization, it is what the opt-in *is*: a feature the user has
 * switched off that still polls once a minute has been switched off in name
 * only. So every effect returns on `!enabled` before it does anything, every
 * store selector collapses to a frozen empty constant (so a calendar write in
 * another window cannot even re-render the panel), and the memo that would call
 * `selectAlerts` short-circuits.
 *
 * The mail source carries a **second** gate, `mail_client`, and it is checked
 * before the invoke rather than around the rendering — opening the mail store
 * creates `~/.local/share/tabtivity/mail/` as a side effect, and a file viewer must
 * not materialize a mail database for someone who has mail switched off. This is
 * `TodoMailRail`'s rule, verbatim — and both now share the one refcounted poll
 * in `stores/todo` behind that same gate.
 */

/**
 * How often the severity clock re-stamps `now`. The clock has to move on its
 * own — nothing in either store changes when 15:00 simply passes, but an event
 * that was `soon` at 14:00 is `now` at 15:00. The mail re-read is NOT this
 * timer's any more: it rides the shared refcounted poll in `stores/todo`
 * (`retainUrgentMailPoll`), one interval however many viewers are mounted.
 */
const TICK_MS = 60_000;

/** Bounds on the user-set lookahead. Below 1 the group can only ever be empty;
 *  above 60 it has stopped being an alert strip and become an agenda. */
const MIN_LOOKAHEAD_DAYS = 1;
const MAX_LOOKAHEAD_DAYS = 60;

/** Frozen empties, so a disabled feed hands `useMemo`/the store selectors a
 *  *stable* reference and nothing downstream re-renders. A fresh `[]` per call
 *  would defeat the whole point. */
const NO_MAIL: MailHeader[] = [];
const NO_CALENDARS: Calendar[] = [];
const NO_EVENTS: CalendarEvent[] = [];
const NO_TASKS: CalendarTask[] = [];
const NO_ITEMS: AlertItem[] = [];
const NO_MUTED: string[] = [];

/** What the panel renders from. */
export interface AlertsFeed {
  /** The group is on **and** at least one source survived its own gates — with
   *  the visibility half skippable per caller (`AlertsFeedOptions`). All-off is
   *  reported as disabled rather than as an empty list: an empty strip reads
   *  as "nothing is due", which is a different and possibly wrong statement. */
  enabled: boolean;
  items: AlertItem[];
  loading: boolean;
  error: string | null;
  /** Manual re-read (the group header's ⟳). Re-stamps `now` too, so a refresh
   *  that finds no new data still re-ages what is already on screen. */
  refresh: () => void;

  /**
   * The muted rows that are **still live** — the header's 🔕 count and what the
   * reveal renders. Never folded into `items`: a mute is not a dismissal, so the
   * row has to stay reachable or the control is a one-way door.
   */
  mutedItems: AlertItem[];
  /** Silence one row (persisted as `files_alerts_muted`). */
  mute: (id: string) => void;
  /** Take one mute back. */
  unmute: (id: string) => void;
  /** Take every mute back, including ids whose row is no longer live. */
  unmuteAll: () => void;
}

/**
 * An expanded occurrence as the flat `CalendarEvent` `selectAlerts` takes.
 *
 * `rrule`/`exdates`/`overrides` are dropped rather than carried: this row *is*
 * one occurrence, and a rule left on it would invite a second expansion
 * downstream that generated the same series all over again.
 */
function eventFromOccurrence(occ: Occurrence): CalendarEvent {
  return {
    id: occ.eventId,
    calendar_id: occ.calendarId,
    start: occ.start,
    end: occ.end,
    all_day: occ.allDay,
    title: occ.title,
    location: occ.location,
    notes: occ.notes,
    conference: occ.conference,
    category: occ.category,
    status: occ.status,
    rrule: null,
    alarms: occ.alarms,
  };
}

/** Has this occurrence finished? An all-day one ends at the start of its
 *  (exclusive) end date; a timed one at its end stamp. */
function occurrenceEnded(occ: Occurrence, now: string): boolean {
  return occ.allDay ? occ.end <= datePart(now) : occ.end <= now;
}

/** What a caller other than the file viewer may say about the gates. */
export interface AlertsFeedOptions {
  /**
   * Read the feed *without* the file viewer's 🔔 visibility key. Tabtivity Mobile
   * asks for this: `files_alerts` is the desktop group's visibility, so closing
   * the strip beside the tree on the laptop would otherwise blank the phone's
   * Alerts screen — a control on one surface silently switching off another.
   * Everything that says which alerts exist (the source switches, the
   * lookahead, the mutes) still applies.
   */
  ignoreVisibility?: boolean;
}

export function useAlertsFeed(options?: AlertsFeedOptions): AlertsFeed {
  // ── The gates ─────────────────────────────────────────────────────────────
  const ignoreVisibility = options?.ignoreVisibility === true;
  const groupVisible = useSettingsStore((s) => s.settings?.files_alerts ?? true);
  const rawDays = useSettingsStore(
    (s) => s.settings?.files_alerts_days ?? DEFAULT_LOOKAHEAD_DAYS,
  );
  const sourceMail = useSettingsStore((s) => s.settings?.files_alerts_sources?.mail ?? true);
  const sourceEvents = useSettingsStore((s) => s.settings?.files_alerts_sources?.events ?? true);
  const sourceTasks = useSettingsStore((s) => s.settings?.files_alerts_sources?.tasks ?? true);
  const mailClient = useExperimental("mail_client");
  // The muted ids live in `settings.json` rather than in this hook, and that is
  // load-bearing twice over: the file viewer is mounted many times at once (the
  // side panel plus every Files tab), so per-instance state would silence a row
  // in one and leave it shouting in the next — and a mute that came back at the
  // next launch would be a control that doesn't work, the same trap `files_alerts`
  // itself avoids by being the visibility rather than a preference above one.
  const mutedIds = useSettingsStore((s) => s.settings?.files_alerts_muted);

  const { wantMail, wantEvents, wantTasks, enabled } = alertGates({
    visible: groupVisible,
    ignoreVisible: ignoreVisibility,
    mail: sourceMail,
    events: sourceEvents,
    tasks: sourceTasks,
    mailClient,
  });

  const lookaheadDays = Math.min(
    MAX_LOOKAHEAD_DAYS,
    Math.max(MIN_LOOKAHEAD_DAYS, Math.round(rawDays) || DEFAULT_LOOKAHEAD_DAYS),
  );

  // ── The clock ─────────────────────────────────────────────────────────────
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return; // opt-in: a switched-off group arms no timer.
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Recomputed on every tick, so severities age instead of freezing at the value
  // they had when the panel mounted. Local wall-clock, never a raw `Date` format
  // — every stamp the calendar stores is wall-clock (`lib/calendar/calendarTime`).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => toStamp(new Date()), [tick]);

  // ── The reads ─────────────────────────────────────────────────────────────
  // The mail read joins the refcounted module-level poll (`stores/todo`'s
  // retain/release, the `stores/remote/hostSessions` pattern): this hook is mounted
  // many times at once, and a per-instance interval — worse, one keyed on
  // `newCount` — meant N identical queries per minute and N more per delivery.
  // The poll itself re-reads on arrival, so no `newCount` subscription is left
  // here at all.
  useEffect(() => {
    if (!wantMail) return; // includes the `mail_client` gate — before the invoke.
    retainUrgentMailPoll();
    return releaseUrgentMailPoll;
  }, [wantMail]);

  useEffect(() => {
    if (!wantEvents && !wantTasks) return;
    // `load` is idempotent — only the first call does work, so mounting the
    // panel beside an open calendar tab costs nothing.
    void useCalendarStore.getState().load();
  }, [wantEvents, wantTasks]);

  const urgentMail = useTodoStore((s) => (wantMail ? s.urgentMail : NO_MAIL));
  const mailLoading = useTodoStore((s) => (wantMail ? s.urgentLoading : false));
  const mailError = useTodoStore((s) => (wantMail ? s.urgentError : null));

  const events = useCalendarStore((s) => (wantEvents ? s.events : NO_EVENTS));
  const rawTasks = useCalendarStore((s) => (wantTasks ? s.tasks : NO_TASKS));
  const calendars = useCalendarStore((s) => (enabled ? s.calendars : NO_CALENDARS));
  const calendarLoaded = useCalendarStore((s) => (enabled ? s.loaded : true));

  // ── The shaping ───────────────────────────────────────────────────────────
  // A calendar whose alerts are switched off (`Calendar.alerts_off`) is left out
  // here exactly as a hidden one is: the switch silences its reminders and its
  // badge count, and a strip that kept listing its rows would be the one
  // surface still alerting for it.
  const alertingCalendars = useMemo(
    () => new Set(calendars.filter((c) => c.visible && !c.alerts_off).map((c) => c.id)),
    [calendars],
  );

  /**
   * `selectAlerts` takes already-expanded occurrences, so the RRULE work happens
   * here — through `lib/calendar/recurrence`'s `expandEvents`, which is the one
   * implementation of what a series generates (exdates dropped, overrides
   * applied, duration carried). Hand-rolling it here would be a second answer to
   * the same question and the two would drift.
   *
   * **One row per series.** An alert row is keyed by its event id, and a daily
   * stand-up would otherwise contribute seven identical rows to a twelve-row
   * strip and crowd out everything else — so each series contributes its next
   * occurrence that has not already ended. An appointment you have already sat
   * through is not an alert, and the calendar badge is where "what did today
   * hold" is answered.
   */
  const occurrenceEvents = useMemo(() => {
    if (!wantEvents) return NO_EVENTS;
    const from = datePart(now);
    // Exclusive end, so `+ 1` is what makes the last day of the lookahead count.
    const until = addDays(from, lookaheadDays + 1);
    const seen = new Set<string>();
    const out: CalendarEvent[] = [];
    for (const occ of expandEvents(events, from, until, alertingCalendars)) {
      if (seen.has(occ.eventId)) continue;
      if (occurrenceEnded(occ, now)) continue;
      seen.add(occ.eventId);
      out.push(eventFromOccurrence(occ));
    }
    return out;
  }, [wantEvents, events, alertingCalendars, now, lookaheadDays]);

  // Filtered to visible calendars for the header to-do badge's reason: unchecking
  // a calendar in the sidebar takes its rows out of every view, and a strip that
  // kept showing them would disagree with the board and with the badge.
  const tasks = useMemo(
    () => (wantTasks ? rawTasks.filter((task) => alertingCalendars.has(task.calendar_id)) : NO_TASKS),
    [wantTasks, rawTasks, alertingCalendars],
  );

  const muted = useMemo(() => mutedIds ?? NO_MUTED, [mutedIds]);

  const input = useMemo(
    () => ({
      now,
      urgentMail,
      events: occurrenceEvents,
      tasks,
      lookaheadDays,
      limit: DEFAULT_ALERT_LIMIT,
      include: { mail: wantMail, events: wantEvents, tasks: wantTasks },
      muted,
    }),
    [
      now,
      urgentMail,
      occurrenceEvents,
      tasks,
      lookaheadDays,
      wantMail,
      wantEvents,
      wantTasks,
      muted,
    ],
  );

  const items = useMemo(() => (enabled ? selectAlerts(input) : NO_ITEMS), [enabled, input]);

  // Only computed when something is actually muted — an empty list is the
  // normal state, and `selectMutedAlerts` short-circuits on it.
  const mutedItems = useMemo(
    () => (enabled && muted.length > 0 ? selectMutedAlerts(input) : NO_ITEMS),
    [enabled, muted, input],
  );

  const writeMuted = useCallback((next: string[]) => {
    void useSettingsStore.getState().updateSettings({ files_alerts_muted: next });
  }, []);

  // `addMutedAlert` is the pure one (idempotent, newest last, bounded), so the
  // bound cannot differ between here and a test.
  const mute = useCallback((id: string) => writeMuted(addMutedAlert(muted, id)), [muted, writeMuted]);
  const unmute = useCallback(
    (id: string) => writeMuted(muted.filter((existing) => existing !== id)),
    [muted, writeMuted],
  );
  // Clears the whole key, dead ids included — the one place a mute for a row
  // that no longer renders (and so has no × of its own) can be taken back.
  const unmuteAll = useCallback(() => writeMuted([]), [writeMuted]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setTick((n) => n + 1);
    if (wantEvents || wantTasks) void useCalendarStore.getState().reload();
    if (wantMail) void useTodoStore.getState().loadUrgentMail();
  }, [enabled, wantMail, wantEvents, wantTasks]);

  return {
    enabled,
    items,
    // The calendar's own load failure is not reportable here: `reload` swallows
    // it and degrades to an empty store, so the only error this feed can name is
    // the mail read's — and naming it matters, because a locked keyring or an
    // account whose password was never saved fails every unattended read.
    loading: enabled && ((!calendarLoaded && (wantEvents || wantTasks)) || mailLoading),
    error: mailError,
    refresh,
    mutedItems,
    mute,
    unmute,
    unmuteAll,
  };
}
