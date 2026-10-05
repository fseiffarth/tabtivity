## Group X — CalDAV Accounts (read-only sync) ✅ Done · 🧪 Untested against a real server

*Real CalDAV: a calendar backed by a server the user has an **account** on —
typed base URL, username, password — synced on a schedule or on demand. The
mail-account shape, not the `Calendar.source_url` shape: that one stays exactly
as it is and is still the right tool for an anonymous read-only feed somebody
shared with you. The invariants that make it worth having: [`docs/context/caldav.md`](../docs/context/caldav.md).*

*Files: new `src-tauri/src/services/caldav.rs`, `src-tauri/src/schema/caldav.rs`,
`src-tauri/src/commands/caldav.rs`, `merge_caldav_calendar_at` in
`src-tauri/src/commands/calendar.rs`, `caldav_account` in
`src-tauri/src/services/remote_credentials.rs`, `src-tauri/src/lib.rs`
(`generate_handler!` + managed state), `roxmltree` in `Cargo.toml`; frontend new
`src/types/caldav.ts`, `src/lib/calendar/caldav.ts`, `src/stores/calendar/caldav.ts`,
`src/components/calendar/CalDavAccountDialog.tsx` + `CalDavSyncHost.tsx`,
`src/components/calendar/{CalendarPane,CalendarSidebar}.tsx`,
`src/components/layout/AppShell.tsx`, `src/lib/i18n.ts`, `src/styles/themes.css`.*

156. **Protocol plumbing (Phase 0).** `services/caldav.rs`: the six fixed XML
    request bodies (principal / calendar-home-set / collection listing +
    minimal fallback / `calendar-query` / `calendar-multiget` /
    `sync-collection`) and a `roxmltree` multistatus parser. Hand-rolled on
    `reqwest` rather than a CalDAV crate — the Rust landscape is unmaintained
    or WebDAV-generic, and a `PROPFIND` body is a five-line template.
    Deliberately **not** routed through `browser_engine`'s SSRF machinery: a
    CalDAV base URL is user-typed for an account they are setting up, the same
    posture `MailServer.host` already has. Redirects are capped, the body is
    capped, TLS is the shared rustls + OS-trust-store stack with no
    cert-ignore hatch.
    - [x] 🤖 Automated test — RFC-shaped fixtures: a home listing keeps only
      calendar collections, a `404` propstat reads as an absent property (not
      present-and-empty), a `sync-collection` reply yields resources plus
      `404` deletion stubs, an etag with no data survives for the multiget
      pass, privileges decide read-only while silence asserts nothing, and an
      HTML login page fails loudly instead of importing zero events.
    - [ ] 🖐️ Manual test — against a locally-run Radicale/Nextcloud **before**
      ever pointing it at an institutional account.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

157. **Accounts, discovery, subscribe (Phase 1).** `caldav/accounts.json` +
    `caldav_accounts_list`/`_account_upsert`/`_account_delete`/
    `_password_state`/`_forget_password`/`_discover`, mirroring the `mail_*`
    account surface down to `{account, saved, save_error}`. Credentials are
    **not a fourth mechanism**: same keychain, same `remote_credentials`, same
    opt-in-default-off, same `true | null` remember argument, keyed by server
    target (`caldav:<user>@<host>`) so re-adding an account finds the password
    already there. `CalDavAccountDialog` is `MailAccountDialog`'s structural
    twin plus the find-then-pick step CalDAV needs; a ticked collection
    becomes an ordinary read-only `Calendar` in the sidebar.
    - [x] 🤖 Automated test — the store mints ids and replaces in place, holds
      no secret, keys the keychain by target rather than account id, coerces
      `remember: false` to `None`, and round-trips a subscription's cursors.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

