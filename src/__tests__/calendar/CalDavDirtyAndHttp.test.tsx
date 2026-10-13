/**
 * Threat recheck gaps 32 and 26/E2b, the window's half.
 *
 * Gap 32 — **a failed CalDAV push must not lose the local edit.** The row
 * carries `caldav_dirty` from its local write until a push the server accepted;
 * a sync pushes such rows before it fetches; the merge keeps them (Rust-tested)
 * and hands back the ones the server changed or deleted, which become questions
 * in the conflict dialog; "Use the server's" drops the mark in the same write.
 *
 * E2b — **plain `http://` CalDAV is refused**: the dialog will not save or
 * search one and says why; an existing http account is never synced, says so,
 * and its calendars turn read-only.
 *
 * The transport is mocked at the invoke boundary, like `CalDavPushGate`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { installCalDavPush, useCalDavStore } from "../../stores/calendar/caldav";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { CalDavAccountDialog } from "../../components/calendar/CalDavAccountDialog";
import { CalDavConflictDialog } from "../../components/calendar/CalDavConflictDialog";
import { caldavErrorText, CALDAV_HTTP_REFUSED, isHttpBaseUrl } from "../../lib/calendar/caldav";
import { friendlyError } from "../../lib/errors";
import { translate } from "../../lib/i18n";
import type { Calendar, CalendarEvent, CalendarTask } from "../../types";
import type { CalDavAccount } from "../../types/caldav";

const HREF = "https://dav.example.org/dav/me/personal/";
const RESOURCE = `${HREF}e1.ics`;
const en = (key: Parameters<typeof translate>[1]) => translate("en", key);

function account(over: Partial<CalDavAccount> = {}): CalDavAccount {
  return {
    id: "acc-1",
    label: "Work",
    base_url: "https://dav.example.org/dav/",
    user: "me",
    save_password: false,
    allow_write: true,
    calendars: [{ href: HREF, calendar_id: "cal-1", display_name: "Personal", ctag: "c1", read_only: false }],
    ...over,
  };
}

const CAL: Calendar = { id: "cal-1", name: "Personal", color: "#36c", visible: true, readonly: false };

const ROW: CalendarEvent = {
  id: "e1",
  calendar_id: "cal-1",
  start: "2026-08-03T09:00",
  end: "2026-08-03T10:00",
  all_day: false,
  title: "standup",
  caldav_href: RESOURCE,
  caldav_etag: '"7"',
  rev: 4,
};

function seed(acc: CalDavAccount, events: CalendarEvent[] = [ROW], tasks: CalendarTask[] = []) {
  useCalDavStore.setState({
    accounts: [acc],
    loaded: true,
    conflicts: [],
    deferred: [],
    pushError: "",
    status: {},
  });
  useCalendarStore.setState({ events, tasks, calendars: [CAL], loaded: true });
}

/** A backend whose fetch finds nothing changed unless told otherwise. */
function backend(over: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (over[cmd]) return over[cmd](args);
    switch (cmd) {
      case "caldav_push":
        return { href: RESOURCE, etag: '"8"', conflict: false, gone: false, dirty: false };
      case "caldav_fetch":
        return { resources: [], removed: [], ctag: "c2", incremental: false, unchanged: false };
      case "caldav_apply":
        return {
          calendars: [CAL],
          events: useCalendarStore.getState().events,
          tasks: useCalendarStore.getState().tasks,
          caldav_kept: [],
        };
      case "caldav_accounts_list":
        return useCalDavStore.getState().accounts;
      case "update_calendar":
        return args.calendar;
      default:
        return null;
    }
  });
}

const commands = () => invoke.mock.calls.map((c) => c[0] as string);

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

