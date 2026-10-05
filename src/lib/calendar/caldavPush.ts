/**
 * What a local edit looks like on the wire (`docs/caldav_plan.md` Phase 3).
 *
 * Pure, and deliberately separate from `lib/calendar/caldav.ts` (the invoke surface) and
 * from `stores/calendar/caldav.ts` (the orchestration): everything here is a decision
 * about *what bytes a resource should contain*, which is the half worth testing
 * without a backend.
 *
 * Two ideas carry the whole module.
 *
 * **A resource is not a row.** CalDAV stores one calendar object per URL, and a
 * repeating event's occurrence edits live inside the *same* object as their
 * master — there is no separate occurrence resource to write. Tabtivity holds a
 * synced series as several rows sharing one `caldav_href`, so pushing any one of
 * them means serializing **all** of them, together, in one body. `resourceRows`
 * is that grouping and `resourceIcs` is that body. Writing only the edited row
 * would not be a partial update; it would be a complete replacement of the
 * object with one component of it, i.e. a delete of every other occurrence
 * override the series had.
 *
 * **Only the ICS-exportable subset leaves the machine.** `column`, `rank`,
 * `tags`, `subtasks`, `project_id` and `mail` are the to-do board's own state
 * with no VEVENT/VTODO representation, and `serializeIcs` already excludes them
 * from file export. This is the same boundary applied to a second output path,
 * not a new policy — which is exactly why the body is built by the *existing*
 * serializer rather than by a push-specific one that could drift from it.
 */

import { icsUid, serializeIcs } from "./ics";
import type { CalendarEvent, CalendarTask } from "../../types";

/** What kind of row a push is about — the backend's `kind` argument. */
export type CalDavRowKind = "event" | "task";

/** A row that can be pushed, with the identity fields the push path reads. */
export interface PushableRow {
  id: string;
  calendar_id: string;
  caldav_href?: string;
  caldav_etag?: string;
  uid?: string;
}

/**
 * Every row that shares a resource with `row` — the whole calendar object.
 *
 * A row with no `caldav_href` is a **new** object and is alone in it, whatever
 * else is in the calendar: nothing on the server points at it yet. Grouping by
 * an empty href would sweep every other unsynced row on that calendar into one
 * body, which is how a first push of one appointment uploads five.
 */
export function resourceRows<T extends PushableRow>(row: T, all: T[]): T[] {
  const href = (row.caldav_href ?? "").trim();
  if (!href) return [row];
  const group = all.filter((r) => (r.caldav_href ?? "").trim() === href);
  return group.length > 0 ? group : [row];
}

/**
 * Master first, then occurrence overrides in slot order.
 *
 * The order is not cosmetic. RFC 4791 §4.1 requires the components of one object
 * to share a UID, and readers take the component *without* a `RECURRENCE-ID` as
 * the series definition; several servers reject a body whose first component is
 * an override, and some readers show one as a standalone event. Sorting here
 * rather than relying on the order rows happen to sit in `calendar.json` is what
 * makes the body stable across a re-sync that rewrote them.
 */
export function orderComponents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    const aOv = (a.recurrence_id ?? "").trim();
    const bOv = (b.recurrence_id ?? "").trim();
    if (!aOv && bOv) return -1;
    if (aOv && !bOv) return 1;
    return aOv.localeCompare(bOv);
  });
}

/**
 * The iCalendar body for one resource.
 *
 * `now` is injected for the reason `serializeIcs`' is: a `DTSTAMP` read from the
 * clock makes every push produce different bytes and every test unrepeatable.
 */
export function resourceIcs(
  events: CalendarEvent[],
  tasks: CalendarTask[],
  now?: Date,
): string {
  return serializeIcs(orderComponents(events), tasks, now);
}

/**
 * The UID a resource is stored under — the master's.
 *
 * Taken from the component that is *not* an override, because that is the one
 * whose identity the series has. Falling back to the first row keeps a
 * malformed group (overrides with no master, which a partial sync can leave
 * behind) from minting a fresh identity and creating a duplicate object.
 */
export function resourceUid(rows: (CalendarEvent | CalendarTask)[]): string {
  const master =
    rows.find((r) => !("recurrence_id" in r && (r.recurrence_id ?? "").trim())) ?? rows[0];
  return master ? icsUid(master) : "";
}