158. **Identity-based reconciliation.** `merge_caldav_calendar_at` — the one
    genuinely new piece of logic. `replace_calendar_events_at` cannot be
    reused: it re-mints ids on every refresh, which for an unattended sync
    would evict every CalDAV-sourced card from the to-do column the user
    dragged it into, every time the timer fires. Rows are matched on
    `caldav_href` and merged field by field; a task keeps
    `column`/`rank`/`tags`/`subtasks`/`mail`/`project_id`/`created`. Explicit
    `404`s delete; absence from a full listing deletes an *event* only (a
    VTODO can vanish because the server filtered it); absence from an
    incremental report deletes nothing.
    - [x] 🤖 Automated test — a second sync updates the title and percent
      while keeping column/rank/tags/subtasks; a new row is placed by
      `normalize`; an explicit deletion removes both kinds; absence deletes an
      event but never a task; an incremental report deletes nothing; a row
      with no `caldav_href` is never pruned; a master+override resource
      matches positionally and shrinks correctly.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

159. **Scheduled sync + visible failure (Phase 2).** `sync_interval_min` drives
    `CalDavSyncHost` (mounted at the shell, renders nothing, starts no timer
    until an account exists, first tick a whole interval after mount, explicit
    `0` means manual-only). The backend's ctag check is what keeps a short
    interval cheap — an unchanged collection costs one small `PROPFIND`, and
    `sync-collection` is used when the server offers a token, falling back to
    a full `calendar-query` when it does not. A failed sync shows as an amber
    `!` on the sidebar row carrying the backend's own words, mail's rule: a
    quietly stale calendar looks exactly like one with nothing new in it.
    - [x] 🤖 Automated test — `parseChanges` groups by resource (a master and
      its `RECURRENCE-ID` override stay in one group), an empty body is
      reported rather than dropped, and `calendarSyncStatus` distinguishes
      never-synced from failed from not-CalDAV-at-all.
    - [ ] 🖐️ Manual test — including a wrong password after a relaunch, which
      is the case the amber `!` exists for.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

160. **Two-way sync (Phase 3) — built, never live-tested.** `PUT`/`DELETE`
    conditional on `If-Match` (`If-None-Match: *` to create), a `412` carried as
    a **value** (`CalDavWrite.conflict`) rather than an error, and whole-*resource*
    serialization so a recurring series' occurrence overrides travel with their
    master. The plan's two open questions were answered by asking rather than
    deciding: `CalDavAccount.allow_write` is per account and **defaults false**
    (an untouched account behaves exactly as Phases 1–2 did), and the conflict UX
    is `CalDavConflictDialog` — keep mine / use the server's / decide later, and
    deliberately no *merge*. `read_only` stays per collection and is still the
    server's answer, now re-askable via `caldav_refresh_access`.

    Two things push forced elsewhere: `UID` and `RECURRENCE-ID` now round-trip
    through `lib/calendar/ics.ts` (without the first a push creates a second copy of every
    appointment; without the second a series pushes back as two masters), and
    `serializeIcs` writes a locally-authored series' `overrides[]` — which fixes
    the **file export**, silently dropping occurrence edits since it was written.
    - [x] 🤖 Automated test — the write gate (`CalDavPushGate.test.ts`: no
      account / no opt-in / server-side read-only all reach no network; a refused
      **delete** rejects rather than letting the local delete through), the
      resource body (`CalDavPush.test.ts`: one UID per resource, master-first,
      overrides emitted, board state never serialized), the unconditional-write
      refusal (`services::caldav::an_update_with_no_known_etag_is_refused…`), and
      the local gate (`commands::caldav::a_write_needs_both_the_users_opt_in_and_the_servers`).
    - [ ] 🖐️ Manual test — Radicale in a container + Thunderbird: create/edit/
      delete an event and a task from Tabtivity and see them in Thunderbird; a
      concurrent edit from Thunderbird surfaces as a named conflict rather than
      being overwritten; a recurring series' "this occurrence only" edit
      round-trips. **Nothing in the CalDAV stack has ever spoken to a real
      server**, so this is riskier than its size.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

