/**
 * CalDAV push, the parts that decide **what bytes a resource contains**
 * (`docs/caldav_plan.md` Phase 3).
 *
 * The protocol half is Rust's and fixture-tested there; the network half cannot
 * be tested without a server. What is testable here is the half that gets a
 * calendar wrong when it is wrong — and every case below is one where a plausible
 * simpler implementation destroys data on somebody's server:
 *
 *  - re-minting a UID → the server keeps its object and files ours beside it, so
 *    one appointment becomes two;
 *  - pushing the edited row alone → the resource is *replaced* by that one
 *    component, so every occurrence override in the series is deleted;
 *  - dropping `overrides` from the body → the same loss, one edit later;
 *  - grouping unsynced rows by their (empty) href → the first push of one
 *    appointment uploads every other unsynced row on the calendar with it.
 */
import { describe, expect, it } from "vitest";

import { icsUid, parseIcs, serializeIcs } from "../../lib/calendar/ics";
import {
  orderComponents,
  resourceIcs,
  resourceRows,
  resourceUid,
} from "../../lib/calendar/caldavPush";
import type { CalendarEvent, CalendarTask } from "../../types";
import { LEGACY_BRAND } from "../../lib/brand";

const AT = new Date("2026-08-01T12:00:00Z");

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    calendar_id: "cal-1",
    start: "2026-08-03T09:00",
    end: "2026-08-03T10:00",
    all_day: false,
    title: "standup",
    ...over,
  };
}

function task(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: "t1",
    calendar_id: "cal-1",
    title: "write it up",
    priority: 0,
    percent: 0,
    ...over,
  } as CalendarTask;
}

describe("icsUid", () => {
  it("keeps the identity a row arrived with", () => {
    expect(icsUid(event({ uid: "server-side-uid" }))).toBe("server-side-uid");
  });

  it("mints a stable synthetic one for a row written here", () => {
    // Stable because the row id is: a UID derived from anything that changes
    // (a title, a start time) would make every edit a new object on the server.
    expect(icsUid(event())).toBe(`e1@${LEGACY_BRAND.slug}`);
    expect(icsUid(event({ title: "renamed" }))).toBe(`e1@${LEGACY_BRAND.slug}`);
    expect(icsUid(event({ uid: "   " }))).toBe(`e1@${LEGACY_BRAND.slug}`);
  });
});

describe("resourceRows", () => {
  it("gathers every row sharing the resource, not just the edited one", () => {
    const master = event({ id: "m", caldav_href: "https://d/c/x.ics" });
    const override = event({
      id: "o",
      caldav_href: "https://d/c/x.ics",
      recurrence_id: "2026-08-10T09:00",
    });
    const other = event({ id: "z", caldav_href: "https://d/c/other.ics" });

    const got = resourceRows(master, [master, override, other]);
    expect(got.map((r) => r.id).sort()).toEqual(["m", "o"]);
  });

  it("leaves an unsynced row alone in its resource", () => {
    // The bug this pins: grouping on an empty href would sweep every other
    // never-pushed row on the calendar into one body.
    const fresh = event({ id: "new" });
    const alsoFresh = event({ id: "new2" });
    expect(resourceRows(fresh, [fresh, alsoFresh])).toEqual([fresh]);
  });
});

describe("orderComponents", () => {
  it("puts the master first and the overrides in slot order", () => {
    const master = event({ id: "m" });
    const later = event({ id: "b", recurrence_id: "2026-08-17T09:00" });
    const sooner = event({ id: "a", recurrence_id: "2026-08-10T09:00" });
    expect(orderComponents([later, sooner, master]).map((e) => e.id)).toEqual(["m", "a", "b"]);
  });
});

describe("resourceUid", () => {
  it("is the master's, not whichever row happens to come first", () => {
    const override = event({ id: "o", uid: "series", recurrence_id: "2026-08-10T09:00" });
    const master = event({ id: "m", uid: "series" });
    expect(resourceUid([override, master])).toBe("series");
  });

  it("falls back to the first row rather than minting a new identity", () => {
    // A group of overrides with no master is what a partial sync can leave
    // behind. Minting a fresh uid there would create a duplicate object.
    const override = event({ id: "o", uid: "series", recurrence_id: "2026-08-10T09:00" });
    expect(resourceUid([override])).toBe("series");
  });
});

