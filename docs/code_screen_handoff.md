# Code screen 2026-10-25 — handoff

Plan `docs/code_screen_plan.md`, base 312ffb7b. [n] = handoff step (1=A1, 2=A2, 3=A3, 4=C1, 5=C2, 6=B1, 7=B2, 8=D1, 9=D2, 10=D3, 11=D4, 12=E+G). Develop shas matched by subject. Nothing run live. [F] = final review.

## Status

- [1] A1 — ba3fed51, eeb1de4a, 1e90e180: all 11 items (no-follow non-blocking `.gitignore`/`project.json`/`.git` access, `safe_relative`, skills copy, detach order) plus agent-doc reads and `read_tree_json` siblings. +16 tests.
- [2] A2 — f6e1f42c, 649ea7e7, 16cb650d: `git_bounded::run` for git_push_mcp/markup_rounds, absolute pkexec/openvpn, rsync/docker quoting, `random_hex`; siblings ollama `pkexec rm`, macOS `sudo`.
- [3] A3 — 24aa3029, 5eeb4d67, aa5e8d8c: git_peer backups before moves, `starts_with("??")`, five registries on `patch_json`, atomic private writes (agent_auth, markup round, dev_todo, tmux launcher, Windows token). aa5e8d8c (main-agent fix after the verifier): an empty store file patches from the default instead of failing every later patch; dev_todo keeps the tracked file's mode instead of 0600.
- [4] C1 — db7c7998: failed store loads keep data, load/upsert races, phone hardening. No handoff file.
- [5] C2 — 8503ac1a, 057bbb71 (docs): Escape guard, Windows rename, in-app confirms, runWithProgress, stale guards, i18n, cross-window appearance. No handoff file.
- [6] B1 — b284c873, 1d4d3c53: blocking project/fs/git commands on workers; extend/detach split in two halves around the host-state clear; review moved 17 siblings.
- [7] B2 — 03b0ec50, 56e2d325, 5c8f7363: Ollama off async workers, registry curl -> reqwest `registry_get`, lockstep ops via `off_worker`, manifest lock not held across await, create-only branch create and CAS fast-forward, owner-gate test made deterministic.
- [8] D1 — 5da9be85: `proc_table::pid_state`, `git_bounded::run` for printing/workspace/tex, `spawn_reaped_then`, `commands::git::stdout`, shared `teardown_with`, `binary_on_path`, one `gsettings_get`.
- [10] D3 — 78adee0b, 17944d1e (docs): listener helper sweep, `ContextMenuPortal`, `useOpenVpn`, Ollama activity store, `usePaneRects`/`useDividerDrag`.
- [11] D4 — 9b399215, 30932867, 03cefb86, 067b986b, e58bee68, 0cfe7ccb, 6f9b6f6e, f0ad6a65 (docs), 195c10f7: bytes/worked-time/age, `escapeHtml`, ANSI strip, `lib/paths`, `useVisiblePoll`, `lib/persist`, phone copies -> `shared/`, `ROOT_SCOPE`, `translateNow`. 195c10f7 (main-agent fix): the implementer's abort-on-every-tick meant a read slower than the interval never finished; a tick now skips an in-flight read until it is older than two intervals, `now()` still starts afresh.
- [9] D2 — f11a6d23, dbbc28d7, 36ab2be6 (docs): `digest::hex`, `floor_char_boundary` clip loops (+8 siblings), chrono `iso_now` keeping `+00:00` (round-trip test for both forms), `clock::now_secs`; one cached `services::remote::projects()`/`project_entry(id)` (path-keyed, files < 100 ms old not cached); `test_util::git` fixtures.
- [12] E+G — 67dcfc85: every listed dead export deleted; ESLint guards (plugin-dialog confirm/ask/message, bare `listen(`, `split("/").pop()`/`lastIndexOf("/")` in components; 7 sites moved to `basename`/`dirname`); Rust scans: guarded project files, read-default-then-write, sync commands across all of `commands/`. Skipped: lib/stores-may-not-import-components (17+ imports, needs S3).
- [F] final review — 694014c5 (TeX timeout keeps its partial log, `keep_on_timeout`), dd4c0991 (corrupt box links manifest refused), 7176ef1d (format/export previews on the blocking pool + scan against `command(async)` on sync fns), 243da9fc (`detect_mime` removed, commandClasses regenerated), dbe9f56b (orphan PDF screenshot-capture listener), 42f306fd (corrupt `projects.json` no longer empties every box), 454e5e58 (session migration postponed, not skipped, on an unreadable registry), 2058be5c (filemap), 4f0d2471, ac5af8c2 (DST-proof todo date test), 3570ef19 (listen guard back on FileViewerPane except one line).
- Not screen steps: 78f3bc99, 434b0cfa, f657ae2f, b31793c1, f1805619, ff0341e6, b633b1a3, 945a878d, 45a7967c, version bumps (other sessions).

