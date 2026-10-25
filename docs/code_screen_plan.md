# Code screen 2026-10-25 — plan

Status: A–E and G landed on develop 2026-10-25 (not run live); S not started —
each S step waits for the user's go-ahead on a quiet tree. Results, flags and
click-through: `docs/code_screen_handoff.md`. Findings come from five read-only screening
agents (Rust services; Rust commands/terminal/platform/crates; frontend
components; frontend lib/stores/mobile-web; folder structure), run 2026-10-25
on develop 8953f472 plus the uncommitted tree of that day. Items marked ✔ were
re-read against the code by the main session; the rest were verified by the
screening agent only — every implementer re-checks its item before fixing, and
drops it (noted in the handoff) if it no longer holds.

## Goal

Safer first, then no freezes, then fewer copies, then a cleaner layout. Each
fix reuses the helper that already exists in the codebase; nothing here adds a
new subsystem.

## Fixed decisions

1. Order: A (safety) → B (freezes) → C (frontend correctness) → D (duplicates)
   → E (dead code) → G (guard rules) → S (structure). S only on a quiet tree.
2. Every `safer` fix gets a regression test that fails before the fix
   (symlinked `.gitignore`, FIFO `.gitignore`, `C:` path segment, unparsable
   `project.json`, failing backup ref, `listen` rejection, stale response…).
3. Dedups pick the winner named in the step; the copies are deleted, not
   wrapped. No new parallel helper when one exists.
4. Behaviour stays the same except where the finding *is* the behaviour
   (e.g. a failed store load no longer reads as "empty").
5. Not done (rejected by the structure screen): regrouping `commands/*.rs`
   (`build.rs` parses the flat list), colocating `src/__tests__` with sources,
   moving `docs/*_plan.md` into a subfolder, renaming `components/embed`,
   splitting `src/styles/*.css` (`@import` order is load-bearing).
6. Hot shared files — `src/lib/i18n.ts`, the filemaps, `services::command_class`
   + generated `commandClasses.ts`, `src/lib/untested.ts` — parallel
   implementers list their edits in the handoff; the main agent applies them
   once at merge.
7. Files with other sessions' uncommitted edits at screen time
   (`git_push_mcp.rs`, `i18n.ts` + dictionaries, mobile `Terminal.tsx`,
   `Project.tsx`, `NewTabSheet.tsx`, `prefs.ts`) are touched only after those
   edits have landed.

## A — Safety

### A1 Untrusted paths (project tree, `.git`, browser API)
- ✔ `src-tauri/src/commands/projects.rs:3337` `ensure_gitignore_defaults`
  (writes :3344/:3355) — `fs::write` follows a committed `.gitignore` symlink
  (e.g. → `~/.bashrc`). Fix: the `symlink_metadata` + `write_no_follow` guard
  its sibling `ensure_generated_dir_ignored` (:3372) already has.
- `src-tauri/src/commands/fs.rs:1024` `update_gitignore_rule` (write :1062) —
  same; Core command, so also server mode. Same fix.
- `src-tauri/src/commands/projects.rs:2676` `set_project_git_disabled` —
  `!exists()` is true for a dangling link; the write creates the target
  outside the tree. Fix: `write_no_follow(.., create_new=true)`.
- ✔ `src-tauri/src/storage.rs:39` `write_json_file`, shared branch :48-55 —
  plain truncating open follows a `project.json` symlink (import:
  `finish_import` projects.rs:4660, detach :4919). Fix: no-follow open in the
  non-private branch, keeping the in-place rewrite (mode/owner kept).
- ✔ `src-tauri/src/services/server/share.rs:332` `exclude_app_dir` — plain
  read/write of `<common-dir>/info/exclude` on the user's repo (symlink
  rewrite, FIFO hang, `commondir` redirect). Fix:
  `git_guard::edit_info_exclude`, as `commands/git.rs:3454` does.
- `src-tauri/src/services/brand_migration/project.rs:104,240` — unguarded
  `read_to_string` of `packed-refs` / `.gitignore`; a FIFO blocks
  `sweep_at_launch` for every later project. Fix:
  `home_io::read_record_capped` / `git_bounded::read_small_regular`.
