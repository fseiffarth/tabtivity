# Cross-OS parity — macOS run, handoff (2026-11-15)

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
