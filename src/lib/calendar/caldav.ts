/**
 * **The** typed invoke surface for CalDAV — one wrapper per `caldav_*` command,
 * and nothing else in the frontend calls `invoke("caldav_*")` directly (the
 * convention `lib/mail.ts` and `lib/remote/hpc/slurm.ts` follow).
 *
 * It also owns the one piece of real work this side of the boundary does:
 * [`parseChanges`] runs each fetched resource's iCalendar text through
 * `lib/calendar/ics.ts`. That is deliberate and is the whole reason a sync is two
 * commands rather than one — `ics.ts` is the only parser in this codebase that
 * understands folding, escaping, `RRULE` and `VALARM`, and it is the one with
 * tests for all four. A second parser in Rust would be two implementations that
 * can disagree about the same feed.
 *
 * No wrapper takes a filesystem path, because no command does.
 */

import { invoke } from "@tauri-apps/api/core";
import { parseIcs } from "./ics";
import { toStamp } from "./calendarTime";
import type { TranslationKey } from "../i18n";
import type { CalendarData, CalendarEvent, CalendarTask } from "../../types";
import type {
  CalDavAccount,
  CalDavAccountSaved,
  CalDavChanges,
  CalDavCollection,
  CalDavKept,
  CalDavParsed,
  CalDavPasswordState,
  CalDavWrite,
} from "../../types/caldav";

/**
 * Minutes between background syncs when an account has never been given one.
 *
 * A quarter of an hour rather than mail's five minutes: an appointment moved on
 * a server is not time-critical the way a delivery is, and a scheduled sync is
 * a request against a work server that may be someone's institutional
 * groupware. An explicit `0` still means *never — only when I ask*, because a
 * stored 0 is a choice and only an absent value is unset.
 */
export const DEFAULT_CALDAV_SYNC_MIN = 15;

/**
 * The fixed code every backend refusal of plain `http://` CalDAV starts with
 * (`services::caldav::HTTP_REFUSED`, decision E2b). The UI shows
 * `caldav.httpRefused` for it — the one sentence saying why.
 */
export const CALDAV_HTTP_REFUSED = "caldav_http_refused";

/** Whether an error is the http refusal. */
export function isHttpRefused(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes(CALDAV_HTTP_REFUSED);
}

/** A sync or push error as the UI says it: the http refusal becomes its one
 *  translated sentence; anything else stays verbatim from the backend. */
export function caldavErrorText(error: string, t: (key: TranslationKey) => string): string {
  return isHttpRefused(error) ? t("caldav.httpRefused") : error;
}

/**
 * Whether a server URL is plain `http://` — refused for a new account, and an
 * existing one stops syncing (it is never deleted). Mirrors the backend's
 * `normalize_base_url`: only an explicit `http://` is; a bare host gets https.
 */
export function isHttpBaseUrl(url: string): boolean {
  return /^\s*http:\/\//i.test(url ?? "");
}

// ── Accounts + credentials ──────────────────────────────────────────────────

/** Every configured account. Never touches the network. */
export function caldavAccountsList(): Promise<CalDavAccount[]> {
  return invoke<CalDavAccount[]>("caldav_accounts_list");
}

/**
 * Create or update an account, applying the opt-in keychain write.
 *
 * `remember` is `true | null` and **never `false`** — `false` means *clear the
 * credential*, and a checkbox seeded by an async keyring read could otherwise
 * delete the password it just authenticated with (`rememberArg`). Clearing is
 * only ever [`caldavForgetPassword`].
 */
export function caldavAccountUpsert(
  account: CalDavAccount,
  password: string | null,
  remember: boolean | null,
): Promise<CalDavAccountSaved> {
  return invoke<CalDavAccountSaved>("caldav_account_upsert", { account, password, remember });
}

/** Remove the account. The keychain entry and the synced calendars stay. */
export function caldavAccountDelete(accountId: string): Promise<void> {
  return invoke<void>("caldav_account_delete", { accountId });
}

export function caldavPasswordState(accountId: string): Promise<CalDavPasswordState> {
  return invoke<CalDavPasswordState>("caldav_password_state", { accountId });
}

/** The only path that deletes a saved CalDAV password. */
export function caldavForgetPassword(accountId: string): Promise<void> {
  return invoke<void>("caldav_forget_password", { accountId });
}

/**
 * Run discovery once and list the collections found. The password passed here
 * is **not persisted by this call** — it is the "Test connection" analogue.
 */
export function caldavDiscover(
  baseUrl: string,
  user: string,
  password: string | null,
  accountId: string | null,
): Promise<CalDavCollection[]> {
  return invoke<CalDavCollection[]>("caldav_discover", { baseUrl, user, password, accountId });
}

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * Fetch one collection. `force` skips the ctag check — a user who clicks *Sync
 * now* after fixing something on the server should not be told "nothing
 * changed" by a token.
 */
