# Whole-project screen 2026-10-15 — High findings: fix plan

Status: implemented and landed on develop 2026-10-15; never run live
(plan review at the end; per-step results in the handoff). Source: `docs/whole_project_screen_2026_10_15.md` § "High — fix
first" (12 items, screened at `dd5ede60`; line numbers drift — find by
anchor). Handoff: `docs/screen_2026_10_15_high_handoff.md`.

## Why

The screen found no criticals, but twelve highs: security claims in doc
comments the code no longer meets (paste gate, "the one git spawn function"),
fail-open edges inside fail-closed gates (exec_trust, git_peer probe), a
privacy-scan bypass in the pre-push hook, a private screenshot on the public
Pages site, a round-trip invariant break, three correctness hangs/leaks, and
four forbidden blurred-`box-shadow` animations. All are small-to-medium,
mostly independent fixes. All twelve were re-verified at `dd5ede60` by the
plan review; #8 is latent (no production caller of `WsClient.close()` today)
but is fixed anyway.

## Fixed decisions

Reviewers may not undo these. "Sharpened" bullets were added by the plan
review; they make a decision exact and do not change it.

1. **#1 Paste gate → backend-spawned login PTY** (user's choice, 2026-10-15).
   The login terminal's PTY runs the login itself as its program, chosen by
   the backend from a *target*, not a caller-supplied command line:
   - `PtyOptions` gets `login: Option<LoginTarget>` (camelCase payload,
     `#[serde(default)]`; the `LoginTarget` enum in `commands::credentials`
     becomes `Deserialize`, tagged by `kind`: `ssh {user, host, port}` /
     `vpn {config}`).
   - With `login` set, `pty_spawn` ignores `cmd`/`args`, builds the command
     with `ssh_exec::interactive_login_command` /
     `openvpn::interactive_connect_command` (which keeps arming the tunnel),
     and runs it as the PTY's program through the platform shell's
     non-interactive form (`sh -c` / `cmd /D /C`) — **no interactive shell
     before or after it**. It refuses `login` together with `project_id`,
     `agent`, `sandbox`, `host_session`, or a tmux/join path (a login tab is a
     plain local root PTY), and never ssh-wraps it (`local_only` forced).
   - After a successful spawn the backend records `login_ptys[pty] = target`.
     The mark is dropped when the PTY's child exits (the reader/exit path) and
     in `pty_kill`, so a PTY whose login ended is never a paste target.
   - `note_minted_login`, `note_pty_input`, the `minted_logins` map and the
     `pty_write` hook are **deleted**. `paste_allowed` keeps its shape.
   - `remote_login_command` and `openvpn_login_command` lose their only
     callers → delete them (lib.rs registration, `command_class` rows,
     regenerate `commandClasses.ts`). If a non-login caller turns up, keep the
     command but without the minting side effect.
   - Frontend: `openConnectionInRoot` takes the `LoginTarget` instead of a
     `command` and opens the root-console tab with `login` set and no
     `initialInput`; `connectionStillOpen` treats an exited login tab as not
     open (a new request opens a fresh one). The tab shows its normal exited
     state when ssh/openvpn ends.
   - Accepted residual: after a successful ssh login the PTY is the remote
     shell of the very account the credential authenticates; a paste there
     stays allowed (same trust domain). Recorded, not fixed.

   **Sharpened (plan review):**
   - *Payload shape.* `PtyOptions` has no `rename_all`, so its keys are
     snake_case (`local_only`, `project_id`, …); the new key is `login` either
     way. `LoginTarget`: `#[derive(Deserialize)] #[serde(tag = "kind",
     rename_all = "snake_case")]`, so the payload is
     `{"kind":"ssh","user":…|null,"host":…,"port":…|null}` /
     `{"kind":"vpn","config":…}`. Every `PtyOptions { … }` literal gets
     `login: None` — production: `terminal/mod.rs` (`join_tab`'s attach),
     `services/mobile_control/headless.rs` (`launch_options`); tests in
     `terminal/mod.rs`, `launch_prep.rs`, `sandbox.rs`, `tmux_local.rs`,
     `root_mcp.rs`, `agent_fence.rs`, `ssh_exec.rs`, `mobile_control/host.rs`
     (`rg -n "PtyOptions \{" src-tauri/src`).
   - *Program, not a shell line.* Spawn the login's **argv directly**
     (program `ssh` / `pkexec` / `sudo` / `openvpn`), not through `sh -c` /
     `cmd /D /C`: both builders quote with POSIX single quotes
     (`shell_quote`), which `cmd.exe` does not parse, so the shell form is
     broken on Windows. Make `ssh_exec::interactive_login_args` `pub(crate)`
     and split `openvpn::interactive_connect_command` (all three `cfg`
     variants: linux `pkexec`, windows bare `openvpn` — resolve it with
     `resolve_openvpn()`, macos `sudo`) into an
     `interactive_connect_argv(config) -> Result<Vec<String>, String>` that
     still calls `arm_interactive` (the pidfile/management claim) — the
     `--management` fragment becomes separate argv items, unquoted. Keep the
     string forms only if a test still needs them. This is still "no
     interactive shell before or after it".
   - *What `pty_spawn` does with `login` set* (in `commands/terminal.rs`,
     **before** `join_tab`): refuse when `project_id`, `agent`, `sandbox`,
     `host_session`, `local_model`, `tmux_session`, `tmux_attach`,
     `host_bound_uid` or `schedule_target_id` is set; replace `cmd`/`args`
     with the built argv; **clear `env`** (a caller-chosen `LD_PRELOAD` /
     `PATH` in a login PTY would capture the very secret the gate protects);
     set `cwd` to `""` (root work dir) and `local_only = true`. Then the
     ordinary `launch_prep::prepare` → `spawn_pty` path.
   - *Server clients.* `pty_spawn` is `Core` and dispatched to browser
     clients, while `openvpn_login_command` was `Admin`. `Ctx` carries no
     role, so `login: vpn` from a `Caller::Client` is **refused** (fail
     closed; OpenVPN is machine-wide and `VpnIndicator`-owned). `login: ssh`
     stays allowed for clients, as `remote_login_command` was `Core`.
   - *The mark and its lifetime.* `login_ptys: id → (LoginTarget, seq)`,
     `seq` = `prepared.spawn_seq()`, recorded after `spawn_pty` returns Ok.
     Cleared: (a) at the top of **every** `pty_spawn` for that id, login or
     not (a respawn of the id must not inherit the mark); (b) in the reader
     task's `if current_spawn_ended { … }` block in `terminal/mod.rs` (next
     to `agent_fence::on_tab_gone`), only when the stored `seq` equals
     `route_seq` — add `credentials::forget_login_pty_spawn(id, seq)`; (c)
     the existing `forget_login_pty` calls in `pty_kill`, `pty_kill_scope` and
     `web_client::reap_client` stay. `credential_paste_to_pty` keeps its
     `pty_id_for` resolution.
   - *Callers.* All nine frontend call sites of the two commands are login
     flows, so both commands are deleted: `stores/projects.ts` (216, 398),
     `lib/remote/vpn/vpnAutoConnect.ts` (203),
     `components/header/MachinesIndicator.tsx` (1033, 1244),
     `components/projects/useRemoteReconnect.ts` (481, 601),
     `useRemoteSession.ts` (516, 664), `RemoteMachinesWindow.tsx` (429). The
     last five feed **embedded** `TerminalView`s (not the root console) via
     `initialInput={…command}` in `RemoteConnectDialog.tsx` (637, 860),
     `RemoteProjectSection.tsx` (511, 709) and `RemoteMachinesWindow.tsx`
     (1034): those terms become `{id, login, key}` and the views take a new
     `login` prop. `install_agent_remote_command` (agents.rs) is not a login
     and stays; fix its doc comment's `note_minted_login` reference.
   - *Tab plumbing.* `TabEntry.login?: LoginTarget` (stores/tabs.ts);
     `tabTerminalSpawn` passes it; `TerminalSpawnInputs` and
     `terminalSpawnKey` include it; `TerminalView` gets a `login` prop and
     sends `login` in `pty_spawn`'s `opts`. `toSavedTabEntry` does **not**
     carry `login`, and a tab with `login` is not restorable
     (`isRestorableTab` → false): a restored login tab would raise a
     `pkexec`/ssh prompt at launch, against "auto-connect must never prompt".
   - *Exit → not open.* In `openConnectionInRoot`'s `onOpened`, subscribe
     `onTerminalExit(`root:${tab.key}`)` (`lib/terminal/terminalBus.ts`) and
     delete the dedupe entry when it still maps to that tab key.
     `pollRootLoginReady` then sees "closed" as it does for a closed tab.
   - *Lost early validation.* `openvpn_login_command` used to throw on a bad
     config before the lamp moved to "connecting"; now the error surfaces as
     the tab's spawn error. `openVpnLoginInTerminal` must not leave a phantom
     "connecting": `pollVpnUp`'s existing timeout → error is accepted.
   - Docs: `docs/context/remote_credentials.md` (the paste-gate section) and
     the module comment in `commands/credentials.rs`.