describe("a failed push keeps the edit (gap 32)", () => {
  it("leaves the row marked, and says why", async () => {
    seed(account());
    backend({
      caldav_push: () => {
        throw "could not reach dav.example.org: error sending request";
      },
    });
    const out = await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW });
    expect(out).toBe("error");
    expect(useCalendarStore.getState().events[0].caldav_dirty).toBe(true);
    expect(useCalendarStore.getState().events[0].title).toBe("standup");
    expect(useCalDavStore.getState().pushError).toContain("could not reach");
  });

  it("sends the revision it serialized, and keeps the mark the backend says is still owed", async () => {
    seed(account(), [{ ...ROW, caldav_dirty: true }]);
    backend({ caldav_push: () => ({ href: RESOURCE, etag: '"8"', conflict: false, gone: false, dirty: true }) });
    await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: { ...ROW, caldav_dirty: true } });
    const [, args] = invoke.mock.calls.find((c) => c[0] === "caldav_push") as [string, Record<string, unknown>];
    expect(args.rev).toBe(4);
    expect(useCalendarStore.getState().events[0].caldav_dirty).toBe(true);
  });

  it("clears the mark once the server took the edit", async () => {
    seed(account(), [{ ...ROW, caldav_dirty: true }]);
    backend();
    await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: { ...ROW, caldav_dirty: true } });
    const row = useCalendarStore.getState().events[0];
    expect(row.caldav_dirty).toBeFalsy();
    expect(row.caldav_etag).toBe('"8"');
  });

  it("gives the resource's other rows the new ETag, so their own push is no conflict", async () => {
    // A series' override row rides in the same body; left on the old ETag, its
    // next push would be a 412 against this machine's own write.
    const override = { ...ROW, id: "e2", recurrence_id: "2026-08-10T09:00", caldav_dirty: true };
    const elsewhere = { ...ROW, id: "e3", calendar_id: "cal-2" };
    seed(account(), [{ ...ROW, caldav_dirty: true }, override, elsewhere]);
    backend();
    await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: { ...ROW, caldav_dirty: true } });
    const rows = useCalendarStore.getState().events;
    expect(rows.find((e) => e.id === "e2")?.caldav_etag).toBe('"8"');
    expect(rows.find((e) => e.id === "e2")?.caldav_dirty).toBe(true);
    expect(rows.find((e) => e.id === "e3")?.caldav_etag).toBe('"7"');
  });

  it("marks the row in the same local write when its calendar pushes", async () => {
    seed(account());
    const uninstall = installCalDavPush();
    try {
      backend({ update_event: (a) => a.event, caldav_push: () => ({ href: RESOURCE, etag: '"8"', conflict: false, gone: false }) });
      await useCalendarStore.getState().updateEvent({ ...ROW, title: "moved" });
      const [, args] = invoke.mock.calls.find((c) => c[0] === "update_event") as [string, { event: CalendarEvent }];
      expect(args.event.caldav_dirty).toBe(true);

      // A calendar push is off for: no mark, no push.
      invoke.mockClear();
      useCalDavStore.setState({ accounts: [account({ allow_write: false })] });
      await useCalendarStore.getState().updateEvent({ ...ROW, title: "again" });
      const [, off] = invoke.mock.calls.find((c) => c[0] === "update_event") as [string, { event: CalendarEvent }];
      expect(off.event.caldav_dirty).toBeUndefined();
      expect(commands()).not.toContain("caldav_push");
    } finally {
      uninstall();
    }
  });
});

