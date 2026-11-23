# Cross-OS parity — macOS run, handoff (2026-11-15)

> **Status (screened against code 2026-11-22):** ARCHIVE candidate (handoff executed). Landed under rebased hashes (`git log --grep=2442`: `578bd24fc` Seatbelt, `06dab493b` open -a tracking, `9a425c1ba` webview rename, `ebc63dff9` PATH, `f165f2b90` keyboard, `5ee8a3394` Tailscale/tmux/Homebrew); the SHAs in the body no longer resolve. Evidence: `add_canonical_spellings` and `lsopen` rules in `src-tauri/src/services/agent/agent_fence.rs` (+ `agent_fence/seatbelt_tests.rs`). Still open per `todo/group-h-crossplatform.md`: Mach lookups in the fence, 2442p, u, v, ad and the partial x/y/z. Not run on a Mac.

The macOS half of todo **2442** (`docs/cross_os_parity_2026_11_12.md`). Every
item was re-read against the tree first; **nothing here was run on a Mac.**
The Mac-only behaviour is covered by `#[cfg(target_os = "macos")]` tests that
CI's `test-macos` runner (macos-26) executes; everything else by pure tests
that run on Linux.

- **BASE:** `abe62d19c` (local `develop`).
- **Branch:** the worktree branch this file is committed on. Commits are listed
  per item below.

## Items

### 2442n — Seatbelt fence (security) · fixed (partly: Mach stays open)

Still `(allow default)`, not the plan's §5 deny-default base: a deny-default
profile needs a mach-lookup allowlist measured per CLI (spike S5), and a wrong
guess means no agent starts on any Mac, which nobody here can try. What was
added instead closes what Linux's private `/tmp`/`/run`, empty home and missing
display close:

- `(deny lsopen)`, `(deny appleevent-send)` — no `open -a Terminal x.command`,
  no `osascript … do script`. Linux check: the bubblewrap fence has a tmpfs
  `/run` and `/tmp` (no session bus, no X11/Wayland socket; abstract sockets
  closed by `fence_scope`), so `xdg-open` there starts nothing; sign-in on
  Linux works by the CLI printing its URL in the tab (and the phone relay).
  macOS now matches that line: the browser is not opened from inside the
  fence, the localhost OAuth callback (TCP) still works.
  `lsopen` is in WebKit's own profiles and Mozilla's notes (refused only by
  10.9); `appleevent-send` is documented by Apple's sandbox Q&A. The
  `sandbox-exec` probe (`bwrap_available`) now carries both rules, so a Mac
  that refused them starts no agent (fail closed).
- Unix sockets: no `network-outbound (remote unix-socket …)` under `/tmp`,
  `/var/folders` (both spellings), the user's home or `/var/run/docker.sock`,
  and no `network-bind` in the shared temps; re-allowed under the roots, the
  shown read-only/writable support paths, the scope home and the private temp,
  hidden paths denied again. This closes the ssh-agent (launchd listener in
  `/private/tmp/com.apple.launchd.*`) **and the default tmux server**
  (`/private/tmp/tmux-<uid>/default`) — before this, a fenced agent in a tmux
  pane could `tmux new-window` an unfenced command. Syntax `(remote
  unix-socket (subpath …))` as used by Codex-derived `zerobox-sandboxing`.
- `SSH_AUTH_SOCK`/`SSH_AGENT_PID` unset and `TMPDIR` set by a `/bin/sh` step
  run *inside* the profile (`seatbelt_argv`), so a tmux server's
  `update-environment` cannot put the agent socket back.
- Private temp: `<user $TMPDIR>/<slug>-tmp/<12 hex of sha256(scope)>` (0700,
  refused if not a plain dir of this uid), short enough for socket paths; the
  user's own `$TMPDIR` is hidden; `/tmp` stays writable for files; `…/C`
  (clang module cache) stays writable. One-shots (push preflight) get the same.
