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

## Review

A second reading of `4dd315378..cbc49d4b1` (2026-11-15), with three fixes on
top, on branch `worktree-agent-a9a30858096c48a1f`. Nothing was run on Windows
or macOS. **Run** means executed here on Linux; **read** means concluded from
the code.

### Per commit

| Commit | Item | Verdict |
|---|---|---|
| `82171671f` | 2442b+c | **fixed** — the moved `APPDATA`/`LOCALAPPDATA` named folders nothing creates (`e09916b8f`). The rest ok (read). |
| `1a22a6752` | 2442d | **fixed** — a CLI an agent starts itself was refused, or the shim ran itself (`d02479fca`). **Flagged**: R1, R3. |
| `8653abd3e` | 2442h | ok (read). **Flagged**: R2. |
| `92dc6af66` | 2442g | ok (read; its test run). **Flagged**: R4. |
| `27699511d` | 2442i | ok (read; tests run). |
| `76ced2a7a` | 2442j | ok (read; tests run). Note R8. |
| `6ca31db62` | 2442e+f | ok — the five rows fetched again from the vendors' pages (Grok, Cursor, Muse, Goose, Vibe) and they match; nothing run. **Flagged**: implementer's 1–3. |
| `8140fcbe0` | 2442m | ok (read). **Flagged**: R6, R7. |
| `f98d2beb1` | 2442aa | **fixed** — a baked-grayscale sheet came out mid-gray wherever the page was blank (`afa9ab992`). **Flagged**: R5. |
| `865e16e11`, `cbc49d4b1` | import, docs | ok. |