Dropped:
- [1][2][3][6][7]: none.
- [8] agents.rs warm-up not on `git_bounded::run` (returns the pid synchronously); its deadline now reaps the subtree. `apps.rs watch_child_exit` left.
- [10] `LocalModelsPage.tsx:189` (tested listen-rejection), module-singleton listeners in `stores/*`/`lib/*`, `detachedDropTargets.ts`, window-drag `onMoved`, `resolveTarget` merge (the two differ materially).
- [11] `ProjectBlobPane.fmtWorked`, `TabHoverCard.formatQuiet`, `reloadGrace.ts`, `todoDates.moveAccepted` vs `dropAccepted`, `CenterPanel.tsx:254`, dead `acceptedColumns` (E).

## Review fixes

- [1] A linked/FIFO `.gitignore` failed scaffold repair and the whole migration plan; now left alone. `scaffold_is_missing_at` read dangling links as "missing" forever; lstat-based (`claude_settings_present`). Misplaced doc comment restored.
- [1] A committed `.tabtivity -> X` redirected `filetabs/layout/state/windows/terminals.json`; now written through held handles (`open_app_sessions_dirs`, `write_json_in`).
- [1] Other `project.json`/session-file reads followed links or hung on a FIFO; all on `read_tree_json`.
- [1] A regular `project.json` over 64 MB was read as blank and truncated on import (data loss); now an error before any write. `extend_project_to_remote` read `project.json` after its side effects; reordered.
- [2] A legit pre-push hook printing > 4 MiB was refused; `Opts::keep_stdout_ends` drains and keeps head and tail.
- [2] rsync glob-expands its source even with `-s`; `rsync_literal_host_path` escapes only segments holding `*?[` (finder's whole-path escape broke `x]y/c[1]`).
- [2] macOS `osascript` was spawned by bare name; now `/usr/bin/osascript`. `rsync -e` quoting `'\''` ran ssh with a different ControlPath; `rsync_e_quote` doubles `'`. Real-rsync tests gated on rsync >= 3; 256 MiB test shrunk.
- [3] Registries lost the owner-only DACL on Windows via `patch_json`; new opt-in `storage::patch_private_json`.
- [3] `skills list_sources`, `save_side_panel_folder`, ollama `mark_pending_pull`, git_peer `save_state` replaced unparsable files with defaults; now error and leave the file.
- [3] Tag create was not a CAS and counted applied on failure; `create_tag` is create-only, failure is `blocked`.
- [6] Concurrent "disable git" clicks failed halfway on workers (toggle mutex); concurrent `.gitignore` rule edits lost rules (edit mutex).
- [6] 17 sibling sync commands moved to workers; `command(async)` on a sync fn is not the blocking pool (`archived_mirror_unsynced`, `sandbox_preflight`) — both fixed; guard test pins `SYNC_COMMANDS_ALLOWED`.
- [7] A dropped caller released the `sync_op` lock while the op kept running; entry points take the `SyncOp` and `off_worker` holds it (`lockstep_drv` now acquires it).
- [7] `init_pairing` discarded `blocked`; now reported as Desynchronized (`pairing_left_behind`), not an `Err`.
- [8][10][11]: no review file.

## Behaviour changes

- [1] Symlink/FIFO `.gitignore`, `project.json`, agent doc: left alone or refused. Scaffold skips; `update_gitignore_rule` and `ensure_generated_dir_ignored` error. Reads capped (4 MB `.gitignore`/agent docs, 64 MB `project.json`).
- [1] Import refuses link/FIFO/over-cap/non-UTF-8 `project.json` (unparsable still becomes blank). Dangling link stops extend/detach. Detach patches the registry before dropping state. `safe_relative` refuses `\` and `:` on every host.
- [2] Preflight keeps hook output head and tail only; lane output refused past 4 MiB; `output()` errors at 256 MiB.
- [2] VPN polkit dialog names an absolute `openvpn`; Ollama's elevated `rm` is `/usr/bin/rm`; a missing system binary is refused (NixOS fails closed). rsync pull uses `--protect-args` and reads a wildcard dir literally.
- [3] Corrupt `global_machines.json`, ssh recents/defaults, `tex_roots`, `skills_sources.json`, `git_peer.json` now error and are left untouched (was silent wipe/default). Registries written pretty with trailing newline. Claude identity rewritten only on change.
- [3] Forced tag move needs a landed backup; moved-since-probe tag is `blocked`. Pairing backups block `git init`. tmux launcher is 0700 and replaces a symlink.
- [6] `resolve_text_paths` rejects on worker failure; `git_available`/`provider_cli_available` read false; `sandbox_preflight` returns `Result`.
- [7] Ollama status reads time out at 10 s (lamp shows stopped); others keep 600 s. Registry: HTTPS-only, 10 s connect, 30 s total. Branch create is create-only; failed create/fast-forward is `blocked`, uncounted. A dropped future no longer cancels an in-flight lockstep pass.
- [8] pid 0 = Gone, pid > `i32::MAX` = Unknown (vm.rs no longer casts); ssh_common sweep deletes `ap-0-*`. openvpn Windows: OpenProcess replaces tasklist. EPERM counts alive on macOS in apps/dev_build.
- [8] tex/printing/workspace children get their own process group and are reaped at the deadline; stuck tex build drops the partial log; output > 256 MiB stops the build. `kill_all` also runs `codex_bind::untrack_now`. Screenshot tool lookup uses the effective PATH.
- [10] First outside click on a context menu only closes it. Settings > Ollama reads the activity store (paused pull shows Resume; download drops at `success`; finished load triggers `fetchModels`). `forgetVpnPassword` shows the backend error.
- [11] Phone ages `3 min ago`/`2 h ago`/`2 d ago`; sizes `46.9 KB`; Mail gets GB step; keys `mobile.activity.{justNow,minutesAgo,hoursAgo,daysAgo}` removed from the five i18n files.
- [11] odt escapes `"` `'`; print attributes escape `>` `'`; OSC stripped in prompt-count/notebook output. Phone polls skip hidden pages (ChatChanges too). Assistant/box scopes keep their ids (only root maps to null).

## Flagged for user

Untrusted paths [1]
- [1] Windows has no `O_NOFOLLOW` in `write_no_follow`/`write_json_file`; lstat-then-open TOCTOU (no fence on Windows).
- [1] `exclude_app_dir` and `commands/git.rs:3454` honour a repo-controlled `commondir` redirect; the plan's item is addressed by neither.
- [1] `write_export_copy` keeps its atomic path write after the handle check; a fenced agent could redirect that one layout-copy file.
- [1] A symlinked `project.json` now breaks import/extend/detach; an unparsable one is still replaced on import (pre-A1).
- [1] Skill copies bounded at 32 GiB / 200 000 entries, not small.
- [1] `skills::install_skill` reads a linked `SKILL.md` unbounded (never copied); canonicalize-then-copy has a TOCTOU window.
- [1] `rehome_tab_cwd` compares Windows `Prefix` case-sensitively (as before).

Spawned processes [2]
- [2] macOS `/usr/bin/rsync` (2.6.9/openrsync) and rsync < 3.0 hosts reject `--protect-args`: every such pull falls back to SFTP. Options: accept / probe version once / let Homebrew rsync >= 3 win (user-writable dirs).
- [2] macOS `resolve_openvpn` still falls back to a bare `openvpn` under sudo.
- [2] `~` host paths are not tilde-expanded under `-s` (paths are absolute today).
- [2] Lane commands with a `current_dir` now get `git_bounded`'s hazard pre-check; the fenced preflight (no cwd) is not checked.
- [2] `git_bounded::run` waits for both pipes: a hook leaving a background holder now times out (was an unbounded hang).

State [3]
- [3] Older `patch_json` stores (settings.json, projects.json, exec_trust, default_apps, agent_versions, ...) never had the owner-only DACL on Windows; `patch_private_json` costs an icacls pair per changed write.
- [3] The Windows token test and DACL assert have never run.
- [3] `%(refname:short)` for tags yields `tags/<t>` when a same-named branch exists (not examined).
- [3] `fs.rs:536` `&line[..2] != "!!"` has the panic shape; local porcelain bytes are ASCII, unchanged.
- [3] `force_reset_branch_does_not_move_without_its_backup` pins old behaviour, not a regression test.

Freezes [6][7]
- [6] Registry setters, `save_tab_layout`, `workspace_sync` stay sync on purpose (`save_tab_layout` has no version check; an older layout could land last on workers).
- [6] fs commands read the registry (`remote_target_for_dir`) on the async thread before branching.
- [7] Sidecar shutdown: `Runtime::drop` waits for an in-flight lockstep op; its awaits fail and timers panic on the blocking thread (noisy, not unsafe).
- [7] Small `load_state`/`persist` writes in lockstep still run on workers; Windows `patch_private_json` spawns icacls per changed write.
- [7] `registry_get` uses reqwest's proxy/TLS roots, not curl's.
- [7] `reconcile` (pub) has no callers; kept, takes `SyncOp`.
- [7] The `create_branch` and `fast_forward_branch_ref` tests were not run against old code.

Duplicates [8][9][10][11]
- [9] Crash-log header stamps change from `Z` to `+00:00` (nothing parses them); every unknown-project error now reads `project 'x' not found`.
- [9] `add_days`' O(n) loop kept; path-taking readers (`git_push_mcp::policy_at`, root_mcp, brand_migration legacy read) left as they are.
- [8] Confirm Unknown-handling choices, esp. Windows access-denied = alive for openvpn/apps.
- [8] `sysstat::...relaxed_lookup_reuses_an_entry_the_default_would_recompute` flaked once (global proc-tree cache).
- [8] The implementer spawned a no-op subagent once; commit trailer says Opus 5.5 per BRIEF.
- [10] Nine menu sites changed dismissal plumbing; `resolveTarget` not merged.
- [11] Say if compact phone ages (`3m ago`) or `47 KB` were wanted (one-line change in `ageLabel`'s caller).

Dead code / guards [12][F]
- [F] `voice_speak`/`voice_speak_stop` have no frontend caller but are read-aloud's planned backend (voice plan step 4): delete, or keep for the feature?
- [F] With its trigger gone, the PDF viewer's in-app region capture (`copySelecting`, copy layer, `pdfViewer.copySelection*` strings) and `screenshot.ts` `startDelayedCapture`/`cancelDelayedCapture` are unreachable: wire to a new entry point, or delete?
- [F] `paths::output_within` (ssh probe; parent-death signal, no cap) is a second bounded-run helper beside `git_bounded::run`.
- [F] Read-only `unwrap_or_default()` callers kept (`agent_fence::read_lists` fails closed, `launch_prep` falls back to global, `agent_auth` labels).
- [12] `src/lib`/`src/stores` → `src/components` import rule waits for S3. AGENTS.md wording for the guard rules: applied 2026-10-26 (user's call).

## Owed

- Windows/macOS: `scripts/ci-local.sh --from windows-clippy` and `--from macos-check` outside the fence (`~/.cargo` read-only in the fence). Notes of [2][3][8] owe it; [1][6][7] do not mention it.
  - [2] `paths::pkexec_argv`/`elevated_argv`, openvpn macOS launcher, osascript test.
  - [3] `#[cfg(windows)]` token test, `private_file::dacl_is_protected`, storage DACL assert.
  - [8] `proc_table.rs` `#[cfg(windows)]` block (HRESULT `0x80070005` on `e.code().0`), tasklist removal in `openvpn.rs`.
- Rebuild + relaunch: `npm run backend:stale` reports the open window predates the build (backend and embedded phone bundle).
- `npm run mobile:bundle` and a frozen dev build before the phone click-through of [11].
- Optional filemap rows, not known landed: [2] `git_bounded`, `paths`; [8] `proc_table`, `git_bounded`. Rows for [10][11] landed.

## Click-through (not run live)

Desktop
1. File tree "Ignore in git"/"Un-ignore" edits `.gitignore`; "Repair scaffold files" appends missing defaults; disable then enable git restores defaults; two quick "disable" clicks both succeed. [1][6]
2. Extend a local project to remote, then detach: description/created_at/time survive, tabs restore in the mirror, no freeze. [1][6]
3. Manage skills: install into a project, `.claude/skills/<name>/` holds files, no links. [1]
4. VPN project (Linux): polkit names an absolute `openvpn`; disconnect gives one prompt; quit with tunnel up gives none. [2]
5. Ollama: delete a system-owned partial layer; polkit shows `/usr/bin/rm`. [2]
6. Agent `git_push` with a `pre-push` hook running `yes`: memory stays flat. [2]
7. Remote directory pull (rsync) on a normal host; container project agent tab starts and writes its pidfile. [2]
8. Settings > Machines add/rename/reorder/remove; truncated `global_machines.json` gives an error and stays unchanged. [3]
9. Diverged lockstep project with a differing tag: tag moves, backup ref holds the old one. TeX root with `\input`s compiles. [3]
10. Settings > Archive delete/clear and "Repair all scaffolds": window stays responsive. Folder picker, file-tree create/rename/delete, terminal path links, new-project git checks work. [6]
11. Brain menu with Ollama up; `systemctl stop ollama` turns the lamp red within about 10 s. Registry browse works; unplugged gives an error within about 30 s. [7]
12. Pull a model, pause from 🧠, Settings > Ollama shows Resume/Delete; resume and delete there. "+" menu flips to agent rows after loading a model. [7][10]
13. Remote lockstep: commit on mirror, checkout on host, diverge then "Use local", Backups list, branch created on host appears; file tree and git panel answer during a pass. [7]
14. Print pane, Wi-Fi badge, background script (animation clears), VPN lamp stays lit; closing a tab and quitting leave no child processes; hung TeX build stops with "stuck". [8]
15. Right-click menus (Disk Usage, Blob pane, Files grid/tree, PDF page strip, PDF note layer, box pill, project pill near right/bottom edges): items work, outside click and Escape close; in the Blob pane the first Escape closes only the menu. [10]
16. Remote connect and reconnect panels: Browse a `.ovpn`, connect headless and interactive (green lamp), untick saved VPN password (error text on keychain refusal). [10]
17. Popout and main window: drag dividers, resize, drag a tab to a popout (split preview). [10]
18. Tex viewer toggles and Local/Remote file-source choice survive restart; mail sizes, download strip, RSS readout look unchanged; ODT viewer and Print dialog open; root-scope agent tab Reader/clear-undo/model tag/`/` commands work. [11]

Phone
19. Phone/web client loads (bundle served). [1]
20. Activity and Home: screen off for a minute, wake: rows refresh once, ages read `N min ago`. [11]
21. Focus view chat updates; subagent list, Prompts and Schedule sheets refresh and stop with the screen off. [11]
22. Files library favourites, recents, last folder, view layout and drafts survive a restart. [11]

## Gates

- [F] after everything: `scripts/gates.sh --all` green — vitest 953 files / 9493 passed; `cargo test --workspace` 5143 passed, 0 failed, 7 ignored; privacy-check clean. Flaky once under parallel builds: `ssh_exec::tests::host_tmux_targets_are_exact_where_the_host_tmux_has_it`, `sysstat` relaxed lookup (both pass alone).

- [1] All selected PASS. `cargo test -p tabtivity -p app-serverd` 4845 (+16); daemon 4516 + 1. One flaky owner-gate test outside the diff.
- [2] All PASS. Lib 4662 (+6), others 144/29/1; test-dlib 4507 + 1 after one timing flake. Windows/macOS check not run.
- [3] All PASS. Lib 4671 (+12, +1 Windows-only), others 144/29/1; one unrelated test-dlib flake, rerun green. `ci-local.sh` not run.
- [4][5]: no handoff.
- [6] All PASS after review (incl. lint-fe, build, vitest). Cargo 4888 (+2) at the step commit.
- [7] All PASS (brand, whitespace, clippy x3, test, test-dlib). Lib 4690 (+3), 7 ignored.
- [8] brand, whitespace, clippy green. Lib 4713 (+2), dlib 4558 + 1; one `sysstat` flake, rerun green. Windows check not run.
- [10] build green; lint 0 errors / 28 warnings; vitest 950 files / 9479 tests (+6); one `PdfZoomRaster` timing flake under load. No cargo tests.
- [11] build green; lint 0 errors / 28 warnings; vitest 951 files / 9493 tests, 0 failed. No Rust touched.

## Follow-ups after the user's calls (2026-10-25/26)

- `voice_speak`/`voice_speak_stop`: kept for read-aloud.
- [13] PDF region capture deleted — 6ec758aa→develop (copy layer, `pdfViewer.copySelection*` keys, `startDelayedCapture`/`cancelDelayedCapture`), c1d67b10 (untested row).
- [14] rsync fast path probes both ends — fba3ee46, ed2d4737 (review: host probe bounded 20 s / 64 KiB, no `2>/dev/null` so csh hosts work), be0c329a (filemap). Fast path only where both ends run rsync ≥ 3.0; else SFTP as before.
- Flagged: the whole screenshot save chain (`capture_screenshot`, `ScreenshotSaveOverlay`, `screenshotPending`, `copy_png_bytes_to_clipboard`) has no caller left; macOS `/usr/bin/rsync` (openrsync) beats Homebrew, so Macs never take the fast path; rsync installed/downgraded mid-session is noticed only after a restart (pulls fall back); remote tooling status still lists rsync as present on macOS.
- [15] Screenshot save chain deleted (user call) — `capture_screenshot`/`*_pending_screenshot` commands + command_class rows, clipboard image-out helpers, `ScreenshotSaveOverlay`, `screenshotPending`, `window/screenshot.ts`, `screenshotSave.*` keys. Kept (no writer left, user's call): the phone's `screenshots-pending` folder entry, the project screenshots-folder gitignore + name migration, the Screenshot global-app role in Settings.
- macOS rsync: user kept `/usr/bin` only — Macs use SFTP; no binary from a user-writable dir runs.
- S1 tests.rs extraction — 0d866d4f..14a2af4e; S2 `src/lib/i18n/` folder — ..fa2a9903; S3 upward imports out of `components/` + lint rule — ..f54fcade (review fix f54fcade).
- S4 `services/` groups (mail, git, root_mcp, agent, api, remote, mcp, calendar; `pub use` re-exports, `git mv`) — dd8cb0f1..83f906b5; test counts equal before/after, windows-clippy's two pre-existing items fixed in bfc89615. No stale `services/<old>.rs` path left in scripts, CI or source scans; prose in DOCUMENTATION.md/todo/docs/context still names old paths (module paths unchanged). Row-less modules: mail_ai, mail_sanitize, git_credentials, remote_credentials, remote_usage.
- S5 `services → commands` inverted — 9e7e2bc3..bcedfb88: helpers moved to `services::{git_hardened, git_hosting, git_worktrees, project_registry, calendar_store, agent_registry, ollama_client, local_drivers, box_store, fs_confine, synctex, window_registry}` (+ `crate::{paths, terminal, platform}`), `pub(crate) use` shims left in `commands/`; refs 141 → 36 (kept on purpose: 31 `mobile_control` → desktop command bodies, `daemon.rs --install-cli`, 3 `commands::apps` launcher users, `net_usage` ControlMaster counters). Test counts equal. Review: body-by-body compare, nothing drifted; fixed the todo-command path scan that matched no command (42d8ecaa). Rebase onto develop carried the launch-tracking fields into `services::window_registry`; `WindowList::XWaylandOnly` cfg fix for windows-clippy (bcedfb88). Flagged: `synctex_*` commands do not confine their pdf path (pre-existing); `launch_prep` reads the box store directly (same result).
- S7 frontend splits — 6beadcd1..a31aa5a3 (pure moves, each reviewed: moved code byte-identical, hook order unchanged): `FileViewerPane.tsx` 10,870 → 406 lines + 20 modules in `embed/fileViewer/`; `SettingsSubPanels.tsx` → 15 modules in `components/settings/` (file removed); `stores/tabs.ts` 6,888 → 4,447 + 9 pure modules in `stores/tabs/` (re-exported when ≥ 4 importers); `FileTree.tsx` 5,283 → 3,826 (+ `useFileTree*.ts`, `fileTreeDrag.ts`); phone `screens/Terminal.tsx` 5,128 → 2,688 (+ `screens/terminal/*`). Vitest 960 files / 9,539 tests after. Still big because each is one function a pure move cannot cut: `CodeEditor` (2,979), `TexView` (1,376), `OllamaPanel` (~1,340), `AgentsPanel` (~930), `useComposerSend` (76 inputs). `untested.ts` labels still say "SettingsSubPanels ·"/"FileViewerPane ·" (area labels only).
- SyncTeX confinement (S5 review flag) — 3a4dde5a, 0faba359: the `synctex_*` commands take the viewer's `projectId` and refuse a PDF or `.synctex(.gz)` map outside its roots; a map that is not a regular file (FIFO) is not opened.
- S6, S8, S9 and S7's Rust function splits: not done, optional.
