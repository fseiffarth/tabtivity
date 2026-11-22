# Screen 2026-11-12 — handoff A (H1, H2, H9, H11)

Plan: `docs/screen_2026_11_12_fix_plan.md`. Branch `worktree-agent-a26f0ad821847d7c3`,
based on develop `214933ab5`. Not run live.

## Commits

Cherry-pick in this order:

- `81d98af3b` fix(fence): H1, root scope never keeps `sandbox`, and the fence
  match fails closed.
- `0a2c62dec` fix(scopes): H2, `host` is reserved.
- `eeff0f713` fix(tmux): H9, `=<name>` targets plus a name check in `local_tmux_kill`.
- `69bd36a66` fix(worker-sync): H11, an ask that arrives mid-run is queued
  (coalesced rerun).
- this handoff (last commit).

## Choices made

- **H1.** Two layers, as the plan says.
  - `sandbox::enforce_spawn_authority` with no project forces `sandbox = false`
    (logged when it flips). `resolve_spawn_authority(has_project = false, …)`
    now answers the same, so the pure matrix and the wrapper agree; the old
    "projectless passes through untouched" test became
    `a_projectless_spawn_keeps_local_only_and_never_a_container`.
  - `launch_prep::prepare` records `docker_wrapped` / `ssh_wrapped` at wrap
    time (`ssh_wrapped` = `remote_target_of` resolved, read just before
    `ssh_exec::wrap_pty_options`). The fence match's `_ => {}` became an
    `other` arm that, for a local agent, calls the pure
    `unfenced_local_agent_allowed(decision, docker_wrapped, ssh_wrapped)` and
    returns `Err` otherwise. Allowed: `shell`, Host session, `container` only
    when docker-wrapped, `remote host` only when ssh-wrapped. A future
    `NotApplicable` reason fails closed. A `!local_agent` spawn (cmd is
    `ssh`/`docker`/`podman`) is unchanged: it carries its own boundary.
  - Tests: two in `sandbox.rs`, a decision table plus a source scan (no
    `_ => {}` left in `prepare`) in `launch_prep.rs`.
- **H2.** `storage::is_reserved_scope` reserves
  `agent_home::HOST_SCOPE_KEY` with the same folding. Every registry/import
  funnel already asks it, so create/import/transfer/boxes refuse `host` the
  way they refuse root/assistant. The vacuous `agent_home.rs` assertion now
  checks that `host`/`Host`/` HOST ` fold onto the Host home's key **and** are
  reserved. `validate_project_id` test extended. Comment on `HOST_SCOPE_KEY`
  corrected; `docs/context/assistant.md` funnel line updated.
- **H9.** `local_tmux_kill_args` / `local_tmux_rename_args` target `=<name>`.
  `local_tmux_kill` checks `valid_tmux_session_name` first (before
  `tmux_available`, so the test touches no tmux) and returns `Err` on a bad
  name, as `local_tmux_rename` does for its new name.
- **H11.** `WorkerSyncRegistry` gained `rerun: HashMap<key, force>` with
  `begin(key, force)` / `finish(key)`; `finish` checks and releases under one
  lock, so no ask falls between. `sync_worker_guarded` loops while `finish`
  says rerun; each pass re-reads the mirror HEAD (inside `sync_worker`) and
  emits its own `worker-sync-report`; the caller that ran gets the last
  report. A queued ask returns `{ok: true, skipped: false, queued: true,
  head: None}` and emits nothing (the running loop reports). New
  `WorkerSyncReport.queued` field; `RemoteMachinesWindow.tsx` shows a queued
  report as the existing "Syncing…" string (no new i18n key).
  `docs/context/git_sync.md` updated.

## Gotchas

- The H1 red runs were not observed separately: the first compile in the
  shared target dir waited on the lock long enough to pick up the fixes.
- `local_tmux_kill` now refuses a session name with characters outside
  `[A-Za-z0-9_-]`. App-minted names always pass; a foreign session with a dot
  or colon in its name can no longer be killed from the Sessions view
  (rename already required a safe *new* name).
- A rerun after a forced ask is a full bundle; an unforced rerun short-circuits
  when the worker already has the newest HEAD.

## Gates

`scripts/gates.sh` (touched gates, on the four fixes before they were
committed; the commits change nothing in those files): **all 10 PASS**, with
zero warnings. The 10 were brand, whitespace, lint-fe, clippy (workspace
crates touched), clippy-dlib, clippy-dmn, build, vitest `--changed`, test
(`-p tabtivity -p app-serverd`) and test-dlib. Total time 49 min, much of it
waiting for the shared target dir's lock.

Test counts: a focused run over the touched modules gave **360 passed**
(`sandbox launch_prep storage:: agent_home tmux_local commands::terminal
worker_sync commands::projects`). The gate run's own logs were removed on
success, and `/tmp` is shared with the other implementers, so the full-suite
count isn't kept here. The coordinator's merged-tree run will report it.

## Flagged for user

- **H2, not in scope:** the Host home still lives at `agent-homes/host`, next
  to scope homes; and `project_key` still folds `box_x` with `box:x` (and
  `a.b` with `a_b`), so a project `box_x` and box `box:x` share a home and a
  live-session slice. Separate key namespaces would fix both.
- **H9 sibling, not fixed:** the remote tmux one-shots
  (`ssh_exec::tmux_kill_session_script`, `tmux_rename_session_script`) still
  use a bare `-t <name>` and so prefix-match on the host. The fix needs the
  `HOST_TMUX_EXACT` version switch (tmux 1.8 on HPC images has no `=`), and
  those scripts take arbitrary quoted foreign names that `host_sh` cannot
  carry as written — a small design choice for the user.

## To apply

- Filemap: nothing reshaped; no row change needed.
- No i18n, `untested.ts`, `command_class` or `commandClasses.ts` edit needed
  (no new command; `local_tmux_kill`'s class is unchanged).
- After merge: `npm run backend:stale` (backend edits in `sandbox.rs`,
  `launch_prep.rs`, `storage.rs`, `tmux_local.rs`, `terminal.rs`,
  `worker_sync.rs`).
