# Cockpit MCP

`services::cockpit_mcp` serves `tab_rename`, `tab_get_info`, `tab_set_activity`,
`tab_set_handoff`, `tab_set_results`, `tab_set_progress`, `tab_set_blocker` and
`tab_set_verification`, `tab_request_attention` and `tab_add_milestone` on `/mcp/cockpit` as its own `Caller::Cockpit` token
lane. Existing help, markup, schedule, git, root and
web lanes keep their authorities and routes. These lanes share a listener,
not a token. Design: `docs/cockpit_mcp_plan.md`.

`tab_rename` changes the caller's own display label. The host
resolves its tmux session to exactly one saved agent tab at spawn and binds
the state directory, scope and persistent workspace id to its session.
Neither project nor tab ids are tool arguments. An unavailable saved identity
means no grant. `TerminalView` persists agent tabs before launching them so
new tabs have that identity; headless creation already saves before launch.
Attach-only tmux tabs are excluded to avoid ambiguous ownership.

`Settings::cockpit_mcp` is on when absent. Manage CLIs → Tabtivity tools has its switch
and `cockpit.mcp.rename` untested pill. The setting is read again for every
rename: off or unreadable settings refuses an existing token. Re-enabling
adds the tool to newly launched eligible agents. Claude and Codex use the
existing command-line MCP wiring; tool-enabled local Vibe models merge the
server into their MCP environment. Other CLIs receive no cockpit grant.
Tabby retains its pinned web/help set; remote, VM, container and reader tabs
are excluded by the same local-reach checks as the help lane. A local-only
tab can still qualify when its project runs elsewhere.

`label` is trimmed, nonempty and at most the phone's `MAX_TAB_LABEL` (120
characters); control and invisible formatting characters are rejected. The
phone shares this validator. `expectedLabel` optionally compares the stored
label inside the mutation lock. Unknown keys/types are rejected. Success
returns only the committed label and `renamed`/`unchanged`; failure is a fixed
category with no paths or storage details. Each spawn permits 30 calls per
rolling minute, including malformed calls. Writes are audited using the
existing bounded metadata-only audit ring, with no label text.

`workspace::rename_tab_id_in` applies the change under the existing session
file lock, checks revocation inside the lock, and stamps the workspace/tab
version. It preserves all other fields, including task titles, legacy shapes
and unknown fields. Equal labels do not write or advance the version. A
closed tab cannot be recreated by a late call; a reopened tab has another id.
Spawn replacement, failure, PTY exit and tab close use existing token
revocation, including cleanup of the cockpit token. The token is treated as
a launch control variable and a tmux secret carrier.

After commit the listener sends `Notice::Workspace`: a desktop/daemon emits
`workspace:patch`, and the Mobile host pokes the desktop's existing workspace
refresh bridge. Views re-read without changing focus or hydrating unloaded
scopes. A stale client sync adopts the newer saved label. Refresh is best
effort and does not change the outcome of a committed write. The phone's
catalog reads the same saved record. Hosted wiring shares the listener/core;
no claim of a live server test is made.

## Agent notes: activity and handoff

Plan: `docs/cockpit_mcp_extensions_plan.md` (fixed decisions, delivery steps
1-2). Pills `cockpit.mcp.activity` and `cockpit.mcp.handoff`.

**Storage.** `TabEntry.extra["cockpitMeta"]` = `{v: 1, revision, activity?:
{text, setAt, spawn}, handoff?: {summary, checks, remaining, setAt}, ...later
keys}`; `setAt` is the host's ms clock. Rust owns it in
`services::cockpit_meta` (typed with `serde(flatten)`, so a later build's keys
and unknown tab fields round-trip). The key is absent until the first write
and then stays (a clear leaves `{v, revision}`), so a revision is never
reused. Unreadable metadata (not an object, `v` other than 1, wrong field
type) refuses reads and writes (`storage_error`) with no write; the cap on the
object is 32 KiB of JSON (`too_large`, refused before mutation).

