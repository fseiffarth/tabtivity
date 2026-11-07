# Cockpit MCP — useful self-only metadata

Status: delivery steps 1-3 implemented 2026-11-06 (metadata foundation,
`tab_get_info`, `tab_set_activity`, `tab_set_handoff`, desktop roster subtitle
and detail handoff; step 3: `tab_set_results`, project gate, publish- and
open-time containment checks, desktop results fold), step 4 (2026-11-06:
`tab_set_progress`, `tab_set_blocker`, `tab_set_verification`, roster blocker
line, detail progress/blocker/verification sections) and step 5 (2026-11-06:
`tab_request_attention` with the Needs-you group, dismissal command and badge,
`tab_add_milestone` with the detail list and the Tonight recap) implemented;
never live. As built and limits: `docs/context/cockpit_mcp.md`. Phone
presentation (including results, the step 4 reports, attention and
milestones) is not started.
Builds on `docs/cockpit_mcp_plan.md` and the implemented rename lane described
in `docs/context/cockpit_mcp.md`.

## Fixed decisions (plan review, 2026-11-06)

Reviewed against the uncommitted v1 (`services/mcp/cockpit_mcp.rs`,
`workspace::rename_tab_id_in`, `workspace::merge`, `tabs.ts::toSavedTabEntry`).
These override vaguer wording below; implementers may not reopen them.

1. **Field name and shape.** `TabEntry.extra["cockpitMeta"]`:
   `{v: 1, revision, activity?: {text, setAt, spawn}, handoff?: {summary,
   checks, remaining, setAt}, …later keys}`. `setAt` is host ms since epoch.
   Absent key = no metadata. Rust owns the type in `services::workspace`
   (or a small sibling module it calls); TS mirrors it read-only.
2. **Merge ownership is the blocking fix.** `toSavedTabEntry` whitelists
   fields, so a desktop sync never carries `cockpitMeta`; with today's
   `merge`, any sync after the client adopted the write replaces the tab with
   the client copy and erases the metadata. In `workspace::merge`: a kept tab
   always takes the held tab's `cockpitMeta` (insert or remove to match),
   whatever the client sent; a created tab has it stripped; `comparable`
   ignores the key so a metadata-only difference is never a client edit.
   Same for `create_tab_in` (strip) and the phone/headless edit paths.
   Regression tests: stale and current-base client syncs both keep it; a
   client that sends a forged `cockpitMeta` cannot author or change it.
3. **Spawn generation.** `grant_cockpit` mints a random nonce into
   `Binding.spawn` (not derived from the token). Activity stores it. At grant
   time, under the lock, clear transient fields whose `spawn` differs (one
   write, only when present) — that is "spawn replacement clears activity".
   Reads and renders additionally hide activity older than 30 min (host
   `setAt` vs now). The nonce is not secret; no "host-only" stripping.
   PTY exit writes nothing; the UI hides activity for a tab whose agent is
   not live (existing roster state).
4. **Revision.** `revision` is a counter inside `cockpitMeta`, starting at 0
   when absent. Every actual change bumps it and goes through `edit_in` (so
   the workspace version and `updatedVersion` move too). Setters require
   `expectedRevision`; mismatch → `conflict`. `tab_rename` stays unchanged.
5. **Refresh.** Generalize `refresh_patch` from `status == "renamed"` to any
   committed change (`renamed` | `updated`).
6. **Rate budget.** The existing per-spawn 30/min `admit_cockpit_rate`
   covers every tool, `tab_get_info` included.
7. **First implementer run = delivery steps 1–2 only** (foundation,
   `tab_get_info`, `tab_set_activity`, `tab_set_handoff`, desktop cockpit
   roster subtitle + detail notes). Phone presentation, results (step 3) and
   steps 4–5 are later runs. Untested ids this run: `cockpit.mcp.activity`,
   `cockpit.mcp.handoff`.
8. **Where it runs.** v1 is uncommitted and the working tree holds other
   sessions' edits, so the implementer works in the main tree, touches only
   its own files, and does not commit; the user commits.

