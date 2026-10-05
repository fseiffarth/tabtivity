import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
  Calendar,
  CalendarData,
  CalendarEvent,
  CalendarTask,
  Occurrence,
  TaskColumn,
  TaskPlacement,
} from "../../types";
// `CalendarData` is the shape `calendar_load` returns; the store flattens it.
import {
  excludeOccurrence,
  expandEvents,
  occurrencesOn,
  overrideOccurrence,
  sortOccurrences,
} from "../../lib/calendar/recurrence";
import { mutedCalendarIds } from "../../lib/calendar/alarms";
import { addDays, toStamp, todayStr } from "../../lib/calendar/calendarTime";
import { parseIcs } from "../../lib/calendar/ics";
import { notifyCalendarWrite } from "../../lib/calendar/calendarWriteHook";
import { translate, useI18nStore } from "../../lib/i18n";

/**
 * The native calendar's store: one global set of calendars, events and tasks,
 * backed by `~/.local/share/tabtivity/calendar.json`.
 *
 * The store is deliberately *global*, not per-project — a calendar tab opened
 * from any scope shows the same events, and an edit in one is seen live by the
 * others (see `CALENDAR_TAB_CMD` in `stores/tabs.ts`).
 *
 * It holds only stored state. Recurrence expansion, alarm evaluation and ICS
 * parsing are pure functions in `src/lib/calendar/{recurrence,ics,calendarTime}.ts`;
 * components call those on the state they select here.
 *
 * Every mutation writes through to the backend and then patches local state with
 * what the backend returned, so the store never drifts from disk.
 */
/** A calendar as it was the moment before `deleteCalendar` removed it. */
export interface DeletedCalendar {
  calendar: Calendar;
  events: CalendarEvent[];
  tasks: CalendarTask[];
}

interface CalendarStore {
  /** The header button's calendar overlay is on screen (`calendar_global_app`). */
  overlayOpen: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;

  calendars: Calendar[];
  events: CalendarEvent[];
  tasks: CalendarTask[];
  loaded: boolean;

  /** Load the whole store. Safe to call repeatedly; only the first does work. */
  load: () => Promise<void>;
  /** Re-read from disk unconditionally (after an ICS import rewrites the file). */
  reload: () => Promise<void>;

  createEvent: (event: Omit<CalendarEvent, "id">) => Promise<CalendarEvent>;
  updateEvent: (event: CalendarEvent) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;

  /**
   * Delete a single occurrence of a recurring event ("this event only") by
   * excluding its rule-generated start, leaving the series intact.
   */
  deleteOccurrence: (eventId: string, occurrenceStart: string) => Promise<void>;
  /** Edit a single occurrence, leaving the rest of the series alone. */
  updateOccurrence: (
    eventId: string,
    occurrenceStart: string,
    changes: Partial<Pick<Occurrence, "start" | "end" | "title" | "location" | "notes">>,
  ) => Promise<void>;

  createTask: (task: Omit<CalendarTask, "id">) => Promise<CalendarTask>;
  updateTask: (task: CalendarTask) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;

  /**
   * The todo board's columns. **Empty until the board's first write** — the
   * backend deliberately does not seed them on read, so a calendar-only user's
   * file never grows board state; the board renders `DEFAULT_COLUMNS` from
   * `lib/todoBoard` until then.
   */
  taskColumns: TaskColumn[];
  /**
   * Apply a board drag — one backend write however many cards it moved, which is
   * why it is a store action rather than N `updateTask` calls: a whole-file
   * rewrite per card would let a concurrent edit land in the middle of a drag.
   * The returned tasks (a superset of what was dragged, whenever a reindex
   * fired) are merged into `tasks` instead of reloading the calendar.
   */
  moveTasks: (moves: TaskPlacement[]) => Promise<void>;
  /** Replace the board's columns (add/rename/recolor/reorder/delete). */
  setColumns: (columns: TaskColumn[], fallbackColumn?: string | null) => Promise<void>;

  createCalendar: (calendar: Omit<Calendar, "id">) => Promise<Calendar>;
  updateCalendar: (calendar: Calendar) => Promise<void>;
  /**
   * Delete a calendar with everything on it. Resolves to what was removed, so
   * the caller can offer an undo (`restoreCalendar`); `null` if the id is unknown.
   */
  deleteCalendar: (id: string) => Promise<DeletedCalendar | null>;
  /** Undo a `deleteCalendar`: the calendar comes back under its old id. */
  restoreCalendar: (deleted: DeletedCalendar) => Promise<void>;
  /** Toggle a calendar's checkbox in the sidebar. */
  toggleCalendarVisible: (id: string) => Promise<void>;

