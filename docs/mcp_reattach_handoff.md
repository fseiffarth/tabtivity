# MCP reattach: handoff between implementer steps

Plan: `docs/mcp_reattach_plan.md` (kept by the main agent; Phase 1 steps and
fixed decisions are settled). Each step appends its own section.

## I1: Phase 1 backend

Branch `worktree-agent-a4f8603c8bd7e41a2`, based on develop `a245d4593`.
Commits: `31c8d7f64` (the whole step: code, tests, docs, this file) plus a one-line docs follow-up that records it.

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

## I3: Phase 1 frontend

Branch `worktree-agent-a345e92f66fd1b56e`, based on I1's `4c0ea87dc`. Commit `9d9f361a3` (the whole step) plus this one-line docs follow-up.

### What landed

* **`stores/agents/mcpStale.ts`** (new): per-PTY `stale`/`armed`/`dismissed`
  plus the turn hook's verdicts seen since. `TerminalView` calls
  `noteMcpStale(id, spawned.mcpStale === true)` after every `pty_spawn` that is
  not a join (`attached`) or an `attachOnly` view, so a relaunch clears it.
  * `mcpReconnectKind`: `byId` (claude, codex, vibe, opencode), `latest` (every
    other resumable CLI or custom `resumeArgs`: Cursor, Grok, Qwen, Droid,
    Gemini, also Antigravity, Copilot, Muse), `none` (no resume, or a tab that
    does not run locally).
  * Reconnect = `agentClearUndo::relaunch` (kill the tab's own tmux session,
    relaunch on `resumeArgsOf`); the flag clears at once and the respawn's own
    answer raises it again if the new run is stale too.
  * "Reconnect when this turn ends": `armMcpReconnect` arms only while a turn is
    in flight (hook verdict `working`/`decision`, else `busyByTab`); idle, it
    reconnects at once. Fires on `agent-turn` `done`/`idle` (own `subscribeTauri`
    listener, live only while a tab is stale) or, for an agent with no hooks,
    on an `useActivityStore` change that leaves it not busy (subscribed only
    while something is armed).
  * Bulk toast: after the last stale answer, `TOAST_SETTLE_MS` (3 s) later, one
    `switchToast` "N agent tabs lost their {app} tools" per batch of newly stale
    tabs (main window only). Its action "Reconnect idle ones" is offered only
    when a candidate exists: stale, open, `byId`, not armed, no turn, no
    background `job`, not byte-busy. `reconnectIdleMcpStale` runs 4 slots; each
    slot waits for its tab's next `noteMcpStale` (its respawn) or 15 s before
    taking the next, and re-checks idleness first.
* **`terminal/TerminalMcpStaleCard.tsx`** (new): the dead-pane card's classes
  (`hint-bubble terminal-sign-in`), with the undo-clear card's ✕ and lift
  (`.terminal-mcp-stale` added to that one CSS rule). Buttons: Reconnect /
  Reconnect when this turn ends / Don't reconnect (armed). `latest` goes
  through `useDialogs().confirmAction` before both Reconnect and arming.
  `none` shows the notice only. Mounted in `TerminalView` beside the dead-pane
  card (one line).
* **Hover card**: `AgentTabFeatures.appMcpStale`; a row "{app} tools:
  disconnected — reconnect from the tab" (`McpStaleHoverMark`, red
  `tab-popup-mcp off`).
* `switchToastAction` gained an optional `untested` id; the box Undo toast now
  passes its own (`ProjectSwitcher`), so AppShell no longer hard-codes it.
* i18n: 16 `terminal.mcpStale.*` + 2 `tabHoverCard.mcpStale*` keys in all five
  dictionaries. Untested rows: `terminal.mcpStale`, `terminal.mcpStale.bulk`,
  `tabHoverCard.mcpStale`. Filemap row beside `TerminalDeadPaneCard`.

### Tests

* `src/__tests__/agents/McpStale.test.ts`: reconnect kinds; bulk filter
  (working, job, armed, Gemini excluded); 4-at-a-time with respawn waits;
  armed fires on `done`; idle arm reconnects at once; toast once per batch,
  no action when only a `latest` tab is stale.
* `src/__tests__/terminal/TerminalMcpStaleCard.test.tsx`: hidden when live;
  Reconnect kills + relaunches; mid-turn arm and disarm; Gemini confirm; Aider
  notice only and ✕.
* `src/__tests__/tabs/TabHoverCardMcpStale.test.tsx`: stale row, MCP row keeps
  only the tab's own servers; no row when live.

### For R1

* **Deviation:** the `latest` set is the rule (every resumable CLI not resumed
  by id), not only the five named CLIs: Antigravity, Copilot, Muse and custom
  agents also confirm and stay out of the bulk.
* An armed reconnect fires on `done` even with a background `job` running
  (it would never fire on a long-lived dev server otherwise); the bulk skips
  job tabs.
* The toast reuses the shared `switchToast` slot (6 s with an action): a
  project-switch toast set in the same moment replaces it.
* Stale entries of closed tabs stay in the store until their id spawns again;
  every reader filters by open tabs.