### Step 3 decisions (2026-11-06)

9. **Tool.** `tab_set_results({expectedRevision, results: [{label,
   relativePath}]})`; an empty list clears. Stored as
   `cockpitMeta.results = {items, setAt}`, same revision/no-op/conflict rules
   as the other setters. It persists across restarts like the handoff.
10. **Which projects.** Only a registered project whose files are on this
    machine: root comes from the trusted registry (`projects.json`) for the
    binding's scope, and remoteness from `services::remote`
    (`remote_target_for…`), never from the path. Root scope, boxes, remote
    or worker-hosted projects → `unavailable`.
11. **Publish-time check.** Lexical: reject empty, absolute, drive/UNC,
    `..` segments, URI schemes, backslash forms, control/invisible chars.
    Then containment against the project root with `services::fs_confine`
    semantics (stat/canonicalize only, never a content read). A missing
    target is accepted (shown "Unavailable" later); a symlink resolving
    outside the root is refused (`invalid_request`).
12. **Open-time check.** Click only, never automatic. Re-check containment
    at open on the host, then open through the existing viewer path
    (`src/lib/terminal/pathLinks.ts::openPathLink` / `ProjectFilesView`
    policy). If that needs a backend check, add one narrow async command
    (classify it `client` in `services::command_class`, regenerate
    `commandClasses.ts`) taking the tab's scope + saved tab id + item index,
    never a path from the renderer.
13. **Desktop only.** Phone presentation of activity, handoff and results is
    one later run, sharing a single projection. Untested id this run:
    `cockpit.mcp.results`.

### Step 4 decisions (2026-11-06)

14. **Progress.** `tab_set_progress({expectedRevision, steps: [{id, label,
    state}]})`, empty list clears. ≤ 8 steps; `id` 1–40 chars of
    `[a-z0-9_-]`, unique; `label` ≤ 120; `state` ∈ `pending|active|done`, at
    most one `active`. Stored `progress = {steps, setAt, spawn}`. Persists as
    history: from an older spawn or older than 30 min it renders as a past
    report ("was in progress"), never as running — no spinner, no live state.
15. **Blocker.** `tab_set_blocker({expectedRevision, text | null})`, ≤ 300
    chars, single line. Transient exactly like activity: `{text, setAt,
    spawn}`, hidden after 30 min / other spawn, and cleared at grant by the
    same `clear_other_spawns_in` pass. The roster subtitle shows a live
    blocker in place of the activity line, marked as agent-reported. It does
    not touch the Needs-you count or app-detected states (step 5 owns
    attention).
16. **Verification.** `tab_set_verification({expectedRevision, entries:
    [{label, outcome, note?}]})`, empty list clears. ≤ 8 entries; `label` ≤
    120; `outcome` ∈ `passed|failed|pending|not_run`; `note` ≤ 300, newlines
    allowed. Stored `{entries, setAt}`; persists. The UI says "reported by the
    agent at <time>", never "verified" or a run time.
17. **Shared rules.** Same revision CAS, no-op, fixed refusals, 30/min budget
    and the 32 KiB whole-`cockpitMeta` bound. `tab_get_info` returns all three
    (blocker only when live and fresh). Desktop detail pane only, below
    results. Untested ids: `cockpit.mcp.progress`, `cockpit.mcp.blocker`,
    `cockpit.mcp.verification`.

### Step 5 decisions (2026-11-06)

18. **Attention.** `tab_request_attention({expectedRevision, question |
    null})`, one question ≤ 500 chars, newlines allowed, no options/answer
    payload. Stored `attention = {id, question, setAt, spawn, dismissed?}`;
    `id` is a host-minted random id, new for every changed question (an
    identical text while one is open is a no-op; an identical text after a
    dismissal is refused `unchanged`/no-op too — a dismissed question cannot
    be resurfaced by a retry). Live only while its spawn is current and
    under 24 h; cleared at grant by `clear_other_spawns_in`; a closed tab
    loses it with the tab.