161. **Look at an `.ics` before importing it — built, never live-tested.**
    `lib/calendar/icsSafety.ts` reports what a picked file contains (`PROCEDURE`/`EMAIL`/
    `AUDIO` alarms, `ATTACH`, non-`http(s)` links, `METHOD:REQUEST`, bidi-disguised
    titles, endless sub-daily `RRULE`s, never-imported component kinds) and
    `IcsImportReviewDialog` shows it before anything is written. Explicitly **not**
    a scanner — an `.ics` cannot run anything here — but every one of those is
    dropped or cleaned in silence today, and the dialog is the difference between
    "Tabtivity ignored it" and "you knew it was there". Raised only when there is
    something to say, so an ordinary export still imports in one click.
    - [x] 🤖 Automated test — `IcsSafety.test.ts`, both directions: every finding
      is detected, and an ordinary calendar export (including a `LOCATION: Room 3:
      Building B`) produces **none**, since a report that flags every file is a
      dialog nobody reads.
    - [ ] 🖐️ Manual test — import a hand-built hostile `.ics` and check the
      dialog names each finding and says what happens to it.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

162. **The CalDAV password no longer follows a redirect off its own host.**
    `dav_request` follows hops itself (reqwest's policy would turn a `PROPFIND`
    into a `GET` on a 302), which meant reqwest's cross-origin header stripping
    was not in play and `basic_auth` was re-attached on **every** hop — so a
    hostile or compromised server at the configured URL could bounce the client
    anywhere and be handed the calendar password. `credentials_may_follow` now
    allows the same origin, or a subdomain over TLS (RFC 6764's `.well-known`
    shape), and nothing else; an `https→http` hop is refused outright rather than
    merely stripped.
    - [x] 🤖 Automated test — `services::caldav::credentials_*` (same origin,
      the well-known subdomain hop, a foreign host, a sibling host, a TLS
      downgrade, and suffix-vs-substring matching).
    - [ ] 🖐️ Manual test — a server that redirects `.well-known/caldav` to its
      DAV subdomain still sets up; one redirecting to another domain refuses with
      the "set the account's URL to that address" sentence.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

824. **VPN-only CalDAV account.** `require_vpn` on `CalDavAccount`, the mail
    account's switch (#823) for a calendar server inside an institutional
    network. `CalDavSyncHost` never makes the account due while no OpenVPN
    tunnel Tabtivity knows about is up, and makes it due — and syncs it on the spot
    rather than at the next 60 s wake-up — when one comes up, on the same
    reconciled rising edge as mail. Enforced in `commands::caldav::credentials`,
    the step every network-bound command takes first, so fetch, push, delete
    and access-refresh all refuse alike before the keyring is even read.
    - [x] 🤖 Automated test — `VpnGate.test.ts`, `schema::caldav` round-trip.
    - [ ] 🖐️ Manual test — with the tunnel down a ticked account shows no sync
      error after its interval; *Sync now* refuses with the VPN sentence;
      connecting the VPN syncs it within seconds.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

839. **A new event's end follows its start, an hour later.** Moving a new
    event's start left its end where the draft put it, so an event dragged to
    the afternoon ended in the morning and was refused on save. On the desktop
    `EventDialog` and the phone's editor (`mobile-web/src/screens/Calendar.tsx`)
    alike, a new timed event carries its end one hour past the start —
    wall-clock math that rolls past midnight and month ends — until the end is
    set by hand. Existing and all-day events are unchanged. Implemented
    2026-09-14 (`78e706a`), **not live-tested; the phone needs a PWA rebuild.**
    - [x] 🤖 Automated test — `MobileCalendarDates` (roll-over)
    - [ ] 🖐️ Manual test — new event, move the start to 15:00 → end reads 16:00;
      set the end to 17:30 by hand, move the start again → end stays 17:30. A
      start at 23:30 on the 31st ends 00:30 on the 1st. Editing an existing event
      does not move its end. Repeat on the phone.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

