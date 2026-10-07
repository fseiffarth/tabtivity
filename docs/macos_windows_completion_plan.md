# macOS / Windows completion — plan

Status: plan + implementation in progress (plan 2026-10-07, from three
read-only reviews: backend `src-tauri/`, desktop frontend `src/`, mobile +
shipped scripts + backlog + CI). Nothing here was run on a Mac or a Windows
box; see §1 for what that means for each step.

## 0. Why

Linux is the reference platform. Windows (alpha, NSIS) and macOS (runs,
lightly tested) got a parity sweep on 2026-09-03, but the reviews found a
second layer of gaps underneath it: Windows paths handled with `/`-only
string code in the frontend, a Windows installer path that puts agent CLIs
into the user's real profile, trusted-helper resolution that is still open to
the #861 planted-binary class on Windows, a nested-`claude` guard that only
works where `/proc` exists, a fenced macOS tab whose agent `git_push` always
fails when a pre-push hook exists, and a phone that offers ＋ / Schedule on a
Windows host that has no tmux and then refuses. Each is small on its own;
together they make the two ports feel half-finished.

## 1. Verification limits (read before any step)

- **Windows:** `cargo check` and `cargo clippy` for `x86_64-pc-windows-msvc`
  work on this Linux box with the two shims (memory `project_windows_build`):
  ```
  export PATH="$HOME/.cargo/bin:$PATH"
  RC="$HOME/.local/bin/eldrun-msvc-rc-shim" AR_x86_64_pc_windows_msvc="$HOME/.local/bin/eldrun-msvc-lib-shim" \
    cargo check  --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
  RC=… AR_x86_64_pc_windows_msvc=… cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -- -D warnings
  ```
  Only the lib target is checked; `cfg(windows)` tests never run here. (Both
  shims exist at those paths — checked 2026-10-07.)
- **macOS:** `cargo check --target aarch64-apple-darwin` stops in
  `objc2-exception-helper` (needs an Apple `cc`; re-confirmed 2026-10-07).
  macOS arms are verified by **reading against the Linux reference** plus
  CI `test-macos`. Keep macOS arms small, prefer reusing an existing macOS
  helper over new FFI, and never claim they work.
- **Frontend:** everything is OS-neutral TypeScript; test Windows paths by
  feeding `C:\…` strings. `src/lib/platform.ts` exports `IS_WINDOWS`,
  `IS_MAC`, `IS_LINUX`, `PLATFORM`; tests can `vi.mock` it.
- Every new arm gets an `UntestedTag` row / pill where it has UI (row in
  `src/lib/untested.ts`; `src/__tests__/shell/UntestedRegistry.test.ts` fails
  on a pill without a row), and a 🖐️ line in `todo/group-h-crossplatform.md`
  with the four platform children — the exact child shape is the one at
  `todo/group-h-crossplatform.md:487–495` (✅/❌ pair per platform, tick none).