**Host-owned through the workspace merge.** `toSavedTabEntry` whitelists
fields, so a window never sends `cockpitMeta`. `workspace::merge` therefore
gives a kept tab the *held* copy's value (inserted or removed to match,
whatever the client sent, stale base or current) and strips it from a created
tab; `comparable` ignores the key, so a metadata-only difference is never a
client edit (no op, no write). `create_tab_in` strips it; the phone's
tmux-named edits are `edit_in` on the held tab and keep it; `reopen_tab_in`
keeps the handoff as a historical note and drops the activity;
`terminal_service` drops the key from a folder-adopted or bundle-imported
layout. `edit_in` stamps `updatedVersion` by the record *including* the
metadata, so a write moves the workspace version and a client with an older
base cannot overwrite the tab with its copy. Cost of that rule: a stale-base
client's real edit to the same tab, racing an agent's note write, is dropped
like any concurrent change and re-adopted from the answer.

**Tools** (shared 30/min per-spawn budget, `tab_get_info` and malformed calls
included; switch, binding and revocation rechecked per call, revocation and the
switch again inside the lock (`cockpit_mcp::guard`); fixed categories `rate_limited`, `unavailable`,
`invalid_request`, `conflict`, `tab_not_found`, `too_large`, `storage_error`;
`tab_rename` keeps `invalid_label`):

- `tab_get_info {}` -> `{status:"ok", label, revision, activity|null,
  activityExpired, handoff|null, activityTtlSeconds}`. Own tab only. Activity
  is returned only for this spawn's own line and only while under 30 minutes
  old; an expired own line reads `activity:null, activityExpired:true`.
- `tab_set_activity {expectedRevision, text|null}`: one line, 160 characters.
- `tab_set_handoff {expectedRevision, handoff: {summary, checks?, remaining?}
  | null}`: 1,000 characters per field, 3,000 total, ordinary newlines allowed.
- Setters answer `updated`/`unchanged`, the committed `revision` and the
  normalized value. `expectedRevision` is compared under the lock (`conflict`;
  absent metadata is revision 0). An identical handoff, a clear of nothing and
  the same *fresh* line from the same spawn write nothing and do not renew an
  expiry; after 30 minutes the same text is a change again.
- Text is trimmed, counted in characters, and rejects control characters and
  invisible/bidi formatting (`strip_invisible`). The new tools validate by
  hand: the shared validator counts bytes against `maxLength`, which would
  refuse ordinary non-Latin text. Unknown keys are refused.
- `tab_set_results {expectedRevision, results: [{label, relativePath}]}`: see
  Results below. `tab_get_info` also returns `results` (`{items, setAt,
  ageSeconds}` or null).
- Audit rows carry only the tool name and a fixed category (the policy names
  every tool; text is never recorded).

**Spawn generation.** `grant_cockpit` mints `Binding.spawn` (random, not
derived from the token, not secret). Activity stores it. At grant, after the
older token is revoked, `clear_other_spawns_in` removes activity from any other
spawn in one `edit_in` (nothing to clear writes nothing). PTY exit writes
nothing.

**Desktop.** `lib/cockpit/agentNotes.ts` validates and bounds what arrives
(restore from the saved record, `adoptSyncOutcome` reconcile on every
sync/patch answer, by `revision`), and decides what is current. The roster row
shows `.cockpit-roster-note` ("Agent says", plain text, relative age) only
when the row's machine is reachable (`!hostDown`) and the line is under 30
minutes old by the host stamp. The detail pane shows the handoff fold
(summary / checks reported / remaining, "written by the agent ... not
verified") whatever its age and whether or not the agent is live. Both are
React text, attributed, and separate from the detected state; they never
change a state, answer a question or open anything. `duplicateSpec` drops the
key.

**Limits (known).**

- "Live" is the roster's existing notion only: a restored agent whose PTY has
  not started, or whose process exited, is not distinguished from a running
  one. The 30-minute bound and the clear at the next grant cover it.
- The grant-time clear has no notifier, so an already-open window shows the
  previous spawn's fresh line until its next workspace sync or patch (any
  save moves it).