export function caldavFetch(
  accountId: string,
  href: string,
  force: boolean,
  full = false,
): Promise<CalDavChanges> {
  return invoke<CalDavChanges>("caldav_fetch", { accountId, href, force, full });
}

/** Reconcile a parsed collection into `calendar.json`, in one atomic write. */
export function caldavApply(args: {
  accountId: string;
  href: string;
  parsed: CalDavParsed[];
  removed: string[];
  incremental: boolean;
  ctag: string;
  syncToken: string | null;
  lastSync: string;
  /** Rows whose local edit the user gave up on ("Use the server's"). */
  discard?: string[];
}): Promise<CalendarData & { caldav_kept?: CalDavKept[] }> {
  return invoke<CalendarData & { caldav_kept?: CalDavKept[] }>("caldav_apply", {
    ...args,
    discard: args.discard ?? [],
  });
}

// ── Push (Phase 3) ──────────────────────────────────────────────────────────

/**
 * Create or update one resource on the server.
 *
 * `resourceHref` null means **create** — the backend mints the URL from the
 * collection and `uid`, and writes conditional on nothing being there. Otherwise
 * it is an update conditional on `etag`; there is no unconditional path, which is
 * the point (`services/caldav.rs`'s write rules).
 *
 * A `412` comes back as `conflict: true`, **not** as a rejection: the caller has
 * a question to put to the user, not an error to report.
 */
export function caldavPush(args: {
  accountId: string;
  href: string;
  kind: "event" | "task";
  rowId: string;
  uid: string;
  ics: string;
  resourceHref: string | null;
  etag: string | null;
  /** The row revision `ics` was serialized from: the backend clears the row's
   *  `caldav_dirty` only when the server took that revision. */
  rev?: number | null;
}): Promise<CalDavWrite> {
  return invoke<CalDavWrite>("caldav_push", { ...args, rev: args.rev ?? null });
}

/**
 * Delete one resource, conditional on its ETag. The local row is the caller's to
 * remove **after** this resolves — the other order loses the row whenever the
 * server refuses.
 */
export function caldavDelete(args: {
  accountId: string;
  href: string;
  resourceHref: string;
  etag: string;
}): Promise<CalDavWrite> {
  return invoke<CalDavWrite>("caldav_delete", args);
}

/** The ETag one resource carries on the server right now — what makes resolving
 *  a conflict an informed overwrite rather than an unconditional one. */
export function caldavResourceEtag(accountId: string, resourceHref: string): Promise<string> {
  return invoke<string>("caldav_resource_etag", { accountId, resourceHref });
}

/** Re-ask the server what this login may do with a collection; returns the new
 *  `read_only`. Access changes — a colleague grants write months later — and the
 *  alternative would be re-subscribing, which costs the calendar's board state. */
export function caldavRefreshAccess(accountId: string, href: string): Promise<boolean> {
  return invoke<boolean>("caldav_refresh_access", { accountId, href });
}

/**
 * Parse every fetched resource, keeping each one's identity with its rows.
 *
 * Grouping is by **resource**, not by component, because one resource can hold
 * a recurring event's master *and* its `RECURRENCE-ID` overrides — there is no
 * separate occurrence object in CalDAV — and the backend matches rows within an
 * href group. Flattening here would throw that structure away.
 *
 * A resource whose text parses to nothing is still reported (as an empty
 * group), so the backend can see the resource exists rather than treating it as
 * absent-and-therefore-deleted.
 */
export function parseChanges(changes: CalDavChanges): { parsed: CalDavParsed[]; skipped: number } {
  let skipped = 0;
  const parsed: CalDavParsed[] = changes.resources.map((res) => {
    const text = res.data ?? "";
    if (!text.trim()) {
      // An empty body after the multiget pass is a resource the server would
      // not hand over. Counted, never guessed at.
      skipped += 1;
      return { href: res.href, etag: res.etag, events: [], tasks: [] };
    }
    const out = parseIcs(text);
    skipped += out.skipped;
    return {
      href: res.href,
      etag: res.etag,
      // The backend mints ids and fills `calendar_id`; these are the parser's
      // id-less rows cast to the wire shape, exactly as `calendar_replace_events`
      // already sends them.
      events: out.events as CalendarEvent[],
      tasks: out.tasks as CalendarTask[],
    };
  });
  return { parsed, skipped };
}

/** The local wall-clock stamp a sync records — this crate's one clock. */
export function syncStamp(now: Date = new Date()): string {
  return toStamp(now);
}