2. **#2** `save_project` is deleted outright (command, registration,
   `command_class` row, generated table). No replacement. *Sharpened:* drop
   any import it leaves unused in `commands/projects.rs` (clippy `-D
   warnings`).
3. **#3** exec_trust: any read failure while fingerprinting hooks (unreadable
   hooks dir, unreadable hook file, unreadable entry metadata) becomes a
   fingerprint subject (like the existing `unread` closure), so the
   fingerprint changes and the gate asks again. Never `unwrap_or_default()` /
   `.ok()?` to "nothing".
   *Sharpened:* in `git_subjects` (`services/exec_trust.rs`): a `NotFound`
   hooks dir stays "nothing" (else every repo without one would ask); any
   other `read_dir` error, a `rd.flatten()`-dropped entry error, a non-`NotFound`
   metadata error, and an executable hook `Subject::file` cannot read each
   become a subject **and set `have_hook = true`** (so the hook-manager
   configs are still fingerprinted). A failed `rev-parse --git-path hooks`
   (status non-zero) is a subject too. Add `Subject::file_or_unread` (None
   only on `NotFound`) and use it for hooks, the hook-manager configs and
   `.husky`; latexmkrc/prettier keep `Subject::file` (an unreadable rc is
   unreadable to the tool too). The real attack is an execute-only ELF hook
   or a `0311` hooks dir — git can exec what it cannot read. Unix-only tests
   (`#[cfg(unix)]`, chmod).
