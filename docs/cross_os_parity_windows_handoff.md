# Cross-OS parity — Windows handoff (2026-11-15)

The Windows half of item **2442** (`todo/group-h-crossplatform.md`, audit
`docs/cross_os_parity_2026_11_12.md`). Nothing here was run on Windows: every
fix is covered by a test that runs on Linux (the OS as a parameter) or by a
`#[cfg(windows)]` test the CI Windows runner runs, and type-checked with the
Windows cross-clippy.

**BASE:** `abe62d19c728c2014cb3b84a16e0de358fa6fd37` (local `develop`).
Tip and commits: `git log --oneline abe62d19c..worktree-agent-abc303da7c2ae18f9`.

## Items

### 2442b + 2442c — scope home env on Windows (fixed, one commit: `82171671f`)

- **Premise confirmed** from Codex's source (`codex-rs/utils/home-dir`):
  `CODEX_HOME` if set (it must exist and be a directory), else
  `dirs::home_dir()`, which on Windows is the profile Known Folder
  (`SHGetKnownFolderPath(FOLDERID_Profile)`), not `USERPROFILE`.
- `agent_home::windows_profile_env` is the one Windows profile set —
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE` + `HOMEPATH` (split
  from the home path; UNC and `\\?\` handled) — used by the live tab
  (`agent_fence::home_env_for`), the probe (`probe_env_for`) and the installer
  (`agent_install::install_env_for`). `agent_home::home_override_env` is the
  per-CLI home-variable table (Codex → `CODEX_HOME=<home>\.codex`, created
  because Codex refuses a missing one); applied on Windows only, in
  `scope_home_env`, which the tab, the probe and the shell shim share.
  `home_env` now takes the agent's command.
- With `APPDATA` moved, a CLI the user installed with `pip install --user`
  would lose its own modules, so the user's `%APPDATA%\Python` passes through
  as `PYTHONUSERBASE` (same pattern as `CARGO_HOME`).
- b and c are one commit: both are the same function (`scope_home_env`).
- Tests: `codex_gets_its_home_variable_on_windows_only`,
  `the_windows_profile_set_moves_every_profile_variable_into_the_home`,
  `a_windows_home_splits_into_drive_and_path`,
  `a_live_windows_tab_moves_the_profile_set_and_keeps_user_python`.
- No table row for `KIMI_CODE_HOME` / `COPILOT_HOME`: both CLIs are Node/
  Python and read `USERPROFILE`, so no evidence they need one.

### 2442d — `.cmd` shims for a CLI typed into a Windows shell tab (fixed: `1a22a6752`)

- `agent_bin` writes `<cli>.cmd` (vendor aliases too) instead of nothing;
  POSIX shims unchanged. The shim runs `"<app>.exe" --agent-shim-env <cli>`
  under `for /f`, which prints `NAME=value` lines (`agent_shim::env_answer`):
  the scope env (`windows_scope_env`: `home_env_for` + the file-storage
  switches, a user-set switch wins) and the real CLI (`resolve_executable`,
  which skips the shim dir). The shim sets them under `setlocal` and runs the
  CLI on the same console (`call` for a `.cmd`, PowerShell for a `.ps1`).
- Why an env answer and not `--agent-shim` running the CLI: the release
  binary is a GUI-subsystem executable, which has no console to host the
  CLI's TUI; its stdout into a `for /f` pipe works.
- Gates, as for an agent tab: AI switch, the one-time platform acceptance,
  the scope's roots (cwd inside), Local models only (`fence_gate` refuses an
  unstamped spawn). The Host session (`HOST_SESSION`) gets the real CLI only.
- Tests: `the_cmd_shim_sets_the_scope_env_for_one_run_and_passes_the_arguments`,
  `the_windows_shim_env_replaces_the_profile_and_keeps_the_users_switch`,
  `windows_gets_cmd_shims_and_a_stale_sh_one_is_removed` (Windows CI only).
- Not covered (flagged): Git Bash does not try `.cmd`, so `claude` typed there
  still runs unshimmed; no API-key proxy / Claude long-lived token injection
  (the env answer would carry a secret through a pipe into cmd's env).

### 2442e — Grok's Windows row (fixed: `6ca31db62 (with 2442f)`)

`irm https://x.ai/cli/install.ps1 | iex`, from docs.x.ai/build/overview. The
script installs into `%USERPROFILE%\.grok\bin` (read, not run), which the
install env puts in the install home's `.grok/bin` (already a launcher dir).
Test: `the_vendor_windows_installers_run_in_their_shell`.

