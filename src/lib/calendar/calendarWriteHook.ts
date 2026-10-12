/**
 * The seam between a calendar edit and CalDAV push (`docs/caldav_plan.md`
 * Phase 3) — one registered handler, and nothing else.
 *
 * It exists to keep the dependency pointing one way. `stores/calendar/caldav` already
 * imports `stores/calendar/calendar` (a sync writes what the calendar surfaces read), so
 * having the calendar store import the CalDAV store back would be a cycle
 * between two module-scope `create()` calls — the shape that resolves to
 * `undefined` at import time depending on which file the bundler reaches first.
 * Instead the calendar store depends on *this*, which knows nothing, and the
 * CalDAV side registers itself at mount. `initMachineSync` installs a
 * subscription in `AppShell` for the same reason.
 *
 * **The two directions are not symmetric, and that is the point.**
 *
 * - An **upsert** is announced *after* the local write succeeded. `calendar.json`
 *   is the user's own store and must not be held hostage to a server being
 *   reachable: an edit made offline is still an edit, and it pushes on the next
 *   sync.
 * - A **delete** is announced *before*, and a rejection **stops** it. The other
 *   order deletes the row locally and then discovers the server refused, leaving
 *   nothing to retry from and an appointment that is gone here and still there
 *   for everyone else.
 */

import type { CalendarEvent, CalendarTask } from "../../types";

/** What happened to a row. */
export type CalendarWriteOp = "upsert" | "delete";

export interface CalendarWriteEvent {
  op: CalendarWriteOp;
  kind: "event" | "task";
  /** The row as it now is (upsert), or as it still is (delete). */
  row: CalendarEvent | CalendarTask;
}

/**
 * Handles one write. Rejecting is meaningful **only** for `delete`, where it
 * cancels the local delete; an `upsert` that rejects has already been written
 * locally and the rejection is reported, not undone.
 */
export type CalendarWriteHandler = (event: CalendarWriteEvent) => Promise<void>;

let handler: CalendarWriteHandler | null = null;

/**
 * Install the handler. Returns the uninstaller, so a host component can drop it
 * on unmount and a test can leave no global state behind.
 *
 * Deliberately last-writer-wins with a single slot rather than a listener list:
 * there is exactly one thing that may answer for a row's server side, and two
 * registered handlers would mean two pushes of one edit.
 */
export function setCalendarWriteHandler(next: CalendarWriteHandler | null): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * Announce a write. With nothing registered this resolves immediately — which is
 * the normal state for someone with no CalDAV account, and is why the calendar
 * store can call it unconditionally.
 */
export function notifyCalendarWrite(event: CalendarWriteEvent): Promise<void> {
  return handler ? handler(event) : Promise.resolve();
}

/**
 * Whether a write into this calendar is one CalDAV will push — a calendar a
 * writable account syncs. Registered beside the handler by the CalDAV side, so
 * the calendar store can mark the row `caldav_dirty` **in the same local write**
 * (gap 32) without importing the CalDAV store. With nothing registered, no
 * calendar is.
 */
export type CalendarDirtyPredicate = (calendarId: string) => boolean;

let dirtyPredicate: CalendarDirtyPredicate | null = null;

/** Install the predicate. Returns the uninstaller. */
export function setCalendarDirtyPredicate(next: CalendarDirtyPredicate | null): () => void {
  dirtyPredicate = next;
  return () => {
    if (dirtyPredicate === next) dirtyPredicate = null;
  };
}

/** `row`, marked `caldav_dirty` when its calendar is one CalDAV pushes. */
export function markForPush<T extends { calendar_id: string; caldav_dirty?: boolean }>(row: T): T {
  return dirtyPredicate?.(row.calendar_id) ? { ...row, caldav_dirty: true } : row;
}
