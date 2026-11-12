# Windows and macOS parity audit — 2026-11-12

Which Linux features are missing, stubbed or silently degraded on Windows and
macOS, as of `develop` at `214933ab5` (v0.2.66). Work items: `todo/group-h-crossplatform.md`
item **2442**; the ids below (`2442a` …) are its sub-items.

**How it was made.** Four reading passes (two per OS) over the platform gates,
the ungated Linux assumptions, and the features added since the completion run
at `e54adf3d` (2026-10-08). Nothing was built or run on Windows or macOS.
**confirmed** means the code path was read end to end; **likely** means the
finding also rests on how the OS or a third-party CLI behaves, which only a
live run settles. Line numbers are against the tree of that day — verify
before relying on one.

**Verdict.** Most post-`e54adf3d` features have a twin, an explicit refusal, or
a UI that hides them. The gaps cluster in three places: agent-tab isolation on
Windows, app tracking and the fence on macOS, and agent logins kept in the OS
credential store on both.

## Windows

| Id | Gap | What Windows gets | Confidence |
|---|---|---|---|
| 2442a | **CI red since v0.2.65; no installer for v0.2.66** | `muse_session::tests::reads_prompts_and_answers_of_the_folders_session` fails: the fixture `fn log()` (`services/agent/muse_session.rs:357`) writes the raw temp path into JSON, invalid with backslashes. `package-windows` needs `test-windows`. Production code is not implicated. Fix: JSON-escape `root` in the test fixtures. | confirmed (CI run + code) |
| 2442b | **Codex ignores its scope home** | A live tab's `home_env` sets only `HOME` and `USERPROFILE` (`agent_fence.rs:1965`); nothing sets `CODEX_HOME`. Codex resolves its home with Rust `dirs::home_dir`, which on Windows asks the profile Known Folder, not the environment. So a Codex tab would use the user's real `.codex`: no scope config or hooks, no `agent_global` layer, no shared login, and the readers (`codex_store.rs`) look in the wrong folder. Fix: set `CODEX_HOME=<home>\.codex`, as a per-CLI table beside `fence_env` (`KIMI_CODE_HOME`, `COPILOT_HOME` are the same idea). | likely |
| 2442c | **`APPDATA` / `LOCALAPPDATA` / `HOMEDRIVE` / `HOMEPATH` not redirected for live tabs** | The installer (`agent_install.rs:62`) and the probe (`agent_home.rs:124`, `probe_env_for`) redirect `APPDATA`; the live tab does not, and `LOCALAPPDATA` is redirected nowhere. A CLI that keeps state there is probed in one tree and run in another. Goose (`%APPDATA%\Block\goose`) is the clear case. Fix: give `home_env` the probe's env set plus `LOCALAPPDATA`. | confirmed |
| 2442d | **A CLI typed into a shell tab is not shimmed** | `agent_bin.rs:56` writes the per-CLI shims as extensionless POSIX scripts; `cmd` and PowerShell do not run those, so a typed `claude` is the real binary against the real home. Under Git Bash the shim wins and `agent_shim::run` exits "no agent sandbox on this platform". Contradicts the AGENTS.md invariant. Fix: `.cmd` shims that apply the home env. | confirmed |
| 2442e | **Grok installs the wrong CLI** | `agent_registry.rs:253`: `install_cmd_windows` is still `npm install -g @xai-official/grok`, the stale third-party client the Linux row left. xAI reportedly ships `irm https://x.ai/cli/install.ps1 \| iex`. | confirmed (row); upstream from third-party guides |
| 2442f | **No Windows install command for six agents** | `install_cmd_windows: None` for vibe, kiro, cursor-agent, goose, plandex, muse. The UI hides Install and shows the docs link (`AgentsPanel.tsx:741`), so nothing fails on click. Muse, Cursor and Kiro reportedly ship for Windows now (PowerShell installers); Goose and Vibe (uv) too. | confirmed (rows); upstream from search |
| 2442g | **Agent `git_push` refuses a repo with a pre-push hook** | No fence to run the hook in: `git_push_mcp.rs:752` returns `FenceUnavailable` with an explicit message. A hard gap for any repo using its own hook. Fix: run the hook under `exec_trust` through `hardened_git_command_in`. | confirmed |
| 2442h | **PowerShell session hook lacks the stray-`--resume` check** | POSIX hook accepts a `clear`/`resume` start only from a Claude with no Claude above it (`agent_session.rs:2555`); `hook_script_body` (`:2775`) has no twin. A `claude -p --resume <id>` from the agent's own shell moves the tab's live-session record; the Chat view shows that run until the next Stop. | confirmed |
| 2442i | **TeX builds carry `\\?\` paths** | `fs::canonicalize` (`commands/tex.rs:1212`) feeds latexmk's cwd, `-outdir`, the format build, and the returned `pdf_path`; `paths::display_path` is never applied. Certain: the PDF tab's path does not match the file tree's. Possible: Perl/kpathsea reject the verbatim cwd. | likely |
| 2442j | **Sync mirror accepts Windows-hostile names** | `remote_sync.rs:249` (`rel_components`) refuses `..`, roots and NUL only. Reserved device names (`aux.py`, `nul`), `name:stream`, trailing dot/space and `NAME~1` pass. Mail attachments (`mail_attach.rs:135`, `windows_part_refusal`) and phone uploads already refuse them. | likely |
| 2442k | **Tab close is a hard kill** | `reap_pids` (`terminal/mod.rs:1424`) calls `TerminateProcess` on a subtree walked beforehand; every `ReapMode` is immediate and there is no job object, so a process spawned mid-kill escapes and nothing gets to flush. | confirmed |
| 2442l | **Background-job lamp never lights** | `tool_shell_uids` returns an empty set (`agent_turn.rs:879`): no reader of another process's environment. | confirmed |
| 2442m | **Small** | `restart_renderer` returns `Err` (`commands/debug.rs:485`). Login keeper has no file identity: length + mtime + 3 s settle (`agent_auth.rs:603`). MiKTeX's `latexmk` needs Perl; detection (`tex.rs:80`) does not check and there is no engine fallback. Shell tab is always `COMSPEC` (`terminal/mod.rs:2334`), no PowerShell choice. System monitor reports 0 for a process it cannot open (`sysstat.rs:~2150`) — against "never render a missing reading as zero". Persisted env deny-list lacks `HOMEDRIVE`/`HOMEPATH` (`terminal_service.rs:643`). `C:\Windows\Fonts` hard-coded (`tex.rs:2115`). No-ops: Codex `prefetch_release`, `run_heartbeat`, `sweep_stale_askpass`, app launch-family tracking, elevated Ollama blob removal. | confirmed |

## macOS

| Id | Gap | What macOS gets | Confidence |
|---|---|---|---|
| 2442n | **Fence is weaker than Linux's** (security) | `sandbox_exec_profile` (`agent_fence.rs:2025`) starts from `(allow default)` and adds file denies only. `SSH_AUTH_SOCK` is not scrubbed, `/private/tmp` and `$TMPDIR` are shared, and nothing denies `lsopen` / `appleevent-send`: a fenced agent can sign with the user's ssh-agent, and `open -a Terminal x.command` or `osascript` starts a program outside the sandbox. `docs/agent_fence_cross_os_plan.md` names these gaps; its §5 profile was never built, and `threat_model.md` documents only the keychain limit. | confirmed (profile); escape semantics inferred |
| 2442o | **Launched apps are mostly untracked** | `.app` bundles start through `/usr/bin/open -a` (`commands/apps.rs:434`); `open` exits at once and the app is not its child. `proc_table::start_time` and `launch_id` are `None` off Linux, so there is no family. Without a window within ~2 s the row is removed: no parking on project switch, no close. `named_windows()` is empty and `activate_window` errs (`platform/mod.rs:67`, `:96`), so "Open in IDE" always relaunches. pid-0 rows are never pruned (`PID0_WINDOW_LIVENESS`, `apps.rs:2379`). Fix: resolve the real pid (`NSWorkspace`/`lsappinfo` by bundle id), retry for a late window. | confirmed |
| 2442p | **Agent logins in the Keychain are invisible** | See [Agent logins](#agent-logins-both). For Claude: `signed_in` / `importable` read `.claude/.credentials.json`, which a Keychain login never writes, and the `claude_token` fallback is injected "while agent_auth holds no shared Claude login" — always true here, which would make the tab inference-only. | likely |
| 2442q | **Webview data does not follow the rename** (also Windows) | `state_gc::webview_data_root` returns `None` off Linux (`state_gc.rs:141`), so the `webview-data` migration step no-ops while the bundle identifier did change. localStorage and IndexedDB are left behind. | confirmed |
| 2442r | **No tmux, no explanation** | tmux is not preinstalled. `tmux_available()` (`tmux_local.rs:249`) is false: non-persistent tabs and no phone terminals, silently. The persist toggle (`SettingsPanel.tsx:1346`) shows on with static help; no install flow exists; the probe is a `OnceLock`, so an install is not noticed until restart. | confirmed |
| 2442s | **Tailscale setup button fails** | It types a bare `tailscale serve --bg …` (`MobileSetupGuide.tsx:36`, `MobileSettings.tsx:435`); the Mac app's CLI is inside the bundle, not on PATH. The backend already resolves the bundle path (`mobile_control/config.rs:108`). | confirmed |
| 2442t | **Install hints assume Homebrew** | git (`ProjectDialog.tsx:55`), gh/glab (`installCommand.ts:20`), TeX (`TexView.tsx:128`), QEMU (`vm.rs:532`), OpenVPN (text). No brew presence check or bootstrap. Without the Command Line Tools, `git --version` (`git_hardened.rs:808`) also raises the system "install developer tools" dialog. | confirmed |
| 2442u | **Main window forced fullscreen at every launch** | `AppShell.tsx:422` calls `setFullscreen(true)` unconditionally, overriding the geometry Rust restored. A fullscreen window is its own Space, which works against app-granular parking. No setting. | confirmed (code); UX effect likely |
| 2442v | **Phone sidecar is a copy taken out of the bundle** | `mobile_binary_source` off Linux is `current_exe()` copied to `<control_dir>/bin/<version>/` (`commands/mobile_control.rs:524`) and run by launchd. A bundle's main executable copied alone may fail signature validation, which on arm64 kills it at launch. No `codesign` anywhere. Fix if confirmed: point the plist into the bundle. | likely — needs a Mac |
| 2442w | **Seatbelt rules on un-canonicalised roots** | `seatbelt_scope_inputs` uses the lexical root (`agent_fence.rs:2142`); Seatbelt matches the resolved path. A project reached through a symlink probably gets write allows that never match. | likely |
| 2442x | **Keyboard** | Alt+letter defaults (`closeAllTabs`, `privacyCurtain`) match on `e.key` (`shortcuts.ts:597`), which Option changes — they probably never fire. Terminal keyboard-select honours Ctrl+C/X only (`keyboardSelect.ts:150`). Several strings say "Ctrl" where ⌘ applies (`en.ts`: `terminal.pathLink.newSubwindow`, `tableView.copySelectionTitle`, `settings.zoomHelp2`, the Ctrl+B / Ctrl+K lessons). Ctrl-drag file export (`fileTreeDrag.ts:165`) collides with Ctrl-click. Native menu titles `"Edit"` / `"Window"` are literals (`lib.rs:1056`). | likely / confirmed (strings) |
| 2442y | **Tool lookup is a fixed PATH list** | `paths::extra_path_dirs` (`paths.rs:244`) covers Homebrew, MacPorts, MacTeX, Docker, nvm; not Volta, fnm, bun, asdf, mise, pyenv, pnpm, rbenv. Every spawn goes through it. `rsync` is taken from system dirs first (openrsync / 2.6.9), so a Homebrew rsync 3 is never used and pulls stay on the SFTP walker. | confirmed |
| 2442z | **Small** | Background-job detection lacks the task-output and start-time checks (`agent_turn.rs:826`). No `PR_SET_PDEATHSIG` / `RLIMIT_AS` twin for bounded children and the spreadsheet reader (`paths.rs:905`, `sheet_reader.rs:361`). Fenced agents cannot read `crash.log` (`agent_fence.rs:1464` is Linux-only). No UI-thread priority. Byte-sync has no case-fold or NFC/NFD handling. `run_heartbeat` empty; `fd_limit::spawn_headroom` always Ok. `AGENT_FENCE_DEFAULT_PATHS` (`agentFence.ts:36`) lists Linux dirs only. | confirmed |

## Both

| Id | Gap | State |
|---|---|---|
| 2442aa | **Print: grayscale, two-sided and paper ignored** | `print_native.rs` takes `_setup` unused on Windows (`:193`) and macOS (`:136`). The preview enables the controls with a tooltip saying they are preset (`print.ts:855`), and an approved agent `print_request` drops them silently. Booklet, N-up, copies and ranges are baked into the PDF and unaffected. |
| 2442ab | **Platform clippy cannot fail CI** | Both steps are `continue-on-error` (`ci-cd.yml:438`, `:518`), "staged" since the completion run. A macOS build break on 2026-11-10 (`928960ac1`) slipped through. |
| 2442ac | **Stale docs** | `threat_model.md`: macOS fence escapes (2442n). `docs/context/openvpn.md`: Linux only, nothing on the Windows service path. `docs/context/print_mcp.md`: no platform note (2442aa). |
| — | Unsigned installers | No Authenticode (`todo/group-o-security.md`), no notarisation (`docs/context/release_signing.md`). Tracked there. |

## Agent logins (both)

Login sharing (`agent_auth`) reads credential files under the scope home. A CLI
that keeps its login in the OS credential store writes no file, so shared
sign-in and "importable" detection do nothing for it, and a Keychain login is
shared across every scope (the Keychain does not follow `$HOME`). `fence_env`
(`agent_auth.rs:934`) forces file storage for muse, droid, goose, gemini, qwen,
qoder and vibe only. Sub-item **2442ad** covers verifying and fixing this table.

Sources are vendor docs where they exist and third-party write-ups otherwise:
treat every "real location" as a lead to confirm on a real install.

| CLI | Path the code reads | macOS | Windows |
|---|---|---|---|
| claude | `.claude/.credentials.json` | Keychain (`Claude Code-credentials`); file is a fallback — **mismatch** | `%USERPROFILE%\.claude\.credentials.json` — match |
| codex | `.codex/auth.json` | file or Keychain by `cli_auth_credentials_store`; default not established | same path, but home redirect bypassed (2442b) |
| cursor-agent | `.config/cursor/auth.json` | Keychain by default; file mode (`AGENT_CLI_CREDENTIAL_STORE=file`) reportedly writes `~/.cursor/auth.json` — **mismatch** | not established; `.config/cursor` probably unused — **likely mismatch** |
| copilot | none (per scope); sessions `.copilot/session-state` | Keychain (`copilot-cli`), shared across scopes; `copilot_auth` is Linux-only | `%USERPROFILE%\.copilot` — match |
| gemini | `.gemini/oauth_creds.json` | Keychain by default; `GEMINI_FORCE_FILE_STORAGE` is set, so file | likely match |
| antigravity | `.gemini/antigravity-cli/antigravity-oauth-token` | Keychain per vendor docs — likely mismatch | Credential Manager per vendor docs — unknown |
| goose | `.config/goose/secrets.yaml` | Keychain by default; `GOOSE_DISABLE_KEYRING` is set; file path matches per docs | `%APPDATA%\Block\goose\config` — **mismatch** (2442c) |
| opencode | `.local/share/opencode/auth.json` | match | match |
| kimi | `.kimi-code/credentials/*.json` | match | match |
| pi | `.pi/agent/auth.json` | match | not researched |
| grok | `.grok/auth.json` | match | match |
| amp | `.local/share/amp/secrets.json` | likely match | likely match |
| droid | `.factory/auth.v2.json` | keyring with file fallback; a third-party tool names `auth.v2.file` / `auth.v2.key` — unknown, on Linux too | unknown |
| muse | `.config/muse/auth.json`; sessions `.local/share/muse/sessions` | not documented — unknown | not documented — unknown |
| junie, qoder, kiro | various | unknown | unknown |
| qwen, auggie, codebuddy, plandex, cline, aider, continue, crush, kilo, openclaw, swe-agent, mini-swe-agent | various | not researched | not researched |

## Checked and at parity

- **Mail, calendar, encryption, ICS**: OpenPGP, SMTP/IMAP and CalDAV are
  in-process Rust; `keyring` has native Windows and Apple backends; attachment
  reads have per-OS handle walks.
- **Windows window parking**: every `WorkspaceBackend` method is implemented;
  the post-`e54adf3d` additions (`named_windows`, `activate_window`, late
  windows, privacy curtain, sleep inhibitor) have Windows arms.
- **VMs, OpenVPN, GPU readouts, network pane** on both; **mobile host**
  (launchd on macOS, HKCU Run key and named pipe on Windows).
- **CLI install and update plumbing**, session-hook twins, `tabtivity-send`
  twins, the updater, voice (whisper, OS voices, Piper on Windows).
- **Sync**: rsync is a fast path with an SFTP fallback; rel paths are
  normalised to `/`; spawned tools are BSD-aware.
- **Frontend**: OS detection is centralised in `src/lib/platform.ts`;
  ⌘/Ctrl mapping in `chordMatches`; gated features are hidden or explained.
- **MCP lanes** (git, print, markup, cockpit, help, web, schedule) contain no
  platform branches.

Decided differences (not gaps) are listed in the Group H opener.

Four findings repeat items the 2026-09 sweep deferred on purpose in **32z** —
they need the product call recorded there, not a fix on sight: the ConPTY job
object (2442k), the Windows renderer restart (2442m), fullscreen restore on
macOS (2442u) and the login-shell PATH import (2442y). 32z's "Keychain file
read for fenced Claude" is the other half of 2442p.

## Not checked

- Anything at run time. First live checks: 2442b (Codex home on Windows),
  2442v (sidecar signature on a Mac), 2442i, 2442w, and where Muse, Cursor,
  Droid and Antigravity keep logins and sessions.
- Whether MiKTeX honours `TEXFORMATS` for the preamble-format cache, and
  whether latexmk reads an rc name beyond `latexmkrc` / `.latexmkrc` there
  (`exec_trust.rs:525` checks only those two).
- ConPTY details (resize, bracketed paste, `TERM`), the Windows `agent_exec`
  key carrier, `worker_sync` behaviour its `cfg(unix)`-only tests leave
  unexercised.
- The ICS-import frontend, TeX and mail on macOS beyond PATH lookup, and the
  ~480 `feat` commits one by one (they were walked by area and by gate).
