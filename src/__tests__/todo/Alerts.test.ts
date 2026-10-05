import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_LIMIT,
  IMMINENT_MINUTES,
  MAX_MUTED_ALERTS,
  addMutedAlert,
  alertCounts,
  alertGates,
  readsInHours,
  selectAlerts,
  selectMutedAlerts,
  severityFor,
} from "../../lib/alerts";
import type { AlertItem } from "../../lib/alerts";
import { awayDelta } from "../../lib/todoBoard";
import type { CalendarEvent, CalendarTask } from "../../types";
import type { MailHeader } from "../../types/mail";
import { BRAND } from "../../lib/brand";

/**
 * The alert feed's selector layer.
 *
 * Everything here is a boundary: an event starting in exactly an hour, a card
 * due today that is not late yet, a message dated in the future by a skewed
 * sender clock. They are only testable because `now` is a parameter — so every
 * case below pins it to the same wall-clock minute and moves the *data*.
 */

const NOW = "2026-07-08T09:00";

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    calendar_id: "work",
    start: "2026-07-08T10:00",
    end: "2026-07-08T11:00",
    all_day: false,
    title: "standup",
    ...over,
  };
}

function task(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: "t1",
    calendar_id: "work",
    title: "write it down",
    priority: 0,
    percent: 0,
    ...over,
  };
}

/**
 * `date` is written without an offset on purpose: JS reads that as local time,
 * so the fixtures mean the same wall-clock minute whatever TZ the suite runs in.
 * The offset-bearing form gets its own test.
 */
function mail(over: Partial<MailHeader> = {}): MailHeader {
  return {
    id: "INBOX-1",
    account_id: "acct",
    folder_id: "INBOX",
    uid: 1,
    subject: "server is down",
    from: { name: "Ops", address: "ops@example.com" },
    to: [],
    cc: [],
    date: "2026-07-08T08:00:00",
    seen: false,
    flagged: false,
    answered: false,
    has_attachments: false,
    size: 100,
    preview: "",
    priority: "urgent",
    priority_source: "user",
    ...over,
  };
}

const ids = (items: AlertItem[]) => items.map((i) => i.id);
const one = (items: AlertItem[]) => {
  expect(items).toHaveLength(1);
  return items[0];
};

describe("severityFor", () => {
  it("puts the imminent boundary inside `now`, not `soon`", () => {
    expect(severityFor(IMMINENT_MINUTES, false)).toBe("now");
    expect(severityFor(IMMINENT_MINUTES + 1, false)).toBe("soon");
  });

  it("puts exactly 24h inside `soon`, not `upcoming`", () => {
    expect(severityFor(24 * 60, false)).toBe("soon");
    expect(severityFor(24 * 60 + 1, false)).toBe("upcoming");
  });

  it("never calls an all-day item overdue on its own day", () => {
    // A date-only row's `minutesAway` counts to the END of its day, so at 09:00
    // on the due date there are still 900 minutes of it left. It only goes
    // negative once the day itself is over.
    expect(severityFor(900, true)).toBe("now");
    expect(severityFor(0, true)).toBe("now");
    expect(severityFor(-1, true)).toBe("overdue");
  });

  it("gives an all-day item its own whole day, and the day before as `soon`", () => {
    expect(severityFor(24 * 60, true)).toBe("now"); // midnight, the day begins
    expect(severityFor(24 * 60 + 1, true)).toBe("soon"); // it is tomorrow's
    expect(severityFor(48 * 60, true)).toBe("soon");
    expect(severityFor(48 * 60 + 1, true)).toBe("upcoming");
  });

  it("treats a missing stamp as `now` rather than dropping it down the list", () => {
    expect(severityFor(null, false)).toBe("now");
  });
});