describe("a sync pushes unpushed edits first (gap 32)", () => {
  it("pushes a dirty row before it fetches, conditional on its stored ETag", async () => {
    seed(account(), [{ ...ROW, caldav_dirty: true }]);
    backend();
    await useCalDavStore.getState().syncCalendar("acc-1", HREF, false);
    const order = commands();
    expect(order.indexOf("caldav_push")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("caldav_push")).toBeLessThan(order.indexOf("caldav_fetch"));
    const [, args] = invoke.mock.calls.find((c) => c[0] === "caldav_push") as [string, Record<string, unknown>];
    expect(args.etag).toBe('"7"');
    expect(args.resourceHref).toBe(RESOURCE);
  });

  it("pushes nothing clean, deferred, already in question, or for a read-only account", async () => {
    const clean = { ...ROW, id: "c", caldav_href: `${HREF}c.ics` };
    const later = { ...ROW, id: "d", caldav_href: `${HREF}d.ics`, caldav_dirty: true };
    seed(account(), [clean, later]);
    useCalDavStore.setState({ deferred: ["d"] });
    backend();
    await useCalDavStore.getState().syncCalendar("acc-1", HREF, false);
    expect(commands()).not.toContain("caldav_push");

    seed(account({ allow_write: false }), [{ ...ROW, caldav_dirty: true }]);
    invoke.mockClear();
    await useCalDavStore.getState().syncCalendar("acc-1", HREF, false);
    expect(commands()).not.toContain("caldav_push");
  });

  it("turns a push conflict into a question and the row stays marked", async () => {
    seed(account(), [{ ...ROW, caldav_dirty: true }]);
    backend({ caldav_push: () => ({ href: RESOURCE, etag: "", conflict: true, gone: false }) });
    await useCalDavStore.getState().syncCalendar("acc-1", HREF, false);
    expect(useCalDavStore.getState().conflicts.map((c) => c.rowId)).toEqual(["e1"]);
    expect(useCalendarStore.getState().events[0].caldav_dirty).toBe(true);
  });
});

describe("what the merge kept becomes a question (gap 32)", () => {
  it("asks about a server change and a server delete, and not about a deferred row", async () => {
    seed(account(), [{ ...ROW, caldav_dirty: true }]);
    useCalDavStore.setState({ deferred: ["t9"] });
    backend({
      caldav_push: () => {
        throw "offline";
      },
      caldav_apply: () => ({
        calendars: [CAL],
        events: useCalendarStore.getState().events,
        tasks: [],
        caldav_kept: [
          { row_id: "e1", kind: "event", href: RESOURCE, title: "standup", reason: "changed" },
          { row_id: "e2", kind: "event", href: `${HREF}e2.ics`, title: "lunch", reason: "deleted" },
          { row_id: "t9", kind: "task", href: `${HREF}t9.ics`, title: "later", reason: "changed" },
        ],
      }),
    });
    await useCalDavStore.getState().syncCalendar("acc-1", HREF, false);
    const conflicts = useCalDavStore.getState().conflicts;
    expect(conflicts.map((c) => [c.rowId, c.op, !!c.serverDeleted])).toEqual([
      ["e1", "upsert", false],
      ["e2", "upsert", true],
    ]);
    expect(conflicts[1].resourceHref).toBe(`${HREF}e2.ics`);
  });

  it("re-asks a server-deleted row on the next sync instead of pushing it back", async () => {
    const local = { ...ROW, caldav_href: undefined, caldav_etag: undefined, caldav_dirty: true, caldav_server_deleted: RESOURCE };
    seed(account(), [local]);
    backend();
    await useCalDavStore.getState().syncCalendar("acc-1", HREF, false);
    expect(commands()).not.toContain("caldav_push");
    const [q] = useCalDavStore.getState().conflicts;
    expect(q.serverDeleted).toBe(true);
    expect(q.resourceHref).toBe(RESOURCE);
  });

  it("'Use the server's' drops the mark in the same write and reads the whole collection", async () => {
    seed(account(), [{ ...ROW, caldav_dirty: true }]);
    const conflict = {
      rowId: "e1",
      kind: "event" as const,
      accountId: "acc-1",
      href: HREF,
      resourceHref: RESOURCE,
      title: "standup",
      op: "upsert" as const,
      at: "2026-08-03T09:00",
    };
    useCalDavStore.setState({ conflicts: [conflict] });
    backend();
    await useCalDavStore.getState().resolveTakeServer(conflict);
    expect(commands()).not.toContain("caldav_push");
    const fetch = invoke.mock.calls.find((c) => c[0] === "caldav_fetch")![1] as Record<string, unknown>;
    expect(fetch.full).toBe(true);
    const apply = invoke.mock.calls.find((c) => c[0] === "caldav_apply")![1] as Record<string, unknown>;
    expect(apply.discard).toEqual(["e1"]);
    expect(useCalDavStore.getState().conflicts).toHaveLength(0);
  });

  it("'Keep mine' on a server-deleted row puts it back as a create", async () => {
    const local = { ...ROW, caldav_href: undefined, caldav_etag: undefined, caldav_dirty: true, caldav_server_deleted: RESOURCE };
    seed(account(), [local]);
    const conflict = {
      rowId: "e1",
      kind: "event" as const,
      accountId: "acc-1",
      href: HREF,
      resourceHref: RESOURCE,
      title: "standup",
      op: "upsert" as const,
      serverDeleted: true,
      at: "2026-08-03T09:00",
    };
    useCalDavStore.setState({ conflicts: [conflict] });
    backend();
    await useCalDavStore.getState().resolveKeepMine(conflict);
    expect(commands()).not.toContain("caldav_resource_etag");
    const push = invoke.mock.calls.find((c) => c[0] === "caldav_push")![1] as Record<string, unknown>;
    expect(push.resourceHref).toBeNull();
    expect(push.etag).toBeNull();
    expect(useCalDavStore.getState().conflicts).toHaveLength(0);
  });

  it("'Decide later' keeps the edit and stops this session's syncs from asking", async () => {
    const conflict = {
      rowId: "e1",
      kind: "event" as const,
      accountId: "acc-1",
      href: HREF,
      resourceHref: RESOURCE,
      title: "standup",
      op: "upsert" as const,
      serverDeleted: true,
      at: "2026-08-03T09:00",
    };
    seed(account(), [{ ...ROW, caldav_dirty: true }]);
    useCalDavStore.setState({ conflicts: [conflict] });
    render(<CalDavConflictDialog />);
    expect(screen.getByText(/was deleted on the server/)).toBeTruthy();
    fireEvent.click(screen.getByText(en("caldavConflict.later")));
    expect(useCalDavStore.getState().conflicts).toHaveLength(0);
    expect(useCalDavStore.getState().deferred).toEqual(["e1"]);
    expect(useCalendarStore.getState().events[0].caldav_dirty).toBe(true);
  });
});

