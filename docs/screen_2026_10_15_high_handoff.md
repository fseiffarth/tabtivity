# Whole-project screen 2026-10-15 High findings — handoff

Per-agent handoffs and review reports of the run, concatenated. Plan: `docs/screen_2026_10_15_high_plan.md`.

---

## Handoff A1 — S1a (backend-spawned login PTY)

Worktree `.claude/worktrees/high-s1`, branch `screen-high-s1`, base `dd5ede60`.

## Commits
- `7688ffca` fix(credentials): the backend spawns the login PTY a saved secret may be pasted into (A1)

## Backend contract for S1b

`pty_spawn(opts, sessionName)` — `opts` is `PtyOptions` (snake_case keys, no
rename_all). New optional key **`login`**:

```json
{"kind":"ssh","user":"alice"|null,"host":"h.example","port":2222|null}
{"kind":"vpn","config":"/abs/path/to.ovpn"}
```

- With `login` set the backend **ignores** `cmd`, `args`, `env`, `cwd`
  (send `cmd: ""`, `args: []`, `env: {}`, `cwd: ""` or anything — it is
  overwritten), forces `local_only = true`, clears `remote_host_id`, and spawns
  the login argv directly as the PTY program (`ssh …` / `pkexec openvpn …` on
  Linux, `openvpn.exe …` on Windows, `sudo <openvpn> …` on macOS). No shell
  before/after: when ssh/openvpn exits, the PTY's child exits → the normal
  `terminal-exit` event (`onTerminalExit(id)`), and the tab shows its usual
  exited state.