- Docs: `docs/context/agent_authority.md` (Composition, macOS bullet + "still
  open"), `docs/threat_model.md` (fenced agent on macOS row),
  `docs/agent_fence_cross_os_plan.md` status line.
- Tests: `agent_fence::seatbelt_tests` (pure, every OS: escape rules first,
  socket rule order, private-temp layout, launch step drops the agent socket
  — that one runs the real `/bin/sh` step); `seatbelt_tests::real::*`
  (macOS CI only: the real profile parses and runs `/usr/bin/true`; write in
  root ok, outside and in the user `$TMPDIR` refused, `mktemp` lands in the
  private dir; no `SSH_AUTH_SOCK` inside; a socket in `/private/tmp` is
  unreachable while the same `nc -U` reaches it unsandboxed, and a root socket
  stays reachable; `open -a Calculator` and an `osascript` Apple Event fail;
  `git --version` and `curl https://github.com` still work).

### 2442w — canonical spellings · fixed (with 2442n)

`add_canonical_spellings` (runtime `canonicalize`, else the `/var`, `/tmp`,
`/etc` → `/private/…` firmlinks) fills `SeatbeltInputs::canonical`; every rule
is rendered under both spellings. Tests:
`every_rule_is_rendered_under_the_resolved_spelling_too`,
`canonical_spellings_follow_a_real_symlink`.

### 2442o — launched apps · partly

- `proc_table::start_time` has a macOS arm (`sysstat::process_start`, µs since
  epoch), so `pid_start`, family liveness and Close's pid-reuse check
  (`leader_unchanged`, now Linux + macOS) work there.
- After `open -a X.app` exits, the row's family is the bundle's processes
  started since the launch (`exit_family` → `bundle_family_now`, `proc_pidpath`
  under `<bundle>/Contents/`), asked for up to 3 s for a cold start; a found
  family keeps the row owned by the real app pid (`KeepFamily`), so parking,
  close and prune follow the app. An already-running instance is no member
  (hand-off → the old demoted/adopt path, as on Linux).
- `named_windows` / `activate_window` have macOS arms (CGWindowList owner name
  + `kCGWindowName`; raise = `unhide` + `activateWithOptions:` of the owner),
  and the IDE window classes gained the Mac app names (`IntelliJ IDEA`,
  `PyCharm`, `Android Studio`, `Sublime Text`, …) so "Open in IDE" can raise.
  **Window titles need Screen Recording permission**; without it nothing
  matches and the IDE launches as before.
- Not done: pid-0 rows still have no liveness on macOS. The on-screen window
  list cannot tell a parked (hidden) app's window from a closed one; the fix
  is a per-id query (`CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, id)`)
  or the owner pid's liveness, plumbed through `prune_candidates`/`apply_prune`
  — not attempted blind.
- Tests: `a_bundle_launch_family_is_the_bundles_new_processes`,
  `close_refuses_a_leader_whose_pid_was_reused` (macOS branch),
  `an_open_ide_window_is_found_by_class_and_project_title` (Mac owner names).

### 2442p — Keychain logins · flagged, no code

`claude_token::inject_launch` injects the saved long-lived token whenever
`agent_auth` holds no shared Claude login — on a Mac with a Keychain login that
is always, so a user who saved a token gets inference-only tabs. Making the
condition right needs to know a Keychain login exists: at least an
attribute-only `security find-generic-password -s "Claude Code-credentials"`
(no `-w`, so no secret and normally no prompt) — that touches the Keychain,
which 32z keeps as a decision. Needs: the decision, then a Mac probe of
whether the attribute lookup prompts.

### 2442q — webview data follows the rename · fixed (macOS and Windows)

`webview_data_root` → `~/Library/WebKit/<identifier>` (wry 0.57 uses
`WKWebsiteDataStore.defaultDataStore`; no data-store identifier is set) and
`%LOCALAPPDATA%\<identifier>` (tauri 2.12 `manager/webview.rs` forces
`app_local_data_dir()` as WebView2's user data folder). A wrong guess is
harmless: the step only copies a folder that exists under the old identifier.
`docs/context/brand_migration.md` updated. Test:
`the_webview_data_root_is_known_on_every_os`.

### 2442r — tmux on a Mac · fixed

`tmux_available` caches a found tmux for the run but re-probes a missing one
every 30 s (`cached_probe`); new command `local_tmux_available` (Core);
`useTmuxAvailable` (re-asked on window focus) drives a note + **Install tmux**
one-click tab on the persist toggle and in the phone setup guide
(`TMUX_INSTALL_CMD`: Homebrew bootstrapped first on a Mac). UntestedTag rows
`settings.persistLocalNoTmux`, `mobile.setupNoTmux`. Test:
`a_missing_tmux_is_probed_again_after_the_ttl`.

### 2442s — Tailscale button · fixed (every OS)

`config::serve_command_line` quotes the resolved CLI (POSIX `'…'`, `cmd.exe`
`"…"`); command `mobile_tailscale_serve_command` (Admin); both buttons run its
line, the guides still show the plain one. Tests:
`the_setup_line_names_the_resolved_cli_quoted_for_the_shell`, the
MobileSetupGuide vitest.

### 2442t — Homebrew / git · fixed

`withHomebrew` (TS) / `with_homebrew` (vm.rs) put Homebrew's own installer
(brew.sh's one-liner) in front of every Mac `brew install` button (gh, glab,
MacTeX, QEMU, tmux) and source `brew shellenv` after it; git offers
`xcode-select --install`. `git_available_blocking` / `local_git_version_blocking`
no longer run the `/usr/bin/git` stub when `xcode-select -p` finds no tools
(that run raised the system dialog). Tests: `vm` install-command test,
`the_mac_git_stub_counts_as_missing_without_the_tools`.

### 2442x — keyboard · partly

- Option+letter chords match by `e.code` on a Mac (`isOptionLetterOf`); a
  captured ⌥ chord stores the letter.
- Terminal keyboard-select: ⌘C copies, ⌘X leaves (`keySelectStep(…, mac)`).
- Fixed "Ctrl"/"Strg" prose → ⌘ on a Mac (`forPlatformKeys`) for
  `settings.zoomHelp2`, `terminal.pathLink.newSubwindow` (both sites),
  `tableView.copySelectionTitle`, and every tour/lesson body (TourHost) — which
  covers the Ctrl+B / Ctrl+K lessons. `hint.fileTreeBody` in the rotating hint
  bar is not routed through it.
- File-tree export drag takes ⌥ on a Mac (`exportDragHeld`); Ctrl+press is a
  right-click there.
- **Flagged:** native menu titles (`lib.rs` "Edit"/"Window") are built in Rust
  before the webview; the dictionaries are TS, so they cannot be reached.
  macOS localizes the predefined items itself (system language), so a Rust
  table for two titles would mix languages — needs a decision.
- Test: `src/__tests__/shell/MacKeyboard.test.ts`.

### 2442y — PATH · partly

Version managers added (`version_manager_dirs`, Mac only, after Homebrew).
**Flagged:** Homebrew rsync conflicts with the trusted-helper rule (#861:
`rsync` only from root-owned dirs; Homebrew's prefix is user-owned). Test:
`version_manager_dirs_follow_each_managers_home`.

### 2442z — small ones · partly

Start-time check for background jobs (`ProcProbe::start`, turn end in µs);
`crash.log` + dev-build log readable in the Seatbelt fence; Mac toolchain
homes in the default fence paths (Rust `MACOS_AGENT_FENCE_PATHS`, TS
`AGENT_FENCE_MACOS_PATHS`). Not done: task-output check (fd reader),
`PDEATHSIG`/`RLIMIT_AS`, byte-sync case-fold/NFC.

### 2442ad — agent logins · flagged, no code

No vendor evidence for Cursor's `AGENT_CLI_CREDENTIAL_STORE` (Cursor's CLI
auth docs name only `NO_OPEN_BROWSER` and `CURSOR_API_KEY`); left unchanged.
Codex: `cli_auth_credentials_store` documented, default not stated; a
write-up of 0.125 reads `file` from source — `.codex/auth.json` stands.

### 2442v — sidecar signature · flagged, no code (see below)

### Related fixes (red on BASE, not mine)

- `src/__tests__/tabs/TabArchive.test.ts` spelled the app's name
  (brand-check failed); now `BRAND.slug`.
- `docs/help/mobile.md` had 37 keywords (the help corpus allows 32;
  `help_mcp::tests::real_corpus_parses` and `the_topics_section_names_every_topic`
  failed); five near-duplicates dropped.

### How the commits are cut

Several files carry more than one item and interactive staging is not
available, so commits are by cluster: `lib.rs`, `command_class.rs` /
`commandClasses.ts`, `installCommand.ts`, `SettingsPanel.tsx` and the i18n
files go with the s/r/t commit (they also hold 2442q's `lib.rs` comment and
2442x's zoom-help call); `agent_fence.rs` holds 2442z's `crash.log` hunk.

## Commits (on BASE `abe62d19c`)

| sha | items |
|---|---|
| `dbc98d3df` | brand-check fix in `TabArchive.test.ts` (red on BASE) |
| `66aff02e9` | `docs/help/mobile.md` keyword limit (red on BASE) |
| `2524d9a93` | 2442n, 2442w, 2442z (`crash.log`) |
| `7ff4d7674` | 2442o |
| `70dd97117` | 2442q |
| `075b5173a` | 2442y (version managers), 2442z (fence paths, job start time) |
| `caa49cc2a` | 2442x |
| `7445a4957` | 2442s, 2442r, 2442t (+ the shared-file hunks named above) |
| this commit | todo ticks, this handoff |

Intermediate commits were not built one by one; the gates ran on the whole
tree before it was cut.

## Gates and cross-check

- `scripts/gates.sh` on the full diff (job `/tmp/gates-job.qFVnWe`): all ten
  gates **PASS** — brand, whitespace, lint-fe, clippy (workspace, daemon lib,
  daemon), build, vitest `--changed`, `cargo test -p tabtivity -p
  app-serverd`, the daemon build's tests. The run before it (identical code,
  minus the help-doc fix) counted 5827 passed / 2 failed / 14 ignored in the
  lib tests, the two being the help-corpus tests red on BASE; vitest there
  9143 passed. Targeted run of the touched modules: 353 passed.
- macOS cross-check (`scripts/ci-local.sh --from macos-check`: `cargo check
  --workspace --all-targets --target aarch64-apple-darwin` with check-only
  cc/ar stand-ins): **ok** (4 m 37 s), which also type-checks the
  `cfg(target_os = "macos")` tests. The fence made `~/.cargo/registry`
  read-only and the Mac-only crates were not cached, so it ran with
  `CARGO_HOME=target/wt-parity/cargo-home-mac` (a copy of the registry
  cache) and `CARGO_TARGET_DIR=target/wt-parity-mac`. Clippy for the Mac
  target was not run locally (CI's step is still `continue-on-error`).

## Flagged for user

Decisions:

1. **Deny-default Seatbelt (§5) or keep `(allow default)` + targeted denials?**
   Mach services stay open: login-keychain items whose ACL trusts the asking
   tool (`/usr/bin/security`), the pasteboard, `trustd`. Closing them needs a
   measured mach allowlist per CLI on a real Mac (spike S5/S6).
2. **`launchctl submit` / `bootstrap`:** no SBPL rule is known to stop a
   fenced process from submitting a job to the user's launchd domain (it then
   runs outside the fence). Check on a Mac first (below).
3. **2442p:** whether an attribute-only Keychain lookup is acceptable to tell
   a Keychain Claude login apart (32z).
4. **Homebrew rsync 3 (2442y):** conflicts with #861's root-owned-only rule.
   Options: an explicit absolute-path setting, or accept MacPorts'
   root-owned `/opt/local/bin/rsync` (passes the rule) — not looked up today.
5. **macOS git in general:** `command_no_window("git")` always prefers the
   root-owned `/usr/bin/git` stub over a Homebrew git (#861). Without the
   Command Line Tools every background git call would raise Apple's dialog;
   only the availability probe is guarded now. Same trust question as 4.
6. **Native menu titles (2442x):** Rust-built, no dictionary there; macOS
   localizes the items by system language. Leave English, or add a two-word
   Rust table?

Premises not confirmed from vendor docs:

- `(deny lsopen)` stops `open`: `lsopen` is a real SBPL operation (WebKit's
  profiles deny it, Mozilla notes only 10.9 rejects it), but whether
  `launchservicesd` also enforces it for a client that skips LaunchServices
  is not established.
- Socket rules match the address a client passes; a socket reached by a
  relative path, or through a symlink, was not checked.
- WKWebView's default data store at `~/Library/WebKit/<bundle id>` is
  observed behaviour, not Apple-documented.
- Cursor's `AGENT_CLI_CREDENTIAL_STORE=file` (forum only) — not added.

Check on a Mac (Apple silicon, Homebrew absent, CLT absent is ideal):

1. CI: the `test-macos` job must pass `agent_fence::seatbelt_tests::real`.
   A red `the_real_profile_parses_and_runs_true` means the profile does not
   compile there — then no agent starts on any Mac (fail closed); the rule
   named in its stderr is the culprit.
2. Fenced Claude tab in a project: run `open -a Calculator` (fails),
   `osascript -e 'tell application "Finder" to get name'` (fails),
   `echo $SSH_AUTH_SOCK` (empty), `echo $TMPDIR` (`…/T/<slug>-tmp/<hash>`),
   `tmux ls` (cannot connect), `git status`, `npm -v`, `curl -I
   https://example.com` (all work), `cat ~/Library/Application\
   Support/<slug>/crash.log` (readable), `/login` (prints the URL; clicking it
   signs in).
3. Same tab: `launchctl submit -l fence-probe -- /usr/bin/touch /tmp/fence-probe`
   then `ls /tmp/fence-probe` from a normal Terminal; if it exists, the
   launchd escape is open (then `launchctl remove fence-probe`).
4. Apps view: launch a cold app (e.g. TextEdit) from a project → its row
   stays; switch project → it hides; Close → it quits. Open in VS Code twice
   with Screen Recording granted to the app → the second raises the window.
5. Settings → Persistent local sessions without tmux: the note and Install
   tmux appear; after the install tab finishes and the window is focused, the
   note is gone.
6. Fresh Mac: New project → git → Install git opens Apple's "install
   command line developer tools" dialog once (none before the click).
7. Mobile setup → Set up in terminal with only the Tailscale app installed:
   the typed line names `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
8. 2442v (sidecar signature), after enabling Mobile:
   `codesign --verify --strict --verbose=4 "<control_dir>/bin/<version>/<binary>"`
   and `launchctl print gui/$(id -u)/<host label>` — `Code Signature Invalid`
   or a SIGKILL exit there means the plist must point into the bundle.

## Review

Reviewer pass over `66aff02e9..9b51d7461`, 2026-11-15. Nothing here ran on a
Mac either. Sources checked for the Seatbelt questions: Codex's
`codex-rs/sandboxing/src/seatbelt.rs`, Anthropic's `sandbox-runtime`
(`src/sandbox/macos-sandbox-utils.ts`), XNU's `bsd/kern/uipc_usrreq.c`.

### Per commit

| sha | items | verdict |
|---|---|---|
| `2524d9a93` | 2442n, 2442w | **fixed** (three commits below) + flagged |
| `7ff4d7674` | 2442o | **fixed** (hand-off helper) + flagged |
| `70dd97117` | 2442q | ok — the step only copies (`copy_webview_data` keeps the old folder, never overwrites one under the current identifier); `%LOCALAPPDATA%\<identifier>` is Tauri's folder (WebView2's `EBWebView`), not the app's state dir (`%APPDATA%\<state dir>`); a symlink inside it would leave the step pending on Windows (`copy_link`), which is harmless |
| `075b5173a` | 2442y, 2442z | ok |
| `caa49cc2a` | 2442x | **fixed** (lesson Ctrl+C) + flagged (layouts) |
| `7445a4957` | 2442r/s/t | ok + flagged (fish, Linux re-probe) |
| `9b51d7461` | docs, todo | ok (2442w's todo line amended with the review's limit) |

### Fixes (on top of `9b51d7461`)

1. `91ecdfb1d` — **an allow rule followed a link the agent can plant**
   (2442w). State: a fenced agent renames its root (or its scope home) away
   — Seatbelt's `subpath` covers the folder itself, and `/private/tmp` is on
   the same volume — and leaves a symlink to the user's home there. Outcome
   at the next start in that scope: `canonicalize` gave the home, and the
   profile held `(allow file-read* (subpath "<home>"))` and
   `(allow file-write* …)`; for the scope home the allow came after every
   hidden denial. Linux has no twin (a root is a mount point). Now paths
   resolve link by link (`resolve_spelling`) and an allow gets the resolved
   spelling only when no link sits at or inside a path the agent may write
   (`SeatbeltInputs::planted`); denials follow every link. Tests:
   `an_allow_rule_never_follows_a_link_the_agent_could_have_planted`,
   `canonical_spellings_follow_a_real_symlink` (leaf case).
   **Cost:** a project whose folder is *itself* a symlink gets no write
   access on a Mac, as before 2442w; a project below a link works.
   Follow-up `6a47c5646`: the system's own `/tmp`, `/var`, `/etc` links (in
   `/`, which nobody writes) are followed whatever is granted below them —
   without it, `TMPDIR=/tmp` in the app's environment left the private temp
   dir allowed only under a spelling Seatbelt never matches.
2. `588655680` — **fenced tools could not `lstat` the folders above what
   they are shown** (2442n). State: `TMPDIR` is now inside the user's hidden
   `$TMPDIR`; a project sits at `~/code/app`. Outcome: `realpath "$TMPDIR"`
   (jest, the `temp-dir` package) and git's work-tree resolution fail with
   EPERM on the first hidden folder (sandbox-runtime's source allows
   directory metadata for exactly this reason). The `$TMPDIR` half is a
   regression of 2442n; the nested-project half is older and was never
   exercised (CI's fixture puts the root directly in the home). Now
   `(allow file-read-metadata (literal …))` for the folders between a hidden
   region and something shown inside it (`stat_only_dirs`). Tests:
   `the_folders_above_what_is_shown_answer_lstat_and_nothing_else`,
   `real::the_folders_above_a_root_and_the_private_tmp_answer_stat_only`
   (macOS CI: `stat`, `git init` in a nested root, and `ls`/`cat` of the
   folder in between still refused).
3. `868cec760` — **Docker socket rule: `subpath` instead of `literal`**
   (2442n). *Not a confirmed bug.* `(remote unix-socket (literal …))` appears
   in no shipped profile found; Codex and sandbox-runtime use `subpath`
   there. The probe does not carry the socket rules, so a parse error would
   start no agent on any Mac. Same meaning, the form the other socket rules
   already use; drop the commit if unwanted. Test:
   `no_socket_in_the_shared_temps_home_or_docker_is_reachable_but_the_scopes_own_are`
   (every `unix-socket` rule is `subpath`).
4. `e7d2f4a16` — **`open -a` to a running Electron/Chromium app adopted its
   new helper** (2442o). State: VS Code is running; the Apps view opens it
   for a project. Outcome: the renderer the running instance starts within
   the watcher's 3 s poll lies in `<bundle>/Contents/Frameworks/…` and
   started after the launch, so the row became `KeepFamily` led by that
   helper, and Close signalled it. Now a family counts only when the app's
   own executable (directly in `Contents/MacOS`) started since the launch.
   Test: `a_bundle_launch_family_is_the_bundles_new_processes` (hand-off
   case).
5. `72558bf71` — **the Windows cross-check's clippy failed on the fence
   commit** (2442n). `seatbelt_argv` and `SEATBELT_ENV_STEP` were built for
   every test run, but only the macOS wrapper and a `cfg(unix)` test use
   them: `cargo clippy --target x86_64-pc-windows-msvc --all-targets -D
   warnings` stopped with "never used" on both. Gated like their users. The
   check is `ci-local.sh`'s `windows-clippy` step (CI's own Windows clippy
   is still `continue-on-error`, 2442ab).
6. `5b6e07548` — **the Run Python lesson said "input(), ⌘+C" on a Mac**
   (2442x). `TourHost` put every lesson body through `forPlatformKeys`;
   Ctrl+C there is the interrupt the program reads. `TourStep.terminalKeys`
   + `stepBody`. Test: `MacKeyboard.test.ts` "keeps a terminal's own Ctrl+C
   in a lesson body".

### Premises, confirmed or not

- **Socket rules and relative paths / symlinks — settled.** XNU's
  `unp_connect` looks the address up (`namei`, `FOLLOW`) and hands the MAC
  hook the resulting vnode (`mac_vnode_check_uipc_connect(ctx, vp, so)`);
  `unp_bind` hands it the resolved parent and the name. The sandbox judges
  the socket found, not the string the client passed.
- **`(remote|local unix-socket (subpath …))` parses** — the exact form in
  Codex's `seatbelt.rs` and in sandbox-runtime.
- **`lsopen` / `appleevent-send` are real operations** (sandbox-runtime:
  `(allow lsopen)`, `(allow appleevent-send)`, with the comment that `open`
  fails with -10822 / -54 without `lsopen` under deny-default). That a
  *deny* under `(allow default)` stops `open` is still the CI test's to
  show (`real::open_and_apple_events_start_nothing_outside_the_sandbox`).
- sandbox-runtime notes that a specific `(deny file-write-unlink)` is not
  overridden by a later `(allow file-write*)`. This profile never relies on
  the opposite: it overrides wildcard with wildcard, an operation with the
  same operation, and a wildcard deny with a later specific allow
  (`file-read-metadata`, which the real tests exercise).
- Still unconfirmed: WKWebView's `~/Library/WebKit/<bundle id>`,
  `launchctl submit`, Cursor's `AGENT_CLI_CREDENTIAL_STORE`.

### Gates and cross-checks

The review was cut short by the session's usage limit: **no full gate run
and no macOS cross-check finished on the final tree.** What ran:

- `cargo test -p tabtivity --lib -- agent_fence commands::apps` (Linux):
  133 passed, on the tree before the last two fence commits; `agent_fence`
  alone (60 passed) after `6a47c5646`. `72558bf71` after it only changes two
  `cfg` attributes and was not test-run on Linux.
- `npx vitest run src/__tests__/shell/MacKeyboard.test.ts`: 5 passed.
- `scripts/gates.sh --base 9b51d7461` on the final sources: brand,
  whitespace, lint-fe, clippy (workspace, all targets) and clippy-dlib
  **passed**; the run was stopped in clippy-dmn, so `npm run build`, vitest
  `--changed` and both `cargo test` gates did **not** run.
- `scripts/ci-local.sh --from windows-clippy` (`CARGO_HOME` =
  `target/wt-parity/cargo-home-mac`, `CARGO_TARGET_DIR` =
  `target/wt-parity-mac`): **fails**, now with one error that is on BASE
  and not this run's — `unused import: git` in
  `src-tauri/src/services/checkpoints/tests.rs:12` (Windows test build).
  Before `72558bf71` it also failed on the fence commit's two dead-code
  errors. `windows-check` and `macos-check` were queued behind the gate run
  and **did not run**: the `cfg(target_os = "macos")` code of the fix
  commits, the new `real::` test included, has not been type-checked.

Owed before this branch moves: `scripts/gates.sh --base abe62d19c`, then
`scripts/ci-local.sh --from windows-check` with the two variables above.

Not reviewed: the docs wording of `threat_model.md` and
`agent_fence_cross_os_plan.md` beyond the diff, and the todo block beyond
2442w's line. Every code commit in the range was read.

### Flagged for user (complete list)

Decisions carried over from the implementer, all still open:

1. Deny-default Seatbelt (§5) or `(allow default)` + targeted denials. Mach
   services stay open.
2. `launchctl submit` / `bootstrap` (check 3 in the list above).
3. 2442p: attribute-only Keychain lookup for a Claude login (32z).
4. Homebrew rsync 3 vs the root-owned-helper rule (#861).
5. macOS git: `/usr/bin/git` stub preferred over a Homebrew git; only the
   availability probe is guarded.
6. Native menu titles (Rust-built, English).

New from the review:

7. **A project whose folder is itself a symlink** gets no write access on a
   Mac (fix 1). To support it the profile has to stop the agent from
   replacing its root: `(deny file-write-unlink file-write-create (literal
   "<root>"))` for the roots, the writable dirs and the scope home
   (sandbox-runtime's "move blocking"), then follow the leaf link. Needs a
   Mac to verify, and makes `chmod`/rename of the root fail for tools.
8. **The scope home can be swapped for a symlink on a Mac** (older than this
   run, not fixed). `agent_home::create_private_dir` accepts a home that is
   a link (`is_dir` follows it), so `prepare_scope_home` — outside the
   sandbox — seeds, lays the `agent-global` layer and copies the shared
   logins through it into whatever folder the agent chose. With fix 1 the
   agent can no longer read or write that folder, but the app writes its
   fixed file names there. Wanted: refuse a scope home that is not a plain
   directory, on every OS.
9. **`user-preference-write`**: under `(allow default)` a fenced
   `defaults write` probably still reaches `cfprefsd`, which writes
   `~/Library/Preferences/*.plist` for the caller — another app's settings
   (Terminal's startup command) from inside the fence. Candidate rule
   `(deny user-preference-write)`; unverified, part of decision 1.
10. **Tools that ask the system for the temp dir instead of `$TMPDIR`**
    (`confstr(_CS_DARWIN_USER_TEMP_DIR)`: Foundation's
    `NSTemporaryDirectory`, so `swift build`, `xcodebuild`) get the hidden
    dir. Check on a Mac: `swift build` in a fenced tab. macOS's own
    `mktemp` is one of them (CI run 623: a bare `mktemp` was refused in the
    fence); a `mktemp` shim in `<state_dir>/bin` now hands it a template in
    `$TMPDIR` in tabs, not in one-shots (push preflight hides the state dir).
11. A symlink *on the way* to a shown path (not the leaf): `realpath` reads
    the link itself (`readlink`, `file-read-data`), which fix 2 does not
    allow — the kernel resolves it, so opens work, but a tool that resolves
    by hand may fail. Mac check with a project below a linked folder.
12. Other root daemons' sockets in `/var/run` (`usbmuxd`, `cupsd`, `pcscd`)
    stay reachable; Linux's private `/run` hides them.
13. **2442o:** pid-0 rows still have no liveness (implementer's note). An
    app run from a translocated or cryptex path (`Safari.app`) does not
    match its bundle path and keeps the old behaviour. A hand-off now waits
    the full 3 s poll before the row is demoted.
14. **2442x:** an ⌥+letter chord matches the physical key (`e.code`), which
    is the labelled letter only on QWERTY: on QWERTZ ⌥Z is `KeyY`, on AZERTY
    ⌥Q is `KeyA`. Needs a layout map or a decision to accept it.
    `hint.fileTreeBody` is not routed through `forPlatformKeys`.
15. **2442t:** `withHomebrew` / `with_homebrew` use `{ …; }` grouping, which
    zsh and bash run and fish does not; a user whose tab shell is fish gets
    a syntax error from the install buttons.
16. **2442r changes Linux too:** a tmux installed while the app runs is
    noticed within 30 s on every unix (before: at the next start). Wanted by
    the item; named here because it is a Linux behaviour change.
17. German `mobile.setupNoTmux` says "Ihre Tabs" where the dictionary says
    "du" elsewhere; `platform/macos.rs` has `list_window_ids`' doc comment
    sitting on `named_windows` now. Wording only, not touched.