- The project-tree export copy of the layout (`.tabtivity/sessions`) carries
  the notes like any other tab field.
- Phone presentation is a later plan step (attention and milestones: see delivery step 5 below).

## Result references (delivery step 3)

Plan decisions 9-13 in `docs/cockpit_mcp_extensions_plan.md`; pill
`cockpit.mcp.results`. Code: `services::cockpit_results` (+ `cockpit_meta`
for storage), `commands/cockpit_results.rs`, `lib/cockpit/openResult.ts`,
`components/cockpit/CockpitResults.tsx`.

**Storage.** `cockpitMeta.results = {items: [{label, relativePath}], setAt}`,
same revision / no-op / conflict rules as the handoff. At most 8 items, labels
120 characters (same plain-line validator as a tab label), paths 512; counted
in characters. A clear is `results: []`; clearing nothing and an identical list
(same order) write nothing. It persists like the handoff (a reopen and a spawn
change keep it; the 32 KiB cap on the object still applies). A stored `results`
of another shape makes the metadata unreadable (`storage_error`, no write).

**Which projects (decision 10).** `cockpit_results::project_root` reads the
registry file in the binding's state dir (`projects.json`, never an in-folder
`project.json`). No root, so `unavailable` for any `tab_set_results` call (a
clear included): the root scope and other reserved ones, `box:` scopes, ids not
in the registry, a record with a `remote` spec (`remote::spec_from_entry`, the
oracle `remote_target_for` uses - never the path's shape; remote-only too), a
record with `compute_hosts` (worker-hosted), a `vm` record, and a folder that is
not an absolute, existing directory. This runs before the items are looked at.

**Publish-time checks (decision 11).** `clean_path` is lexical and keeps the
text as given (no trimming): a forward-slash path of plain names. Refused:
empty, absolute (`/x`), UNC (`//h/s`), any `:` (drive letters, URI schemes,
NTFS streams), backslashes, `.`/`..`/empty segments (a trailing `/` too:
folders are not linked), segments ending in a dot or space, Windows wildcard
characters and device names (`NUL`, `COM1`...), the app's own project folder,
control and invisible/bidi characters. Then `reach` resolves the target with
`paths::canonical_or_new` (the `fs_confine` rule: a link is judged by where it
leads, a dangling one by where it points, a missing path by its nearest
existing ancestor) and compares with the canonical project folder:
`Outside` -> `invalid_request` for the whole call; `Missing` is accepted. Only
stat/canonicalize run - no content read, no preview, nothing generated or sent.
`fs_confine`'s read path (`confine_abs_within`/`open_confined`) already judges
an in-root link by its real target, so a link out of the root is refused there
too; the difference this module adds is that the boundary is the project folder
alone, not the project plus its box siblings (`allowed_roots`).

**Open (decision 12).** The window never sends a path. `cockpit_result_target
{scope, tabId, index, revision}` (async over a blocking body; command class
`client`) reads the saved tab, refuses a changed list (`stale`, by the revision
the window drew), takes item `index` of the *stored* list, finds the root again
(`unavailable` if the project stopped being local or the folder is gone), checks
that the root is not reached through a planted link, re-runs `clean_path` and
`reach` (`refused` when it now resolves outside, e.g. a file replaced by a
link), then looks the file up with the viewers' own `resolve_text_paths` (metadata
only; a folder or a vanished file is `unavailable`). The window opens `status:
"open"` through `openPathLink` (an in-app viewer tab in the tab's own scope, a
Back button to the agent tab, no OS default app) and then shows it
(`jumpToTab`, overlay closed). The viewer's own reads stay confined by
`fs_confine::allowed_roots`/`open_confined`, so a swap after the check still
cannot read outside the project's roots.