19. **Needs-you.** `src/lib/cockpit/decisions.ts::buildDecisions` gets one
    new group (e.g. `agentAsks`) fed from live, undismissed attention.
    A tab already in `asking` (app-detected `question` state) is counted
    once, not twice — the app-detected state wins. Same badge path
    (`cockpitBadge`), no new reads while the rail is closed, no sounds or
    OS notifications. Clicking opens that tab's conversation exactly like an
    `asking` row; it never answers or approves anything.
20. **Dismissal.** The user dismisses from the Needs-you popover / detail
    pane through one narrow async Tauri command (scope, saved tab id,
    attention id) that sets `dismissed` under the `edit_in` lock only if the
    id still matches; class `client` in `services::command_class`,
    `commandClasses.ts` regenerated. No whole-document save. Merge
    ownership (decision 2) already keeps clients from reviving it.
21. **Milestones.** `tab_add_milestone({requestId, text})`, `requestId`
    1–64 chars `[A-Za-z0-9_-]`, `text` ≤ 200 single-line. No
    `expectedRevision` (append-only); a `requestId` already among the
    retained entries is a no-op returning the existing entry. Stored
    `milestones = [{requestId, text, at}]`, host `at`, newest last, capped at
    20 (oldest dropped). Shown in the detail pane, and in Tonight's
    "While you were away" recap (`tonight.ts::buildAway`) for entries with
    `at` inside the away window, labelled as agent-reported.
22. Untested ids: `cockpit.mcp.attention`, `cockpit.mcp.milestones`.
    Desktop only; phone follows in the shared phone run.

## Intended experience

An agent can explain what it is doing, leave a useful handoff, and point to
its results. The cockpit shows these beside the agent's existing activity
signals. The user can scan active work and recover context after time away.

Example: a tab named “Keyboard navigation” shows “Checking narrow-window
behavior.” Later its detail pane holds a handoff, a screenshot link, and
“Tests passed; live desktop check pending,” explicitly attributed to the agent.

Keep the first delivery small: activity subtitle, handoff note, result links,
and the read-own-metadata tool needed to update them reliably. Follow with
progress, blockers, verification, attention cards, and milestones.

## Authority and behavior

All tools use the existing `/mcp/cockpit` lane and the caller's spawn-bound
saved tab identity. No caller-supplied scope, project, tab, tmux target, or
generation. Preserve current eligible CLI/host restrictions and the assistant's
pinned tools. Root agents receive the same self-only metadata authority.

The current rename switch governs the extended lane; revise its localized
description to explain the new capabilities. Recheck the switch, identity,
live generation, and revocation for every read and write, including inside
the mutation lock. Keep fixed refusal categories and metadata-only audits.
The existing 30-call/minute spawn budget covers all tool calls, including
invalid requests. Recommend updates at meaningful transitions, never token
streaming or heartbeat calls.

Metadata is agent-authored content. Render bounded plain text, visibly separate
from app-observed working, question, interrupted, and finished states. Metadata
cannot assert approval, verified safety, or app-confirmed success. It never
changes those states, executes work, answers questions, sends prompts, switches
focus, or opens files automatically. No cross-tab enumeration or counts.

## Proposed tools

Names and bounds below are implementation targets. Validate schemas strictly,
reject unknown keys, and return only the caller's metadata and fixed outcomes.

| Tool | Contract | Initial bounds |
|---|---|---|
| `tab_get_info` | Return own display label, metadata revision, current metadata, and freshness. | No terminal content, credentials, storage paths, or other tabs. |
| `tab_set_activity` | Replace own activity subtitle; `null` clears it. | 160 characters; expires after 30 minutes or spawn replacement/exit. |
| `tab_set_handoff` | Replace `{summary, checks, remaining}`; `null` clears it. | 1,000 characters per field, 3,000 total. |
| `tab_set_results` | Replace own list of `{label, relativePath}` references. Empty list clears. | 8 references; 120-character labels; 512-character paths. |
| `tab_set_progress` | Replace ordered `{id, label, state}` steps. | 8 steps; 120-character labels; `pending`, `active`, `done`; at most one active. |
| `tab_set_blocker` | Replace a short explanation; `null` clears it. | 300 characters; transient like activity. |
| `tab_set_verification` | Replace bounded `{label, outcome, note}` entries. | 8 entries; 120-character labels, 300-character notes; `passed`, `failed`, `pending`, `not_run`. |
| `tab_request_attention` | Replace own outstanding question; `null` clears it. | One 500-character question; no answer payload or action arguments. |
| `tab_add_milestone` | Append `{requestId, text}` with a host timestamp. | 20 retained entries; 200-character text; bounded deduplication by request id. |