describe("selectAlerts — severity boundaries", () => {
  it("classifies a timed event by how far off it is", () => {
    const at = (start: string) =>
      one(selectAlerts({ now: NOW, events: [ev({ start, end: start })] })).severity;

    expect(at("2026-07-08T08:59")).toBe("overdue");
    expect(at("2026-07-08T09:00")).toBe("now");
    expect(at("2026-07-08T10:00")).toBe("now"); // exactly IMMINENT_MINUTES
    expect(at("2026-07-08T10:01")).toBe("soon");
    expect(at("2026-07-09T09:00")).toBe("soon"); // exactly 24h
    expect(at("2026-07-09T09:01")).toBe("upcoming");
  });

  it("reports whole minutes, negative in the past", () => {
    const items = selectAlerts({
      now: NOW,
      events: [ev({ id: "past", start: "2026-07-08T08:30" }), ev({ id: "soon", start: "2026-07-08T09:45" })],
    });
    expect(items.map((i) => i.minutesAway)).toEqual([-30, 45]);
  });

  it("ignores the seconds on a full ISO `now`", () => {
    const items = selectAlerts({
      now: "2026-07-08T09:00:45",
      events: [ev({ start: "2026-07-08T09:30" })],
    });
    expect(one(items).minutesAway).toBe(30);
  });

  it("does not call a card due today overdue at 09:00", () => {
    const item = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08" })] }));
    expect(item.allDay).toBe(true);
    expect(item.severity).toBe("now");
  });

  it("does call it overdue the next day", () => {
    const item = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-07" })] }));
    expect(item.severity).toBe("overdue");
  });

  it("measures a date-only due to the END of its day, not to its midnight", () => {
    // Wednesday 09:00 → a card due Friday. The deadline is the end of Friday,
    // i.e. 2 days and 15 hours off — anchoring on Friday 00:00 gave 39 h, which
    // the day-granular readout then reported as "in 1 d".
    const item = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-10" })] }));
    expect(item.allDay).toBe(true);
    expect(item.minutesAway).toBe(2 * 1440 + 15 * 60);
    expect(item.daysAway).toBe(2);
  });

  it("counts calendar days, whatever the hour of the reading", () => {
    const daysAt = (now: string) =>
      one(selectAlerts({ now, tasks: [task({ due: "2026-07-10" })] })).daysAway;
    // The same Friday deadline is 2 days off all Wednesday long — the figure a
    // minutes/1440 division moves between 2 and 3 as the day wears on.
    expect(daysAt("2026-07-08T00:01")).toBe(2);
    expect(daysAt("2026-07-08T23:59")).toBe(2);
  });

  it("treats a due date carrying an hour as a timed deadline", () => {
    const item = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08T17:00" })] }));
    expect(item.allDay).toBe(false);
    expect(item.minutesAway).toBe(8 * 60);
    expect(item.severity).toBe("soon");
    // ...and it is late from 17:01, rather than from midnight.
    const late = one(selectAlerts({
      now: "2026-07-08T17:01",
      tasks: [task({ due: "2026-07-08T17:00" })],
    }));
    expect(late.severity).toBe("overdue");
    expect(late.minutesAway).toBe(-1);
  });

  it("keeps an all-day event all-day", () => {
    const item = one(
      selectAlerts({
        now: NOW,
        events: [ev({ all_day: true, start: "2026-07-09", end: "2026-07-10" })],
      }),
    );
    expect(item.allDay).toBe(true);
    expect(item.at).toBe("2026-07-09");
  });

  it("returns nothing at all for an unusable clock", () => {
    // Rather than classifying every deadline against a broken `now`.
    expect(selectAlerts({ now: "not a date", events: [ev()], tasks: [task({ due: "2026-07-08" })] }))
      .toEqual([]);
  });
});