**Desktop.** `readCockpitMeta` keeps all of a list or none (a click names an
item by its index). `CockpitResults` is a second fold under the handoff: plain
React text (button label, path), "Listed by the agent {ago}", no anchors or
hrefs. Drawing it asks the host for nothing. "Unavailable" (and the refused /
stale / no-viewer notes) appears beside an item only after a click that opened
nothing, and is forgotten when the revision changes.

**Limits (known).**

- A missing file is shown as unavailable only after a click: drawing does no
  stat of its own, so a file that never existed looks like the others until
  clicked.
- A dangling link whose target resolves inside the project is accepted like a
  missing file; a link cycle resolves nowhere and counts as outside.
- The check and the viewer's read are two steps; the viewer's `open_confined`
  re-walks the path without following a swapped-in link, but a file replaced by
  another in-project file in between opens that one.
- Phone presentation of results is a later run (shared projection with activity
  and handoff).

Not live-verified. The implementation never starts or stops the app. Keep the
untested pill until the user confirms the platform-specific click-throughs
in `todo/group-s-agents.md`.

## Structured reports (delivery step 4)

Plan decisions 14-17; pills `cockpit.mcp.progress`, `cockpit.mcp.blocker`,
`cockpit.mcp.verification`. Code: `services::cockpit_meta` (storage, validators,
`apply`), `mcp/cockpit_mcp.rs` (tools), `lib/cockpit/agentNotes.ts`,
`lib/cockpit/roster.ts::rosterNote`, `components/cockpit/CockpitReports.tsx`.
Same revision CAS, no-op, fixed refusals, shared 30/min budget and 32 KiB cap
as the other notes. Validation is by hand in `cockpit_meta` (characters, not
bytes; exact key sets; unknown keys refused).

**Storage.** `cockpitMeta.progress = {steps: [{id, label, state}], setAt,
spawn, ended?}`, `blocker = {text, setAt, spawn}`, `verification = {entries:
[{label, outcome, note?}], setAt}`. A stored value of another shape (an unknown
`state` or `outcome`, a non-object) makes the metadata unreadable
(`storage_error`, no write), like results.

- `tab_set_progress {expectedRevision, steps}`: at most 8 steps; `id` 1-40 of
  `[a-z0-9_-]`, unique; `label` one plain line, 120 characters; `state`
  `pending|active|done`, at most one `active`. `[]` clears. The same steps from
  the same spawn that are still fresh and not `ended` are a no-op; otherwise a
  republish is a change with a new `setAt`.
- `tab_set_blocker {expectedRevision, text|null}`: one plain line, 300
  characters. Transient like the activity: the same fresh text from the same
  spawn does not renew its expiry.
- `tab_set_verification {expectedRevision, entries}`: at most 8; `label` one
  line, 120; `outcome` `passed|failed|pending|not_run`; `note` optional, 300,
  newlines allowed (CRLF folded, an empty note is none; `null` is refused).
  `[]` clears; an identical list is a no-op and keeps the report time.