- **Refusals** (pty_spawn rejects with an `Err(string)`, i.e. the invoke
  throws; the tab's spawn error path shows it):
  - `login` + any of `project_id`, `agent`, `sandbox`, `host_session`,
    `local_model`, `tmux_session`, `tmux_attach`, `host_bound_uid`,
    `schedule_target_id` → `"a login terminal cannot be <a project tab|…>"`.
  - `login.kind == "vpn"` from a browser/server client (`Caller::Client`) →
    `"a login terminal cannot be a browser client (a VPN login is the desktop's)"`.
  - a server client whose id is a running local-tmux tab another client owns →
    `"terminal: '<id>' is a running tab; a login opens in a tab of its own"`.
  - bad target (host/user starting with `-`, control chars, empty/bad config)
    → the argv builder's validation message (formerly thrown by
    `remote_login_command` / `openvpn_login_command` *before* the tab opened;
    now it is the tab's spawn error — plan "Lost early validation").
  - Windows without `openvpn.exe` → the existing `OPENVPN_MISSING` text.
- **Paste**: `credential_paste_to_pty({pty, target, submit})` unchanged in shape.
  It is allowed only into a PTY whose *current* spawn was a successful login
  spawn for a target whose accounts include the credential. The mark is dropped
  when the login's child exits, on `pty_kill` / `pty_kill_scope` / client reap,
  and at the top of every `pty_spawn` of that id (refused spawns included).
  After exit a paste returns the existing error
  `"that terminal is not a login for this credential — open the connection's login terminal and try again"`.
- **Deleted commands**: `remote_login_command`, `openvpn_login_command`
  (registration, `command_class` rows, `commandClasses.ts` regenerated). The
  frontend call sites still invoke them until S1b lands (vitest mocks them, so
  tests pass; at runtime they would fail with "unknown command").
- `pty_write` no longer inspects input (the `note_pty_input` hook is gone):
  typing a command line into a shell never marks anything.

## Choices made
(filled at the end)

## Gate status
(verified by A6, 2026-10-15, worktree `high-s1` at `7688ffca`, before S1b's edits)
- `scripts/gates.sh --base dd5ede60`: all PASS — brand, whitespace, lint-fe,
  clippy (`-p tabtivity -p app-serverd --all-targets -D warnings`), clippy-dlib,
  clippy-dmn, build, vitest `--changed`, cargo test, test-dlib
  (`--no-default-features --lib --test server_secrets`). Nothing red; no fix commit.
- Windows: `cargo clippy --manifest-path src-tauri/Cargo.toml --target
  x86_64-pc-windows-msvc --all-targets -D warnings` PASS (0 warnings); `cargo check
  --workspace --all-targets --target x86_64-pc-windows-msvc` PASS.
- macOS: `cargo check --workspace --all-targets --target aarch64-apple-darwin`
  (check-only cc/ar shims, as `ci-local.sh`) PASS.
- Cargo test count (`cargo test -p tabtivity -p app-serverd`, re-run on `068ca2d0`): 4235 passed, 0 failed, 4 ignored.

## A6 — S1b

Worktree `.claude/worktrees/high-s1`, branch `screen-high-s1`, one commit on A1's:

- `068ca2d0` fix(credentials): login terminals run the login as the PTY's program (frontend)
  (author fseiffarth@users.noreply.github.com)

### What changed
- New `src/lib/remote/loginTarget.ts`: `LoginTarget` (mirrors the backend enum),
  `sshLogin`/`vpnLogin` (blank user → null), `loginDedupeKey` (`ssh:<user@>host:<port>` /
  `vpn:<config>`, the spelling every flow pre-marked by hand before). Filemap row added.
- Tab plumbing: `TabEntry.login` (stores/tabs.ts); `toSavedTabEntry` leaves it out
  (comment); `isRestorableTab` → false with `login`; `withTmuxSession` mints no tmux name
  for a login tab; `tabTerminalSpawn` passes `login` and forces `sandbox` false and
  `tmuxSession`/`tmuxAttach` null for one (the backend refuses those combos — root shells
  otherwise get a local tmux session by default); `TerminalSpawnInputs`/`terminalSpawnKey`
  include it; `TerminalView` takes `login`, compares it by value (`loginKey`, like
  args/env) and sends `opts.login`.
- `openConnectionInRoot({label, login, dedupeKey})`: tab with `login`, no `initialInput`;
  on open it subscribes `onTerminalExit("root:<key>")` and drops the dedupe entry when it
  still maps to that tab → `connectionStillOpen` false → `pollRootLoginReady` reads
  "closed" and the next request opens a fresh login tab.
- All callers moved: `stores/projects.ts` (ssh + vpn), `vpnAutoConnect.openVpnLoginInTerminal`,
  `MachinesIndicator` (add/edit), `useRemoteReconnect`, `useRemoteSession`,
  `RemoteMachinesWindow`; embedded terms are now `{id, login, key}` and
  `RemoteConnectDialog`/`RemoteProjectSection`/`RemoteMachinesWindow` pass `login=` instead
  of `initialInput=`. No `remote_login_command`/`openvpn_login_command` call is left in `src/`.
- `openProjectShellInRootConsole`'s reuse skips login tabs (rootOverlay.ts).
- Docs: `docs/context/remote_credentials.md` (frontend half in the paste-gate paragraph;
  the create-dialog first connect), comments in `CredentialPasteBar`, `vpnPrompt`.

### The S4-flagged gap (first connect of a created project)
- Finding: nothing connected a just-created remote project on activation at all
  (`auto_connect` is unset on a new project, so `autoConnectPrimary` returns at once); the
  real first connect was the lamp's Connect, whose blank-password headless connect rides
  the creation dialog's login master with no `viaLogin` → `key_auth: true` on a password
  host. The comments claiming "activation connects" were stale.
- Fix: `connectCreatedRemoteProject(projectId, password)` in `lib/remote/remoteConnect.ts`;
  `ProjectDialog` (after `onProject`) and `HpcPipelineWizard` (after `addProject`) call it:
  `remote_connect {password: typed||null, viaLogin: !typed, background: false}` through
  `withHostKeyConfirm`; skips a lamp already connecting/connected; failure → `off` with no
  password (nothing to ride, e.g. Windows), `error` with one. So a new project now comes up
  connected right after Create (behaviour change, like ExtendToRemoteDialog).
- To merge cleanly with S4 I applied **S4's exact hunks** for the stash deletion
  (`stores/projects.ts` block, both dialogs' imports/stash lines, `remotePassword`
  destructure in ProjectDialog, the two `remote_credentials.md` paragraphs) — identical
  changes on both sides. My own additions sit ≥1 unchanged line away; the likeliest
  conflict is `HpcPipelineWizard.tsx` around `await addProject(project); // adds + activates`
  (I dropped "(which connects)" from that comment). ProjectDialog uses
  `remote.remotePassword`, so S4's removed destructure doesn't break it.

### Tests (new/changed)
- New `src/__tests__/remote/LoginTerminalTab.test.ts` (5): login tab shape (login, no
  initialInput, no tmux; spawn inputs null tmux/sandbox; key differs), exit → not open →
  fresh tab, late exit of an old tab doesn't clear the new mark, exit never clears an
  embedded (`markConnectionOpened`) mark, dedupe-key spelling.
- New `src/__tests__/remote/RemoteCreateFirstConnect.test.ts` (4): regression for the gap.
- `RemoteActivateConnect` (asserts `login` targets; new "ended login = closed, reopens a
  fresh tab"), `VpnTerminalHandoff` (login tab; the "command can't be built" case is gone —
  that is now the tab's spawn error), `VpnAutoConnect` (login tab), `CredentialPaste`
  (backend refusal shown after the login ended), `TabPersistFilter` (login tab not saved,
  not restorable), `TerminalSleepWake` (opts.login sent; equal target wakes, other target
  respawns), `InstallInRootConsole` (new signature).

### Gate status (S1b, in the worktree)
- `scripts/gates.sh`: brand, whitespace, lint-fe (0 errors), build, vitest `--changed` all
  PASS; cargo gates skipped (no Rust change in S1b).
- Full `npx vitest run`: **843 files, 8532 tests passed** (dd5ede60 + S1a + S1b; S4 is not
  in this tree).
- Cross-checks (run on S1a's Rust, unchanged by S1b): Windows msvc clippy + check, macOS
  check — PASS (see A1 "Gate status").
- Pre-commit privacy check flagged a `secret` binding and a test literal; renamed
  (`typed`, `"pw-test"`), re-ran that test file + eslint, then committed.

### Gotchas
- Root shell tabs get a local tmux session by default; without the `login` guard in
  `withTmuxSession`/`tabTerminalSpawn` every root login tab would be refused by the backend.
- A refused or failing login spawn (bad config, no openvpn.exe) is now the tab's
  `[spawn error: …]`; the lamp then sits "connecting" until `pollVpnUp`'s bound (root) or
  Disconnect (embedded reconnect terminal), as plan "Lost early validation" accepts.
- Embedded dialog logins are still marked with `markConnectionOpened` (owner `null`), so an
  exited embedded login keeps its dedupe mark until the dialog's Disconnect — unchanged,
  only root tabs self-heal on exit (as the plan specifies).
- Post-commit hook printed "EMBEDDED MOBILE PWA IS STALE"; left alone (as A4).

### Flagged for user
- Verification step 1 says "the paste bar types the password" in the **root console**
  login tab: there is no paste bar on root tabs (there never was; `CredentialPasteBar` sits
  only above the dialogs' embedded logins). The backend would accept a paste there now;
  adding a bar to root login tabs is a small follow-up if wanted. Not built.
- New behaviour, not run live: a remote project created in ProjectDialog / the HPC wizard
  now connects right after Create. Click-through: create a remote project (a) headless with
  a typed, unsaved password, (b) via "Sign in in a terminal" → lamp goes green without
  clicking Connect; then the Connect dialog's Auto-connect toggle must stay unavailable for
  the password host (no `key_auth: true` recorded).
- No i18n keys and no `untested.ts` rows added (no new UI).

---

## Handoff A2 — S2a (#3 exec_trust, #10 git_peer)

Worktree `.claude/worktrees/high-s2`, branch `screen-high-s2`, base dd5ede60.
Commit: **19deb9c6** `fix(security): exec_trust and git_peer probe fail closed on unreadable input`
Files: `src-tauri/src/services/exec_trust.rs`, `src-tauri/src/services/git_peer.rs` only.

## #3 exec_trust (`git_subjects`)
- New `Subject::file_or_unread` (None only on `NotFound`) and
  `Subject::unread_path` (label `"<path> (could not be read)"`, distinct from
  the readable label so no file content can fingerprint like the unread state;
  bytes = io error + `stat_summary` (unix: inode, mode, size, ctime.ns; else
  size + mtime) so swapping one unreadable hook for another changes the
  fingerprint).
- New `dir_entries(dir, &mut unread)`: missing dir → empty; read_dir error,
  entry error, non-NotFound metadata error → unread subjects. Replaces both
  `read_dir(..).unwrap_or_default()` + `flatten()` sites (hooks, `.husky`).
- `is_executable` now takes `&Metadata` (both cfg variants).
- Any unread in the hooks dir sets `have_hook = true`; additionally an
  unlistable (`0311`) hooks dir is searched by name for every hook git runs
  (`GIT_HOOK_NAMES`, githooks(5)) — a readable one there is fingerprinted by
  content.
- Failed `rev-parse --git-path hooks` (non-zero) → `unread("hooks", stderr)` +
  `have_hook = true`. Sibling fixed too: failed `config --list` (non-zero) →
  `unread("config", …)` (it can hide `core.fsmonitor` etc.).
- Hook-manager configs and `.husky` files use `file_or_unread`;
  latexmkrc/prettier keep `Subject::file` (per plan).

## #10 git_peer probe
- Pure `failed_repo_check_is_probe_error(remote, local_dir_exists, exit)`:
  empty only on 128, or (remote) 1/2 = failed `cd`; 255, 127, signal, spawn
  failure, anything else → probe_error. Missing local dir → never an error.
  Applied to local too (audit: local non-128 exits used to read as empty).
- Pure `classify_batched_probe(code, stdout) -> BatchedProbe {Answer, Error,
  Fallback}`: only exit 0 carries an answer (script always exits 0 once run);
  255 or signal → `Error` (returned directly, no re-dial) **even when the output
  parses** (a dropped link can truncate the tolerant trailing sections, e.g.
  `checked_out`); any other code → per-command fallback.
- Sibling fixed in `probe_per_command`: `for-each-ref` heads/tags and
  `status --porcelain` must succeed or the snapshot is `probe_error` (a dropped
  link used to read as "no branches / clean tree" — a clean tree is one a
  `reset --hard` may overwrite).
- `probe_error_snapshot()` helper; `PeerSnapshot.probe_error` doc and the
  #28p D4 comment updated.

## Tests (new)
exec_trust (unix, skip as root): `an_execute_only_hook_is_a_subject_not_nothing`
(0111 hook ≠ none ≠ readable ≠ error-text content; swap re-asks),
`an_unlistable_hooks_dir_is_a_subject_and_counts_as_a_hook` (0311 dir →
subject + manager config fingerprinted + by-name lookup finds pre-commit),
`a_missing_hooks_dir_is_nothing_but_an_unreadable_husky_file_is_not`;
any OS: `a_failed_hooks_path_query_is_a_subject` (`.git` file → missing gitdir).
git_peer: `a_failed_repo_check_reads_empty_only_on_an_explicit_no`,
`the_batched_probe_trusts_only_a_clean_exit`. The "never leads to reset" half
rests on the existing `pairing_dest_probe_error_is_symmetric` (probe_error dest
→ pairing blocked).

## Gates (scripts/gates.sh, touched)
All PASS: brand, whitespace, clippy (tabtivity+serverd all-targets), clippy-dlib,
clippy-dmn, test (`cargo test -p tabtivity -p app-serverd`), test-dlib.
tabtivity lib: 4063 tests in the binary (84 matched exec_trust|git_peer, all ok).
Not run: Windows/macOS cross-check (plan lists it for S1a/S2b/S3, not S2a;
exec_trust has new `cfg(unix)`/`cfg(not(unix))` code — `stat_summary`,
`is_executable(&Metadata)` — worth including in S2b's msvc/darwin check).

## Gotchas
- RTK hook rewrites output; use `rtk proxy`.
- Worktree target is `<worktree>/target` (workspace root).
- The commit's post-commit hook printed a "mobile PWA is stale" notice (about
  the running app's sidecar) — unrelated, left alone.

## Hot-file edits needed by main agent
None (no command_class / commandClasses.ts / i18n / untested.ts changes).

## Flagged for user
- Remote exit 128 is still "empty" per the plan, but git also exits 128 for a
  real repo it refuses (e.g. "detected dubious ownership"), and the batched
  script prints `norepo` for any failed `rev-parse`. Matching stderr text is not
  safe (ssh forwards LANG, so git's message may be localized). Residual.
- The batched script's in-repo queries (`status` etc.) still discard their own
  failures (`2>/dev/null`, empty section); only ssh-level failures (255) are
  caught there. Residual (rare: repo already confirmed).
- A non-repo dir hitting the git-hooks gate (e.g. Publish before init, if that
  ever happens) now asks once instead of passing silently.
- Not run live. Click-through: Commit on a project whose `.git/hooks` (or
  `core.hooksPath`) is `chmod 0311`, or with an execute-only (`chmod 0111`)
  hook → the approval dialog appears again.

## A7 — S2b (#6 git spawn sweep)

Commit: **96961006** `fix(security): every local git spawn goes through the hardened builder`
(on top of 19deb9c6, branch `screen-high-s2`). Finished the stopped agent's
uncommitted edits in 9 files; reviewed them, kept them, fixed what follows.

### Choices
- Hardened (`hardened_git_command_in`): `git_publish.rs` has_origin,
  unpublish's `remote remove origin`, rename_origin_aside (2 spawns);
  `git.rs` git_repo_root_blocking (subfolder `dir`; discovery walks up);
  `projects.rs` git_head_unborn; `git_init.rs` `git(dir, args)` (all Publish
  calls; `-c init.defaultBranch=… init` is still detected as `init` by
  `subcommand_of`, so no sanitize/pin there); `git_fork.rs` `remote add
  upstream` (now bounded too).
- Hookless (background): `git.rs` detect_git_providers sweep, `projects.rs`
  git_in (mirror), `usage_stats.rs` git_user_email.
- Left bare with a one-line reason comment: git_command (the builder),
  surviving_denylisted_key / sanitize_git_config_file (`config --file`),
  git_available, git_clone_blocking, git_remote_visibility_blocking,
  sync.rs diff_mirror_vs_host, dev_build.rs commits_behind/head_sha,
  skills.rs refresh_source (confirmed: `<state_dir>/skills_cache/<id>`,
  Tabtivity's own clone, not a project tree).
- Source-scan test `every_local_git_spawn_goes_through_the_hardened_builder`
  (commands/git.rs tests): walks every `.rs` under `src-tauri/src` at test
  time (not `include_str!` — a new file is covered automatically), matches
  `command_no_window("git")` / `Command::new("git")`, allowlist of
  `(file, fn, reason)`; also fails on a stale allowlist entry. Test code
  skipped: out-of-line `#[cfg(test)] mod x;` files and inline
  `#[cfg(test)] mod x { … }` bodies only (to the `mod` line's indent + `}`),
  so production code after a test module (git.rs has some) is still scanned.
  Self-test `the_git_spawn_scan_skips_test_modules_but_not_code_after_them`.
  Mutation-checked: a bare spawn appended after git.rs's test module fails it.
- Fixes on the stopped agent's version: it cut each file at its first test
  module (missed production code after it); `enclosing_fn` now counts the
  spawn's own line (a one-line fn names itself); usage_stats comment said
  "below" for the `log` above.

### Gates (scripts/gates.sh, touched) — all PASS
brand, whitespace, clippy (tabtivity+serverd all-targets), clippy-dlib,
clippy-dmn, test (`cargo test -p tabtivity -p app-serverd`), test-dlib.
tabtivity lib binary: 4065 tests (2 new).

### Cross-checks — all exit 0 (cover A2's cfg(unix)/cfg(not(unix)) code too)
- msvc: `cargo clippy --manifest-path src-tauri/Cargo.toml --target
  x86_64-pc-windows-msvc --all-targets -- -D warnings` (RC/AR shims)
- `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc`
- `cargo check --workspace --all-targets --target aarch64-apple-darwin`
  (ci-local.sh's check-only CC/AR shims)

### Gotchas
- projects.rs edits are two tiny local hunks (~1199 git_in, ~3293
  git_head_unborn); S3's `save_project` deletion is elsewhere (~2778).
- The scan only matches the spawn on one line; `command_no_window(\n"git")`
  split across lines would slip (rustfmt never does that for this call).
- post-commit printed the unrelated "embedded mobile PWA is stale" notice.

### Flagged for user
- Behaviour change: Publish's git_init calls and `remote add upstream` ran
  with the repo's hooks/config before; now sanitized + hooks off (none of
  them is a hook-firing verb, so no visible change expected).
- Sibling, not fixed (out of #6's scope, fails closed): `refusing_command`
  (git.rs, shared-project gate) spawns `/bin/sh`, which does not exist on
  Windows — the refusal still happens but as a spawn error, losing its
  message.
- Not run live. No dedicated click-through; regressions would show as
  Publish / Unpublish / fork import / usage recap / repo-root lookup failing.

## Review — S2

Reviewer of S2a+S2b (`git diff dd5ede60..screen-high-s2`). Fix commit:
**cb8d0a49** `fix(security): a repo git refuses never reads as an empty pairing side`
(on 96961006, branch `screen-high-s2`; `git_peer.rs`, `commands/git.rs`).

### Fixed (each with a regression test)
1. **Refused repo read as empty (git_peer).** git exits 128 for a repo it refuses
   (dubious ownership) or cannot read (damaged `.git`), same as "not a repo". The
   batched script printed `norepo` for *any* failed rev-parse (a host with no git
   too). Now "empty" = 128 **and** no `.git` entry: the script captures rev-parse's
   status and checks `[ ! -e .git ] && [ ! -L .git ]` itself, else prints
   `unreadable` → `probe_error`; the per-command probe asks `git_entry_present`
   only on 128 (local lstat, fail-closed on non-NotFound; remote one plain
   `cd <q> && test ! -e .git && test ! -L .git`, no braces for non-POSIX shells;
   any non-zero = present). No locale text matched. Tests:
   `a_repo_git_refuses_is_a_probe_error_not_an_empty_side` (real PROBE_SCRIPT with
   git's `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`, damaged `.git`, dangling `.git` link,
   remote check in real sh; mutation-checked), updated
   `a_failed_repo_check_reads_empty_only_on_an_explicit_no`.
2. **Sibling: transfer against an unread side.** `transfer_and_apply` used a
   `probe_error` snapshot's empty branch list: every source ref became an
   unchecked `update-ref` over the dest's tips (init_pairing's post-init probe,
   Sync leg 2's re-probe); an unread *source* returned a clean no-op. Now `Err`
   before any git/ssh. `init_pairing` also refuses when its own pre-probe of the
   dest errors (TOCTOU after the caller's check), before `git init`. Tests:
   `a_transfer_against_an_unread_side_is_refused`,
   `transfer_and_apply_refuses_an_unread_side_before_any_git`.
3. **`refusing_command` on Windows.** Spawned `/bin/sh` → spawn error, message
   lost. Windows now uses Git for Windows' `sh.exe` beside the git it would run
   (`helper_program("git")` or `resolve_executable("git")`, `sh_beside_git`);
   unix keeps `/bin/sh`. cmd/PowerShell rejected on purpose: a caller appends
   args (`repair_moved_worktrees`'s `worktree repair <paths>`), and both re-parse
   appended args as code; sh keeps them positional. Tests:
   `a_refused_call_runs_nothing_and_says_why` (+ appended `; touch` / `$(touch)`
   args run nothing), `the_windows_refusal_shell_is_found_beside_git` (pure,
   runs on Linux). Without any Git-for-Windows sh it still fails closed as before.

### Checked, no change
- exec_trust fingerprint: no remaining `.ok()?`/`unwrap_or_default` that drops a
  hook to "nothing" (by-name lookup's `.ok()` only runs when the dir is already an
  unread subject with `have_hook`; `--show-toplevel` failure falls back to `repo`).
- S2b conversions: hardened == hookless (both hooks off); none of the converted
  verbs fires hooks, so no exec_trust gate is lost. `--show-toplevel` and
  `remote get-url` outputs unchanged by the pin/sanitize (`-c` pins touch no
  remote URL; `include.path` stripping was already the norm). `init` keeps no
  sanitize/pin via `subcommand_of`. Allowlist entries all verified as non-project
  repos; other crates' git (gateway hub) out of scope.
- Every probe → `init_pairing`/`reset --hard` path: `pair_plan` makes a
  probe_error side the unseeded dest → `pairing_dest_probe_error` blocks;
  `resolve` needs both `is_repo`.

### Flagged for user (not changed)
- Remote path that is a *subfolder* of a refused/damaged parent repo still reads
  as empty (no `.git` in the folder itself); pairing would `git init` a nested
  repo there. Walking up would block projects under a foreign-owned parent.
- exec_trust: the hooks query's spawn/timeout `Err` arm adds a subject but does
  not set `have_hook` (the non-zero arm does), so hook-manager configs are not
  fingerprinted then. Not exploitable as far as I can see (the gated verb hits the
  same FIFO refusal/timeout), so left alone.
- Behaviour change: a folder with an empty/damaged `.git` (or a repo git refuses)
  now shows "repository could not be read; refusing to auto-initialize" until
  the user fixes it, instead of being re-initialized.
- Not run live.

### Gates (worktree, after cb8d0a49 changes) — all PASS
brand, whitespace, clippy, clippy-dlib, clippy-dmn, test
(`cargo test -p tabtivity -p app-serverd`), test-dlib. Cross: msvc clippy
`-D warnings`, `cargo check --workspace --all-targets` for
x86_64-pc-windows-msvc and aarch64-apple-darwin (check-only shims) — exit 0.

---

## Handoff A3 — plan step S3 (#2, #7, #9)

Worktree `.claude/worktrees/high-s3`, branch `screen-high-s3`, one commit on `dd5ede60`:

- `5e3c0796` fix(backend): drop save_project, tolerate unknown agent_tasks fields, bound openvpn teardown

## What changed

- **#2 save_project**: deleted from `commands/projects.rs` (~2778), its `lib.rs`
  registration, the `("save_project", Core)` row in `services/command_class.rs`.
  `commandClasses.ts` regenerated, which drops one line. No imports went unused,
  because `Project`, `storage` and `PathBuf` are all still used in projects.rs. There
  are no frontend or doc callers (only `save_projects` exists, which is untouched).
- **#7 agent_tasks schema**: `deny_unknown_fields` is removed from **8** types, not
  the plan's 7: `AgentScheduleRule` (tagged enum), `AgentScheduleLastRun`,
  `ScheduledAgentPrompt`, `ScheduleOrigin`, `AgentScheduleDelivery`,
  `AgentPromptTarget`, `AgentTasksFile` and `AgentScheduleTargetBinding`.
  A new module doc explains why, in the same way as `agent_prompts.rs`.
  Test changes:
  - `schedule_rules_are_type_tagged_and_strict` is renamed
    `..._strict_about_the_type`. An extra field on a rule now loads and is
    dropped. An unknown variant and wrong casing still fail, and the test still
    asserts that.
  - The "nope"/"extra" assertions in two other tests are inverted to `is_ok()`.
  - The binding test is renamed `the_target_binding_is_camel_case`. Its
    snake_case payload still fails because the required fields are missing.
  - New test `a_file_from_a_newer_build_with_unknown_fields_round_trips`: it puts
    an unknown field on every struct, checks that everything known loads, that the
    unknown fields are dropped on output, and that the output round-trips stably.
- **#9 openvpn (Linux only; Windows and macOS are unchanged, as the plan says)**:
  - New `stop_failed_connect(config, child, pidfile)` handles the `Err` arm of
    `connect_streaming`. It runs `management_shutdown`, then `kill_pidfile`
    (a no-op if there is no pidfile yet), then `child.kill()`, then
    `reap_or_register`.
  - New `reap_or_register(config, VpnProc, timeout)` waits with `try_wait`,
    polling every 100 ms, for up to `REAP_TIMEOUT` = 5 s. If the child is reaped,
    the pidfile is removed. If it is still alive, it is inserted into `registry()`.
  - `disconnect` now only looks at the registry entry first, without removing it.
    If `kill_pidfile` is refused, the entry is kept and the call returns
    `Err("openvpn teardown was not authorized")`. Before, it returned `Ok` after an
    unbounded wait. If the kill goes through, it does a bounded reap.
  - Sibling fixed as well: `disconnect_checked` also had an unbounded
    `kill(); wait()` after the TERM was delivered, and now uses
    `reap_or_register` too.
  - Tests (`#[cfg(target_os = "linux")]`):
    - `a_child_that_outlives_the_reap_stays_registered` (`sleep 30` child, 200 ms
      timeout, the child gets registered)
    - `a_failed_connect_child_we_can_kill_is_reaped_not_registered`

## Gotchas

- Rust 2021 keeps an `if let` scrutinee's temporaries alive for the whole block.
  `if let Some(p) = registry().lock_ok().remove(..) { reap_or_register(..) }`
  would therefore deadlock, because `reap_or_register` relocks the registry. Both
  call sites bind `let proc = …;` first, with a comment. Keep that if you touch
  this code during the merge.
- After a timeout, a registered child that is still alive makes `is_connected`
  true. A second `connect` then returns `Ok` without doing anything, and the lamp
  can show the tunnel as up even though the first connect reported an error. This
  is the intended trade-off in the plan ("never leave a root tunnel
  unregistered"), and it matches reality: a root openvpn is running.
- The frontend ignores errors from `openvpn_disconnect` everywhere (`.catch(() => {})`
  followed by setting "off"), so the new `Err` on a refused kill does not change
  the UI. The status poll corrects the lamp.
- The `stop_failed_connect` timeout path can raise a `pkexec kill` polkit prompt
  when the pidfile was already written and the management socket did not confirm
  the tunnel is down. This is intended by the plan.

## Gates (worktree, Linux)

`scripts/gates.sh` passed everything:
- brand, whitespace, lint-fe, build, vitest --changed (26 passed)
- clippy (tabtivity + app-serverd, all targets), clippy-dlib, clippy-dmn
- `cargo test -p tabtivity -p app-serverd`: 4230 passed, 0 failed (7 binaries)
- `cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
  3956 passed, 0 failed

Cross-checks passed:
- msvc clippy `--target x86_64-pc-windows-msvc --all-targets -D warnings`
- `cargo check --workspace --all-targets` for `x86_64-pc-windows-msvc`
- `cargo check --workspace --all-targets` for `aarch64-apple-darwin` (check-only
  cc/ar shims)

## Hot-file edits for the merge

- `services/command_class.rs`: one row is removed (`save_project`). S1a removes
  others. Regenerate `commandClasses.ts` once after the last merge.
- `services/openvpn.rs`: the edits are in the Linux `connect_streaming` Err arm,
  the new fns right after `connect_streaming`, Linux `disconnect`,
  `disconnect_checked`, and two tests at the end of `mod tests`. None of this
  touches S1a's builder region (~440–500).
- `commands/projects.rs`: one 5-line fn is deleted at ~2778, which does not touch
  S2b's regions.
- No i18n keys, no `untested.ts` rows, no filemap rows (save_project had no row).

## Proposed todo entry (Medium; main agent to place it in the matching todo/ group)

```
- [ ] **agent_tasks.json: an unknown schedule-rule variant fails the whole file**
  (Medium, from the 2026-10-15 screen #7 residual). `AgentScheduleRule` is an
  internally tagged enum (`type`), so a rule kind added by a newer build
  (e.g. `"type":"hourly"`) still makes an older build reject all of
  `agent_tasks.json` — every schedule disappears from view. Unknown *fields* are
  tolerated since screen-high S3. Fix idea: deserialize `rule` leniently (an
  `Unknown(serde_json::Value)` fallback via `#[serde(other)]`-like custom
  Deserialize or a raw-value wrapper), never fire an unknown rule, and write it
  back verbatim so the newer build keeps it.
```

## Flagged for user

- Not run live. To verify #9: with a headless OpenVPN config, start a connect and
  leave the polkit prompt unanswered past 45 s. The connect should fail with "timed
  out" within about 5 s more, and nothing should hang. Then connect, and on
  Disconnect cancel the polkit kill prompt (if the management socket did not
  already stop it). The tunnel should stay listed as up instead of being forgotten.
- `openvpn_disconnect` now returns an error on a refused kill, where it used to
  return Ok. No caller shows the error today.

---

## Handoff A4 — plan step S4 (#8, #11, #12)

Worktree `.claude/worktrees/high-s4`, branch `screen-high-s4`, one commit on `dd5ede60`:

- `18937b7373837919489657b4107da7badc7e4ce2` fix: settle WsClient on close, drop the dead password stash, stop animating blurred shadows (author fseiffarth@users.noreply.github.com)

## What changed

### #8 wsClient (`src/lib/transport/wsClient.ts`)
- `readyWaiters` now hold `{resolve, reject}` (the existing `Pending` type).
- `close()`: sets `closed`, drops `socket` and `hello` **before** calling `socket.close()` (so a synchronously-firing `onclose` also early-returns), sets link state `down`, rejects every pending call and every ready waiter with `DisconnectedError`. Idempotent: the socket's later `onclose` sees a different socket and returns.
- `whenReady()` after `close()` rejects at once (before: parked forever). Before `connect()` it still waits (closed is false initially).
- Sibling fix: `onmessage` ignores frames from a socket that is no longer `this.socket` — a late `hello` on the dropped socket would otherwise set `hello` and flip the link back to "up" after `close()`.
- Tests in `src/__tests__/shell/WebTransport.test.ts` (2 new): a FakeSocket whose `close()` defers `onclose` like a browser; asserts calls + `callRaw` reject, `hello` null, link `down`, `whenReady()` rejects, late onclose/hello change nothing, no reconnect scheduled; and a pre-hello `whenReady()` rejected by `close()`.

### #11 password maps
- `src/stores/projects.ts`: the `pendingRemotePassword` Map, `pendingViaLogin` Set, `stashRemotePassword`, `stashRemoteViaLogin` and their doc comments deleted (region ~79–127 at dd5ede60; `deactivatingProjects` kept, it shared the block). No other edit in that file.
- `ProjectDialog.tsx`: import + the stash block in the remote branch removed; the now-unused `remotePassword` destructure dropped (lint error otherwise).
- `HpcPipelineWizard.tsx`: import + stash block (incl. the comment at :279) removed; `remotePassword` is still used there.
- `docs/context/remote_credentials.md`: two sentences that named the stash rewritten (lines ~54–58 and ~86–88). Not the paste-gate section S1 edits — different paragraphs, but same file: expect a trivial merge if S1 rewrote nearby lines.
- Test: `src/__tests__/remote/RemoteCreateCredentials.test.tsx` — the module no longer exports either stash function.

### #12 box-shadow animations
- `onboarding.css`: `hint-bubble-breathe` animates only `border-color`; new `.hint-bubble::after` (inset -1px, static peak shadow `0 6px 24px … , 0 0 0 3px accent22%`) with `hint-bubble-glow` opacity 0→1→0, same 2.4 s / 0.24 s delay. Reduced motion: `.hint-bubble::after` added to the existing `animation: none` list (glow invisible, as the old static shadow-3 rest state). `.hint-bubble.terminal-sign-in::after { content: none }` — the sign-in / version-drift / undo-clear cards (all carry `terminal-sign-in`) never breathed and still don't. The bubble keeps its static `box-shadow: var(--shadow-3)` throughout (before, the keyframes swapped shadow-3 ↔ peak; now peak fades in over shadow-3).
- `projects-tabs.css` `drag-group-absorb`: transform-only now; the pill gets a static `0 0 0 1px accent` ring and a `::after` (inset `-3px 0 0` = border box, past the 3px top border) carrying the old peak `0 0 0 4px accent, 0 0 18px accent`, opacity 0.25↔1 via `drag-group-glow` (0.7 s). **`.project-pill.drag-group` sets `overflow: visible`** — the pill's `overflow: hidden` would clip the pseudo's outer glow. Pill content is auto-sized (nowrap, labels ellipsize themselves) so nothing should spill, but eyeball it. On an *active* pill the `.active` side shadow outranks the static 1px ring (same specificity, later rule); the ::after ring still shows.
- `projects-tabs.css` `tab-land`: shadow removed from keyframes; `.tab.landing:not(.install-pending)::before` holds `0 0 10px 1px accent55%` with `tab-land-glow` opacity 0→1(55%)→0, same 0.34 s curve. `::before` because `::after` is the status ring; an install-pending tab keeps its own ::before pulse (no landing glow). Reduced motion: the pseudo's animation is `none` (opacity 0). Added `:root[data-blurred] .tab.landing::before` to the cross-window drop exemption. The active tab's side shadow now stays visible during the landing (before, the animation overrode it).
- `subwindows.css` `.blob-node`: `box-shadow` dropped from its `transition` (comment says why); hover/active/center shadows switch instantly.
- New corpus test `src/__tests__/theme/AnimatedShadowBlur.test.ts` (4 tests): no `@keyframes` box-shadow layer with non-zero blur (a `var()` shadow counts as blurred); no rule that transitions `box-shadow` has a selector-extending rule (`:hover`, `-active`, …) with a blurred shadow; the three glow keyframes animate opacity. Verified it fails on the dd5ede60 CSS with exactly the four screen items (drag-group-absorb, tab-land, hint-bubble-breathe, .blob-node → -active/-center).

## Gates (in the worktree)
- `scripts/gates.sh`: brand PASS, whitespace PASS, lint-fe PASS (0 errors; no warnings in touched files — eslint on them is clean), build PASS, vitest --changed PASS. No Rust change → cargo gates skipped.
- Full `npm test`: **842 files, 8526 tests passed** (7 new: 2 WebTransport, 1 RemoteCreateCredentials, 4 AnimatedShadowBlur).
- privacy-check not run separately (pre-commit hook ran on commit).

## Hot-file notes for the merge
- `src/stores/projects.ts`: only the deletion of the map block (~79–127). S1b's login-call edits (~196–410) are below it; line numbers shift by −48.
- `docs/context/remote_credentials.md`: two paragraphs above/below S1's paste-gate section.
- No i18n keys, no `untested.ts` rows, no generated files.

## Gotchas
- The worktree's post-commit hook printed "EMBEDDED MOBILE PWA IS STALE" (sidecar serving a different bundle than mobile-dist); unrelated to S4, left alone. It may also have queued a frozen dev build from the worktree commit — left alone per AGENTS.md.
- The test FakeSocket's `close()` fires `onclose` synchronously, which hid #8 (the old code then settled via onclose); the new tests override `close()` to defer it.

## Flagged for user
- **Eyeball these animations** (not run live, CSS only):
  1. Onboarding hint bubble (and its banner variant): the accent border still breathes and the glow/ring fades in and out in step.
  2. Alt-drag a project pill onto another: the target swells and glows; check the glow is not clipped and the pill's label/status bars don't spill (the pill is `overflow: visible` during that hover). Also try it on the active pill.
  3. Drag a tab into a different tab bar / split: it drops in with a brief accent glow; an agent tab with a working/finished ring keeps its ring.
  4. Blob view: hover / active / center nodes — the glow now switches instantly instead of easing.
- **Pre-existing gap, not fixed (outside S4):** the stash had no reader, so deleting it changes nothing at runtime, but the gap it once covered is open: a project created in ProjectDialog / HpcPipelineWizard with a typed, *unsaved* password, or via "Sign in in a terminal", gets its first pooled connect on activation as `remote_connect {password: null}` without `viaLogin` (`stores/projects.ts` ~423 at dd5ede60, the S1b region). If it rides the dialog's ControlMaster, `record_key_auth` can stamp `key_auth: true` on a password host (unless the keychain is unreadable). Candidate todo item (Medium): pass `viaLogin: true` for a just-created project's first activation connect, or have the dialogs pass the credential straight to `remote_connect` as ExtendToRemoteDialog does.

---

## Handoff A5 — plan step S5 (#4 pre-push private index, #5 screenshot)

Worktree: `.claude/worktrees/high-s5`, branch `screen-high-s5`, based on `dd5ede60`.
Commit: `fdaf7c48` "fix(hooks): bump commit from a private index; drop the private screenshot" (one commit, author fseiffarth@users.noreply.github.com; pre-commit privacy hook ran and passed).

## What changed

- `.githooks/pre-push` (#4): before `bump-version.sh` runs, the hook aborts
  (exit 1, lists the files) if any of the four version files differs from
  HEAD (`git diff --quiet HEAD -- …`, working tree + index). Then the bump
  commit is made from a private index: `mktemp "$(git rev-parse
  --absolute-git-dir)/bump-index.XXXXXX"`, `trap` removes it (and `.lock`) on
  EXIT, `read-tree HEAD` into it, `add --` the four files, `commit` with
  `GIT_INDEX_FILE` + `TABTIVITY_VERSION_BUMP=1`, then `git reset -q -- <four
  files>` on the shared index. Header comment step 2 updated.
  `TABTIVITY_BUMPING=1` re-push unchanged.
- `src/__tests__/git/PrePushPreflight.test.ts`: refactored the throwaway-repo
  setup into `throwawayRepo()` + `preflight()`; two new cases:
  - "commits only the version files, whatever else is staged": stages a new
    `unrelated.txt` and an edit to `hello.txt`, runs the hook under
    PUSH_PREFLIGHT; asserts the bump commit's parent is the pushed sha, its
    diff-tree is exactly the four files, `status --porcelain` is
    `A  unrelated.txt` / `M  hello.txt` (still staged, nothing unstaged), and
    no `bump-index*` is left in `.git`.
  - "refuses to bump over uncommitted edits in the version files": dirty
    `src-tauri/Cargo.toml` → non-zero exit, stderr names the file, HEAD and
    package.json version unchanged.
  Regression proof: both new cases FAIL against the old hook (checked by
  temporarily restoring `HEAD:.githooks/pre-push`), all 3 pass with the new one.
  This file runs in `npm test` (CI + gates) — no separate script needed.
- #5: `git rm screenshots/eldrun-current.png`; `pages.yml` copies only
  `tabtivity-functionality.svg`; `site/index.md` hero image line removed (the
  svg is already shown further down); `scripts/take-screenshot.sh` sources
  `scripts/lib/brand.sh` and defaults to
  `$REPO_ROOT/screenshots/${APP_SLUG}-current.png` (comment at the old line 20
  updated: untracked until reviewed, then `git add -f`);
  `todo/group-y-verification.md` retake entry names the new file and the
  restore steps.
- Found siblings (not in the plan's file list):
  - `scripts/brand-check.sh`: removed the now-stale allowlist entry
    `screenshots/$APP_LEGACY_SLUG-current.png` (the file no longer exists).
  - `docs/context/git_push_mcp.md`: one paragraph on the private index and
    the dirty-version-file abort.

## Choices / gotchas

- The `mktemp` file is deleted before `read-tree` so git writes a fresh
  index rather than parsing a zero-byte file (current git accepts an empty
  file for read-tree, but not every path through read-cache does).
- `--absolute-git-dir` (not `--git-dir`): `GIT_INDEX_FILE` must not be a
  relative path that depends on cwd; works in linked worktrees too
  (`.git/worktrees/<name>/`).
- The diff check is against HEAD, which is what the bump commits on — the
  hook already bumps HEAD regardless of which ref is pushed (unchanged).
- `pages.yml`'s `screenshots/**` path trigger is kept (the svg lives there).
- History docs mentioning `eldrun-current.png` (`docs/rename_phase3_handoff.md`,
  `docs/root_cleanup_plan.md`) and `scripts/brand-flip.sh` /
  `rename-codemods/prose-pass.sh` comments left as history.
- shellcheck is not installed here — not run. `bash -n` on both scripts OK.

## Gates

`scripts/gates.sh` (selected: frontend, because of the test file): brand PASS,
whitespace PASS, lint-fe PASS, build PASS, vitest --changed PASS; Rust gates
skipped (no Rust change). `npx vitest run src/__tests__/git/PrePushPreflight.test.ts`:
3/3 pass. `scripts/brand-check.sh` PASS, `scripts/privacy-check.sh` PASS (also
via the pre-commit hook), `git diff --check` clean, `bash -n` OK on the hook and
take-screenshot.sh. shellcheck: not installed — not run.
The `docs/context/git_push_mcp.md` paragraph was added while gates ran (docs
only: brand + whitespace re-checked after).
The post-commit hook printed its "embedded mobile PWA is stale" advisory —
unrelated (the running window vs. this worktree), ignored.

## Flagged for user

1. **History rewrite**: `screenshots/eldrun-current.png` (blob `bac1fd53`) is
   gone from the tree and from the next Pages deploy, but it stays in git
   history (and in any already-deployed Pages build until the next deploy to
   main runs). Purging it needs a history rewrite of a public repo
   (filter-repo + force-push of main/develop, everyone re-clones) — not done,
   the user's call.
2. **Retake**: `scripts/take-screenshot.sh` now writes
   `screenshots/tabtivity-current.png` (untracked; `screenshots/` is
   gitignored). After a retake: review it, add its blob id to
   `scripts/privacy-reviewed-binaries.txt`, `git add -f`, and restore the hero
   image in `site/index.md` + the `cp` in `pages.yml` (todo entry in
   `todo/group-y-verification.md` says so). Until then the site has no hero
   image (plan review decision (c)).
3. The Pages site only changes once this reaches `main` (pages.yml runs on
   main pushes touching `site/**`/`screenshots/**`).

---

## Review S1: security finder findings (login PTY)

Reviewed `git diff dd5ede60..screen-high-s1` (7688ffca backend, 068ca2d0
frontend) in `.claude/worktrees/high-s1`. Read-only. The app was not run and
nothing was built.

## What holds up

- Only a backend login spawn sets the mark (`commands/terminal.rs:571`). The
  mark is keyed by spawn seq. It is dropped at the top of every `pty_spawn` of
  the id (`:552`), when that seq's reader exits (`terminal/mod.rs:2078`), and in
  kill/reap. If a spawn ends before its mark lands, `note_login_pty_if` +
  `route_spawn_live` catch it. A concurrent respawn of the same id cannot keep
  an old seq's mark alive.
- The caller's `cmd`/`args`/`env`/`cwd` are discarded. Every
  project/agent/sandbox/host-session/local-model/tmux/host-bound/schedule flag
  is refused. `local_only` is forced, so there is no ssh wrap. The client join
  path is refused before the VPN claim is armed. A VPN login from
  `Caller::Client` is refused. `ssh_target`/`validate_arg` reject a host, user
  or config that starts with `-`.
- `remote_login_command`, `openvpn_login_command`, `note_minted_login`,
  `note_pty_input` and the `pty_write` hook are gone. Only doc comments still
  mention them (no live references in `src/`, `src-tauri/` or `mobile-web/`).
  The `command_class` rows are removed and `commandClasses.ts` is regenerated.
- The headless mobile path (`mobile_control/headless.rs`) sets `login: None`.
- Frontend: login tabs are never persisted (`toSavedTabEntry`), never
  restored (`isRestorableTab`), never tmux-wrapped (`withTmuxSession`,
  `tabTerminalSpawn`) and never sandboxed. `loginKey` is compared by value, so
  re-rendering a TerminalView does not respawn the login.

## Likely real

### F2: Medium (correctness and tunnel tracking). Building a VPN login argv re-arms the tunnel's claim even if a tunnel for that config is already up
`src-tauri/src/services/openvpn.rs`, `arm_interactive` (called from
`interactive_connect_argv`, which `apply_login` calls at
`commands/credentials.rs:169`).

`arm_interactive` deletes whatever pidfile exists for the config and
re-registers a fresh claim, without checking whether the recorded pid is still
alive. Suppose a second VPN login for a config whose interactive tunnel is
already up gets spawned (a double click, a dedupe miss after the first tab's
mark/exit state changed, or a renderer asking for it). Then the live tunnel's
pidfile is removed. The tunnel becomes invisible to `is_connected` and
`disconnect_all`, and it outlives Tabtivity with routing changed. This was
already true of `openvpn_login_command`. S1 makes it reachable from a
`pty_spawn` payload.
**Fix:** in `arm_interactive` (or in `apply_login` for `Vpn`), refuse when
`interactive_state(config)` is `Alive(_)` ("tunnel already up"). Only reap
the pidfile when the pid is dead.

### F3: Low (correctness). A VPN claim is left Pending when the spawn fails after `apply_login`
`commands/terminal.rs:563` → `launch_prep::prepare` / crash-loop guard /
`spawn_pty` error paths.

`apply_login` arms the interactive claim (pidfile slot and management
endpoint) before `prepare` and `spawn_pty` run. If either fails, or the
crash-loop guard refuses, the claim stays `Pending` with no process behind
it, until something calls `disconnect`. Only cosmetic and bookkeeping effects
are expected: a Pending entry counts as not connected. But a leftover
management endpoint/password file stays recorded.
**Fix:** on any `Err` after `apply_login` returned `Some(Vpn{config})`, call
`openvpn::forget_interactive(config)`. A small guard type that disarms on
drop unless committed would do it.

## Speculative / inherent

### F4: Inherent ceiling. The login program trusts the user's own config and PATH
The genuine `ssh`/`openvpn` read the user's `~/.ssh/config`, `known_hosts`,
the `.ovpn` file and PATH. A caller that can already run arbitrary commands as
the same OS user can change any of those, and on Linux it can usually query
an unlocked keyring directly. S1 does not change this and cannot. It should
be written down as the gate's ceiling in `docs/context/remote_credentials.md`
so nobody reads the gate as a same-user boundary.
**Suggestion:** one line in the doc. To harden ssh, also pass
`-F /dev/null`-style isolation only if the product wants to drop user ssh
config for logins. That is probably not desired, because users rely on their
config.

### F5: Low. A browser client can make the server dial any ssh host:port
`login: ssh` stays allowed for `Caller::Client` with any host and port, so a
client can open outbound ssh connections from the server. This was already
possible through `remote_login_command` + a shell, so it is not a regression.
On a hosted server it may be worth tying client SSH logins to hosts the
client's projects/machines already name.

### F6: Low, Windows only, unverified. Program lookup for bare `ssh`
On Windows the login argv's program is the bare name `ssh`. Whether the PTY
layer (portable-pty's `CommandBuilder`) resolves a bare name only from PATH,
or also from the cwd (the root work dir), was not verified. If it checks the
cwd, a planted `ssh.exe` there would run instead.
**Fix:** resolve `ssh` to an absolute path in `interactive_login_args` on
Windows, as is already done for `openvpn.exe` (`resolve_openvpn`).

## Not found

- No path through `pty_id_for` maps a client onto another client's login
  PTY. The join is refused for login spawns, and a non-login client spawn of
  the same id clears the mark first.
- Login tabs never take a tmux/attach path, so there is no route to a
  shared tmux session for them.

## Verification — S1

Verifier, 2026-10-15. Worktree `high-s1`, branch `screen-high-s1`. One fix
commit: **`092c44d9`** (on top of `068ca2d0`). Each new regression test was
checked to fail with its fix disabled and to pass with it in place.

### F2: confirmed, fixed
`arm_interactive` removed the pidfile and re-registered the claim without
checking it. With a live tunnel (interactive, or headless adopted into the
interactive registry), a second login deleted the live pidfile. It also
rewrote the config's management endpoint, which the headless flavour shares.
The fix: `arm_interactive` now refuses with "this VPN is already connected"
when `is_connected(config)` is true, for either flavour (`tunnel_up`). It does
this before touching the pidfile or the endpoint. A Pending claim is still
re-armed, so a cancelled polkit prompt can be retried. Because the refusal
comes before the spawn, a remount of a live VPN login tab no longer kills
its tunnel.
Tests: `openvpn::tests::{a_second_login_for_a_live_tunnel_is_refused,
a_login_for_an_adopted_tunnel_is_refused, a_pending_claim_is_rearmed_and_released}`.

### F3: confirmed, fixed
Every `Err` (and the `attached` early return) after `apply_login` left a
Pending claim plus a management port/password file. The fix is a new
`credentials::LoginClaim` guard in `pty_spawn`. It is kept only when
`spawn_pty` succeeds. If it is dropped instead, it calls the new
`openvpn::release_interactive_claim`, which removes only a Pending claim and
never a live one.
Test: `credentials::tests::a_vpn_login_that_never_ran_hands_its_claim_back`
(guard level). An end-to-end `pty_spawn` test would need `RemotePoolState`
plus a real `launch_prep::prepare` against the user's state dir, so it was
not written.

### F4: inherent, no code
This is accurate. The gate's doc comment ("Login PTYs" in
`commands/credentials.rs`) now states its ceiling: the gate is no same-user
boundary, because the genuine ssh/openvpn read the user's own config,
`known_hosts`, `.ovpn` and PATH.

### F5: design point, no code
This is accurate and not a regression. The same doc comment now notes that a
client's ssh login may dial any host:port, and that only that host's own
credential is pasted there.

### F6: confirmed (narrow), fixed
`build_command` first tries `paths::helper_program("ssh")`, the
admin-locked System32 OpenSSH or Git copy. Then portable-pty's Windows
`search_path` looks only at PATH. When it finds nothing, it passes the bare
`ssh` as `lpApplicationName` to `CreateProcessW`, which completes a partial
name from the **app process's current directory**. The cwd that matters is
the app's, not the PTY's, and the file needs no extension. This bites only
when ssh is found nowhere. The fix is `credentials::pin_program`: on
Windows, the login's ssh becomes an absolute path (`helper_program`, then
`ssh.exe` on PATH). If neither is found, the login is refused.
Test: `credentials::tests::a_login_program_is_pinned_to_an_absolute_path`.
Every other bare-name PTY spawn on Windows has the same lookup. That is
outside S1 and is flagged below.

### V1 (verifier's own pass): confirmed, Medium, fixed
This is a mark-lifetime race. Take a login spawn A and a hostile spawn B of
the same id, run concurrently: B runs `forget_login_pty` and then awaits
`prepare`. Meanwhile A spawns and marks (A, seq a) while it is still live.
B then spawns as the current seq b and replaces A's PTY. A's reader sees
`route_close` false (it is not the current spawn), so it never calls
`forget_login_pty_spawn`. The mark survives, and `paste_allowed` checked
only id + target, so `credential_paste_to_pty` wrote the saved password
into B's program. The caller controls both spawns and the paste, so it can
retry the race at will. (The finder's "a non-login client spawn of the same
id clears the mark first" is the step that loses the race.)
The fix: the paste resolves the mark's seq (`marked_spawn`) and requires
`PtyRegistry::input_sender_of_spawn(pty, seq)`. The registry entry must be
that very spawn, both before the keychain read and when the sender is taken.
This also covers any other path that replaces an id without dropping its
mark.
Test: `credentials::tests::a_paste_into_a_respawn_of_a_login_id_is_refused`
(new test helper `terminal::insert_test_pty_at`).

Frontend login flow: nothing further found. Login tabs are not
persisted, not tmux-wrapped and not sandboxed, and the root dedupe mark
self-heals on exit, as S1b's handoff describes.

### Gates (on `092c44d9`'s tree)
- `scripts/gates.sh`: brand, whitespace, clippy, clippy-dlib, clippy-dmn,
  cargo test (`-p tabtivity -p app-serverd`) and test-dlib all PASS.
  lint-fe, build and vitest were skipped (no frontend change).
- Windows msvc clippy `--all-targets -D warnings`: PASS. The first run
  flagged a test-only helper as dead code on Windows, so it is now gated to
  Linux tests. `cargo check --workspace --all-targets` for
  x86_64-pc-windows-msvc and aarch64-apple-darwin (check-only shims): PASS.
- Not run live.

### Flagged for user
- F4 and F5 are left as documented limits. Tying a server client's ssh
  logins to hosts its projects name is a product decision.
- The Windows bare-name `CreateProcessW` cwd lookup (F6's mechanism) also
  applies to every other PTY spawn whose program is found nowhere on
  PATH. Only the login is pinned here.
- A pre-existing minor issue, not changed: two VPN logins in flight for one
  config (both Pending) re-arm the management endpoint, so a tunnel started
  by the first one tears down through the elevated kill instead of the
  socket.

---

## Final review — screen 2026-10-15 High plan (screen-high-int)

Reviewed `git diff 9f6623b8..screen-high-int` in `.claude/worktrees/high-int`
(S1a/S1b + S1 verifier, S2a/S2b + fixes, S3, S4, S5). S3, S4 and S5 had no
step reviewer, so they got the closest read. The app was not run live.

## Fixed

One commit, **`5ce41e48`** (docs/register only, no bug in code was confirmed):

- **Stale docs.** `docs/context/openvpn.md` still said `interactive_connect_command`
  arms a tunnel "typed into a terminal tab", and that auto-connect "opens the
  connect command in the root terminal". It now describes login PTYs:
  `interactive_connect_argv`, no shell, and refused while a tunnel is up. It also
  records the bounded failed-connect/disconnect teardown (#9).
  `docs/context/remote_autoconnect.md` had the same phrase, now fixed.
- **UntestedTag.** Two behaviours had no pill, so I added these:
  - `settings.headlessRemote`, on the "Headless remote connections" toggle. It
    covers the root-console login tabs: ssh/openvpn runs as the PTY's program, an
    ended login opens a fresh tab, and login tabs are never restored.
  - `projectDialog.remoteToggleTitle`, on the create dialog's "Remote (SSH)
    project" toggle. It covers the first connect right after Create, through
    `connectCreatedRemoteProject` (ProjectDialog and the HPC wizard).

  These existing rows now describe the login-PTY behaviour:
  - `terminalSignIn.label`
  - `vpnPrompt.logInTerminal`
  - `credentialPasteBar.1`, whose description was the garbage `"))}"`.
- **Plan decision (d) residual.** It was never placed in `todo/`. It is now in
  `todo/group-s-agents.md`, after "Per-tab scheduled agent prompts": an unknown
  rule variant still fails the whole `agent_tasks.json`.

## Checked, no change needed

- **`commandClasses.ts`.** `the_generated_command_classes_ts_is_current` passes
  without regeneration. The three removed rows (`save_project`,
  `remote_login_command`, `openvpn_login_command`) are gone from both
  `command_class.rs` and the TS table, and from `lib.rs`.
- **Leftovers.** No live references to `save_project`, `remote_login_command`,
  `openvpn_login_command`, `note_minted_login`, `note_pty_input`, the
  `minted_logins` map or the `stashRemote*` / `pending*` maps remain. Only
  historical mentions in doc comments and the context doc remain.
  `interactive_login_command` and `interactive_connect_command` are deleted.
- **Cross-step merges.**
  - `services/openvpn.rs` (S1 builders and S3 teardown) and
    `commands/projects.rs` (S2b hardened git and S3 `save_project`) merged
    cleanly.
  - In `stores/projects.ts`, `ProjectDialog` and `HpcPipelineWizard`, S4's
    stash deletion and S1b's `connectCreatedRemoteProject` are consistent:
    `remote.remotePassword` is still read, and the destructure was dropped.
- **i18n.** No new user-facing frontend strings. The tab labels are unchanged from
  before.
- **Filemap.** `lib/remote/loginTarget.ts` has its row.
- **S3.**
  - The openvpn teardown order is management → `kill_pidfile` → `kill` →
    bounded `try_wait` → register.
  - The registry lock is released before `reap_or_register` relocks.
  - `kill_pidfile` is true for a missing or dead pid, so there is no spurious
    Err.
  - The agent_tasks schema test was inverted as the plan says, and the new
    round-trip test covers every struct.
- **S4.**
  - `close()` rejects pending calls and waiters before `onclose`, and a late
    `onclose` or `hello` is ignored.
  - No `box-shadow` is left in any keyframes or in the `.blob-node` transition.
  - Each glow animates the opacity of a positioned pseudo-element: the hint
    bubble is `position: fixed`, the pill is `relative`, and `.tab.landing` is
    `relative`.
  - The landing glow's `animationend` fires on the tab at the same time as
    `tab-land`, which is harmless.
  - The terminal sign-in cards set `::after` to `content: none`.
- **S5.**
  - The private index is in `--absolute-git-dir`, and the trap removes it and
    its `.lock`.
  - The dirty-version-file abort runs before `bump-version.sh`.
  - `package-dev-auto.sh` unsets `GIT_INDEX_FILE`, so the post-commit build is
    not pointed at the deleted index.
  - The tests prove that only the four files are committed and that staged
    files stay staged.
- **`privacy-check.sh 9f6623b8 HEAD`.** Clean: 15 commits, all with the noreply
  identity.

## Flagged for user

1. **#7 design.** With `deny_unknown_fields` removed, unknown fields load but are
   **dropped** when an older build writes `agent_tasks.json` back. For example,
   `phone_device` from a newer build would be lost. AGENTS.md says "persisted JSON
   must round-trip". A `#[serde(flatten)] extra` map would keep them. The plan
   only asked for "loads", so this was not changed; it is noted in the new todo
   entry. The IPC-only `AgentScheduleTargetBinding` also lost its strictness,
   because the plan listed it.
2. **A login tab whose spawn fails never emits a terminal exit.** Examples are a
   bad `.ovpn`, "this VPN is already connected", a missing ssh on Windows, or the
   crash-loop guard. The tab keeps its dedupe mark until the user closes it, so a
   retry opens nothing and the ssh poll runs to its timeout. Before S1 this was
   the same: the shell tab lived on after a failed ssh. So it is not a
   regression. The fix would be TerminalView reporting a spawn failure of a
   `login` view to `remoteConnect`.
3. **S5 failure mode.** If `git reset -q -- <bump files>` fails after the bump
   commit (for example, another process holds `index.lock`), `set -e` aborts the
   push. The shared index then still stages the pre-bump versions, and the next
   commit would revert the version. This is rare, and git prints its fatal error.
   A clearer warning plus a re-push could be added.
4. **S5.** If `bump-version.sh` succeeds but the private-index commit then fails,
   the working tree keeps the bumped files. The next push refuses with "version
   files carry uncommitted changes", and the user must revert them by hand.
5. **S3, already in A3's handoff.** A failed connect whose child survives the
   reap is registered. A retried connect then returns Ok at once (`is_connected`),
   and the lamp can read "up" for a tunnel that never completed its handshake.
   This is accepted by the plan ("never leave a root tunnel unregistered").
6. **S3, pre-existing.** A failed headless connect never clears its management
   endpoint or password file. They are overwritten by the next connect.
7. **The `connectCreatedRemoteProject` edge case.** Suppose the user typed a
   password and then signed in through the terminal toggle. The first connect is
   sent with that stale password and without `viaLogin`.
8. **Still open from earlier handoffs:**
   - A1/A6: there is no paste bar on root-console login tabs, and the new
     first-connect-after-Create behaviour.
   - S1: F4/F5 are documented limits, and the Windows bare-name cwd lookup is
     still open for other PTY spawns.
   - S2 residuals: see its review.
   - A5: rewriting history for the screenshot, and the retake.

## Gates (on `screen-high-int` before the commit; the commit only touches docs, todo, `untested.ts` and two pill call sites)

`scripts/gates.sh --base 9f6623b8` (the whole branch): every gate passed.

| Gate | Result |
|---|---|
| brand | PASS |
| whitespace | PASS |
| lint-fe | PASS |
| clippy (tabtivity + app-serverd, all targets) | PASS |
| clippy-dlib | PASS |
| clippy-dmn | PASS |
| build | PASS |
| vitest `--changed 9f6623b8` | PASS |
| cargo test | PASS |
| test-dlib | PASS |

Also passing:
- `UntestedRegistry`, `PrePushPreflight` and `AnimatedShadowBlur`: 12 tests.
- `the_generated_command_classes_ts_is_current`.
- `privacy-check.sh` over the range. The pre-commit privacy hook also passed on
  `5ce41e48`.

The Windows and macOS cross-checks were not re-run here; the step agents ran
them on their own branches. `npm run backend:stale` was not run here, since it
needs the main checkout's running window. Run it after landing.