describe("readsInHours — which rows keep their hours", () => {
  /** What the strip actually prints, off the row: the group's own measurement. */
  const delta = (item: AlertItem) =>
    awayDelta(item.minutesAway ?? 0, item.daysAway ?? 0, !readsInHours(item));

  it("reads a card with no time in hours — its deadline is that day's midnight", () => {
    // 09:00 on the due date: 15 hours of it left. Read in whole days this is
    // `daysAway === 0`, i.e. a bare "today" for the entire last day of a card.
    const item = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08" })] }));
    expect(item.allDay).toBe(true); // the stamp still has no hour...
    expect(readsInHours(item)).toBe(true); // ...but the deadline does
    expect(delta(item)).toEqual({ late: false, unit: "h", count: 15 });
  });

  it("keeps both halves for a card further out", () => {
    // Wednesday 09:00 → due Friday: to the end of Friday is 2 d 15 h.
    const item = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-10" })] }));
    expect(delta(item)).toEqual({ late: false, unit: "dh", count: 2, hours: 15 });
  });

  it("says how late a date-only card is in hours once its day is over", () => {
    const item = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-07" })] }));
    expect(item.severity).toBe("overdue");
    expect(delta(item)).toEqual({ late: true, unit: "h", count: 9 });
  });

  it("leaves an all-day event in whole days — a conference day is not a deadline", () => {
    const item = one(
      selectAlerts({
        now: NOW,
        events: [ev({ all_day: true, start: "2026-07-09", end: "2026-07-10" })],
      }),
    );
    expect(readsInHours(item)).toBe(false);
    expect(delta(item)).toEqual({ late: false, unit: "d", count: 1 });
  });

  it("changes nothing for a timed row", () => {
    const timed = one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08T17:00" })] }));
    expect(readsInHours(timed)).toBe(true);
    expect(delta(timed)).toEqual({ late: false, unit: "h", count: 8 });

    const meeting = one(selectAlerts({ now: NOW, events: [ev({ start: "2026-07-08T09:45" })] }));
    expect(readsInHours(meeting)).toBe(true);
    expect(delta(meeting)).toEqual({ late: false, unit: "min", count: 45 });
  });
});

describe("selectAlerts — what never becomes a row", () => {
  it("drops completed cards, by percent or by stamp", () => {
    const items = selectAlerts({
      now: NOW,
      tasks: [
        task({ id: "done-pct", due: "2026-07-08", percent: 100 }),
        task({ id: "done-stamp", due: "2026-07-08", completed: "2026-07-07T12:00" }),
        task({ id: "open", due: "2026-07-08" }),
      ],
    });
    expect(ids(items)).toEqual(["task:open"]);
  });

  it("drops a cancelled event but keeps a tentative one", () => {
    const items = selectAlerts({
      now: NOW,
      events: [
        ev({ id: "off", status: "cancelled" }),
        ev({ id: "maybe", status: "tentative" }),
        ev({ id: "plain", status: "" }),
      ],
    });
    expect(ids(items).sort()).toEqual(["event:maybe", "event:plain"]);
  });

  it("drops a card with neither a due nor a start date", () => {
    expect(selectAlerts({ now: NOW, tasks: [task({ due: null, start: null })] })).toEqual([]);
  });

  it("falls back to a card's start when it has no due", () => {
    const item = one(selectAlerts({ now: NOW, tasks: [task({ start: "2026-07-08T11:00" })] }));
    expect(item.at).toBe("2026-07-08T11:00");
    expect(item.allDay).toBe(false);
  });

  it("drops mail already converted into an open card", () => {
    const items = selectAlerts({
      now: NOW,
      urgentMail: [mail({ id: "INBOX-1" }), mail({ id: "INBOX-2" })],
      tasks: [task({ id: "card", due: null, mail: { message_id: "INBOX-1" } })],
    });
    expect(ids(items)).toEqual(["mail:INBOX-2"]);
  });

  it("brings that mail back once the card is done", () => {
    const items = selectAlerts({
      now: NOW,
      urgentMail: [mail({ id: "INBOX-1" })],
      tasks: [task({ id: "card", due: null, percent: 100, mail: { message_id: "INBOX-1" } })],
    });
    expect(ids(items)).toEqual(["mail:INBOX-1"]);
  });

  it("alerts only on Urgent marks the user made by hand", () => {
    const items = selectAlerts({
      now: NOW,
      urgentMail: [
        mail({ id: "INBOX-1", priority_source: "user" }),
        mail({ id: "INBOX-2", priority_source: "filter" }),
        mail({ id: "INBOX-3", priority_source: "model" }),
        mail({ id: "INBOX-4", priority_source: undefined }),
      ],
    });
    expect(ids(items)).toEqual(["mail:INBOX-1"]);
  });

  it("honours the per-source opt-outs", () => {
    const input = {
      now: NOW,
      urgentMail: [mail()],
      events: [ev()],
      tasks: [task({ due: "2026-07-08" })],
    };
    expect(selectAlerts(input)).toHaveLength(3);
    expect(ids(selectAlerts({ ...input, include: { mail: false } })).every((i) => !i.startsWith("mail")))
      .toBe(true);
    expect(selectAlerts({ ...input, include: { mail: false, events: false, tasks: false } }))
      .toEqual([]);
    // An unset flag is on, not off.
    expect(selectAlerts({ ...input, include: { events: false } })).toHaveLength(2);
  });
});