- `tab_get_info` also returns `progress` (always: `{steps, setAt, ageSeconds,
  current}`, `current` = this spawn's, not `ended`, under 30 minutes),
  `blocker` (this spawn's, fresh only) with `blockerExpired`, and
  `verification` (`{entries, setAt, ageSeconds}`).

**Spawn generation (decisions 14/15).** `clear_other_spawns_in` (at grant) now
removes another spawn's activity *and* blocker and marks another spawn's
progress `ended: true`, in one `edit_in` (one revision bump; nothing to change
writes nothing). `reopen_tab_in` does the same for the reopened (new) tab via
`drop_transient`. Progress is *kept* as history: the `ended` mark is the host's
way to tell the window the report is not the current run's, because the
mirror deliberately has no spawn nonce (the window cannot know which spawn is
current). Verification, like the handoff, is untouched.

**Desktop.**

- `readCockpitMeta` keeps progress and verification all or nothing, bounds the
  text, drops `spawn`, keeps `ended`.
- `rosterNote` (roster subtitle): a live blocker (roster-live, under 30
  minutes) replaces the activity line; otherwise the activity line. The blocker
  row has the "Agent reports blocked" tag and the `cockpit.mcp.blocker` pill.
  It never touches `row.state`, `rosterCounts`, the Needs-you list or sorting.
- `CockpitReports.tsx`, below the results: progress, blocker, verification.
  Progress `running` (`progressReport`) only for a roster-live agent, an
  `ended`-unset report under 30 minutes old; anything else is titled "(past
  report)", "Past report from <ago>", and its active step reads "was in
  progress". No spinner or animation either way (static words). Verification
  says "Reported by the agent at <time> (<ago>). <app> did not run or check
  these." and never "verified". All React text; `white-space: pre-wrap` for
  notes.

**Limits (known).**

- As with the activity, "live" is the roster's `!hostDown` only; a progress
  report of the current run that was left running reads as running until it is
  30 minutes old, and an already-open window shows the previous spawn's
  `ended`/blocker change only after its next workspace patch (the grant-time
  write has no notifier).
- Worst-case multi-byte text in every field can pass 32 KiB (CJK at every
  bound is about 45 KiB); the write that would cross the cap is refused
  (`too_large`) unwritten, so the agent has to clear a bulkier note first.
- Phone presentation is a later step.

## Attention and milestones (delivery step 5)

Plan decisions 18-22; pills `cockpit.mcp.attention`, `cockpit.mcp.milestones`.
Code: `services::cockpit_meta` (`Attention`, `Milestone`, `Change::Attention` /
`Change::Milestone`, `dismiss_in`), `mcp/cockpit_mcp.rs`,
`commands/cockpit_results.rs::cockpit_attention_dismiss`,
`lib/cockpit/agentNotes.ts` / `attention.ts` / `decisions.ts` / `tonight.ts`,
`CockpitRail.tsx` (`AgentAskRow`), `CockpitReports.tsx`, `CockpitTonight.tsx`.

**Storage.** `cockpitMeta.attention = {id, question, setAt, spawn, dismissed?}`
and `milestones = [{requestId, text, at}]` (oldest first, newest last). A stored
value of another shape makes the metadata unreadable (`storage_error`, no
write). Both count toward the 32 KiB cap (all notes full in ASCII fit, about
20 KiB).

- `tab_request_attention {expectedRevision, question|null}`: one question, 500
  characters, newlines allowed, trimmed, no control or bidi characters; unknown
  keys (options, answer...) refused. The host mints the `id` (128-bit hex) in
  the handler, used only when the question is new. The same text from the same
  spawn is a no-op while it is open (under 24 h) *and* once dismissed, at any
  age: a retry cannot resurface a dismissed question (only a changed text, or
  an agent clearing it with `null` first, makes a new item - noted below). A
  text that lapsed unanswered is asked again with a new id and stamp. `null`
  clears. Answers `updated`/`unchanged`, `revision` and `attention` (`id`,
  `question`, `setAt`, `dismissed`).
- `tab_add_milestone {requestId, text}`: `requestId` 1-64 of `[A-Za-z0-9_-]`,
  `text` one plain line, 200 characters; exactly those two keys (an
  `expectedRevision` is refused). Append-only: `update_in` skips the revision
  compare for `Change::Milestone`. A `requestId` already among the retained
  entries changes nothing and returns that entry (`unchanged`, even with
  different text); the 21st entry drops the oldest. A new one bumps the metadata
  `revision` (the windows adopt by revision), so an agent must re-read
  `tab_get_info` before its next `tab_set_*` (the tool says so).
- `tab_get_info` also returns `attention` (this spawn's own, under 24 h, with
  `ageSeconds` and `dismissed`), `attentionExpired` and `milestones` (all kept,
  oldest first).

**Lifecycle (decision 18).** `retire_other_spawns` removes another spawn's
question (grant: `clear_other_spawns_in`; reopen: `drop_transient`), one
`edit_in`, one revision bump, nothing written when there is nothing to remove.
The window has no spawn nonce and needs none: the question is *removed*, not
marked, so a restarted agent's question disappears at the next workspace
patch/sync (the same missing-notifier limit as the activity line). The window
also hides a question older than 24 h by the host stamp. Milestones are history
and survive grant and reopen; a closed tab takes both with it.

**Dismissal (decision 20).** `cockpit_attention_dismiss(scope, tabId,
attentionId)` (async over a blocking body, class `client`, row in
`services::command_class`, `commandClasses.ts` regenerated) calls
`cockpit_meta::dismiss_in`: under the `edit_in` lock it sets `dismissed` only if
the stored attention id equals the one the window drew, and bumps the revision;
answers `dismissed`, `unchanged` (already dismissed) or `stale` (a different id,
none, an empty or over-long id: nothing written). A closed tab is
`tab_not_found`, unreadable metadata fails unwritten. The window then calls
`refreshWorkspaceScope(scope)` to adopt the new revision. A client cannot author
`dismissed`: `workspace::merge` hands a kept tab the held copy whatever it sent
(tested with a forged `dismissed`).

**Desktop.**

- `readCockpitMeta` keeps `attention` (id `[A-Za-z0-9_-]{1,64}`, question
  <= 500, `dismissed` only for a literal `true`; `spawn` dropped) and
  `milestones` (bad entries dropped, the newest 20 kept).
- `currentAttention` = open (host stamp, under 24 h, not from the future) and
  not dismissed; `openAttention` also returns a dismissed one (detail pane).
- `buildDecisions` has the group `agentAsks` right after `asking`
  (`DECISION_GROUPS`), newest first. A row whose app-detected state is
  `question` is excluded: **the detected state wins**, so the tab is counted
  once. A working or interrupted tab's question is listed (and an interrupted
  tab then appears in both groups, a rule the plan only defines against
  `asking`). It never changes `topAsking`, so the detail pane is not hijacked.
