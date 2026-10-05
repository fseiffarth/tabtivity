/**
 * The gate in front of every CalDAV write (`docs/caldav_plan.md` Phase 3).
 *
 * `pushRow` is where a local edit becomes a request to somebody's server, and
 * the four things it must never do are the four things tested here:
 *
 *  1. push a row on a calendar no CalDAV account feeds;
 *  2. push for an account whose owner has not turned two-way sync on;
 *  3. push to a collection the server reports as read-only for this login;
 *  4. let a **refused delete** through as if it had succeeded — the one case
 *     where "carry on locally" means the appointment is gone here and still
 *     there for everyone else.
 *
 * The transport is mocked at the invoke boundary, which is the honest line: what
 * is under test is the decision, and the protocol below it is Rust's and
 * fixture-tested there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { CALDAV_CONFLICT_ERROR, isCalDavConflict, useCalDavStore } from "../../stores/calendar/caldav";
import { useCalendarStore } from "../../stores/calendar/calendar";
import type { CalendarEvent } from "../../types";
import type { CalDavAccount } from "../../types/caldav";
import { PINNED_ICS_UID_DOMAIN } from "../../lib/brand";

const HREF = "https://dav.example.org/dav/me/personal/";
const RESOURCE = "https://dav.example.org/dav/me/personal/e1.ics";

function account(over: Partial<CalDavAccount> = {}): CalDavAccount {
  return {
    id: "acc-1",
    label: "Work",
    base_url: "https://dav.example.org/dav/",
    user: "me",
    save_password: false,
    allow_write: true,
    calendars: [
      {
        href: HREF,
        calendar_id: "cal-1",
        display_name: "Personal",
        ctag: "c1",
        read_only: false,
      },
    ],
    ...over,
  };
}

const ROW: CalendarEvent = {
  id: "e1",
  calendar_id: "cal-1",
  start: "2026-08-03T09:00",
  end: "2026-08-03T10:00",
  all_day: false,
  title: "standup",
  caldav_href: RESOURCE,
  caldav_etag: '"7"',
};

function seed(acc: CalDavAccount, row: CalendarEvent = ROW) {
  useCalDavStore.setState({ accounts: [acc], loaded: true, conflicts: [], pushError: "" });
  useCalendarStore.setState({ events: [row], tasks: [], calendars: [], loaded: true });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ href: RESOURCE, etag: '"8"', conflict: false, gone: false });
});

describe("what never reaches the network", () => {
  it("a row on a calendar no account feeds", async () => {
    seed(account(), { ...ROW, calendar_id: "cal-local" });
    const out = await useCalDavStore
      .getState()
      .pushRow({ op: "upsert", kind: "event", row: { ...ROW, calendar_id: "cal-local" } });
    expect(out).toBe("skipped");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("an account whose owner has not opted into two-way sync", async () => {
    // The plan's open question, answered by asking. Default off means the
    // read-only behaviour Phases 1-2 shipped is what an untouched account does.
    seed(account({ allow_write: false }));
    expect(await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW })).toBe(
      "skipped",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a collection the server reports as read-only for this login", async () => {
    const acc = account();
    acc.calendars[0].read_only = true;
    seed(acc);
    expect(await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW })).toBe(
      "skipped",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a delete of a row the server never heard of", async () => {
    seed(account(), { ...ROW, caldav_href: "", caldav_etag: "" });
    const out = await useCalDavStore.getState().pushRow({
      op: "delete",
      kind: "event",
      row: { ...ROW, caldav_href: "", caldav_etag: "" },
    });
    expect(out).toBe("skipped");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("a push that goes through", () => {
  it("sends the resource conditionally and records the new validator", async () => {
    seed(account());
    const out = await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW });
    expect(out).toBe("pushed");

    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("caldav_push");
    expect(args.resourceHref).toBe(RESOURCE);
    expect(args.etag).toBe('"7"');
    expect(String(args.ics)).toContain("SUMMARY:standup");

    // The ETag this write earned, so the *next* edit is conditional on it and
    // not on the one it replaced.
    expect(useCalendarStore.getState().events[0].caldav_etag).toBe('"8"');
  });

  it("creates with no href and no etag for a row the server has never seen", async () => {
    seed(account(), { ...ROW, caldav_href: "", caldav_etag: "" });
    await useCalDavStore.getState().pushRow({
      op: "upsert",
      kind: "event",
      row: { ...ROW, caldav_href: "", caldav_etag: "" },
    });
    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.resourceHref).toBeNull();
    expect(args.etag).toBeNull();
    // The UID domain is pinned: it does not follow the app's name.
    expect(args.uid).toBe(`e1@${PINNED_ICS_UID_DOMAIN}`);
  });
});

describe("a conflict", () => {
  it("is a question, not a rejection, when it happens on an edit", async () => {
    invoke.mockResolvedValue({ href: RESOURCE, etag: "", conflict: true, gone: false });
    seed(account());
    const out = await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW });
    expect(out).toBe("conflict");

    const [pending] = useCalDavStore.getState().conflicts;
    expect(pending.rowId).toBe("e1");
    expect(pending.op).toBe("upsert");
    expect(pending.title).toBe("standup");
  });

  it("does not stack a second question for the same row", async () => {
    invoke.mockResolvedValue({ href: RESOURCE, etag: "", conflict: true, gone: false });
    seed(account());
    await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW });
    await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW });
    expect(useCalDavStore.getState().conflicts).toHaveLength(1);
  });

  it("**stops** the local delete when it happens on a deletion", async () => {
    // The asymmetry the whole ordering exists for: carrying on here would leave
    // the appointment gone on this machine and still there for everyone else.
    invoke.mockResolvedValue({ href: RESOURCE, etag: "", conflict: true, gone: false });
    seed(account());
    await expect(
      useCalDavStore.getState().pushRow({ op: "delete", kind: "event", row: ROW }),
    ).rejects.toThrow(CALDAV_CONFLICT_ERROR);
    expect(useCalDavStore.getState().conflicts).toHaveLength(1);
  });

  it("is distinguishable from an ordinary failure by its callers", async () => {
    expect(isCalDavConflict(new Error(CALDAV_CONFLICT_ERROR))).toBe(true);
    expect(isCalDavConflict(new Error("could not reach the server"))).toBe(false);
    expect(isCalDavConflict("nope")).toBe(false);
  });
});

describe("a failure that is not a conflict", () => {
  it("is remembered, and an edit is not rolled back over it", async () => {
    // The row is already written locally; an unreachable server is a reason to
    // report, not to undo an edit the user made.
    invoke.mockRejectedValue("the server refused (403)");
    seed(account());
    const out = await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW });
    expect(out).toBe("error");
    expect(useCalDavStore.getState().pushError).toContain("403");
    expect(useCalendarStore.getState().events).toHaveLength(1);
  });

  it("still stops a delete", async () => {
    invoke.mockRejectedValue("the server refused (403)");
    seed(account());
    await expect(
      useCalDavStore.getState().pushRow({ op: "delete", kind: "event", row: ROW }),
    ).rejects.toThrow("403");
  });
});

describe("keeping mine on a refused delete", () => {
  function refusedDelete() {
    return {
      rowId: "e1",
      kind: "event" as const,
      accountId: "acc-1",
      href: HREF,
      resourceHref: RESOURCE,
      title: "standup",
      op: "delete" as const,
      at: "2026-08-03T09:00",
    };
  }

  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "caldav_resource_etag" ? '"9"' : { href: RESOURCE, etag: "", conflict: false, gone: true },
    );
  });

  it("deletes the row once the server's copy is gone", async () => {
    seed(account());
    useCalDavStore.setState({ conflicts: [refusedDelete()] });
    await useCalDavStore.getState().resolveKeepMine(refusedDelete());
    expect(useCalendarStore.getState().events).toHaveLength(0);
    expect(useCalDavStore.getState().conflicts).toHaveLength(0);
  });

  it("removes only the copy a calendar move left behind, never the moved row", async () => {
    // A root agent's `calendar_move_events` keeps the row's id and drops its
    // old address, then deletes that address on the server. A conflict on the
    // delete is about the copy — the event itself now lives in another calendar.
    const moved = { ...ROW, calendar_id: "cal-2", caldav_href: undefined, caldav_etag: undefined };
    seed(account(), moved);
    useCalDavStore.setState({ conflicts: [refusedDelete()] });
    await useCalDavStore.getState().resolveKeepMine(refusedDelete());

    expect(invoke).toHaveBeenCalledWith("caldav_delete", {
      accountId: "acc-1",
      href: HREF,
      resourceHref: RESOURCE,
      etag: '"9"',
    });
    const [row] = useCalendarStore.getState().events;
    expect(row).toEqual(moved);
    expect(useCalDavStore.getState().conflicts).toHaveLength(0);
  });
});
