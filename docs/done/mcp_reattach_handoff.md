# MCP reattach: handoff between implementer steps

> **Status (screened against code 2026-11-22):** Log of `docs/done/mcp_reattach_plan.md` Phase 1 (I1-I3, R1) and Phase 2 (I4, R3, F); both phases are in code (`root_mcp_reattach.rs`, `root_mcp_mark.rs`, `launch_prep.rs`, `session_mux/`). Open: the "Flags for the user" and CLI `503` behaviour; the worktree branch named here is history. Not live-tested.

Plan: `docs/done/mcp_reattach_plan.md` (kept by the main agent; Phase 1 steps and
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

## R1: Phase 1 review

Branch `worktree-agent-a57c1d17452a56bdf`, reset to the integration commit
`d0142ab58` (I1 + I3 + I2 on `a245d4593`). Review of `a245d4593..d0142ab58`;
fixes are one commit each, with a regression test (`31cdbb6d8`, `4c18ef897`, `ed4c94828`).

### Fixed

1. **A local-model Tabby chat could not reattach** (medium;
   `launch_prep.rs`, `assemble_assistant_launch_with`). An assistant chat is
   a local agent session, so a reattach (Live, Stale, NoGrant) is granted no
   lane. `assistant::launch_line` refuses `ClaudeLocal` and `OpenCodeLocal`
   without the web lane (`Refusal::NoLane`), so `prepare` failed. The surviving
   chat could not be reopened after a restart, or after an in-run respawn.
   Before Phase 1 the reattach was minted a lane and went through. Fix: on a
   non-Create verdict, `prepare` passes the web lane's url, built from this
   listener's port. The command line tmux ignores is then built; no token is
   named or minted. Test:
   `launch_prep::tests::a_reattached_local_chat_is_not_refused_for_want_of_a_lane`.
2. **The AI switch rejoin check read the 3 s cache** (low; `launch_prep.rs`,
   `reattaches_session`). I1 moved `reattaches_session` onto the cached stamp
   listing. With the AI switch off, that answer lets a launch through as a
   rejoin, and on tmux a rejoin is still `new-session -A`. A session that ended
   less than 3 s ago would start its agent again while AI is off. Fix: the
   check asks the mux's own `has` again (`local_session_live`); the classifier
   keeps the listing. Test:
   `launch_prep::tests::reattach::a_rejoin_is_judged_live_not_from_the_cached_listing`.
3. **The privacy sweep left ended sessions in the stamp cache** (low;
   `agent_privacy::forget_sessions`). `end_sessions` and `sweep_sessions` kill
   through tmux's argv, not the mux, so the cache was not dropped. A relaunch
   within 3 s (`end_refused_spawn`, then a retry) read the session as live. The
   new session then got no grant and no stamp. Fix: `forget_sessions` drops the
   cache (`session_mux::tmux::forget_marks`, now `pub(crate)`). Test:
   `agent_privacy::tests::a_swept_session_leaves_the_stamp_cache`.

### Not fixed (reported)

* **tmux re-stamps on an attach race** (low; `tmux_local::local_tmux_argv`).
  The `; set-option` rides `new-session -A` unconditionally. If the listing
  said "absent" but the session exists at spawn time, the attach overwrites
  the stamp. Two cases: the Mobile host creates it inside the window's 3 s
  window, or two concurrent spawns of one id. The agent keeps the old tokens,
  but the stamp names a grant this run holds, so a later in-run reattach reads
  Live. The Windows host does it right (`Created::New` only). A tmux-side fix
  needs `set-option -o` or `if-shell` on `#{session_created}`; that wants a
  live check, so it was left alone.
* **Arming on a hookless agent fires on a quiet screen** (design; `mcpStale.ts`
  `syncWatchers`). Without hook verdicts, "when this turn ends" fires when
  `busyByTab` drops. A long silent tool call can read as the end of the turn,
  and the restart then comes mid-turn. The user armed it, but the plan names
  only `done`.
* **Foreign confirm from a port squatter** (low). If the window could not
  re-bind its port, a stale stamp's probe goes to whoever holds that port. A
  squatter answering 204 makes the tab read Live: no card, empty MCP row. It
  only hides the stale flag and gains no authority. A probe to the window's own
  remembered-but-lost port could be skipped.
* `mcp_token_handed_out` is true for any adopt, even one holding only
  cockpit/help lanes (`holds_token` counts root, schedule and git only). Nit.
* `note_mcp_mark` in `commit` and `forget_marks` can block an async worker for
  up to one listing (`LIST_TIMEOUT`/`LIST_DEADLINE`), because the single-flight
  lock is held across it. Nit.
* `TokenStore::adopt` keeps every identity field but `tab` (project, schedule
  target, push dir). Today `adopt` only moves a grant within one PTY id
  (`old == tab`); no UI renames a local session. If a tab can ever move scope
  with its session, the old scope's tokens follow it.

### Checked and sound

* Classifier table, stamp parse (exact `nonce:grant|-:port`, hex only, port >
  0, tmux's trailing newline), Unmarked to Stale, Unknown to Create without a
  stamp, no runtime to Create without a stamp.
* `grant_lanes` runs only on Create; the stamp's grant is the first lane token
  in `opts.env`, always one this store registered. A planted token env is
  stripped first (`CONTROL_ENV`). `SpawnTokenGuard` on a reattach holds nothing.
* `adopt`: own nonce and a held grant only; same-id is a no-op. A different id
  revokes what the new id held and re-keys, and `tabs_mcp::rebind_pty` follows.
  The tmux socket is unreachable from the fence, so a stamp cannot be forged by
  an agent.
* `GET /mcp/grant/{hash}`: exact Host `127.0.0.1:<port>`, no `Origin`, lower
  hex 64; 204/404/403 only, one bit about a 256-bit hash; on every router.
* Port: `start` binds synchronously in `setup` before the IPC loop runs; the
  fallback is port 0 plus a holder log, and the file is written only when the
  port changed (parents created). `bind_avoiding` holds rejected listeners, so
  the Mobile host and the daemon never land on the window's port.
* Windows: the stamp is kept only on `Created::New`, and attach and rename keep
  it; the cap gate means an old host reads as unknown; `marks_answer` as I2
  described (I agree with "none" when the setting is on and no host runs); the
  cache drops on kill, rename, `kill_app_sessions` and `spawn_detached`. Read
  only, never compiled here.
* Frontend: an armed reconnect fires once (`fireArmed` disarms first); the
  toast's button clears the toast before it runs, so a double click cannot run
  two bulks; the bulk takes idle, `byId`, unarmed, job-free tabs, 4 slots; the
  confirm guards `latest` before both Reconnect and arm; `noteMcpStale` skips
  joins and attach-only views.
* Tests: no `"a/b"` literals; the tmux tests are `#[cfg(unix)]`, the winhost
  tests are under `cfg(windows)`, and the port tests use `Path::join`.

### Tests run (targeted, no gates)

* `cargo test -p tabtivity --lib -- launch_prep agent_privacy session_mux root_mcp tmux_local`:
  400 passed, the three new tests included, no warnings.
* `npx vitest run` on I3's three test files: 13 passed.
* Not run: clippy, the `--no-default-features` build, Windows (no TS touched,
  so no lint or brand-check needed).

### For I4 (Phase 2)

* After revival, a previous run's grants live in this store again, but the
  stamp still carries the old nonce. `classify_reattach` treats it as foreign
  and probes the stamp's port, which is this listener's own after a stable
  re-bind, so it answers 204: Live, but with no `adopt`. Treat "foreign nonce,
  port == own port" as an own-store lookup plus `adopt`, or re-stamp revived
  sessions with the new nonce.
* The probe hands the grant hash to whatever holds the stamp's port. Keep the
  hash a lookup key only, never a credential, in the persisted record.
* The 30 min cap and the never-schedule rule have to hold in `adopt` as well,
  because `adopt` re-keys every lane of the old tab.
* Assistant chats are local agent sessions too: a revived Tabby keeps web and
  help lanes, and fix 1 keeps its reattach from being refused.

### Flags for the user

* Nothing was run live. The Windows code is still never compiled
  (`cfg(windows)`); Windows CI compiles it first.
* The hookless "when this turn ends" trigger (above) is a design call to make.

## I4: Phase 2, revival without restart

Branch `worktree-agent-a6176a1d14ec85ad4`, reset to the integration commit
`d9ae7d698` (`mcp-reattach-int`: I1 + I3 + I2 + R1 + V0 on `a245d4593`).
Commits: see `git log d9ae7d698..` (code + tests + docs in one, then this
section).

### What landed

1. **Hash-keyed `TokenStore`** (`services/root_mcp.rs`). The map key is
   `token_hash(token)` (= `Session::id`); `authenticate` hashes the bearer
   (`bearer_hash`) and looks it up, so a hash presented as a bearer is hashed
   again and opens nothing. `register`, `stamp_push_*`, `revoke_token`
   (`revoke_hash`), `holds_session`, `set_access`, `revoke_session`,
   `session_alive` and `SpawnTokenGuard` (now holds hashes, `retarget`) go by
   hash. `release_tab` (memory only, the PTY teardown in
   `root_mcp_review::on_tab_gone`) vs `revoke_tab` / `revoke_session` (also
   drop the hashes from the record). `Session.revived`.
2. **Record** (`services/root_mcp/root_mcp_reattach.rs`, new). One file per
   listener (`Role::record`: `reattach.json`, `reattach-host.json`), only
   through `patch_private_json`, unknown fields kept at every level
   (`#[serde(flatten)] extra`). Top level: the writing run's `nonce`, `port`,
   `last_alive`; per session: `port, nonce, grant, project, cmd_stem,
   local_model, created, lanes[caller, hash?, project, schedule_target/agent,
   push_dir, git_at_spawn, fence_scope, unfenced_host]`. A non-revivable lane
   is listed **without** its hash (so its loss still reads stale; a schedule
   hash is never written). Written at `PreparedLaunch::commit` for a create
   (`McpRecord::Created`, built after the fence stamps), not for an assistant
   chat.
3. **Revive on reattach** (`launch_prep.rs`). `plan_for` asks the record only
   for a Stale stamp with a grant (`Listener::candidate` → `judge`); a passing
   row makes the launch grant as a create (`verdict == Create || reviving`),
   then after the fence `root_mcp_reattach::revive` swaps each fresh session
   whose identity matches the recorded lane (`LaneRow::matches`: caller,
   project, schedule target + agent, push dir, fence scope, unfenced host; no
   endpoint/model) for the recorded hash (`rekey`, `git_at_spawn` from the
   record, tabs seat re-enrolled), revokes the rest, and strips every lane token
   from `opts.env`. `mcp_stale = outcome.lost` (any recorded lane that did not
   come back). At commit the session is re-stamped with this run's nonce and its
   first revived hash (`SessionMux::restamp_mcp`, tmux `set-option -t =<s>:`;
   the default — Windows host — cannot) and the row rewritten (`revived_row`).
4. **Guards** (`Listener::judge`, each a `Refusal`): first-try bind, stamp port =
   row port = own, stamp nonce = row nonce ∈ {this run, the previous run that
   passed at start}, downtime `< 30 min`, stamp grant = row grant,
   `cli_revives`. Plus in `revive`: the launch's project = the row's, and no
   recorded hash already held (fail closed). A refused row is dropped.
5. **Listener start** (`commands/root_mcp.rs`). `bind_window` → `Bound
   {first_try, lost}` (its fallback avoids the host's port); `bind_host` binds
   `host-port` first (never the window's port), remembers a new one;
   `open_reattach_record` opens and installs the record: a fallback purges it,
   a record past the cap or on another port loses its rows, rows of any older
   run go, and the file is rewritten as this run's. `reattach_heartbeat`
   (immediately, then every 5 min) refreshes `last_alive` and drops rows of
   sessions the mux no longer lists. `stop_for_exit` deletes the window's file.
   `start_headless` remembers nothing under `cfg(test)`.
6. **R1's own-port note.** `classify_reattach` takes `own_port`: a foreign
   nonce on this listener's port is an own-store lookup (never a probe), and
   `plan_for` honours it only while `within_cap` → `adopt`. A stamp on the
   port this listener lost is never probed (R1's squatter nit).
7. **R1's race (fixed).** The create stamp is `set-option -q -o`: set only where
   unset, silent and successful otherwise, so an attach never overwrites a
   stamp. Regression test on a real tmux (private socket).
8. **503 while pending.** `admit` answers `503` (audit `revival_pending`) to a
   bearer whose hash is a previous run's revivable lane not yet revived or
   refused, within the cap (`pending_bearer`), instead of `401`.
9. **Lifecycle hooks**: `local_tmux_kill` → `on_session_gone`,
   `local_tmux_rename` → `on_session_renamed`, `local_tmux_kill_app_sessions`
   → `on_all_sessions_gone` (rows cleared), `stop_for_exit` → `on_clean_quit`.

### Deviations from the plan

* **In-run revival.** A row of *this* run is revivable too (a PTY teardown
  released the tokens in memory, the session lives on: a popout move, a
  webview reload): downtime 0, same guards otherwise. It is what "release_tab
  keeps the row" buys.
* **No revival at all in a fallback run**, in-run included (the guard is
  per listener, not per row).
* **CLI rule**: Claude/Codex/OpenCode yes; Copilot only under 50 s (with a
  5-minute heartbeat that is rare); a local Vibe model never; an unwired CLI
  (env pair → `tabtivity-mcp`, stateless per call) yes; any other wired CLI no.
  The CLI checked is the record's `cmd_stem` (the agent running), not the
  relaunch's.
* **Stamp grant** is the first *revivable* lane's hash (`stamp_grant`), not
  the first lane's, so a revived session's stamp names a session the store
  holds. Phase 1 reads any held lane the same.
* **A partially revived tab is Stale** (plan step 7). `servers_of_tab` is then
  empty although the revived lanes work; the card says "disconnected".
* **Assistant chats** keep the Phase 1 way (no row).
* **`last_alive` is per listener**, not per row.
* **The 503** is beyond the plan (see "For R2/R3").
* **No frontend change**: Stale already covers every case the plan names; the
  per-CLI expectations live in `agent_mcp_wiring.md` §5.

### Tests run (targeted, one at a time; no gates)

* `cargo test -p tabtivity --lib root_mcp_reattach`: 19 passed (record round-trip
  with older/unknown fields and 0600; open: fallback purge, cap, other port,
  corrupt file, older runs; every guard; CLI table; refused row dropped;
  revive: all six lanes, schedule/root/web never, lane switched off, project /
  target / push dir / fence scope / unfenced-host mismatch, other project, held
  hash; no plaintext in store or record; lifecycle incl. clean quit; pending;
  revived row; `adopt` after revival; stamp grant; the global
  release-vs-revoke test).
* `cargo test -p tabtivity --lib -- launch_prep agent_privacy session_mux root_mcp
  tmux_local tabs_mcp markup_mcp mobile_control::host`: 625 passed (new:
  own-port lookup within/past the cap, revival only for a stale stamp, the
  real-tmux race test `a_stamp_rides_a_create_only_and_never_overwrites_on_an_attach`,
  restamp argv, the updated source scan of `prepare`).
* `cargo test -p tabtivity --lib -- terminal api_proxy agent_fence`: 225 passed.
* `cargo clippy -p tabtivity --lib -- -D warnings`: clean.
* Not run: gates, `--all-targets` clippy, `--no-default-features`, app-serverd,
  Windows, vitest (no frontend change).

### For R2/R3 (security review): attack these

1. **The interception residual itself** (`threat_model.md`, loopback row): a
   local process binds the freed port while the app is down, collects bearers,
   releases the port before the restart, and the revival makes them live. Is
   "first-try bind" + 30 min cap + no schedule enough? Can a fenced agent hold
   the port across the restart *and* still not trigger the purge (e.g. bind
   only on IPv6 `::1`, `SO_REUSEPORT`, bind after our bind)?
2. **The record as an oracle or a lever**: can anything that can write
   `<state_dir>/root_mcp/reattach.json` (it is fence-hidden — verify) plant a
   row that revives a hash it knows into another identity? Note `revive`
   re-derives every identity field from the *fresh* grant and only takes the
   hash and `git_at_spawn` from the row; is `git_at_spawn` from disk a hole
   (gap 19)?
3. **Hash as credential**: every path that takes an id/hash from outside
   (`/mcp/grant/{hash}`, `revoke_session(id)`, `set_access(id)`,
   `holds_session`) — none may accept a hash where a token is meant.
4. **Stamp forgery / race**: `-q -o` on create; a tmux stamp an agent could
   set (the tmux socket is outside the fence — verify for the Host session and
   unfenced Windows); `restamp_mcp` targets `=<name>:` exactly.
5. **`adopt` after revival**: never carries schedule/root/reader/web
   (`unrevivable` revoke), cap enforced before it through `within_cap`.
   Can an own-nonce stamp naming a revived hash be used to move lanes into
   another tab?
6. **The 503**: does it leak anything beyond "this bearer is a pending
   revivable token" to someone who already holds the token? Can it be used to
   keep a CLI retrying against a squatter?
7. **Lifecycle holes**: rows surviving a kill that does not go through
   `local_tmux_kill` (the Mobile host's `runner.kill`, the privacy sweep,
   `end_sessions`) — they keep hashes until the heartbeat prunes the session;
   a session name reused before that gets a new stamp (nonce mismatch), but
   check. The quit race: a heartbeat patch landing after `delete`.
8. **Mobile host**: own port/record/nonce; the window never revives a
   host-stamped session (it probes the host); `bind_host` never takes the
   window's port. A host restart keeps its file (only the window's clean quit
   deletes one).
9. **`SpawnTokenGuard::retarget`**: a failed spawn after a revival releases the
   revived sessions (memory only), and the row stays — is a retry then
   correctly revived again or refused?

### Flags for the user

* Nothing was run live; the Windows host path is not compiled here.
* **Unverified CLI behaviour**: V0 measured "connection refused" outages only.
  Between the listener start and the tab's restore a previous run's token now
  gets `503`; how Claude/Codex/OpenCode/Copilot treat a `503` (or a `401`
  before revival, for a tab restored past the cap) is not measured. Worth a
  verify-cli pass.
* **Copilot** is effectively never revived (50 s cap vs a 5-minute heartbeat).
  A shorter heartbeat would help it at the cost of more writes.
* **Residual of the race fix**: a session from a pre-stamp build (no stamp)
  that loses the listing race is stamped by the attach.
* The plan file `docs/done/mcp_reattach_plan.md` still says "Nothing implemented".

## R3: Phase 2 security verification

Verified R2's six findings from the code, on `8eedce18e`; fixes are one
commit each with a regression test that fails without it
(`git log 8eedce18e..`).

### Verdicts

1. **Medium, interception survives the first-try bind: CONFIRMED, fixed by
   the peer check the user chose (see "Finding 1: the peer check" below).** A std-socket test on Linux: a
   squatter that set `SO_REUSEADDR` keeps its accepted connection after
   closing its listener, the app's bind (Rust sets `SO_REUSEADDR` on Unix)
   succeeds on the first try, the old connection still delivers to the
   squatter, new connections reach the app; without `SO_REUSEADDR` on the
   squatter the app's bind fails (`EADDRINUSE`, fallback, purge). Fenced
   agents share the host network (`--unshare-net` only for Local models
   only projects) and know the port from their own MCP URLs. The core of
   the risk (harvest during downtime, release before restart) was already
   the accepted residual; the first-try guard narrows less than the docs
   said. `loopback_owner` exists but reads only `LISTEN` rows and walks
   `/proc/*/fd` of this uid (no peer lookup, Linux only).
2. **Low, a revoke undone by a stale row write: CONFIRMED, fixed.** The
   listener keeps the hashes this run revoked (`forgotten`): every write
   strips them (a created or revived row written at commit after a revoke),
   so does `candidate`; `forget_hashes` writes under the write lock (the
   unlocked "named" pre-check is gone) and removes the record when its write
   fails. Residual: a state dir that can be read but no longer written keeps
   the hash on disk for a later run (this run still revives nothing of it).
3. **Low, backward clock step: CONFIRMED (the cap stretched by the step,
   not "never expires"), fixed.** `now < last_alive` is refused, and
   `Listener::clock` (wall at open + monotonic elapsed, never behind the
   wall clock) feeds `within_cap`, `candidate` and `pending_bearer`.
4. **Low, revival creates a fresh tokenless agent: CONFIRMED, fixed.** A
   revival is `host_attach_only`; on tmux an attach-only launch's argv is
   the attach client's (`attach_only_client`), so a session gone since the
   3 s listing is never created; the commit drops the row when the session
   is gone. The AI switch's rejoin (same never-create rule, same tmux hole)
   is covered by the same code.
5. **Low, a schedule/root hash written as the grant: CONFIRMED, fixed.**
   `created_row` returns `None` without a revivable lane.
6. **Low, clean-quit race: CONFIRMED, fixed.** One per-listener `io` lock
   over every write and the delete.

### Tests run (targeted, one at a time; no gates)

* `cargo test -p tabtivity --lib root_mcp_reattach` (6 new tests).
* `cargo test -p tabtivity --lib -- launch_prep root_mcp_reattach` (new:
  `a_revival_only_attaches`).
* `cargo test -p tabtivity --lib -- root_mcp launch_prep session_mux tmux_local mobile_control::host terminal agent_privacy tabs_mcp`: 725 passed.
* `cargo clippy -p tabtivity --lib -- -D warnings`: clean. Not run: gates, `--all-targets`, `--no-default-features`, Windows (`attach_only_client` is unused there: `allow(dead_code)`).

### Finding 1: the peer check

* `Session::revived` is now `Option<String>`: the mux session the token was
  revived into (`revive(.., session, ..)` → `rekey`; a rename follows through
  `TokenStore::rename_revived`).
* `commands::root_mcp`: the server runs with
  `into_make_service_with_connect_info::<Peer>`; `Peer` (one per accepted
  connection) carries the client address and a verdict cache keyed by session
  id. `admit` asks `revived_peer_ok` for a revived session only, after the
  route check and before the body: no `ConnectInfo` → `401`.
* `root_mcp_reattach::peer_in_session` (blocking, `spawn_blocking`): the
  session's pane pid (`SessionMux::pane`), then
  `loopback_owner::peer_descends_from`: the client socket's row in
  `/proc/net/tcp{,6}` (`connection`: local = peer, remote = 127.0.0.1:port),
  same uid, its holders through `/proc/*/fd` (`proc::walk`, uncached), each of
  whose `PPid` chain must reach the pane pid (`descends_from`, bounded).
* `revivable_on(caller, peer_checked)`, `PEER_CHECK = cfg!(target_os =
  "linux")`: without the check git and tabs are not revived (no hash
  written, `stamp_grant` skips them).
* The Mobile host's rejoin of a session that ended meanwhile says so
  (`SESSION_ENDED`); the AI switch's code only while the switch is off.
* Tests: `loopback_owner` (connection parse, `PPid` parse, ancestry through a
  fence, a real socket inside/outside), `root_mcp_reattach`
  (`git_and_tabs_are_revived_only_where_the_peer_is_checked`,
  `a_revived_token_is_honoured_only_from_its_own_pane_tree`,
  `a_rename_moves_a_revived_sessions_binding`), `commands::root_mcp`
  (`a_revived_token_from_an_unknown_peer_is_refused`), the host's rejoin test.
  `cargo test -p tabtivity --lib -- root_mcp loopback_owner launch_prep
  session_mux tmux_local mobile_control::host terminal agent_privacy tabs_mcp
  api_proxy ollama_client sign_in`: 796 passed; `cargo clippy -p tabtivity
  --lib -- -D warnings`: clean. Not run: gates, `--all-targets`, macOS,
  Windows.

### Flags for the user

* **Unverified: a CLI that makes itself non-dumpable** (Codex's process
  hardening may set `PR_SET_DUMPABLE 0`) hides `/proc/<pid>/fd`, so its
  revived tokens would always be refused (fail closed, the tab stale until
  Reconnect). Worth one live check per CLI.
* The phone gets the generic launch-failed code for a revival whose session
  ended; the text (logged) now says the session ended.
* Nothing was run live; macOS/Windows paths not compiled here.
