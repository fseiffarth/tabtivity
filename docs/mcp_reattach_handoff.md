# MCP reattach: handoff between implementer steps

Plan: `docs/mcp_reattach_plan.md` (kept by the main agent; Phase 1 steps and
fixed decisions are settled). Each step appends its own section.

## I1: Phase 1 backend

Branch `worktree-agent-a4f8603c8bd7e41a2`, based on develop `a245d4593`.
Commits: see `git log a245d4593..` (filled in below at the end of the step).

### What landed

1. **Stable port, synchronous bind.** `commands::root_mcp::start` binds a std
   listener (`bind_window`: `<state_dir>/root_mcp/port`, fallback port 0, holder
   logged through `loopback_owner::occupants` + `api_proxy_port::classify`) and
   publishes `Runtime` before any restored tab spawns. `serve` now takes the std
   listener and converts it inside its future (`from_std`), so the runtime is set
   synchronously. `bind` (Mobile host / daemon) is std too and goes through
   `bind_avoiding`, which re-asks while the ephemeral port equals the window's
   remembered one (rejected listeners are held until the end).
2. **Nonce and stamp.** `Runtime.generation` (random 32 hex per start,
   `root_mcp_mark::new_nonce`). The stamp is `@<slug>_mcp = <nonce>:<grant|->:<port>`
   (`root_mcp_mark::Mark`; the port is a third field beyond the plan, because a
   foreign-nonce probe needs it). It rides `PtyOptions.mcp_mark` (`#[serde(skip)]`)
   and `tmux_local::local_tmux_argv` appends `; set-option -t <session> @<slug>_mcp <mark>`.
   `prepare` sets the mark only for a Create.
3. **`SessionMux::mcp_marks()`** (`session_mux/mod.rs`, `tmux.rs`): one
   `tmux ls -F '#{session_name}\t#{@<slug>_mcp}'`, cached 3 s single-flight (lock held
   across the listing) for the app's server only, dropped on kill/rename/quit
   reap. `launch_prep::reattaches_session` and the new `local_session_plan` use it.
4. **Classifier and integration.** `root_mcp::root_mcp_mark::classify_reattach`
   (pure). `prepare` computes `local_session_plan` before the single
   `grant_lanes` call, which now runs only on `Reattach::Create`. Live (own
   nonce) calls `TokenStore::adopt(grant, &opts.id)`: re-keys every lane of the
   tab that holds the grant, revokes what the new id held in a lane, and
   rebinds the tabs-lane member's PTY (`tabs_mcp::rebind_pty`). Live (foreign
   nonce) and Stale/NoGrant mint nothing. Route: `GET /mcp/grant/{hash}` on every
   router (`grant_held`: 204/404; 403 for an `Origin` or a Host that is not
   `127.0.0.1:<port>`; hash must be lower-case 64 hex). Probe: `probe_grant`
   (std blocking, 300 ms total).
5. **Truthful state.** `root_mcp::{set_tab_stale, tab_stale, forget_stale}`;
   `servers_of_tab` is empty for a stale tab; `Features.app_mcp_stale`;
   `PtySpawned.mcp_stale`; the flag is set in `PreparedLaunch::commit` and cleared in
   `root_mcp_review::on_tab_gone`.

### Design choices beyond the plan

* **Port in the stamp** (third field), see above.
* **NoGrant** (stamp with `-`): mint nothing and report nothing (nothing was ever
  connected). A user who turns tools on later gets them only after a restart.
* **Unknown** (backend cannot list stamps: trait default, Windows host today):
  behaves exactly as before (grant, no stamp), `has` answers the rejoin.
* **Stale is flagged for every reattached local agent without a working grant**,
  not only for those that would have been granted a lane: eligibility is not
  recomputed (it would mean running `grant_lanes` against a scratch store, which has
  side effects such as the tabs-lane enrolment). Help is on by default, so nearly
  every agent has a lane anyway.
* **`note_mcp_mark`** in `commit` (not in `prepare`): a launch that fails after the
  grant must not leave a phantom stamp in the cache.
* `adopt` only re-keys `Identity.tab`. Things keyed by the old tab id elsewhere
  (review sandbox copy, mail taint markers) are not moved; the taint latch lives in
  the session and survives.

### Gotchas

* Cache window: a session that ended on its own less than 3 s ago (not killed
  through the mux) still lists, so an immediate relaunch would read Live/Stale and
  mint nothing for the fresh session it creates. Kill/rename/quit invalidate.
* `Runtime` gained a field; every literal in tests was updated with
  `generation: "test-generation".into()`.
* The root_mcp source-scan test counts `pub const ...TOKEN_ENV` lines in
  `root_mcp.rs`; no new such const was added.
* Heredocs with some contents were refused by the agent sandbox here; write patch
  scripts to the scratchpad instead.

### Interfaces for I2 (Windows session host) and I3 (frontend)

* Trait (`services/session_mux/mod.rs`):
  `fn mcp_marks(&self) -> Result<SessionMarks, MuxError>` (default
  `Err(MuxError::Unavailable(..))` = unknown) and
  `fn note_mcp_mark(&self, name: &str, mark: &str)` (default no-op).
  `SessionMarks::from_rows(impl IntoIterator<Item = (String, Option<String>)>)`:
  the raw stamp string per live session, `None` for no stamp. A backend must
  list **every** live session (an absent session is a Create) and return the
  stamp exactly as `PtyOptions.mcp_mark` carried it at creation. The host's
  `Spawn` must carry `opts.mcp_mark` and set it only when it creates the session
  (never on attach). Until I2, the Windows host answers unknown and is unchanged.
* Frontend: `pty_spawn` answers `PtySpawned` with `mcpStale: true` (camelCase,
  omitted when false). The hover card feature payload
  (`agent_tab_features` -> `Features`) has `appMcpStale: true` (omitted when false)
  and `appMcp: []` for a stale tab. No event is emitted; the flag is only on
  those two answers. Stale clears only when the tab is torn down or relaunched.
* Reconnect = kill the session and relaunch; `local_tmux_kill` already
  invalidates the stamp cache.

### Gates

`scripts/gates-job.sh start` (touched gates only; the change has no frontend or TS part):

* brand-check PASS; `git diff --check` PASS
* clippy `-p tabtivity -p app-serverd --all-targets`, `-p tabtivity --no-default-features --lib`,
  `-p app-serverd --all-targets`: PASS at zero warnings
* `cargo test -p tabtivity -p app-serverd`: PASS, lib 6143 passed / 17 ignored (+ 144, 39, 1 in the
  integration suites)
* `cargo test -p tabtivity --no-default-features --lib --test server_secrets`: 5953 passed, 1 failed:
  `terminal::host_pty::tests::a_dead_remain_on_exit_pane_stays_open_until_killed`, the known
  load flake (`project_load_flaky_tests`); it passes alone (`cargo test ... host_pty`, 5/5).
* npm gates not run: no frontend change.

### Flagged for user

* The probe route is the one unauthenticated route on the MCP listeners
  (`docs/threat_model.md`, row "Loopback listeners and local sockets").
* The 3 s cache window and the Stale-over-approximation above.
* Nothing was run live (no app start): the stable port, the stamp on a real
  restore and the probe between window and Mobile host are unverified outside
  unit/real-tmux tests on a private socket.
