# Headless MCP — handoff

Plan: [`docs/headless_mcp_plan.md`](headless_mcp_plan.md). TODO #2339
(`todo/group-z-server.md`). Never run live.

## Done — phase 1 (sidecar listener + headless wiring)

- **Each process serves the tabs it spawns.** The Mobile host binds its own
  loopback listener in `host::run`, before the scheduler starts
  (`commands::root_mcp::start_headless`). Same router and admission as the
  window's (`bind_and_serve`), minus the root route; `Runtime::serves_root`
  is false there, so `apply_to_spawn`, `apply_reader_to_spawn` and the VM
  guestfwd hand out nothing in that process.
- `root_mcp::TokenStore`: the token map as an instance; the process has one
  (`tokens()`), the listener authenticates against the store in its
  `ServerState`. Tokens still never touch disk.
- `grant_schedule` / `grant_git_push` / `grant_help`: the post-gate halves of
  the three `apply_*_to_spawn`, taking runtime + store (what the #2339 test
  drives through a headless create).
- `ServerState { app: Option<AppHandle>, store, notify }`, `Notice::{Schedules,
  GitPush}`. Window: Tauri events as before. Host: `poke_desktop(...,
  ["schedules"])`, the existing `DesktopRequest::Refresh` path, so an open
  window re-reads its loaded schedule rows.
- `git_push_mcp::serve_without_keyring()` (host only): `creds()` returns no
  token without touching the keychain, `git_push` / `git_release` answer
  `Category::WindowRequired` after argument checks and before budget, CI reads
  go tokenless and a 403/404 says why. Test-only per-thread switch
  (`serve_without_keyring_on_this_thread`) so the process flag never leaks
  into sibling tests.
- Hygiene: phone close (no window) revokes `headless:<tmux>`;
  `sweep_mcp_tokens` revokes a tab's tokens after its tmux session is missing
  three looks in a row (60 s apart); ids the host cannot check are kept.
- UI: one help line in MCP session access (`mcpSecurity.headless`, all five
  dictionaries, `UntestedTag` row).
- Tests: `host.rs`
  `a_headless_claude_tab_is_handed_the_hosts_schedule_and_help_servers`,
  `the_token_sweep_waits_for_repeated_misses`; `commands::root_mcp`
  `a_token_is_admitted_only_by_the_listener_whose_process_minted_it`,
  `the_headless_router_does_not_route_the_root_lane`; `git_push_mcp`
  `without_the_keyring_pushes_and_releases_answer_window_required_for_free`.

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
4. **Gotcha — the fence.** `preflight_command` asks `fenced_scope_of_tab(tab)`
   of the *window's* registry, which does not know the host's tabs and would
   answer `None` → the hook runs **unfenced on the host**. Adopted proposals
   must use the recorded scope, and a record without one on a platform that
   fences must fail closed (`fence_unavailable`).
5. A record stuck adopted by a window that died expires with the 24 h rule.

## Next — phase 3 (parity)

The host's sessions and audit rows are invisible to the window's MCP session
access (the note says so). An admin-socket request listing them, with Revoke,
would close that. The host's audit ring is in its own memory.

## Gotchas

- `root_mcp::set_runtime` is a `OnceLock`: the first listener of a process
  wins. Tests never call `bind_and_serve`; they use stores of their own.
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
  The alternative is a non-prompting `remote_credentials::store_readable()`
  gate plus a bounded read, which would let CI reads of private repos work
  from headless tabs (pushes would still need phase 2 for the card).
- Phase 2 at all, or keep `window_required` (restart the tab from a window).