4. **#4** pre-push bump commit uses a **private index**
   (`GIT_INDEX_FILE` = temp file seeded by `git read-tree HEAD`, `git add`
   the four bump files into it, commit with it), so nothing else staged can
   ride along; the shared index is then reset for those four paths.
   `TABTIVITY_BUMPING=1` keeps skipping the scan, which is now sound because
   the bump commit contains only the bump files on top of an already-scanned
   HEAD.
   *Sharpened:* create the temp index inside the git dir (`mktemp
   "$(git rev-parse --git-dir)/bump-index.XXXXXX"`, removed by a `trap`) —
   the hook also runs under Tabtivity's fenced push preflight, where `.git`
   is writable and `/tmp` is not shared. **Before** `bump-version.sh` runs,
   abort the bump (exit 1 with a message) if any of the four files differs
   from HEAD (`git diff --quiet HEAD -- <files>`): the bump script rewrites
   the working-tree files, so an uncommitted edit in them would otherwise ride
   into the unscanned bump commit. After the commit: `git reset -q --
   <files>`. Keep the `TABTIVITY_VERSION_BUMP=1` env on the commit.
5. **#5** `screenshots/eldrun-current.png` is `git rm`ed; `pages.yml` stops
   copying it and `site/index.md` uses `assets/tabtivity-functionality.svg`
   (already published) instead; `scripts/take-screenshot.sh` default output
   becomes `screenshots/tabtivity-current.png` (still untracked until the user
   retakes and reviews one). **History is not rewritten** — flagged for the
   user. The todo entry in `todo/group-y-verification.md` about a retake is
   updated to the new name.
   *Sharpened:* the svg is already shown at `site/index.md:57`, so line 20's
   image is **removed**, not pointed at the svg (it would show twice). In
   `take-screenshot.sh` spell the default via `scripts/lib/brand.sh`
   (`"$REPO_ROOT/screenshots/${APP_SLUG}-current.png"`) and run
   `scripts/brand-check.sh`. `screenshots/` is gitignored (line 64), so the
   new file stays untracked by itself. Also update the comment at
   `take-screenshot.sh:20`.
