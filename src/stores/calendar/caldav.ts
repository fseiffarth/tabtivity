import { create } from "zustand";
import {
  caldavAccountDelete,
  caldavAccountUpsert,
  caldavAccountsList,
  caldavApply,
  caldavDelete,
  caldavFetch,
  caldavPush,
  caldavRefreshAccess,
  caldavResourceEtag,
  CALDAV_HTTP_REFUSED,
  isHttpBaseUrl,
  parseChanges,
  syncStamp,
} from "../../lib/calendar/caldav";
import { resourceIcs, resourceRows, resourceUid } from "../../lib/calendar/caldavPush";
import {
  setCalendarDirtyPredicate,
  setCalendarWriteHandler,
} from "../../lib/calendar/calendarWriteHook";
import type { CalendarWriteEvent } from "../../lib/calendar/calendarWriteHook";
import { useCalendarStore } from "./calendar";
import type { CalendarEvent, CalendarTask } from "../../types";
import type {
  CalDavAccount,
  CalDavAccountSaved,
  CalDavCollection,
  CalDavKept,
} from "../../types/caldav";

/**
 * CalDAV accounts, and the sync that keeps their calendars current.
 *
 * Deliberately a **second** store next to `stores/calendar/calendar`, mirroring the
 * backend's own split: an account carries a login, a per-collection cursor and
 * a keychain credential, none of which is calendar-display state. What a sync
 * *produces* lands in the calendar store, where every existing surface already
 * reads it — this store never renders an event.
 *
 * The two rules a scheduled sync lives or dies by:
 *
 *  1. **A sync is not a replace.** `syncCalendar` hands the parsed rows to
 *     `caldav_apply`, which merges them by `caldav_href` and leaves the to-do
 *     board's column/rank/tags alone. Routing this through
 *     `calendar_replace_events` would evict every CalDAV-sourced card from
 *     wherever the user dragged it, every time the timer fires.
 *  2. **A failure is visible.** `status` keeps the last outcome per collection,
 *     and an account whose password was never saved (or whose keyring is
 *     locked) fails every unattended sync after a relaunch — exactly as mail's
 *     does. A quietly stale calendar is worse than a visible error, because it
 *     looks exactly like a calendar with nothing new in it.
 */

export type CalDavPhase = "idle" | "syncing" | "ok" | "error";

export interface CalDavSyncStatus {
  phase: CalDavPhase;
  /** Verbatim from the backend. Empty unless `phase === "error"`. */
  error: string;
  /** Local stamp of the last *successful* sync. */
  at: string;
  /** The last sync found nothing to do (the ctag had not moved). */
  unchanged: boolean;
}

const IDLE: CalDavSyncStatus = { phase: "idle", error: "", at: "", unchanged: false };

/**
 * A write the server refused because the resource changed elsewhere.
 *
 * Held as a **list of pending questions**, not as a thrown error, because that is
 * what a conflict is: nobody's edit has been lost yet, and which one survives is
 * the user's call. The rule this serves is mail encryption's, verbatim — a silent
 * downgrade is the worst thing a sync feature can do, because it looks exactly
 * like success.
 */
export interface CalDavConflict {
  /** Stable per row, so a second failing push replaces the question instead of
   *  stacking a duplicate one behind it. */
  rowId: string;
  kind: "event" | "task";
  accountId: string;
  /** The collection, not the resource — what the push was addressed to. */
  href: string;
  resourceHref: string;
  /** What the user would be overwriting or discarding, for the dialog to name. */
  title: string;
  /** The write that hit the conflict: an edit, or a deletion. */
  op: "upsert" | "delete";
  /** The server deleted the resource while this row held an unpushed edit
   *  (gap 32): the row is local-only now, and "keep mine" puts it back. */
  serverDeleted?: boolean;
  /** Local stamp, so a conflict from this morning does not read as fresh. */
  at: string;
}

/** How a push ended. `conflict` is not failure — it is a question. */
export type CalDavPushOutcome = "pushed" | "skipped" | "conflict" | "error";

/**
 * The message a refused **delete** rejects with.
 *
 * A delete has to reject to stop the local one (see `pushRow`), but the caller
 * must be able to tell "the server refused, and a dialog is already asking about
 * it" from "something went wrong, say so". One exported constant and one
 * predicate rather than a string compare at each call site — this is a sentinel,
 * and a sentinel spelled twice is a sentinel that stops matching.
 */