New setters take a required `expectedRevision`, obtained from `tab_get_info`.
Check it under the same lock as the write and return `conflict` on mismatch.
Return `updated` or `unchanged`, the committed metadata revision, and the
normalized changed value. Keep the existing `tab_rename` contract compatible.
The metadata revision is independent of ordinary workspace version changes.
Identical replacements are no-ops; repeated transient text does not renew its
expiry. Stale activity can be republished explicitly after reading freshness.

Use host timestamps for updates and expiry. Do not accept fabricated run
times or percentages. Verification entries are statements by the agent;
record when they were reported, without claiming when a test actually ran.
Shared validators allow international text, reject invisible/bidi formatting,
and allow ordinary newlines only in multiline notes. Bound the total stored
metadata to 32 KiB; reject overflow before mutation, accounting for JSON size.

## Persistence and lifecycle

Add a versioned, namespaced metadata field to the authoritative saved tab
record, owned by `services::workspace`. Extend its locked stable-id patch
helpers rather than writing session JSON from MCP. Preserve legacy shapes,
unknown fields, task titles, labels, and every unrelated tab field. Corrupt or
unreadable state must fail without a replacement write.

Make metadata host-owned during workspace reconciliation: stale desktop or
phone snapshots cannot erase it, and generic browser saves cannot author it.
Each actual mutation advances the tab/workspace version and metadata revision
atomically. User dismissal of attention uses the same narrow revisioned patch
path. Choose and document the metadata field name before implementing the
schema and merge rules together.

Activity, blocker, and attention are tied to the issuing spawn generation.
Expired or previous-generation values are absent from current UI and reads;
keep generation markers host-only. Expiry is evaluated on read/render using
existing visible-view clocks, without periodic persistence or a new poller.
Keep handoff, results, verification, and progress through restoration as
historical agent reports, with their original timestamps. Old progress must
not look like a currently running task. Milestones form a bounded history.

Closing a tab invalidates writes and removes its active attention. Existing
closed-tab retention may retain bounded historical notes; reopening has a new
identity and no live activity or attention. Spawn replacement revokes old
tokens before a new agent can write. No late call can recreate a closed tab.

Reuse post-commit workspace refresh hints, desktop workspace patches, and the
headless host's cross-process bridge. Refresh delivery failure does not undo a
successful write. Views derive rows from the authoritative tab data; the
cockpit UI store continues to hold only selection/filter/layout state.

## Result links

Begin with files inside the caller's registered local project. Resolve the
project root from trusted host registry state, never an in-folder config.
Accept a project-relative path as a reference, not a capability to read files.
Reject absolute paths, parent traversal, URI schemes, network paths, and
symlink escapes. Revalidate containment at open time using existing guarded
file-viewing helpers; account for file replacement between publish and open.

Publishing a reference reads no file content, creates no preview, launches no
external program, and transfers nothing to a phone. The user explicitly opens
it through existing viewer policy. Missing files show “Unavailable” without
triggering generation. Render labels as text; never interpret HTML or command
links. Phones use existing authorized file delivery/viewing flows.

For root tabs without a registered project, return `unavailable` for results
until an existing, scope-authorized inbox/reference mechanism is verified and
specified. Do not broaden this tool to arbitrary host paths. External URLs,
directory links, executable launching, and result uploads are deferred.

## Cockpit and phone presentation

Show the activity subtitle as a secondary roster line. Put the handoff,
results, progress, blockers, and verification in the selected agent's detail
area, with localized attribution and relative update times. Keep the real
Reader/composer and current state precedence intact. Test all three existing
frame width bands and ordinary/root/popout ownership rules.