6. **#6** The five bare local git spawns in `git_publish.rs` and `git.rs`
   go through `hardened_git_command_in` (hookless variant where it runs in
   the background). After the change, a test or `rg` check proves no other
   bare `Command::new("git")` for a *local* repo remains outside the
   hardened builder (remote/ssh spawns are out of scope).
   *Sharpened:* the bare form in this codebase is
   `crate::paths::command_no_window("git")`, not `Command::new("git")`. The
   review found **more local-repo sites** than the five, all in scope (fix
   found siblings): `commands/projects.rs` `git_in` (~1199, runs on the
   mirror) and `git_head_unborn` (~3293), `commands/usage_stats.rs`
   `git_user_email` (~207), `services/git_init.rs` `git()` (~47, Publish on
   an existing repo; `init` is already special-cased by `git_command_in`),
   `commands/git_fork.rs` (~207, `remote add upstream` in the fresh clone).
   Legitimately bare (leave, one-line reason comment each): `git.rs`
   builder (`git_command`), `surviving_denylisted_key` / `sanitize_*`
   (`config --file`, no repo), `git_available` (`--version`),
   `git_clone`/`git_remote_visibility_blocking` (network, no local repo),
   `commands/sync.rs` `diff --no-index`, `services/dev_build.rs` (the app's
   own checkout), `services/skills.rs` `refresh_source` (Tabtivity's own
   skills clone in the state dir — confirm it is not a project tree, else
   harden it too). The check is a unit
   test in `commands/git.rs` that `include_str!`s the production files and
   fails on `command_no_window("git")` outside an allowlist of
   (file, function) pairs with reasons (pattern: `nav_gate.rs`'s source
   scan); test modules are skipped by cutting at `#[cfg(test)]`. Note the
   hardened builder already sets `current_dir` and takes the args up front;
   `git_repo_root_blocking` passes the subfolder `dir`.
7. **#7** `deny_unknown_fields` is removed from every persisted struct in
   `schema/agent_tasks.rs`; add a round-trip test that an extra unknown field
   loads (and, matching `agent_prompts.rs`, a comment why).
   *Sharpened:* that is seven types, including the tagged enum
   `AgentScheduleRule` (line 6) and `AgentScheduleTargetBinding`. The existing
   test `schedule_rules_are_type_tagged_and_strict` asserts an extra field on
   a rule errors — invert that one assertion (unknown *variant* and wrong
   casing still error, and keep asserting so). Residual, recorded not fixed:
   an unknown rule **variant** from a newer build still fails the whole file
   (tagged enum); goes to `todo/` as a Medium.
8. **#8** `wsClient.close()` rejects every in-flight `invoke` and every
   `whenReady()` waiter itself (same error the `onclose` path uses) before
   nulling the socket; idempotent if `onclose` later fires.
   *Sharpened:* `readyWaiters` hold only `resolve` today — store
   `{resolve, reject}`. `close()` also clears `hello` and sets the link state
   `down`. Test in `src/__tests__/shell/WebTransport.test.ts`.