  /**
   * Fetch `url` (an ICS feed — TimeTree's calendar-export URL, or any other
   * read-only subscription) and replace `calendarId`'s events/tasks with what
   * it parses to, in one backend write. Manual, on-click only — nothing here
   * polls. Used both to refresh an existing subscription and, on first
   * subscribe, to populate the brand-new calendar `createCalendar` just made
   * (whose events start empty, so "replace" behaves like "insert").
   */
  refreshCalendarFromUrl: (
    calendarId: string,
    url: string,
  ) => Promise<{ events: number; tasks: number; skipped: number }>;
}

/** A new event carries no id — the backend mints one. */
const withoutId = (event: Omit<CalendarEvent, "id">): CalendarEvent =>
  ({ ...event, id: "" }) as CalendarEvent;

export const useCalendarStore = create<CalendarStore>((set, get) => ({
  overlayOpen: false,
  openOverlay: () => set({ overlayOpen: true }),
  closeOverlay: () => set({ overlayOpen: false }),

  calendars: [],
  events: [],
  tasks: [],
  taskColumns: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    await get().reload();
  },

  reload: async () => {
    const data = await invoke<CalendarData>("calendar_load").catch(() => null);
    set({
      calendars: data?.calendars ?? [],
      events: data?.events ?? [],
      tasks: data?.tasks ?? [],
      taskColumns: data?.task_columns ?? [],
      loaded: true,
    });
  },

  // ── Events ──────────────────────────────────────────────────────────────

  // Every mutation below announces itself through `notifyCalendarWrite`. With no
  // CalDAV account that is a resolved promise and nothing else; with one, it is
  // where a local edit becomes a `PUT`. The *ordering* is the part that matters
  // and is asymmetric on purpose — see `lib/calendar/calendarWriteHook.ts`: an upsert is
  // announced after the local write (an edit made offline is still an edit), a
  // delete before it (a refusal must be able to stop it).

  createEvent: async (draft) => {
    const event = await invoke<CalendarEvent>("create_event", { event: withoutId(draft) });
    set((s) => ({ events: [...s.events, event] }));
    await notifyCalendarWrite({ op: "upsert", kind: "event", row: event });
    return event;
  },

  updateEvent: async (event) => {
    // A move to another calendar, of a row a CalDAV server holds. That row is
    // a resource in its old collection, and its address cannot come along:
    // pushed under it, the move would `PUT` straight back into the calendar it
    // left. So the address is dropped (the new calendar's push is a create)
    // and the old copy is deleted — the same path a root agent's
    // `calendar_move_events` takes (`docs/context/root_console.md`).
    const prev = get().events.find((e) => e.id === event.id);
    const href = (prev?.caldav_href ?? "").trim();
    const moved = prev && href && prev.calendar_id !== event.calendar_id ? prev : null;
    if (moved) {
      // A series with occurrences edited on the server is several rows in one
      // resource; moving the master alone would split it.
      const split = get().events.some(
        (e) =>
          e.id !== moved.id &&
          e.calendar_id === moved.calendar_id &&
          (e.caldav_href ?? "").trim() === href,
      );
      if (split) {
        throw new Error(
          translate(useI18nStore.getState().lang, "eventDialog.errMoveSyncedSeries", {
            title: moved.title,
          }),
        );
      }
      event = { ...event, caldav_href: undefined, caldav_etag: undefined };
    }
    const updated = await invoke<CalendarEvent>("update_event", { event });
    set((s) => ({ events: s.events.map((e) => (e.id === updated.id ? updated : e)) }));
    if (moved) {
      // After the local write, unlike an ordinary delete: nothing is lost if
      // the server refuses, since the event already lives in its new calendar.
      // A refusal lands in the CalDAV conflict list or `pushError`, and "keep
      // mine" there removes only the copy left behind.
      await notifyCalendarWrite({ op: "delete", kind: "event", row: moved }).catch(() => {});
    }
    await notifyCalendarWrite({ op: "upsert", kind: "event", row: updated });
  },

  deleteEvent: async (id) => {
    const row = get().events.find((e) => e.id === id);
    // The row is handed over *before* it is deleted, because after the delete
    // there is no href or ETag left to address the server's copy with.
    if (row) await notifyCalendarWrite({ op: "delete", kind: "event", row });
    await invoke<void>("delete_event", { id });
    set((s) => ({ events: s.events.filter((e) => e.id !== id) }));
  },

  deleteOccurrence: async (eventId, occurrenceStart) => {
    const master = get().events.find((e) => e.id === eventId);
    if (!master) return;
    await get().updateEvent(excludeOccurrence(master, occurrenceStart));
  },

  updateOccurrence: async (eventId, occurrenceStart, changes) => {
    const master = get().events.find((e) => e.id === eventId);
    if (!master) return;
    await get().updateEvent(overrideOccurrence(master, occurrenceStart, changes));
  },

  // ── Tasks ───────────────────────────────────────────────────────────────

  createTask: async (draft) => {
    const task = await invoke<CalendarTask>("create_task", {
      task: { ...draft, id: "" } as CalendarTask,
    });
    set((s) => ({ tasks: [...s.tasks, task] }));
    await notifyCalendarWrite({ op: "upsert", kind: "task", row: task });
    return task;
  },

  updateTask: async (task) => {
    const updated = await invoke<CalendarTask>("update_task", { task });
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === updated.id ? updated : t)) }));
    await notifyCalendarWrite({ op: "upsert", kind: "task", row: updated });
  },

  deleteTask: async (id) => {
    const row = get().tasks.find((t) => t.id === id);
    if (row) await notifyCalendarWrite({ op: "delete", kind: "task", row });
    await invoke<void>("delete_task", { id });
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  // ── The todo board ──────────────────────────────────────────────────────

  moveTasks: async (moves) => {
    const changed = await invoke<CalendarTask[]>("todo_move_tasks", { moves });
    if (changed.length > 0) {
      const byId = new Map(changed.map((t) => [t.id, t]));
      set((s) => ({ tasks: s.tasks.map((t) => byId.get(t.id) ?? t) }));
    }
    // The first drag is also what *creates* the board (a read never does), so a
    // move can be the moment the columns come into existence — re-read once
    // rather than guessing what the backend seeded.
    if (get().taskColumns.length === 0) await get().reload();
  },

  setColumns: async (columns, fallbackColumn = null) => {
    const data = await invoke<CalendarData>("todo_columns_set", {
      columns,
      fallbackColumn,
    });
    // A column delete refiles cards, so the whole store comes back rather than
    // just the column list.
    set({
      calendars: data.calendars,
      events: data.events,
      tasks: data.tasks,
      taskColumns: data.task_columns ?? [],
    });
  },

  // ── Calendars ───────────────────────────────────────────────────────────

  createCalendar: async (draft) => {
    const calendar = await invoke<Calendar>("create_calendar", {
      calendar: { ...draft, id: "" } as Calendar,
    });
    set((s) => ({ calendars: [...s.calendars, calendar] }));
    return calendar;
  },

  updateCalendar: async (calendar) => {
    const updated = await invoke<Calendar>("update_calendar", { calendar });
    set((s) => ({ calendars: s.calendars.map((c) => (c.id === updated.id ? updated : c)) }));
  },

  deleteCalendar: async (id) => {
    const before = get();
    const calendar = before.calendars.find((c) => c.id === id);
    const deleted: DeletedCalendar | null = calendar
      ? {
          calendar,
          events: before.events.filter((e) => e.calendar_id === id),
          tasks: before.tasks.filter((t) => t.calendar_id === id),
        }
      : null;
    await invoke<void>("delete_calendar", { id });
    // The backend deletes the calendar's events and tasks with it; mirror that
    // locally rather than re-reading the whole file.
    set((s) => ({
      calendars: s.calendars.filter((c) => c.id !== id),
      events: s.events.filter((e) => e.calendar_id !== id),
      tasks: s.tasks.filter((t) => t.calendar_id !== id),
    }));
    return deleted;
  },

  restoreCalendar: async ({ calendar, events, tasks }) => {
    const data = await invoke<CalendarData>("restore_calendar", { calendar, events, tasks });
    set({ calendars: data.calendars, events: data.events, tasks: data.tasks });
  },

  toggleCalendarVisible: async (id) => {
    const cal = get().calendars.find((c) => c.id === id);
    if (!cal) return;
    await get().updateCalendar({ ...cal, visible: !cal.visible });
  },

  refreshCalendarFromUrl: async (calendarId, url) => {
    // A dedicated, SSRF-guarded backend fetch — the general reader fetch is
    // for HTML and would sanitize an ICS body as markup instead of handing it
    // to the parser untouched.
    const text = await invoke<string>("calendar_fetch_ics", { url });
    const parsed = parseIcs(text);
    const data = await invoke<CalendarData>("calendar_replace_events", {
      calendarId,
      events: parsed.events,
      tasks: parsed.tasks,
    });
    set({
      calendars: data.calendars,
      events: data.events,
      tasks: data.tasks,
      taskColumns: data.task_columns ?? [],
    });
    return { events: parsed.events.length, tasks: parsed.tasks.length, skipped: parsed.skipped };
  },
}));