Attention appears in the existing Needs-you presentation and opens that tab's
conversation. It never creates an approval or supplies an answer. Dismissal
records a revision so client refreshes do not resurrect the same question.
A revised question is a new attention item. Deduplicate the count with an
already detected question from the same tab; use the existing decision and
badge derivations, without reads while the rail is closed. A dismissed question
cannot be resurfaced by an identical retry. Attention expires with its spawn
or after 24 hours; no sounds or OS notifications in this delivery.

Surface milestone history in the detail pane and, where appropriate, the
existing “While you were away” list. Host timestamps and bounded retention
prevent an unbounded activity feed. Share the metadata projection with phone
cards; avoid separate desktop and phone definitions of freshness or status.

## Delivery sequence

1. **Metadata foundation and own-context read.** Define Rust/TS types,
   schema version, bounds, revision semantics, workspace merge ownership,
   lifecycle/freshness, and `tab_get_info`. Add focused contract tests before
   exposing any new writes. Confirm desktop and headless host convergence.
2. **Activity and handoff.** Add their setters, roster subtitle, and detail
   notes. Deliver value independently of later features. Register localized
   `UntestedTag` ids `cockpit.mcp.activity` and `cockpit.mcp.handoff`.
3. **Result references.** Verify guarded open behavior, add the bounded setter
   and explicit viewer links, then phone presentation through its existing
   authorized route. Register `cockpit.mcp.results`.
4. **Structured reporting.** Add progress, blocker, and verification setters
   and detail presentation. Tag each feature separately. Keep historical
   reports distinct from current detected activity.
5. **Attention and history.** Integrate the attention setter/dismissal,
   same-tab question deduplication, and bounded milestones. Test badge counts,
   existing seen behavior, and Tonight's visible-view loading rules. Tag each
   feature separately.
6. **Documentation and delivery.** Update only affected filemap rows,
   `docs/context/cockpit_mcp.md`, cockpit context, and matching help sections.
   Record implementation tasks in `todo/group-s-agents.md`; manual acceptance
   boxes get Works/Doesn't-work children for Linux X11, Linux Wayland, Windows,
   and macOS. Keep pills until the user confirms each feature is tested.

Likely integration points: `src-tauri/src/services/mcp/cockpit_mcp.rs`,
`services/workspace.rs`, `services/root_mcp.rs`, its security policy/tests,
`commands/root_mcp.rs`, workspace reconciliation in `src/stores/tabs.ts`,
`src/lib/agents/agentRoster.ts`, the cockpit roster/detail/decision/tonight
models and components, and the phone's existing roster/catalog projection.
Inspect the current implementations before reshaping any of them. New browser
mutations must be narrow patches/CAS; classify and regenerate command classes
for any new Tauri command. Services remain AppHandle-free.

## Verification and acceptance

Backend tests cover self-only targeting, strict schemas and bounds, disabled
and revoked access, replacement generations, read/write quotas, concurrent
updates, compare-and-swap conflicts, no-ops, expired metadata, corrupt-state
preservation, legacy/unknown-field round trips, stale-client merges, and
close-versus-write races. Result tests cover traversal, symlink escapes,
platform-specific path forms, and changed/missing targets at open time.

Frontend tests cover attribution, freshness, restored history, question count
deduplication/dismissal, text escaping, and scope/selection stability during
refresh. Phone checks cover the same projection without extra authority.
Keep Rust tests portable and verify the library without desktop features.

Run `scripts/gates.sh` in the background for the entire touched diff and
`git diff --check`. After implementation changes the backend, run
`npm run backend:stale` and report its result. Do not start, stop, or restart
Tabtivity. User live acceptance, once the backend is applied: publish metadata
from an eligible agent; observe desktop/cockpit/phone convergence; switch and
restore scopes; open a result explicitly; dismiss attention; replace and close
the agent; confirm stale calls cannot change or resurrect its tab. Record
platform results only where actually checked.