* A dead pane on a stale tab shows both cards in the same corner (the dead
  one's Restart also clears the stale flag through the respawn).
* Popouts: the card works there, the toast is main-window only.
## I2: Windows session host

Branch `worktree-agent-a6043cb45f230d9ad`, based on I1 `4c0ea87dc`. Commits:
see the I2 rows in `git log 4c0ea87dc..` (portable protocol part, then the
`cfg(windows)` mux part with `CI-Only: windows`).

### What landed

1. **Protocol, additive** (`session_host/protocol.rs`): `Request::Spawn` gains
   `mcp_mark: Option<String>` and `SessionInfo` gains `mcp_mark`, both
   `serde(default, skip_serializing_if = "Option::is_none")`, so a stamp-less
   message is byte-identical to before and an older peer drops the field. New cap
   `CAP_MCP_MARK = "mcp-mark"` in `CAPS`. **No `PROTO` bump.** `MAX_MCP_MARK` 256.
2. **Host** (`table.rs`, `server.rs`): `Entry.mcp_mark` is set only by the
   `Spawn` that creates the session (`Created::New`); an attach never changes it,
   a rename keeps it. A malformed stamp (`table::valid_mcp_mark`: empty, > 256
   bytes, anything but printable ASCII without space) is `BadRequest` before
   anything spawns. `List` returns it. `sessions.json` never carries it.
3. **Client** (`client.rs`): `Client::mcp_marks()` sends one `List` and returns
   `Some(rows)`. A host without the cap returns `None` and is sent nothing.
4. **Decision, pure** (`route::marks_answer`, tested on every OS): listed rows →
   `SessionMarks`. Old host → `Unavailable` (unknown). No host and the setting on
   (and a copy to start) → empty (a new session is made by this build's host, so
   it gets stamped). No host and the setting off → `Unavailable` (the tab runs
   in-process with nothing to stamp). Any other error passes through, and
   `launch_prep` reads it as unknown, so a spawn never breaks on it.
5. **Mux** (`session_mux/winhost.rs`, `cfg(windows)`): `host_spawn_for` carries
   `opts.mcp_mark`; `mcp_marks` asks any running host (setting or not) under
   `LIST_DEADLINE`. The result is cached 3 s per pipe, single-flight (the lock is
   held across the listing). `note_mcp_mark` folds into that pipe's entry.
   `spawn_detached`, `kill`, `rename` and `kill_app_sessions` drop it.

### Design choices

* The cap is checked instead of sending a new request: an older host's `List`
  would decode every session as "no stamp" (Stale). Without the cap the answer is
  "unknown", so its tabs keep today's behaviour (grant, `has` for the rejoin).
* Unknown only where no host runs **and** none will run (setting off).
  With the setting on and no host running, the answer is "none" so the create is
  stamped. Answering unknown there would leave every first session after a
  crash unstamped, and so Stale on the next restore.
* Mixed versions: a stamp sent to an older host (a race with a sidecar that
  started an old copy) is dropped silently. That host then lists as unknown,
  which is safe.

### Gotchas

* Same 3 s cache window as tmux: a session that ended on its own (not through
  the mux) within 3 s still lists.
* A mark noted for a launch that the host did not take (a batch launch, which
  stays in-process) sits in the cache for at most 3 s.

### Tests

* Portable: `protocol::tests::the_mcp_stamp_is_additive_on_the_wire`,
  `table::tests::{the_mcp_stamp_is_set_on_create_only, an_mcp_stamp_is_short_printable_ascii}`,
  `server::tests::{the_mcp_stamp_is_kept_from_the_creating_spawn_and_listed, an_older_host_reads_as_unknown_not_as_unstamped}`
  (a hand-written old host: no cap, so nothing is sent),
  `route::tests::mcp_marks_are_known_only_from_a_host_of_this_build`, and the
  `copies` test (the stamp never lands in `sessions.json`).
* Windows only (`winhost/tests.rs`, CI is the only test bed):
  `mcp_stamps_ride_the_creating_spawn_and_list_back` (real host: create vs
  attach, note, rename, kill),
  `with_no_host_mcp_marks_are_none_when_on_and_unknown_when_off`, and the
  `host_spawn_for` stamp check in `wrap_marks_the_launch_and_keeps_its_argv`.

### Gates

* The full gates were **not** completed: the user stopped every running gate run
  partway through (memory).
* Before that stop: brand-check PASS, `git diff --check` PASS, and
  `cargo clippy -p tabtivity -p app-serverd --all-targets -D warnings` PASS. That
  clippy run came after a fix: `type_complexity` on `marks_answer`, solved with
  `client::MarkRows`.
* Then, alone: `cargo test -p tabtivity --lib session_host`, 92 passed, the new
  portable tests included.
* Not run: the `--no-default-features` clippy and its test, the full
  `cargo test`, and the app-serverd clippy.
* The Windows cross-check (`ci-local.sh` windows-clippy / scratch `CARGO_HOME`)
  was not run either, because of the same memory stop. The `cfg(windows)` code
  (`winhost.rs`, its tests, the `launch.rs` and `win/tests.rs` literals) has
  never been compiled. Windows CI is its first compile.

### Flagged for user

* Nothing was run live. The Windows path (`winhost.rs`) has only been read, never
  compiled or run.
* A host started by an older build keeps answering "unknown" until it retires
  (it stays while it has sessions). Its tabs get today's behaviour, not a stale
  flag.