export const CALDAV_CONFLICT_ERROR = "caldav-conflict";

/** Whether a rejection is the conflict sentinel — i.e. already explained. */
export function isCalDavConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(CALDAV_CONFLICT_ERROR);
}

interface CalDavStore {
  accounts: CalDavAccount[];
  loaded: boolean;
  /** Keyed by collection href. */
  status: Record<string, CalDavSyncStatus>;
  /** Unanswered conflicts, newest last. Empty is the normal state. */
  conflicts: CalDavConflict[];
  /** Rows whose conflict the user put off ("Decide later") this session: a
   *  sync neither pushes them again nor re-asks; their next edit does. */
  deferred: string[];
  /** The last push failure that was **not** a conflict (a 403 on a read-only
   *  collection, an unreachable server). Kept for the same reason `status` keeps
   *  sync errors: the surface that would show it inline is not open. */
  pushError: string;

  /** Load the accounts once. Touches no network. */
  load: () => Promise<void>;
  reload: () => Promise<void>;

  /**
   * Create or update an account (and apply the opt-in keychain write).
   *
   * Returns the backend's whole answer, not just the account: `saved` and
   * `save_error` are **what the keychain actually did**, and a write that
   * silently failed is how a user loses a password they think is saved.
   */
  upsert: (
    account: CalDavAccount,
    password: string | null,
    remember: boolean | null,
  ) => Promise<CalDavAccountSaved>;
  remove: (accountId: string) => Promise<void>;

  /**
   * Turn discovered collections into subscriptions: one local `Calendar` each,
   * plus the account's own record of which collection feeds it.
   */
  subscribe: (accountId: string, collections: CalDavCollection[]) => Promise<void>;
  /** Stop syncing a collection. The local calendar and its events stay. */
  unsubscribe: (accountId: string, href: string) => Promise<void>;

  /**
   * Sync one collection. `force` skips the cheap ctag check. Rows holding an
   * unpushed edit are pushed first (gap 32). `discard` names rows whose local
   * edit is given up ("Use the server's"); `full` skips the incremental report.
   */
  syncCalendar: (
    accountId: string,
    href: string,
    force: boolean,
    options?: { discard?: string[]; full?: boolean },
  ) => Promise<CalDavSyncStatus>;
  /** Sync every subscription of every account — the timer's tick. */
  syncAll: (force: boolean) => Promise<void>;

  /** The account (if any) a local calendar id is synced from. */
  accountForCalendar: (calendarId: string) => { account: CalDavAccount; href: string } | null;

  // ── Push (Phase 3) ────────────────────────────────────────────────────────

  /**
   * Send one row's whole **resource** to the server, or delete it.
   *
   * Called from the calendar store's write path via `lib/calendar/calendarWriteHook`, and
   * directly by the conflict dialog. Never throws for a conflict — that comes
   * back as an outcome and lands in `conflicts`.
   */
  pushRow: (event: CalendarWriteEvent) => Promise<CalDavPushOutcome>;
  /**
   * Push every row of one collection that holds an unpushed edit
   * (`caldav_dirty`, gap 32) — the start of each sync. Conditional on each
   * row's stored ETag like any push, so a server change meanwhile is a `412`
   * and lands in `conflicts`. Rows named in `skip`, deferred rows and rows with
   * an open question are left alone; a row the server deleted re-raises its
   * question instead.
   */
  pushDirty: (account: CalDavAccount, href: string, skip: string[]) => Promise<void>;
  /** Answer a conflict by overwriting the server's copy with this machine's. */
  resolveKeepMine: (conflict: CalDavConflict) => Promise<void>;
  /** Answer it by taking the server's copy — a forced sync of that collection,
   *  which is what puts the server's version into `calendar.json`. */
  resolveTakeServer: (conflict: CalDavConflict) => Promise<void>;
  /** Drop the question (it was answered, or its row is gone). */
  dismissConflict: (rowId: string) => void;
  /** "Decide later": drop the question and keep the local edit. The row stays
   *  marked; this session's syncs leave it alone, and its next edit asks again. */
  deferConflict: (rowId: string) => void;
  /** Re-ask the server what this login may do with a collection. */
  refreshAccess: (accountId: string, href: string) => Promise<void>;
}

/** A subscribed calendar's default color when the server offers none. */
const FALLBACK_COLOR = "#8d8fd6";

