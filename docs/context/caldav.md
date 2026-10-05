# CalDAV accounts — what the feature actually protects

Phases 0–3 are implemented:
protocol plumbing, accounts + discovery + subscribe, scheduled sync, and
two-way push. The plan deferred Phase 3 on two open questions; how each was
answered is the "Push" section below.

Nothing here has run against a real CalDAV server. The parsers, the merge, the
push gate and the resource serializer are fixture- and unit-tested; the
transport has never spoken to anything.

## The one distinction the whole design rests on

There are two ways a calendar can come from somewhere else, and they are not
variants of one feature:

- **`Calendar.source_url`** (already shipped) is an *anonymous, unauthenticated
  ICS feed*, refreshed by a manual click. `replace_calendar_events_at` deletes
  every row under the calendar and re-inserts a freshly parsed set with **fresh
  ids**, and that is fine — a feed carries no identity the store can trust, and
  the only trigger is a click.
- **A CalDAV account** is a login on a server the user depends on for work,
  synced *unattended, on a timer*.

The second cannot make the first's trade. `CalendarTask.column`/`rank`/`tags`/
`subtasks`/`project_id`/`mail` are the to-do board's own state, have no CalDAV
representation, and a wholesale replace would silently evict every
CalDAV-sourced card from wherever the user dragged it — every five, or fifteen,
minutes. That is not a rough edge; it makes the board unusable for anything
CalDAV-backed.

So the feature is built on **identity, not replacement**. A CalDAV resource has
a URL the server hands back unchanged next time; it is stored as `caldav_href`
in the row's `extra` flatten, and `merge_caldav_calendar_at`
(`commands/calendar.rs`) reconciles on it:

| Case | Event | Task |
|------|-------|------|
| Matched (href present in the fetch) | overwrite server fields, keep the id | overwrite server fields, keep the id **and all board state** |
| New | create (fresh id) | create — `normalize` already files an unplaced card |
| Explicit `404` from the server | delete | delete |
| Absent from a **full** listing | delete | **keep** |
| Absent from an **incremental** report | keep | keep |

The two "absent" rows are the only judgement calls, and both are deliberate. An
incremental (`sync-collection`) reply *omits* everything unchanged, so treating
absence as deletion there would empty the calendar on the first quiet interval.
A full `calendar-query` is authoritative about events — but a VTODO can vanish
from one because it was deleted **or** because the server stopped returning
completed-and-old todos by its own default filter, and those two are
indistinguishable from the client. Guessing wrong destroys a card, so tasks are
not deleted on absence alone. The plan's own answer stands: only an explicit
`404` for that specific href deletes a task.

One more subtlety: a single resource can hold several components — a recurring
event's master plus its `RECURRENCE-ID` overrides, because CalDAV has no
separate occurrence object. So rows are matched **within** an href group, by
position, and that is why the frontend hands the backend
`CalDavParsed { href, etag, events, tasks }` groups rather than one flat list.

## Why a sync is two commands

`caldav_fetch` speaks the protocol and hands back each resource's iCalendar
text **unparsed**; the frontend runs it through `src/lib/calendar/ics.ts`; `caldav_apply`
reconciles and writes. That is the same seam `calendar_fetch_ics` +
`calendar_replace_events` already has, for the same reason: `ics.ts` is the only
parser in this codebase that understands folding, escaping, `RRULE` and
`VALARM`, and it is the one with tests for all four. A second implementation in
Rust would be two parsers that can disagree about the same feed.

The Rust side therefore has exactly one job — speak WebDAV — and one new
dependency, `roxmltree`, for the multistatus documents. Everything outgoing is a
string template, because there are six of them.

## Where the account plumbing lives, and why not in `calendar.json`

`caldav/accounts.json` (schema `schema/caldav.rs`) holds the account, the
username, and a per-collection sync cursor. `calendar.json` holds only a pointer
(`caldav_account_id` + `caldav_href` on the `Calendar` row) and the synced rows
themselves.

`source_url` rides `Calendar`'s `extra` flatten because it names nothing that
needs protecting and carries no cursor. An account is different: it is read by
`calendar_load` on every calendar-tab mount, and it is the file that gets
exported and inspected alongside a calendar. Sync bookkeeping and a login name
have no business there. This is the same split `MailAccounts` draws against the
mail index.

The consequence worth stating: **every existing consumer of
`CalendarEvent`/`CalendarTask` needed zero changes.** The grid, month view,
agenda, alarms, ICS export and the to-do board already do not know or care where
a row came from.