describe("the resource body", () => {
  it("carries the master and each occurrence override, under one UID", () => {
    const master = event({
      id: "m",
      uid: "series@example",
      rrule: { freq: "weekly", interval: 1 },
      overrides: [{ occurrence_start: "2026-08-10T09:00", start: "2026-08-10T11:00" }],
    });

    const ics = resourceIcs([master], [], AT);
    const uids = [...ics.matchAll(/^UID:(.*)$/gm)].map((m) => m[1].trim());
    expect(uids).toEqual(["series@example", "series@example"]);
    expect(ics).toContain("RECURRENCE-ID:20260810T090000");
    // The moved occurrence's own start, and the master's duration carried over
    // because the override named no end.
    expect(ics).toContain("DTSTART:20260810T110000");
    expect(ics).toContain("DTEND:20260810T120000");
  });

  it("re-emits a row that IS an override with the slot it replaces", () => {
    // The CalDAV-sourced shape: master and override are separate rows sharing
    // one href, and the override's `recurrence_id` is the only thing that says
    // which occurrence it belongs to. Losing it writes two masters.
    const master = event({ id: "m", uid: "s", caldav_href: "https://d/c/x.ics" });
    const override = event({
      id: "o",
      uid: "s",
      caldav_href: "https://d/c/x.ics",
      recurrence_id: "2026-08-10T09:00",
      start: "2026-08-10T11:00",
      end: "2026-08-10T12:00",
      title: "standup (moved)",
    });

    const ics = resourceIcs(orderComponents([override, master]), [], AT);
    const components = ics.split("BEGIN:VEVENT").slice(1);
    expect(components).toHaveLength(2);
    expect(components[0]).not.toContain("RECURRENCE-ID");
    expect(components[1]).toContain("RECURRENCE-ID:20260810T090000");
    expect(components[1]).toContain("standup (moved)");
  });

  it("never carries board state off the machine", () => {
    // `column`/`rank`/`tags`/`subtasks`/`project_id` have no VTODO
    // representation. This is the same boundary the file export already holds,
    // applied to a second output path — and the reason the body is built by the
    // existing serializer rather than a push-specific one.
    const card = task({
      uid: "todo-1",
      column: "doing",
      rank: 2048,
      tags: ["thesis"],
      project_id: "proj-1",
      subtasks: [{ id: "s0", title: "outline", done: true }],
    });
    const ics = resourceIcs([], [card], AT);
    for (const leak of ["doing", "2048", "thesis", "proj-1", "outline"]) {
      expect(ics).not.toContain(leak);
    }
    expect(ics).toContain("UID:todo-1");
    expect(ics).toContain("SUMMARY:write it up");
  });

  it("round-trips a series through the parser as master plus override", () => {
    const master = event({
      id: "m",
      uid: "series@example",
      rrule: { freq: "weekly", interval: 1 },
      overrides: [
        { occurrence_start: "2026-08-10T09:00", start: "2026-08-10T11:00", title: "moved" },
      ],
    });
    const parsed = parseIcs(resourceIcs([master], [], AT));
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].uid).toBe("series@example");
    expect(parsed.events[0].recurrence_id).toBe("");
    expect(parsed.events[1].recurrence_id).toBe("2026-08-10T09:00");
    expect(parsed.events[1].title).toBe("moved");
  });
});

describe("the file export gained the same fix", () => {
  it("no longer drops occurrence edits on the floor", () => {
    // Before Phase 3 `serializeIcs` wrote `exdates` but not `overrides`, so a
    // series exported and re-imported came back with every moved occurrence
    // silently in its original place.
    const master = event({
      id: "m",
      rrule: { freq: "weekly", interval: 1 },
      exdates: ["2026-08-17T09:00"],
      overrides: [{ occurrence_start: "2026-08-10T09:00", start: "2026-08-10T11:00" }],
    });
    const ics = serializeIcs([master], [], AT);
    expect(ics).toContain("EXDATE:20260817T090000");
    expect(ics).toContain("RECURRENCE-ID:20260810T090000");
  });
});
