//! Serde structs for CalDAV accounts (`docs/caldav_plan.md`).
//!
//! Two jobs, the same two `schema::mail` has:
//!
//! 1. **The wire contract** with `src/types/caldav.ts` — snake_case, same field
//!    names, same optionality.
//! 2. **`accounts.json`.** [`CalDavAccounts`] is the on-disk store under
//!    `~/.local/share/tabtivity/caldav/accounts.json`. It carries **no secret** —
//!    passwords live in the OS keychain via `services::remote_credentials`,
//!    keyed by server target (`commands::caldav::account_key`).
//!
//! **Why this is a second file and not a few keys on `Calendar`.** `source_url`
//! (the anonymous ICS-feed case) rides `Calendar`'s `extra` flatten because it
//! names nothing that needs protecting and carries no cursor. A CalDAV account
//! carries a username, a per-collection sync cursor, and a credential in the
//! keychain — that is account state, not calendar-display state, and putting it
//! in `calendar.json` would mean the file every calendar tab reads on mount (and
//! that gets exported and inspected alongside a calendar) also carries sync
//! bookkeeping nothing there needs. The mail client draws the same line between
//! `MailAccounts` and the message index.
//!
//! The **events and tasks themselves stay in `calendar.json`** as ordinary
//! `CalendarEvent`/`CalendarTask` rows, each carrying `caldav_href` and
//! `caldav_etag` in its own `extra` flatten. That is what lets every existing
//! consumer — the grid, month view, agenda, alarms, ICS export, the to-do board
//! — render CalDAV-sourced rows with zero changes: they already do not know or
//! care where a row came from.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::remote_credentials::KeyringState;

// ── Accounts ────────────────────────────────────────────────────────────────

/// One subscribed collection on an account.
///
/// `href` is the collection's own URL and is **the** stable key: the account's
/// label can be renamed, the local `Calendar` can be recolored, but the href is
/// what the server recognizes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CalDavCalendarRef {
    /// The collection's absolute URL.
    pub href: String,
    /// The `Calendar.id` in `calendar.json` this collection syncs into.
    pub calendar_id: String,
    #[serde(default)]
    pub display_name: String,
    /// Last-seen `getctag` — the cheap "did anything change at all" check that
    /// lets a scheduled sync skip the expensive report entirely.
    #[serde(default)]
    pub ctag: String,
    /// Last-seen RFC 6578 `sync-token`, when the server offers one. `None`
    /// means the ctag-gated full refetch path, which every server supports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_token: Option<String>,
    /// Which components the collection holds (`VEVENT`, `VTODO`). Empty means
    /// the server did not say, and both are asked for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<String>,
    /// **The server's own answer**, from its `current-user-privilege-set` — a
    /// collection someone else shared with you is legitimately read-only *to
    /// you*, so this is asked for rather than inferred from "push shipped".
    ///
    /// The serde default is `true` because that is what an *older* `accounts.json`
    /// means: every ref Phases 1–2 wrote was read-only, and a missing field must
    /// not read as "writable" on the first launch that can write.
    /// [`CalDavAccount::allow_write`] is the other half of the gate, and the
    /// server's 403 is the third — nothing here is trusted to be the only one.
    #[serde(default = "default_true")]
    pub read_only: bool,
    /// UTC-ish local stamp of the last successful sync, as the frontend minted
    /// it (this crate pulls in no time crate — same reasoning as
    /// `CalendarTask::created`). Empty until the first success.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_sync: String,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CalDavAccount {
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// What discovery resolved, or what the user pasted directly. Never
    /// defaulted from anything: a university-affiliated user can hold two
    /// unrelated mailboxes on two unrelated systems, so which account to sync is
    /// theirs to type — exactly like a mail account's IMAP host.
    pub base_url: String,
    pub user: String,
    /// Opt-in, **default false** — the standing no-password-storage rule.
    /// False means the password lives in the backend's in-memory map for this
    /// session only.
    #[serde(default)]
    pub save_password: bool,
    /// Minutes between background syncs. `None` or `0` means manual-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_interval_min: Option<u32>,
    /// **VPN-only account, default false** — the mail account's field of the
    /// same name, for the same institutional-server case. Enforced where the
    /// credentials are resolved (`commands::caldav::credentials`), which every
    /// network-bound command goes through, so a fetch, a push, a delete and an
    /// access refresh all refuse alike while no OpenVPN tunnel is up.
    #[serde(default)]
    pub require_vpn: bool,
    /// **Two-way sync — opt-in, default false** (`docs/caldav_plan.md` Phase 3).
    ///
    /// The plan left "is write access even wanted against an institutional
    /// calendar?" open, and this field is the answer: it is the *user's* to give,
    /// per account, and the default is the read-only behaviour Phases 1–2
    /// shipped. A push bug against a shared work calendar has a materially bigger
    /// blast radius than the same bug against a self-hosted one, and nobody but
    /// the account's owner knows which they are looking at.
    ///
    /// It is only ever half the gate: [`CalDavCalendarRef::read_only`] is the
    /// server's own answer, and a collection that says read-only stays read-only
    /// however this is set.
    #[serde(default)]
    pub allow_write: bool,
    #[serde(default)]
    pub calendars: Vec<CalDavCalendarRef>,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

/// `~/.local/share/tabtivity/caldav/accounts.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CalDavAccounts {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub accounts: Vec<CalDavAccount>,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

/// Current `accounts.json` version. Bumped only for a shape change a reader has
/// to branch on; additive fields ride the `extra` catch-all.
pub const ACCOUNTS_VERSION: u32 = 1;