describe("selectAlerts — the lookahead window", () => {
  it("cuts the future at a whole day boundary", () => {
    const items = selectAlerts({
      now: NOW,
      events: [
        ev({ id: "in", start: "2026-07-15T23:00" }), // day 7, late
        ev({ id: "out", start: "2026-07-16T00:01" }), // day 8
      ],
    });
    expect(ids(items)).toEqual(["event:in"]);
  });

  it("honours a caller-supplied window", () => {
    const events = [ev({ id: "a", start: "2026-07-09T09:00" }), ev({ id: "b", start: "2026-07-11T09:00" })];
    expect(ids(selectAlerts({ now: NOW, events, lookaheadDays: 1 }))).toEqual(["event:a"]);
    expect(ids(selectAlerts({ now: NOW, events, lookaheadDays: 0 }))).toEqual([]);
  });

  it("never cuts the past — an overdue card stays however old it is", () => {
    const items = selectAlerts({
      now: NOW,
      lookaheadDays: 0,
      tasks: [task({ due: "2025-01-01" })],
    });
    expect(one(items).severity).toBe("overdue");
  });

  /**
   * A card's future is not a meeting's: a meeting next month is a fact about
   * the calendar, a card due next month is a plan, and a strip of plans is a
   * second board. So the lookahead can only shorten a card's window, never
   * lengthen it past `TASK_LOOKAHEAD_DAYS`.
   */
  it("cuts a card at 7 days however long the lookahead is", () => {
    const tasks = [
      task({ id: "in", due: "2026-07-14" }), // day 6
      task({ id: "edge", due: "2026-07-15" }), // day 7 — out for a card
      task({ id: "far", due: "2026-08-08" }),
    ];
    const items = selectAlerts({ now: NOW, tasks, lookaheadDays: 60 });
    expect(ids(items)).toEqual(["task:in"]);
    // The same 60-day window still reaches that far for an *event*.
    expect(
      ids(selectAlerts({ now: NOW, events: [ev({ id: "far", start: "2026-08-08T09:00" })], lookaheadDays: 60 })),
    ).toEqual(["event:far"]);
  });

  it("still lets a shorter lookahead win over the card cut", () => {
    const items = selectAlerts({
      now: NOW,
      lookaheadDays: 1,
      tasks: [task({ id: "soon", due: "2026-07-09" }), task({ id: "later", due: "2026-07-12" })],
    });
    expect(ids(items)).toEqual(["task:soon"]);
  });

  it("never applies the window to mail, which has no future deadline", () => {
    const items = selectAlerts({
      now: NOW,
      lookaheadDays: 0,
      urgentMail: [mail({ date: "2026-01-01T08:00:00" })],
    });
    expect(ids(items)).toEqual(["mail:INBOX-1"]);
  });
});

