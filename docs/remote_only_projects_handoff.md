# Remote-only projects — handoff

Plan: `docs/remote_only_projects_plan.md`. Base: develop 70344a96b87026a1e2d3fe2b385ce98676587046 (2026-10-28).
Integration branch: `ro-int` (main agent merges each step into it).

Each agent step appends its own section below (never edits another's):
shas, choices, gotchas, gate status + test counts, **Hot-file edits**
(i18n keys, `untested.ts` rows, `command_class` rows, filemap rows — listed
here, not made, for parallel steps), **Flagged for user**.


## A1 — engine contract (E1, E2)

Branch `ro-a1`, commit **b7e05ab9** (on 70344a96).

**What landed**
- `schema/project.rs`: `RemoteSpec.remote_only: Option<bool>` (skip-if-none) and `RemoteSpec::is_remote_only()` = `remote_only.unwrap_or(vm == Some(true))`.
- `services/remote.rs`: `local_copy_in(entry, state_dir) -> Option<PathBuf>` (pure: explicit `extra["mirror"]` via `fs_confine::mirror_override_dir`, else `default_mirror_dir_in`; `None` for a remote-only/VM project **and for a local project**), and `pub fn remote_only_refusal(what) -> String` = `"{UPPER}_REMOTE_ONLY: {what}"`. Every later step should build its refusal with it.
- `remote_sync::mirror_dir_opt(id)`: `None` iff the registry spec is remote-only, else exactly `mirror_dir(id)` (also on an unreadable registry, like `mirror_dir`).
- Workers: `remote_only` is set to `None` in `patch_compute_hosts` (the one worker writer) **and** in `remote::compute_hosts_from_value` (the one reader), so a stale worker flag can never pin.
- `CreateProjectRequest` / `ImportProjectRequest`: top-level `remote_only: bool` (`remoteOnly`, `#[serde(default)]`), deserialized only.
- `launch_prep`: `vm_spawn_refusal` → `Pin::{None, RemoteOnly, Vm}` (`Pin::of(spec)`; VM wins over its flag) + `pinned_spawn_refusal(pin, running, local_only, tab)`. VM messages/`_VM_DOWN` unchanged; remote-only refuses `local_only` with `_REMOTE_ONLY`. The mirror-cwd step now goes through `local_tab_mirror(entry, state_dir)` (`local_copy_in` + mkdir), which returns `None` for remote-only, so it can never mint a mirror even if the refusal were bypassed (it then errors with the sentinel).
- `set_project_run_host` refuses `"local"` for a remote-only project (`run_host_refusal`, pure).
- `agent_host_move::move_session` refuses either end being this machine for a remote-only project (`local_side_refusal`, pure); `side(None)` resolves through `mirror_dir_opt`.

**Choices**
- `create`/`import`/`extend` call a new `strip_renderer_posture` that drops a `remote_only` sent *inside* `req.remote` now (security rule 1), but A1 does **not** write `Some(true)` from `remoteOnly` — doing so without E6b's no-mirror path would leave an orphaned mirror. **A7/E6b: set `spec.remote_only = Some(true)` from `req.remote_only` (non-VM) right after the strip, and drop the "until that lands … plain Remote" clause in the field doc comments.** Extend always strips (D7: Local → Remote-only is later).
- VMs inherit every refusal (remote-only by default): local run host and local agent moves are now refused for VM projects too (sibling fix; both used to be allowed and would mint/ use the empty default mirror).
- No shared fixture work for A1: the plan gives `tabLocality` (incl. its Rust reader line) to A2 and `projectHostReach` to A8.

**Gotchas for later steps**
- Adding a field to `RemoteSpec`/request structs breaks struct literals in `src-tauri/tests/projects_commands.rs` too (16 literals there; `ImportBundleRequest` is a different struct).
- `local_copy_in` answers `None` for a local project; callers that also handle local projects must keep their own local branch.

**Gates** (`scripts/gates.sh`, diff vs 70344a96): brand PASS, whitespace PASS, clippy (desktop) PASS, clippy-dlib PASS, clippy-dmn PASS, `cargo test -p tabtivity -p app-serverd` PASS (5006 passed, 0 failed, 7 ignored), test-dlib PASS. No frontend change (lint/build/vitest skipped). `backend:stale` not run (brief forbids it).

**Hot-file edits** (made, as the only backend step): `docs/filemap_backend.md` rows for `services/remote.rs`, `remote/remote_sync.rs`, `launch_prep.rs`, `remote/agent_host_move.rs`. No new command → no `command_class` row, no `commandClasses.ts` regen. No i18n / `untested.ts` edits.

**Flagged for user**: none.

## A2 — cockpit contract (F1 + tabLocality fixture)

Branch `ro-a2`, commit **c5571992** (one commit on 70344a96).

**Landed**
- `src/lib/projectTabHost.ts`: `isHostPinned(p)` = `vm.enabled || (remote.remote_only ?? remote.vm === true)`,
  over a structural `HostPinProject` (`vm?`, `remote?: Partial<RemoteSpec>`), so `stores/tabs/tabLocation`
  can call it. `REMOTE_ONLY_SENTINEL` = `${BRAND.upper}_REMOTE_ONLY`; `remoteOnlyRefusal(err)` → the
  translated line `tabs.remoteOnlyRefused` when the text has `<SENTINEL>:`, else `null` (raw text never shown).
- `RemoteSpec.remote_only?: boolean` in `src/types/index.ts`.
- Rename `vmProject` → `hostPinned` everywhere (effectiveTabLocation, tabTerminalSpawn, TabPane prop, PaneSlot,
  closeRemoteTab ×3, stores/projects ×2, agentClearUndo, MobileBridgeHost, tabLocation.hostTabId); every caller
  now passes `isHostPinned(project)` instead of `vm.enabled`.
- Pin fixes: `TabLocalityBadge` / `LocalityMenu` / `tabLocation()` take `pinned`; a pinned menu is the
  machine list alone (header is a hint row with `tabLocality.pinnedHostTitle`, no Local row, no way back to
  root). `RunHostPicker` takes `pinned` (stored `"local"` pref reads as the primary; opens on machines) and its
  3 call sites (ProjectFilesView ×2, TextView) pass it. `TabHoverCard` takes `hostPinned`; `useSessionPicker`
  reads the pin from the projects store by the ptyId's scope. TabBar + DetachedCenterPanel pass the pin to badge,
  menu, hover card and the "+" machine list.
- `TerminalView`: the four `[spawn error: …]` writes go through `spawnErrorNote(err)`, printing the
  `remoteOnlyRefusal` line (yellow) when it maps.
- Phone (window side): `phoneReachesTab` → a pinned *remote* (not VM) reaches nothing; `phoneListsTab` already
  lists every remote tab. VM keeps today's rule.
- Fixture `src/__tests__/mobile/tabLocality.fixture.json`: column `vm` → `pinned`, 5 rows added (19 rows).
  Readers: `MobileTabLocality.test.ts`, `MobileTabReach.test.ts` (pinned rows → the VM project, plus a
  remote-only "lists all, reaches none" test), and **Rust**
  `src-tauri/src/services/mobile_control/discovery/tests.rs` `the_tab_locality_rule_matches_the_windows_table`:
  `row["vm"]` → `row["pinned"]` (the 2-line change; `tab_is_local`'s own param name `vm_project` untouched).
  `projectHostReach.fixture.json` NOT touched (the plan gives those rows to A8).

**Choices**
- The pin keeps a worker location: `hostPinned` turns unset/`local`/anything non-remote into `"remote"`, but a
  stored `host:<id>` stays (remote-only projects may have shared-fs workers, D4; collapsing would respawn a
  worker tab on the primary). A VM has no workers, and `hostTabId` still falls back to the primary for an
  unknown worker. Fixture rows for it agree on both sides (non-local either way).
- The "+" machine gates moved to the predicate by dropping the Local row (`agentMachines({ pinned })`) rather
  than hiding the list; `agentMenuEntries` shows no ▾ for a list of one (a VM: its primary alone = today's
  behaviour). So a remote-only project with workers still gets primary + workers.
- `localTabCwd` takes `hostPinned` (PaneSlot + DetachedCenterPanel terminalCwd): a pinned agent tab no
  longer spawns with the mirror as cwd (the "+" local-rows sibling bug's cwd half). The disconnected Files-tab
  browse dir (`filesProjectDir`) is left to A10/F4.
- `carriesAcrossHosts` keeps its `vm.enabled` exclusion (plan: host⇄worker moves still work for remote-only);
  `agentWorktreeSwitch` unchanged (already `!remote`).
- `phoneCreateVerdict` / `phoneProjectFolder` for remote-only left as-is (still "agents"/mirror path): F8/A8.

**Gotchas**
- `src/__tests__/shell/i18n.test.ts` requires **every language** to hold every key, so de/es/fr/it got the two
  new keys too (AGENTS.md says English only — the test is stricter).
- A weak-type TS error appears if `HostPinProject.remote` is `Pick<…"remote_only"|"vm">` (all-optional): keep
  `Partial<RemoteSpec>`.
- The commit hook printed "MOBILE BUNDLE IS STALE" — worktree mtimes, no `mobile-web/` file changed here.

**Hot-file edits (made, single frontend step)**
- i18n (en + de/es/fr/it): `tabLocality.pinnedHostTitle`, `tabs.remoteOnlyRefused`.
- `src/lib/untested.ts`: `tabLocality.pinnedHostTitle` (tabs · pinned locality menu / Run: picker).
- `docs/filemap_frontend.md`: `lib/projectTabHost.ts` row (isHostPinned, remoteOnlyRefusal, `pinned` column).
- No `command_class` change.

**Gates** (`scripts/gates.sh`, worktree): all PASS — brand, whitespace, lint-fe (0 errors; 28 warnings, none on
lines touched), clippy ×3, build, vitest `--changed` (724 files / 6757 tests), cargo test -p tabtivity -p
app-serverd, test-dlib. Rust fixture reader verified directly (`the_tab_locality_rule…` ok).
`backend:stale` not run (brief); only a Rust test file changed. Not run live.

**Flagged for user**
- None blocking. Note for A8: the window now says a remote-only tab is never reachable here (incl.
  `local_agent`); the sidecar's `runs_on_this_machine` must match once E7 reads `remote_only`.

## A10 — file panel (F4)

Branch `ro-a10`, commit **c35ce6da** (one commit on ro-int e5f55e2f = A1 + A2).

**Landed**
- `sidePanelViews.ts`: `SidePanelViewGates.mirror`; `orange` = `project && remote && mirror`, `sessions` unchanged.
  `ProjectFilesView` passes `!isHostPinned(project)`, `AppShell`'s edge rail passes `!activePinned` (same predicate).
- `ProjectFilesPane`: `useFileSource` / `useIndependentFileSource` read the pin from the projects store
  (`useHostPinned(projectId)`): pinned → always `"remote"`, no latch, `setSource` a no-op (a stored `"local"` is
  ignored, nothing persisted). Main pane: `treeDir = projectDir` (the mirror is never resolved), the whole-tree sync row
  (auto-sync all / Large folders… / Sync all) is not rendered, disconnected shows the `file-tree-empty` Connect prompt
  with `projectFilesPane.disconnectedHostOnly` ({host} = `remote.label || remote.host`) and no Local escape.
  `BoxRootSection` (a pinned member): no FileSourceSwitch, no ⧉, the same host-only prompt, `GitHistory hostPinned`.
- `ProjectFilesView`: FileSourceSwitch hidden, the compact source row not rendered, ⧉ hidden, `GitHistory hostPinned`.
- `FileTree` / `useFileTreeRemote`: the hook returns `hostPinned` and `syncTracked` (`(remoteListing || treatLocal) &&
  !hostPinned`; `treatLocal` forced false on pinned, `mirrorRoot` null). Every row slot, folder slot, tooltip
  exclusion, "Sync to local / Stop syncing" and auto-sync/exclude rows read it; `SyncMirrorSkips` and the sync-status
  refresh/poll are off on pinned. The local `compile_tex` rows are hidden on pinned. A stale `"local"` run-host pref
  reads as unset (primary) for the ▶ runs, matching A2's `RunHostPicker`. The search hint on pinned says
  `fileTree.searchHostOnlyHint` instead of "switch the source to Local".
- `GitHistory`: `hostPinned` prop → `lockstepEligible` false (no `git_peer_status`), no host/mirror worktree site dropdown.
- `QuickOpen` / `ContextFilePicker`: a pinned project lists nothing (no `list_project_paths` call) and shows
  `quickOpen.hostOnly`. The picker matches `listDir` against the registry's `resolveProjectDirectory` exactly.

**Choices**
- `GitHistory` got `hostPinned` instead of the plan's `remote={!pinned}`: `remote=false` would also flip
  `canOpenFiles` to true (GitPullPanel/GitMergeBar would open conflict files at state-dir paths) and drop the
  "host" site label. Same outcome for lockstep.
- **Sibling fix, wider than "pinned"**: native drag-out (`handleEntryDragStart`, the mid-drag Ctrl handoff
  `toNativeDrag` in `fileTreeDrag.ts`), embedded OS apps (`isEmbeddable`) and the external open (Shift-open, or a file
  with no built-in viewer → `fileTree.hostFileExternal*` message pointing at "Download to…") are gated on
  `remoteListing`, i.e. also the Remote side of a plain remote project — `start_file_drag`/`open_file` have no remote
  handling and were handed host paths there too. In-app drags to tabs/folders unchanged.
- **Search / quick open left off on pinned** (A6 not in): `canSearch` stays `!remoteListing`; QuickOpen and
  ContextFilePicker short-circuit. No HPC retry, no connected gate yet (nothing is called).
- The FileTree's local TeX compile rows are hidden on pinned rather than wired to A11's host build tab.

**For A6 (host search)**: flip `canSearch` to `!remoteListing || hostPinned` (gated on `!remoteBlocked`) in
`FileTree.tsx`, pass the project `directory` + `relRoot` (folder scope) in `FileTreeSearch`, wrap in
`withHpcConfirm` + one `confirmed: true` retry; drop the `hostOnly` short-circuits in `QuickOpen.loadFiles` and
`ContextFilePicker` (add the connected gate + HPC retry there); then `fileTree.searchHostOnlyHint` and
`quickOpen.hostOnly` become unused — delete them from all five i18n files.
**For A11**: `PaneSlot` `filesProjectDir` (the Files-tab `FileBrowser` browse dir while disconnected) still resolves
the mirror for a pinned project — your F6 `holdRemoteTerminal` hold of every pinned pane covers it; if not, pass
`hostPinned` to that `localTabCwd` call. `ViewerHeader`'s `AutoSyncHeaderToggle` and `FileViewerPane`'s
`TabSourceBadge` controls are yours (F5). FileTree's `.tex` Compile rows are hidden on pinned (`!hostPinned`) — wire the
host build tab there if wanted.

**Gotchas**
- `FileTree` looks its project up itself (`useFileTreeRemote`), so callers need not pass the pin; `syncSource` "local"
  is ignored on a pinned project.
- The registry test fails on an `UntestedTag` call site without a `untested.ts` row, so no pills were added here —
  see Hot-file edits.

**Gates** (`scripts/gates.sh`, diff vs e5f55e2f): brand PASS, whitespace PASS, lint-fe PASS (0 errors; the 2
warnings on touched files are pre-existing `ProjectFilesView` exhaustive-deps lines), build PASS, vitest `--changed`
PASS (724 files / 6764 tests). New/changed files run directly: `HostPinnedFilePanel.test.tsx` 6,
`SidePanelViews.test.ts` 3, `FileSourcePref.test.ts` 15 (4 new), `FileTreeSearch.test.tsx` 9 — all pass. No Rust
change (cargo gates skipped). Not run live.

**Hot-file edits**
- i18n, MADE (one contiguous block per file, right after `"projectFilesPane.disconnected"` in en/de/es/fr/it):
  `projectFilesPane.disconnectedHostOnly`, `fileTree.hostFileExternalTitle`, `fileTree.hostFileExternalBody`,
  `quickOpen.hostOnly`, `fileTree.searchHostOnlyHint`.
- `src/lib/untested.ts`, NOT made — rows + pills to add at merge (markup and row together, or the registry test fails):
  - `projectFilesPane.disconnectedHostOnly` { area: "files", what: "Remote-only or VM project, disconnected · the file
    panel shows a Connect prompt saying the files live only on the host, with no Local copy to browse" } — pill beside
    the prompt line in `ProjectFilesPane` (both the main pane and `BoxRootSection`).
  - `fileTree.hostFileExternalTitle` { area: "files", what: "Host file list (remote-only/VM, or the Remote side of a
    remote project) · Shift-opening a file, or opening one with no built-in viewer, explains it is on the host and
    points at Download to… instead of launching an app; Ctrl-dragging a file out of the window does nothing" } —
    pill in the message body (`FileTree.openEntry`).
  - optional `sidePanelViews.pinned` { area: "files", what:
    "Remote-only or VM project · the side panel and edge rail offer no Diverged view, no Local/Remote switch, no ⧉ and
    no sync row; the tree has no ↓/↑ sync slots" } — pill on the header row where the switch used to be.
- `docs/filemap_frontend.md`, NOT made — one-line touches if the rows exist: `components/files/sidePanelViews.ts`
  (+ `mirror` gate), `components/files/useFileTreeRemote.ts` (+ `hostPinned`, `syncTracked`).
- No `command_class` change (no new command).

**Flagged for user**
- The drag-out / external-open gate also applies to the Remote side of plain remote projects (they were handed host
  paths before; now a message points at Download to…). Say if a plain remote should keep trying the OS open.

## A1 review — verifier

Branch `ro-a1`, fix commit **ff402308** (on b7e05ab9). Finder: `a1_findings.md` (0 High, 1 Medium, 4 Low, 3 Info). I checked each finding against the code.

**M1: a VM with an explicit `remote_only: false`. Confirmed, fixed.** `is_remote_only()` was `remote_only.unwrap_or(vm)`. For `{vm:true, remote_only:false}`, `Pin::of` still refused a local spawn, but `local_side_refusal`, `run_host_refusal` and `local_copy_in`/`mirror_dir_opt` treated the VM as having a mirror. That let `agent_tab_move_host(to=None)` write a VM transcript into this machine's agent home. Fix: `is_remote_only()` = `vm == Some(true) || remote_only == Some(true)`, so VM outranks the flag in every consumer. Regression cases were added to the schema round-trip test, `local_copy_in_resolves_per_posture`, the move-refusal test and the run-host test.
- **Choice (D1 wording):** D1/engine rule 1 states the formula `remote_only.unwrap_or(vm == Some(true))`. The new one differs only on `{vm:true, remote_only:false}`, which v1 never writes (the plan review says a VM's `remote_only` is never written). So nothing written in v1 changes, and the new formula fails closed for hand edits and imported bundles (`project_transfer` copies `remote` raw). The plan's D1 text should be amended to "VM outranks". The later VM opt-in mirror (G.26) therefore cannot be encoded as `remote_only:false` on a VM. It needs its own field, and it is out of this plan anyway (manual-pull-only).

**L1: `mirror_dir_opt` fails open. Confirmed, fixed.** It returned `Some(default mirror)` for a local project, an unknown id, and an unreadable registry, so it was not the twin of `local_copy_in`. It is now `project_entry(id).ok().and_then(|e| local_copy_in(&e, &storage::state_dir()))`. That is one rule: `None` for remote-only, local, unknown or unreadable. For a plain Remote it returns the same value as `mirror_dir` (same trimmed `extra["mirror"]`, same default). The only current caller, `agent_host_move::side`, is unaffected. Regression: the by-id asserts in the new integration test (plain Remote → its mirror; local project and unknown id → `None`).

**L2: refusal-before-mirror ordering not pinned. Confirmed (the plan requires this test), fixed.** New `launch_prep` source scan `prepare_refuses_a_pinned_spawn_before_the_mirror_step`. Inside `prepare`, `pinned_spawn_refusal(` must come before `local_tab_mirror(`, and no `mirror_dir` / `local_copy_in` / `local_tab_mirror` may appear before the refusal.

**L3: strip call sites tested only through helpers. Confirmed gap, fixed.** New integration test `a_renderer_sent_remote_only_is_never_stored` (`tests/projects_commands.rs`). `create_project_blocking` with `remote.remote_only = Some(true)` stores no `remote_only` in either `projects.json` or `project.json`. `add_compute_host` with a worker `remote_only: true` returns and stores none. Import/extend still rely on the helper test; they share the same one-line call.

**L4: a non-bool `remote_only` makes the whole spec unparseable, so the project reads as local. Not fixed, flagged.** This is the general typed-field risk: a non-bool `vm` already does the same thing to a VM today. Only a hand edit or a crafted bundle can reach it. The fix belongs to whatever validates imported `remote` specs (A5/`project_transfer`), not to a one-off lenient deserializer.

**I1: `req.remoteOnly` is parsed and dropped. Rejected for now.** No frontend sends it until A9/F2, and A9 depends on A7/E6b, which writes the flag (see A1's Choices). No interim refusal is needed.

**I2: `commands::fs` `is_under_mirror` routing. Flagged** (plan inventory gap for E5/F4). A renderer path under a remote-only or VM project's default mirror path is read and written on the local fs, and a write can mint the folder. A5/A10 should route these sites through `mirror_dir_opt`.

**I3: a VM's stored run host `"local"`. Flagged** for F1/A2. It is not migrated, and `runHostPref.set` updates the store before the backend refuses. The spawn guard still refuses it.

**Hot-file edits / cross-step**
- `docs/filemap_backend.md` row `remote/remote_sync.rs` (not edited, hot file): change "`mirror_dir_opt` is `None` for a remote-only project" to "`mirror_dir_opt` = `local_copy_in` by id (`None` for remote-only, local, unknown or unreadable)". Row `remote.rs`: "`None` when `RemoteSpec::is_remote_only` (a VM always; else `remote_only == Some(true)`)".
- **TS `isHostPinned` (ro-a2, `src/lib/projectTabHost.ts`):** it is currently `vm?.enabled || (remote.remote_only ?? remote.vm === true)`. That matches the new Rust whenever `vm.enabled` tracks `remote.vm`, which holds for every VM the backend creates. It disagrees only for `{remote.vm:true, remote_only:false}` with no `vm.enabled` record. For exact parity, change the last line to `return p.remote.vm === true || p.remote.remote_only === true;` and add that row to its test or fixture.

**Gates** (`scripts/gates.sh`, diff vs b7e05ab9): brand, whitespace, clippy, clippy-dlib and clippy-dmn PASS. In `cargo test -p tabtivity -p app-serverd`, 4831 passed and 1 failed: `markup_rounds::tests::a_call_past_the_operations_deadline_is_killed`, a 3 s wall-clock assert on an untouched file, under load (the suite took 584 s). Rerun alone it passes. Because of that, gates.sh stopped, so I ran the rest by hand: `cargo test -p tabtivity --test '*'` 176 passed; `cargo test -p app-serverd` builds, 0 tests (as in A1); test-dlib (`--no-default-features --lib --test server_secrets`) 4690 passed, 7 ignored. No frontend change.

**Flagged for user**
- D1's formula is amended to "VM outranks `remote_only`" (M1).
- L4 (non-bool flag → project reads as local), I2 (`is_under_mirror` inventory gap), I3 (stale VM run host).

## A11 — viewers, tabs, disconnected cockpit (F5–F7)

Branch `ro-a11`, commit **dc90f624** (one commit on ro-int 48168218 = A1 + A2 + A10).

**Landed**
- TeX (`TexView`; `TexWorkspaceView` needs nothing, its compile goes through `registerTexCompile`): on a pinned
  project Compile (button, Ctrl+Shift+B, the PDF tab's recompile notice) runs `hostCompile` — saves this pane and every
  workspace pane, resolves the root, opens a host build tab via new `src/lib/viewers/tex/hostTexBuild.ts`
  (`openHostTexBuild`), never `compile_tex`. Argv exactly the plan's: `latexmk -cd <-pdf|-pdflua|-pdfxe>
  -interaction=nonstopmode -synctex=1 ./<rel>.tex` (flag = the backend's `latexmk_flag` mapping; path outside
  `remote_path` stays absolute). The viewer then watches the PDF (`useDiskReloadPoll`, `seed:false`, baseline = the
  mtime before or -1 for "absent", gated on connected + `PaneVisibleContext`, 10-min cap) and on the first change opens /
  refocuses the PDF tab and calls `onCompiled` like a local success; an open PDF tab reloads on its own poll. The
  compile toolbar shows on pinned whatever this machine's `tex_capability` says; the engine menu offers
  pdflatex/lualatex/xelatex (`HOST_TEX_ENGINES`, Auto = pdflatex, no `tex_auto_engine` call); the Options (out-dir /
  extra flags) and TeX hover-preview toggles are hidden and `hoverPreview` is off. SyncTeX keeps the "remote" notice
  (the pane's source is forced `"remote"`).
- `FileViewerPane`: pinned → `effectiveSource` always `"remote"` (so the disconnected `RemotePaneHold` shows at once,
  without waiting on `file_source`), `FileSourceContext` `"remote"`, no `fileSources` entry (no ☁ badge / hover-card
  line), no `TabSourceBadge` controls, no ViewerHeader source switch, no `remoteMissing` SFTP stat.
- `ViewerHeader`: `localMirrorRootFor` answers `null` on pinned (fixes TextView's run plan, TexView's out-dir bound,
  the ± resolver); `AutoSyncHeaderToggle` not rendered on pinned.
- SQLite: `SqliteView` reads `useFileSource()`; a `"remote"` file gets a note (`fileTree.sqliteHostOnly`, points at
  Download to…) and no `sqlite_tables`/`sqlite_page` call. Covers every entry point (tree, links, restored tabs).
- "+" menus: `TabBar` and the popout's `NewTabMenu` (new `hostPinned` prop, passed by `DetachedCenterPanel`) omit the
  API-key groups, the local-model group and the ☁ Cloud session row (`pickCloud` unset) on a pinned scope, and don't
  run `agent_logins` / the Ollama placement probe for them. Agents (▾ only with workers, A2), Shell, Files, Monitoring,
  Workspace unchanged.
- `PaneSlot`: a pinned project's `files` tab holds on `RemotePaneHold` (primary's lamp) while disconnected, and
  `filesProjectDir` no longer resolves the mirror on pinned (the A10 note). `TabPane`'s `files` case honours
  `holdRemoteTerminal`. Pinned terminals already held (their location always resolves to a host).

**Choices**
- **Build tab delivery: `cmd: ""` + `initialInput` (the quoted argv) instead of `cmd: "latexmk"` + `args`.** A restored
  shell tab respawns its `cmd` with **no args** (`restoreSavedTab`), so a `latexmk` tab would run a bare `latexmk` over
  every `.tex` in the project root on the next launch. A login shell comes back as a shell. Every arg is POSIX
  single-quoted (`shellQuote(…, "unix")`, the SLURM/Python-run pattern), so the argv is still exactly the plan's.
- **"Reuses the tab" = replaces it**, as `openPythonTab` does (env marker `{PREFIX}TEX_BUILD=<root>`): typing into a
  live tab could land in a running latexmk; closing ends the old build. The tab is `ephemeral` (never tmux-wrapped) —
  closing a remote tmux tab only detaches, so each Compile would otherwise leave a session on the host.
- The build goes through `guardLoginNodeRun` (HPC hosts ask, like every run there).
- **Ctrl+S on pinned only saves** (locally it saves + compiles): a build here is a new tab that takes focus.
- Open externally on a host file (`effectiveSource === "remote"`: pinned, or the Remote side of a plain remote
  project) shows A10's `fileTree.hostFileExternal*` message instead of `open_file` on a host path — sibling fix
  matching A10's tree rule.
- SQLite gate is on the remote source, not only pinned (the plan notes it is broken for any remote-native file).
- Monitor / disk usage / network tabs keep their own `sshDown` states; `projectfiles` has A10's prompt; embed viewers
  hold in `FileViewerPane`. Only the `files` kind needed a new hold.
- FileTree's `.tex` Compile rows (hidden on pinned by A10) are not wired to the host build — left in A10's file.

**Gotchas**
- `TexViewer`-style tests need `vi.resetModules()` per render (`getTexCapability` caches), so the new test seeds the
  freshly imported stores after the reset.
- `useEditableFile.save()` writes nothing for an unchanged draft, so "saved before the build" is not observable in a
  test with a clean buffer.

**Gates** (`scripts/gates.sh`, diff vs 48168218): brand PASS, whitespace PASS, lint-fe PASS (0 errors, no warnings on
touched files), build PASS, vitest `--changed` 724/725 files, 6772/6773 tests — the one failure is
`terminal/TerminalAiSwitch.test.tsx` ("an agent tab refused while AI is off waits…"), a timing test untouched by this
step; it passes 4/4 run alone (twice). New tests: `tabs/HostPinnedPanes.test.tsx` 6, `tex/TexHostBuild.test.tsx` 6.
No Rust change. Not run live.

**Hot-file edits**
- i18n, MADE (one block per file right after `"fileViewer.saveAndCompile"`, en/de/es/fr/it): `tex.compileOnHostTab`
  (build tab label, `{name}`), `tex.compileOnHostTitle` (Compile button title on pinned, `{host}`),
  `fileTree.sqliteHostOnly` (`{name}`).
- `src/lib/untested.ts`, NOT made — rows + pills to add at merge:
  - `tex.compileOnHostTab` { area: "viewers", what: "Remote-only or VM project · TeX Compile opens a latexmk build tab
    on the host (replaced on the next Compile) and the PDF tab opens once the build writes it; no hover preview or
    compiler options" } — pill after the Compile button in `TexView` when `hostPinned`.
  - `fileTree.sqliteHostOnly` { area: "viewers", what: "A SQLite file on the host (remote-only/VM, or the Remote side of
    a remote project) · the viewer says it opens only local files and points at Download to…" } — pill in the note in
    `SqliteView`.
  - optional `newTabMenu.hostPinned` { area: "tabs", what: "Remote-only or VM project · the + menu has no local-model,
    API-key or Cloud session rows; while disconnected the Files tab shows the Connect placeholder" } — as
    `untested: "newTabMenu.hostPinned"` on the Shell entry of a pinned scope's menu, or skip.
- `docs/filemap_frontend.md`, NOT made: new row `lib/viewers/tex/hostTexBuild.ts` — "host-pinned TeX Compile: the
  latexmk argv/command and the one-click host build tab (replace, ephemeral, HPC guard)"; one-line touches if rows
  exist: `TexView.tsx` (+ host build + PDF watch), `PaneSlot.tsx` (+ pinned Files hold).
- No `command_class` change.

**Flagged for user**
- The build tab is typed into the host's login shell rather than run as the tab's program (restore would otherwise
  rerun a bare `latexmk`), and Ctrl+S on a pinned TeX file saves without building. Say if either should differ.

## A3 — sync off (E3 + `git_peer` host-arm hardening)

Branch `ro-a3`, commit **c93eb46c** (on A1 b7e05ab9).

**What landed**
- `services/remote.rs`: pure `mints_mirror(spec, host_id)` (primary only, and not `is_remote_only`); `connect_host` uses it, so a VM boot also stops minting an empty mirror.
- `sync_auto::start_now` no-ops via `has_mirror_to_sync(spec)` before its mirror `create_dir_all`.
- `git_peer`: `pub fn lockstep_refusal(spec) -> Option<String>` (sentinel). `start_now` no-ops on it. In `commands/git_peer.rs`, a `lockstep_target(id)` helper refuses remote-only for **every** mirror-touching command (`set_enabled(true)`, `set_local_authoritative`, `sync_now`, `pair_confirm`, `backups`, `restore_backup`, `mirror_dir`, `checkout`, `resolve`). `set_enabled(false)` and `git_peer_status` stay allowed.
- `commands/sync.rs`: pure `byte_sync_refusal(spec)`. `resolve` refuses, so all ten commands behind it refuse. `sync_mark_selected` / `sync_set_auto` / `sync_set_excluded` refuse through `refuse_remote_only`. `sync_status` → `[]`, and `sync_big_folders` → an empty scan (`hostScanned: false`), both before the HPC guard. `sync_scan_host_new` refuses before its HPC question.
- `worker_sync`: `wants_code_fanout(host, remote_only)`. `fan_out` and `on_worker_connect` skip silently, and `sync_worker` (so `worker_sync_now`) returns an error report with the sentinel. `add_compute_host` refuses `sync_code && !shared_fs` (`compute_host_refusal`, pure).
- `hpc_ws_pull_logs` refuses (`pull_logs_refusal`, pure) before any SFTP.
- **Sibling fix (security)**: `Peer::Remote::run` → `run_git_remote(spec, &remote_git_args(args))` = `hardened_git_args` (hooks off, fsmonitor off, `-c` pairs before the verb, byte-identical to the local arm's args). **Also** the two batched host scripts (`PROBE_SCRIPT`, `ancestry_script`) now go through `hardened_remote_script`, which prefixes the script with a `git() { command git <quoted -c pairs> "$@"; }` shell function. Without it, the 12 s background probe ran a bare `git status` on the host, which runs a repo's `core.fsmonitor` program and its `post-index-change` hook (verified with git 2.53). The bound comes from A4's `run_git_remote` work; nothing here touches `ssh_exec.rs`.

**Choices**
- The posture predicate is `is_remote_only()`, so **VM projects are refused byte-sync** too (sync_pull and the rest). That is consistent with D2/"no mirror by default". The VM's opt-in manual-pull mirror (G.26) is unbuilt, so nothing live used it, but it will need its own path when built.
- Lockstep refusals cover all mirror-touching lockstep commands, not just the three the plan names. Each one works on a mirror that doesn't exist.
- `patch_compute_host` can still flip a stored worker to synced-copy. I left it alone: it is harmless because fan-out and `sync_worker` refuse at runtime, and only `add_compute_host` was in scope. The UI (D4) should disable "Sync a copy" for both.
- `hpc_ws_move_root` still resets `git_peer.json` / `sync.json` for a remote-only project. That writes small state files, never a mirror, and `start` no-ops, so I left it unchanged.

**Gotchas**
- E8 (A12): `set_remote_mirror_dir(keepLocalCopy)` must clear `remote_only` **before** calling `git_peer_set_enabled(true)` / `pair_confirm`, or both refuse with the sentinel.
- `brand_migration::project::on_project_open` still runs on connect (A5's).

**Gates** (`scripts/gates.sh`, diff vs b7e05ab9): brand PASS, whitespace PASS, clippy PASS, clippy-dlib PASS, clippy-dmn PASS. In the gate's `cargo test`, 5 tests failed (4 in `markup_rounds::`, 1 in `mobile_control::markup::`, files A3 does not touch) at load average 53–73. They pass alone (53/53). Rerun: lib 4786 passed + those 53 = 4839 (= the gate's 4834 + 5), 7 ignored. Integration 143 + 31 + 1 passed. test-dlib: 4696 + 1 passed. `backend:stale` not run (brief).

**Hot-file edits** (listed, not made):
- `docs/filemap_backend.md` row `remote.rs` (services): append "`mints_mirror`: connect mints the mirror only for a plain Remote primary."
- row `git/git_peer.rs`: append "Host verbs and the batched probe/ancestry scripts run hardened (`hardened_git_args` / `hardened_remote_script`, hooks off); `lockstep_refusal` no-ops/refuses a remote-only project."
- row `remote/sync_auto.rs`: append "no-op for a remote-only project."
- row `remote/worker_sync.rs`: append "nothing fans out for a remote-only project (`wants_code_fanout` takes the posture); an explicit sync refuses."
- No `command_class` rows (no new command), no i18n, no `untested.ts`. The new sentinel texts (`byte-sync needs a local copy…`, `git lockstep needs a local copy…`, `a synced-copy worker needs…`, the `add_compute_host` and log-pull ones) are fallbacks only: F1's `remoteOnlyRefusal` maps the prefix.

**Flagged for user**: VM projects now refuse byte-sync (see Choices). Confirm this is wanted until the G.26 opt-in mirror exists.

## A5 — local-tree readers + export (E5)

Branch `ro-a5`, commit **25846b42** (on A1 b7e05ab9).

**What landed**
- `remote.rs`: new `entry_is_remote_only(entry)` (pure). Readers moved to `mirror_dir_opt` / `local_copy_in`: `ide::project_root` (refuses with `remote_only_refusal`), `restore_service::project_roots`, `brand_migration::project::on_project_open` (skips), `usage_stats::watch_root_for` (`None`).
- Fence/boxes: `agent_fence::compute_fence_roots` returns `None` for a `local_only` remote-only scope (fails closed, never the stale `mirror`); `attach_roots`, `root_project_read_only_paths`, `roots_for_scope` use `local_copy_in`; `box_store::compute_box_allowed_roots` skips a remote-only member entirely (directory included), `box_allowed_roots` adds members' copies via the new pure `member_local_copies`. `mail_attach::root_label` uses `local_copy_in`.
- `vm::has_mirror` → `mirror_by_posture(spec, probe)`: not remote-only / no spec → `true` (fail closed); remote-only (every VM) → folder non-empty.
- `commands/projects.rs`: `MirrorStatus.remote_only` (remote-only answers `path: ""`, `exists: false`, `suggested` kept); `mirror_relocation_refusal(spec, what)` — `set_remote_mirror_dir` and `move_remote_mirror` refuse remote-only (VMs too) **before** creating any folder. E8/A12: add the `keepLocalCopy` bypass in `set_remote_mirror_dir_blocking` around that check. Sibling: `scaffold_target_for_entry` → `None` for remote-only (Repair scaffold / the launch-time legacy repair would have written into a stale mirror).
- Root MCP: `projects_list` rows gain `remote_only`; `sync_status` rows gain `posture` (`mirrored` | `remote_only`; a remote-only row has `note` + `warnings`, no `lockstep`/`byte_sync`); `local_checkout` refuses remote-only. Both tool descriptions updated.
- `project_transfer`: `ExportPreview.remote_only` (mirror `None`, counts 0); `local_tree_refusal`: `include_mirror && mirrorSource: Local` on remote-only → sentinel, before anything is written; `Host` works. Import: pure `settle_imported_posture(spec, carries_tree)` shared by inspect (`BundleInfo.remote_only`) and import — a tree → `remote_only` removed (plain Remote, mirror = the tree); no tree → bundle's `remote_only` kept, no mirror folder, no `extra["mirror"]`, no `mirrorEmpty` note. Applied to both the registry entry and `project.json`.

**Choices**
- `local_copy_in` (A1) now decides remoteness by the `extra["remote"]` key, not by the spec parsing: an entry whose spec does not parse resolves its explicit-else-default mirror, exactly as `mirror_dir_opt` does by id. Without this, moving the fence planners onto it changed their answer for such entries (an existing fence test uses `{"host":"h"}`). A1's test extended.
- Import drops `vm` from the bundle's spec (sibling hardening): VMs are refused at export, so only a crafted bundle carries it, and it would have unlocked the per-VM SSH handling and pinned the project.
- `has_mirror` probes `mirror_dir` (explicit else default), not only the default dir: stricter than the plan's wording.

**Gotchas**
- Frontend not touched: `ProjectPill.revealOnDisk`/`moveMirror` still call `set_remote_mirror_dir` on a missing mirror; for a VM/remote-only project that now errors (logged) instead of minting a mirror. A9 should hide them on `isHostPinned` / `status.remoteOnly`. A9 also needs `remoteOnly?: boolean` on the TS `ExportPreview` and `BundleInfo` (`src/types/index.ts`) and on the inline `remote_mirror_status` type in `ProjectPill.tsx`, and must send `includeMirror: false` (or `mirrorSource: "host"`) for a remote-only export, because `includeMirror` defaults to true and `mirrorSource` to `local`.

**Gates** (`scripts/gates.sh`, diff vs b7e05ab9): brand PASS, whitespace PASS, clippy PASS, clippy-dlib PASS, clippy-dmn PASS, `cargo test -p tabtivity -p app-serverd` PASS (**5016 passed**, 0 failed, 7 ignored; A1 had 5006: +9 lib tests, +1 integration `a_remote_only_project_travels_without_a_local_tree`), test-dlib PASS. No frontend change. `backend:stale` not run (brief forbids it).

**Hot-file edits** (listed, not made)
- `docs/filemap_backend.md` row `services/remote.rs` (line ~154): append "`entry_is_remote_only(entry)`: the posture of a registry entry, for list planners."
- `docs/filemap_backend.md` row `commands/project_transfer.rs` (line ~74): append "A remote-only project's tree travels only as the host's copy; a bundle without a tree imports remote-only (no mirror), one with a tree as a plain Remote."
- No new command, so no `command_class` row. No i18n / `untested.ts` edits.

**Flagged for user**: none.


## A4 — git on the host (E4)

Branch `ro-a4`, commit **007ebbc3** (on A1 b7e05ab9).

**What landed**
- `commands/git.rs`: `WorktreeSite::resolve(site, remote_only)` (pure) refuses the local/mirror side of a remote-only project (`remote_only_refusal("this project has no local copy, so its worktrees live on the host only")`). `worktree_ctx` now returns `Result<WorktreeCtx, String>` (all 7 callers `?`), decides from `primary.spec.is_remote_only()`, and resolves the mirror through `mirror_dir_opt` (refusal as fallback).
- `commands/git_publish.rs`: `parse_publish_from(s, remote_only)`: for remote-only, absent/empty → `Host`, `"local"`/`"mirror"` → sentinel refusal (`"this project has no local copy to publish from; publish from the host"`), `"remote"`/`"host"` → `Host`. `publish_site` reads the posture from the trusted entry's spec. `mirror_repo` goes through `mirror_dir_opt`, so `mirror_origin_repo` (push, fetch, visibility/unpublish/switch via `origin_site`) answers `None` → host even if an old default mirror with a `.git` is on disk.
- **Security sibling fix**: `git_push_blocking`'s host arm now calls `run_git_hooked(Some(&target), …, &PUSH_ARGS)` (hardened args, host pre-push hook live, as it was) instead of a bare `run_git_remote`. New source-scan test `every_host_git_call_goes_through_the_hardened_runner`: `run_git_remote(` may only appear in `git_hardened::run_git_as` and `git_peer::run` (lockstep's `Peer::Remote`, hardened by A3).
- **Bound**: `run_git_remote` runs ssh through new `git_bounded::wrapped_output(cmd, git_args)`: ceiling = `timeout_for_args(git_args)` (new pub(crate) helper, also used by `timeout_of`: hooks live unless the `core.hooksPath=` pin is present), computed from the git args before wrapping; no hazard precheck; the timeout error names the git verb ("git push timed out after N s … The connection to the host may be stalled."), prefixed "failed to run git over ssh: ". Subtree killed + reaped as for local git. `git_peer`'s host arm inherits it.
- Sibling fix (same code path): local `push_local` (git.rs) and `fetch_local` (git_pull.rs) were unbounded `.output()`; now `git_bounded::output` (hazard precheck + verb ceiling = LONG).
- `git_hardened.rs`: `#[cfg(test)] hooked_git_args` (what `run_git_hooked` builds), comment on the bounded remote arm.

**Choices**
- An explicit `publishFrom: "local"` on a remote-only project is refused, not silently moved to the host. Today's pill defaults to `"local"` (`stores/projects.ts` `publishProject(..., publishFrom = "local")`), so **A9/F3 must send `"remote"` (or omit it) for a pinned project** — the plan already says so.
- `git_worktree_list(site: "mirror")` now errors for a remote-only project; its frontend callers (`agentWorktrees.ts`, `agentWorktreeSwitch.ts`) already `catch` and fall back to the root / empty list.
- `git_pull.rs` is not in E4's file list; the one-line `fetch_local` bound is there because it is the push's twin on the same `mirror_origin_repo` route.

**Gotchas**
- `git_bounded::verb` on an ssh argv returns the first non-dash arg (`BatchMode=yes`), which is why the wrapped path takes the git args separately; a test pins that.
- Gates under ~100 load average took ~50 min; a `timeout 3000` around `scripts/gates.sh` killed the first run mid-test.

**Gates** (`scripts/gates.sh`, diff vs b7e05ab9): brand PASS, whitespace PASS, clippy (desktop) PASS, clippy-dlib PASS, clippy-dmn PASS, `cargo test -p tabtivity -p app-serverd` PASS (**5012 passed**, 0 failed, 7 ignored; A1 had 5006 → +6 new tests), test-dlib PASS. No frontend change. `backend:stale` not run (brief).

**Hot-file edits** (listed, not made): `docs/filemap_backend.md` — if rows exist, one-line updates: `services/git/git_bounded.rs` (+ `wrapped_output`/`timeout_for_args`: bounded runs of git wrapped in ssh), `services/remote/ssh_exec.rs` (`run_git_remote` bounded at the git verb's ceiling). No new command → no `command_class` row. No i18n / `untested.ts` edits (the two refusal strings ride the sentinel; F1's `remoteOnlyRefusal` mapper words them).

**Flagged for user**: none.

## A6 — host search and quick open (E6a)

Branch `ro-a6`, commit **124c4b2c** (one commit on ro-int 566d8546 = A1(+review) + A2 + A3 + A10 + A11).

**Landed**
- New `services/remote/host_search.rs` (pure halves + one bounded runner): `SKIP_DIRS` (now the one vendor list behind
  `search::should_skip_dir`, `fs::should_skip_ending_scan_dir` and the host walks; brand dirs added everywhere),
  `validate_rel_root` (refuses absolute, `..`/`.`/empty segments, NUL/control chars), `hpc_refusal(tagged, confirmed, spec)`
  (`HPC_GUARD host-search <target>`), `grep_command` / `find_command` (every value `shell_quote`d, run as
  `exec sh -c '<cd … || exit 2; …>'` because the login `$SHELL` may be fish/csh), `parse_grep` / `parse_find`
  (NUL-separated, stop at a cut record, drop any path that leaves the walk root), `truncate_line` (`MAX_LINE_CHARS` 2000),
  `run_bounded` (`git_bounded::run`, `READ_TIMEOUT`, `STDOUT_CAP` 16 MiB on the host via `head -c` and locally; exit 2 =
  project folder missing, 255 = ssh failed).
- `commands/search.rs` `project_search(ctx, projectDir, query, caseSensitive, maxResults, relRoot?, confirmed?)`: a
  remote-only project (`remote_target_for_dir` + `is_remote_only`) runs `grep -rnIF --null [-i] --exclude-dir=… -- <q> <root>
  | head -n <cap>` on the host. Order: query that no line can hold → `[]`; `relRoot` check; **not connected → error at once
  (pool `is_connected`, never dials)**; HPC question; then a `user_dial` for a confirmed run (the `sync_big_folders` rule).
  `col` from the line text (1 when the host's case folding matched what ours does not), `rel` relative to the searched
  folder (as the tree expects), `path` the host absolute path. `relRoot` also works locally (validated, canonicalized and
  held inside the project root — a symlink out is refused).
- `commands/fs.rs` `list_project_paths(ctx, projectDir, confirmed?)`: same gate order; `find . \( -name … \) -prune -o -type f
  -print0`, files only, capped at `MAX_HOST_PATHS` (50 000), sorted.
- `core_dispatch` `USER_CONFINED`: `("project_search", "relRoot", BodyConfined)`.
- Frontend: `FileTree` `canSearch = !remoteListing || hostPinned` (the `remoteBlocked` early return already gates on
  connected) and passes `hostPinned` to `FileTreeSearch`, which then sends the project `directory` + `relRoot` (folder
  scope). `QuickOpen` / `ContextFilePicker` list a pinned project's host only while its primary lamp is `connected`
  (else `projectFilesPane.disconnectedHostOnly`; the picker loads once it connects). All three go through
  `withHpcConfirm` with new `confirmedArg(confirmed)` (`lib/remote/hpc/hpcGuard.ts`: absent on the first try, so local
  calls send exactly what they did). A declined question shows `search.hostDeclined`; the tree's name mode does not
  re-ask on every keystroke after a decline. New HPC kind `host-search` (`HpcGuardKind`, `HpcGuardDialog` COPY).

**Choices**
- `--null` instead of the plan's `-Z`: on BSD/macOS grep `-Z` is *decompress*; `--null` is the NUL-after-name flag on both.
- The host walks skip the same vendor dirs as the local ones (node_modules, target, .venv, …), not only `.git` + brand dir:
  same results as a plain Remote's mirror search; one shared list.
- There is no "local walk's line cap" / "entry cap" in the code: added `MAX_LINE_CHARS` (host only; the local walk is
  unchanged) and `MAX_HOST_PATHS`.
- A disconnected host answers a plain error (`host_disconnected_error`), not the `_REMOTE_ONLY` sentinel (it is not a
  posture refusal); the UI never calls while disconnected.
- Sibling fix: `QuickOpen`'s `scrollIntoView` call is now optional-chained like `ContextFilePicker`'s (threw in jsdom once a
  row rendered).

**Gotchas**
- The parser drops a record split by a newline in a file name only if it breaks the `name\0num:` shape; names with `:` are
  fine. busybox `grep` may lack `--exclude-dir`/`--null` (then the search returns nothing, not an error).
- Content search on an HPC host asks once per settled query (per-run confirmation, never remembered).

**Gates** (`scripts/gates.sh`, diff vs 566d8546): brand, whitespace, lint-fe (0 errors), clippy ×3, build, vitest
`--changed`, cargo test, test-dlib — all PASS. Counts re-run after: `cargo test -p tabtivity -p app-serverd` 5029 passed
(lib 4853, of which 13 new: `host_search` 10, `search` 3), 0 failed, 7 ignored. New/changed vitest files run directly:
`FileTreeSearch.test.tsx` 13 (4 new: relRoot, HPC retry, decline, disconnected), `HostPinnedFilePanel.test.tsx` 8 (quick open
connected/disconnected, picker loads on connect). `backend:stale` not run (brief). Not run live.

**Hot-file edits**
- i18n, MADE (en/de/es/fr/it, one block each in place of A10's two deleted keys): added `hpcGuard.hostSearch.title`,
  `hpcGuard.hostSearch.body`, `hpcGuard.hostSearch.go`, `search.hostDeclined`; **deleted** `quickOpen.hostOnly`,
  `fileTree.searchHostOnlyHint` (A10's "delete afterwards" keys).
- `src/lib/untested.ts`, NOT made — row + pill to add at merge:
  - `fileTree.hostSearch` { area: "files", what: "Remote-only project · file-tree search (name and content, folder scope),
    Ctrl+P quick open and the context-file picker search the host while connected; an HPC-tagged host asks first" } —
    pill on the search input row in `FileTree` when `hostPinned` (or `untested` on the QuickOpen header).
- `docs/filemap_backend.md`, NOT made: new row `services/remote/host_search.rs` — "remote-only host search/quick open: grep/find
  scripts (quoted, own `sh -c`), `rel_root` check, HPC refusal, NUL parsers, bounded run"; touch `commands/search.rs`
  (+ host branch, `relRoot`) and `commands/fs.rs` (`list_project_paths` host branch).
- `docs/filemap_frontend.md`, NOT made: one-line touches `FileTreeSearch.tsx` (+ `hostPinned`, `relRoot`, HPC retry),
  `QuickOpen.tsx` (host listing while connected).
- No `command_class` change (no new command; `commandClasses.ts` unchanged).

**Flagged for user**: none blocking. A VM project is `is_remote_only`, so its search/quick open now reach the VM over SSH
too (it searched the empty default mirror before).

## A8 — phone (E7 + F8, `projectHostReach` rows)

Branch `ro-a8`, commit **fcac81cf** (on ro-int 936f90ea).

**What landed**
- `mobile_control::discovery`: new `host_pinned(record)` = `vm.enabled || remote.vm == true || remote.remote_only == true` (the record's loose value; same three fields as the window's `isHostPinned`, equal to `RemoteSpec::is_remote_only` whenever the spec parses — pinned by `the_pin_matches_the_specs_posture`). `project_host` unchanged (remote-only stays `remote` on the wire).
  - `ScopeSource.pinned`, `ResolvedProject.pinned`; `PublicProject.remote_only` (serialized only when true, only for host `remote`: a type fact like `host`, no id/path).
  - `mobile_root` → `None` for remote-only (a stale `mirror` key or a leftover default folder never make it a folder); `scope_sources` lists it with no roots (like a mirrorless VM), so `folder: false`.
  - `runs_on_this_machine(host, pinned, …)`: a pinned remote runs nothing here, `local_agent` included (matches A2's window rule `phoneReachesTab`). VM unchanged.
  - `host_of_tab`: for a pinned project an unset/`"local"`/unknown location is the primary, `host:<id>` that worker (the window's pinned `effectiveTabLocation`), so its agents/shells saved "local" are listed as host tabs; `local_agent` never listed.
  - `launch_place`: `NotAttachable` for every tab of a pinned project, whatever kind/location → `headless::launch_options` never yields `LocalMirror` for it (create, reopen, closed list, scheduler restart).
  - `create_verdict(host, folder, pinned, machines)`: pinned → `agents` iff it has a runnable machine (persist_sessions on + this build lists host tabs), else `none`. `primary_host`/`machines` were already filled for host `remote`; now reachable for remote-only.
  - Sibling: a misplaced `spec_for` doc comment sat on `ProjectHosts::machines`; moved.
- `headless::create_tab`: refuses a pinned project (`NotAttachable`) before any record is written.
- `host.rs` (minimal; listed for the merge):
  - `creatable(project, kind, on_host)`: a pinned project only takes a create that names a machine; reopen / sign-in / teleport pass `false` (all start here) → `409 not_attachable`.
  - `launch-options`: `here: !pinned` on both answers; for a pinned project the window's worktrees/cloud/sign_in/local/api_key are dropped (empty), `hosts` kept.
- Window (`src/lib/projectTabHost.ts`): `phoneProjectFolder(remote-only)` = `""` (no mirror, stale key ignored); `phoneCreateVerdict` doc (stays `agents`: host agents only). `MobileBridgeHost.createOnHost`: `cwd: scope.cwd || directory` (one line; a remote-only scope has no phone folder).
- Access line: `MobileAccessPicker.tsx` `PhoneReachHost` (= host kind | `remote_only`), `phoneReachHost(project)` (isHostPinned, VM aside), `HOST_REACH_KEY.remote_only = "mobile.hostReach.remoteOnly"`; used at both plan sites (ProjectFilesView title + picker prop) and the sibling Settings → Mobile rows (`MobileSettings.tsx` title + picker).
- Phone (`mobile-web/`):
  - `api.ts`: `ProjectRow.remote_only?`, `LaunchOptions.here?` (passed through by `getLaunchOptions`).
  - `NewTabSheet`: props `remoteOnly`, `sendsFile`; pinned (`remoteOnly || here === false`): `MachinePicker` (new `here` prop) has no "Desktop (local copy)" row and shows the primary; the primary is preselected while connected; with none connected the agent tiles are disabled and `machineConnectHint` shows; no shell, worktree, cloud, local-model, API-key, sign-in rows, no `machineNote` (it names the desktop's copy), no send-a-file row; headless → new `mobile.newTab.remoteOnlyNeedsWindow` line instead of `mobile.newTab.headless` / NeedsWindow.
  - `Project.tsx`: `remoteOnly` from the row; no one-tap quick create and no ★ default (the agent needs a machine); host note `mobile.project.hostRemoteOnly` (own dismiss flag `projectNoteRemoteOnly`, `prefs.ts`); no-folder line `mobile.project.noFolderRemoteOnly{,Host}`; passes `sendsFile={!folderless}`.
- Fixture `src/__tests__/mobile/projectHostReach.fixture.json`: +45 rows (126): remote-only, remote-only + stale mirror key, remote-only + sandbox record, spec `vm: true` without a vm record (all: host remote, reach false, lists true, create agents), and `remote_only: false` (= plain remote). Rust reader `the_project_host_table_matches_the_windows` now passes `host_pinned` and `create_verdict(host, true, pinned, true)`; TS reader unchanged (already reads `isHostPinned` through `phoneReachesTab`).

**Choices**
- The plan's "pin like the VM" for `runs_on_this_machine` would keep `local_agent` reachable; A2's window says a remote-only project reaches nothing (D11), so the sidecar follows the window: `Remote if pinned => false`. `tab_is_local`/`tabLocality.fixture.json` untouched.
- The phone learns the posture from an explicit `remote_only` on the project row (not inferred from `folder: false` + `create`), and the sidecar adds `here` to `launch-options` (the plan's "lists no this-computer row").
- `create: agents` for remote-only only while a machine is offered; without one (persist_sessions off, Windows) it is `none`, so the phone hides ＋ rather than offering dead tiles.
- `untested.ts` not touched: the new headless line reuses the existing `mobile.newTab.machine` pill id.

**Gotchas / merge**
- Main-checkout dirty files this step touches (keep both sides): `mobile_control/host.rs` (creatable + launch-options hunks, far from the dirty `drop_box`/inbox hunks but `creatable` sits right after the dirty `has_folder`/`drop_box` hunk), `host/tests.rs` (one test appended at the end), `MobileBridgeHost.tsx` (one line in `createOnHost`), `mobile-web/src/api.ts` (two type fields + one spread), **`mobile-web/src/screens/NewTabSheet.tsx`**: the other session rewrites `MachinePicker` from a `<select>` to an unfolding `.option-list`; at merge apply `here` there as `rows = [...(here ? [this computer row] : []), ...machines]`, `current = rows.find(id === (value || primary id)) ?? rows[0]`, and `value && here ? machineNote : …`. The new tests in `MobileNewTabSheet.test.tsx` ("a remote-only project") use the `combobox`/`option` roles of HEAD's `<select>`; adapt them as that session adapted `MobileHostMachines.test.tsx`.
- `protocol.rs` / `commands/mobile_control.rs` / `Terminal.tsx`: not touched.
- `MobileNewTabSheet` file row: until now no folderless scope could open the sheet (create was `none`); remote-only is the first, hence `sendsFile`.

**Gates** (`scripts/gates.sh`, diff vs 936f90ea): brand PASS, whitespace PASS, lint-fe PASS (0 errors; the 2 warnings on touched files are the existing `ProjectFilesView` exhaustive-deps ones), clippy / clippy-dlib / clippy-dmn PASS, build PASS (tsc + desktop, mobile, web bundles). vitest `--changed`: 735 files, 6910 passed, 1 failed — `terminal/TerminalAiSwitch.test.tsx` (untouched, timing under load; 4/4 passed twice alone). gates.sh stopped there, so by hand: `cargo test -p tabtivity --lib` **4859 passed, 2 failed, 7 ignored**; integration tests 177 passed; test-dlib 4716 passed, the same 2 failed. `mobile_control::` alone 557 passed. The 2 failures are **not in this diff and fail on ro-int (936f90ea) as is**: `commands::projects::tests::a_remote_only_project_refuses_mirror_relocation` and `commands::vm::tests::the_mail_reader_mirror_flag_follows_the_posture_and_fails_closed` assert that `{vm:true, remote_only:false}` is unpinned — A5's tests against the old D1 formula, which A1's review changed to "VM outranks" (ff402308). Fix at integration: flip those two asserts (a VM stays pinned). (ro-a7 looked to be fixing the first.) Not run live; `backend:stale` not run (brief).

**Hot-file edits**
- i18n (made, one contiguous block after `mobile.hostReach.vm` in en/de/es/fr/it): `mobile.hostReach.remoteOnly`, `mobile.project.hostRemoteOnly`, `mobile.project.noFolderRemoteOnly`, `mobile.project.noFolderRemoteOnlyHost`, `mobile.newTab.remoteOnlyNeedsWindow`.
- `src/lib/untested.ts` (listed, not made): extend `mobile.newTab.machine`'s `what` with "; a remote-only project lists its machines alone (no Desktop row), the primary preselected, nothing startable while none is connected or with no window" — or give the remote-only sheet/notes a row of their own (`mobile.newTab.remoteOnly`) and swap the pill id in `NewTabSheet.tsx`. `mobile-every-project-type` covers the desktop access line.
- `docs/filemap_backend.md` (listed): row `services/mobile_control/discovery.rs`: append "`host_pinned` (VM or `remote.remote_only`/`vm`): a remote-only project has no phone folder, runs nothing here (`launch_place` NotAttachable), lists every agent/shell as a host tab, creates agents on its machines only; `PublicProject.remote_only`." (No `headless.rs`/`host.rs` rows exist; none needed.)
- `docs/filemap_frontend.md` (listed): `lib/projectTabHost.ts` row (514): "`phoneProjectFolder` is "" for remote-only"; `mobile/MobileAccessPicker.tsx` row (112): "`phoneReachHost` / `HOST_REACH_KEY.remote_only`: a remote-only project's reach line".
- No `command_class` change (no new command).

**Flagged for user**
- None blocking. Note: a VM with an opted-in `mirror` still gets that folder on the phone (`mobile_root`), while A1's `local_copy_in` says a VM has no local copy; left as is (G.26 is unbuilt).

## A7 — host creation + init (E6b)

Branch `ro-a7`, commit **5eb1ba89** (on ro-int 936f90ea).

**What landed**
- `commands/projects.rs`: `apply_requested_posture(remote, remote_only, is_vm)` runs right after `strip_renderer_posture` in create and import, and writes `spec.remote_only = Some(true)` from the top-level `remoteOnly` (never for a VM). The "until that lands" clause is gone from both request docs. Extend is unchanged: it always strips, because Local → Remote-only is later (D7), and its request has no `remoteOnly`.
- Pure `remote_creation_plan(req, is_vm) -> CreationPlan { mkdir_host, mirror, local_scaffold, arm_lockstep, check_local_git }` drives `create_claimed_project`. A remote-only project gets only the best-effort host mkdir: no mirror, no local scaffold, no `git_peer.json`, no local `.git` honesty downgrade. A VM gets the same minus the mkdir. Local and plain Remote behave as before.
- `finish_import`: a remote-only import records no mirror and creates no mirror folder. `remote_git_init` and its downgrade stay.
- **New command `remote_project_init_host(projectId, scaffold, git) -> HostInitReport { written, kept, git: "initialized"|"failed"|"skipped", committed, gitType }`**. It is async and needs the pooled connection (otherwise "the project is not connected; connect first"). It refuses a plain Remote (its scaffold lives in the mirror) and a VM.
  - Steps: `sftp::mkdir_on(root)` → `remote_scaffold::write_scaffold` (when `scaffold`) → `try_blocking` → `remote_scaffold::init_host_repo` (when `git`).
  - If the host `git init` fails, `git_type` is downgraded to `none` and `git_provider` is dropped, in both copies (`patch_project_entry_mirrored`).
- New `services/remote/remote_scaffold.rs`:
  - Pure `plan_scaffold_writes(with_git, lstat)` and `committable_paths`.
  - The SFTP scaffold write: lstat every path, never follow a link, create-new with `SSH_FXF_EXCL`. A failed exclusive open is looked at again, because SFTP v3 reports EEXIST as a generic failure. It writes `.claude/settings.json` only into a real `.claude` folder.
  - The scaffold set is the same as `scaffold_project`'s (docs, `.gitignore` only with git, `.claude/settings.json`).
  - `init_host_repo`: `remote_git_init`, then every later call goes through `git_hardened::run_git` (hardened, hooks off, bounded). The commit is made only when `rev-parse --show-prefix` is empty (the project root is the repo's top level, never an enclosing repo) **and** HEAD is unborn. It stages only the scaffold paths that are plain files (`git add -- <paths>`, never `add -A` over whatever the folder held). If git has no identity, it falls back to the app identity.
- `SCAFFOLD_COMMIT_MSG` / `SCAFFOLD_COMMIT_IDENTITY` are now shared consts. The local `git_scaffold_commit` uses them too, with unchanged behaviour.
- **Sibling fix**: `ssh_exec::remote_mkdir_p` / `remote_git_init` run through a new `bounded_ssh_output` (`git_bounded::run` at `WRITE_TIMEOUT`, `no_precheck`, subtree killed and reaped). On timeout the error is "`<what>` over ssh timed out …", not the misleading "git BatchMode=yes … named pipe" that `output_within` would print for an ssh argv.
- **Sibling fix (ro-int merge artefact)**: two A5 tests still asserted A1's pre-review rule that "`{vm:true, remote_only:false}` is not remote-only". On ro-int they failed (`a_remote_only_project_refuses_mirror_relocation`, `commands::vm::…the_mail_reader_mirror_flag_follows_the_posture_and_fails_closed`). Both now pin the VM-outranks rule (the code was already right).

**Choices**
- mkdir uses `sftp::mkdir_on` on the pooled session (SFTP's `mkdir -p`), not the ssh `remote_mkdir_p`, because the scaffold needs that session anyway.
- The commit stages only scaffold files, and only at the repo's top level on an unborn HEAD. This is stricter than the plan's "scaffold commit": a browsed host folder may already hold the user's files or sit inside a home-dir repo. As a result, a retry never adds a second commit.
- The command refuses VMs ("adopting it for VMs is a follow-up") and plain Remotes.
- D9 (the HPC warning) belongs to F2 (frontend) per the plan. Nothing was added to the backend.

**Gotchas**
- `services/mod.rs`: `remote_scaffold` was added to the one-line `pub use remote::{…}` re-export. A6's `host_search` touches the same line, so expect a trivial merge conflict.
- A9 must call `remote_project_init_host` with `{ projectId, scaffold, git }` **after awaiting the connect**. Without a pooled connection it refuses. `report.gitType` carries the possibly downgraded label for the store.

**Gates** (`scripts/gates.sh`, diff vs ro-int): brand, whitespace, lint-fe, clippy, clippy-dlib, clippy-dmn, build (`npm run build`, covers `commandClasses.ts`), vitest `--changed` and test-dlib PASS. `cargo test -p tabtivity -p app-serverd` PASS: **lib 4864 passed**, 0 failed, 7 ignored; integration 143 + 33 + 1. The first run failed only on the vm.rs merge artefact above. New tests:
- lib: 3 `remote_scaffold`, 4 projects, 2 `ssh_exec`;
- integration: `a_remote_only_project_keeps_nothing_local`, which checks create plus import, the flag in both copies, and that the state dir holds only `project.json` with no mirror under the parent.

`backend:stale` was not run (brief).

**Hot-file edits**
- Made (allowed): `services::command_class` row `("remote_project_init_host", Core)`, regenerated `src/lib/transport/commandClasses.ts` (+1 line), lib.rs registration.
- Listed, not made: `docs/filemap_backend.md`:
  - a new row `services/remote/remote_scaffold.rs`: "a remote-only project's scaffold (create-new over SFTP, never over anything there) and first commit (hardened, top-level unborn repo only), for `remote_project_init_host`";
  - row `commands/projects.rs`: append "`remote_creation_plan` per kind; `remote_project_init_host` sets up a remote-only project's host folder";
  - row `remote/ssh_exec.rs`: append "`remote_mkdir_p`/`remote_git_init` bounded (`WRITE_TIMEOUT`)".
- No i18n and no `untested.ts` rows. The command's errors are plain fallbacks. A9's dialog words the failure and owns the UntestedTag.

**Flagged for user**: none.

## A3+A4 review — verifier

Branch `ro-rv34` (on ro-int 936f90ea), one commit **22eb4a5b** (A3 and A4 fixes; the steps share `git_peer.rs`/`ssh_exec.rs` hunks, so not split). I re-checked each finding against ro-int's code, not the finders' base.

**A3 findings**
- **M1 `hpc_ws_move_root` ungated: fixed.** I confirmed the bug. For a remote-only project or a VM, the move re-pointed `remote_path` at an empty folder. It relied on a mirror re-seed that never happens: there is no mirror, and lockstep is off. A pure `move_root_refusal(spec)` now refuses it with the sentinel. The refusal comes before the host `mkdir` and before any `git_peer.json`/`sync.json` write. Test: `a_remote_only_project_refuses_the_workspace_move`. This reverses A3's "left unchanged" choice.
- **M2 hooks-off fails open on host git < 2.9: fixed.** I confirmed it: `core.hooksPath` is unknown before 2.9 and gets ignored. A `/dev/null` value would not help, because old git never reads the key whatever its value. So the fix detects the version instead:
  - `git_hardened::host_git(spec)` probes `git --version` once per `user@host:port`. A version it reads stays cached for the app's lifetime; a failed probe is cached for 60 s.
  - `host_hooks_off_refusal(version, args)` refuses a hooks-off call on such a host when its verb runs a hook there (`OLD_GIT_HOOK_VERBS`: checkout, merge, commit, fetch/pull through `gc --auto`, rebase, am, cherry-pick, revert, push, gc, clone, submodule, worktree, bisect). An unreadable version is refused too, so it fails closed.
  - Reads run no hook on old git (`post-index-change` is 2.22+). Hooks-live calls (the trust-gated ones, and the host push) pass.
  - This is enforced in `ssh_exec::run_git_remote`, so `run_git`'s host arm and lockstep's `Peer::Remote` are both covered.
  - The batched probe and ancestry scripts run only read verbs. Tests: `a_host_git_too_old_to_turn_hooks_off_refuses_hook_verbs`, `the_host_git_version_is_read_from_its_banner`.
- **L1 `patch_compute_host` bypasses `add_compute_host`'s refusal: fixed.** The patch now goes through a pure `HostPatch::apply_checked`. A patch that would create a synced-copy worker on a remote-only project returns the sentinel, and the host is left unchanged. Test: `a_worker_patch_cannot_make_a_synced_copy_of_a_remote_only_project`.
- **L2 `hardened_remote_script` lacks the diff-driver flags: fixed.** The shell function now inserts `--no-ext-diff --no-textconv` after `diff|log|show|blame`, taking the verbs from `DIFF_DRIVER_CMDS`. Its doc now states the `filter.<driver>` residual. Test: `the_batched_host_scripts_turn_the_diff_drivers_off`, which includes a positive control showing that the planted `diff.external` really fires when git runs bare.
- **L3 running loops don't re-check the posture: flagged for E8 (A12), no code.** Nothing reaches it until E8 exists. E8's Remote→Remote-only conversion must stop `sync_auto`, `git_peer` and worker fan-out, and wait on `exited`, before it writes the flag.
- **L4 thin wiring tests: partly fixed.** New source scan `every_sync_command_checks_the_posture`: every `pub async fn` in `commands/sync.rs` (15 of them) must call `resolve(` / `refuse_remote_only(` / `byte_sync_refusal(`. The fsmonitor half of the old test is unchanged, but the new diff-driver test has a real positive control.
- **I1–I3**: no action. I1 is a doc follow-up for E9. I2 is covered once F1's mapper lands.

**A4 findings**
- **F1 host publish/unpublish/visibility/rename unbounded and run bare git: fixed.**
  - `run_provider_command` now runs through `git_bounded::run`. Create is bounded at LONG, visibility edit at WRITE. A missing CLI is still reported as "not installed", and a timeout reports that the repo may already exist.
  - The host create script no longer runs any git itself. `gh repo create` runs without `--push`, and GitLab's chained `git push` is gone.
  - The push now follows as `host_publish_push`, through `run_git_hooked`'s remote arm: hardened, bounded, with the pre-push hook live as before.
  - `git remote remove/rename` on the host goes through `run_git` (hardened, hooks off, bounded), as `host_git_best_effort`. Only ssh's 255 is treated as an error, which matches the old `|| true` behaviour.
  - Sibling fix: the old rename script ran its second `git` even when the `cd` failed.
  - The local GitLab push now uses `git_bounded::output`.
  - Tests: `the_host_create_scripts_run_no_git_of_their_own`, `a_provider_command_is_bounded`.
- **F2 the host git outlives the killed ssh client: fixed where the host has `timeout`.**
  - The probe runs `timeout -k 5 60 git --version`. If that works, every host git call runs as `cd <p> && timeout -k 10 <ceiling+30 s> git …`. These are plain words, so a tcsh login shell runs them too.
  - The +30 s margin means the local bound always reports first, and the host only reaps what is left.
  - A host without `timeout` (macOS, Windows OpenSSH) gets no host-side bound. There the timeout message now says git "may still be running on the host" instead of "was stopped".
  - Tests: `a_host_git_call_is_bounded_on_the_host_too`, `the_host_git_probe_parses_on_a_real_shell`, and the extended `a_wrapped_git_call_is_stopped_and_named_by_its_git_verb`.
- **F3 the worktree-add exclude script is unbounded: fixed.** It now runs through the new `ssh_exec::run_remote_script_within(spec, script, READ_TIMEOUT)`. Sibling fix: lockstep's batched `PROBE_SCRIPT` and `ancestry_script` were unbounded too and now use the same call. A timeout gives `probe_error`, which withholds destructive moves, or the bounded per-branch fallback. I narrowed the scan test's doc to say what it covers.
- **F4 reader threads and fds leak when the master itself is wedged: flagged.** I did not reproduce it. A fix means not passing fds to the mux, e.g. `-S none`, which loses the shared master's auth. Not worth it without a reproduction.
- **F5 `mirror_dir_opt` fails open: rejected.** ro-int already returns `None` when the registry cannot be read. Push/publish then goes to the host and never to a stale mirror.
- **F6 test gaps: partly fixed.**
  - New `mirror_repo_in` seam plus test `a_stale_default_mirror_is_not_a_remote_only_projects_repo`: a `.git` on disk under the default mirror, with a remote-only or VM entry, gives `None`; a plain Remote entry gives `Some`.
  - The host-side bound is tested on the built command.
  - Still untested, because there is no registry fixture: `worktree_ctx` end-to-end, and `git_push_blocking` reaching `run_git_hooked`.

**Gotchas**
- Two A5 tests (`a_remote_only_project_refuses_mirror_relocation`, `the_mail_reader_mirror_flag_follows_the_posture_and_fails_closed`) failed on ro-int itself: they assert `vm: true, remote_only: false` is *not* remote-only, which A1's review (ff402308, "a VM outranks remote_only") changed. Updated the expectations to the decided rule (test-only).
- The privacy check reads a four-part dotted version number as an IP address; tests use three-part versions.
- The first host git call to each host now costs one extra ssh round trip for the probe; a host without `timeout` costs two. The result is cached per `user@host:port`.
- `ssh_exec.rs` changes are limited to `run_git_remote`, `git_ssh_args*`, `bounded_remote_git_command`, `run_remote_script*`. `remote_mkdir_p` and `remote_git_init` (A7) are untouched.

**Gates** (`scripts/gates.sh`, diff vs ro-int): brand, whitespace, clippy, clippy-dlib, clippy-dmn, `cargo test -p tabtivity -p app-serverd`, test-dlib all PASS (no frontend change). Lib tests: 4864 passed, 7 ignored. The first run counted 4862 passed plus the 2 A5 failures above, which I then fixed; the green rerun prints no counts. Net +9 tests: 10 new, and the two old host-script tests merged into one. `backend:stale` not run (brief).

**Hot-file edits** (listed, not made): `docs/filemap_backend.md`:
- row `services/git/git_hardened.rs`: append "`host_git` / `host_hooks_off_refusal`: host git version + `timeout` probe; hook verbs refused on a git < 2.9".
- row `services/remote/ssh_exec.rs`: append "`run_git_remote` runs under the host's `timeout` when it has one; `run_remote_script_within` bounds a script".
- No new command, so no `command_class` change; no i18n change.

**Flagged for user**
- Hosts with git < 2.9 (CentOS/RHEL 7 is 1.8.3) now refuse Tabtivity's hooks-off host writes: checkout, merge, commit, fetch, pull and the rest of that list, plain Remote projects included. Reads still work. This fails closed, but on such a host the git bar's branch switch and fetch, and lockstep's host checkout/merge, stop working until git is updated. Say if fetch, whose only old-git hook is `pre-auto-gc`, should be let through.
- Host publish on GitHub is now `gh repo create` (no `--push`) plus a separate hardened push. It has not been run live against a real host.
- F4, and E8's posture re-check (L3), are listed above.

## A9 — creation dialog + pill (F2, F3)

Branch `ro-a9`, commit **db5f715d** (one commit on ro-int 3dab2b72).

**What landed**
- `ProjectDialog`: a **Keep a local copy** `toggle-card` under the Remote card, on by default (D12/D13). Off → `remoteOnly`: Local location (and its `folderRequired`) hidden, a `project-dialog-path` hint (`remoteOnlyHint`) plus the D9 line `remoteOnlyHpcWarning` when `isHpcHost(settings, remoteConn)`; `create_project`/`import_project` get top-level `remoteOnly: true` and no `mirrorParent`; `needsGitInstall` ignores local git.
  - **New**: after `onProject`, `setUpHostFolder` *awaits* `connectCreatedRemoteProject`, then `remote_project_init_host({ projectId, scaffold: !skipScaffold, git: gitType !== "none" })`, patches the store's `git_type` if the report downgraded it (drops `git_provider` on `none`), and only then opens the description agent tab. A failed connect or init keeps the dialog open on `initHostFailed` with the button `initHostRetry`, which reruns that setup alone (`pendingInit`, the `pendingPublish` pattern; no second create).
  - **Clone** (Import → GitHub/GitLab with the copy off; fork not offered for remote): `isCloneImport` drops `!isRemoteProject` only when remote-only. It calls `create_project` (not import: A7's import would `git init` the folder first), spec `remote_path = <browsed>/<name>`, `gitProvider` from the URL; no local `git_clone`, never the init; awaits the connect, then one host shell tab `git clone --progress <url> .` (label `cloneOnHostTab`), then closes. `buildRemoteSpec(safeName, joinName)` got the `joinName` arg for this (default `kind === "new"`).
  - **D14**: a `toggle-card` (`pill.autoConnectOnLaunch` / `remoteConnect.autoConnectTitleEligible`) in the details step; pre-ticked only when the dialog's connect was headless, not via the sign-in terminal, with no password, no OpenVPN config, and not HPC (disabled on HPC, title `autoConnect.hpcTitle`). Ticked → the spec carries `auto_connect: true` (create keeps it; `strip_renderer_posture` only drops `remote_only`).
  - `publishLaterRemoteOnlyHint` replaces the mirror wording for a remote-only "Push to GitHub/GitLab".
- `lib/remote/remoteConnect.ts`: `connectCreatedRemoteProject` now resolves `null` (connected / already moving) or the failure text; other callers still `void` it.
- `ProjectSwitcher.addAndAudit`: no big-folder ask on `isHostPinned`.
- `projectTypeTags`: `key: "remoteOnly"`, "Host only", SSH's own colour, title names the target; not on a VM.
- `ProjectPill`: `hostPinned = isHostPinned(project)` hides Show on disk, `IdeMenuItems`, Move project…, Repair scaffold, Detach SSH host…; `revealOnDisk` returns on `remoteOnly` from `remote_mirror_status` (stale menu can't mint a mirror); Archive gets `pill.archiveRemoteOnlyLine`; `PublishWindow` and the provider-move window default `publishFrom: "remote"` and hide the side dropdown when pinned.
- `ProjectExportDialog`: `preview.remoteOnly` → no local radio, `transfer.remoteOnlyNote` + host tally line, the host is measured as soon as connected, request `mirrorSource: "host"` and `includeMirror` only while connected (else settings only). `ProjectImportBundleDialog`: `info.remoteOnly` → no mirror location, `transfer.bundleRemoteOnly`, `mirrorParent: null`.
- `RemoteMachinesWindow` (D4): on `isHostPinned`, the add form's "Sync a copy" is disabled (and read as off for the request) and a shared worker's "Sync a copy" switch cannot be turned on (a stale synced one can still be turned off); reason line `remoteMachines.syncCopyRemoteOnly`.
- TS: `ExportPreview.remoteOnly?`, `BundleInfo.remoteOnly?`, new `HostInitReport`; `MirrorStatus.remoteOnly` on the pill's inline type.
- Sibling (plan cockpit rule 4, "Open in IDE" gone): the IDE header button in `ProjectFilesView` and the IDE rows in `FileTree`'s root menu are hidden on pinned too (two one-line gates in A10's files).

**Choices**
- `RunHostPicker` without Local: already done by A2 (F1 owns it); not touched.
- Export i18n key named `transfer.remoteOnlyNote` (the dialog's prefix), not the plan's `projectExport.remoteOnlyNote`.
- Tag colour = the SSH tag's `#58a6ff` ("a token, not a new hue family"; the tag type wants hex).
- The clone hint replaces the token hint with `cloneOnHostHint` (the host's own git credentials clone it).
- Remote-only *folder* imports connect fire-and-forget as before (no host init: the plan gives init to New only).

**Gotchas**
- D14 key-auth case: the first pooled connect is sent `viaLogin` (no password), which records no `key_auth` (`record_key_auth`), so a pre-ticked auto-connect reads "ineligible" until the first manual connect from the lamp records the key auth (the existing `connectCreatedRemoteProject` doc already accepts that). Not changed — it is the password-host guard.
- The privacy hook flags empty-string bindings whose name ends in the words for a pass phrase or a secret; the dialog test's mock field is `typedSignIn`.
- The commit hook printed "MOBILE BUNDLE IS STALE": worktree mtimes, no `mobile-web/` change.

**Gates** (`scripts/gates.sh`, diff vs 3dab2b72): brand PASS, whitespace PASS, lint-fe PASS (0 errors; no warnings on touched files except the 2 pre-existing `ProjectFilesView` exhaustive-deps lines), build PASS, vitest `--changed` PASS. After the last two tweaks (IDE gates, test rename) re-ran tsc, eslint on touched files and the suites: `__tests__/projects` 37 files / 264 tests, `__tests__/files` + `ProjectPillIdeMenu` 38 files / 273 tests, all pass. New tests: `ProjectDialogRemoteOnly.test.tsx` 9, `ProjectPillRemoteOnlyMenu.test.tsx` 5, `remote/RemoteOnlyWorkers.test.tsx` 2; added 2 to `ProjectTypeTags.test.ts`, 2 to `ProjectTransferDialogs.test.tsx`, return-value asserts in `RemoteCreateFirstConnect.test.ts`. No Rust change (cargo gates skipped; `backend:stale` not run per brief). Not run live.

**Hot-file edits**
- i18n, MADE (en/de/es/fr/it, one block each right after `"projectDialog.cloneIntoVmTab"`): `projectDialog.keepLocalCopyTitle`, `.keepLocalCopyDesc`, `.remoteOnlyHint`, `.remoteOnlyHpcWarning`, `.cloneOnHostTab`, `.cloneOnHostHint`, `.initHostFailed`, `.initHostRetry`, `.initHostWorking`, `.publishLaterRemoteOnlyHint`; `projectType.tagRemoteOnly`, `projectType.titleRemoteOnly`; `pill.archiveRemoteOnlyLine`; `transfer.remoteOnlyNote`, `transfer.bundleRemoteOnly`; `remoteMachines.syncCopyRemoteOnly`.
- `src/lib/untested.ts`, NOT made — rows + pills to add at merge (row and markup together):
  - `projectDialog.keepLocalCopyTitle` { area: "projects", what: "ProjectDialog · Keep a local copy off = remote-only project: no Local location; a New connects, sets up the host folder (scaffold + git init) and only then opens its agent tab, a failed setup retries alone; the auto-connect card is pre-ticked only for a password-less, VPN-less, non-HPC sign-in; an HPC host gets a warning line" } — pill in the card's `.toggle-card-title` after the text.
  - `projectDialog.cloneOnHostTab` { area: "projects", what: "Import → clone with Keep a local copy off · <browsed>/<name> is made empty on the host and one host terminal tab runs git clone --progress <url> ." } — pill after the `cloneOnHostHint` text (the `hostClone` branch of the URL hint).
  - `projectType.tagRemoteOnly` { area: "projects", what: "Remote-only project · a Host only tag beside SSH in the pill hover card, naming the host" } — the tag is data (`projectTypeTags`); if a pill is wanted, beside the tag row in `ProjectHoverCard`, else row-only is not allowed by the registry test — skip it then.
  - `pill.hostPinnedMenu` { area: "projects", what: "Remote-only or VM project · the pill menu has no Show on disk, Move project…, Detach SSH host…, Repair scaffold or Open in IDE (nor the file panel's IDE button/rows); Archive says nothing exists locally; Publish… and Move to provider… run on the host with no side choice" } — pill after the `archiveRemoteOnlyLine` text in the Archive confirm.
  - `transfer.remoteOnly` { area: "projects", what: "Remote-only project · Export packs the tree from the host only (settings alone while disconnected); importing its bundle asks for no mirror folder" } — pill after `transfer.remoteOnlyNote` in `ProjectExportDialog`.
  - `remoteMachines.syncCopyRemoteOnly` { area: "remote", what: "Remote-only project · Remote machines: Sync a copy is disabled with the reason, in the add form and on shared workers" } — pill on the add form's reason line.
- `docs/filemap_frontend.md`, NOT made: row `ProjectDialog.tsx` (l.87) append "Keep a local copy off = remote-only (awaited connect → `remote_project_init_host` → agent tab; host clone tab; D14 auto-connect card)"; row `projects/ProjectPill.tsx` (l.135) append "menu rows needing a local copy hidden on `isHostPinned`; Publish from the host"; row `projects/RemoteMachinesWindow.tsx` (l.140) append "no synced-copy workers on a remote-only project (D4)".
- No `command_class` change (no new command).

**Flagged for user**
- D14 on a key-auth host: the pre-ticked auto-connect only starts working after one manual connect records the key auth (see Gotchas). Say if creation should record key auth itself; that would change the `viaLogin` guard for password hosts whose master was opened elsewhere.

## A8 review — verifier

Branch `ro-rv8` (on ro-int 381459a9), one commit **affbc764**. I re-checked each finding in `a8_findings.md` against ro-int's code.

**Findings**
- **F1 picker vs tiles fallback mismatch: fixed.** Confirmed. With no primary row listed, the `<select>` showed `machines[0]` (a connected worker), but the tiles fell back to "" (stuck, no hint), and picking the shown row fired no change. Both now read one rule, `pinnedFallback(machines)` in `NewTabSheet.tsx`: the primary, else the first connected machine, else the first row. The agent starts on that row while it is connected. The plan's behaviour is unchanged: with an offline primary, the primary is still shown, nothing starts and the hint shows. Test: `MobileNewTabSheet.test.tsx` "starts on the machine it shows when no primary is listed".
- **F2 synced-copy workers offered on a remote-only project: fixed.** Confirmed. `HostMachine.runnable` was `shared_fs || sync_code` whatever the posture. After E8, or with a record written before A3's refusal, the phone listed such a worker and could start an agent on a tree nothing feeds (D4).
  - Sidecar: `ProjectHosts.pinned` (`host_pinned`), `runnable = shared_fs || (sync_code && !pinned)`. `phone_machines` and the create's machine lookup both filter on `runnable`, so the worker is neither listed nor nameable.
  - Window: `workerRunnable(h, pinned = false)` in `stores/tabs/tabLocation.ts`. The bridge's `phoneHostLocation` passes `isHostPinned(project)`.
  - Sibling, same bug on the desktop: the "+" ▾ machine list (`agentMachines`, which already had `pinned`) and the tab badge's `LocalityMenu` now offer that worker disabled. The badge gets a new title `tabLocality.syncOffPinnedTitle`, because the old title says to enable "Auto-sync code", which is refused on a remote-only project.
  - Tests: `a_machine_is_named_by_its_label_and_runnable_only_with_the_code` (pinned arm), `a_remote_only_project_runs_everything_on_its_host` (w1 not runnable), `AgentMachineMenu.test.tsx`, `HostPinnedLocality.test.tsx` "offers a synced-copy worker disabled…", plus the F3 and F4 tests.
- **F3 window-side host create for remote-only untested: test added.** `MobileHostMachines.test.tsx` "starts a remote-only project's agent on its hosts alone…". It covers:
  - `remote` and a shared-fs worker are created with `cwd` = the project directory (the `scope.cwd || directory` line);
  - a synced-copy worker gives `host_not_found`;
  - a host-less create gives `project_ineligible`;
  - a shell gives `not_attachable`.
- **F4 sidecar happy path untested: test added.** `a_remote_only_project_starts_an_agent_on_a_listed_machine` (host/tests.rs, appended at the end). `launch-options` lists exactly the primary and the shared-fs worker, both connected. A create naming each passes `creatable` and reaches the window as `Create` with `host: "remote"` / `"host:w3"`. A sign-in on its host tab gives `409 tab_on_host` and never reaches the window. To get past `master_up` without an sshd, I added a test-only seam: `ssh_exec::TEST_LIVE_MASTERS` (`#[cfg(test)]`), checked first in `master_alive`, with per-tempdir paths so tests stay independent. `host.rs` is untouched.
- **F5 reused pill ids: confirmed, listed (HOT_FILE_RULE).** `scripts/untested.mjs check` fails on a pill id that has no register row, so the swaps have to land together with the rows. Both are below.
- **F6 fixture `lists` column is table-level: no action (Info).** It is correct as documented. Production `host_of_tab` for pinned projects is pinned by `a_remote_only_project_runs_everything_on_its_host` (labels and `on_host`).

**Main-checkout dirty files touched (keep minimal at merge)**
- `mobile-web/src/screens/NewTabSheet.tsx`:
  - the `primary` fallback lines become `shown = pinned ? pinnedFallback(machines) : undefined; primary = shown?.connected ? shown.id : ""`;
  - the `MachinePicker` display fallback becomes `pinnedFallback(machines)?.id`;
  - new helper `pinnedFallback` above `DefaultStar`.
  - At merge with the other session's `.option-list` rewrite: `current = rows.find(id === (value || (here ? "" : pinnedFallback(machines)?.id))) ?? rows[0]`.
- `src/components/mobile/MobileBridgeHost.tsx`: one line in `phoneHostLocation` (`workerRunnable(worker, isHostPinned(project))`).
- `mobile_control/host.rs`: not touched. `host/tests.rs`: one test appended at the end.

**Gates** (`scripts/gates.sh`, diff vs 381459a9): brand, whitespace, lint-fe (0 errors, no new warnings; touched files lint clean), clippy, clippy-dlib, clippy-dmn, build, vitest `--changed`, `cargo test -p tabtivity -p app-serverd`, test-dlib all PASS. gates.sh drops its logs on success, so I reran the lib tests by hand: **4893 passed, 0 failed, 7 ignored**. The 4 touched vitest files: 42 passed. Not run live; `backend:stale` not run (brief). The pre-commit hook says the mobile bundle is stale (expected for a `mobile-web/` source edit; `npm run mobile:bundle` at integration).

**Hot-file edits**
- i18n (made, one key in en/de/es/fr/it, right after `tabLocality.syncOffTitle`): `tabLocality.syncOffPinnedTitle`.
- `src/lib/untested.ts` (listed, not made), for F5. Add rows, then swap the pill ids:
  - `"mobile.newTab.remoteOnly": { area: "mobile", what: "NewTabSheet · remote-only project: Runs on lists its machines alone (no Desktop row), the primary preselected (else the first connected machine when no primary is listed); nothing starts while none is connected (connect hint); no shell/worktree/cloud/local-model/API-key/sign-in/send-a-file rows; with no window the 'needs the desktop window' line" }`. Swap the pills at `NewTabSheet.tsx` `remoteOnlyNeedsWindow` (`mobile.newTab.machine` → `mobile.newTab.remoteOnly`), and in `MachinePicker` use `here ? "mobile.newTab.machine" : "mobile.newTab.remoteOnly"`.
  - `"mobile.project.remoteOnly": { area: "mobile", what: "Project · remote-only project: header line 'everything runs on the remote host' (own × flag), no-folder line pointing at ☰ Files, no one-tap ＋ quick create and no ★ default" }`. Swap the pill at `mobile-web/src/screens/Project.tsx` (the note's `mobile-every-project-type` → `remoteOnly ? "mobile.project.remoteOnly" : "mobile-every-project-type"`).
  - `"mobile.hostReach.remoteOnly": { area: "mobile", what: "Phone access picker / file panel phone button / Settings → Mobile row: a remote-only project's reach line (host tabs and host files only)" }`. Swap the `UntestedTag` in `MobileAccessPicker.tsx` (`mobile-every-project-type` → `host === "remote_only" ? "mobile.hostReach.remoteOnly" : "mobile-every-project-type"`).
  - `"tabLocality.syncedCopyPinned": { area: "tabs", what: "Tab badge / + ▾ machine list: on a remote-only project a synced-copy worker is offered disabled ('sync off', new pinned tooltip); a shared-filesystem worker stays runnable" }`. Pill: an `UntestedTag id="tabLocality.syncedCopyPinned"` beside the disabled note in `LocalityMenu`, if the register wants one.
- `docs/filemap_backend.md` (listed): row `services/mobile_control/discovery.rs`: append "a remote-only project's synced-copy worker is not runnable (D4)". Row `services/remote/ssh_exec.rs`: "`TEST_LIVE_MASTERS` test seam for `master_alive`".
- `docs/filemap_frontend.md` (listed): row `stores/tabs/tabLocation.ts`: "`workerRunnable(h, pinned)`: a synced copy runs nothing on a pinned project".
- No `command_class` change.

**Flagged for user**
- With an offline primary and a connected worker, the remote-only sheet still shows the primary and starts nothing until the worker is picked (the plan's "preselect the primary"). Auto-falling back to the worker would be one line in `pinnedFallback`.
- Backend spawn paths do not refuse a synced-copy worker of a remote-only project. The UI (phone and desktop) now hides or disables it, and `add_compute_host`/`patch_compute_host` refuse to create one, but an old tab saved at `host:<that worker>` still spawns there on restore. This is E8 / A12's call: either the conversion moves such tabs, or `launch_prep` refuses.

## A13 — docs (F10 + E9) and the deferred hot-file edits

Branch `ro-a13`, commit **04e8b7fb** (one commit on ro-int 15f95865 = everything except A12).

**Hot-file edits applied (A1 → A8 review)** — each checked against the merged code first.
- `src/lib/untested.ts`: 16 rows added, each with its pill in the same commit (`node scripts/untested.mjs check`: "The register and the source agree").
  - files: `projectFilesPane.disconnectedHostOnly` (both prompts in `ProjectFilesPane`, main pane + `BoxRootSection`, not while "connecting"), `fileTree.hostFileExternalTitle` (in the message body, `FileTree.openEntry`), `sidePanelViews.pinned` (in `ProjectFilesView`'s header where the source switch was), `fileTree.hostSearch` (end of the search-mode row on pinned).
  - embed: `tex.compileOnHostTab` (after Compile in `TexView` on pinned), `fileTree.sqliteHostOnly` (in `SqliteView`'s note; import added).
  - projects: `projectDialog.keepLocalCopyTitle` (toggle-card title), `projectDialog.cloneOnHostTab` (after `cloneOnHostHint`), `projectType.tagRemoteOnly` (`ProjectHoverCard` tag row, only when the Host only tag is present), `pill.hostPinnedMenu` (after `archiveRemoteOnlyLine`), `transfer.remoteOnly` (end of the remote-only note in `ProjectExportDialog`), `remoteMachines.syncCopyRemoteOnly` (add form's reason line).
  - mobile (A8 review F5, swaps): `mobile.newTab.remoteOnly` (`NewTabSheet` `remoteOnlyNeedsWindow` line; `MachinePicker` label `here ? machine : remoteOnly`), `mobile.project.remoteOnly` (`Project.tsx` note: `remoteOnly ? … : "mobile-every-project-type"`), `mobile.hostReach.remoteOnly` (`MobileAccessPicker`: `host === "remote_only"` → own pill). Ternaries are written as two literal calls so the scanner sees both ids.
  - tabs: `tabLocality.syncedCopyPinned` (`LocalityMenu` machine row gained an optional `tag`; set on a disabled worker of a pinned project).
- `docs/filemap_backend.md`: A1-review wording for `remote.rs` (`local_copy_in`: VM always, else the flag, local → None) and `remote_sync.rs` (`mirror_dir_opt` = `local_copy_in` by id); appended A3 (`remote.rs` `mints_mirror`, `git_peer.rs`, `sync_auto.rs`, `worker_sync.rs`), A4 (`git_bounded.rs`, `ssh_exec.rs`), A5 (`remote.rs` `entry_is_remote_only`, `project_transfer.rs`), A6 (`fs.rs` `list_project_paths`), A7 (`projects.rs`, `ssh_exec.rs`), A8 (+review: `discovery.rs`, `ssh_exec.rs` `TEST_LIVE_MASTERS`), A3+A4 review (`git_hardened.rs`, `ssh_exec.rs`), E9 (`commands/vm.rs` `has_mirror` posture). New rows: `commands/search.rs` (none existed), `remote/host_search.rs`, `remote/remote_scaffold.rs`.
- `docs/filemap_frontend.md`: `PaneSlot.tsx`, `ProjectDialog.tsx`, `MobileAccessPicker.tsx`, `ProjectPill.tsx`, `RemoteMachinesWindow.tsx`, `FileTreeSearch.tsx`, `sidePanelViews.ts`, `TexView.tsx`, `projectTabHost.ts` (`phoneProjectFolder`), the `tabs/{…tabLocation…}.ts` row (`workerRunnable`); new row `lib/viewers/tex/hostTexBuild.ts`. No `useFileTreeRemote.ts` / `QuickOpen.tsx` rows exist, so none added.
- Already done by the steps (checked, nothing to do): A1 review's `isHostPinned` parity line (`remote.vm === true || remote_only === true`), every i18n key, A7's `command_class` row + `commandClasses.ts`.

**A13 docs**
- `docs/help/remote-projects.md`: new `## Remote-only projects` (create with Keep a local copy off, New/clone/folder import, where things run, Download to…, what is absent and why, VM note); step 3 of "Create" points at it; keywords + `remote-only`, `host only`, `no local copy`, `keep a local copy`, `download` (20 of 32). Topic 6.8 KB (< 16 KB), section ~3 KB (< 8 KB).
- `docs/help/sync.md`: one line — remote-only and VM projects have no mirror, nothing syncs.
- `DOCUMENTATION.md` §"Remote, Sync, and Multi-Host": one **Remote-only** bullet.
- `docs/context/remote_projects.md`: new `## Remote-only` rationale section (posture + VM fold, renderer never sets it, one resolver + sentinel, no local execution, host git hardening/old git, host init, host search, D4 workers, D5, TeX build in the login shell, export/import, conversion decisions D7/D8 without UI names).
- `docs/context/vm_projects.md`: "a VM is remote-only + boot" paragraph; `commands::terminal::vm_spawn_refusal` → `services::launch_prep::pinned_spawn_refusal` (`Pin::Vm`), `vmProject` → `hostPinned`; says no frontend code maps `_VM_DOWN` yet. (The "frontend turns `_VM_DOWN` into a boot action" sentence the plan review named was not in the doc any more; the correction is added as a positive statement.)
- `todo/group-g-remote.md`: new `### G.27 — Remote-only projects` at the end of the file (after G.26's trailing numbered items, so their grouping is unchanged): 11 ticked 🤖 boxes (A1–A11, real test names, all verified to exist), one unticked 🤖 box for A12, 12 🖐️ boxes (F10's list + export; the last two are the conversion) each with the four-platform ✅/❌ pair, none ticked, and an **Open** line with the handoff's flagged residuals. G.26 sibling fixes: the `vm_spawn_refusal`/`vmProject` names annotated with their G.27 successors, the spawn-refusal matrix test location (`services::launch_prep`), and the "Frontend follow-ups" item no longer claims the badges mislabel VM tabs (A2 fixed that).

**Choices**
- Skipped the optional `newTabMenu.hostPinned` pill (A11): the change only removes rows, and a pill on the Shell entry would tag an unchanged row.
- TeX/SQLite rows use area `embed` (the register's section for viewers), not A11's suggested `viewers`.
- Help docs describe no conversion (A12 not in this base); the context doc states the D7/D8 decisions only. **A12: add one line for the two pill rows to `docs/help/remote-projects.md` § Remote-only projects and tick G.27's A12 🤖 box once landed.**

**Gates** (`scripts/gates.sh`, diff vs 15f95865): brand PASS, whitespace PASS, lint-fe PASS (0 errors; the only warnings on touched files are the 2 pre-existing `ProjectFilesView` exhaustive-deps lines), build PASS, vitest `--changed` PASS; cargo gates skipped (no Rust change). Touched suites run directly: 10 files / 87 tests pass (incl. `UntestedRegistry.test.ts`). The commit hook printed "MOBILE BUNDLE IS STALE" (a `mobile-web/` source edit; `npm run mobile:bundle` at integration). No Rust change (`docs/help/*.md` is compiled into the help MCP corpus; parse rules checked by hand: frontmatter unchanged in shape, keyword count/length within limits). Not run live; `backend:stale` not run (brief).

**Hot-file edits for A12 (left to it)**: the `pill.stopLocalCopy*` / `pill.keepLocalCopy*` register rows + pills, the `remote_unpair_mirror{,_preview}` `command_class` rows, the `commands/projects.rs` filemap row's conversion clause.

**Flagged for user**: none new. The G.27 Open line repeats the residuals already flagged by A3+A4 review (git < 2.9), A8 review (saved synced-copy-worker tabs) and A9 (D14 key auth).

## A12 — conversion Remote ⇄ Remote-only (E8 + F9)

Branch `ro-a12`, commit **80af8286** (one commit on ro-int fd073162; touches none of the A8-review files).

**What landed**
- New `commands/remote_unpair.rs` (top-level, not `commands/projects/…`: `build.rs`'s core-dispatch generator only scans `src/commands/*.rs`):
  - `remote_unpair_mirror_preview(projectId) -> UnpairPreview` (async over blocking; refuses "connect first" at once via `remote::is_connected`, never dials). Counts `commitsNotOnHost` (`rev-list --count` of the mirror's branch tips, a detached HEAD and tags the host lacks by name+sha, `--not` what the host has, via `git_peer::known_shas` — now `pub(crate)` — and two hookless probes), `uncommitted` (`status --porcelain=v1 -z` entries, untracked included), `unpushedSyncEdits` (manifest file entries diverged on the local side by `remote_sync::divergence`; an unreadable path counts), `localTabs` (saved layout, `tab_runs_here` = the window's unpinned rule), `stoppedWorkers` (labels of `sync_code && !shared_fs` workers), `mirrorPath`/`keptAt`/`moves`, `fingerprint` (sha256 over mirror path, `refs_signature`, raw porcelain, `sync.json` len+mtime(ns), and the counts). Any unreadable git side or manifest → error, never zero.
  - `remote_unpair_mirror(projectId, expect) -> UnpairOutcome { entry, keptAt, moved, moveError }`: connected check → `sync_op::acquire_manual` → the **whole preview again under the lock** (host included) → refuses `{UPPER}_MIRROR_CHANGED: …` on a fingerprint mismatch, or any blocker → `apply_unpair_blocking` (registry + `project.json`: `remote_only: true` field-level, `mirror` and a `"local"` run host removed; `clear_host_bound_files` = `sync.json` + `git_peer.json`; `local_loss.json` survives) → manifest cache evicted → `move_out_blocking` → lock dropped → `git_peer::stop` + `sync_auto::stop`.
  - D8: a mirror inside the state dir (the default location, or an explicit one pointing there) moves via `move_tree` (rename, cross-device copy **with `.git`**, source removed only after the copy) to `projects_ssh_root()/<sanitized name> (local copy)` (` 2`, ` 3`… when on disk or registered). An explicit mirror stays. A failed move leaves the folder where it was and reports `moveError` + its path; the conversion itself stands.
  - VMs refused both ways (`entry_is_vm || is_vm_spec`); an already remote-only project refused with the `_REMOTE_ONLY` sentinel.
- Reverse: `set_remote_mirror_dir(ctx, projectId, path, keepLocalCopy?)`. Only `keepLocalCopy: true` accepts a remote-only project (VM refused): absolute path, not under the state dir, no registry conflict; under the sync lock; first `pin_saved_tabs_to_host` (saved agent/shell tabs with no host location → `"remote"`), then one mirrored write that sets `mirror` and removes `remote_only` (before any lockstep call — A3's note). Starts `sync_auto` when connected. Pairing: the dialog then calls `git_peer_set_enabled(true)` (git projects), host authoritative through the existing `pairing_conflicts` flow. Without the flag: refused as before (A5).
- **L3 (A3 verifier)**: `git_peer` (initial pass + `guarded_pass`) and `sync_auto::reconcile_pass` re-read the posture (`remote::is_remote_only_now`) **after taking the sync lock** and end; `sync_auto`'s tick also breaks the loop. The conversion writes the flag under that lock, so a pass queued behind it (this process or the sidecar's, which this process cannot stop) never acts on the old spec or the moving mirror; the tasks are stopped after.
- **A8-verifier input**: `launch_prep::synced_worker_spawn_refusal` — a remote-only project's tab on a `sync_code && !shared_fs` worker is refused with `_REMOTE_ONLY` (shared-fs and code-sync-off workers still run, D4). The preview also names such workers.
- Sibling fix: `move_remote_mirror`'s cross-device fallback used `copy_dir_all` (drops `.git` and nested repos) and then `remove_dir_all`'d the original — git history lost on a cross-drive "Move project…". Now `copy_tree_core(.., keep_git: true)`.
- Frontend: `components/projects/LocalCopyDialogs.tsx` (`StopLocalCopyDialog`, `KeepLocalCopyDialog`, both `AsyncConfirmDialog`); two Edit-group rows in `ProjectPill` (Stop = `danger`, on a plain Remote; Keep, on a remote-only one; both absent on any VM, disabled until the primary lamp is `connected`). Stop shows the counts (backend's local tabs maxed with this window's live unpinned-local tabs), refuses while any is non-zero, names the workers and the kept path; success shows a message with the kept path (or the move failure); a `_MIRROR_CHANGED` refusal re-runs the preview and asks again. Keep shows the suggested folder (`remote_mirror_status.suggested`) + "Choose another folder…", the host folder's size (`remote_download_size ""`, upper bound), sends `keepLocalCopy: true`, then pairs. Store: `stopKeepingLocalCopy`, `keepLocalCopy` (`projects.ts`), `pinScopeTabsToHost` (`tabs.ts`); TS `UnpairPreview`/`UnpairOutcome`.

**Choices**
- The commit needs the host and re-runs the full preview (not only the local fingerprint): the host-side count can't be re-checked otherwise, and the instructions say refuse when in doubt.
- Untracked files in the mirror count as `uncommitted` and block (the folder is kept, but the user would believe the work is on the host). Stricter than the plan's "uncommitted changes"; the user commits, ignores or deletes them.
- The reverse pins tabs: without it an agent tab saved with no `location` (host under the pin) defaults to the mirror once the project keeps one and respawns locally without its host session.
- Worker fan-out bundles read the mirror without the sync lock; a move during one fails that push only (read-only, nothing lost).

**Gotchas**
- `build.rs` generates the core-dispatch wrappers from top-level command files only; a command in a submodule fails `every_core_command_has_a_wrapper_or_is_a_known_gap`.
- A bool argument whose name contains "local" needs a `NotAPath` row in `core_dispatch::USER_CONFINED` (added: `set_remote_mirror_dir.keepLocalCopy`).
- Reads of `tab_layout` need a `// project-tree-read: ok` marker (`tests/project_tree_intent.rs`).

**Gates** (`scripts/gates.sh`, diff vs fd073162): brand, whitespace, lint-fe (0 errors, 28 warnings = the existing ones), clippy ×3, build, vitest `--changed` (730 files / 6858 tests), `cargo test -p tabtivity -p app-serverd` (lib 4904 passed, 7 ignored; `it` 143; `projects_commands` incl. 2 new), test-dlib — all PASS. New tests: 12 in `remote_unpair` (refusals, VM both ways, tab rule, porcelain parser, tips, kept destination + suffixes, move-out keeps `.git` and never deletes on failure, sentinel, blockers, sync-edit count, tab pinning), 1 in `launch_prep` (synced-worker refusal), integration `a_remote_project_stops_and_resumes_keeping_a_local_copy` + `an_explicit_mirror_stays_in_place_when_the_copy_is_dropped`, vitest `ProjectPillLocalCopy.test.tsx` 7. `backend:stale` not run (brief). Not run live.

**Hot-file edits**
- Made: `command_class` rows `("remote_unpair_mirror", Core)`, `("remote_unpair_mirror_preview", Core)`; `commandClasses.ts` regenerated (+2); `lib.rs` registration; `core_dispatch` `NotAPath` row.
- i18n, MADE (en/de/es/fr/it, one block each right after `"pill.archiveRemoteOnlyLine"`): `pill.stopLocalCopy{Ellipsis,MenuTitle,NeedsConnection,Title,Checking,Commits,Uncommitted,SyncEdits,LocalTabs,Blocked,After,KeptMoved,KeptStays,NoFolder,Workers,Confirm,Busy,Changed,DoneTitle,DoneBody,MoveFailed}`, `pill.keepLocalCopy{Ellipsis,MenuTitle,NeedsConnection,Title,Folder,Choose,ChooseTitle,Size,SizeChecking,How,NoGit,Confirm,Busy}`.
- `src/lib/untested.ts`, NOT made — rows + pills at merge:
  - `pill.stopLocalCopy` { area: "projects", what: "Remote project · Stop keeping a local copy…: preview of commits/changes/byte-sync edits/local tabs the host lacks blocks the confirm; on confirm the project turns remote-only and the old mirror is kept (moved out of the state folder as '<name> (local copy)' when it lived there), path shown" } — pill on the menu row (`className="untested danger"` + `<UntestedTag id="pill.stopLocalCopy" />`).
  - `pill.keepLocalCopy` { area: "projects", what: "Remote-only project · Keep a local copy…: pick a folder (projects-ssh/<name> by default), the project keeps a mirror again and git lockstep pairs it from the host" } — pill on the menu row.
- `docs/filemap_backend.md`, NOT made: new row `commands/remote_unpair.rs` — "Remote ⇄ Remote-only conversion (E8): preview counts + fingerprint, commit under the sync lock, mirror kept/moved out, never deleted"; touch `commands/projects.rs` (`set_remote_mirror_dir` `keepLocalCopy` reverse; `move_remote_mirror` keeps `.git` cross-device), `launch_prep.rs` (synced-worker refusal), `remote.rs` (`is_remote_only_now`), `git/git_peer.rs` + `remote/sync_auto.rs` (posture re-read under the lock).
- `docs/filemap_frontend.md`, NOT made: new row `components/projects/LocalCopyDialogs.tsx` — "the pill's Stop keeping / Keep a local copy dialogs (E8/F9)"; touch `ProjectPill.tsx` (+ the two Edit rows), `stores/tabs.ts` (`pinScopeTabsToHost`).

**Flagged for user**
- Untracked files in the local copy block "Stop keeping a local copy" (see Choices). Say if only tracked changes should block.
- Sibling bug NOT fixed (not code this step touches): `import_project` in `"move"` mode has the same cross-device fallback (`copy_dir_all`, then `remove_dir_all` of the source), so a cross-drive move-import drops the folder's `.git`.
- "Keep a local copy…" shows the host folder's whole size (untracked/ignored files included) as an upper bound; pairing itself copies the committed history only.

## Final review

Branch `ro-int`, commit **4528202c** on 31ea25d2 (the whole range `70344a96..31ea25d2` reviewed; A12 read line by line).

**Bugs fixed (each with a regression test)**
- Sibling bug A12 flagged, confirmed: `import_project` in `"move"` mode fell back to `copy_dir_all` (drops `.git` and nested repos) on a cross-drive move and then `remove_dir_all`'d the source — the history was gone. Both cross-drive moves (`import_project` "move", `move_remote_mirror`) now go through one `move_fresh_tree(src, dst, what, rename)` (rename, EXDEV → `copy_tree_core(.., keep_git: true)` then remove, any other rename error reported, nothing copied). Test `a_cross_device_move_keeps_git_and_nested_repos` (`commands/projects/tests.rs`, injects an EXDEV rename; also covers A12's `move_remote_mirror` fix, which had no test).
- The `{UPPER}_REMOTE_ONLY` sentinel was mapped only by the terminal's spawn note and the two conversion dialogs; every other surface (git, worktree, export, Move project…, IDE, hpc workspace, the dialog's host-init error…) showed the raw English tail, against engine rule 4 ("never shows raw text"). `friendlyError` (`src/lib/errors.ts`) now has it as its first rule (`tabs.remoteOnlyRefused`), so every `ErrorNote` words it and keeps the raw text under Details. Test in `FriendlyErrors.test.tsx`.

**Leftovers applied**
- `untested.ts`: `pill.stopLocalCopy`, `pill.keepLocalCopy` rows + pills on the two `ProjectPill` Edit rows (`untested.mjs check`: register and source agree).
- Filemaps: new rows `remote_unpair.rs`, `projects/LocalCopyDialogs.tsx`; touched `projects.rs` (reverse + `move_fresh_tree`), `launch_prep.rs` (synced-worker refusal), `remote.rs` (`is_remote_only_now`), `git/git_peer.rs`, `remote/sync_auto.rs` (posture re-read under the lock), `ProjectPill.tsx`, `tabs.ts` (`pinScopeTabsToHost`).
- `docs/help/remote-projects.md` § Remote-only projects: the conversion paragraph (Stop keeping / Keep a local copy…, refused while the copy holds anything, folder kept never deleted, not on VMs).
- `todo/group-g-remote.md` G.27: A12 🤖 box ticked with its test names; intro no longer says "in progress".
- Checked, nothing to do: no TODO/FIXME added in the range; all 68 new i18n keys exist in en/de/es/fr/it and are used; no brand name spelled in new code; the three new/changed commands carry `cfg_attr(feature = "desktop", tauri::command)` + `command_class` rows and `commandClasses.ts` is current (gate); merges: only A5 and A7 had hand resolutions (both sides kept).
- `mobile-dist/` is gitignored (rebuilt by `npm run build`; nothing to commit).

**Integration checked, no bug found**: `RemoteSpec::is_remote_only` ↔ `isHostPinned` (+ VM record) ↔ phone `runnable`/TS `workerRunnable(pinned)` ↔ `synced_worker_spawn_refusal`; Rust `tab_runs_here` ↔ `effectiveTabLocation`/`isLocatableKind`/`isLocalAgentKind`; conversion: preview re-run under `sync_op` with the host, fingerprint over refs/porcelain/`sync.json`/counts, registry flip refuses a changed mirror path, `clear_host_bound_files` keeps `local_loss.json`, manifest cache evicted under the lock, move never deletes the source before a full `.git`-keeping copy, lockstep/auto-sync passes queued behind the lock end on `is_remote_only_now`, tasks stopped after; reverse pins saved + live tabs before the flag drops, lockstep only enabled after; VMs refused both ways.

**Flagged for user**
- A failed move-out (`moveError`) leaves the old default mirror inside the state dir, now unregistered: a later Delete/forget of the project that purges `<state_dir>/remote-projects/<id>/` would take it with it. The dialog shows the path; say if the purge should skip a leftover `mirror/`.
- A non-git remote project's mirror can hold files never selected for byte-sync (local-only new files); "Stop keeping" counts only manifest entries, so these do not block. The folder is kept, so nothing is deleted, but the user may think they are on the host.
- Open viewer tabs that hold an absolute path inside the old mirror keep reading that local folder (or fail once it moved) after the conversion; not traced further.
- Keep a local copy…: if `git_peer_set_enabled` fails after the folder was recorded, the dialog shows the raw error and a second confirm is refused ("already keeps a local copy"); lockstep can be turned on from the git panel.
- A12's own flags stand (untracked files block Stop; the Keep size is an upper bound).

**Gates** (`scripts/gates.sh --all`): brand, whitespace, lint-fe (0 errors), clippy ×3, build, vitest (990 files / 9820 tests), cargo test --workspace (tabtivity lib 4906 passed / 7 ignored, `it` 143, `projects_commands` 36, other crates 101 + 136), test-dlib — all PASS. `npm run mobile:bundle` rebuilt `mobile-dist/` (gitignored, so nothing to commit). `scripts/privacy-check.sh` PASS. Not run live; `backend:stale` not run (brief).