9. **#9** openvpn connect timeout stops the tunnel with `kill_pidfile` (as
   `disconnect` does) and never `child.wait()`s unboundedly on the root
   child — reap with `try_wait` in a bounded loop or detach it.
   *Sharpened:* Linux `connect_streaming`'s `Err` arm: `management_shutdown`
   first (no elevation), then `kill_pidfile` (the pidfile may not be written
   yet — then it is a no-op), then a bounded `try_wait` (~5 s); if the child
   still lives, **register it** in `registry()` as a `VpnProc` so
   `disconnect`/`disconnect_all` can still end it — never leave a root
   tunnel unregistered. Same unbounded `kill(); wait()` sibling in Linux
   `disconnect` (after a refused `kill_pidfile`): wait only when the kill
   was delivered, else keep the registry entry (as `disconnect_checked`
   already does). Windows' direct spawn is a same-privilege child (`kill`
   works) and macOS daemonizes — unchanged.
10. **#10** git_peer probe: ssh exit 255 is a `probe_error`, never "clean
    empty remote". Audit the same classifier for any other non-zero exit that
    falls through to "empty"; only an explicit, successful "no repo here"
    answer means empty.
    *Sharpened:* remote git runs as `cd <path> && git …`. In
    `probe_per_command` for `Peer::Remote`: "empty" only on git's
    not-a-repo exit (128) or a failed `cd` (exit 1/2, the missing dir pairing
    may create); 255 and every other non-zero → `probe_error`. In `probe`'s
    batched path an `Ok` with exit 255 and unparseable output returns
    `probe_error` directly instead of re-dialling. Pure classifier fn +
    unit tests.
11. **#11** `pendingRemotePassword` and `pendingViaLogin` maps and both
    writers (`ProjectDialog`, `HpcPipelineWizard`) are deleted.
    *Sharpened:* the exported `stashRemotePassword` / `stashRemoteViaLogin`
    go too, with their imports and the comment at `HpcPipelineWizard.tsx:279`.
12. **#12** The four blurred-`box-shadow` animations/transitions move to a
    static shadow on a `::before`/`::after` pseudo-element whose **opacity**
    animates (reuse the existing reduced-motion opacity variants where they
    fit). No `box-shadow` in any `@keyframes` or `transition` in those rules.
    *Sharpened:* `.blob-node`'s blurred shadows are on `.blob-node-active` /
    `.blob-node-center` (`subwindows.css` ~504–513), reached by class change
    through the `transition`; dropping `box-shadow` from that `transition`
    is enough there. The other `box-shadow` keyframes in the tree
    (`hint-target-pulse`, `tour-target-pulse`, `tour-spotlight-in`,
    `pdf-note-flash`, `side-panel-drop-flash`) are spread-only (0 blur) —
    out of scope.

## Steps (plan sections)

- **S1a** #1 backend: `commands/{credentials,terminal,ssh,openvpn}.rs`,
  `terminal/mod.rs` (field, exit hook, literals), `services/ssh_exec.rs` +
  `services/openvpn.rs` (argv builders), `lib.rs`, `command_class.rs` +
  regenerated `commandClasses.ts`, the `login: None` literals elsewhere.
  Tests: credentials.rs (mark set only by a login spawn, cleared on respawn /
  exit seq / kill, refused combos, env cleared, vpn refused for a client),
  argv builder tests replacing the string ones.
- **S1b** #1 frontend: `TabEntry.login`, `terminalSpawn.ts`,
  `TerminalView.tsx`, `remoteConnect.ts`, `stores/projects.ts` (login calls),
  `vpnAutoConnect.ts`, `MachinesIndicator.tsx`, `useRemoteReconnect.ts`,
  `useRemoteSession.ts`, `RemoteMachinesWindow.tsx`,
  `RemoteConnectDialog.tsx`, `RemoteProjectSection.tsx`. Tests:
  `CredentialPaste`, `VpnTerminalHandoff`, `VpnAutoConnect`,
  `RemoteActivateConnect`, `TabPersistFilter` (login tab not saved),
  `TerminalSleepWake` (spawn key). Starts after S1a's commit, same worktree.