describe("selectAlerts — mail rows", () => {
  it("takes `at` from the arrival date and the detail from the sender", () => {
    const item = one(selectAlerts({ now: NOW, urgentMail: [mail()] }));
    expect(item.at).toBe("2026-07-08T08:00");
    expect(item.minutesAway).toBe(-60);
    expect(item.allDay).toBe(false);
    // The addr-spec is never dropped in favour of the display name.
    expect(item.detail).toBe("Ops <ops@example.com>");
    expect(item.source).toEqual({
      mailId: "INBOX-1",
      mailAccountId: "acct",
      mailPriority: "urgent",
    });
  });

  it("falls back to the bare address when there is no display name", () => {
    const item = one(selectAlerts({ now: NOW, urgentMail: [mail({ from: { address: "a@b.c" } })] }));
    expect(item.detail).toBe("a@b.c");
  });

  it("converts an offset-bearing RFC 3339 date to local wall clock", () => {
    const stamped = "2026-07-08T06:30:00Z";
    const local = new Date(stamped);
    const item = one(selectAlerts({ now: NOW, urgentMail: [mail({ date: stamped })] }));
    expect(item.at).toBe(
      `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-` +
        `${String(local.getDate()).padStart(2, "0")}T` +
        `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`,
    );
  });

  it("keeps an urgent message with an unusable date, with a null `at`", () => {
    const item = one(selectAlerts({ now: NOW, urgentMail: [mail({ date: "" })] }));
    expect(item.at).toBeNull();
    expect(item.minutesAway).toBeNull();
    expect(item.severity).toBe("now");
  });

  it("never lets a future-dated urgent message sink below `now`", () => {
    // A skewed sender clock must not demote a mark the user applied by hand.
    const urgent = one(selectAlerts({ now: NOW, urgentMail: [mail({ date: "2026-07-20T08:00:00" })] }));
    expect(urgent.severity).toBe("now");
  });

  it("records the message as urgent", () => {
    const item = one(selectAlerts({ now: NOW, urgentMail: [mail()] }));
    expect(item.source.mailPriority).toBe("urgent");
  });
});