### 2442f — Windows install rows (partly: `6ca31db62`)

Each from the vendor's own docs (fetched, not run):

| CLI | Row | Where it lands |
|---|---|---|
| Muse | `irm https://dev.meta.ai/install.ps1 \| iex` (dev.meta.ai/docs/muse-code) | `%LOCALAPPDATA%\Programs\muse\muse.cmd` → new launcher dir |
| Cursor | `irm 'https://cursor.com/install?win32=true' \| iex` (cursor.com/docs/cli/installation) | `%LOCALAPPDATA%\cursor-agent\cursor-agent.*` → new launcher dir |
| Goose | `Invoke-WebRequest -Uri "…/download_cli.ps1" -OutFile "download_cli.ps1"; .\download_cli.ps1` (goose-docs.ai installation) | `%USERPROFILE%\.local\bin` |
| Vibe | `uv tool install mistral-vibe` (Mistral's manual install) | `UV_TOOL_BIN_DIR` = install home `.local\bin` |
| Kiro | **left empty** — see Flagged | |
| Plandex | none: WSL only (its README) | |

`windows_shell_kind` now reads `Invoke-WebRequest` as PowerShell (Goose).
Tests: `the_vendor_windows_installers_run_in_their_shell`,
`the_windows_installer_env_also_moves_the_profile_and_appdata`.

### 2442g — agent `git_push` with a pre-push hook on Windows (fixed: `92dc6af66`)

Read `docs/context/git_push_mcp.md` first. The trust model allows it without
weakening an invariant: on Windows the agent already runs on the host with
the user's rights (accepted once), so the hook run gives it nothing; what the
app must not do is run project code nobody approved, and no hook process may
hold the token. So:

- The spawn path stamps `PushBinding::unfenced_host` only for a local agent
  whose decision is `NotApplicable { reason: "platform" }`
  (`launch_prep::push_unfenced_host`; never ssh/docker, never the Host
  session, which has no Pusher).
- `HookBoundary::TrustedHost` runs the hook on the host through Git for
  Windows' `sh.exe` (`git_hardened::hook_command`), token variables removed as
  everywhere, **only while `exec_trust` holds the user's approval of the
  repo's hooks** (the git bar's own gate); otherwise `fence_unavailable` with
  "push once from the git bar, then ask again" and the hook never runs.
- Docs: `docs/context/git_push_mcp.md`, `docs/help/git.md`.
- Tests: `an_unfenced_hosts_hook_runs_only_once_approved_and_without_the_token`
  (Unix, the same code path with the trust check injected),
  `only_a_fenced_local_agent_stamps_its_push_binding`,
  `the_proposal_carries_the_fence_scope_its_binding_recorded`.

### 2442h — PowerShell hook: no Claude above this one (fixed: `8653abd3e`)

Windows cannot read another process's environment, so the check walks the
hook's parent chain (one `Get-CimInstance Win32_Process` read, only on a
clear/resume start with a foreign id) up to the app's executable (baked in
from `current_exe`) and counts Claude processes — `claude.exe`, or a
Node/Bun whose command line names `@anthropic-ai/claude-code`. Two or more
refuse; 64 hops at most. Test (text of the body, every OS):
`the_powershell_hook_refuses_a_nested_claudes_resume`.

### 2442i — TeX: no `\\?\` paths (fixed: `27699511d`)

`commands/tex.rs` canonicalises only through `canonical`
(`fs::canonicalize` + `paths::without_verbatim_prefix`): cwd, `-outdir`, the
format build, the include and root lists, the magic root and `pdf_path`.
Root-map entries an older build stored verbatim are re-learned at the next
compile. Tests: `tex_paths_never_carry_the_verbatim_prefix` (a source scan
plus outputs), `resolve_tex_root_prefers_magic_comment`.