- **S2a** #3 exec_trust, #10 git_peer.
- **S2b** #6 git spawn sweep + source-scan test. Starts after S2a's commit,
  same worktree.
- **S3** #2 save_project, #7 agent_tasks schema, #9 openvpn timeout (+
  `disconnect` sibling).
- **S4** #8 wsClient, #11 password maps, #12 box-shadow CSS.
- **S5** #4 pre-push private index, #5 screenshot.

Every step: regression test where the fix is testable (backend unit test,
vitest, or for #4 a scripted temp-repo check); `scripts/gates.sh` for the
gates the step touches; one green commit (or a few) per step. S1a and S1b
land together (S1a alone deletes commands the frontend still calls).

## Organisation

Shape: **mixed risk, disjoint subsystems** — parallel implementers in
separate worktrees (`.claude/worktrees/high-s<N>`, node_modules hardlinked;
created at `dd5ede60`), two of them followed by a second, sequential
implementer in the same worktree. The main agent merges in order
S3 → S2 (a+b) → S5 → S4 → S1 (a+b). Security/invariant steps get extra
review: S1 (paste gate) gets two independent reviewers — a finder and a
verifier — with no shared context, after S1b; S2 (git/exec fail-closed) gets
one reviewer after S2b. S3, S4, S5 are covered by the final review only.

Waves (never more than 5 agents at once, at most 3 cargo-heavy):
- Wave 1: A1 (S1a, cargo), A2 (S2a, cargo), A3 (S3, cargo), A4 (S4, npm),
  A5 (S5, shell).
- Wave 2, as slots free: A6 (S1b, npm) after A1; A7 (S2b, cargo) after A2
  (and after A3 finishes, to stay at 3 cargo agents); then the S2 reviewer,
  the S1 finder + verifier.
- Final reviewer on the merged tip.

Count: 1 plan reviewer + 7 implementers + 3 step reviewers + 1 final
reviewer = 12 agents. Cargo agents use `CARGO_INCREMENTAL=0` and their own
worktree target dir.

Why: the items share no code except a few hot files. S1a and S3 both remove
rows from `services::command_class` and regenerate `commandClasses.ts`; S1a
and S3 both edit `services/openvpn.rs` (S1a ~440–500 builders, S3 ~1500–1630
connect/disconnect); S2b and S3 both edit `commands/projects.rs` (S2b
~1199/~3293, S3 ~2778); S1b and S4 both edit `src/stores/projects.ts` (S1b
~196–410, S4 ~94–127). All are distinct regions; removals of distinct sorted
rows merge cleanly; the main agent regenerates the table once after the last
merge and re-runs that test. New i18n keys / `untested.ts` rows (if any) go
in the handoff, applied by the main agent.

### Agent steps

| Agent | Plan sections | Main files | Review |
|---|---|---|---|
| A1 | S1a | `src-tauri/src/commands/{credentials,terminal,ssh,openvpn}.rs`, `src-tauri/src/terminal/mod.rs`, `src-tauri/src/services/{ssh_exec,openvpn}.rs` (builders), `lib.rs`, `services/command_class.rs` | finder + verifier (with A6) |
| A6 | S1b | `src/stores/tabs.ts` (TabEntry), `src/lib/terminal/terminalSpawn.ts`, `src/components/terminal/TerminalView.tsx`, `src/lib/remote/remoteConnect.ts`, `src/stores/projects.ts` (login calls), `src/lib/remote/vpn/vpnAutoConnect.ts`, `src/components/header/MachinesIndicator.tsx`, `src/components/projects/{useRemoteReconnect,useRemoteSession}.ts`, `src/components/projects/{RemoteMachinesWindow,RemoteConnectDialog,RemoteProjectSection}.tsx` | finder + verifier (with A1) |
| A2 | S2a | `src-tauri/src/services/exec_trust.rs`, `src-tauri/src/services/git_peer.rs` | 1 reviewer (with A7) |
| A7 | S2b | `src-tauri/src/commands/{git_publish,git,projects,usage_stats,git_fork}.rs`, `src-tauri/src/services/git_init.rs` | 1 reviewer (with A2) |
| A3 | S3 | `src-tauri/src/commands/projects.rs`, `src-tauri/src/schema/agent_tasks.rs`, `src-tauri/src/services/openvpn.rs` | final only |
| A4 | S4 | `src/lib/transport/wsClient.ts`, `src/stores/projects.ts` (maps), `ProjectDialog`, `HpcPipelineWizard`, `src/styles/{onboarding,projects-tabs,subwindows}.css` | final only |
| A5 | S5 | `.githooks/pre-push`, `.github/workflows/pages.yml`, `site/index.md`, `scripts/take-screenshot.sh`, `todo/group-y-verification.md` | final only |

## Verification

- Gates: each agent runs `scripts/gates.sh` in its worktree (it includes the
  daemon build's `--no-default-features` test and clippy — S1a must pass
  them: `pty_spawn` and the login builders compile there too); the main agent
  re-runs the touched gates on the merged tip; `scripts/brand-check.sh`,
  `scripts/privacy-check.sh`.
- Windows/macOS cross-check (AGENTS.md: process spawning and `cfg` code):
  S1a, S2b and S3 run the msvc clippy line and `cargo check --workspace
  --all-targets` for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`
  before the merged tip is pushed.
- `npm run backend:stale` after landing (backend changed).
- Not run live. Click-through for the user after landing:
  1. Non-headless SSH project with a saved password: activate it → the root
     console shows an ssh login tab (no shell prompt before it); the paste
     bar types the password; after `exit` the tab shows exited and the paste
     bar refuses. Re-activating opens a fresh login tab.
  2. Same for an OpenVPN config from the header VPN menu.
  3. The Connect dialog's / Remote machines window's embedded "Sign in in a
     terminal" login (ssh and VPN): it starts the login without a shell, and
     its paste bar works.
  4. Quit and relaunch with a login tab open: it is not restored.
  5. Onboarding hints, Alt-drag tab grouping, tab landing and the blob view
     still glow/animate.
  6. Commit button on a project whose hooks dir (`.git/hooks` or its
     `core.hooksPath`) is `chmod 0311` asks for approval again.

## Plan review (2026-10-15)

Every finding was re-checked against `dd5ede60`: all twelve hold. #8 is
latent (`WsClient.close()` has no production caller today) and is fixed
anyway.

What the review changed:
- #1: added the sharpened bullets above. The main fixes:
  - Plan gaps: the five embedded-terminal login flows (dialogs, Remote
    machines window, MachinesIndicator) were missing from the plan. So were
    the `env` hole (`LD_PRELOAD`/`PATH` in a login PTY), the `Admin`→`Core`
    escalation for `login: vpn` from browser clients, a respawn of the same id
    inheriting the mark, and login tabs being persisted and restored (a prompt
    at launch).
  - The `sh -c` / `cmd /D /C` form is broken on Windows (POSIX quoting), so
    the login is spawned as an argv. This is still the user's decision #1.
  - The exit hook is now exact: seq-guarded, in the reader's
    `current_spawn_ended` block, and cleared on every respawn.
- #3: `NotFound` stays quiet. Unreadable hooks also set `have_hook`. A failed
  `--git-path` query becomes a subject.
- #4: the temp index lives in the git dir. The hook aborts when the bump files
  already carry uncommitted edits.
- #5: the image line is dropped, not duplicated. The name is spelled through
  `brand.sh`.
- #6: the real bare pattern is `command_no_window("git")`. The review found
  five more local-repo sites, which are now in scope, and listed the
  legitimately bare ones. The check is now a source-scan test.
- #7: the existing strictness test must be inverted. An unknown variant is
  recorded as a residual.
- #8: `readyWaiters` must carry `reject`.
- #9: management socket first. A child that cannot be reaped is registered,
  not left unregistered. The same hang was fixed in `disconnect`.
- #10: exact exit-code classification (`cd … && git`).
- #12: `.blob-node` is fixed by its `transition`. The spread-only keyframes are
  out of scope.
- Organisation: S1 was ~25 files and S2 grew with the sweep, so both are split
  into a/b agents, run sequentially in the same worktree. That makes 12 agents
  in two waves, still ≤5 at once and ≤3 cargo. More hot files are listed, and
  the Windows/macOS cross-check is added.

Blocking questions: none. Decisions taken in the user's absence, all
reversible:
- (a) `login: vpn` is refused for every server client.
- (b) Login tabs are never restored.
- (c) `site/index.md` loses its hero image until a reviewed screenshot
  exists.
- (d) The unknown-rule-variant residual goes to `todo/`, not this batch.

## Resume state (2026-10-15, run paused at the usage limit — since resolved, all steps landed)

Committed in worktrees (`.claude/worktrees/high-s<N>`, branch `screen-high-s<N>`),
nothing merged into develop yet:
- S2a `19deb9c6` (A2), S3 `5e3c0796` (A3), S4 `18937b73` (A4), S5 `fdaf7c48` (A5) — gates green.
- S1a `7688ffca` (A1) committed; check docs/handoff-A1.md for gate status.
- S2b (A7, high-s2): stopped mid-work, uncommitted edits (9 files)
  left in its worktree — a fresh agent checks `git status` there, finishes,
  runs gates, commits.
Handoffs: `docs/handoff-A{1..5}.md` (untracked copies).
Still to do: finish S1a → S1b (A6; also fix A4's flagged first-connect
`viaLogin`/`key_auth` gap) → S1 finder + verifier; finish S2b → S2 reviewer
(also: git exit 128 "dubious ownership" still reads as an empty remote);
final review; merge S3 → S2 → S5 → S4 → S1 into develop, regenerate
`commandClasses.ts` once, gates on the merged tip, `backend:stale`.

## Follow-up round (2026-10-15, user decisions on the flagged items)

Fixed decisions:
- F-a **Screenshot history:** not rewritten (blob `bac1fd53` stays in history).
- F-b **agent_tasks round-trip:** every persisted struct in
  `schema/agent_tasks.rs` gets a `#[serde(flatten)] extra` map (as `Project`
  has), so an older build writes newer fields back untouched. Unknown rule
  *variants* stay the existing todo.