describe("selectAlerts — titles and details", () => {
  it("falls back to a dash rather than an empty title", () => {
    expect(one(selectAlerts({ now: NOW, events: [ev({ title: "" })] })).title).toBe("—");
    expect(one(selectAlerts({ now: NOW, urgentMail: [mail({ subject: "" })] })).title).toBe("—");
  });

  it("strips bidi/zero-width controls out of somebody else's text", () => {
    const item = one(selectAlerts({ now: NOW, events: [ev({ title: "in‮voice" })] }));
    expect(item.title).toBe("invoice");
  });

  it("prefers a card's project, then its category, then its tags", () => {
    const detail = (over: Partial<CalendarTask>) =>
      one(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08", ...over })] })).detail;

    expect(detail({ project_id: BRAND.slug, category: "work", tags: ["a"] })).toBe(BRAND.slug);
    expect(detail({ category: "work", tags: ["a"] })).toBe("work");
    expect(detail({ tags: ["a", "b"] })).toBe("a · b");
    expect(detail({})).toBe("");
  });

  it("uses an event's location, then its category", () => {
    expect(one(selectAlerts({ now: NOW, events: [ev({ location: "Room 2" })] })).detail).toBe("Room 2");
    expect(one(selectAlerts({ now: NOW, events: [ev({ category: "team" })] })).detail).toBe("team");
  });

  it("carries the ids the open action needs", () => {
    const item = one(
      selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08", project_id: BRAND.slug })] }),
    );
    expect(item.id).toBe("task:t1");
    expect(item.source).toEqual({ taskId: "t1", calendarId: "work", projectId: BRAND.slug });
  });

  it("carries an event's video-call link + provider for the Join button", () => {
    const item = one(
      selectAlerts({ now: NOW, events: [ev({ conference: "https://zoom.us/j/42" })] }),
    );
    expect(item.source.conferenceUrl).toBe("https://zoom.us/j/42");
    expect(item.source.conferenceProvider).toBe("Zoom");
  });

  it("derives the link from a location that is a bare meeting URL", () => {
    const item = one(
      selectAlerts({ now: NOW, events: [ev({ location: "https://meet.google.com/abc-def" })] }),
    );
    expect(item.source.conferenceUrl).toBe("https://meet.google.com/abc-def");
    expect(item.source.conferenceProvider).toBe("Google Meet");
  });

  it("leaves an event with no joinable link without a conference url", () => {
    const item = one(selectAlerts({ now: NOW, events: [ev({ location: "Room 2" })] }));
    expect(item.source.conferenceUrl).toBeUndefined();
    expect(item.source.conferenceProvider).toBeUndefined();
  });
});

describe("selectAlerts — ordering", () => {
  it("sorts by time, then kind, then id — an overdue row is earliest anyway", () => {
    const items = selectAlerts({
      now: NOW,
      events: [
        ev({ id: "later", start: "2026-07-11T09:00" }), // upcoming
        ev({ id: "imminent", start: "2026-07-08T09:30" }), // now
        ev({ id: "tomorrow", start: "2026-07-09T08:00" }), // soon
      ],
      tasks: [task({ id: "late", due: "2026-07-01" })], // overdue
    });
    expect(ids(items)).toEqual([
      "task:late",
      "event:imminent",
      "event:tomorrow",
      "event:later",
    ]);
  });

  it("sorts by `at`, not by the mail severity floor", () => {
    // `mailSeverity` raises a skew-dated urgent message's dot to "now" without
    // touching its `at` — the row still sorts on that (future) date, behind an
    // event actually starting soon, even though its severity reads louder.
    const items = selectAlerts({
      now: NOW,
      urgentMail: [mail({ id: "INBOX-skewed", date: "2026-07-20T08:00:00" })],
      events: [ev({ id: "soon", start: "2026-07-08T09:30" })],
    });
    const skewed = items.find((i) => i.id === "mail:INBOX-skewed");
    expect(skewed?.severity).toBe("now");
    expect(ids(items)).toEqual(["event:soon", "mail:INBOX-skewed"]);
  });

  it("puts an all-day event before the same day's timed ones", () => {
    const items = selectAlerts({
      now: NOW,
      events: [
        ev({ id: "timed", start: "2026-07-09T08:00" }),
        ev({ id: "allday", all_day: true, start: "2026-07-09", end: "2026-07-10" }),
      ],
    });
    expect(ids(items)).toEqual(["event:allday", "event:timed"]);
  });

  it("puts a date-only task's card AFTER a same-day timed event, not before", () => {
    // NOW is 2026-07-08T09:00. A bare-date task due today reads "due in 15h"
    // (to midnight) — it must not outrank an event two hours off just because
    // its `at` has no time component and looks like the start of the day.
    const items = selectAlerts({
      now: NOW,
      events: [ev({ id: "soon", start: "2026-07-08T11:00" })], // 2h away
      tasks: [task({ id: "today", due: "2026-07-08" })], // due in 15h (midnight)
    });
    expect(ids(items)).toEqual(["event:soon", "task:today"]);
  });

  it("still puts a date-only task ahead of a LATER day's timed event", () => {
    const items = selectAlerts({
      now: NOW,
      events: [ev({ id: "later", start: "2026-07-09T08:00" })],
      tasks: [task({ id: "today", due: "2026-07-08" })],
    });
    expect(ids(items)).toEqual(["task:today", "event:later"]);
  });

  it("sorts a null `at` last within its severity", () => {
    const items = selectAlerts({
      now: NOW,
      urgentMail: [mail({ id: "INBOX-nodate", date: "" }), mail({ id: "INBOX-dated", date: "2026-07-08T09:30:00" })],
      events: [ev({ id: "imminent", start: "2026-07-08T09:15" })],
    });
    expect(ids(items)).toEqual(["event:imminent", "mail:INBOX-dated", "mail:INBOX-nodate"]);
  });

  it("breaks a same-minute tie by kind, then id", () => {
    const items = selectAlerts({
      now: NOW,
      events: [ev({ id: "b", start: "2026-07-08T09:30" }), ev({ id: "a", start: "2026-07-08T09:30" })],
      tasks: [task({ id: "t", due: "2026-07-08T09:30" })],
    });
    expect(ids(items)).toEqual(["event:a", "event:b", "task:t"]);
  });

  it("is deterministic under a reordered input", () => {
    const events = [
      ev({ id: "a", start: "2026-07-09T08:00" }),
      ev({ id: "b", start: "2026-07-08T09:30" }),
      ev({ id: "c", start: "2026-07-11T09:00" }),
    ];
    const tasks = [task({ id: "x", due: "2026-07-08" }), task({ id: "y", due: "2026-07-01" })];
    const forward = selectAlerts({ now: NOW, events, tasks });
    const reversed = selectAlerts({
      now: NOW,
      events: [...events].reverse(),
      tasks: [...tasks].reverse(),
    });
    expect(ids(reversed)).toEqual(ids(forward));
  });
});

describe("selectAlerts — the cap", () => {
  it("truncates after the sort, keeping the loudest rows", () => {
    const tasks = [
      task({ id: "late-1", due: "2026-07-01" }),
      task({ id: "late-2", due: "2026-07-02" }),
      task({ id: "far", due: "2026-07-13" }),
    ];
    const items = selectAlerts({ now: NOW, tasks, limit: 2 });
    expect(ids(items)).toEqual(["task:late-1", "task:late-2"]);
  });

  it("caps at DEFAULT_ALERT_LIMIT with no limit given", () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      task({ id: `t${i}`, due: "2026-07-08T10:00" }),
    );
    expect(selectAlerts({ now: NOW, tasks })).toHaveLength(DEFAULT_ALERT_LIMIT);
  });

  it("renders nothing for a zero or negative limit", () => {
    expect(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08" })], limit: 0 })).toEqual([]);
    expect(selectAlerts({ now: NOW, tasks: [task({ due: "2026-07-08" })], limit: -3 })).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(selectAlerts({ now: NOW })).toEqual([]);
  });
});