### 2442j — sync mirror: Windows-hostile names (fixed: `76ced2a7a`)

`rel_components_for(windows, rel)` refuses a reserved device name
(`paths::is_windows_device_name`) and what `mail_attach::windows_part_refusal`
refuses (`:`, `NAME~1`, trailing dot/space). **Case policy, recorded in
`refuse_case_collisions`:** the spelling already in the mirror stays; a host
path that differs from it only in case (the file or a folder above) is
refused and reported, never written over it. Windows only (the real name
comes from `canonicalize` there). Tests:
`windows_hostile_mirror_names_are_refused_on_windows_only`,
`a_case_only_collision_is_refused_and_the_first_spelling_stays`.
Not covered: names inside a bulk rsync directory transfer.

### 2442m — small items (partly: `8140fcbe0`)

Done: system monitor marks a process it cannot open `unreadable` and the
pane shows — with a tooltip (`sysmon.unreadableTitle`); persisted-env
deny-list gains `HOMEDRIVE`, `HOMEPATH` (and `CODEX_HOME`, which 2442b now
relies on); fonts from `%WINDIR%\Fonts` and `%LOCALAPPDATA%`; MiKTeX's
`latexmk` with no Perl on PATH is passed over and the build drives the
engine, saying why in `driver_note` (MiKTeX KB: it ships no Perl). Tests:
`an_unreadable_process_is_marked_and_a_readable_one_is_unchanged`,
`a_persisted_env_is_matched_in_any_letter_case`,
`windows_font_dirs_follow_windir_and_localappdata`,
`miktex_latexmk_without_perl_is_passed_over`. Untouched: shell tab always
`COMSPEC`, login-keeper file identity, the no-op `prefetch_release` /
`run_heartbeat` / `sweep_stale_askpass` / launch-family tracking.

### 2442aa — print presets, Windows and macOS (fixed: `f98d2beb1`)

`nativePresets(platform)` (`lib/window/printing.ts`): Linux presets paper,
grayscale and two-sided; Windows and macOS none. There: grayscale is baked
into the PDF (`layoutPrintPdf` `bakeGrayscale` — a full-sheet neutral
rectangle in the `Saturation` blend mode, sheet an RGB transparency group;
text stays vector); Two-sided is disabled with `print.duplexNotPresetHint`;
Paper carries `print.paperNotPresetHint`; an approved two-sided/booklet
`print_request` reports `notApplied: ["duplex"]` and a message in
`print_status`. `UntestedTag` `print.grayscaleBaked`. Platform table in
`docs/context/print_mcp.md`. Tests: vitest `bakes grayscale into every
sheet only when asked to`, `nativePresets`; Rust
`a_printed_request_says_which_options_were_not_applied`.

### 2442l — background-job lamp (flagged, untouched)

A sound tie exists in principle (no tmux on Windows: walk ToolHelp ppids
down from the tab's ConPTY child, checking creation times against pid
reuse), but `is_background_job` also needs the shell's command line, and no
Windows reader for another process's command line exists here yet
(`ProcessCommandLineInformation`). Not built blind.

## Gates and cross-check

- `scripts/gates.sh` (the gates the diff touches: brand, whitespace,
  lint-fe, clippy, clippy-dlib, clippy-dmn, build, vitest, test, test-dlib)
  on the whole tree of these commits (it equals the tip minus this handoff
  and the todo ticks): **all passed**. Library suite: 5832 tests, 0 failed
  (14 ignored); vitest (changed files): all passed. The commits were split
  from that one gated tree by hunk afterwards, so each intermediate commit
  was not gated on its own; every later commit only adds to the earlier ones.
- Two earlier runs failed on things already broken on `develop` at BASE and
  fixed there since: `brand-check` (the tab-archive test) and `help_mcp`
  (`docs/help/mobile.md` keywords). Both fixes were cherry-picked first
  (`f14c5401b` ← c7b1811d7, `4dd315378` ← 3ea20a62a). One vitest run hit a
  flaky `TerminalAiSwitch` test that passes alone.
