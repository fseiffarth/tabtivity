# Headless owner — the desktop's live state moves into the sidecar

*Split out on 2026-09-29 from
[`tabtivity_hosted_plan.md`](tabtivity_hosted_plan.md) (§1 decision 3, §3.4, P0
and P1), because every step pays off on the desktop whether or not a server
ever ships. File references were measured at `923e0202`; re-verify before
building on one.*

*Status: **H0 landed** (2026-09-29, never live-verified): `write_json_atomic`
fsyncs the parent directory (#172); `calendar.json` writes are
compare-and-swap on a file `rev` with per-record `rev`s (#171,
`commands::calendar::transact`); the sidecar answers `Todo`, `Calendar`,
`Schedules`, `Prompts` and `AgentTranscript` off the state dir when the
window is closed (`services::mobile_control::headless`), flagged
`desktop_available: false` and read-only.*

*Status: **H1 landed in part** (2026-09-29, never live-verified).
`services::workspace` is the group-0 owner: the session file carries a
version and every tab a stable `id`; the desktop syncs through
`workspace_sync` with the version it last saw and the service merges only
what that client changed (a tab another client opened survives, a close it
never saw stands — the two-client test in `workspace.rs`); `save_tab_layout`
is refused once a scope is versioned; settings and boxes are
compare-and-swap on a `rev`. Chosen against the plan and why: (1) the owner
is the versioned file plus its lock rather than the sidecar process — the
sidecar only runs while Mobile is enabled, and both processes run the same
`AppHandle`-free service, so no owner has to be alive; (2) ops are derived
by the service from the client's snapshot against its base version instead
of being sent one by one, so the tab store's internals stay and the wire
shape is `toSavedTabEntry`'s; (3) tmux names are still minted client-side
and the default tmux socket stays — `-L eldrun` would hide every live
session from a window that had not restarted, and owner-side spawning needs
a detached `tmux new-session` path `pty_spawn` does not have; (4) the
per-client layout is split at the API (`groups`/`sessions`/`active_tab_index`
are the client's fields the merge never reads), not into a second file;
(5) default apps keep their whole-document save (a bare map with nowhere to
hold a revision); (6) `Catalog`/`Activity`/`GitStates` are still the
window's.*

*Status: **H1b landed** (2026-09-29, never live-verified), which completes
what H1 meant: per-tab `updatedVersion` (a change written after a client's
base is kept over that client's stale copy); the desktop's `workspace:patch`
listener (`WorkspacePatchHost` → `applyWorkspacePatch`; `adoptSyncOutcome`
takes a newer label/colour and drops a sent tab closed elsewhere); the
owner mints a created tab's tmux name and schedule binding
(`workspace::create_tab_in`, idempotent per request) and **spawns it**:
`pty_spawn`'s launch assembly moved into `services::launch_prep::prepare`,
shared by the window and the Mobile sidecar, whose headless create starts
the session detached (`tmux_local::spawn_detached_with`) on the **default
tmux socket** — kept, against the plan's `-L eldrun`: sessions cannot move
between tmux servers, so a switch would need a union of two servers at every
touch point (list, kill, rename, attach, capture, discovery, the fence's
live check) while a window that had not restarted kept spawning on the
old one, for the small gain of a private server; the window attaches to a
sidecar-started session through its ordinary `new-session -A` restore.
`Catalog`, `Activity`, `GitStates` and a shell / plain-agent `Create` are
answered by the sidecar with no window (`mobile_control::headless`,
`desktop_available: false`); a sign-in, cloud, worktree, local-model, mode or
root-console create still needs the window. Default apps are patched per
entry (`patch_default_apps`) under the file's lock — a patch command, not a
revision on the bare map. Not yet: a window does not learn of a sidecar
create until its next sync or hydrate (`adoptSyncOutcome` adds nothing —
H3), and a sidecar-started agent lacks the window's `--name`, `/rename` and
Remote-Control flag until restarted from a window. The exit test is
`host.rs::a_create_with_no_window_is_minted_spawned_and_listed_by_the_owner`.
Handoff: [`headless_owner_handoff.md`](headless_owner_handoff.md).*

*Status: **H2 interim landed** (2026-09-29, never live-verified): the
single-client lease. `services::timer_lease` grants one client per state
dir a heartbeat-renewed lease (`timer-lease.json`, 30 s TTL, released on
the way out); the React timer hosts — scheduled prompts, auto-continue, the
warm-up cron, calendar alarms, CalDAV sync — tick only while their window
holds it, and the schedule dialog says so when another window does. Git
probing is not gated (a duplicate probe costs, never fires). The port of the
timers into the owner — "fires once with no client" — is still plan only,
as is H3.*

*Status: **H2 landed** (2026-09-29, never live-verified): the timers that
matter with no window are the owner's. **Scheduled prompts** fire from the
Mobile sidecar while no window holds the lease
(`services::mobile_control::scheduler`): a 15 s tick over every bound agent
tab, `scheduleVerdict`'s twin, the durable claim taken under the file's
cross-process lock (`agent_tasks::claim_in` — the one at-most-once check,
whichever process fires), the prompt typed into the tab's tmux session
(`send-keys` reset, `load-buffer` + `paste-buffer -r [-p]`, `Enter`; prefix
commands first), the receipt, the history row and a one-time rule's retire
as the window does them; a tab whose session is gone is restarted through
the H1b detached spawn and delivered to on a later tick. Idle is the hooks'
`live_sessions/*.turn` record (the agent's own word — chosen over tmux
activity alone because output is silent under a long tool and the window's
gate is the same record) plus the session's `window_activity` quiet as the
settle; a hookless tab needs 30 s of quiet. **Calendar reminders** reach a
subscribed phone with no window through the existing Web Push path
(`mobile_control::alarms`), and are claimed — by a window before it shows
one, by the sidecar before it pushes — in a shared fired record under its
lock (`services::calendar_alarms`), so a reminder shows once across two
windows and the sidecar. The lease stays a **window** lease (the sidecar
reads it, never takes it), so an opening window takes the timers back.
Still under the lease, by design: auto-continue, the warm-up cron, CalDAV
sync; git probing is not gated. Exit tests:
`scheduler::tests::a_due_prompt_fires_once_with_no_window_and_restarts_a_dead_tab`,
`…::two_windows_and_the_sidecar_fire_a_schedule_exactly_once`,
`alarms::tests::reminders_reach_the_phone_once_with_no_window`. Handoff:
[`headless_owner_handoff.md`](headless_owner_handoff.md).*

*Status: **H3 landed** (2026-09-29, never live-verified): with no window
open the Mobile sidecar answers every remaining `DesktopRequest` kind but
mail and alerts, and `MobileBridgeHost.tsx` answers nothing the owner can.
The pattern is H0/H1b's throughout — the window first, the owner's files on
`desktop_unavailable`, every headless answer flagged `desktop_available:
false` — so with a window open nothing changed hands. **Tab mutations**
(`RenameTab`, `ColorTab`, `ReorderTab`, `CloseTab`, `ReopenTab`, `Activate`)
go through `services::workspace`'s per-tab operations, each an `edit_in`
that stamps `updatedVersion` so a window's stale copy merges; a headless
close ends the tab's tmux session and reaps its subtree
(`scheduler::Runner::kill`) and remembers an agent tab in the file
(`workspaceClosedTabs`) for a reopen, which comes back as a *new* tab (fresh
id and tmux name, same session id) started detached on its resume args; an
activate flips the registry's `status` under the lock. **Input paths**:
`TabPrompt` is recorded on the prompt history (`agent_prompts::record_at`),
`TabSeen` stamps a per-uid seen file the headless readings honour (a watched
`done` is not reported again), `UndoClear` types Claude's `/resume` through
the tmux runner or relaunches Codex, `TabInput` needs nothing (the hooks
record the turn). **Writes with side effects**: `TodoMutate` /
`CalendarMutate` are the desktop's board and calendar rules ported to
`headless_board.rs` over H0's CAS cores (a CalDAV-backed calendar is refused:
the window pushes from the write, so an edit here would be lost);
`ScheduleMutate` / `PromptMutate` write `agent_tasks.json` /
`agent_prompts.json` under their file locks (`upsert_in`, `upsert_at`,
`archive_at`), a send-now being a one-time rule the sidecar's own scheduler
fires. **Also**: `AgentStatus` (state and today's tally off the files, no
usage panel — reading one runs the CLI in the window's agent home),
`LaunchOptions` (only what the owner can start), `DesktopImages` /
`AttachDesktopImage` (the same folders, no clipboard). **Still the
window's**: `MailOverview` / `MailFolder` / `MailMessage` / `MailMark` /
`MailReply` (the mail store, its IMAP sessions and the keychain-held secrets
are the window's; the memory note "store must not be opened by the agent
path" stands) and `Alerts` / `AlertResolve` (the feed is built in the window
— `buildAlerts` over its stores, the mutes in `localStorage`). **The open
window** adds a tab created elsewhere at its next sync (`adoptSyncOutcome`,
bounded by `createdVersion`) and every headless write pokes an open window
with `DesktopRequest::Refresh` (fire-and-forget; normally nothing is there
to hear it). **The phone** edits the board, the calendar, schedules and
prompts with the window closed, reopens and activates; only a mode /
worktree / cloud / local-model / sign-in launch, mail and alerts still wait
for the window. Exit tests: `host.rs::tab_edits_close_and_reopen_are_the_owners_with_no_window`,
`…::writes_with_side_effects_are_the_owners_with_no_window`,
`…::an_undo_with_no_window_types_or_relaunches`,
`…::activating_a_project_with_no_window_marks_the_registry`,
`scheduler::tests::a_kill_ends_the_session_and_its_process_on_a_private_socket`,
`headless_board::tests::*`, `workspace::tests::phone_tab_operations_land_in_the_file_and_a_closed_agent_tab_reopens`,
`WorkspaceSync.test.ts`. Handoff:
[`headless_owner_handoff.md`](headless_owner_handoff.md).*

The request behind it: **the phone, schedules and alarms keep working with
the desktop window closed, and two clients never fight over the same state.**
The hosted plan builds on this; nothing here depends on it.

---

## 1. The problem

Today the React app is the authority for far more than it looks:

- **Spawning.** Terminal processes only start when `TerminalView` mounts:
  the only `pty_spawn` call is `TerminalView.tsx:1430`. The frontend decides
  tmux-or-not (`CenterPanel.tsx:199`) and mints tmux names (`tabs.ts:45`).
- **Timers.** Scheduled prompts, auto-continue and the warm-up cron are fired
  by React hosts mounted in `AppShell.tsx:1420-1422`. `AgentScheduleHost`
  ticks every 15 s against the frontend's `lastPtyOutputAt`. Calendar alarms
  (`stores/calendar/alarms.ts:148`), the CalDAV sync host and git probing run
  on frontend timers too; the phone's git dots are "what the desktop's pills
  already probed".
- **The tab set** is saved as one whole client snapshot (`save_tab_layout`,
  `projects.rs:2565`, debounced from `tabs.ts:5127`).
  `terminal_service.rs:78-93` records four tabs lost to *one* client racing
  itself.
- **The phone is answered by the window.** `commands/mobile_control.rs:1331`
  emits a `DesktopRequest` to window `"main"`, and `MobileBridgeHost.tsx`
  (2302 lines) answers it. Popouts forward their writes to the main window
  (`detachedContext`).
- **Project activation and restore** live in the store
  (`projects.ts:1408-1437`).

The consequences: with no window open, nothing is scheduled and the phone
gets no answer. With two windows open, every schedule fires twice and the tab
set is last-writer-wins as a whole. Closing the main window quits the whole
app (`lib.rs:776-783`), so the owner cannot live in the Tauri process either.

## 2. The owner

**The owner is the existing per-user Mobile sidecar** (`tabtivity --mobile-host`,
`main.rs:21-45`, already a user systemd unit), grown into a `workspace`
service. It already runs without a window and survives the desktop closing.
On a server the same code becomes the per-user daemon (hosted plan §3.1).

| State | Owner | Why |
|---|---|---|
| Project list, active/stopped, per-project settings | owner (`projects.json`). `save_projects` already patches only `status`, `position` and `box_id` (`projects.rs:655-673`); activation/restore logic moves out of the store. | Already mostly backend-owned. |
| **Tab set** per project: id, kind, label, colour, order, tmux name, agent session record, untested marks | **owner, per-operation commands** (group 0) | Must be identical on every client. |
| **Spawn policy and launch assembly**: tmux-or-not, tmux name, launch script | **owner** (group 0) | A tab's process must start whether or not a client is connected. Decided by the host's OS, never a client's. |
| **Timers**: schedules, auto-continue, warm-up cron, calendar alarms, CalDAV sync, git probing | **owner** | With no client they never fire; with two clients they fire twice. |
| Agent turn state, prompts, transcript pointers | owner (hooks already write it backend-side) | Already mostly backend-side. |
| Todo, calendar, alerts, mail overview | owner | The phone reads them without a window. |
| Settings, boxes, default apps | owner, **compare-and-swap** replacing the whole-document `save_settings` / `save_boxes` / `save_default_apps` | A laptop and a phone saving at once must not erase each other. |
| Pane split, focused tab per pane, scroll position, overlays, keyboard steering, hover, **terminal size** | **client** | Per screen; a phone and a 4K monitor cannot share a layout (decided, hosted plan Q4). `TerminalSession` splits into the shared tab set and a per-client layout (today both sit in `save_tab_layout`'s `tab_groups`). |

**Protocol.** On connect, the client gets a versioned snapshot. After that it
receives `workspace:patch {version, ops}` events. Mutations are
per-operation commands that return the new version, and a client whose
version skipped re-fetches the snapshot. Stores keep optimistic updates but
reconcile on the patch. Field edits (labels, colours) are last-writer-wins
per field. Tab creation, closing and reordering are serialised by the owner.
**`save_tab_layout` is refused once the owner holds the tab set; no second
client connects before that.**

**One writer per slice.** `JSON_MUTATION_LOCK` (`storage.rs:97-100`) only
serialises writes within one process, and the sidecar is a second process.
Once the sidecar owns a slice, the desktop window writes that slice **only**
through the sidecar, over the existing desktop bridge, and never touches the
file.

## 3. Phases

Each phase ships on its own.

**H0: prerequisites, no owner yet.**
- **#172, parent-directory fsync.** `write_json_atomic` already calls
  `sync_all` on the staged file (`storage.rs:117`); what is missing is an
  fsync of the parent directory after `persist` (`:118`), so a crash can
  lose the rename. A two-line durability fix.
- **#171, compare-and-swap on `calendar.json`.** `write_data`
  (`commands/calendar.rs:63-65`) is a whole-file write. The calendar lock
  serialises writers within one process only, the sidecar is a second
  process, and the board writes on every drag. Add a per-record `rev` and
  make writes CAS.
- **The sidecar serves the persisted-state `DesktopRequest` kinds** (`Todo`,
  `Calendar`, `Schedules`, `Prompts`, `AgentTranscript`) from files when the
  window is closed. `Catalog`, `Activity` and `GitStates` come back as
  "desktop closed" or marked stale. **Visible payoff: the phone reads todo,
  calendar and schedules with the desktop closed.**

**H1: group 0, tab set, spawning, whole-document saves.** The riskiest step.
- Per-operation tab commands in the `workspace` service.
- The owner spawns into `tmux -L tabtivity`, and every client, the desktop
  included, attaches. Today tmux uses the default socket; only tests pass
  `-L` (`tmux_local.rs:899`).
- `save_tab_layout` is refused. Settings, boxes and default apps use
  compare-and-swap. `TerminalSession` splits into the shared tab set and the
  per-client layout.
- `Catalog`, `Activity` and `GitStates` are then answered by the owner,
  because they read React stores today (`MobileBridgeHost.tsx:2160-2171`).

**H2: timers.** Schedules, auto-continue, cron, alarms, CalDAV, git probing.
In the interim, a timer host still in React runs only under a single-client
**lease** granted by the owner. Two windows can never both fire it, and until
its port lands a schedule needs a connected client (stated in the UI).

**H3: the remaining `DesktopRequest` kinds** (34 in total,
`protocol.rs:752`):
- read-only: `AgentStatus`, `AgentTranscript`, `Todo`, `Alerts`,
  `Calendar`, `Schedules`, `Prompts`, `LaunchOptions`, `MailOverview`,
  `MailFolder`, `MailMessage`, `DesktopImages`;
- tab mutations: `RenameTab`, `ColorTab`, `ReorderTab`, `CloseTab`,
  `ReopenTab`, `TabSeen`, `UndoClear`, `Create`, `Activate`;
- input paths: `TabInput`, `TabPrompt`, `AttachDesktopImage`;
- writes with side effects: `TodoMutate`, `CalendarMutate`,
  `ScheduleMutate`, `PromptMutate`, `AlertResolve`, `MailMark`,
  `MailReply`.

After each port, the desktop's React store switches from owning that slice to
subscribing to it, and `MobileBridgeHost.tsx` shrinks by that handler.

**Quit keeps the owner (user, 2026-09-29).** A clean quit used to stop the
Mobile sidecar as well (`stop_host_for_exit`), which left nothing to own
anything with the window gone. Settings → Mobile → "Keep running when Eldrun
is closed" (`eldrun_mobile_host.stay_after_quit`, default off) makes the quit
leave it running; open tabs are still reaped as before.

**Exit, live:** with the desktop window closed, the phone lists tabs, starts
an agent, and sees a scheduled prompt fire. Two desktop windows open at once
fire every schedule exactly once. `MobileBridgeHost.tsx` answers nothing the
owner can.

## 4. Verification

- **Gates:** all five AGENTS.md gates at zero warnings after each step.
- **H0:** the write path calls `sync_all` on the temp file and on the parent
  directory handle (assert via a seam); two interleaved calendar
  read-modify-writes, where the second is rejected and retried against fresh
  state; each persisted-state kind answered by the sidecar with no window.
- **Owner tests (H1–H2):**
  - two simulated clients rename, reorder and close tabs concurrently, and
    the final tab set equals the owner's, with no tab lost;
  - `save_tab_layout` is refused once the owner holds the tab set;
  - each timer fires exactly once with two clients and once with none.
- **Manual:** the exit above, plus two windows dragging a card on the same
  board within a second, where neither edit vanishes.

## 5. Related decisions

- `docs/mcp_control_plan.md` §1 decision 2 says re-implementing the
  frontend's model backend-side "would be a second implementation that
  drifts". This plan does exactly that, on purpose: it *moves* the model, and
  does not duplicate it. That decision carries a note saying it no longer
  applies to a slice once that slice has moved.
- The hosted plan's P1 is this plan, plus the start of the crate extraction.