describe("selectAlerts — muting", () => {
  it("drops a muted row and leaves the rest alone", () => {
    const tasks = [task({ id: "a", due: "2026-07-01" }), task({ id: "b", due: "2026-07-02" })];
    expect(ids(selectAlerts({ now: NOW, tasks, muted: ["task:a"] }))).toEqual(["task:b"]);
  });

  it("mutes before the cap, so a silenced row never eats a slot", () => {
    const tasks = [
      task({ id: "a", due: "2026-07-01" }),
      task({ id: "b", due: "2026-07-02" }),
      task({ id: "c", due: "2026-07-03" }),
    ];
    // Without the ordering rule this returns just ["task:b"]: `a` would take the
    // first of the two slots and be filtered out afterwards.
    expect(ids(selectAlerts({ now: NOW, tasks, limit: 2, muted: ["task:a"] })))
      .toEqual(["task:b", "task:c"]);
  });

  it("does not let a muted message consume a mail slot either", () => {
    const urgentMail = [
      mail({ id: "INBOX-1", date: "2026-07-08T08:00:00" }),
      mail({ id: "INBOX-2", date: "2026-07-08T08:10:00" }),
    ];
    expect(ids(selectAlerts({ now: NOW, urgentMail, limit: 1, muted: ["mail:INBOX-1"] })))
      .toEqual(["mail:INBOX-2"]);
  });

  it("ignores a muted id nothing matches", () => {
    const tasks = [task({ id: "a", due: "2026-07-01" })];
    expect(ids(selectAlerts({ now: NOW, tasks, muted: ["task:gone", "event:none"] })))
      .toEqual(["task:a"]);
  });
});

describe("selectMutedAlerts", () => {
  it("returns only the muted rows that are still live", () => {
    const tasks = [task({ id: "a", due: "2026-07-01" }), task({ id: "b", due: "2026-07-02" })];
    // `task:gone` is a mute whose card no longer exists — no row, no count.
    expect(ids(selectMutedAlerts({ now: NOW, tasks, muted: ["task:a", "task:gone"] })))
      .toEqual(["task:a"]);
  });

  it("is empty when nothing is muted", () => {
    const tasks = [task({ id: "a", due: "2026-07-01" })];
    expect(selectMutedAlerts({ now: NOW, tasks })).toEqual([]);
    expect(selectMutedAlerts({ now: NOW, tasks, muted: [] })).toEqual([]);
  });

  it("partitions the same feed as selectAlerts — no row in both, none lost", () => {
    const tasks = [
      task({ id: "a", due: "2026-07-01" }),
      task({ id: "b", due: "2026-07-02" }),
      task({ id: "c", due: "2026-07-03" }),
    ];
    const muted = ["task:b"];
    const visible = ids(selectAlerts({ now: NOW, tasks, muted }));
    const silenced = ids(selectMutedAlerts({ now: NOW, tasks, muted }));
    expect(visible).toEqual(["task:a", "task:c"]);
    expect(silenced).toEqual(["task:b"]);
    expect(visible.filter((id) => silenced.includes(id))).toEqual([]);
  });
});