- **Windows cross-check:** `cargo clippy --manifest-path src-tauri/Cargo.toml
  --target x86_64-pc-windows-msvc --all-targets --no-default-features
  --features desktop,voice-io -- -D warnings` (the `windows-clippy` step of
  `scripts/ci-local.sh`, with the `eldrun-msvc-{rc,lib}-shim`s): **clean**.
  It first found a `type_complexity` in the new shim code (fixed) and a
  pre-existing unused import in `checkpoints/tests.rs` (fixed, `865e16e11`).
  Run with a private `CARGO_HOME` copy and its own target dir
  (`target/wt-parity-win`): the fence's `~/.cargo/registry` is read-only and
  one Windows-only crate was not cached. `windows-check` (whole workspace)
  was not run; only `src-tauri` changed.
- macOS cross-check not run (the print change is TS plus a `cfg!` constant).

## Flagged for user

1. **Kiro on Windows** — Kiro documents `irm 'https://cli.kiro.dev/install.ps1' | iex`
   (kiro.dev/docs/getting-started/installation.md), but the script runs a
   per-machine MSI (`msiexec /quiet`) into `C:\Program Files\Kiro-Cli`:
   needs elevation and lands outside the install home, so Update/Uninstall
   would not own it. Row left empty. Decide: accept a machine-wide install
   (and add `Program Files\Kiro-Cli` to the launcher dirs), or keep the
   docs link.
2. **Vibe needs `uv`** — Mistral's Windows path is "install uv, then
   `uv tool install mistral-vibe`". Without uv the Install tab fails with
   "uv is not recognized". Decide whether to chain Astral's uv installer.
3. **Vendor installers edit the user PATH** (Grok, Cursor, Muse write the
   User `Path` in HKCU) — same as the existing Claude/Codex rows; noted
   against "never edits another app's config".
4. **2442d gaps** — Git Bash in a shell tab still runs the real CLI unshimmed;
   the shim injects no API-key proxy or Claude long-lived token.
5. **2442l** — needs a Windows command-line reader; product call whether to
   build one.
6. **Never run on Windows.** Click-through on a real Windows machine (an
   installer built from this branch):
   1. Codex (2442b/c): open a project, new Codex tab, sign in. In its shell
      (`!` or a shell tab of the agent) run `echo %CODEX_HOME% %APPDATA%` →
      both under `…\agent-homes\<project>`. Open a second project's Codex
      tab → already signed in.
   2. Shell shim (2442d): new shell tab (cmd) in a project, type `claude` →
      it starts signed in; `/exit`; `echo %USERPROFILE%` → your own profile.
      Repeat in PowerShell. `cd C:\` then `claude` → "cd into the project
      first". In Git Bash: note it runs unshimmed (known gap).
   3. Session hook (2442h): in a Claude tab ask it to run
      `claude -p --resume <some old id> hi` in its shell → the Chat view
      keeps the tab's conversation. Type `/clear` in the tab → the Chat view
      follows to the new conversation.
   4. git push (2442g): project with `.git/hooks/pre-push` (e.g. `echo hi`).
      Agent calls `git_push` → refused "push once from the git bar". Push
      from the git bar, approve the hooks dialog. Agent pushes again → the
      card shows "hi" and the push goes out. Edit the hook → refused again.
   5. TeX (2442i, 2442m): MiKTeX without Perl: Compile a document with
      `\input{chapter}` → PDF opens, the note says latexmk needs Perl; the
      PDF tab's path has no `\\?\`. With TeX Live: built by latexmk.
   6. Sync (2442j): remote project holding `aux.py`, `README.md`,
      `readme.md`; pull all → two refusals listed, `README.md` intact.
   7. Installs (2442e/f): Manage CLIs → install Grok, Muse, Cursor, Goose
      (and Vibe with uv present) → each card turns installed without a
      restart; a tab of each starts.
   8. Print (2442aa, Windows and macOS): open a colour PDF → Print → Two-sided
      is greyed with its hint, Paper has its hint; Grayscale on → Approve →
      the system dialog's preview and the paper are gray, text sharp. Agent
      `print_request` with `duplex: "long"` → approve → `print_status` shows
      `notApplied: ["duplex"]`.
   9. System monitor (2442m): a SYSTEM-owned process shows — in CPU/MEM/RSS
      with a tooltip.
