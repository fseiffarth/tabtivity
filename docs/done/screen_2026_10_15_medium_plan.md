# Whole-project screen 2026-10-15 — Medium findings: fix plan

Status: implemented and landed on develop 2026-10-16; never run live (plan
review and decision change at the end; per-step results in the handoff). Source:
`docs/whole_project_screen_2026_10_15.md` § "Medium — worth a batch each"
(screened at `dd5ede60`; line numbers drift — find by anchor; the anchors
below were re-checked at `cb98acf9`, i.e. develop + the High follow-up round
`screen-high-int2`). Handoff: `docs/screen_2026_10_15_medium_handoff.md`.
Follows `docs/screen_2026_10_15_high_plan.md` (landed). The High follow-up
round (agent_tasks `extra`, client ssh allow-list, root login paste bar,
pre-push rollback) **has landed on develop (`2f0569c5`)**; branch every
implementer from develop at or after it — it touched `git_peer.rs`,
`remoteConnect.ts`, `credentials.rs` and `.githooks/pre-push`, all of which
this plan edits.

## Why

The Mediums are ~40 findings: i18n stopping at the component boundary,
leftover native dialogs, store/hook races and silent failures, a handful of
backend correctness/security gaps (the browser-client path confinement is
the closest to a High), ~19 dead IPC commands, and repo/CI drift. Most are
mechanical; a few touch invariants.

## Fixed decisions

Reviewers may not undo these. ("Review:" lines are the plan review's
sharpening of how a decision is carried out; they change no decision.)

1. **Already done, skip:** `save_project` (deleted in the High run) and
   `commands/git.rs` `/bin/sh` on Windows (fixed in the S2 review).