- `cockpitBadge` adds `agentAsks` (same dedup: detected `decision` and not busy
  wins) to `total`; it reads the tabs already in the store, so there is no read
  and no clock while the rail is closed (`now` defaults to `Date.now()` at the
  derivation; an expiry shows at the next re-derivation, not on a timer). The
  header tooltip names the count.
- `AgentAskRow`: the tab (click = the same `onPick` as an asking row: Now
  selects it, Root's rail jumps), the question as clamped plain text, Dismiss,
  the pill. The popover renders the same `CockpitRail`. The detail pane's
  `CockpitAttention` (above the handoff) shows the open question with Dismiss,
  or the dismissed one muted. Nothing answers, approves, sends a prompt, plays a
  sound or raises an OS notification.
- `CockpitMilestones` (below verification): newest first, the host's time,
  "Reported by the agent". `buildAway` adds `milestones` (`at` after the away
  window's start and not from the future; newest first across tabs, `empty`
  counts them); Tonight lists them under "Milestones reported by agents" with
  an "agent-reported" tag. The rows come from the roster inputs Tonight already
  has, so no extra load.

**Limits (known).**

- Clearing with `null` and asking the same text again makes a new item, even
  after a dismissal: the plan blocks a retry, not an agent that clears first.
- Like the activity, a restarted agent's removed question leaves an open window
  only at its next workspace patch/sync.
- "Live" is not consulted for attention: a question stays for 24 h even if the
  agent process exited (until restart, dismissal or close).
- Phone presentation is a later run.

Not live-verified; the implementation never started or stopped the app. Keep
the pills until the user confirms the click-throughs in
`todo/group-s-agents.md`.

`AppToolsSettings` groups cockpit, help, schedule, git and markup controls
under the localized app-tools heading. Root-console and assistant web entries
link to their existing settings pages; their permissions and review controls
remain independent. The help switch shares `help_mcp` with the intro.

New conversations are instructed to shorten their first task title once with `tab_get_info` and `tab_rename` (2–5 words, ideally under 32 characters), passing `expectedLabel`. Custom and resumed titles stay. Other CLIs use the shared first-prompt fallback on the phone; desktop labels stay as their CLI names.