Linux and macOS arms: read commit by commit. Two things change off Windows:
the print commit's macOS half, which the item asks for, and the
persisted-env deny-list, which drops `HOMEDRIVE`, `HOMEPATH` and
`CODEX_HOME` from a saved tab layout on every OS (no built-in tab saves
one; a custom agent's own setting is still honoured).

### Fixes

1. **`afa9ab992` fix(print)** — 2442aa. *Input:* Windows or macOS, a
   grayscale job, any page with unpainted paper (every LaTeX page).
   *Wrong outcome:* the `Saturation` rectangle is blended inside the page's
   isolated transparency group; where nothing was painted there is no
   backdrop, and a blend over none paints its own colour, 50 % gray, over the
   whole blank part of the sheet. **Run:** Ghostscript, MuPDF and Poppler all
   render the unfixed PDF's paper as RGB 127; with the fix, 255, the red
   test square gray 77. *Fix:* each baked sheet starts with an opaque white
   rectangle beneath the document. *Test:* vitest
   `paints a baked-grayscale sheet white beneath the document` (run; fails
   with the fix removed).
2. **`d02479fca` fix(windows)** — 2442d with 2442c. *Input:* a Windows agent
   tab (its PATH starts with the shim directory, its `APPDATA` is the agent
   home's since 2442c); the agent runs `claude …` or `codex …` from cmd or
   PowerShell. *Wrong outcome:* `--agent-shim-env` resolves the app's state
   dir from `%APPDATA%` (`storage::state_dir_base`), finds no settings, reads
   the one-time acceptance as ungiven and refuses ("open an agent tab once
   and accept that first"). In the Host session it skipped the wrong shim
   directory, answered the shim itself, and the shim called itself without
   end. Before 2442d both calls ran the real CLI. *Fix:* such an agent's
   environment carries `<APP>_AGENT_UNFENCED=<shim dir>` (a control variable,
   stripped from layouts like `AGENT_FENCE`; set for the agent tab, the Host
   session and a CLI the shim started; Windows only). The shim's answer is
   decided from it before any state is read: the real CLI from the caller's
   PATH outside that directory, no second environment — what the POSIX shim
   does inside a fence. *Tests:*
   `a_windows_agents_own_cli_call_steps_aside_past_the_shim`,
   `the_unfenced_agent_marker_is_set_by_the_spawn_and_only_on_windows` (run).
   The Windows-only caller is covered by the cross-clippy only.
3. **`e09916b8f` fix(windows)** — 2442c. *Input:* a Windows agent tab or
   probe after 2442c. *State:* `<home>\AppData\Roaming` and
   `<home>\AppData\Local` do not exist; only the installer's home creates
   them, for the reason written at `commands::agents::into_install_home`.
   *Wrong outcome (by that record, not seen here):* npm fails writing into a
   missing `%APPDATA%`, and PowerShell — every session hook — writes its
   module cache relative to the working directory, the user's project.
   *Fix:* `scope_home_env` makes both folders of a prepared home. *Test:*
   `a_windows_agent_homes_appdata_folders_exist_before_a_cli_runs` (run;
   fails with the fix removed).

### Gates and cross-checks

All run on `e09916b8f`, the tree of the three fixes; this section was added
afterwards and touches no gate but the always-run ones, run again on it.

- **Gates** — `scripts/gates.sh --base cbc49d4b1` (the ten the fixes
  select: brand, whitespace, lint-fe, clippy, clippy-dlib, clippy-dmn,
  build, vitest, test, test-dlib): **all passed**.
- **Windows cross-check** — `cargo clippy --manifest-path
  src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets
  --no-default-features --features desktop,voice-io -- -D warnings`, with
  the msvc `rc`/`lib` stand-ins, the implementer's private `CARGO_HOME` and
  `target/wt-parity-win`: **clean**, on `cbc49d4b1` and again on
  `e09916b8f`. It type-checks the Windows-only code; it runs none of it.
- **macOS cross-check** — `ci-local.sh`'s `macos-check` (`cargo check
  --workspace --all-targets --target aarch64-apple-darwin
  --no-default-features --features desktop,voice-io`, check-only `cc`/`ar`
  stand-ins): **passed**, on `cbc49d4b1` and again on `e09916b8f`. Its one
  note, a future-incompatibility warning for the `block` crate, is not this
  branch's.
- **Not run:** `windows-check` (the whole workspace; only `src-tauri`
  changed), `gates.sh --all`, anything on a Windows or macOS machine. The
  `#[cfg(windows)]` tests (`windows_gets_cmd_shims_and_a_stale_sh_one_is_removed`)
  run on the CI Windows runner only.

### Flagged for user

Reviewer's, most serious first. None was acted on.

- **R1 — 2442d, non-ASCII profile paths.** `--agent-shim-env` prints UTF-8;
  cmd reads `for /f` output in the console code page (850 or 437 by
  default). For an account like `C:\Users\Jörg` every value that names the
  state dir (`USERPROFILE`, `APPDATA`, …) and a real CLI under the profile
  would arrive garbled, and a typed `claude` would fail where before 2442d
  it ran. From how cmd decodes; needs a Windows machine. Directions:
  `chcp 65001` around the read and back, or the helper writing the console's
  code page. (The app's own path is baked into the `.cmd`, but the
  installer is per-machine, so it is ASCII.)
- **R2 — 2442h, one Claude seen as two.** The walk counts processes, and
  refuses at two. If npm's launcher (a Node whose command line names
  `@anthropic-ai\claude-code\`) starts a native `claude.exe`, or a
  self-relaunch spawns a child (Windows has no `exec`), the tab's own Claude
  counts twice and its `/clear` and `/resume` stop moving the record.
  Click-through 3's second half decides it; try both an npm and a native
  install. If it fails: count a run of adjacent Claude processes as one.
- **R3 — 2442d, letter case of the working directory.** `scope_for`
  compares `current_dir()` to the registry's spelling with
  `Path::starts_with`, which is case-sensitive on Windows. PowerShell keeps
  the case the user typed (`cd c:\dev\proj`), so the shim would answer
  "outside the scope's roots" inside the project.
- **R4 — 2442g, a hook that is not a shell script.** `sh.exe <hook>`
  ignores the `#!` line, so a `pre-push` written in Python or Node runs as
  shell, fails, and the push is refused (it fails closed). Git itself
  reads the `#!` line on Windows.
- **R5 — 2442aa, the disabled Two-sided control still acts.** On Windows
  and macOS it keeps a value saved earlier or sent by an agent's request,
  and `layoutPrintPdf` goes on adding the blank filler side between copies
  for it; the user cannot change it. Decide: a layout hint the user may
  set, or always none there.
- **R6 — 2442m, an English sentence from the backend.**
  `MIKTEX_PERL_NOTE` reaches the TeX view untranslated (the other driver
  notes are the tool's own output).
- **R7 — 2442m, test reach.** The monitor's new test covers the JSON field
  only; the Windows arm that sets `unreadable` and the pane's dash have none.
- **R8 — 2442j, notes.** A host rename that changes only the case is
  refused while the old spelling is in the mirror; the check adds one
  `canonicalize` per path component per write on Windows.
- **R9 — 2442c, residual.** Any app binary started under a Windows agent
  tab resolves its state dir from the agent home's `APPDATA`. Only the
  shim's helper does so today (fix 2). A second one needs the state dir
  pinned in the tab's environment.

Implementer's, all still open: **1** Kiro (per-machine MSI), **2** Vibe
needs `uv` — note `commands::ollama::vibe_install_cmd` already chains
Astral's installer for the same CLI, so the two Windows commands differ,
**3** vendor installers edit the user PATH, **4** Git Bash runs unshimmed and
the shim injects no API-key proxy or Claude token, **5** 2442l, **6** never
run on Windows.

Click-through, added to the implementer's list:

10. Agent's own CLI call (fix 2): in a Codex tab and in a Host session ask
    the agent to run `claude --version` through PowerShell → the version,
    no "accept that first", no hang.
11. AppData (fix 3): open an agent tab in a fresh project, let one prompt
    finish → the project folder holds no new `Microsoft\Windows\PowerShell`
    folder; `npm config get prefix` in the agent's shell names
    `…\agent-homes\<project>\AppData\Roaming\npm`.
12. Grayscale (fix 1; step 8 again): the paper around the text is white in
    the system dialog's preview and on the sheet, not gray.
13. R1: step 2 on an account whose name has a non-ASCII letter.