841. **ICS round-trip and recurrence edge cases that lose data.** Found
    2026-09-15 by the edge-case sweep; each is an `it.skip` in `IcsEdgeCases` /
    `RecurrenceEdgeCases` naming the bug — un-skip when fixed. `ics.ts`: (1) a
    bare `\r` in a text value (Windows-pasted note) is serialised raw and
    `unfold` reads it as a line break on re-import, dropping the rest of the
    note; (2) `parseLine` splits parameters on every `;`, truncating a quoted
    `CN="Doe; Jane"` to `Doe`; (3) `buildTask` reads an absent PERCENT-COMPLETE
    as `0`, so a `STATUS:COMPLETED` VTODO imports at 0 % yet gets a completed
    date; (4) `fold` counts UTF-16 units, not octets, so non-ASCII lines exceed
    RFC 5545's 75 (SHOULD-level, round-trip still correct). `recurrence.ts`:
    (5) `generateStarts` stops at the first start past the window, so an
    occurrence moved *into* the window by an override never appears (next
    week's standup moved to this Friday is missing from this week). Fixed
    the same day: text values normalise CR/CRLF to `\n` before escaping (TEXT
    has no form for a CR); parameters split on `;` outside quotes only; an
    absent PERCENT-COMPLETE is absent, not 0; `fold` counts UTF-8 octets and
    never splits a code point; expansion generates far enough to reach every
    override moved into the window. **Not live-tested.**
    - [x] 🤖 Automated test — `IcsEdgeCases`, `RecurrenceEdgeCases`
    - [ ] 🖐️ Manual test — paste a note with a Windows line break into an
      event, sync, reopen: the whole note survives. Move next week's recurring
      event to this Friday: it shows on this week's view.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2318. **Numbered weekdays in a recurrence ("the 2nd Tuesday").** An imported
    or synced `RRULE` with an ordinal `BYDAY` — `FREQ=MONTHLY;BYDAY=2TU`,
    `BYDAY=-1FR`, `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` — lost its ordinal in
    `parseRrule`, so a monthly meeting showed on every Tuesday; with two-way push
    on, `serializeIcs` then wrote the reduced `BYDAY=TU` back to the server.
    Implemented 2026-09-18: `Rrule.bynthweekday` (`{n, day}` list, `n` ±1…±5;
    yearly counts within the start's month) in `src/types` and
    `src-tauri/src/schema/calendar.rs`; `parseRrule` reads ordinals and Outlook's
    `BYDAY=TU;BYSETPOS=2` spelling; `formatRrule` writes them (yearly names
    `BYMONTH` from the start); `recurrence.ts` expands them, skipping months
    without a 5th; `describeRrule` says "Monthly on the 2nd Tuesday". Any rule the
    model can only reduce (`BYHOUR`, `BYSETPOS` over several days, several or
    negative `BYMONTHDAY`s, `20MO` in a year…) keeps its text in
    `Rrule.ics_value`, written back verbatim while the rule still reads the same,
    so a push no longer rewrites a server rule Tabtivity cannot draw — it still
    *displays* those reduced. `EventDialog` gains a "Repeats on" choice for
    monthly/yearly (day of month / nth weekday / last weekday, derived from the
    start), and a save that leaves the rule alone keeps the stored rule object.
    Still dropped whole: `FREQ=HOURLY`/`MINUTELY` rules. **Not live-tested.**
    - [x] 🤖 Automated test — `RecurrenceNthWeekday`, `EventDialogRepeatOn`,
      `Ics`, Rust `rrule_numbered_weekdays_round_trip_and_old_rules_still_load`
    - [ ] 🖐️ Manual test — import a monthly "2nd Tuesday" invite from Google or
      Outlook: it shows once a month on the right day and the editor reads
      "Repeats on: on the 2nd Tuesday"; edit its title with push on, then check
      the server copy still reads `BYDAY=2TU`. Create a monthly event on a month's
      last Friday and pick "on the last Friday".
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