## Credentials, and the things that are not new

No fourth credential mechanism: same OS keychain, same
`services::remote_credentials`, same opt-in-default-off, same `true | null`
(never bare `false`) remember argument, same "unreadable is not absence"
tri-state, same `SavePasswordRow` off `useSavedCredentialSource`. The key is
`caldav:<user>@<host>` — **server target, not Tabtivity account id**, matching
`ssh_account`/`mail_account`, so two accounts pointed at one login share one
entry instead of disagreeing about whether a password is saved. Only the origin
goes into the key, because discovery routinely resolves a longer URL than the
one the user pasted and a path-keyed entry would fork in two on the first sync.

The SSRF machinery (`reader_hop_allowed`, `resolve_hop`, DNS pinning) is
deliberately **not** applied. It exists because a reader-mode or ICS-subscribe
URL is content someone else handed the user; a CalDAV base URL is one they typed
for an account they are setting up, exactly like `MailServer.host` — mail does
not run its IMAP host past the reader's hop judge either. Someone pointing this
at `https://localhost:5232` for a self-hosted Radicale is not an attack. What
*is* kept: a redirect cap, a body cap, no cookie store, no `Referer`, no
cert-ignore hatch.

## The password does not follow a redirect off its own host

`dav_request` follows hops itself — it has to, because `reqwest`'s redirect
policy would turn a `PROPFIND` into a `GET` on a 302, answering a question
nobody asked. The cost of disabling that policy is that its *other* job goes
with it: reqwest strips sensitive headers on a cross-origin hop, and this
module re-attached `basic_auth` on every hop instead. A server at the URL the
user typed — or anyone who can answer for it — could therefore bounce the
client anywhere and be handed the calendar password in a readable header.

`credentials_may_follow` is the fix, applied per hop against the URL the
*caller* named rather than the previous hop (a chain of small steps must not be
able to walk the password anywhere):

- **same origin** — every hop inside one server's URL space;
- **a subdomain of the credential's host, over TLS** — RFC 6764's own shape,
  where the user types `example.org` and `/.well-known/caldav` redirects to
  `caldav.example.org`;
- **nothing else**, and an `https → http` hop is refused outright rather than
  merely stripped, because everything after it (the calendar's contents
  included) would cross the network in the clear.

Sibling hosts (`caldav.example.org` → `dav.example.org`) are refused too, which
is stricter than "same organization" and deliberately so: telling those apart
from an attacker's host needs a public-suffix list this codebase does not have
(`web_safety::registrable` is a documented two-label approximation, under which
`a.co.uk` and `evil.co.uk` are one site). The refusal is recoverable and its
message says how — set the account's URL to the address the server named, and
that address becomes the credential origin. An unauthenticated hop that comes
back `401` gets *that* sentence rather than "check your password", because the
fix is not to retype one.

## What a scheduled sync costs

The cheap check first: `getctag` is one small `PROPFIND`, and an unchanged one
means nothing is fetched at all. When the server offers RFC 6578,
`sync-collection` returns only what changed (plus `404` stubs for deletions);
when it does not, or the token has expired, the fallback is a full
`calendar-query`, which is what every pre-6578 server has always been on. A
manual *Sync now* passes `force`, skipping the ctag check — a user who just
fixed something on the server should not be told "nothing changed" by a token.

A failure is **visible**: the sidebar row shows an amber `!` carrying the
backend's own sentence. This is mail's rule, and the case it exists for is
specific — an account whose password was never saved, or a keyring that is
locked, fails every unattended sync after a relaunch, and a calendar that
quietly stops updating looks exactly like a calendar with nothing new in it.

## Push (Phase 3), and how the plan's two open questions were answered

**"Is write access even wanted against an institutional calendar?"** — asked,
not decided. `CalDavAccount.allow_write` is per account and **defaults false**,
so an untouched account behaves exactly as Phases 1–2 did. Nobody but the
account's owner knows whether the thing on the other end is a shared work
calendar or their own Radicale, and a push bug against the first has a
materially bigger blast radius than against the second.

The switch is not the only gate, and none of the three is trusted to be the last
one: the account's opt-in, the server's own `current-user-privilege-set`
(`CalDavCalendarRef.read_only`, per collection — a calendar someone else shared
with you is legitimately read-only *to you*), and the server's `403`, which is
the only one that is actually enforcement. `caldav_refresh_access` re-asks the
middle one, because access changes and the alternative would be re-subscribing,
which costs the calendar's board state.