/** `#rrggbbaa` → `#rrggbb`; anything unrecognizable → the fallback. */
function calendarColor(raw: string): string {
  const value = (raw || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{8}$/i.test(value)) return value.slice(0, 7);
  return FALLBACK_COLOR;
}

/** The row's own title, for a conflict question that has to name something. */
function rowTitle(row: CalendarEvent | CalendarTask): string {
  return (row.title ?? "").trim() || "(untitled)";
}

/**
 * Whether the local `Calendar` should be marked read-only in the UI.
 *
 * **Both** gates fold into this one flag, and they have to: a calendar that is
 * editable in the grid while nothing it writes ever reaches the server is the
 * "looks exactly like success" failure this feature is not allowed to have. So
 * an account whose owner has not turned push on shows its calendars as read-only
 * — the same thing they were before Phase 3 — rather than accepting edits it will
 * quietly keep to itself.
 */
function notWritable(account: CalDavAccount, collectionReadOnly: boolean): boolean {
  // An `http://` account never syncs (decision E2b), so it takes no edits either.
  return collectionReadOnly || !account.allow_write || isHttpBaseUrl(account.base_url);
}

/** The account and collection whose sync takes this calendar's writes, if any. */
function pushTarget(
  accounts: CalDavAccount[],
  calendarId: string,
): { account: CalDavAccount; href: string } | null {
  for (const account of accounts) {
    const ref = account.calendars.find((c) => c.calendar_id === calendarId);
    if (!ref) continue;
    return notWritable(account, ref.read_only) ? null : { account, href: ref.href };
  }
  return null;
}

/** A merge's kept row, as the question the conflict dialog asks. */
function keptConflict(accountId: string, href: string, kept: CalDavKept): CalDavConflict {
  return {
    rowId: kept.row_id,
    kind: kept.kind,
    accountId,
    href,
    resourceHref: kept.href,
    title: (kept.title ?? "").trim() || "(untitled)",
    op: "upsert",
    serverDeleted: kept.reason === "deleted",
    at: syncStamp(),
  };
}

/**
 * Re-derive every linked calendar's `readonly` from the account's two gates.
 *
 * Called wherever either gate can move — the account's own opt-in, and the
 * server's answer — because the flag is a *derivation*, and a derived value that
 * is only computed once is a value that is wrong from the second time onward.
 */
async function applyWritability(account: CalDavAccount): Promise<void> {
  const calendar = useCalendarStore.getState();
  for (const ref of account.calendars) {
    const local = calendar.calendars.find((c) => c.id === ref.calendar_id);
    if (!local) continue;
    const readonly = notWritable(account, ref.read_only);
    if (local.readonly === readonly) continue;
    await calendar.updateCalendar({ ...local, readonly });
  }
}

/** Mirror a backend `caldav_dirty` mark into the in-memory row. */
function markDirty(kind: "event" | "task", rowId: string): void {
  useCalendarStore.setState((s) =>
    kind === "event"
      ? { events: s.events.map((e) => (e.id === rowId ? { ...e, caldav_dirty: true } : e)) }
      : { tasks: s.tasks.map((t) => (t.id === rowId ? { ...t, caldav_dirty: true } : t)) },
  );
}

