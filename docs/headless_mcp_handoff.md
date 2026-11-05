# Headless MCP — handoff

Plan: [`docs/headless_mcp_plan.md`](headless_mcp_plan.md). TODO #2339
(`todo/group-z-server.md`). Never run live.

## Done — phase 1 (sidecar listener + headless wiring)

- **Each process serves the tabs it spawns.** The Mobile host binds its own
  loopback listener in `host::run`, before the scheduler starts
  (`commands::root_mcp::start_headless`). Same router and admission as the
  window's (`bind` + `serve`), minus the root route; `Runtime::serves_root`
  is false there. A failed first bind is logged and retried with backoff
  (`bind_retry_delay`: 5 s doubling to 5 min) until the host stops.
- **One grant call.** `launch_prep::prepare` calls
  `root_mcp::grant_lanes(opts, agent, runtime(), tokens(), state_dir)` and
  nothing else for MCP. It reads every gate from that state dir
  (`root_mcp::Trusted`: `settings.json` + the scope's `projects.json` entry;
  `remote::entry_is_remote_for_host`, the entry's `sandbox` / `vm` specs,
  `schedule_mcp::level_at`, `git_push_mcp::enabled_in`, `help_mcp`), so tests
  drive the real gates against a fixture. A runtime that does not serve the
  root lane hands out neither root nor reader tokens.
- `root_mcp::TokenStore`: the token map as an instance; the process has one
  (`tokens()`), the listener authenticates against the store in its
  `ServerState`. Tokens never touch disk.
- `ServerState { app: Option<AppHandle>, store, notify }`, `Notice::{Schedules,
  GitPush}`. Window: Tauri events. Host: `poke_desktop(..., ["schedules"])`;
  the window's bridge turns that into its own `agent-schedules-changed`
  event (`emitSchedulesChanged`), so `AgentScheduleHost` (layout + tick) and
  popouts react exactly as to a window-made proposal.
- `git_push_mcp::serve_without_keyring()` (host only): `creds()` returns no
  token without touching the keychain; `git_push` / `git_release` answer
  `Category::WindowRequired` after argument checks, before the policy read
  and any budget; CI reads go tokenless and a 403/404 says why. Test-only
  per-thread switch (`serve_without_keyring_on_this_thread`).
- Hygiene: a phone close with no window revokes `headless:<tmux>`;
  `sweep_mcp_tokens` (60 s, `MissedTickBehavior::Delay`) revokes one
  *generation* of a tab's tokens (its session ids, `token_generations`) once
  the tmux session is missing three looks in a row. A CLI that exits does
  not end its session (a login shell follows it), so tokens live as long as
  the session. Ids the host cannot check are kept.
- UI: one help line in MCP session access, shown only while Mobile is on
  (`mcpSecurity.headless`, five dictionaries, `UntestedTag` row).
- Tests:
  - `host.rs` `a_headless_claude_tab_is_handed_the_hosts_mcp_servers`:
    `start_headless` publishes the runtime; a headless create through
    `grant_lanes` and the real gates gets schedule, git and help; the bound
    listener admits the tokens over HTTP (never 401) and has no `/mcp`; a
    fresh store refuses them; root and reader spawns get nothing from that
    runtime (a root-serving runtime would grant both under the same
    settings); the phone's close revokes all three.
  - `host.rs` `the_token_sweep_waits_for_repeated_misses_of_one_generation`.
  - `commands::root_mcp`: `a_token_is_admitted_only_by_the_listener_whose_process_minted_it`,
    `the_headless_router_does_not_route_the_root_lane`,
    `a_failed_headless_bind_is_reported_and_retried_until_shutdown`.
  - `git_push_mcp`: `without_the_keyring_pushes_and_releases_answer_window_required_for_free`
    (direct calls and `handle_message`).
  - `MobileSchedulesPoke.test.ts`, `RootMcpSecurity.test.tsx` (the note's gate).

## Done — phase 1b (the markup lane in the Mobile host)

Plan: "Phase 1b" in [`docs/headless_mcp_plan.md`](headless_mcp_plan.md).
Never run live. Commits: see git log (tr2339/markup).

- **The bug.** A tab the Mobile host spawned never got `markup_ask` /
  `markup_withdraw` / `markup_done`: the host routed no `/mcp/markup` and
  published `serves_markup: false`, so `grant_lanes` skipped the lane, and a
  CLI reads its MCP config once. The phone's ✓ badges and **Approve all** need
  `markup_done`, so they never showed.
- **Choice: (b), the host serves its own asks.** `/mcp/markup` is routed
  unconditionally (only `/mcp` keeps the `ctx.is_some()` gate); `serve`
  publishes `serves_markup: true` for every listener; asks and ticks stay in
  memory in the process that took them; tokens never touch disk and are valid
  only in the minting process. Rejected (a), a shared on-disk store: liveness
  would need an owner process per entry, change notification needs a second
  channel for window→host, and it turns the phone's 3-s poll into locked
  file reads (reasons in the plan).
- **Window side.** `commands/markup_mcp.rs`: `markup_mcp_list/_ticks/_answer/
  _reopen/_dismiss` are now `async`, same names and payloads (TS unchanged,
  no new `command_class` row, `commandClasses.ts` unchanged); they read the
  window's store then the host's over the admin socket
  (`AdminRequest::MarkupList/Ticks/Answer/Reopen/Dismiss`,
  `AdminResponse::MarkupAsks/Ticks/Answered/Refused`, `AdminContext::markup`
  = `admin_markup` in the host). `use_host_peer` is set once by the window's
  `root_mcp::start`; the host and a daemon set none. Answer: local first, on
  `gone` the host's (which returns `{ prompt, receipt }` for the window to
  queue); reopen likewise; dismiss goes to both.