describe("addMutedAlert", () => {
  it("appends, newest last", () => {
    expect(addMutedAlert(["task:a"], "task:b")).toEqual(["task:a", "task:b"]);
  });

  it("is idempotent, and re-muting moves the id to the end", () => {
    expect(addMutedAlert(["task:a", "task:b"], "task:a")).toEqual(["task:b", "task:a"]);
  });

  it("keeps the list bounded, dropping the oldest mute", () => {
    const full = Array.from({ length: MAX_MUTED_ALERTS }, (_, i) => `task:${i}`);
    const next = addMutedAlert(full, "task:new");
    expect(next).toHaveLength(MAX_MUTED_ALERTS);
    expect(next[next.length - 1]).toBe("task:new");
    expect(next).not.toContain("task:0");
  });
});

describe("alertCounts", () => {
  it("counts every severity, including the empty ones", () => {
    const items = selectAlerts({
      now: NOW,
      events: [
        ev({ id: "imminent", start: "2026-07-08T09:30" }),
        ev({ id: "tomorrow", start: "2026-07-09T08:00" }),
      ],
      tasks: [task({ id: "late", due: "2026-07-01" }), task({ id: "late2", due: "2026-07-02" })],
    });
    expect(alertCounts(items)).toEqual({ overdue: 2, now: 1, soon: 1, upcoming: 0 });
  });

  it("is all zeroes for no rows", () => {
    expect(alertCounts([])).toEqual({ overdue: 0, now: 0, soon: 0, upcoming: 0 });
  });

  it("describes the capped list, not the one behind it", () => {
    const tasks = [
      task({ id: "late", due: "2026-07-01" }),
      task({ id: "later", due: "2026-07-11T09:00" }),
    ];
    expect(alertCounts(selectAlerts({ now: NOW, tasks, limit: 1 })))
      .toEqual({ overdue: 1, now: 0, soon: 0, upcoming: 0 });
  });
});

/**
 * The gates. The one asymmetry worth locking: `files_alerts` is the *file
 * viewer's* group visibility, so Tabtivity Mobile — a surface with its own screen
 * and no 🔔 of its own — reads past it, while everything that says which alerts
 * exist stays shared between the two.
 */
describe("alertGates", () => {
  const ALL_ON = { visible: true, mail: true, events: true, tasks: true, mailClient: true };

  it("is every source when the group is on", () => {
    expect(alertGates(ALL_ON)).toEqual({
      wantMail: true,
      wantEvents: true,
      wantTasks: true,
      enabled: true,
    });
  });

  it("closes every source when the group is off", () => {
    expect(alertGates({ ...ALL_ON, visible: false })).toEqual({
      wantMail: false,
      wantEvents: false,
      wantTasks: false,
      enabled: false,
    });
  });

  it("keeps the phone's sources open across a closed desktop group", () => {
    expect(alertGates({ ...ALL_ON, visible: false, ignoreVisible: true })).toEqual({
      wantMail: true,
      wantEvents: true,
      wantTasks: true,
      enabled: true,
    });
  });

  it("still obeys the source switches when visibility is skipped", () => {
    expect(alertGates({ ...ALL_ON, visible: false, ignoreVisible: true, mail: false })).toMatchObject({
      wantMail: false,
      wantEvents: true,
      enabled: true,
    });
    expect(
      alertGates({
        ...ALL_ON,
        visible: false,
        ignoreVisible: true,
        mail: false,
        events: false,
        tasks: false,
      }).enabled,
    ).toBe(false);
  });

  it("keeps mail behind the mail_client gate on both surfaces", () => {
    expect(alertGates({ ...ALL_ON, mailClient: false }).wantMail).toBe(false);
    expect(alertGates({ ...ALL_ON, visible: false, ignoreVisible: true, mailClient: false }).wantMail)
      .toBe(false);
  });
});