export const useCalDavStore = create<CalDavStore>((set, get) => ({
  accounts: [],
  loaded: false,
  status: {},
  conflicts: [],
  deferred: [],
  pushError: "",

  load: async () => {
    if (get().loaded) return;
    await get().reload();
  },

  reload: async () => {
    const answer = await caldavAccountsList().catch(() => []);
    // A rejected invoke is not the only way this can arrive empty-handed: a
    // bridge that resolves with nothing (an older backend, a stubbed one) hands
    // back `null`, and storing that turns every reader's `.filter` into a
    // crash. "No accounts" is the honest reading of an answer that names none.
    set({ accounts: Array.isArray(answer) ? answer : [], loaded: true });
  },

  upsert: async (account, password, remember) => {
    const result = await caldavAccountUpsert(account, password, remember);
    set((s) => {
      const next = s.accounts.some((a) => a.id === result.account.id)
        ? s.accounts.map((a) => (a.id === result.account.id ? result.account : a))
        : [...s.accounts, result.account];
      return { accounts: next };
    });
    // Turning push on (or back off) is the moment the calendars' read-only flag
    // changes meaning, so it is re-derived here rather than left to whenever the
    // next subscribe happens to run.
    await applyWritability(result.account);
    return result;
  },

  remove: async (accountId) => {
    await caldavAccountDelete(accountId);
    set((s) => ({ accounts: s.accounts.filter((a) => a.id !== accountId) }));
  },

  subscribe: async (accountId, collections) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    const calendar = useCalendarStore.getState();

    const refs = [...account.calendars];
    for (const collection of collections) {
      if (refs.some((r) => r.href === collection.href)) continue;
      // A subscribed collection is an ordinary calendar in the sidebar — that
      // is what makes every view, the alarms, the ICS export and the to-do
      // board work with it unchanged. `readonly` because the server is
      // authoritative and there is no push path in this phase.
      const created = await calendar.createCalendar({
        name: collection.display_name || account.label || collection.href,
        color: calendarColor(collection.color),
        visible: true,
        readonly: notWritable(account, collection.read_only),
        caldav_account_id: accountId,
        caldav_href: collection.href,
      });
      refs.push({
        href: collection.href,
        calendar_id: created.id,
        display_name: collection.display_name,
        // **No ctag or sync-token is stored here.** They are cursors meaning
        // "you have already seen everything up to this point", and storing one
        // before the first fetch would make that first sync skip the entire
        // calendar it was supposed to import.
        ctag: "",
        sync_token: null,
        components: collection.components,
        // The server's own answer, kept verbatim. The account's opt-in is a
        // separate field on purpose: a collection that is read-only *to this
        // login* stays that way however the account is configured.
        read_only: collection.read_only,
        last_sync: "",
      });
    }
    await get().upsert({ ...account, calendars: refs }, null, null);
  },

  unsubscribe: async (accountId, href) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    await get().upsert(
      { ...account, calendars: account.calendars.filter((c) => c.href !== href) },
      null,
      null,
    );
    set((s) => {
      const status = { ...s.status };
      delete status[href];
      return { status };
    });
  },

  syncCalendar: async (accountId, href, force, options) => {
    set((s) => ({
      status: { ...s.status, [href]: { ...(s.status[href] ?? IDLE), phase: "syncing", error: "" } },
    }));

    const fail = (error: string): CalDavSyncStatus => {
      const previous = get().status[href] ?? IDLE;
      const next: CalDavSyncStatus = { ...previous, phase: "error", error, unchanged: false };
      set((s) => ({ status: { ...s.status, [href]: next } }));
      return next;
    };

    const account = get().accounts.find((a) => a.id === accountId);
    // An `http://` account is never synced (E2b) — nothing is sent, and the row
    // says why. Nothing deletes it; its calendars turn read-only here.
    if (account && isHttpBaseUrl(account.base_url)) {
      await applyWritability(account).catch(() => {});
      return fail(CALDAV_HTTP_REFUSED);
    }
    const discard = options?.discard ?? [];

    try {
      // Unpushed edits first (gap 32): a push that lands now is what the fetch
      // below then reads back, and one that conflicts becomes a question
      // instead of being merged over.
      if (account) await get().pushDirty(account, href, discard);

      const changes = await caldavFetch(accountId, href, force, options?.full ?? false);
      if (changes.unchanged) {
        const at = get().status[href]?.at ?? "";
        const next: CalDavSyncStatus = { phase: "ok", error: "", at, unchanged: true };
        set((s) => ({ status: { ...s.status, [href]: next } }));
        return next;
      }

      const { parsed } = parseChanges(changes);
      const data = await caldavApply({
        accountId,
        href,
        parsed,
        removed: changes.removed,
        incremental: changes.incremental,
        ctag: changes.ctag,
        syncToken: changes.sync_token ?? null,
        lastSync: syncStamp(),
        discard,
      });
      // The whole store comes back from one atomic write, so the calendar
      // surfaces see the merge as a single consistent state rather than a
      // sequence of per-row patches.
      useCalendarStore.setState({
        calendars: data.calendars,
        events: data.events,
        tasks: data.tasks,
        taskColumns: data.task_columns ?? [],
        loaded: true,
      });
      // The cursors moved on disk; keep the in-memory account in step so the
      // next tick compares against what was actually stored.
      await get().reload();
      // Rows the merge kept because they hold an unpushed edit the server
      // changed or deleted: each is a question, never a silent overwrite.
      for (const kept of data.caldav_kept ?? []) {
        if (get().deferred.includes(kept.row_id)) continue;
        const conflict = keptConflict(accountId, href, kept);
        set((s) => ({
          conflicts: [...s.conflicts.filter((c) => c.rowId !== conflict.rowId), conflict],
        }));
      }

      const next: CalDavSyncStatus = {
        phase: "ok",
        error: "",
        at: syncStamp(),
        unchanged: false,
      };
      set((s) => ({ status: { ...s.status, [href]: next } }));
      return next;
    } catch (err) {
      return fail(typeof err === "string" ? err : String(err));
    }
  },

  syncAll: async (force) => {
    for (const account of get().accounts) {
      for (const ref of account.calendars) {
        // Serial, not parallel: several collections on one account mean several
        // authenticated requests to one server, and a burst is how a client
        // ends up rate-limited by an institutional gateway.
        await get().syncCalendar(account.id, ref.href, force);
      }
    }
  },

  accountForCalendar: (calendarId) => {
    for (const account of get().accounts) {
      const ref = account.calendars.find((c) => c.calendar_id === calendarId);
      if (ref) return { account, href: ref.href };
    }
    return null;
  },

  // ── Push ──────────────────────────────────────────────────────────────────

  pushRow: async ({ op, kind, row }) => {
    const target = get().accountForCalendar(row.calendar_id);
    // Not a CalDAV calendar at all — the overwhelmingly common case, and the
    // reason this can be called unconditionally from the calendar store.
    if (!target) return "skipped";
    const { account, href } = target;
    const ref = account.calendars.find((c) => c.href === href);
    // The same gate the calendars' read-only flag and the dirty mark use: push
    // off, a read-only collection, or an `http://` account (E2b, never synced).
    if (!ref || notWritable(account, ref.read_only)) return "skipped";

    const resourceHref = (row.caldav_href ?? "").trim();
    const etag = (row.caldav_etag ?? "").trim();

    const noteConflict = (): CalDavPushOutcome => {
      const conflict: CalDavConflict = {
        rowId: row.id,
        kind,
        accountId: account.id,
        href,
        resourceHref,
        title: rowTitle(row),
        op,
        at: syncStamp(),
      };
      set((s) => ({
        conflicts: [...s.conflicts.filter((c) => c.rowId !== row.id), conflict],
      }));
      return "conflict";
    };

    try {
      if (op === "delete") {
        // A row the server never heard of needs no deleting there. Returning
        // early rather than erroring is what lets the local delete proceed.
        if (!resourceHref || !etag) return "skipped";
        const outcome = await caldavDelete({
          accountId: account.id,
          href,
          resourceHref,
          etag,
        });
        if (outcome.conflict) {
          noteConflict();
          // **A refused delete must stop the local one.** Returning the outcome
          // here would let `deleteEvent` proceed, leaving the appointment gone
          // on this machine and still there for everyone else — the exact
          // asymmetry the server-then-local ordering exists to prevent. The
          // throw is what makes the caller's `await` fail; the conflict is
          // already on the list, so the dialog explains it.
          throw new Error(CALDAV_CONFLICT_ERROR);
        }
        return "pushed";
      }

      // The resource, not the row: a repeating event's occurrence overrides live
      // in the same calendar object, and writing one component would replace the
      // object with just that component.
      const calendar = useCalendarStore.getState();
      const ics =
        kind === "event"
          ? resourceIcs(resourceRows(row as CalendarEvent, calendar.events), [])
          : resourceIcs([], resourceRows(row as CalendarTask, calendar.tasks));
      const uid =
        kind === "event"
          ? resourceUid(resourceRows(row as CalendarEvent, calendar.events))
          : resourceUid([row as CalendarTask]);

      const outcome = await caldavPush({
        accountId: account.id,
        href,
        kind,
        rowId: row.id,
        uid,
        ics,
        resourceHref: resourceHref || null,
        etag: etag || null,
        rev: row.rev ?? null,
      });
      if (outcome.conflict) {
        markDirty(kind, row.id);
        return noteConflict();
      }

      // The backend stamped the row on disk; mirror it into the store so the
      // *next* edit is conditional on the ETag this write just earned rather
      // than on the one it replaced. The unpushed-edit mark goes too, unless
      // the row was edited again while this write was in flight.
      const patch = {
        caldav_href: outcome.href,
        caldav_etag: outcome.etag,
        caldav_dirty: outcome.dirty ? true : undefined,
        caldav_server_deleted: undefined,
      };
      // The resource's other rows (a series' overrides rode in the same body)
      // take the new ETag too, as the backend stamped them, so their next push
      // is not a `412` against this very write.
      const sibling = (r: CalendarEvent | CalendarTask) =>
        r.id !== row.id &&
        resourceHref !== "" &&
        r.calendar_id === row.calendar_id &&
        (r.caldav_href ?? "").trim() === resourceHref &&
        outcome.href === resourceHref;
      useCalendarStore.setState((s) =>
        kind === "event"
          ? {
              events: s.events.map((e) =>
                e.id === row.id
                  ? { ...e, ...patch }
                  : sibling(e)
                    ? { ...e, caldav_etag: outcome.etag }
                    : e,
              ),
            }
          : {
              tasks: s.tasks.map((t) =>
                t.id === row.id
                  ? { ...t, ...patch }
                  : sibling(t)
                    ? { ...t, caldav_etag: outcome.etag }
                    : t,
              ),
            },
      );
      return "pushed";
    } catch (err) {
      const message = typeof err === "string" ? err : String(err);
      set({ pushError: message });
      // A **delete** rethrows: the calendar store is waiting on this to decide
      // whether to remove the local row, and swallowing it here would delete a
      // row the server still has. An upsert does not — it is already written
      // locally, and it stays marked `caldav_dirty` (the backend marked it
      // before sending), so the next sync pushes it again before it fetches and
      // no merge overwrites it in between (gap 32).
      if (op === "delete") throw new Error(message);
      markDirty(kind, row.id);
      return "error";
    }
  },

  pushDirty: async (account, href, skip) => {
    const ref = account.calendars.find((c) => c.href === href);
    if (!ref || notWritable(account, ref.read_only)) return;
    const { events, tasks } = useCalendarStore.getState();
    const rows: { kind: "event" | "task"; row: CalendarEvent | CalendarTask }[] = [
      ...events
        .filter((e) => e.calendar_id === ref.calendar_id && e.caldav_dirty)
        .map((row) => ({ kind: "event" as const, row })),
      ...tasks
        .filter((t) => t.calendar_id === ref.calendar_id && t.caldav_dirty)
        .map((row) => ({ kind: "task" as const, row })),
    ];
    // One push per resource: a series' rows go to the server as one object.
    const sent = new Set<string>();
    for (const { kind, row } of rows) {
      const now = get();
      if (skip.includes(row.id) || now.deferred.includes(row.id)) continue;
      if (now.conflicts.some((c) => c.rowId === row.id)) continue;
      const gone = (row.caldav_server_deleted ?? "").trim();
      if (gone) {
        // Still an open question from an earlier sync (or an earlier run):
        // asked again, never answered by pushing.
        const conflict = keptConflict(account.id, href, {
          row_id: row.id,
          kind,
          href: gone,
          title: row.title,
          reason: "deleted",
        });
        set((s) => ({ conflicts: [...s.conflicts, conflict] }));
        continue;
      }
      const resource = (row.caldav_href ?? "").trim() || `row:${row.id}`;
      if (sent.has(resource)) continue;
      sent.add(resource);
      await get().pushRow({ op: "upsert", kind, row });
    }
  },

  resolveKeepMine: async (conflict) => {
    const calendar = useCalendarStore.getState();
    const row =
      conflict.kind === "event"
        ? calendar.events.find((e) => e.id === conflict.rowId)
        : calendar.tasks.find((t) => t.id === conflict.rowId);
    if (!row) {
      get().dismissConflict(conflict.rowId);
      return;
    }

    // A root agent's calendar move deletes the old copy and keeps the row,
    // under the same id, in another calendar with an address of its own (or
    // none yet). Keeping "mine" then means removing the copy it left behind,
    // and nothing about the row: staging would stamp the old resource's ETag
    // onto the moved row, and the local delete below would take the moved
    // event with it.
    const movedOn =
      conflict.op === "delete" && (row.caldav_href ?? "").trim() !== conflict.resourceHref;

    try {
      // Re-read the validator and write against *that*. Still conditional: an
      // edit that lands between the question and the answer conflicts again
      // rather than being destroyed by the resolution of an older conflict.
      // A resource the server deleted has no validator to read: the row is
      // local-only, and keeping it is a create.
      const current = conflict.serverDeleted
        ? ""
        : await caldavResourceEtag(conflict.accountId, conflict.resourceHref);
      const staged =
        conflict.kind === "event"
          ? { ...(row as CalendarEvent), caldav_etag: current }
          : { ...(row as CalendarTask), caldav_etag: current };
      if (!movedOn) {
        useCalendarStore.setState((s) =>
          conflict.kind === "event"
            ? { events: s.events.map((e) => (e.id === row.id ? (staged as CalendarEvent) : e)) }
            : { tasks: s.tasks.map((t) => (t.id === row.id ? (staged as CalendarTask) : t)) },
        );
      }

      if (conflict.op === "delete") {
        await caldavDelete({
          accountId: conflict.accountId,
          href: conflict.href,
          resourceHref: conflict.resourceHref,
          etag: current,
        });
        // Only now is the local row safe to drop — the same server-then-local
        // order the ordinary delete path takes. That path announces itself and
        // therefore issues a second DELETE for a resource this one just removed;
        // the server answers `404`, which `delete_resource` reports as `gone`,
        // i.e. success. One wasted round trip, in exchange for the local delete
        // going through the single code path that owns it.
        if (!movedOn) {
          if (conflict.kind === "event") await calendar.deleteEvent(row.id);
          else await calendar.deleteTask(row.id);
        }
      } else {
        const outcome = await get().pushRow({ op: "upsert", kind: conflict.kind, row: staged });
        if (outcome === "conflict") return; // the question was re-raised; leave it up
      }
      get().dismissConflict(conflict.rowId);
    } catch (err) {
      set({ pushError: typeof err === "string" ? err : String(err) });
    }
  },

  resolveTakeServer: async (conflict) => {
    // A forced sync of the collection is what *is* "take the server's version":
    // the merge overwrites the row's server-owned fields from the fetched
    // resource, and does it through the one code path that knows how. The
    // row's unpushed-edit mark is dropped in that same write (`discard`) — or
    // the merge would keep the edit again — and the read is a full one: an
    // earlier sync may already have moved the token past the server's change.
    // A row the server deleted is deleted here too.
    await get().syncCalendar(conflict.accountId, conflict.href, true, {
      discard: [conflict.rowId],
      full: true,
    });
    get().dismissConflict(conflict.rowId);
  },

  dismissConflict: (rowId) => {
    set((s) => ({
      conflicts: s.conflicts.filter((c) => c.rowId !== rowId),
      deferred: s.deferred.filter((id) => id !== rowId),
    }));
  },

  deferConflict: (rowId) => {
    set((s) => ({
      conflicts: s.conflicts.filter((c) => c.rowId !== rowId),
      deferred: s.deferred.includes(rowId) ? s.deferred : [...s.deferred, rowId],
    }));
  },

  refreshAccess: async (accountId, href) => {
    const readOnly = await caldavRefreshAccess(accountId, href);
    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.id !== accountId
          ? a
          : {
              ...a,
              calendars: a.calendars.map((c) =>
                c.href === href ? { ...c, read_only: readOnly } : c,
              ),
            },
      ),
    }));
    const account = get().accounts.find((a) => a.id === accountId);
    if (account) await applyWritability(account);
  },
}));

/**
 * Wire calendar edits to the push path. Returns the uninstaller.
 *
 * Installed by `CalDavSyncHost` (one mount, at the shell) rather than at module
 * scope, so a test — and a popout window, which has its own React root — gets a
 * store with no side effects until something asks for them.
 */
export function installCalDavPush(): () => void {
  const dropHandler = setCalendarWriteHandler(async (event) => {
    await useCalDavStore.getState().pushRow(event);
  });
  // Which writes the calendar store marks `caldav_dirty` in the same local
  // write (gap 32): exactly the ones `pushRow` would send.
  const dropPredicate = setCalendarDirtyPredicate(
    (calendarId) => pushTarget(useCalDavStore.getState().accounts, calendarId) !== null,
  );
  return () => {
    dropHandler();
    dropPredicate();
  };
}

/** The status of whichever collection feeds a local calendar, for the sidebar. */
export function calendarSyncStatus(
  status: Record<string, CalDavSyncStatus>,
  accounts: CalDavAccount[],
  calendarId: string,
): CalDavSyncStatus | null {
  for (const account of accounts) {
    const ref = account.calendars.find((c) => c.calendar_id === calendarId);
    if (ref) return status[ref.href] ?? IDLE;
  }
  return null;
}
