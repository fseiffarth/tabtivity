# Remote-host tabs on the phone — handoff

Plan: `docs/mobile_remote_host_tabs_plan.md`. Each agent edits only its own
section below (shas, choices, gotchas, gate status + test counts, "Flagged
for user").

## R: sidecar (branch `mobile-host-r`, `.claude/worktrees/mobile-host-r`)

Done, steps 1–6, three commits on develop 21eadf64, not pushed:

- `d29097fa` groundwork: `remote::{spec,compute_hosts}_from_value`;
  `ssh_exec::host_mux_args` (literal ControlPath, `-T`/`-tt -q -e none`,
  `BatchMode`, `ControlMaster=no`, `ProxyCommand=false`,
  `ClearAllForwardings`, no agent/X11 forwarding, `PermitLocalCommand=no`,
  `RemoteCommand=none`, `[-p]`, target, `--`, command), `master_check_args`
  and a strict `master_alive(path, limit)`, and
  `host_tmux_{attach,capture,window_size}_command` (which return `None` for a
  name that is not `[A-Za-z0-9_-]`); `AuthStore::has_live_session`;
  `output_within` moved from discovery to `paths`.
- `2700d51b` the feature: discovery (`ProjectHosts`, `host_of_tab`,
  `TabPlace`, `PublicTab.on_host`, `host_probe_targets`,
  `CatalogCache::with_host_live`), new `host_live.rs`, `pty_bridge`
  `AttachTarget`, host.rs refusals, `terminal_target`, the wiring, the
  headless skips, the scheduler pin.
- `625f5534` docs: `mobile_access.md`, `mobile_sidecar.md`, backend filemap
  rows (`discovery.rs`, `ssh_exec.rs`, new `host_live.rs`).

Choices:
- `TabPlace::Host { spec: Box<RemoteSpec>, control_path: Option<PathBuf> }`:
  `control_path` is the socket the last round found. `None` makes the upgrade
  `409 host_offline`. `Some` with the session missing is `410 session_gone`.
  `Some` with a dead master at the upgrade's `-O check` is `409
  host_offline`. The name `TabPlace` clashes with `protocol::TabPlace`, which
  host.rs imports, so host.rs only calls the methods (`on_host()`,
  `host_ssh()`).
- `persist_sessions` is read straight from the `remote` value. A record whose
  `remote` does not parse as a `RemoteSpec` has no primary, so it lists no
  primary-host tab.
- An unknown location string (not `local`/`remote`/`host:<id>`) is not listed.
- The refresher runs only behind `enable_background_relays` (the real
  sidecar/daemon entry points), like the relays, so a test host never probes.
  Its gate ticks every 2 s, and a round runs at most every 10 s. The first
  round after a phone signs in is therefore within ~2 s. While no phone
  session is live the snapshot is emptied.
- An unreadable `settings.json` counts every host as HPC (no `tmux ls`).
- A failed `-O check` with a window up means dead at once. Only `tmux ls`
  failures carry the last answer forward for 60 s.
- `last_activity` is `null` for host tabs; the `tmux ls` names are the only
  facts kept.
- Sibling bug fixed: a host agent tab closed from the phone with no window
  went into `workspaceClosedTabs` and would have shown under "Recently
  closed", where reopen answers `not_attachable`. `headless::closed_tabs`
  now lists only records `launch_options` accepts.
- The no-dial test is `#[ignore]`d
  (`host_mux_args_fail_fast_without_dialing_when_no_master_listens`, run with
  `--ignored`). I ran it, plus a manual `ssh -v` with the argv against a
  missing socket. Result: "Control socket … does not exist", then "Executing
  proxy command: exec false", exit 255, no "Connecting to". The test uses
  `-F <empty file>` because the fence's `/etc/ssh/ssh_config.d` has
  permissions ssh refuses.

Gotchas / for the merge:
- The merge-time Rust hunk is still the main agent's job. A
  `#[cfg(test)] phone_lists_tab(host, shells_in_container, kind, location)`
  already exists in discovery.rs. The test
  `the_table_level_listing_rule_lists_every_remote_projects_tab` already
  checks it against `reach || host == "remote"`. The hunk only needs
  `assert_eq!(phone_lists_tab(…), row["lists"].as_bool().unwrap())` in
  `the_project_host_table_matches_the_windows`.
- With the window up, the held/schedule/send routes still go to the desktop,
  as the plan says. Only the no-window fallback answers `tab_on_host` (the
  held fallback passes it through `held_call`'s allow-list as 409).
- The sidecar must see the desktop's `XDG_RUNTIME_DIR`/state dir to resolve
  the same `control_dir()` (known limit, unchanged).

Gates (worktree, `scripts/gates.sh`, final run rc 0):
- PASS: brand, whitespace, clippy (tabtivity + app-serverd, all targets),
  clippy-dlib, clippy-dmn, `cargo test -p tabtivity -p app-serverd` (lib
  4443 passed + 6 ignored; `it` 144), test-dlib.
- Cross-checks, src-tauri, `--no-default-features --features desktop`: Windows
  msvc clippy `-D warnings` clean; `aarch64-apple-darwin` `cargo check
  --all-targets` clean.
- Not run: the full `scripts/ci-local.sh`, and nothing live.

Flagged for user:
- With no window, host tabs are listed from the socket file alone, as the plan
  decided. A stale socket shows `available` until the upgrade answers
  `host_offline`.
- Not verified: OpenSSH forwarding `TERM=vt100` from the mux client to the
  remote PTY (the plan's claim). Check it in the live test (step 1 of the
  plan's Verification).
- The daemon (`Listen::Unix`) runs the same refresher. Which liveness branch
  it takes depends on whether it holds a timer lease; not verified
  (harmless, it never dials).

## W: window + phone (branch `mobile-host-w`, `.claude/worktrees/mobile-host-w`)

Done, steps 7–9, two commits on develop 21eadf64, not pushed:

- `a28b58f0` window: `phoneListsTab` in `lib/projectTabHost.ts` (a remote,
  non-VM project lists every tab, otherwise `phoneReachesTab`), used by
  `MobileBridgeHost.phoneTabs`; create/reopen keep `phoneReachesTab`. Shared
  fixture `projectHostReach.fixture.json` gains `lists` (= `reach || host ==
  "remote"`, 6 of 81 rows differ from `reach`), asserted in
  `MobileTabReach.test.ts`. Frontend filemap rows updated.
- `89682202` phone: `TabRow.on_host`, chip, the offline line, the hidden
  controls, the `connection.ts` codes, i18n (5 dicts), the untested row,
  `docs/help/mobile.md`, and QA box **31cj** beside 31ci.

Choices:
- The chip reuses `.agent-mode-mark` with no modifier, so it takes the
  neutral currentColor (PLAN/GOAL use the same class).
- "Hide Mark up Submit": `Terminal`'s `markupTarget` is undefined for an
  `on_host` tab, so its viewers offer no Mark up at all (Submit is the only way
  out of marking). Project's markup `linked` never picks an `on_host` row.
- "Hide From this phone / From the desktop": the composer's + keeps only the
  "Project file" @ tile (camera and gallery upload to the inbox too).
- Sign-in: `signInWay` is null for `on_host`, which removes the Status sheet
  button and the signed-out banner. A sign-in link the CLI prints on screen
  still shows its notice; relaying its localhost callback gets the sidecar's
  `tab_on_host`, shown as a sentence.
- Schedules: a new `schedulesOffered(tab, terminalsOffered, desktopAvailable)`
  in `TabCard.tsx` hides ◷ and the ⋯ "Scheduled prompts" row only when
  `on_host && desktop_available === false`. PromptsSheet drops `on_host` tabs
  as send-now targets then. TabCard's `terminalsOffered` prop is renamed to
  `schedulesOffered`, since that was all it controlled.
- Held prompts: no UI change. `holdDraft`'s failure path already types the
  text straight into the session, so a headless `tab_on_host` refusal falls
  back to typing it.
- Terminal reconnect: after two failed upgrades the tab probe reports
  `host_offline` instead of `session_gone` when the row is `on_host` and
  unavailable. The upgrade's 409 has no closing frame, so this is how the
  phone learns why.
- Also reworded `mobile.hostReach.remote` (the desktop's picker line), which
  had the same false claim as the two strings the plan named.
- Bug fixed on the way: `wrapAgentTabForPhone` answered `null` ("activated")
  for a host tab whose pane was not drawn yet. It now refuses any non-local
  tab of a remote project with `session_gone` before the readiness check.

Gotchas / for the merge:
- `MobileEveryProjectType.test.tsx` encoded the old rule (host tabs →
  `tab_not_found`). Now the unlisted examples are container tabs, and a new
  case pins what a host tab gets: schedules, rename, colour and seen are
  served; `tab_worktrees` answers `not_movable` (the `worktreeMoveDir` rule
  still holds); `activate` answers `session_gone`. A host shell gets colour
  and close; the agent-only handlers still answer `tab_not_found`.
- `MobileProjectAccess.test.tsx` matched the old `hostReach.remote` wording;
  updated.
- The Rust fixture hunk (`row["lists"]` in
  `the_project_host_table_matches_the_windows`) is still the main agent's job.
- `i18n.ts`/dicts/`untested.ts` have uncommitted edits in the main tree from
  another session; merge, never overwrite. The new keys sit after
  `mobile.project.hostRemote` and `mobile.failure.notAttachable`.
- `mobile-dist/` is gitignored; nothing to commit from `npm run mobile:bundle`
  (it built clean).

Gates (worktree, `scripts/gates.sh --base 21eadf64`, rc 0): brand,
whitespace, lint-fe (0 errors, no new warnings), clippy ×3, build, vitest
(--changed), `cargo test -p tabtivity -p app-serverd`, daemon test-dlib: all
PASS. Full `npx vitest run`: **918 files, 9302 tests, all pass** (hardlinked
node_modules). Not run live.

Flagged for user:
- With no window, the phone hides a host tab's schedules and send-now. Held
  prompts still go through, typed straight in.
- A host tab offers no Mark up from its own viewers. The alternative would be
  a Submit into a new local agent in the mirror; say if you want that.
- QA box 31cj has the four platform children per the rule, but the plan lists
  no host tabs on Windows (no tmux).

## Security review of R

Reviewed `21eadf64..625f5534` adversarially (ssh argv, host_live gates,
catalog rule, every `/tabs/{id}` route, PTY bridge). Held up: the no-dial
argv (`ControlMaster=no` + `ProxyCommand=false` + literal path; `--` is
consumed by ssh's second getopt pass; host/user through `ssh_target`; tmux
names `[A-Za-z0-9_-]` and quoted), no network work under the catalog lock,
HPC hosts get no background `tmux ls`, no `-O check` without a window, the
refusal list, the 5 s re-check, the per-phone filter, ssh child reaped on
teardown, one-shots under a deadline.

Fixed on `mobile-host-r` (each with a regression test):
- `468e82c8` — the host attach printed tmux's refusals into the phone's
  screen (`can't find session: <name>` carries the raw scope id; `no server
  running on /tmp/tmux-<uid>/default`; `tmux: not found`). With no window or
  on an HPC host a host tab is available on its master alone, so that was
  the ordinary case. Now `has-session && exec attach`, stderr discarded.
- `9881f405` — the same case closed bare, and the phone reconnected every
  ≤15 s forever (its tab endpoint still says available): four mux sessions
  per turn, keeping a master the closed window left behind alive past
  `ControlPersist`. The bridge now reads ssh's exit code at EOF: 255 →
  `host_offline`, other non-zero → `session_gone` (new `Closing` reason the
  phone already describes), both final; 0 still reconnects.
- `1ca61f70` — the three host-tab route tests in `host.rs` panic on the
  Windows CI runner (Windows lists no host tab); now `#[cfg(unix)]`.

Flagged for user:
- **Masters kept alive with a window up.** While a window holds the lease
  and a phone is signed in, every 10 s `-O check` (and `tmux ls` off HPC)
  resets `ControlPersist` on each host with a listable host tab — HPC hosts
  included, and hosts the desktop stopped using without a disconnect. The
  plan accepts this ("the desktop's anyway"); if not, probe only hosts the
  window's pool currently holds.
- **User ssh_config runs every round.** `ssh -G` (no deadline) per target
  every 10 s, even with no window and for HPC hosts, plus the `-O check`/
  `tmux ls` calls, each evaluate `Match exec` (often an `nc -z` network
  probe); a hanging one stalls the refresher for good (stale snapshot, not
  cleared on logout). Options: cache the resolved path per spec across
  rounds, give `ssh -G` a deadline, `-F none` on the no-dial lane (it needs
  nothing from the config). `CanonicalizeHostname always` also makes ssh
  resolve the host in DNS before the mux attempt (no connect).
- **`[detached (from session <name>)]`** is printed by the tmux client on
  stdout when the desktop re-attaches with `-D`, so the name reaches the
  phone — local tabs too (pre-existing), not silenceable from the script;
  would need a filter in the bridge.
- Headless close runs local `tmux kill-session -t <host tab's name>` (plan
  pinned); harmless unless a local session of that name exists.
- A refresher `tmux ls` over a hung master can outlive a sidecar quit (its
  deadline thread dies with the process).

Gates after the fixes (worktree at `9881f405`, `scripts/gates.sh --base
21eadf64`, rc 0): brand, whitespace, clippy ×3 (zero warnings), `cargo test
-p tabtivity -p app-serverd` **4618 passed, 0 failed, 6 ignored**, daemon
test-dlib PASS (2473 `ok` in its log, no failure). No frontend change, so
lint/build/vitest were skipped. The Windows/macOS cross-checks
(`ci-local.sh`) were not run. Not run live.

## Final review

Reviewed `21eadf64..056add72` on `mobile-host-r`, then fixed two bugs (each
with regression tests), committed, not pushed:

- `fd411cc4` — the refresher's `ssh -G` (the security review's flag).
  `ssh_exec::resolve_control_path` now runs under `RESOLVE_TIMEOUT` (5 s).
  `host_live` keeps each host's resolution (`Memory.resolved`): 5 min
  (`RESOLVE_KEEP`) while it finds a master, 60 s (`RESOLVE_RETRY`) while it
  does not (no answer, no socket file, dead master). Hosts no longer probed are
  forgotten. `paths::output_within` (every sidecar probe: `ssh -G`, `-O
  check`, `tmux ls`, host one-shots, local `tmux ls`) now puts the child in its
  own process group and kills the group at the deadline, so a hung `Match
  exec` child no longer outlives `ssh`. On Linux it arms `PR_SET_PDEATHSIG`,
  so no probe outlives a sidecar that quits mid-round. Its pipe readers get a
  2 s grace and keep what they read, instead of joining with no bound. Tests:
  4 cache tests in `host_live`; `output_within_kills_the_childs_own_children_at_the_deadline`
  (checked to fail without the group kill) and
  `output_within_does_not_wait_on_a_pipe_a_runaway_holds` in `paths`.
  Rows updated in the backend filemap and `mobile_sidecar.md`.
- `152d27fd` — `pty_bridge::recheck` closed every host tab that went
  unavailable as `host_offline`. When the round found the master but the host's
  tmux no longer lists the session, it now closes as `session_gone` (final).

Checked and found fine: `on_host`, `host_offline` (409 and close reason),
`tab_on_host` (409 on every listed route), and `session_gone` all match
`api.ts`/`connection.ts`. The phone's reconnect probe works. The catalog's
`phone_lists_tab` matches the window's `lists` column. The five i18n keys are
in all five dictionaries and each is used. The `mobile.project.onHost` row and
its pill are there. Unix-only tests are `cfg`-gated, and paths use `join`. No
TODOs are left.

Flagged for user:
- **An ended host session reads as "host offline" on the phone.** TabCard's
  line and Terminal's reconnect probe treat any unavailable `on_host` tab as
  `host_offline`. With a window up and the master alive, a session that
  ended also shows "Connect this project on the desktop". The phone cannot
  tell the two apart without a new field (contract change), so I left it.
- **The no-dial lane still reads the user's ssh_config.** `-O check` and
  `tmux ls` run every 10 s with a window up, and each evaluates `Match exec`.
  These calls are now bounded and group-killed. `-F none` on
  `host_mux_args`/`master_check_args` would stop the config from running at
  all (the argv needs nothing from it). That is a design choice.
- The die-with-parent signal is Linux-only: on macOS a sidecar killed
  mid-probe can still orphan an `ssh` stuck on a hung master. A `Match exec`
  grandchild running when the sidecar itself dies (as opposed to hitting the
  deadline) is not covered either.
- Small wording drift: the untested row and the QA text say the offline card
  "does not open". It opens the terminal, which stops with that line after two
  failed upgrades. 31cj also still says "the sidecar half on its own branch".

Gates (worktree at `152d27fd`, `scripts/gates.sh --all`, rc 0): brand,
whitespace, lint-fe (0 errors, 28 warnings, none from this review, which
changed no TS), clippy ×3 at zero warnings, build, vitest, `cargo test
--workspace` **4862 passed, 0 failed, 6 ignored**, test-dlib PASS. A separate
`npx vitest run` gave **9302 tests passed**. `npm run mobile:bundle` built
clean. `scripts/privacy-check.sh 21eadf64 HEAD` was clean. `scripts/ci-local.sh
--fast` gave rc 0 (Windows clippy/check, macOS check and daemon ldd all ran).
Skipped: gitleaks (not installed), and test-core/test-gateway (`--fast`,
untouched). Not run live.