- F-c **Root login tab paste bar:** the existing `CredentialPasteBar` shows
  above a root-console login tab whose target has a saved credential (reuse
  the dialogs' component and its keychain check; tagged untested).
- F-d **Client ssh logins:** a `Caller::Client` `login: ssh` is refused unless
  the target names a host already configured as a remote project or machine
  (match user/host/port as stored); the desktop window keeps any host.
- F-e **Small bugs from the reviews, fixed without asking:** (1) a login tab
  whose spawn fails releases its dedupe mark, so a retry opens a fresh tab;
  (2) pre-push: if the shared-index reset or the private-index commit fails,
  the hook restores the four version files / index and exits non-zero with a
  clear message; (3) git_peer: a remote path inside a refused parent repo
  must not read as empty (fail closed when any ancestor holds a `.git` git
  refuses). A damaged `.git` staying blocked is intended — no change.

Agent steps (two parallel implementers, then one final reviewer):

| Agent | Items | Main files |
|---|---|---|
| B1 | F-b, F-d, F-e(3) | `src-tauri/src/schema/agent_tasks.rs`, `src-tauri/src/commands/terminal.rs` (+ where the login is validated), `src-tauri/src/services/git_peer.rs` |
| B2 | F-c, F-e(1), F-e(2) | `src/components/projects/CredentialPasteBar.tsx`, root-console tab view, `src/lib/remote/remoteConnect.ts`, `.githooks/pre-push`, tests |