Both gates fold into the local `Calendar.readonly` flag (`applyWritability`), and
that is the load-bearing part: with push off, a CalDAV-backed calendar is
read-only in the grid. A calendar that accepted edits while never sending them
would be the "looks exactly like success" failure this whole feature is built to
avoid.

**"The conflict UX is undesigned."** — `CalDavWrite.conflict` makes a `412` a
*value*, not an error, so it arrives as a question the UI can render rather than
a string one surface happens to pattern-match. `CalDavConflictDialog` (mounted at
the shell, beside the sync host, because the pane that raised the edit is the one
that has been closed by the time an answer is needed) offers exactly three
answers: **keep mine** (re-read the current ETag and write against *that* — an
overwrite, but still a conditional one, so a third edit landing mid-question
conflicts again), **use the server's** (a forced sync of the collection, through
the same merge every other sync goes through), and **decide later**. There is
deliberately no "merge": half of one time and half of another is not a third
valid meeting.

Two invariants carry the write path, and both are places where the obvious
simpler implementation loses somebody's data:

- **Every write is conditional.** Create sends `If-None-Match: *`, update and
  delete send `If-Match: <etag>`. There is no unconditional fallback, not even
  for a server that returned no validator — a row in that state refuses to write
  and asks for a sync instead, because the unconditional write is exactly the one
  that destroys an edit made from a phone between the read and the write.
- **A delete is server-then-local, and a refusal stops it.** An upsert is pushed
  *after* the local write (an edit made offline is still an edit); a delete is
  pushed *before* it, and both a conflict and an ordinary failure reject, so the
  local row survives. The other order leaves an appointment gone here and still
  there for everyone else, with nothing left to retry from. `lib/calendar/calendarWriteHook.ts`
  is where that asymmetry lives — a one-slot handler registry, so the calendar
  store can announce writes without importing the CalDAV store back (two
  module-scope `create()` calls in a cycle is the shape that resolves to
  `undefined` depending on which file the bundler reaches first).

### What push forced the ICS layer to learn

A resource is not a row. CalDAV has no separate occurrence object, so a repeating
event's "this event only" edits live in the *same* calendar object as their
master — and this app stores a synced series as several rows sharing one
`caldav_href`. Pushing the edited row alone would not be a partial update; it
would replace the object with one component of it, deleting every other override
the series had. `lib/calendar/caldavPush.ts` groups by resource (`resourceRows`), orders
master-first (`orderComponents`), and serializes the group as one body.

Two fields had to start round-tripping for any of that to be correct, and neither
is displayed anywhere:

- **`uid`** — the calendar object's identity everywhere outside this app. The
  serializer used to mint `${row.id}@<pinned domain>` unconditionally (the
  domain is `PINNED_ICS_UID_DOMAIN`, the app's old lowercase name, for good), which on a push
  means the server keeps its object under the old UID and files ours as a second
  one. A row now writes back under the UID it arrived with.
- **`recurrence_id`** — which occurrence an override row replaces. Without it a
  row knows it is an override but not *of what*, and pushing the series writes
  two masters under one UID.

`serializeIcs` also emits a locally-authored series' `overrides[]` as
`RECURRENCE-ID` components. That is a **fix to the file export too**: before
this, a series exported and re-imported came back with every moved occurrence
silently in its original place.

## Looking at an `.ics` before importing it

`lib/calendar/icsSafety.ts` + `IcsImportReviewDialog` report what is in a picked file
before any of it lands in `calendar.json`. It is explicitly **not** a scanner,
and the dialog's own footnote says so: an `.ics` cannot run anything here. The
parser reads a fixed set of properties into plain data, every text field goes
through `stripFormatControls`, no calendar surface renders HTML, and a link
reaches the OS only after `lib/calendar/conference.ts` has refused everything that is not
`http(s)`.

It answers the question those defences cannot, precisely because their job is to
be silent: *what am I about to put in my calendar?* A `PROCEDURE` alarm, an
`ATTACH`, a `zoommtg:` location, a `METHOD:REQUEST`, a title carrying a
right-to-left override — all of them are dropped or cleaned today without a word.

Two rules keep it from becoming noise. Every finding says **what Tabtivity does
about it** (`ignored` is a field, not a tone), because a warning that lists a
hostile-sounding property without saying it is discarded reads as a threat rather
than a fact. And the dialog is **not raised at all** for a file with no findings
— an ordinary calendar export still imports in one click, which is what keeps the
dialog worth reading on the file that is not ordinary.