- **Host side.** `Notice::Markup` (the host's change hook, installed by
  `start_headless` when there is no server context) → `poke_desktop(["markup"])`
  → the window's `refreshSlices` `markup` → `emitMarkupChanged` →
  `markup-mcp-changed`. `markup_mcp::sweep()` after the phone's close and
  after the 60-s sweep's revokes. `markup_call`: window down (or
  `tab_not_found` from it) and `markup_held_here` → `markup_here`, else the
  old `desktop_unavailable`. `poke_desktop` no longer panics off the runtime.
- **Tests.** `host/tests.rs` `a_headless_claude_tab_is_handed_the_hosts_mcp_servers`
  (extended), `a_tab_the_host_spawned_gets_its_markup_answered_by_the_host_without_a_window`;
  `commands::markup_mcp` `the_window_reaches_the_asks_and_ticks_the_host_holds`
  (a real admin socket, two stores), `the_hosts_tick_answer_keeps_the_newest_ticks_that_fit_a_frame`;
  `commands::root_mcp` `the_headless_router_does_not_route_the_root_lane`
  (now: markup routed), `the_hosts_markup_hook_notifies_its_sink`; `markup_mcp`
  `two_processes_asks_merge_to_the_newest_and_ticks_to_a_union`,
  `the_second_process_holds_its_own_asks_and_ticks`; `MobileMarkupPoke.test.ts`.
- **Gotchas.**
  - `markup_mcp::as_host::run` (tests only) switches the asks/ticks stores
    **per thread** to a second set, to model the host. The test's "window" side
    runs on `app_core::rt` blocking-pool threads (never inside `run`), the
    host's admin handler wraps `admin_markup` in `run`. Anything a test drives
    on another thread (HTTP handlers) sees the default store.
  - `markup_mcp::set_change_hook` is a `OnceLock`: the first hook wins. The
    #2339 test's `start_headless` installs the host's (a no-op sink).
  - The ask id is random and unique per process, so "local first, then the
    peer on `gone`" cannot confuse two stores; `gone` also means withdrawn,
    expired or dismissed, which the peer answers `gone` too.
  - The admin frame is 64 KiB: the host answers at most `MAX_PEER_TICKS` (the
    newest 1000) ticks of a tab.
  - A window older than this build never reads the host's asks (the host's
    phone path still answers with no window); a host older than this answers
    an error, read as no asks.
  - The window's list/ticks now do one admin-socket connect per call; with
    Mobile off the connect fails at once (`ENOENT`/`ECONNREFUSED`).
  - A tab the window closes while the host owns it keeps its card up to about
    three minutes (the host's sweep needs three missed looks).
  - `backend:stale`: the host must restart to serve the lane; a tab spawned
    before keeps lacking it (its MCP config is fixed at start).
- **Gate results.** @@GATES@@

### Flagged for user

1. Nothing was run live. Manual steps: `docs/context/markup_mcp.md` QA 8c and
   the 🖐️ box under #2339 (needs a rebuilt desktop **and** a restarted Mobile
   host; host-spawned tabs started before then stay without the tools until
   restarted).
2. `markup_mcp_answer` / `_reopen` / `_dismiss` changed from sync to `async`
   commands (the wire name and payload are unchanged); they now may take an
   admin-socket round trip.
3. A tab that exists in both processes (a window respawn of a host tab, or
   the reverse) shows only the newest card until the older process's session
   is swept; asks are not otherwise merged across processes.