- Dictionary parity is enforced by `src/__tests__/shell/i18n.test.ts`
  ("every language covers every English key" / "no language defines a key
  English does not" / placeholder survival): every new or renamed key lands in
  `src/lib/i18n.ts` **and** all four `src/lib/i18nDicts/{de,es,fr,it}.ts`.
  The phone PWA has no dictionary of its own: its `mobile.*` keys live in the
  same files.
- Shipped scripts: the file names `scripts/tabtivity-send.{sh,ps1,cmd}` and
  `scripts/install_phone.{sh,ps1}` are on `scripts/brand-check.sh`'s allowlist
  (`"scripts/$APP_SLUG-send.ps1"` …), so those files may spell the name; the
  copy an agent home gets is named at write time by
  `services::agent_bin` (`brand::SEND_CLI`, `concat!(app_slug!(), "-send.ps1")`).
  Any **new** script sources `scripts/lib/brand.sh` and uses `$APP_SLUG`.

## 2. Fixed decisions

1. Scope is **completion of existing features**, not new platform features.
   Hardware-blocked or product-level items are listed in §5 and not built.
2. Frontend path fixes use `basename`/`dirname`/`normalizePath` from
   `src/lib/paths.ts` (they accept both separators and drive roots). No new
   path helpers.
3. Windows command quoting comes from the existing
   `pythonRun.shellQuote(arg, "windows")` (`src/lib/terminal/pythonRun.ts:57`
   — verified: `"…"` with `""` doubling). POSIX quoting stays for bash/zsh/sh.
4. Windows-only Rust goes behind `#[cfg(windows)]` with a pure, cfg-free
   core (string/parse/decision logic) that has a Linux-run unit test. Same
   for macOS: parsers of `ps`/`route`/`arp` output are pure functions tested
   with captured sample text.
5. The hook scripts stay single files: the sh hook gains a `ps`-based
   fallback branch used when `/proc` is unreadable (macOS), exercised by a
   Rust test that runs the script body with a shimmed `ps`. The PowerShell
   `Win32_Process` walk is **not** built here: `todo/group-s-agents.md:2529`
   records the user's rule that a wrong guard refuses the tab's own `/clear`
   and that it is built only with a Windows box to test on (see §5, §7).
6. Secrets on Windows: one helper `services::private_file::restrict_to_owner`
   (icacls `/inheritance:r /grant:r "<user>:F"` through
   `paths::command_no_window`; no ACL helper exists anywhere in `src-tauri/`
   today — `rg -n "icacls|SetNamedSecurityInfo"` is empty) used by
   `mail_crypt::harden`, `mobile_control::store::write_bytes_atomic` and
   `storage::write_json_file`'s private branch. Failure to restrict is logged,
   not fatal (today it is silently nothing: `harden` and `write_bytes_atomic`
   both `let _ = mode` on non-unix).
7. Phone on a tmux-less host: the project detail payload carries
   `terminals: "tmux" | "unsupported"` beside its existing `shells` flag
   (`host.rs:1162`, TS `ProjectDetail` in `mobile-web/src/api.ts:138`); the
   phone hides ＋ tab, Schedule and markup Submit and shows one explanatory
   line. No new mobile API routes.
8. `tabtivity-send.ps1` reaches parity with the sh twin by construction, not
   by a new design: origin marker, lock, 1 GiB cap, kind line, same leaf
   names. (The `.tab` sender marker and the 24 MiB cap are already in the
   PS1.) A Rust string-level test asserts both scripts mention the same
   marker names.
9. CI: `test-windows` gets the same **staged** clippy step macOS has; the
   Windows findings are fixed locally first (shims) so the staged step is
   green from its first run. `test-macos` clippy stays staged (cannot run here).
10. Model: default. Implementer and reviewer per step; reviewer fixes
    confirmed bugs only.
11. Every step ends with all six gates green (`npm run build`, `npm test`,
    `cargo test`, `npm run lint`, `cargo clippy`, `scripts/brand-check.sh`)
    plus the Windows `cargo check`/`clippy` cross-check for steps touching
    `src-tauri/`, plus `git diff --check`, and a commit in the step's worktree.

## 3. Steps

### 3.1 Frontend: native Windows paths and script quoting (S×7 ≈ ½ day)

Files: `src/components/files/FileTree.tsx` (rename retarget 2842; the
`relPath.split("/")` sites at 1596/1682/1836/2907/3726/3756 operate on
**project-relative** paths the backend already slash-normalises — leave them),
`src/stores/tabs.ts` (`retargetTabs` 2927–2949),
`src/components/monitoring/DiskUsagePane.tsx` (`parentDir` 75–78, label 188),
`src/components/files/RenameDialog.tsx` (79–80),
`src/components/embed/deck/DeckView.tsx` (952, 1045, 1185 — `.split("/").pop()`
on absolute paths; 166–167 already `norm()`s, leave it),
`src/lib/terminal/pythonRun.ts` (`currentPlatform` 159–161),
`src/lib/terminal/shellScriptRun.ts` (`shellQuote` 14–16, `shellRunCommand`
54–62) + `FileTree.tsx:3139` (`shellRunnerFor(entry.extension, PLATFORM)`,
already platform-keyed — no change there).

- Replace `/`-only `lastIndexOf`/`split("/")` on **absolute native** paths
  with `dirname`/`basename` (decision 2). `retargetTabs` compares the old
  directory prefix with both separators (normalize both sides).
- `currentPlatform()` returns `IS_WINDOWS ? "windows" : "unix"` (today it
  sniffs `navigator.userAgent`; `IS_WINDOWS` prefers `navigator.platform`).
- `shellScriptRun`: `shellRunCommand` quotes with
  `pythonRun.shellQuote(scriptRel, "windows")` for the `powershell`/`cmd`
  interpreters (today both get POSIX `'…'`, which cmd does not strip) and
  keeps `'…'` for bash/zsh/fish/ksh. The script path stays the
  project-relative `scriptRel` the tab's cwd resolves — not a native absolute
  path.
- Fix the stale comment in `src/components/embed/deck/DeckPresenter.tsx:228–230`
  (`src-tauri/src/commands/presenter.rs:246–400` has `caffeinate` and
  `SetThreadExecutionState` twins; the "Linux-only … TODO V #121" sentence is
  wrong).

Tests (vitest): `src/__tests__/run/ShellScriptRun.test.ts` (fix the two
expectations that codify the broken form, add `C:\p\run.bat`), a new
`src/__tests__/files/WindowsPaths.test.ts` covering `parentDir`-style
helpers via the exported functions or small extracted helpers, `tabs.ts`
retarget with `C:\p\a.txt` → `C:\p\b.txt` and a directory rename.

Accept: all four fixed sites produce correct results for `C:\…` and `/…`
inputs; no new `any`; lint unchanged.

### 3.2 Terminal path links on Windows (M ≈ ½ day)

Files: `src/lib/terminal/pathLinks.ts` (`PATH_SHAPE` 40, `EXTENSION` 42,
leaf extraction 69–71), `src/__tests__/terminal/PathLinks.test.tsx`, and a
read of the backend `resolve_text_paths` (`src-tauri/src/commands/fs.rs:153`,
tests from 2501) to confirm it accepts `\` candidates; fix there only if it
rejects them.

- `PATH_SHAPE` accepts `[\\/]` separators and an optional `[A-Za-z]:`
  drive prefix; leaf and extension extraction use `basename`; candidates are
  `normalizePath`ed before `relativePathWithin`.
- Keep the Linux matches byte-identical (regression test with the existing
  fixture lines).

Accept: `src\a.ts:120`, `C:\Users\x\p\src\a.ts`, `.\src\a.ts` link; existing
POSIX fixtures unchanged.

### 3.3 Frontend wording and modifiers per platform (M ≈ 1 day)

Files: `src/lib/shortcuts/shortcuts.ts` (`chordLabel` 563–581 — already ⌘ on
mac), `src/lib/shortcuts/shortcutHint.ts` (`useChordHint`, which already
renders a rebindable action **or a literal `ChordDescriptor`** through
`chordLabel`, i.e. platform-resolved), `src/lib/i18n.ts` +
`src/lib/i18nDicts/{de,es,fr,it}.ts` (34 values carry a literal `Ctrl+`),
`src/components/embed/FileViewerPane.tsx` (337 `OPEN_MODIFIER`, 4771–4775
autocomplete hint), `src/components/monitoring/SystemMonitorPane.tsx:927`,
`src/components/layout/CopilotCompletionCard.tsx:124`,
`src/components/header/DevBuildIndicator.tsx:203–216` (`followLog`),
`src-tauri/src/commands/monitor.rs:14` (comment only).

- **No new `primaryModifierLabel()`**: a tooltip that names a key chord goes
  through the existing `useChordHint()(label, actionIdOrDescriptor)` — the
  rebindable ones by action id, the fixed ones (`Ctrl+Enter`, `Ctrl+G`,
  `Ctrl+D`, `Ctrl+Space`) as a literal descriptor. Only the *mouse* modifier
  ("Ctrl+click", "Ctrl+Shift+Tab cycles …" prose) needs a label: move
  `OPEN_MODIFIER` out of `FileViewerPane.tsx` into
  `shortcuts.ts` as `modifierLabel()` (⌘ on mac, Ctrl elsewhere) and give
  those strings a `{modifier}` parameter like `fileViewer.linkOpenHint`
  already has. Sweep the 34 `Ctrl+` values in `i18n.ts` (`rg -n "Ctrl\+"
  src/lib/i18n.ts`: 2344, 2596, 2736, 4548, 5586, 7670, 7763, 7989, 8224,
  8646, …) — English plus the four dictionaries; a key whose chord moves into
  a parameter loses the literal in all five files.
- Autocomplete hint strings name ⌥ on mac; handler unchanged.
- `sysmon.linuxOnly` → "The system monitor is not available on this system."
  (key rename to `sysmon.unavailable` in all five files; `sysstat::system_snapshot`
  answers `supported: false` on every non-Linux target, so the wording is
  the only change; refresh the `monitor.rs:14` comment to say so).
- Copilot card: `settings.copilotUnsupported` loses "for now". The install
  button is unreachable off Linux (`copilot_auth.rs:364` sets `supported`
  from `cfg!(target_os = "linux")`), so its `shellKind` stays `"bash"`; the
  backend port is §5.
- DevBuildIndicator "Follow log" is hidden when `IS_WINDOWS` (`tail -F` in a
  root-console shell; the dev build chain is bash-only).

Tests: extend `src/__tests__/shell/Shortcuts.test.ts` — `chordLabel` and
`modifierLabel` under mocked `IS_MAC`/`IS_WINDOWS`; the i18n parity test
(`src/__tests__/shell/i18n.test.ts`) stays green.

Accept: no literal "Ctrl+" remains in a tooltip whose handler accepts ⌘;
`npm run lint` warning count unchanged.

### 3.4 Phone on a tmux-less (Windows) host (S+S ≈ ½ day)

Files: `src-tauri/src/services/mobile_control/discovery.rs` (822–836
`live_tmux`, which already answers an empty map on Windows; 846
`shells_open`), `src-tauri/src/services/mobile_control/host.rs:1162` (the
project-detail JSON that carries `"shells"`; 120–131 the `(not(unix))` spawn
refusal), `mobile-web/src/api.ts:138` (`ProjectDetail`),
`mobile-web/src/screens/Project.tsx` (153–155 the ＋ sheet, 147–149 the
Schedule sheet, 353–358 `markupNewTab`), held prompts
(`rg -n "held" mobile-web/src/screens/Terminal.tsx | head`), the `mobile.*`
keys in `src/lib/i18n.ts` + four dicts, tests beside
`src/__tests__/mobile/MobileProjectScreen.test.tsx` /
`MobileNewTabSheet.test.tsx` / `MobileProjectSchedule.test.tsx` /
`MobileMarkupNewTab.test.tsx`.

- The project-detail payload carries `terminals: "tmux" | "unsupported"`
  from a cfg-free `terminals_support() -> &'static str` in `discovery.rs`
  (next to `shells_open`; `unsupported` when `cfg!(target_os = "windows")`,
  the same predicate `live_tmux` uses). `protocol.rs` is **not** touched —
  the detail payload is built as `json!` in `host.rs`.
- Phone: when unsupported, hide ＋ tab, Schedule, held-prompt sending and
  the markup `markupNewTab` Submit; show one line
  (`mobile.project.terminalsUnsupported`) with the same meaning as the
  desktop's `mobile.windowsTerminalsNote` (`i18n.ts:1520`). Absent field ⇒
  `tmux` (an older desktop).
- Backlog: tick nothing; under `todo/group-h-crossplatform.md:730–731`
  ("Phone-side 'no terminals on Windows' copy") add the 🤖 automated line
  (ticked, naming the test) and the 🖐️ line with the four platform child
  pairs (none ticked); the pill id `mobile.project.terminalsUnsupported`
  gets its `src/lib/untested.ts` row.

Tests: Rust test that the detail JSON carries the field (both values, by
calling `terminals_support` and a serialisation of the row); vitest for the
Project screen with `terminals: "unsupported"` (＋ / Schedule / Submit
absent, line present) and with the field absent (unchanged). `npm run
mobile:bundle` (exists in `package.json:11`) must stay green — run it, the
PWA is baked in.

### 3.5 Shipped scripts: `tabtivity-send.ps1` parity, phone install without jq (M+S ≈ 1 day)

Files: `scripts/tabtivity-send.ps1` (84 lines; vs `scripts/tabtivity-send.sh:28–36`
lock, `51–118` origin/size/kind), `scripts/install_phone.sh:24–40` (`jq`
gate + three `jq` reads), `src-tauri/src/services/agent_bin.rs` (tests from
~110; the sh copy is asserted byte-equal at 115),
`src-tauri/src/services/mobile_control/outbox.rs` (10–19 and 214–217 for the
marker names; no change expected).
`src/components/mobile/MobileSettings.tsx:380–390` is already right
(PowerShell on Windows, bash elsewhere) — no change.

- PS1 (what it lacks today — the `.tab` sender marker, 24 MiB cap and
  symlink refusal are already there): `.<leaf>.src` origin marker (the
  source's `[IO.Path]::GetFullPath` with the `$root` prefix stripped —
  **not** `[IO.Path]::GetRelativePath`, which Windows PowerShell 5.1's .NET
  Framework lacks; empty for a file outside the project or under
  `.tabtivity/`, mirroring `origin_of`); a lock (the
  `.send-lock` directory created with `New-Item -ItemType Directory` as the
  mutex, exit 5 + the sh twin's message when it exists, removed in
  `finally`); the 1 GiB outbox sum check (exit 5, same message); the leaf
  collision loop also checks `.<leaf>.src`; the kind line by magic bytes
  (PNG/JPEG/GIF/WebP → "shown as an image", `%PDF-` → "opens as a PDF", else
  the sh twin's remaining branches — copy its exact `report` strings).
- `install_phone.sh`: drop the hard `jq` requirement — parse with `python3`
  when present (stock on macOS), `jq` otherwise, else fail with a one-line
  `brew install jq` hint. Keep bash-3.2 safe (no associative arrays, no
  `${var,,}`).
- Rust test (in `agent_bin.rs`, beside the existing byte-equality test):
  both send scripts contain the same marker leaf shapes (`.tab`, `.src`,
  `.send-lock`), the same byte caps (`25165824`, `1073741824`) and the same
  user-facing message table (string-level parity, like
  `agent_session::powershell_twin_covers_every_shape`).

Accept: parity test green; `bash -n scripts/install_phone.sh`; PowerShell
syntax cannot be checked here — reviewer reads it line by line against the
sh twin. `scripts/brand-check.sh` stays green (both files are allowlisted).

### 3.6 Nested-`claude` guard for the macOS hook (M ≈ ½–1 day)

Files: `src-tauri/src/services/agent_session.rs` (`posix_hook_script_body`
1946, the `/proc` walk 1998–2003, `hook_script_body` 1935/2066, tests
`hook_script_refuses_a_clear_or_resume_from_a_claude_nested_under_the_tabs`
3180 and `run_hook` 2996), `todo/group-s-agents.md:2529–2550`.

- sh: when `$proc_root/$p/environ` is unreadable, walk with
  `ps -o ppid= -p $p` and read the environment with `ps -E -o command= -p $p`
  (macOS, same uid; grep for `[A-Z]*_TAB_UID=<uid>` exactly as the `/proc`
  branch does) — count `claude` by `ps -o comm=`. Linux branch unchanged.
  The script comment's "Without /proc nothing is counted and the start is
  taken" sentence is updated.
- **No PowerShell change** (decision 5): the Windows walk stays the backlog
  item it is, with the user's "only with a Windows box" rule.
- Testability without an environment variable: `posix_hook_script_body`
  keeps its signature and delegates to `posix_hook_script_body_with(live_dir,
  proc_root)` with `/proc` baked in by the production caller — the hook runs
  under the agent's environment, so a `PROC_ROOT` **env var** would be one
  more thing a project could set; a baked literal is not. The existing hook
  tests `env_clear()` and set `PATH` explicitly, so the new test writes the
  body with `proc_root = <empty temp dir>`, prepends a temp `bin/` holding a
  `ps` shim that answers a scripted parent chain from a file, and asserts
  the nested start is refused and the tab's own is taken on the fallback
  branch. The existing test keeps the `/proc` default and stays byte-for-byte
  unchanged.
- Backlog: nothing ticked in `todo/group-s-agents.md`; add a 🖐️ line for the
  macOS fallback under it (four platform child pairs, none ticked).

Accept: Linux behaviour byte-identical (the generated script differs from
today's only by the `proc_root` literal and the fallback branch, which Linux
never enters while `/proc` is readable); new test covers the fallback.

### 3.7 Backend Windows: installer home, trusted helpers, symlinks, private files (M×3+S ≈ 1–1.5 days)

Files: `src-tauri/src/commands/agents.rs` (803–842 `installer_command`,
850 `agent_install_path`, 66 `windows_shell_kind`),
`src-tauri/src/services/agent_install.rs` (32 `install_env_in`, 52
`bin_dirs_in`, test 165), `src-tauri/src/paths.rs` (121–134
`system_executable`, 140–146 `helper_program`, `first_trusted_in` /
`root_owned_file` above them), `src-tauri/src/commands/project_transfer.rs:1183–1191`
(`make_symlink`), `src-tauri/src/commands/boxes.rs:459–495` (the Windows
junction `make_member_link` / `remove_member_link`), new
`src-tauri/src/services/private_file.rs`, `src-tauri/src/services/mail_crypt.rs:567–577`
(`harden`), `src-tauri/src/services/mobile_control/store.rs` (19–22
`write_bytes_atomic`, 69–72 the `not(unix)` `ensure_private_file`),
`src-tauri/src/storage.rs:40–43` (private-file create), `docs/filemap_backend.md`
(one row for the new module, in the `services/` table next to `mail_attach.rs`).

- `installer_command` Windows branch applies `install_root()` (create it),
  `install_env()` and `PATH` from `agent_install_path()` exactly as the
  `not(windows)` branch does today, through both the PowerShell and the cmd
  spawn. `install_env_in` gains, on Windows only, `USERPROFILE` and
  `APPDATA` pointing into the install home (npm's global prefix on Windows is
  `%APPDATA%\npm` unless `NPM_CONFIG_PREFIX` is set — it is, so the npm
  launcher dir is `<prefix>` itself, not `<prefix>/bin`); `bin_dirs_in` adds
  `npm` (the prefix root) and `.bun/bin` already there. Pure core:
  `install_env_for(windows: bool, state_dir)` tested on Linux for both values
  (extend test 165).
- `system_executable` Windows twin: candidates `%ProgramFiles%\Git\cmd`,
  `%ProgramFiles%\Git\bin`, `%SystemRoot%\System32\OpenSSH`,
  `%SystemRoot%\System32`; accept only when the file's owner is
  Administrators/SYSTEM/TrustedInstaller and no user-writable ACE exists.
  `Cargo.toml` already enables `Win32_Security` and `Win32_Storage_FileSystem`
  for the `windows` crate; `GetNamedSecurityInfoW` lives in
  `Win32_Security_Authorization`, which is **not** enabled — prefer `icacls
  "<path>"` output parsed by a pure `windows_acl_is_locked(&str) -> bool`
  with a sample-text test over adding a crate feature. Fall back to `None`
  (today's behaviour) when the check cannot be made, never to "trusted".
- `make_symlink` Windows: resolve `target` against `at.parent()`; directory
  → `symlink_dir`, else `symlink_file`; on `ERROR_PRIVILEGE_NOT_HELD`
  (os error 1314) for a directory fall back to a junction. `boxes.rs`'s
  junction code is private to that module and shells out to `cmd /c mklink
  /J`: lift it into `services::private_file`'s sibling or a small
  `services::win_links` (one `make_junction(target, at)` used by both; one
  filemap row) rather than a copy.
- `private_file::restrict_to_owner(path)` (decision 6) used by `harden`,
  `write_bytes_atomic` and `storage.rs`'s private create; the unix path keeps
  chmod. `ensure_private_file`'s Windows arm may stay `Ok(())` (verifying an
  ACL is a second parser — out of scope) but says so in its comment.

Tests: pure cores on Linux (`install_env_for`, `windows_acl_is_locked`,
`icacls` sample text); `cargo check` + `clippy` for the Windows target must
pass; `cargo test` on Linux unchanged.

### 3.8 Backend macOS fence: one-shot command for the agent push preflight (S–M ≈ ½ day, read-verified only)

Files: `src-tauri/src/services/agent_fence.rs` (1453 `sandbox_exec_profile`
— **already** a pure `SeatbeltInputs -> String` under `cfg(any(macos, test))`;
1489 `sandbox_exec_inputs`; 1561–1620 `wrap_pty_options_sandbox_exec`;
1767–1804 `one_shot_command`), `src-tauri/src/services/git_push_mcp.rs:552–562`.

- No profile factoring is needed. Add a `cfg(target_os = "macos")`
  `one_shot_command` beside the Linux one that builds a **narrower**
  `SeatbeltInputs` directly (roots from `roots_for_scope`, `readable` from
  `configured_read_only_paths()`, `protected` from
  `git_guard::guard_paths(&roots, Some(cwd))`, `hidden` = the state dir and
  the Cargo credential paths, `own_home: None`, `home` from
  `paths::home_dir_string()`), writes it to the scope's `sandbox::stage_dir`
  as `preflight.sb`, and returns `/usr/bin/sandbox-exec -f <profile> <cmd>
  <args>` in `cwd` with `AGENT_FENCE=1`. Fail closed when `bwrap_available()`
  (which on macOS means "sandbox-exec works", 691–703) is false, with the
  same `fence_unavailable_message()`. The `not(linux)` fallback becomes
  `not(any(linux, macos))`.
- Factor the inputs builder so the one-shot path and the PTY path share one
  function for the parts they have in common (`one_shot_inputs(scope_id, cwd)`
  vs `sandbox_exec_inputs(opts, …)`) only if that is a pure move; otherwise
  leave `sandbox_exec_inputs` alone.
- `live_unfenced_by_scope` on macOS: **dropped**. `sandbox-exec` applies the
  profile and `exec`s the target, so the agent process's argv0 is the agent,
  not `sandbox-exec`; the honest check (`sandbox_check(pid)` from
  libsandbox) is new FFI that cannot be compiled here → §5. The documented
  "empty = unknown" stays.
- `git_push_mcp.rs:552–562`: the `FenceUnavailable` message no longer says
  "sandbox-exec is unavailable" when `one_shot_command` refused for another
  reason — pass the fence's own error text through (it already does:
  `{e}`), and reword the Windows `PreflightFailed` sentence only if it names
  the wrong platform (it does not; leave it).

Tests: on Linux under `cfg(test)`, the one-shot `SeatbeltInputs` → profile
contains the roots as `file-write*` allows, the guard paths as denies, the
state dir as a hidden deny and no `own_home` allow; the PTY fixture's
profile keeps its `own_home` line. macOS compile is CI-only: keep the
`cfg(macos)` code tiny and mirror the imports `wrap_pty_options_sandbox_exec`
uses.

### 3.9 Backend small twins: LAN identity, dev-build chip, Ollama wording (S×3 ≈ ½ day)

Files: `src-tauri/src/commands/workspace.rs:503–521` (`network_identity_blocking`;
`wifi_ssid_macos` 438–449 already runs `route -n get default` and reads its
`interface:` line; `gateway_id_of`, `parse_proc_default_gateway`,
`parse_proc_arp_mac` beside it), `src-tauri/src/services/dev_build.rs` (230
`lock_holder_alive`, 251 `own_exe`, 465 `spawn_relauncher`),
`src-tauri/src/commands/ollama.rs:1236–1239`, `src-tauri/src/commands/apps.rs:2164`
(`pid_alive`, already portable: `/proc` on Linux, `OpenProcess` on Windows).

- Gateway id: pure parsers `gateway_from_route_print(&str)`, `mac_from_arp_a(&str)`
  (Windows, `route print -4` / `arp -a`), `gateway_from_route_get(&str)`
  (macOS — the `gateway:` line of the `route -n get default` output
  `wifi_ssid_macos` already reads; share the one spawn), `mac_from_arp_n(&str)`
  (`arp -n <ip>`), through `probe_output_capped`; same `gateway_id_of`
  hashing as Linux. Tests on captured sample output for both shapes. The
  `NetworkIdentity.gateway_ip` doc comment ("only on Linux") is updated.
- `dev_build.rs`: `lock_holder_alive` via `crate::commands::apps::pid_alive`;
  `own_exe` via `std::env::current_exe()` with the Linux ` (deleted)`
  detection kept behind `cfg(target_os = "linux")`; `spawn_relauncher`
  returns a worded "dev relaunch is Linux-only" error on other targets before
  touching `sh`.
- Ollama non-Linux message (`remove_blob_files_elevated`): say the blobs
  belong to another account / are locked, not "the Ollama service".

Accept: Linux `cargo test` unchanged; new parser tests; Windows cross-check.

### 3.10 Backend macOS: background-job tabs (M ≈ ½ day, read-verified only)

Files: `src-tauri/src/services/agent_turn.rs` (443–485 `tool_shell_uids`,
421–422 `environ_uid` under `cfg(any(linux, test))`),
`src-tauri/src/sysstat.rs` (one file, no `services/sysstat/` directory: the
macOS backend's `parent_map` 1746, `ppid` 1813, `cmdline` 1824, the raw
`KERN_PROCARGS2` sysctl read at ~2180–2216, and `parse_procargs2` 1448, which
**deliberately drops the environment** — see its doc comment and the test
`procargs2_yields_argv_without_the_environment`).

- macOS twin of `tool_shell_uids` from `sysstat::parent_map()` +
  `sysstat::cmdline()` for the comm/parent-comm checks, and the tab uid from
  the environment part of the `KERN_PROCARGS2` buffer: split the sysctl read
  into a `pub(crate) fn procargs2_raw(pid) -> Option<Vec<u8>>` that
  `cmdline` keeps using, and a pure `procargs2_env(&[u8]) -> &[u8]` (the
  bytes after `argc` NUL-terminated argv strings) that `agent_turn` feeds to
  `environ_uid` (`environ_uid` becomes `cfg(any(linux, macos, test))`).
  `agent_turn` reads only the `*_TAB_UID=` match, never surfaces the
  environment — say so in the comment, since `parse_procargs2`'s comment is
  the rule that the monitor must not read it. Windows stays empty with a
  comment (no env block reader).
- `procargs2_env` tested on Linux with a crafted buffer (reuse the fixture of
  `procargs2_yields_argv_without_the_environment`).

### 3.11 Backend Windows: agent mail attachments through the handle-based walk (M ≈ ½–1 day)

Files: `src-tauri/src/services/mail_attach.rs` (47 `WINDOWS_REFUSED`,
225/260–262 the `not(linux|macos)` arm, 277–333 `read_under`, 334 the unix
helpers, tests from 353), `src-tauri/src/services/mobile_control/files_windows.rs`
(`ProjectDir` is `pub(in crate::services::mobile_control)`, 52; `open` 55,
`open_root` 69, `child_dir` 240, `open_file` 248).

- `read_under` on Windows opens through `files_windows::ProjectDir` —
  `open_root(root)` then `child_dir` per component and `open_file` for the
  leaf (reparse points refused, root re-proved by the handle). `ProjectDir`
  and those three methods widen from `pub(in crate::services::mobile_control)`
  to `pub(crate)` (or `mobile_control` exposes one
  `pub(crate) fn read_project_file(root, parts, max) -> io::Result<Vec<u8>>`
  wrapper — pick the smaller diff). The size cap and the `Miss` mapping stay
  shared with the unix arm.
- `WINDOWS_REFUSED` is used only inside `mail_attach.rs` (no frontend string
  — `rg -n WINDOWS_REFUSED src` is empty): delete the constant with its arm.
- The boundary tests at 353+ are `cfg(linux|macos)`; add the Windows arm's
  cfg-free decision core (component validation before I/O) to the same list.

### 3.12 CI: Windows clippy, staged (S ≈ ¼ day + fixing what it prints)

Files: `.github/workflows/ci-cd.yml` (132–176 lint, 223–255 test-windows,
293–298 macOS staged clippy).

- Run the Windows-target clippy locally first (§1) and fix every finding in
  the cfg(windows) arms (do this **last**, after 3.7–3.11 landed, so it lints
  the new arms too).
- Add `components: clippy` + a `Lint backend (clippy, staged)` step to
  `test-windows`, `continue-on-error: true`, same wording as macOS.

Accept: local Windows clippy at zero warnings; workflow YAML validated by
`python3 -c 'import yaml,sys;yaml.safe_load(open(sys.argv[1]))' .github/workflows/ci-cd.yml`
(PyYAML 6.0.3 is installed here; the repo has no YAML linter of its own and
a fenced tab may not reach npm, so do not rely on `npx --yes yaml-lint`).

## 4. Agent steps

| Agent step | Plan sections | Files (main) | Est. |
|---|---|---|---|
| A1 | 3.1 + 3.2 | FileTree.tsx, tabs.ts, DiskUsagePane.tsx, RenameDialog.tsx, DeckView.tsx, pythonRun.ts, shellScriptRun.ts, pathLinks.ts + tests | 1 day |
| A2 | 3.3 | shortcuts.ts, shortcutHint.ts, i18n.ts + 4 dicts, FileViewerPane.tsx, SystemMonitorPane.tsx, CopilotCompletionCard.tsx, DevBuildIndicator.tsx | 1 day |
| A3 | 3.4 | discovery.rs, host.rs, mobile-web api.ts + Project.tsx (+ Terminal.tsx held prompts), i18n.ts + 4 dicts, untested.ts, group-h todo + tests | ½–1 day |
| A4 | 3.5 | tabtivity-send.ps1, install_phone.sh, agent_bin.rs test | 1 day |
| A5 | 3.6 + 3.9 | agent_session.rs (+ tests), workspace.rs, dev_build.rs, ollama.rs, todo/group-s-agents.md | 1–1.5 days |
| A6 | 3.7 | agents.rs, agent_install.rs, paths.rs, project_transfer.rs, boxes.rs (junction lift), private_file.rs (new), mail_crypt.rs, store.rs, storage.rs, filemap rows | 1.5 days |
| A7 | 3.8 + 3.10 | agent_fence.rs, git_push_mcp.rs, agent_turn.rs, sysstat.rs | 1 day |
| A8 | 3.11 | mail_attach.rs, files_windows.rs | ½–1 day |
| A9 | 3.12 | ci-cd.yml + any cfg(windows) clippy fixes across the tree | ½ day |

Order: A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 (A9 last on purpose;
A3/A4 and A7/A8 touch disjoint files and may run in parallel worktrees). Each agent
works in its own worktree off the current `develop` tip and rebases onto the
previous step's result; the main agent lands each step before the next.

## 5. Not in this plan (hardware or product decisions)

- macOS deny-default Seatbelt (`docs/agent_fence_cross_os_plan.md` §5): needs
  a Mac to iterate the profile.
- Windows sandbox-account fence (§4 of the same plan): documented refusal.
- Copilot language server on macOS/Windows (#45a backend): fence design
  per platform; needs hardware for the auth path.
- Reader shell line on macOS (`agent_transcript::running_outputs`, libproc
  fd listing): new FFI that cannot be compiled here.
- `ui_priority` twins: measure first per `docs/performance_plan.md`.
- NSIS old-install removal + WebView2/WebKit data copy for the rename
  upgrade (`todo/group-y-verification.md` 168): paths unknown, needs hardware.
- macOS ssh-link counters via `nettop` (31f): CSV shape unconfirmed.
- Code signing / notarization (`.exe`, `.dmg`): repo secrets + Apple account.
- VM projects phase 6 (macOS/Windows backends).
- The 32z deferred list (`todo/group-h-crossplatform.md:715–741`): each needs
  hardware or a product call.
- The ~559 🖐️ items with unticked Windows/macOS children: verification, not
  code; nothing to tick without hardware.
- Nested-`claude` guard in the **PowerShell** hook (`todo/group-s-agents.md:2529`):
  the backlog records the user's rule to build it only with a Windows box
  (a wrong guard refuses the tab's own `/clear`).
- macOS live-unfenced classification (`agent_fence::live_unfenced_by_scope`):
  needs `sandbox_check()` FFI; `sandbox-exec` execs the target so there is no
  process to spot by name.
- Verifying (not just setting) Windows ACLs in `ensure_private_file`: a
  second parser; the set side lands in 3.7.

## 6. Verification (user, on hardware; nothing to launch here)

Windows:
1. Project files: rename an open text file → the viewer tab follows; right-click
   a file in Disk usage → "Open terminal here" lands in its folder.
2. Drop a `run.bat` and a `run.ps1` into a project, press ▶ on each → runs.
3. Let a Claude tab print `src\lib\x.ts:10` → it is a link.
4. Settings → Manage CLIs → install Codex → it lands under the Tabtivity
   state dir, not `%APPDATA%\npm`.
5. Phone: open a project → no ＋ / Schedule; one line explains why.
6. From an agent tab: `tabtivity-send some\file.pdf` → the phone opens the
   project file (not a copy); a second send while one runs waits.

macOS:
1. Fenced Claude tab in a repo with a pre-push hook → agent `git_push`
   succeeds (hook ran under sandbox-exec).
2. In a Claude tab's Bash tool run `claude -p --resume <other>` → the tab's
   Reader does not switch (the `ps -E` fallback; on Windows this stays the
   known gap, see §5).
3. Wired Mac: set a default printer for this network → it sticks per gateway.
4. Tooltips show ⌘, not Ctrl.

## 7. Plan review (2026-10-07)

Checked every §3 path and line against the tree (`rg`/`sed`); edits above.
One line per decision:

- §1: both MSVC shims exist (`ls`); `npm run mobile:bundle` exists
  (`package.json:11`); no YAML linter in the repo, PyYAML 6.0.3 is installed
  → 3.12 names only the `python3` validator. Added the i18n parity test by
  name (`src/__tests__/shell/i18n.test.ts`) and the fact that the phone has
  no dictionary of its own (plan said `mobile-web/src/i18n*`, which does not
  exist). Added the untested-register test and the exact 🖐️ child shape.
  Added how the send scripts get their name (allowlisted file names; the
  agent-home copy is named by `brand::SEND_CLI` / `app_slug!()` at write
  time).
- Decision 3: verified `pythonRun.shellQuote(arg, "windows")` does `""`
  doubling (`pythonRun.ts:57–58`).
- Decision 5 / 3.6: dropped the PowerShell `Win32_Process` walk. The
  backlog entry (`group-s-agents.md:2529–2550`) records the user's rule
  "build it only with a Windows box to test on" because a wrong guard refuses
  the tab's own `/clear`; moved to §5. If the user overrules, the backlog
  entry already specifies the design (stop at the app's own exe name).
- 3.6: `PROC_ROOT` env var replaced by a baked `proc_root` parameter of a
  new `posix_hook_script_body_with`: the hook runs under the agent's
  environment and an env var is one more knob a project could set; a baked
  literal keeps Linux byte-identical and the existing tests (`env_clear()`,
  explicit `PATH`) untouched.
- Decision 6 / 3.7: no ACL helper exists anywhere (`icacls`,
  `SetNamedSecurityInfo`, `GetNamedSecurityInfo` — zero hits); `storage.rs`'s
  private create is a third caller that today does nothing off unix — added.
  `Win32_Security_Authorization` is not among the enabled `windows` crate
  features → plan prefers `icacls` text parsing over a new feature.
- 3.7: `boxes.rs` has a junction helper, but private (`make_member_link`,
  `cmd /c mklink /J`): the plan now lifts it into a shared module instead of
  "use the helper it has". npm on Windows puts launchers in `<prefix>` not
  `<prefix>/bin` — written into the bullet.
- 3.3: `src/lib/shortcuts.ts` does not exist; it is
  `src/lib/shortcuts/shortcuts.ts`, and `src/lib/shortcuts/shortcutHint.ts`
  already provides `useChordHint(label, action | ChordDescriptor)` that
  renders ⌘ on mac for fixed chords too. Dropped the proposed
  `primaryModifierLabel()`/`metaLabel()` (a duplicate); kept one
  `modifierLabel()` for the mouse-modifier prose, lifted from the existing
  `OPEN_MODIFIER` (the only `IS_MAC ? "⌘"` site). Copilot `shellKind` change
  dropped: the install button is unreachable off Linux
  (`copilot_auth.rs:364`).
- 3.1: `shellRunCommand` runs the project-relative `scriptRel`, not a native
  absolute path — bullet corrected; the `split("/")` sites in `FileTree.tsx`
  act on backend-normalised relative paths and are excluded.
- 3.4: `protocol.rs` has no catalog/scope struct; the phone's project detail
  is `json!` in `host.rs:1162` (`"shells"`), `Catalog` in `discovery.rs:375`
  is `projects: Vec<ResolvedProject>`. Field moved to the detail payload;
  `live_tmux` already short-circuits on Windows. Test file names given.
- 3.5: the PS1 already has the `.tab` marker, the 24 MiB cap and the symlink
  refusal; what is missing is listed precisely. `install_phone.sh` gate is at
  line 24, not 25. `MobileSettings.tsx:380–390` already does the right thing
  — removed from the step.
- 3.8: `sandbox_exec_profile(&SeatbeltInputs)` is already a pure function
  under `cfg(any(macos, test))` (`agent_fence.rs:1453`) — "factor out"
  deleted; the step is now only the macOS `one_shot_command` built on it.
  macOS `live_unfenced_by_scope` dropped (sandbox-exec execs the target; no
  argv0 to match; `sandbox_check` is new FFI) → §5. `git_push_mcp` already
  passes the fence's error text through; bullet reduced to a wording check.
- 3.9: `commands::apps::pid_alive` exists and is portable (`apps.rs:2164`);
  `wifi_ssid_macos` already spawns `route -n get default` — the gateway
  parser shares that spawn. Line numbers corrected (503, 230/251/465).
- 3.10: `sysstat` is one file (`src-tauri/src/sysstat.rs`), not a
  `services/sysstat/` directory; `parent_map`/`ppid`/`cmdline` exist for
  macOS (1746/1813/1824). `parse_procargs2` drops the environment on purpose
  (comment + test): the plan now splits the raw sysctl read and adds a
  separate env slice reader that only ever feeds `environ_uid`.
- 3.11: `files_windows::ProjectDir` is `pub(in mobile_control)` with `open`,
  `open_root`, `child_dir`, `open_file` — not reachable from `mail_attach`
  without widening; bullet says so. `WINDOWS_REFUSED` has no frontend
  consumer (verified) — delete, not "if nothing else uses it".
- 3.12: line ranges verified (lint 132–176, test-windows 223–256, macOS staged
  clippy 293–298).
- §4: A3 (3.4 + 3.5) split into A3/A4 — two subsystems (mobile backend +
  PWA vs. shipped scripts) with disjoint files; A6 (3.8 + 3.10 + 3.11) split
  into A7 (fence + agent_turn/sysstat, both macOS) and A8 (mail_attach +
  files_windows, Windows). Nine steps; parallelisable pairs named.
- §5: three entries added (PowerShell guard, macOS live-unfenced, ACL
  verification).
- Invariants: no step spells the brand (scripts are allowlisted or source
  `brand.sh`; Rust uses `app_slug!`); no `services/` module gains an
  `AppHandle`; nothing new runs project code (the preflight hook in 3.8 runs
  inside the fence, as on Linux; `exec_trust` unchanged); 3.8 fails closed
  (`bwrap_available()` false → refusal, never unfenced); remoteness is not
  inferred anywhere (all steps are host-local).

### Blocking

- None. (If the user wants the PowerShell nested-`claude` walk built now
  despite the `group-s-agents.md:2529` rule, re-add it to 3.6 / A5 with the
  backlog's design; it would add ~½ day.)

### Not verifiable here

- macOS `ps -E -o command=` printing the environment for same-uid processes
  under a sandbox-exec profile; `[IO.Path]::GetRelativePath` availability in
  Windows PowerShell 5.1 (it is .NET Core 2.0+ — on 5.1 the PS1 must compute
  the relative path by prefix stripping of `[IO.Path]::GetFullPath`; the
  implementer should use the prefix form); every `cfg(macos)` arm's
  compilation.
