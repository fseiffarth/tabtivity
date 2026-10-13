import type { CalendarEvent, Occurrence } from "../../types";
import { addDays, addMinutes, datePart, daysBetween, minutesBetween, timePart } from "./calendarTime";

/**
 * Copy/paste for calendar entries — the pure half.
 *
 * The whole point of the feature is the *narrowness* of what a paste changes:
 * the copy is the same appointment again on another day, so everything the user
 * typed — title, location, notes, the join URL, category, status, reminders,
 * the calendar it lives on and how long it lasts — rides along untouched, and
 * only the date (or, dropped on an hour grid, the start stamp) is new.
 *
 * Two things are deliberately NOT copied:
 *
 *  - **Identity.** `id`, `uid`, `caldav_href`/`caldav_etag` and `recurrence_id`
 *    name *this* object, here and on a CalDAV server. Carried into the copy they
 *    would make the paste push back over the original resource instead of
 *    creating a second appointment beside it. The draft omits them; the backend
 *    mints a new id and the next push is a create.
 *  - **The repeat rule.** What was copied is one occurrence — the block the user
 *    right-clicked — so the paste is one event. Carrying `rrule`/`exdates`/
 *    `overrides` over would silently clone a whole series (and its exceptions,
 *    which are keyed to dates the copy no longer has) from one right-click.
 *
 * Provenance *is* copied: an event made from a mail (`from_mail`) pastes as one
 * too, or a copy would launder the sender's words into the user's own.
 */
export interface CalendarClipboardEntry {
  /** The event to re-create. Already stripped of identity and repetition; only
   *  `start`/`end` (and, if its calendar is gone, `calendar_id`) are rewritten. */
  draft: Omit<CalendarEvent, "id">;
  /** What the menu calls it ("Paste “Standup”"). */
  title: string;
  /** True when it came out of a repeating series, so the menu can say that the
   *  paste will be a single event rather than a second series. */
  fromSeries: boolean;
}

/**
 * What a right-click → Copy puts on the clipboard.
 *
 * The *occurrence* is the source, not the master: when the user copies the one
 * Thursday of a series that was moved or renamed, the copy is the Thursday they
 * see. The master is read only for what an occurrence does not carry (which
 * calendar it lives on).
 */
export function copyOfOccurrence(event: CalendarEvent, occ: Occurrence): CalendarClipboardEntry {
  return {
    draft: {
      calendar_id: event.calendar_id,
      start: occ.start,
      end: occ.end,
      all_day: occ.allDay,
      title: occ.title,
      location: occ.location,
      notes: occ.notes,
      conference: occ.conference,
      category: occ.category,
      status: occ.status,
      alarms: occ.alarms,
      // A copy of a mail-made event is still the sender's words.
      ...(event.from_mail ? { from_mail: event.from_mail } : {}),
    },
    title: occ.title,
    fromSeries: occ.recurring,
  };
}

/** Where a paste landed: a day, plus the minute under the cursor on an hour grid. */
export interface PasteTarget {
  /** The day the paste was aimed at (`YYYY-MM-DD`). */
  date: string;
  /** The snapped start the hour grid was right-clicked at. Absent elsewhere —
   *  a month cell or an agenda day says nothing about a time of day, so the copy
   *  keeps its own. */
  start?: string;
}

/**
 * The event a paste creates: the copy, moved to `target`.
 *
 * An all-day copy keeps its length in whole days (its end is exclusive). A timed
 * one keeps its length in minutes and — dropped on a day rather than at an hour —
 * its own time of day, which is what makes "same meeting, next Tuesday" one
 * right-click and no re-typing.
 */
export function pastedAt(
  entry: CalendarClipboardEntry,
  target: PasteTarget,
): Omit<CalendarEvent, "id"> {
  const { draft } = entry;
  const date = datePart(target.date);

  if (draft.all_day) {
    const days = Math.max(1, daysBetween(draft.start, draft.end));
    return { ...draft, start: date, end: addDays(date, days) };
  }

  const durationMin = Math.max(1, minutesBetween(draft.start, draft.end));
  const start = target.start ?? `${date}T${timePart(draft.start) || "00:00"}`;
  return { ...draft, start, end: addMinutes(start, durationMin) };
}