4. No `UntestedTag` row: nothing user-visible was added (no new strings);
   the behaviour is covered by the 🖐️ box instead. Say if a pill is wanted.
5. With the window open, the phone's answer to a **host** tab's ask goes
   phone → host → window → host (admin socket) → window's scheduler, three
   hops; if the window is wedged the phone gets `desktop_unavailable` rather
   than the host answering. Deliberate (the host's scheduler does not run
   while a window holds the timer lease), but say if the host should take
   over after a timeout.
6. The host-side `ask` rate limits (20 asks / 60 ticks per tab per hour) are
   per process, as they were; a tab keeps its budget across a respawn only
   within the process that spawned it.

## Next — phase 2 (git requests queued for the window's card)

Only if the user wants pushes from headless tabs (see "Decisions" below).
Sketch in the plan. The parts that matter:

1. A file-locked queue `<state>/root_mcp/git_queue.json` (0600, no secret):
   id, kind, tab, project, canonical dir, **the tab's fence scope as the host
   registered it** (`agent_fence::fenced_scope_of_tab` in the host), requested
   branch/tag, note, created_at, host session id, status, mirrored outcome.
2. Host `call_push` / `call_release` append a record and answer `queued`;
   `git_push_status` / `git_push_cancel` read and edit records of their tab;
   the pending limit counts records.
3. The window adopts queued records (startup, a new `git` refresh slice, or a
   short timer in `commands::root_mcp::start`) into in-memory proposals marked
   adopted, runs `run_request` / `run_release`, and mirrors every change back.
   Adopted proposals are pruned by age only (their session lives in the host).
4. **Gotcha — the fence.** Since gap 18 (2026-10-08) the preflight runs in
   the scope stamped on the Pusher binding (`PushBinding::fence_scope`,
   copied into the proposal) and refuses with `fence_unavailable` when none
   is recorded; the window's fence registry is never asked. Adopted
   proposals must carry the host's recorded scope into `Proposal::fence_scope`.
5. A record stuck adopted by a window that died expires with the 24 h rule.

## Next — phase 3 (parity)

The host's sessions and audit rows are invisible to the window's MCP session
access (the note says so). An admin-socket request listing them, with Revoke,
would close that. The host's audit ring is in its own memory.

## Known behaviour (recorded, not changed)

- **The keychain.** The host never reads the *git* token. It does read the
  keychain elsewhere: a headless Copilot spawn injects its credentials
  through `copilot_auth::inject_env` → `remote_credentials::get` (since H1b),
  which is gated by the non-prompting lock probe. "Keyring-free" is a
  property of the git lane only.
- **`after_usage_reset` runs a CLI unfenced in the host.** A schedule proposal
  with `when.type = after_usage_reset` makes the serving process run
  `commands::agents::agent_usage` (`claude -p /usage` and kin) to find the
  reset — in the Mobile host as in the window, outside any fence, after
  `schedule_mcp::admit` has taken the budget.
- **Port squatting after a restart.** When the host restarts, its old port is
  free and another local user could bind it; a headless tab still holding
  the old URL would then send its bearer token there. That is impersonation
  of the server (the squatter learns a token no listener accepts any more),
  not theft of a live token. The window's listener has had the same property
  on every restart.

## Gotchas

- `root_mcp::set_runtime` is a `OnceLock`: the first listener of a process
  wins. The #2339 test calls `start_headless` and so publishes a
  `serves_root: false` runtime for the whole test binary; no other test may
  publish one.
- The fixture's `projects.json` entries lack `position` / `local_file`, which
  `ProjectsList` requires: discovery reads them leniently, `grant_lanes`
  (like every other trusted reader) does not. The #2339 test adds them.
- A sidecar restart (rebuild, Mobile off/on) forgets its tokens: headless tabs
  then get connection refused / `401` until restarted. Window restarts have
  always done the same to tabs that survive in tmux.
- The window's attach to a host-spawned tmux session runs `prepare` and mints
  window tokens for its own tab id; the running CLI keeps the host's. Harmless
  (as on any reattach), but the window's session list then shows a session the
  CLI does not use.
- Backend changes reach the sidecar only after it restarts
  (`journalctl --user -u tabtivity-mobile-host`).

## Decisions left to the user

- Should the background service ever read the git token? Phase 1 says never.
  The alternative is the non-prompting `remote_credentials::store_readable()`
  gate plus a bounded read (what Copilot already uses), which would let CI
  reads of private repos work from headless tabs (pushes would still need
  phase 2 for the card).
- Phase 2 at all, or keep `window_required` (restart the tab from a window).