/** The ids of the calendars currently checked in the sidebar. */
export function visibleCalendarIds(calendars: Calendar[]): Set<string> {
  return new Set(calendars.filter((c) => c.visible).map((c) => c.id));
}

/** A calendar's color, falling back to the accent when it has been deleted. */
export function calendarColor(calendars: Calendar[], id: string): string {
  return calendars.find((c) => c.id === id)?.color ?? "var(--accent)";
}

/** One day of the agenda: the date, and what is on visible calendars that day. */
export interface DayOccurrences {
  date: string;
  occurrences: Occurrence[];
}

/**
 * The next `days` days on visible calendars, a day at a time, each in start
 * order — **the** day expansion, used by the header button's badge, its hover
 * list, and the to-do board's agenda rail (`lib/todoBoard`'s `agendaWindow`
 * delegates here).
 *
 * One implementation because these surfaces are read against each other: the
 * hover list is the badge's explanation, and a number saying "3 left today" over
 * a list naming four is worse than either alone. Two call sites expanding the
 * same day with their own filters is exactly how that happens.
 *
 * Past occurrences are **included** — the badge skips them (`occurrenceEnded`)
 * and the lists dim them, because "what have I already done today" is half of
 * what a glance at the day is for, and dropping them here would make that a
 * choice the surfaces could disagree about.
 *
 * A multi-day event lands under **every** day it covers, which is what someone
 * asking "what is tomorrow" wants and what the calendar's own agenda does.
 */