// ── Command results ─────────────────────────────────────────────────────────

/// What the keychain **actually did**, never collapsed to a bare account: a
/// write that silently failed is how a user loses a password they think is
/// saved. Identical in shape to `MailAccountSaved` because it answers the same
/// generic question.
#[derive(Debug, Clone, Serialize)]
pub struct CalDavAccountSaved {
    pub account: CalDavAccount,
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_error: Option<String>,
}

/// Whether a password is saved for an account — and whether the store could be
/// read at all, because a locked collection answers every lookup with "nothing
/// saved" and reading that as absence is what un-saves credentials.
#[derive(Debug, Clone, Serialize)]
pub struct CalDavPasswordState {
    pub has_saved: bool,
    pub keyring: KeyringState,
}

// ── Protocol shapes ─────────────────────────────────────────────────────────

/// One calendar collection discovery found. The account dialog lists these as
/// checkboxes; subscribing turns the ticked ones into [`CalDavCalendarRef`]s.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CalDavCollection {
    pub href: String,
    #[serde(default)]
    pub display_name: String,
    /// `calendar-color`, as the server spells it (`#rrggbb` or `#rrggbbaa`).
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub ctag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_token: Option<String>,
    #[serde(default)]
    pub components: Vec<String>,
    /// The server reported privileges and none of them was a write privilege.
    /// A server that reports none at all leaves this `false` — unknown, not a
    /// claim of writability.
    #[serde(default)]
    pub read_only: bool,
}

/// One resource (one VEVENT or VTODO, by universal convention) as the server
/// handed it over: its URL, its ETag, and its iCalendar text **unparsed**.
///
/// The text goes to the frontend and through `src/lib/calendar/ics.ts`, which is the one
/// parser here that understands folding, escaping, `RRULE` and `VALARM` — the
/// same handoff `calendar_fetch_ics` already makes.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CalDavResource {
    pub href: String,
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub data: String,
}

/// One resource **after** the frontend has parsed its iCalendar text.
///
/// The round trip is deliberate and mirrors the ICS path exactly: the backend
/// fetches ([`CalDavResource`]), `src/lib/calendar/ics.ts` parses, and the parsed rows
/// come back here to be reconciled and written. The alternative — a second
/// iCalendar parser in Rust — would mean two implementations of folding,
/// escaping, `RRULE` and `VALARM` that could disagree about the same feed.
///
/// The resource identity travels **with** the group rather than being poked
/// into each row's `extra` by the frontend, so the one place that decides what
/// `caldav_href` and `caldav_etag` mean is `commands::calendar`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CalDavParsed {
    pub href: String,
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub events: Vec<crate::schema::calendar::CalendarEvent>,
    #[serde(default)]
    pub tasks: Vec<crate::schema::calendar::CalendarTask>,
}

/// What one **write** did (`docs/caldav_plan.md` Phase 3).
///
/// A conflict is a *result*, not an error, and that is the whole shape of it: a
/// `412` means someone else changed the resource since this app last read it,
/// which the user has to decide about, so it must arrive as a value the frontend
/// can render a choice from rather than as an error string one surface happens to
/// pattern-match. The rule it serves is mail encryption's, verbatim — a silent
/// downgrade is the worst thing a sync feature can do, because it looks exactly
/// like success.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CalDavWrite {
    /// The resource's absolute URL after the write — minted by the client for a
    /// create, echoed back for an update.
    pub href: String,
    /// The validator for the *next* conditional write. Empty means the server
    /// returned none and the follow-up `PROPFIND` could not get one either, in
    /// which case the next write has to wait for a sync — an unconditional
    /// overwrite is exactly what this feature does not do.
    #[serde(default)]
    pub etag: String,
    /// The server refused: the resource changed elsewhere since `etag` was read
    /// (`412`), or — on a create — something already exists at that URL.
    #[serde(default)]
    pub conflict: bool,
    /// A delete found nothing there. Reported rather than treated as failure:
    /// the intended end state is the actual one.
    #[serde(default)]
    pub gone: bool,
}

/// What one fetch of a collection found.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CalDavChanges {
    pub resources: Vec<CalDavResource>,
    /// Hrefs the server reported as **gone** (RFC 6578's `404` stubs, or a
    /// `404` from a targeted multiget). This is the only signal that deletes a
    /// task: absence from a listing is not, because some servers stop returning
    /// completed VTODOs by default filter and "deleted" and "filtered out" would
    /// be indistinguishable.
    pub removed: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_token: Option<String>,
    #[serde(default)]
    pub ctag: String,
    /// This was an incremental (`sync-collection`) report, so a local row whose
    /// href is *absent* means "unchanged", never "deleted".
    #[serde(default)]
    pub incremental: bool,
    /// The ctag matched the stored one: nothing was fetched and nothing needs
    /// applying. The whole point of the cheap check.
    #[serde(default)]
    pub unchanged: bool,
}

#[cfg(test)]
mod tests {
    #[test]
    fn require_vpn_defaults_off_and_round_trips() {
        let raw = r#"{"id":"c1","base_url":"https://dav.example.com/","user":"u"}"#;
        let acct: super::CalDavAccount = serde_json::from_str(raw).expect("parse");
        assert!(!acct.require_vpn);
        let mut gated = acct.clone();
        gated.require_vpn = true;
        let back: super::CalDavAccount =
            serde_json::from_str(&serde_json::to_string(&gated).unwrap()).unwrap();
        assert!(back.require_vpn);
    }
}