describe("plain http:// CalDAV is refused (E2b)", () => {
  it("an existing http account is never synced, says why, and turns read-only", async () => {
    const acc = account({ base_url: "http://dav.example.org/dav/" });
    seed(acc, [{ ...ROW, caldav_dirty: true }]);
    backend();
    const status = await useCalDavStore.getState().syncCalendar("acc-1", HREF, true);
    expect(status.phase).toBe("error");
    expect(status.error).toContain(CALDAV_HTTP_REFUSED);
    expect(commands()).not.toContain("caldav_fetch");
    expect(commands()).not.toContain("caldav_push");
    const updated = invoke.mock.calls.find((c) => c[0] === "update_calendar")![1] as { calendar: Calendar };
    expect(updated.calendar.readonly).toBe(true);
    expect(caldavErrorText(status.error, en)).toBe(en("caldav.httpRefused"));
  });

  it("an edit in an http account's calendar is not sent and not marked", async () => {
    seed(account({ base_url: "http://dav.example.org/dav/" }));
    backend();
    const out = await useCalDavStore.getState().pushRow({ op: "upsert", kind: "event", row: ROW });
    expect(out).toBe("skipped");
    expect(commands()).not.toContain("caldav_push");
    expect(useCalendarStore.getState().events[0].caldav_dirty).toBeUndefined();
  });

  it("the account dialog says why and will neither search nor save", () => {
    seed(account());
    render(
      <CalDavAccountDialog
        account={account({ base_url: "http://localhost:5232/" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("http://");
    expect((screen.getByText(en("common.save")) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(en("caldav.discover")) as HTMLButtonElement).disabled).toBe(true);
    expect(commands()).not.toContain("caldav_account_upsert");
  });

  it("an https or bare-host URL is not refused", () => {
    expect(isHttpBaseUrl("https://dav.example.org/")).toBe(false);
    expect(isHttpBaseUrl("dav.example.org")).toBe(false);
    expect(isHttpBaseUrl("  HTTP://dav.example.org/")).toBe(true);
  });

  it("a backend refusal reads as the translated reason wherever errors are shown", () => {
    const raw = `${CALDAV_HTTP_REFUSED}: CalDAV needs https:// (dav.example.org)`;
    expect(friendlyError(raw, (k) => translate("en", k))?.summary).toBe(en("caldav.httpRefused"));
    expect(caldavErrorText("timed out", en)).toBe("timed out");
  });
});

describe("'Keep mine' on a row with no resource address (step 7 review)", () => {
  const MINTED = `${HREF}n-uid.ics`;
  const NEW: CalendarEvent = {
    id: "n1",
    calendar_id: "cal-1",
    uid: "n-uid",
    start: "2026-08-04T09:00",
    end: "2026-08-04T10:00",
    all_day: false,
    title: "planning (mine)",
    caldav_dirty: true,
    rev: 2,
  };
  const question = (over: Partial<Parameters<ReturnType<typeof useCalDavStore.getState>["resolveKeepMine"]>[0]> = {}) => ({
    rowId: "n1",
    kind: "event" as const,
    accountId: "acc-1",
    href: HREF,
    resourceHref: "",
    title: "planning (mine)",
    op: "upsert" as const,
    at: "2026-08-04T09:00",
    ...over,
  });
  const pushArgs = () =>
    invoke.mock.calls.filter((c) => c[0] === "caldav_push").map((c) => c[1] as Record<string, unknown>);

  it("a lost-reply create overwrites its own server copy and drops the imported duplicate", async () => {
    // The create landed but its reply was lost; the retry met it (`412`), and
    // the sync imports the server's copy as a second row under the same UID.
    const dup: CalendarEvent = { ...NEW, id: "n2", title: "planning", caldav_dirty: undefined, caldav_href: MINTED, caldav_etag: '"3"' };
    seed(account(), [NEW]);
    const conflict = question();
    useCalDavStore.setState({ conflicts: [conflict] });
    backend({
      caldav_apply: () => ({ calendars: [CAL], events: [NEW, dup], tasks: [], caldav_kept: [] }),
      caldav_resource_etag: (args) => {
        expect(args.resourceHref).toBe(MINTED);
        return '"3"';
      },
      caldav_push: () => ({ href: MINTED, etag: '"4"', conflict: false, gone: false, dirty: false }),
    });
    await useCalDavStore.getState().resolveKeepMine(conflict);

    const pushes = pushArgs();
    expect(pushes).toHaveLength(1); // the sync's dirty pass skipped the open question
    expect(pushes[0].resourceHref).toBe(MINTED);
    expect(pushes[0].etag).toBe('"3"');
    expect(String(pushes[0].ics).match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(String(pushes[0].ics)).toContain("planning (mine)");
    expect(invoke.mock.calls.filter((c) => c[0] === "delete_event").map((c) => c[1])).toEqual([{ id: "n2" }]);
    expect(commands()).not.toContain("caldav_delete");
    const rows = useCalendarStore.getState().events;
    expect(rows.map((e) => e.id)).toEqual(["n1"]);
    expect(rows[0].caldav_href).toBe(MINTED);
    expect(useCalDavStore.getState().conflicts).toHaveLength(0);
    expect(useCalDavStore.getState().pushError).toBe("");
  });

  it("a series row the server deleted joins the resource its master was put back into", async () => {
    const S = `${HREF}s-uid.ics`;
    const master: CalendarEvent = { ...NEW, id: "m", uid: "s-uid", title: "series", caldav_dirty: undefined, caldav_href: S, caldav_etag: '"5"' };
    const over: CalendarEvent = {
      ...NEW,
      id: "o",
      uid: "s-uid",
      title: "moved occurrence",
      recurrence_id: "2026-08-11T09:00",
      caldav_server_deleted: S,
    };
    seed(account(), [master, over]);
    const conflict = question({ rowId: "o", resourceHref: S, serverDeleted: true, title: "moved occurrence" });
    useCalDavStore.setState({ conflicts: [conflict] });
    backend({
      caldav_resource_etag: () => '"5"',
      caldav_push: () => ({ href: S, etag: '"6"', conflict: false, gone: false, dirty: false }),
    });
    await useCalDavStore.getState().resolveKeepMine(conflict);

    expect(commands()).not.toContain("caldav_fetch");
    const [push] = pushArgs();
    expect(push.resourceHref).toBe(S);
    expect(push.etag).toBe('"5"');
    const ics = String(push.ics);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("RECURRENCE-ID");
    expect(commands()).not.toContain("delete_event");
    const rows = useCalendarStore.getState().events;
    expect(rows.find((e) => e.id === "o")?.caldav_href).toBe(S);
    expect(rows.find((e) => e.id === "m")?.caldav_etag).toBe('"6"');
    expect(useCalDavStore.getState().conflicts).toHaveLength(0);
  });

  it("with nothing of the object on the server it is created again", async () => {
    seed(account(), [NEW]);
    const conflict = question();
    useCalDavStore.setState({ conflicts: [conflict] });
    backend();
    await useCalDavStore.getState().resolveKeepMine(conflict);
    expect(commands()).not.toContain("caldav_resource_etag");
    const [push] = pushArgs();
    expect(push.resourceHref).toBeNull();
    expect(push.etag).toBeNull();
  });

  it("a push that conflicts again keeps the question and puts the duplicate back", async () => {
    const dup: CalendarEvent = { ...NEW, id: "n2", title: "planning", caldav_dirty: undefined, caldav_href: MINTED, caldav_etag: '"3"' };
    seed(account(), [NEW, dup]);
    const conflict = question();
    useCalDavStore.setState({ conflicts: [conflict] });
    backend({
      caldav_resource_etag: () => '"3"',
      caldav_push: () => ({ href: MINTED, etag: "", conflict: true, gone: false, dirty: true }),
    });
    await useCalDavStore.getState().resolveKeepMine(conflict);
    expect(commands()).not.toContain("delete_event");
    const rows = useCalendarStore.getState().events;
    expect(rows.map((e) => e.id).sort()).toEqual(["n1", "n2"]);
    expect(rows.find((e) => e.id === "n1")?.caldav_href).toBeUndefined();
    expect(useCalDavStore.getState().conflicts.map((c) => c.rowId)).toEqual(["n1"]);
  });
});

describe("an account switched from http to https (step 7 review)", () => {
  it("re-reads the calendar when the backend moved its addresses to https", async () => {
    const httpRef = "http://dav.example.org/dav/me/personal/";
    const acc = account({ base_url: "http://dav.example.org/dav/", calendars: [{ ...account().calendars[0], href: httpRef }] });
    seed(acc, [{ ...ROW, caldav_href: `${httpRef}e1.ics` }]);
    const moved = { ...acc, base_url: "https://dav.example.org/dav/", calendars: [{ ...acc.calendars[0], href: HREF }] };
    backend({
      caldav_account_upsert: () => ({ account: moved, saved: false }),
      calendar_load: () => ({ calendars: [CAL], events: [ROW], tasks: [], task_columns: [] }),
    });
    await useCalDavStore.getState().upsert({ ...acc, base_url: "https://dav.example.org/dav/" }, null, null);
    expect(commands()).toContain("calendar_load");
    expect(useCalendarStore.getState().events[0].caldav_href).toBe(RESOURCE);
    expect(useCalDavStore.getState().accounts[0].calendars[0].href).toBe(HREF);
  });

  it("does not re-read it for an ordinary save", async () => {
    seed(account());
    backend({ caldav_account_upsert: (args) => ({ account: args.account, saved: false }) });
    await useCalDavStore.getState().upsert(account({ label: "Renamed" }), null, null);
    expect(commands()).not.toContain("calendar_load");
  });
});