- `src-tauri/src/services/skills.rs:381` `copy_dir_recursive` — unbounded copy
  of third-party skill repos into `.claude/skills/<name>`. Fix:
  `tree_copy::copy_tree`.
- ✔ `src-tauri/src/services/mobile_control/web_client.rs:1070` `safe_relative`
  — no `:` check; on Windows `dir.join("C:/…")` (:780) serves any regular file
  ≤ 32 MB to a signed-in browser client. Fix: reuse
  `mobile_control/files.rs` `valid_segment`.
- `src-tauri/src/commands/projects.rs:4784,4908` — extend/detach read
  `project.json` with `unwrap_or_default()` and later delete the original
  (:4861, :4972): an unparsable file loses time/created_at/description. Fix:
  propagate the parse error.
- `src-tauri/src/commands/projects.rs:4972-4978` — detach deletes the state
  `project.json` + dir before `patch_project_entry`. Fix: patch first, delete
  after (extend's order).
- `src-tauri/src/commands/projects.rs:4947` — tab-cwd rewrite uses
  `strip_prefix(format!("{state_dir_s}/"))`; likely misses `\` cwds on Windows
  (unconfirmed which separator the frontend stores). Fix: `Path::strip_prefix`.

### A2 Spawned processes
- ✔ `src-tauri/src/services/git_push_mcp.rs:373` `run_capped` — uncapped
  `read_to_end` of an agent-writable pre-push hook for up to 5 min
  (`PREFLIGHT_TIMEOUT`, :690): `yes` → OOM of the main process. Fix: callers
  (:546, :690, :737, `git_release.rs:271`, and `markup_rounds.rs:404 run`) go
  through `git_bounded::run` with `Opts{stdin, stdout_cap, timeout}`; add a
  stderr cap to `git_bounded::run` (uncapped at `git_bounded.rs:402`) and a
  non-zero default stdout cap.
- `src-tauri/src/services/openvpn.rs:264,1567,1809,1896` — `pkexec openvpn` /
  `pkexec kill` by bare name; pkexec resolves through the caller's `PATH`
  (a planted `~/.local/bin/kill` runs as root after the polkit approval).
  Fix: absolute root-owned paths via `SYSTEM_BIN_DIRS` + `root_owned_file`
  (for `pkexec` itself too), and one `pkexec_kill(pid)` helper replacing the
  three copies of the kill + `mark_signalled` block.
- `src-tauri/src/services/remote_sync.rs:1151-1167,1203-1225` — rsync `-e`
  string with unquoted `ControlPath=`; `host:src` without `--protect-args`.
  Fix: `crate::quote::posix` + `-s`.
- `src-tauri/src/services/sandbox.rs:485-487` — hand-rolled shell quoting.
  Fix: `crate::quote::posix`.
- `src-tauri/src/services/openvpn.rs:1153` `random_hex` — reads
  `/dev/urandom` by hand. Fix: `getrandom::fill` + `digest::hex`.

### A3 State that must survive
- `src-tauri/src/services/git_peer.rs:1831,2316` — backup `update-ref` result
  discarded (`let _ =`); the forced tag move / `reset --hard` runs anyway.
  Fix: `run_checked`, skip the move/reset on failure (as :2203 does).
- `src-tauri/src/commands/global_machines.rs:49,61`, `commands/ssh.rs:145-148,
  196-203, 243-252`, `commands/tex.rs:2295-2306` — `read_json(..)
  .unwrap_or_default()` then `write_json`: a corrupt/newer file is replaced
  (`global_machine_add` wipes the registry to one row); concurrent calls lose
  updates. Fix: `storage::patch_json`.
- Hand-rolled atomic writes → `storage::write_private_atomic(_mode)` /
  `write_json_atomic`: `services/agent_auth.rs:212` (+ sidecars :203, :440,
  :481, :872, :1098, :1124), `markup_rounds.rs:1355` (fixed tmp name, no
  fsync), `dev_todo.rs:156` (fixed tmp name), `tmux_local.rs:940` (0644 then
  chmod), `mobile_control/admin.rs:347` (Windows control token inherits the
  folder ACL).
- `src-tauri/src/services/git_peer.rs:359` — `&line[..2] != "??"`. Fix:
  `starts_with("??")`.

## B — Freezes and stalls

### B1 Sync commands that block the window; local fs on tokio workers
- `commands/projects.rs:1376,1388` `delete_archived_project` / `clear_archive`
  (`remove_dir_all` of whole trees; the module's own comment at :960 names
  this freeze), `:2641` `set_project_git_disabled` (`remove_dir_all(.git)` /
  `git init`), `:3623` `repair_all_project_scaffolds`, `:4028`
  `project_migration_apply` → async + `try_blocking`.
- `commands/projects.rs:4708` `extend_project_to_remote` (ssh mkdir, scaffold
  commit inline) and detach `:4874` → `*_blocking` body + `try_blocking`, like
  `archive_project`.
- `commands/fs.rs:158` `resolve_text_paths`, `:2815` `list_dirs`, `:2871`
  `list_dir_all` → async. Local branches of `delete_dir` (:923), `list_dir`
  (:103), `delete_file` (:892), `create_file` (:953),
  `write_project_file*` (:978, :1007), `create_dir` (:1077) → `try_blocking`.
  While there: `list_dirs` becomes `list_dir_all` with `dirs_only`.
- `commands/git.rs:799` `git_available`, `commands/git_fork.rs:127`
  `provider_cli_available` → async + `try_blocking`.

### B2 Ollama and lockstep
- `commands/ollama.rs:2593,920,1275,1564,2244` — blocking `ollama_http`
  (600 s read timeout, :299) inside async fns → `try_blocking`, short timeout
  for status reads.
- `commands/ollama.rs:2548,2347` (curl :2571, :2286, :2313, no `--max-time`)
  → async `reqwest` with a timeout.
- `services/git_peer.rs:1462 transfer_and_apply, 3957 detect_and_sync,
  2636 reconcile_with, resolve_inner, init_pairing` — sync `Peer::run`/`probe`
  on tokio workers → `spawn_blocking` batches (pattern: `remote.rs:413/430`).
- `services/git_peer.rs:2974-2995, 3021-3035` — global `SyncManifestState`
  mutex held across one `sftp::metadata_on(..).await` per path. Fix: stat
  first, lock once, record (as `sync_auto.rs:690-760`).

## C — Frontend correctness

### C1 Stores, lib, phone app
- `src/stores/calendar/calendar.ts:148` `reload` — IPC failure → empty data
  with `loaded: true`, no stale guard. Fix: keep old state + `error`, sequence
  number. Same "failed = empty" in `stores/calendar/caldav.ts:406`,
  `stores/boxes.ts:193`, `stores/remote/globalMachines.ts:189`.
- `src/stores/agents/agentPrompts.ts:171`, `agentSchedules.ts:67` — load vs
  upsert race. Fix: per-key request counter.
- `src/lib/agents/typedClear.ts:116` `forgetTypedLine` has no caller (map
  grows, reused PTY id inherits a line). Fix: call it from `forgetClosedTab`
  (`stores/tabs.ts:2550`); the inline copies at tabs.ts:3410, 3458, 3544,
  3578, 5304 call the helper.
- `value in OBJ` membership → `Object.hasOwn`: `src/lib/theme/tabColors.ts:43`,
  `mobile-web/src/tabColors.ts:45`, `src/lib/voice/desktopVoice.ts:45`,
  `src/lib/viewers/tex/beamer.ts:201`.
- `mobile-web/src/main.tsx:1-16` — no `hardenPrototype()`, no
  `error`/`unhandledrejection` listener. Fix: call it; log rejections into
  the connect trace.
- `mobile-web/src/api.ts:609` — `body as T` unchecked; `Activity.tsx:114`
  `setTabs(body.tabs)` unguarded; `src/lib/transport/wsClient.ts:271` and
  mobile `Terminal.tsx:1983` deref a parsed `"null"` frame. Fix: reject
  non-object bodies, guard, null-check.

### C2 Components
- `src/components/common/ProjectBlobPane.tsx:712-719` — window Escape calls
  `ascend()` while hidden / when another handler took it. Fix: `if (!visible ||
  e.defaultPrevented) return`, close the menu first.
- `src/components/files/FileBrowser.tsx:322` — rename via
  `lastIndexOf("/")` breaks Windows paths. Fix: `resolvePath(dirname(oldAbs),
  nextName)` as FileTree.tsx:3251.
- Native plugin-dialog `confirm` → `useDialogs().confirmAction`:
  `ProjectPill.tsx:1335,1351`, `ProjectDialog.tsx:941` (Dockerfile-as-root
  question), `VmSettingsDialog.tsx:78`, `FileTree.tsx:2904`.
- Install-with-log flows subscribe outside `try` (button stuck on
  "installing" if `listen` rejects): `SettingsSubPanels.tsx:2436,2494,3593,
  3616`, `LocalModelsPage.tsx:184`. Fix: one `runWithProgress` helper.
- Stale-response guards: `FileViewerPane.tsx:3882-3901` spell check,
  `GitHistory.tsx:1789-1793` commit message (don't overwrite a user edit).
- `CompareView.tsx:170,631` — per-line `highlight()` every render. Fix:
  `useMemo`.
- Hardcoded text → `t()`: `ProjectBlobPane.tsx:110-114,1009`, file-dialog
  filter names (`useRemoteSession.ts:447`, `useRemoteReconnect.ts:392`,
  `VpnIndicator.tsx:457`, `DeckView.tsx:1053`), `SystemMonitorPane.tsx:425`,
  `GifView.tsx:149`, `StatsRecap.tsx:45`.
- `PdfPresentApp.tsx:132`, `DeckAudienceApp.tsx:88` follow only the theme.
  Fix: shared `useCrossWindowAppearance()` with `DetachedApp.tsx:323-372`.

## D — Duplicates

### D1 Rust: processes, git, liveness, teardown
- `pid_alive` ×4 with divergent EPERM/zombie semantics:
  `commands/apps.rs:2188`, `services/vm.rs:1698` (also u32→i32),
  `services/openvpn.rs:109,121`, `services/ssh_common.rs:1092` → one
  `proc_table::pid_state(pid) -> Alive|Gone|Unknown`.
- Bounded-run loops: `commands/printing.rs:123`, `commands/workspace.rs:135`,
  `commands/tex.rs:415`, `commands/agents.rs:1487-1503` →
  `git_bounded::run` (generalised if needed; one helper, not a second).
- `commands/apps.rs:705-717` → `paths::spawn_reaped` with an on-exit callback.
- Hardened-git "trimmed stdout": `commands/projects.rs:1246`,
  `commands/git.rs:2071`, `commands/git_pull.rs:103`,
  `services/prompt_blame.rs:46`, `services/brand_migration/project.rs:49` →
  one `git::stdout(target, dir, args)`.
- `terminal/mod.rs:1747` `PtyRegistry::kill` test-only → `#[cfg(test)]`;
  `kill_all` (:1772) drains and calls `teardown_taken` (gains
  `codex_bind::untrack_now`).
- `commands/screenshot.rs:449` `on_path` → `paths::binary_on_path`;
  `gsettings_get` ×2 (`platform/x11.rs:858`, `commands/os_clock.rs:66`) → one.

### D2 Rust: small primitives and lookups
- Hex: `agent_history.rs:673-685`, `agent_session.rs:2126`,
  `mail_crypt.rs:293-298`, `mobile_control/admin.rs:324,340`,
  `agent_transcript.rs:600`, `vm.rs:1236`, `desktop_images.rs:162` →
  `digest::hex` / `sha256_hex`.
- UTF-8 clip loops ×13 (`agent_changes.rs:735`, `agent_transcript.rs:1337`,
  `git_push_mcp.rs:267`, `help_mcp.rs:438`, `mail_contacts.rs:53`,
  `root_mcp_mail.rs:519`, `sheet_reader.rs:558`, `web_lane.rs:314,326`,
  `voice/ssip.rs:40`, `server/share.rs:809`, `mobile_control/git_overview.rs:109`,
  `mobile_control/headless.rs:63`) → `str::floor_char_boundary`.
- Time: `storage.rs:700` vs `lib.rs:119` `iso_now` (`+00:00` vs `Z` — pick the
  one persisted files already carry, check round-trip), hand calendar maths
  (`storage.rs:707`, `commands/screenshot.rs:297`, `services/mail_ai.rs:518`,
  `schema/calendar.rs:1195`) → chrono; `now_secs` copies
  (`opencode_models.rs:84`, `mobile_control/host_live.rs:288`,
  `api_proxy_port.rs:161`) → `clock::now_secs`.
- Projects list: `commands/projects.rs:366` vs `services/remote.rs:126`
  `read_projects_list`; direct `projects.json` readers (projects.rs:3601,
  3628, 3778, 3806, 3995, 4046; `git_hosting.rs:209`; `git_publish.rs:888`;
  `apps.rs:1252`; `project_runtime.rs:99`) and 8 "find by id or not found"
  → one `projects::entry(id) -> Result<ProjectEntry>` on the cached reader.
- Test-only `git(dir, args)` fixtures ×~15 with drifting env hygiene → one
  `#[cfg(test)] test_util::git` clearing foreign `GIT_*` + global config
  (`src-tauri/src/test_util.rs` exists).

### D3 Desktop frontend: listeners, menus, VPN, Ollama, panes
- ~40 hand-rolled `listen` sites → `useTauriListener`/`subscribeTauri`
  (`src/hooks/useTauriListener.ts`); uncaught ones first:
  `WorkspacePatchHost.tsx:22`, `RootOverlay.tsx:148-149`,
  `ProjectExportDialog.tsx:122`, `DiskUsagePane.tsx:128`, `UpdatesPanel.tsx:93`,
  `ScreenshotSaveOverlay.tsx:66`, `SettingsSubPanels.tsx:3476,3493`,
  `DetachedApp.tsx` (×12).
- Hand-rolled context menus → `ContextMenuPortal`: `DiskUsagePane.tsx:451`,
  `ProjectBlobPane.tsx:945`, `FileBrowser.tsx:122-130`, `PageStrip.tsx:546`,
  `PdfNoteLayer.tsx:559`, `BoxScopeChip.tsx:562`, `ProjectPill.tsx:1745`,
  `FileTree.tsx:4698`.
- OpenVPN copies in `useRemoteSession.ts` / `useRemoteReconnect.ts` /
  `VpnPasswordPrompt.tsx` / `VpnIndicator.tsx` → `useOpenVpnLog`,
  `useVpnReadyMarker` (on `terminalBus`, not raw `listen("terminal-output")`),
  `pickAndStoreOvpnConfig`; one `forgetVpnPassword` (the error-showing one).
- `SettingsSubPanels.tsx:3451-3495` OllamaPanel, `LocalModelsPage.tsx:189`,
  `localModelGroup.ts:86` → `useOllamaActivityStore` +
  `initLocalModelEvents()` (fixes: a pull paused from 🧠 shows no Resume in
  Settings).
- `CenterPanel.tsx:382-431` vs `DetachedCenterPanel.tsx:483-523` (+ drag :548,
  `resolveTarget` :699) → `usePaneRects` + shared split-drag hook.

### D4 Shared helpers (desktop + phone)
- Bytes: `mobile-web/src/terminal/fileLabels.ts:15`, `mobile-web/src/screens/
  Mail.tsx:52` (no GB step), `src/lib/browser.ts:440`, `mail.formatSize`,
  `fmtSize` → `src/lib/formatBytes.ts:16`; `rendererWatchdog.ts:313`
  `formatRssKib` → `gpu.ts:105`.
- Durations: `AppTimerDisplay.tsx:10`, `StatsRecap.tsx:44`,
  `ActivityCalendar.tsx:10`, `ProjectBlobPane.tsx:110`, `TabHoverCard.tsx:87`
  → `ProjectHoverCard.formatTime` moved to `src/lib`; phone `Activity.tsx:44
  ago` vs `fileLabels.ts:7 ageLabel` → one, one key set.
- HTML escape ×5 (`highlight.ts:78`, `mail.ts:1081`, `odt.ts:26,31`,
  `print.ts:1385`) → one (check each escaped set before merging).
- ANSI strip ×3 (`prompt.ts:106` wins; `notebook.ts:45`, `promptCount.ts:33`).
- Path helpers re-done despite `lib/paths`: `GitHistory.tsx:147`,
  `GitPullPanel.tsx:28-39`, `FontField.tsx:113`, `FileViewerPane.tsx:10366,
  10449`, `CalendarPane.tsx:976`.
- Phone visible-poll effects ×~20 (Activity.tsx:132, NeedsYou.tsx:111,
  Home.tsx:185,203, Terminal.tsx:2309,2423,2544,2578, Project.tsx:404,
  markup/questions.ts:81, markup/newTab.ts:70, ChatChanges.tsx:124,
  chatUncommitted.ts:44) → one mobile `useVisiblePoll(fn, ms)` with an
  in-flight guard (model: `src/lib/usePoll.ts`).
- Persisted JSON: `stores/viewers/texViewPref.ts:43-80` vs
  `stores/remote/fileSourcePref.ts:36-68`, and nine phone copies
  (reloadGrace, filesPlace, lastPlace, drafts, pen, seenDone, prefs,
  libraryView, slashCommands) → `src/lib/persist.ts`
  (`readJson`, `writeJson`, `cappedMap`).
- Copies into the phone app: `mobile-web/src/tabColors.ts` → re-export
  `src/lib/theme/tabColors.ts`; `todoDates.ts:37,62` vs `lib/todoBoard.ts:
  177,285` pure column rules → `shared/`; `ScheduleSheet.tsx:37
  delayMinutes` = `AgentScheduleDialog.tsx:70`, `Terminal.tsx:186
  paintMicLevel` = `ReaderVoice.tsx:24` → `shared/`.
- Root scope: `ROOT_SCOPE` ×2 (`stores/tabs.ts:227`, `stores/usage.ts:31`),
  bare `"root"` compares (pdfMarkup.ts:47, hostBound.ts:47,
  closeRemoteTab.ts:48, hpcGuard.ts:123, projectTabHost.ts:51,
  tmuxSession.ts:162), `scope === "root" ? null : scope` ×5 → `ROOT_SCOPE` +
  `projectIdOfScope()` (reserved-scope aware) in `lib/terminal/ptyId.ts`.
- ~40 `translate(useI18nStore.getState().lang, …)` + local `tr()`
  (`mobile-web/src/connection.ts:114`, `localLock.ts:7`,
  `lib/viewers/print.ts:434`) → `translateNow` in i18n (after Fixed
  decision 7 allows touching i18n.ts).

## E — Dead code (verify with `rg` again, delete with their tests)
- TS: `lib/agents/prompt/filter.ts` (whole), `prompt/tags.ts:72-112`,
  `desktopVoice.ts:284-294` (and check the Rust `voice_speak` command),
  `gif.ts:436 decodeGif`, `prompt.ts:148 looksLikeDecisionPrompt`,
  `auth.ts:188 deviceRecord`, `fileUtils.ts:186 DECK_SUFFIX`,
  `texPreview.ts:114 clearTexPreviews`, `mail.ts:797 APP_EMAILS_DIR`,
  `assistant.ts:72 ASSISTANT_OFF`, `deck/fonts.ts:197,425`,
  `pdfNotes.ts:125 notesOf`, `screenshot.ts:27 requestInAppCapture`,
  `todoDates.ts:88 acceptedColumns`, `linkState.ts:91 isDisconnectedError`,
  `PillStatusBars.tsx:13 statusBarKinds`, `fileAccess.ts:200 detectMime`
  (+ Rust `detect_mime` if then unused), `FontField.tsx:47,131`.

## G — Guard rules (keep the classes from coming back)
- ESLint `no-restricted-imports`: `confirm`/`ask`/`message` from
  `@tauri-apps/plugin-dialog` in `src/components`; `src/lib` and
  `src/stores` may not import `src/components` (after S3).
- ESLint `no-restricted-syntax` with allowlist: direct `listen(` in
  components; `.split("/").pop()` / `lastIndexOf("/")`.
- Rust source-scan tests (like the hardened-git one): no `fs::write` /
  `read_to_string` on `.gitignore`/`project.json`/`info/exclude` outside the
  guarded helpers; no `read_json(..).unwrap_or_default()` followed by a write
  of the same file; sync `#[tauri::command]` bodies with no
  `remove_dir_all`/`.output()`/`ollama_http`.
- One-line rules into AGENTS.md (Invariants/Conventions) for the three
  above, after the user approves the wording.

## S — Structure (quiet tree only; one group per commit; `git mv` for blame)
- S1 Inline `mod tests` → sibling `tests.rs` for the 24 files with > 1,000
  test lines (`mobile_control/host.rs` 5,791 of 13,540, `mail_store.rs`,
  `commands/git.rs`, `agent_session.rs`, `root_mcp.rs`, `git_peer.rs`, …).
  Check `include_str!` source-scan tests first (`mail_engine.rs:2638`,
  `command_class.rs:1044`).
- S2 `src/lib/i18n.ts` → `src/lib/i18n/{index,en,de,es,fr,it,all}.ts`.
- S3 Upward imports out of `components/`: `embed/fileAccess.ts`,
  `files/{openFileEntry,importDrop}` → `lib/files/`; `tabs/newTabItems.ts`
  → `lib/tabs/`; `projects/{scaffold,useSavedCredential}` → `lib/projects/`;
  `QUEUED_CONFIRM_DELAY_MS` → lib. Edit `vi.mock` path strings with the move.
- S4 `services/` subfolders with `pub use` re-exports in `services/mod.rs`
  (precedent: `app_core::services::schedule_usage`): `mail/`, `git/`,
  `root_mcp/`, `agent/`, `api/`, `remote/`, `mcp/`, `calendar/`; ~15
  `super::` paths and 22 `include_str!` paths fixed by hand.
- S5 Invert `services → commands` (211 refs): move `calendar` store fns,
  `git::hardened_git_command_in` & co., `projects::uuid_v4`, pure `ollama`
  helpers, `agents::agent_bins`, `fs::display_path` & co., `boxes` scope fns
  down into `services/`, leaving `pub(crate) use` shims until callers move.
  Prerequisite for S9 and for thinning `commands/{projects,ollama,git,mail,
  fs}.rs`.
- S6 Desktop-imported phone modules → `shared/` (`mobile-web/src/terminal`
  parsers, `markup/{layer,pen,anchors,rasterize,submitState,findText,
  frameProtocol}`, `api.ts` types/client), per cluster.
- S7 Giant files: `FileViewerPane.tsx` → `components/embed/fileViewer/`;
  `SettingsSubPanels.tsx` → `components/settings/`; `stores/tabs.ts` pure
  parts → `stores/tabs/`; `FileTree()` hooks; mobile `Terminal.tsx` hooks;
  `services/launch_prep.rs:705 prepare`; `git_peer.rs` apply loops;
  `pty_bridge.rs:833 attach`; `sync_auto.rs:530 reconcile_pass`.
- S8 Folders: `components/projects` remote half → `components/remote/`;
  `components/common`/`layout` singleton hosts → `components/hosts/`,
  feature dialogs to their features; `src/lib` and `mobile-web/src` loose
  clusters (see screen report); `commands/scaffold_history/` →
  `src-tauri/assets/`; finish `docs/root_cleanup_plan.md`; snake_case
  scripts → kebab-case.
- S9 `src-tauri/src/schema/` → `app-core` (after S5).

## Organisation

Shape: **mixed risk.** A is security/invariant work → each A step gets an
implementer, then two independent reviewers (finder + verifier, no shared
context). B gets a per-step reviewer (threading changes). C, D, E get the
final review only. G after D. S is sequential, one implementer per step,
started only when the user says the tree is quiet, each S step its own
go-ahead from the user (S5–S9 are large).

Bound: ≤ 5 subagents at once, ≤ 3 running cargo.

Models (user's choice 2026-10-25, mixed by risk): **Opus** for the A
implementers and their finder + verifier reviewers, the B implementers and
their reviewers, S5/S7/S9 and the final review; **Sonnet** for the
mechanical C, D, E, G steps and the S1–S4, S6, S8 moves. Column "Model"
below.

Dependencies: A1 → B1 (both `commands/projects.rs`); A2 → D1
(`git_bounded::run` shape); A3 → B2 (`git_peer.rs`); C1 ∥ C2 ∥ A*;
D1/D2 after A+B; D3 after C2; D4 after C1 and after the i18n edits land;
E after D; S after everything else.

### Agent steps

| Step | Plan sections | Main files | Reviewers | Model |
|---|---|---|---|---|
| 1 | A1 | commands/projects.rs, commands/fs.rs, storage.rs, server/share.rs, brand_migration/project.rs, skills.rs, mobile_control/web_client.rs | finder + verifier | Opus |
| 2 | A2 | git_bounded.rs, git_push_mcp.rs, git_release.rs, markup_rounds.rs, openvpn.rs, remote_sync.rs, sandbox.rs | finder + verifier | Opus |
| 3 | A3 | git_peer.rs, global_machines.rs, ssh.rs, tex.rs, agent_auth.rs, markup_rounds.rs, dev_todo.rs, tmux_local.rs, admin.rs | finder + verifier | Opus |
| 4 | C1 | stores/calendar/*, boxes.ts, globalMachines.ts, agentPrompts.ts, agentSchedules.ts, typedClear.ts, tabs.ts, mobile-web main.tsx/api.ts | final only | Sonnet |
| 5 | C2 | ProjectBlobPane, FileBrowser, ProjectPill, ProjectDialog, VmSettingsDialog, FileTree, SettingsSubPanels, FileViewerPane, GitHistory, CompareView | final only | Sonnet |
| 6 | B1 | commands/projects.rs, commands/fs.rs, commands/git.rs, commands/git_fork.rs | per-step | Opus |
| 7 | B2 | commands/ollama.rs, services/git_peer.rs | per-step | Opus |
| 8 | D1 | apps.rs, vm.rs, openvpn.rs, ssh_common.rs, printing.rs, workspace.rs, tex.rs, agents.rs, terminal/mod.rs, screenshot.rs | final only | Sonnet |
| 9 | D2 | digest users, clip loops, storage.rs/lib.rs time, projects.rs/remote.rs list, test_util.rs | final only | Sonnet |
| 10 | D3 | DetachedApp, SettingsSubPanels, useRemoteSession/Reconnect, VpnIndicator, CenterPanel/DetachedCenterPanel, menu sites | final only | Sonnet |
| 11 | D4 | src/lib formatters/persist/paths, mobile-web helpers, shared/, ptyId.ts, i18n translateNow | final only | Sonnet |
| 12 | E + G | dead exports; eslint config; Rust scan tests | final only | Sonnet |
| S1–S9 | S | per S item | per-step, user go-ahead each | Opus for S5, S7, S9; Sonnet for S1–S4, S6, S8 |

12 agent steps before S; S adds up to 9 more.

## Verification

- Per step: `scripts/gates.sh` (the gates the diff touches), regression tests
  named in the handoff with before/after test counts, `npm run backend:stale`
  after backend steps.
- Final: `scripts/gates.sh --all`, `scripts/ci-local.sh` (backend steps touch
  process spawning, paths, `cfg` code — read the Windows/macOS cross-check
  output), `scripts/brand-check.sh`, `scripts/privacy-check.sh`.
- Not run live. Click-through checks for the user go in the handoff:
  rename a file on Windows; Escape with a hidden Projects tab; delete a big
  archived project (window stays responsive); pause an Ollama pull from 🧠,
  then open Settings; calendar with the backend briefly failing.
- Handoff: `docs/code_screen_handoff.md`.