2. **Out of scope this round:** the structural refactors (`FileTree`,
   `PdfCanvas`, `CodeEditor`/`FileViewerPane` split, `TerminalView`'s single
   effect, `tabs.ts` split, `MobileBridgeHost` move, phone `Terminal.tsx`),
   the 8-module import cycle, dead-code-kept-alive-by-tests, the ~40
   `AppHandle`/`State` signatures, test-writing for the untested large
   components, and removing `continue-on-error` from the Windows/macOS CI
   clippy jobs (user's call — flagged, not changed).
3. **In scope from "Bloat":** one `useDiskReloadPoll` hook replacing the 7
   copy-pasted mtime polls (honouring `saverInterval(…, quiesce)` as the one
   good copy does), and one source of truth for the agent CLI list (a new
   CLI must restore as an agent, not "shell"); the backend registry stays
   the authority where one exists.
   - Review: build the hook on the existing `src/lib/usePoll.ts` (it already
     applies `saverInterval`, blur/hidden quiesce and in-flight guarding) —
     copy the working sibling, no second poll engine; gate on
     `PaneVisibleContext` and catch up on show (AGENTS.md). For the CLI
     list: the backend `AgentSpec` table (`commands/agents.rs`) is the
     authority; generate a static TS table from it the way
     `commandClasses.ts` is generated (Rust test + `UPDATE_…=1`), because
     `cmdToKind`/restore are synchronous and cannot await `list_agents`.
     Put it in a `src/lib/agents/` module, not `stores/tabs.ts`, so
     `newTabItems.ts` stops importing `RESUMABLE_AGENTS` from the store.
4. **i18n:** every display string found goes through `src/lib/i18n.ts`
   (English holds every key; other languages get translations in the same
   style as their neighbours). Non-React code uses the module's non-hook
   translator. `calendarTime` AM/PM and default locale follow the app
   language. The i18n test is fixed so a dropped `{app}`/`{slug}`
   placeholder fails it (compare placeholders before `fillBrand`).
   - Review: the non-hook translator is
     `translate(useI18nStore.getState().lang, key, vars)` (as
     `vpnAutoConnect.ts:167` already does). The test lives at
     `src/__tests__/shell/i18n.test.ts`; `src/lib/i18nDicts/all.ts`
     `TRANSLATIONS` is already `fillBrand`-ed, so the new check compares
     `enSource` (`i18n.ts`) with the raw `de/es/fr/it` dicts, **in both
     directions** (set equality), since the two known mismatches go opposite
     ways (see M1). `sw.js` cannot import `i18n.ts`: see M1.
5. **Native dialogs:** all 14 `window.confirm/prompt/alert` go to the shared
   PromptDialogs (#244); none remain outside tests (add a source-scan test).
   - Review: the screen's list actually names **17** desktop sites, and
     HEAD has **5 more** desktop ones and **6 phone** ones (M2 lists all
     28). Desktop sites use `useDialogs()` from
     `src/components/common/PromptDialogs.tsx`; phone sites (which cannot
     use desktop components) use the phone's own sheet
     (`ConfirmSheet`/option sheet pattern in `mobile-web/src/screens/Calendar.tsx`).
     The scan test exempts exactly `src/lib/transport/dialogAdapter.ts`
     (the browser-client fallback that implements the dialog plugin) and
     `@tauri-apps/plugin-dialog` `confirm(...)` imports (not native
     `window.*`).
6. **Browser-client confinement:** every core-dispatch command that takes a
   filesystem path is confined to the user's roots for a `Role::User`
   client, the same way `list_dir_all` is (`USER_CONFINED_PATH`); a command
   whose path cannot be confined is refused for that role. The comment is
   made true, not softened.
   - Review: the finding understated the gap. Beyond the six named, **every
     `projectDir`-taking command** (`list_dir`, `write_project_file`,
     `delete_dir`, all `git_*`, …) confines `relPath` *within* `projectDir`
     (`fs::enforce_confinement`) but never checks `projectDir` itself, so a
     user can pass `projectDir: "/"`. The complete per-command table and
     mechanism is in M4a. It is carried out at the dispatcher
     (`core_dispatch::confine_for_user`, one typed table), not by rewriting
     command bodies, and a test fails when a new core command grows a
     path-named argument the table does not classify.
7. **`let _ =` on decision-feeding writes:** a failed `save_manifest` makes
   the operation fail visibly (or, where the transfer already happened,
   marks the manifest stale so the next status re-derives and never shows a
   false "clean" / allows a blind forced push). Failed layout persist in
   `persistScope` surfaces once per session (toast), not per write.
   - Review: there are **9** ignored `save_manifest` results, not 4:
     `commands/sync.rs` ×4, `services/sync_auto.rs` ×2,
     `services/git_peer.rs` ×3 (see M4b). One helper in `remote_sync`
     (record-or-mark-stale) serves all nine.
8. **`FileLock::exclusive`** propagates `flock` failure like `shared()`;
   callers that must still work on lockless filesystems fall back
   explicitly and log once.
   - Review: the current behaviour is documented as deliberate ("Best
     effort — a filesystem without advisory locks still gets the caller's
     revision check", `storage.rs` above `struct FileLock`). Carry #8 out
     by classifying the error: "locks unsupported" (`ENOLCK`,
     `EOPNOTSUPP`/`ENOTSUP`, `ENOSYS`; Windows equivalent) goes through one
     explicit fallback API (e.g. `FileLock::exclusive_or_unlocked` →
     `Ok(None)`, logged once per path class) used **only** by callers that
     have a revision/compare-and-swap check (`storage::patch_json`,
     `remote_sync::save_manifest_at`, …); every other error propagates.
     `shared()` gets the same classification so readers on FUSE stop
     failing where writers silently succeed. ~24 call sites in 15 files to
     triage (M4c).
9. **Terminal graceful reap** re-checks parentage before SIGKILL (the
   `GracefulBlocking` shape).
   - Review: `GracefulBlocking` is *not* safe either — it also SIGKILLs the
     snapshot list after the grace period, only returning early if every
     pid is gone. And literal parentage cannot be re-checked: once the
     leader dies its children reparent to init, so legit survivors would
     fail a parent check. Carry #9 out as **process identity**: snapshot
     `(pid, starttime)` (`services::proc_table` already parses field 22)
     and SIGKILL only pids whose start time still matches, in **both**
     `Graceful` and `GracefulBlocking`. macOS/Windows: whatever identity the
     platform `proc_table` backend has; Windows already uses
     `TerminateProcess` per pid (check it opens by pid + creation time).
10. **Dead IPC:** each of the listed commands with no caller is deleted
    (registration, `command_class` row, regenerated `commandClasses.ts`,
    `model_allowlist` row if any). `switch_project_windows` is removed from
    dispatch. A command found to have a real caller (incl. phone/server
    paths) stays and is noted. The 8 bare `#[tauri::command]` in
    `commands/connect.rs` become `cfg_attr(feature = "desktop", …)`.
    - Review: re-verified at HEAD — all 19 still have no caller in `src/`,
      `mobile-web/src/`, `src-tauri/src` (incl. MCP servers,
      `mobile_control`, `core_dispatch`), `src-core`, `src-gateway`,
      `src-serverd` or `scripts/`; none has a `model_allowlist` row. Only
      `check_pid_alive` has a unit test (`commands/apps.rs` tests) — delete
      it with the command. Drop their rows in `DOCUMENTATION.md`
      (`list_ollama_models`, `list_installable_models` ~:1005-1007,
      `set_box_relations` ~:1130) and any filemap row. `connect.rs` is a
      `#[cfg(feature = "desktop")]` module and `build.rs` already handles
      cfg-gated modules (as for `subwindow.rs`), so the attribute change is
      safe and cosmetic.
11. **Phone SW cache name** derives from content (bundle hash), not a build
    timestamp; an unchanged bundle never changes it.
    - Review: the cache name already *is* the entry chunk's hash
      (`stampServiceWorker`); what changes it is `define`
      `__APP_MOBILE_BUILT_AT__` (`new Date()`) **and**
      `__APP_MOBILE_COMMIT__` (changes every commit even when the phone
      bundle didn't) being inlined into the hashed bundle via
      `mobile-web/src/buildInfo.ts`. Both leave the bundle. Decided: the
      phone's version line becomes `v<version> · <entry hash, 8 chars>`,
      read at runtime from the page's own `/assets/index-<hash>.js` script
      URL — content-derived, and still answers "did my refresh pick up the
      new bundle" (the purpose `buildInfo.ts` states).
12. **Client ssh login allow-list provenance** (user decision, 2026-10-15,
    added during plan review). The allow-list landed in the High follow-up
    round (`commands/credentials.rs` `ssh_login_configured` /
    `ssh_login_known`: a `Caller::Client` `login: ssh` is refused unless the
    host is a stored remote project primary/worker or a global machine) is
    bypassable: a non-admin browser client can itself store a host through
    `core` commands (`create_project`, `save_projects`, `add_compute_host`,
    `patch_compute_host`, …) and then open a login to it. Decision: the
    allow-list counts only hosts added by the **desktop window or an admin
    client**. Record who added a host (provenance on the stored host entry),
    round-tripping existing state — a host with no provenance counts as
    desktop-added. A host a non-admin client stored itself gets **no login
    tab until the desktop or an admin approves it**. Also: the allow-list
    compares the address normalised (`creds::ssh_account`: trimmed, host
    case-folded, port default 22) but ssh receives the caller's raw spelling
    — the login argv must use the **stored** spelling of the matched entry.
    - Review (how): see step M4d.

## Steps (plan sections)

Every finding below was re-checked at `cb98acf9`; current anchors given.

- **M1 i18n** — all hold.
  - `stores/projects.ts`: `vpnToast()` :76-78 (use the existing
    `vpnAutoConnect.upToast` key), `Could not stop every persistent
    session` :1470, the `local   …\nremote  …` toast-path labels :1261.
  - `lib/remote/vpn/vpnAutoConnect.ts:247` (second hard-coded VPN toast;
    `upToast` used at :167).
  - `lib/remote/remoteConnect.ts:120` `— authenticate in root terminal`
    (S1 did not move it; the High follow-up round edits this file — rebase).
  - `lib/transport/wsInternals.ts:272-275` Ok/Cancel/Yes/No defaults;
    `lib/transport/clientAdapters.ts` error strings (`open_in_file_manager`,
    `refusing to open a non-web URL`, `the browser blocked the new tab`);
    `lib/calendar/calendarTime.ts` `formatTime` AM/PM (~:445) and
    `formatLongDate(…, locale = "en")` (~:453); callers pass the app
    language.
  - `components/header/AppResourceDisplay.tsx` ~:146/152 `title="CPU"`/`"RAM"`
    and the `CPU …%`/`RAM …` row text, `gpuTooltip`.
  - `mobile-web/public/sw.js` `fallbackTitle()` (~:116-119): `sw.js` is a
    static `public/` file and cannot import `i18n.ts`. Decided: the
    `stampServiceWorker` plugin (`vite.mobile.config.ts`) stamps a
    `__APP_PUSH_TITLES__` placeholder with the three fallback titles in all
    five languages, taken from `i18n.ts` keys at build time; the phone page
    writes its current language to Cache Storage (one fixed key) on load and
    on change; the worker's push handler reads it, falling back to
    `navigator.language`, then English. M1 owns that placeholder and its
    lines in `stampServiceWorker`; M6 owns the `define` block of the same
    file.
  - Dictionaries: `shortcutHelp.steeringIntro` — English has `{app}`, all
    four translations drop it (add it). `steering.popout.desc` — the
    **reverse**: English has no `{app}`, all four translations add
    `La navigazione {app} …` etc. English is the source: make the
    translations follow English (drop the extra `{app}` clause or reword it
    without the placeholder). Fix the test per #4 so both directions fail.
- **M2 dialogs** — 28 sites (#5). Desktop, as listed by the screen (17):
  `header/MobileIndicator.tsx:217`; `skills/SkillsLibraryView.tsx:207,240,262`;
  `embed/deck/DeckView.tsx:734`; `embed/ImageAnnotator.tsx:193` (prompt);
  `mail/MailPane.tsx:353`; `mobile/MobileSettings.tsx:383,432,768`;
  `mobile/MobileSetupGuide.tsx:51`; `todo/TodoBoard.tsx:370,387` (prompt);
  `todo/TodoCardDialog.tsx:155`; `projects/RemoteMachinesWindow.tsx:618`
  (was :626). **ProjectPill.tsx:2298/2300 `alert` move to M3**, which
  rewrites that block. Desktop, missed by the screen (5):
  `layout/DetachedCenterPanel.tsx:2009,2058,2107` (prompt ×3, popout
  window — `useDialogs` must render inside the popout's own tree),
  `layout/ProjectSwitcher.tsx:593`, `projects/BoxEditorDialog.tsx:99`.
  Phone (6): `mobile-web/src/screens/Terminal.tsx:4440` (interrupt
  confirm), `screens/Todo.tsx:197,211,227,231`, `mobile-web/src/api.ts:1091`
  (`alert`). Also takes `MobileSettings.tsx:751` `void invoke(...)` without
  `.catch` (from M3) since M2 owns that file. Source-scan test per #5.
- **M3 hooks/state** — all hold.
  - `layout/DetachedCenterPanel.tsx:328-333` `listen()` with no disposed
    guard (cleanup before the promise resolves leaks the listener).
  - `stores/tabs.ts`: `persistScope` :5275 swallows non-strict failures at
    ~:5379 (`// tab layout is non-critical`) → #7 once-per-session toast
    (i18n key via handoff); `closeHiddenGroup` :4161 purges link routes but
    skips `forgetPty`; `applyDetachedEdit` :4508 `case "close"` :4589 skips
    both `purgeForTab` and `forgetPty`; `retargetTabs` :3187 and
    `setTabTmuxName` :3469 build patches by hand instead of `writeScope`
    (:2441); `attachGroup` :4017 reads `entries` from `get()` before
    `set()`; `saveLayout` doc ~:5398 says "No production caller" but
    `AppShell.tsx:866` calls it on quit — **switch AppShell to
    `persistScope(scope, localFile)` with the scope it resolves `localFile`
    from** (the doc explains why `saveLayout`'s pairing is a hazard), then
    the doc is true; `deserializeTree` :2603 dereferences
    `saved.tabKeys`/`children`/`sizes` unvalidated.
  - `stores/projects.ts` ~:1903-1906: a disconnected remote project returns
    before `setSidePanelFolder` (:1919) — restore the folder before the
    early return (it needs no connection).
  - `lib/transport/wsClient.ts:255` `frame.capabilities!`.
  - `components/models/useModelsHub.ts:399` `void invoke("pause_ollama_pull")`
    without `.catch`.
  - `projects/ProjectPill.tsx:2283-2300` in-folder layout: typed guard, no
    `as never` ×4, plus its two `alert`s → PromptDialogs message (from M2).
- **M4a confinement (#6)** — `services/core_dispatch.rs`, `commands/fs.rs`
  (helper only), tests in `core_dispatch.rs` and
  `services/mobile_control/web_client.rs`. Context: per the server docs a
  `Role::User` session runs in a daemon under the user's own uid and has
  unfenced shell tabs (`pty_spawn` is `core`), so this is consistency and
  defence in depth, not the uid boundary — keep it a table, no
  command-body rewrites. Mechanism: replace `USER_CONFINED_PATH` with a
  table `(cmd, key, Kind)` checked in `confine_for_user` before the call:
  - `UserPath`: absolute path → `user_path` (empty → projects root).
  - `ProjectDir`: must canonicalize to a path inside the **user's roots** =
    `root_work_dir` ∪ the projects root new projects are created under ∪
    every project directory and mirror override in the user's
    `projects.json` ∪ every box folder (one new `fs::user_roots()` helper
    over `compute_allowed_roots`'s pieces; `user_path` switches to it too).
  - `LocalFile`: must equal a known project's `local_file` in
    `projects.json`.
  - `BodyConfined`: the body already confines (`open_confined`,
    `confine_abs_read`, `confine_project_path`, `sqlite::confine`) — listed
    so the exhaustive test passes; the implementer verifies each.
  - `Remote`: a path on an SSH/HPC host or inside a project's remote tree
    resolved from `projectId` (`confined_mirror_path`) — not the server's
    filesystem; governed by the host allow-list (High follow-up round), not
    by roots.
  - `Refuse`: refused for `Role::User`.
  The table, by kind (from the generated wrappers'
  argument keys; re-derive it from the build's `OUT_DIR/core_dispatch.rs`
  in case HEAD moved):
  - `UserPath`: `list_dir_all.path`, `list_dirs.path`,
    `import_external_file.sourcePath`, `remote_upload_file.localPath`,
    `remote_download_to.destDir`, `calendar_read_ics.path`,
    `calendar_write_ics.path`, `inspect_project_export.bundlePath`,
    `preview_project_scaffold.sourceDir`, `project_folder_exists.directory`,
    `git_clone.dest`, `git_fork_clone.dest`, `disk_usage_scan.root`,
    `set_remote_mirror_dir.path`, `move_remote_mirror.parentDir`,
    `watch_dir.path` + `.repoDir`, `exec_trust_approve.dir`,
    `claude_folder_trusted.cwd`, `compile_tex.path` + `.outDir`,
    `resolve_tex_root.path`, `tex_auto_engine.path`,
    `tex_preview_snippet.dir`, `format_source.path`,
    `formatter_available.path`, `git_merge_sides.path`,
    `hpc_ws_pull_logs.logsDir`, `git_worktree_add.path` (local site),
    `skills_install`/`skills_list_installed`/`skills_uninstall`
    `target.Project.dir` (nested — the test must list it explicitly),
    `agent_tab_changes.tabDir`, `agent_tab_transcript.tabDir`.
  - `ProjectDir`: `projectDir` of `list_dir`, `create_dir`, `create_file`,
    `delete_dir`, `delete_file`, `dir_size`, `dir_size_breakdown`,
    `extract_archive`, `rename_path`, `project_path_exists`,
    `project_search`, `project_generated_dir`, `list_project_endings`,
    `list_project_paths`, `write_project_file`, `write_project_file_bytes`,
    `import_external_file`, `update_gitignore_rule`, `usage_git_stats`,
    `python_interpreters`, `python_interpreter_for`, `hpc_ws_link`, every
    `slurm_*`, every `git_*` that takes it (≈35, incl. `git_worktree_*`);
    `srcProjectDir` + `destProjectDir` of `copy_path` and `move_path`.
  - `LocalFile`: `load_project`, `get_project_panel_prefs`,
    `set_project_panel_prefs`, `load_side_panel_folder`,
    `save_side_panel_folder`, `adopt_folder_tab_layout`, `workspace_sync`.
  - `BodyConfined` (verify): `read_file_text`, `write_file_text`,
    `file_mtime`, `file_size`, `file_source`, `detect_mime`,
    `sqlite_tables`, `sqlite_page`, `read_spreadsheet`, `copilot_complete`,
    `pdf_markup_submit`, `markup_mcp_list`, `markup_mcp_ticks` (path +
    projectId) — any that turns out not to confine moves to `UserPath`.
  - `Remote`: `ssh_list_dir`, `ssh_mkdir`, `remote_remember_path`,
    `remote_set_default_path`, `hpc_ws_*` `target`/`workspacePath`/
    `mirrorPath`/`newRoot`, `hpc_scratch_candidates`, `slurm_job_out.logDir`,
    `git_worktree_*` with a host `site`, `remote_download_size.relPath`,
    every `sync_*` `relPath(s)`, `git_peer_checkout`.
  - `Refuse` for `Role::User`: `ollama_models_dir_plan.path` (server-wide
    Ollama models dir — the class row is arguably `admin`, but M4a must not
    change classes: refuse here and note it for M5/the user).
  - Not paths (false positives of the key regex; list as exempt with
    reason): `agent_schedule_*`/`markup_mcp_*` `scheduleTargetId`, `caldav_*`
    `href`/`resourceHref`, mail `folderId`/`destFolderId`,
    `credential_paste_to_pty.target`, `git_checkout.target` (a ref),
    `set_project_git_hosting.profileUrl`, `patch_compute_host`,
    `set_project_sandbox.sourceDecision`, `skills_*` `relPath` (catalog),
    `GitWorktreeSelection.path` (validated against the repo's own worktree
    list by `selected_git_context`).
  Tests: one per kind for user vs admin; the exhaustive test walks
  `dispatchable_names()` × argument keys matching
  `path|dir|file|folder|dest|root|cwd|source|target|local` and fails on any
  unclassified pair; the `web_client` session test gains a `projectDir: "/"`
  refusal. Update the module comment, `docs/context/web_client.md` (:174-179
  says `list_dirs` is unconfined) and `web_client.rs:52` to say what is
  confined now.
- **M4b sync correctness** — read `docs/remote_sync_guide.md` first
  (lockstep/byte-sync rules).
  - #7: the 9 sites — `commands/sync.rs:820,1131,1554,1809`,
    `services/sync_auto.rs:529,550`, `services/git_peer.rs:2055,2896,2934`
    (git_peer lines moved in the High follow-up round; rebase). One
    `remote_sync` helper: on failure after a transfer, drop the cached stamp
    (as `save_manifest_at` already does for `CHANGED_ELSEWHERE`) and mark
    the paths' base unknown so the next status re-derives and a forced push
    re-asks; surface the error where the operation is user-initiated.
  - `services/remote_sync.rs:803` `replace_local_atomic`: the staged
    `NamedTempFile` is 0600 and keeps that mode. Apply the host file's mode
    (from the SFTP stat the pull already has, masked to `0o7777`, Unix
    only) before `persist`; for a file with no host mode, keep the existing
    local file's mode, else the umask default. The rsync path already
    preserves modes; add a test with a 0755 file.
  - `services/worker_sync.rs` `build_bundle` (:138-159) + caller
    (:268-290): an empty *incremental* bundle means "worker has HEAD" only
    when `exclude == head`; otherwise (mirror HEAD moved backwards or
    sideways) fall through to the full-bundle attempt so the worker is
    moved and the record matches. Keep "tracked files only, never git
    clean".
- **M4c process/locks** — `storage.rs` `FileLock` (#8, ~24 call sites in
  `services/{workspace,calendar_alarms,agent_home,remote_sync,agent_prompts,
  terminal_service,agent_auth,agent_tasks,timer_lease,process_lease}.rs`,
  `commands/{calendar,boxes}.rs`, `services/brand_migration/persisted.rs`,
  `storage.rs:98`); `terminal/mod.rs` `reap_pids` :1313-1349 (#9 identity
  check, both graceful modes; `teardown_taken` :1762 already invalidates the
  cache); `services/mail_engine.rs:79-89` `with_platform_verifier().expect()`
  inside the `OnceLock` → store a `Result` and answer every connect with the
  error. `agent_prompts.rs` has an uncommitted edit from another session at
  review time — rebase onto whatever lands.
- **M4d client ssh login provenance (#12)** — checked at `2f0569c5`
  (develop, follow-up round landed).
  - Where provenance lives: `schema/project.rs` `RemoteSpec` (it already has
    a `#[serde(flatten)] extra`, and `ComputeHost` flattens `RemoteSpec`, so
    one field covers primaries and workers; an older build keeps the field
    through `extra`). Add e.g. `added_by_client: Option<bool>` (absent /
    `false` = desktop or admin; `true` = a non-admin client stored it and no
    one approved it). Global machines need nothing: every
    `global_machine_*` writer is classed `admin`.
  - Who is admin inside a command body: today nobody — `Caller` is
    `System`/`Local`/`Client(id)` and the `Role` stops at
    `core_dispatch::dispatch`. Carry the session role into the `CoreCtx`
    the transport builds (`src-core` `ctx.rs` + `web_client.rs`, fixed at
    login like the role itself, never read from a frame), with a helper
    "is an untrusted client" = `Caller::Client` and role ≠ admin. `System`
    and `Local` are trusted.
  - Stamp at every writer of a `RemoteSpec`/`ComputeHost` address
    (user/host/port) reachable by a client: at least `create_project`,
    `import_project`, `extend_project_to_remote` (all `req`),
    `save_projects` (whole list — compare against the stored entries:
    unchanged addresses keep their provenance, new or changed ones are
    stamped; an incoming value of the field from a client is ignored, never
    trusted), `add_compute_host`, `patch_compute_host` (its `user` change is
    a new address), project-transfer/bundle import if it writes hosts. The
    implementer greps every write of these structs and lists them in the
    handoff; a test drives each writer as an untrusted client.
  - `remote::configured_project_ssh_addresses` (services/remote.rs) skips
    stamped entries; `ssh_login_known` returns the matched stored
    `(user, host, port)` instead of `bool`, and `apply_login_with` builds
    the argv from it (fixes the raw-spelling half of #12).
  - Approval: one new command (e.g. `approve_client_ssh_host
    {projectId, hostId}`) classed `admin` (the desktop is always allowed;
    a user client is refused by class), clearing the stamp. Its class row
    and `commandClasses.ts` regeneration are coordinated with M5 (row in the
    handoff; regenerated once at the tip). Desktop UI: a "Allow logins to
    this host" action plus a pill where the host is shown
    (`RemoteMachinesWindow.tsx` / the project's remote settings), i18n keys
    via handoff, `UntestedTag` + `untested.ts` row. A refused login tells the
    user why (i18n'd refusal text naming the approval).
  - Not covered by #12 (noted, not changed): non-login `core` ssh commands
    (`ssh_connect`, `ssh_probe`, `ssh_list_dir`, `ssh_host_key_preview`, …)
    still dial a host a user names — that is how a user sets up a project,
    and no saved secret is pasted there.
  - Tests: the bypass (user client stores a host, login refused; desktop
    approves, login allowed); legacy entry without the field allowed; a
    client `save_projects` cannot clear a stamp; argv uses stored spelling
    for a caller spelling `Host.Example ` with different case/whitespace.
    Update `docs/context/remote_credentials.md` (the follow-up round's
    allow-list paragraph).
- **M5 dead IPC + deps** — #10 as reviewed. Unused deps confirmed:
  `src-tauri/Cargo.toml:112` `chrono-tz`, `:215` `idna`, `:307` `ipnet`
  (only `src-core` uses them; `mail_sanitize.rs` mentions `idna` only in
  text — check). Remove, `cargo build` both feature sets, `Cargo.lock`
  churn expected.
- **M6 repo/CI**
  - `ci-cd.yml:238` daemon clippy `cargo clippy -p app-serverd -- -D
    warnings` → add `--all-targets`; `scripts/ci-local.sh` mirrors ci-cd
    steps by exact text (`--check-drift`), so update its STEPS entry in the
    same commit. Leave `:421`/`:501` `continue-on-error` (#2).
  - Delete `docs/start-tabtivity-tauri-hotreload.sh` (worse than stale:
    `ROOT` is `docs/`, so it runs `npm run tauri:dev` in the wrong folder);
    `docs/guide/building.md:47-49` points at the root launcher
    `start-tabtivity-tauri-hotreload.sh`. Leave `docs/TabtivityHotReload.desktop`
    (already points at the root script) and the rest of
    `docs/root_cleanup_plan.md` (that plan lists this deletion; tick it
    there).
  - #11 as reviewed: remove both `define`s from `vite.mobile.config.ts`
    (~:113-116), `buildInfo.ts` reads the entry hash at runtime; keep
    `headCommit()` only if still used. Test: two builds of an unchanged tree
    give the same `sw.js` cache name.
  - `package-lock.json` root `version` (top + `packages[""]`, 0.2.9 vs
    0.2.12): sync it; `scripts/bump-version.sh` bumps it too (jq, both
    spots); **and add `package-lock.json` to `bump_files` in
    `.githooks/pre-push` (:216, from the High follow-up round)** so the
    bump commit and its rollback include it.
- **M7 small dedupes** — `useDiskReloadPoll` (#3): the copies are in
  `GifView.tsx` (~:97/114), `OdtView.tsx`, `FileViewerPane.tsx` ×3,
  `pdf/PdfPresentApp.tsx` (~:268/319), `pdf/PdfViewer.tsx` (~:3378-3386);
  check `deck/DeckView.tsx` (also polls `file_mtime`) and count again
  before claiming 7. Single agent CLI list (#3 review): `tabs.ts:6099
  AGENT_CMDS`, `tabs.ts:6229 RESUMABLE_AGENTS`,
  `components/tabs/newTabItems.ts:53 AGENT_ITEMS`, backend
  `commands/agents.rs` `AgentSpec`.

Every step: regression tests where testable; `scripts/gates.sh` for touched
gates; green commits.

## Organisation

Shape: **mixed risk, disjoint subsystems.** Ten implementers in separate
worktrees (`.claude/worktrees/med-<step>`), never more than 5 agents at
once and at most 3 cargo-heavy at once. M4 was split (review): as written it
was ~10 sites across 8+ files plus a 150-command confinement table — well
over the ~1.5-day / ~3-large-file budget. #12 (added during review) is its
own step M4d: a schema field, a ctx role, ~7 writers, a new command and a
UI action are a full agent's worth.

- Wave 1: M1, M2, M4a, M4b, M5 (cargo-heavy: M4a, M4b, M5).
- Wave 2 (as slots free): M4d (after M4a merged — both touch
  `web_client.rs`), M4c, M6, M7, M3 (cargo-heavy at once: at most three of
  M4c, M4d and the M4a/M4d reviewers).
- Reviews: M4a and M4d (security) each get an independent finder then
  verifier; M4b
  (sync semantics, `remote_sync_guide.md`) one reviewer; M3 (store races)
  one reviewer; M1, M2, M4c, M5, M6, M7 are covered by the final review.
- Total: 1 plan reviewer + 10 implementers + 6 step reviewers + 1 final = 18.

Hot shared files: `src/lib/i18n.ts` (and `src/lib/i18nDicts/*`) is **owned
by M1**; M2/M3/M7 that need new keys list them in their handoff, and the
main agent adds them at merge (or they reuse existing keys).
`services::command_class` + `commandClasses.ts` are owned by M5 (M4a must
not add/remove commands or change a class; it notes `ollama_models_dir_plan`;
M4d's one new `admin` command gets its row from the handoff at the tip).
`src/lib/untested.ts` and the filemaps: list rows in the handoff.
Region splits: `stores/projects.ts` M1 (strings :76, :1261, :1470) vs M3
(:1903-1919); `vite.mobile.config.ts` M1 (`stampServiceWorker`) vs M6
(`define`); `stores/tabs.ts` M7 (:6099-6240) vs M3 (rest);
`DetachedCenterPanel.tsx` M3 (:328) vs M2 (:2009-2107); `ProjectPill.tsx`
and `MobileSettings.tsx` each have one owner (M3, M2).
`services/remote_sync.rs`: M4b owns it; M4c touches only its two
`FileLock` lines and merges after M4b. `web_client.rs`: M4a (tests, doc
comment) then M4d (role into the ctx). `RemoteMachinesWindow.tsx`: M2
(:618 confirm) vs M4d (approval action) — different regions.

Merge order: M5 → M4a → M4d → M4b → M4c → M6 → M1 → M2 → M7 → M3, then
regenerate `commandClasses.ts` once and run `scripts/gates.sh --all` on the
tip.

### Agent steps

| Agent | Plan section | Main files | Review |
|---|---|---|---|
| A-M1 | M1 | `src/lib/i18n.ts` + `i18nDicts/*`, `stores/projects.ts` (strings), `lib/remote/{remoteConnect,vpn/vpnAutoConnect}.ts`, `lib/transport/{wsInternals,clientAdapters}.ts`, `lib/calendar/calendarTime.ts`, `mobile-web/public/sw.js` + `stampServiceWorker`, `AppResourceDisplay.tsx`, `src/__tests__/shell/i18n.test.ts` | final |
| A-M2 | M2 | the 22 desktop sites (incl. `DetachedCenterPanel`, `ProjectSwitcher`, `BoxEditorDialog`), 6 phone sites, `PromptDialogs` usage, scan test | final |
| A-M3 | M3 | `stores/tabs.ts`, `DetachedCenterPanel.tsx` (listen), `AppShell.tsx` (quit save), `stores/projects.ts` (side panel), `wsClient.ts`, `ProjectPill.tsx`, `useModelsHub.ts` | 1 reviewer |
| A-M4a | M4a | `services/core_dispatch.rs`, `commands/fs.rs` (`user_roots` helper), `web_client.rs` test, `docs/context/web_client.md` | finder + verifier |
| A-M4b | M4b | `commands/sync.rs`, `services/{sync_auto,git_peer,remote_sync,worker_sync}.rs` | 1 reviewer |
| A-M4d | M4d | `schema/project.rs` (`RemoteSpec`), `src-core` `ctx.rs` + `web_client.rs` (role), `commands/credentials.rs`, `services/remote.rs`, the host writers (`commands/projects.rs`, compute-host commands), new `admin` command, `RemoteMachinesWindow.tsx`/remote settings UI, `docs/context/remote_credentials.md` | finder + verifier |
| A-M4c | M4c | `storage.rs` + `FileLock` callers, `terminal/mod.rs`, `services/mail_engine.rs` | final |
| A-M5 | M5 | `lib.rs`, `services/command_class.rs`, the dead commands' modules, `DOCUMENTATION.md` rows, `src-tauri/Cargo.toml`, `connect.rs` | final |
| A-M6 | M6 | `.github/workflows/ci-cd.yml`, `scripts/ci-local.sh`, `docs/guide/building.md`, `vite.mobile.config.ts` (`define`), `mobile-web/src/buildInfo.ts`, `scripts/bump-version.sh`, `package-lock.json`, `.githooks/pre-push` | final |
| A-M7 | M7 | the viewer files + new hook on `usePoll.ts`, `stores/tabs.ts` (AGENT_CMDS/RESUMABLE_AGENTS only), `newTabItems.ts`, generated agent table + its Rust test | final |

## Verification

- Gates per agent; `scripts/gates.sh --all` on the merged tip; brand and
  privacy checks; Windows/macOS cross-checks for M4a–M4d and M5
  (cfg/spawn, process identity, command registration).
- `npm run backend:stale` after landing; `npm run mobile:bundle` for M1/M2/M6
  phone changes.
- Not run live. Click-through list assembled from the handoffs at landing.

## Plan review (2026-10-15)

Checked every Medium against `cb98acf9` (develop + High follow-up round).
Changes made to this plan:

- **Still holds:** every finding not listed below. Anchors updated in place
  (projects.ts, wsClient, tabs.ts, Cargo.toml, ci-cd.yml, git_peer, …).
- **Already fixed / not an issue:** `save_project` and git.rs `/bin/sh`
  (decision 1, re-confirmed: no `save_project` anywhere). `remoteConnect.ts`
  toast was *not* moved by S1 (still :120). The "8 bare `#[tauri::command]`"
  are harmless (desktop-only module) — kept as a convention fix.
- **Finding corrected:** `steering.popout.desc` drops `{app}` in *English*,
  not the translations (the translations add it); test must compare both
  directions. Native dialogs: 17 listed (not 14) + 5 unlisted desktop +
  6 phone. `save_manifest`: 9 ignored sites, not 4. ci-cd daemon clippy is
  :238 and `ci-local.sh --check-drift` must change with it.
- **Design flaws flagged and resolved by sharpening (no decision undone):**
  #6's gap is far wider (every `projectDir` unchecked) — full table in M4a;
  #9's "GracefulBlocking shape" is not safe and parentage can't be re-checked
  after reparenting → pid + start-time identity; #8 contradicts a documented
  deliberate design → error classification + explicit fallback API; #11's
  commit `define` also breaks "unchanged bundle never changes it" → entry
  hash shown instead of commit/time; `sw.js` cannot use `i18n.ts` →
  build-stamped title table + language hint in Cache Storage; `saveLayout`
  on quit (AppShell) is the hazard its own doc describes → switch to
  `persistScope`; `useDiskReloadPoll` builds on `usePoll.ts`; agent CLI
  table generated from the backend.
- **Missed sibling:** `package-lock.json` must join `bump_files` in
  `.githooks/pre-push` (follow-up round's rollback), else every bump leaves
  the lockfile behind again.
- **Added (user decision, relayed by the coordinator during review):**
  Fixed decision #12 — client ssh login allow-list provenance + stored
  spelling for the argv — and step M4d carrying it out. Design points the
  review decided: provenance as one optional field on `RemoteSpec` (covers
  workers; survives older builds via `extra`); the session role must reach
  command bodies via `CoreCtx` (today `Caller` has no role); a client's
  incoming provenance value is never trusted; approval is one new
  `admin`-class command + a desktop action.
- **Organisation:** M4 split into M4a (confinement), M4b (sync), M4c
  (locks/reap/mail), plus M4d (#12); ownership fixed for `ProjectPill.tsx` (M3),
  `MobileSettings.tsx` (M2), `vite.mobile.config.ts` regions, `remote_sync.rs`;
  merge order and totals updated (18 agents); the High follow-up round has
  landed (`2f0569c5`), branch from there.

Not blocking (decided, user may override): #6 is defence in depth — a
`Role::User` already has unfenced shell tabs under their own uid, so the uid
is the real boundary; the plan keeps the fix but as one dispatcher table, not
body rewrites. `ollama_models_dir_plan` is classed `core` but acts on the
server-wide Ollama dir — refused for users in M4a; reclassifying it `admin`
is left for a later class review. The phone's version line loses the commit
and build time (entry hash instead).

**BLOCKING questions:** none.

## Decision change (2026-10-15, after the M4d security review)

Fixed decision #12 is **replaced**: a non-admin `Role::User` client only
exists on a per-user daemon behind the gateway, which has no desktop window
and is unreachable from the admin's browser — nobody could approve its hosts,
and that user already has unfenced shell tabs. So on a per-user daemon **the
account owns its own hosts**: no provenance stamp, no approval command or UI.
Kept from M4d: the client ssh login argv uses the **stored** spelling of the
matched host/user/port, and the earlier "only stored hosts" check stays as a
typo guard. Role plumbing into `CoreCtx` is kept only if something still
uses it; otherwise removed.