export function dayAgenda(
  events: CalendarEvent[],
  calendars: Calendar[],
  now: Date = new Date(),
  days = 1,
): DayOccurrences[] {
  const first = todayStr(now);
  // `expandEvents`' window is half-open — `[start, end)` — so a single day is
  // today up to tomorrow, not today to today (which is the empty window).
  const all = expandEvents(events, first, addDays(first, days), visibleCalendarIds(calendars));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(first, i);
    return { date, occurrences: sortOccurrences(occurrencesOn(all, date)) };
  });
}

/** Today's occurrences alone — the badge's set, and `dayAgenda`'s first day. */
export function occurrencesToday(
  events: CalendarEvent[],
  calendars: Calendar[],
  now: Date = new Date(),
): Occurrence[] {
  return dayAgenda(events, calendars, now, 1)[0].occurrences;
}

/** An occurrence that has already ended — the badge skips it, the list dims it. */
export function occurrenceEnded(occ: Occurrence, now: Date = new Date()): boolean {
  if (occ.allDay) return false;
  return occ.end <= toStamp(now);
}

/**
 * How long a finished occurrence stays on the header's day list before it is
 * dropped altogether.
 *
 * Dimming a past occurrence answers "what have I already done today", and for
 * the hour after a meeting that is genuinely the question — it is the one you
 * might still be writing up, or checking the room of. A day's worth of them is
 * not: by late afternoon the dimmed rows are most of a list whose whole job is
 * to say what is still coming, and the thing you opened it for has been pushed
 * off the bottom.
 */
export const PAST_OCCURRENCE_GRACE_MIN = 60;

/**
 * An occurrence finished long enough ago to drop from a day list
 * (`PAST_OCCURRENCE_GRACE_MIN`) — the *hiding* rule, where `occurrenceEnded` is
 * the dimming one, so the two states a past row can be in are decided in one
 * place rather than by two comparisons that could drift apart.
 *
 * An all-day event is never stale: it has no hour to be an hour past.
 */
export function occurrenceStale(
  occ: Occurrence,
  now: Date = new Date(),
  graceMin = PAST_OCCURRENCE_GRACE_MIN,
): boolean {
  if (occ.allDay) return false;
  return occ.end <= toStamp(new Date(now.getTime() - graceMin * 60_000));
}

/**
 * The number in the header button's badge: **events left today**.
 *
 * Deliberately *derived*, where the mail badge's number is *acknowledged*. Mail
 * counts arrivals and clears when you open the overlay, because a delivery is an
 * event that happened once and has been seen. An appointment is not: opening the
 * calendar does not make the 3 p.m. meeting stop being at 3 p.m., so this number
 * is recomputed from the events themselves and falls to zero by the end of the
 * day on its own. Nothing here needs a "seen" flag, and adding one would only
 * let the badge lie.
 *
 * "Left" means **not yet ended**, not "not yet started" — an appointment you are
 * currently sitting in is still one of today's, and a meeting that ran from 09:00
 * to 17:00 should not vanish from the count at 09:01. An all-day event runs to
 * the end of the day, so it counts all day.
 *
 * Only *visible* calendars are counted: a calendar unchecked in the sidebar is
 * hidden from every view, and a badge that counted what no view will show would
 * send the user looking for events they cannot find.
 *
 * A calendar with its alerts switched off (`alerts_off`) is not counted either:
 * the badge is the quietest alert the calendar has, and "don't interrupt me
 * about this one" that left a number on the header would not be off. Its events
 * are left off the header's list too (`CalendarIndicator`).
 */
export function eventsLeftToday(
  events: CalendarEvent[],
  calendars: Calendar[],
  now: Date = new Date(),
): number {
  const muted = mutedCalendarIds(calendars);
  return occurrencesToday(events, calendars, now).filter(
    (occ) => !occurrenceEnded(occ, now) && !muted.has(occ.calendarId),
  ).length;
}
