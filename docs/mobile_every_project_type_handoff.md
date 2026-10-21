# Phone access for every project type: handoff

Plan: `docs/mobile_every_project_type_plan.md`. Worktree
`.claude/worktrees/mobile-every-type`, branch `mobile-every-type`. One section
per agent step; later agents append theirs.

## A1. Catalog (plan step 1)

Commit: see `git log` (the commit whose message starts `feat(mobile): catalog
lists every project type`).

### What was built

`services/mobile_control/discovery.rs`:

- `mobile_local` is gone. `scope_sources` lists every opted-in project; a box
  member contributes `mobile_root(state_dir, member)` whatever its type.
- `ProjectRecord.mirror: Option<String>` (the flattened top-level `mirror`
  key; `lenient_string`, a non-string is `None`, never a parse error).
- `project_host(&ProjectRecord) -> ProjectHost` (`vm.enabled` first, then
  `remote`, then `sandbox.enabled`, else local).
- `mobile_root(state_dir, &ProjectRecord) -> Option<PathBuf>`: local and
  container the `directory`; remote the trimmed `mirror` else
  `remote_sync::default_mirror_dir_in(state_dir, id)`; VM the `mirror` only.
- New pub enums `ProjectHost { Local, Remote, Container, Vm }` and
  `CreateVerdict { All, Agents, None }`, both `Serialize` as lowercase words.
- `ResolvedProject` gains `host`, `folder: bool`, `create`, and
  `has_folder()` (returns `folder`).
- `SavedTab.location: Option<Value>` (loose); `tab_is_local(kind, location,
  vm_project)` is the Rust twin of `effectiveTabLocation`; `tab_on_this_machine`
  applies it per host (remote/VM: local tabs only; container: drop agents, and
  shells while the spec scope is not `agents`; local: everything).
- `ScopeSource` gains `host`, `cwd_alias` (a remote project's `directory`) and
  `shells_in_container`. `resolve_scope` reads a tab saved with
  `cwd == directory` as `cwd = mirror` (so it is below the root and
  `ResolvedTab.cwd` names where the agent ran).
- A remote or VM project whose first root does not resolve (or a VM with no
  root) is listed with no tabs, `folder: false`, `create: None`.
- `create_verdict`: local `All`; remote with a folder `Agents`; remote without
  one, container, VM `None`; box, root, assistant `All` (their host is
  `Local`).

`commands/projects.rs`: `set_project_mobile_access` lost both type checks
(before and inside `patch_project_entry`); `mobile_access_prerequisites` stays.
`commands/boxes.rs`: one doc comment reworded. `headless.rs`: only the one
test `ResolvedProject` literal gained the three fields (A3 owns the rest).
`docs/filemap_backend.md`: a new `mobile_control/discovery.rs` row.

Tests (discovery.rs): `every_project_type_is_listed_with_its_own_folder`,
`a_remote_project_without_a_mirror_is_listed_empty`,
`a_remote_tab_saved_with_the_project_directory_is_read_in_the_mirror`,
`only_tabs_with_a_local_session_are_listed_on_remote_vm_and_container_projects`,
`the_tab_locality_rule_matches_the_windows_table`,
`the_mirror_key_is_read_leniently`; the box test now includes a remote
member's mirror and a mirror-less VM member. TS twin:
`src/__tests__/mobile/MobileTabLocality.test.ts` reading
`src/__tests__/mobile/tabLocality.fixture.json` (the Rust test `include_str!`s
the same file).

### Choices where the plan was silent

- `folder` is false for the assistant even when its work folder exists
  (today's `host.rs::has_folder` refuses it by kind); true for box and root.
  So `has_folder()` is a drop-in for the kind test in `host.rs::has_folder`,
  but the `== ScopeKind::Project` gates (git, worktrees, files flag) must
  become `kind == Project && has_folder()`: a box and root have a folder and
  are not git projects.
- Only a remote or VM project is listed folder-less. A local or container
  project whose folder is missing is still dropped (unchanged), and so is a
  local/container record with no `directory`.
- A folder-less project's `root` is a path that exists nowhere: the remote
  mirror it would have, or `default_mirror_dir_in(state_dir, raw_id)` for a
  VM with no mirror. Nothing may read or write it while `folder` is false; A2's
  gates must cover every route that takes `root` (inbox, upload, markup).
- Locality: only an exact `"local"` location is local; `"remote"`,
  `"host:<id>"` and any unknown string are not. `local_agent` is always local
  (TS does the same, even in a VM project).
- Container: `agent` runs in the container, `shell` iff the spec scope is not
  `agents`, any other kind (`local_agent`) on the host. A container project's
  `create` is `None` even for scope `agents` (plan: refused in phase 1).
- The cwd alias applies to remote (non-VM) projects only and only when the
  entry has a `directory`.
- `host`/`create` are on `ResolvedProject`, not `PublicProject`: A2 decides how
  they reach the list and detail payloads (names fixed by the plan: `host`,
  `folder`, `create`).

### Gotchas for A2 / A3 / B*

- Anything that builds a `ResolvedProject` literal needs the three fields
  (`fixture_scope`, the `headless.rs` test, any host.rs fixture).
- A remote project's `ResolvedTab.cwd` is now the mirror path for window-made
  tabs; A3's `launch_options` should use `project.root` as the mirror.
- Locality is decided from the saved record; a tab in a remote project with an
  unset `location` and `kind: "shell"` is never listed. A phone-made agent in
  a remote project must carry `location: "local"` (A3) or it is invisible only
  if it is a shell; an agent defaults local, so stamping is belt and braces.
- B1 (desktop bridge) must compute the same folder as `mobile_root`
  (`resolveLocalMirror(project)` else `${directory}/mirror`).
- The set_project_mobile_access change has no Rust unit test (it needs the
  global state dir and tmux); the B2 vitest and R1 cover the switch.

### Gates

`scripts/gates.sh` (diff-selected), all PASS at zero warnings: brand-check,
`git diff --check`, `npm run lint`, clippy (tabtivity + app-serverd, all
targets), clippy daemon lib build, `npm run build`, vitest `--changed`,
`cargo test -p tabtivity -p app-serverd`, daemon-build test
(`--no-default-features --lib --test server_secrets`). Counts: tabtivity lib
4337 tests (40 in `mobile_control::discovery`, 6 new, the box test changed);
vitest `MobileTabLocality.test.ts` 14 cases. `ci-local.sh` and the Windows/macOS
cross-checks were not run (A1 touches only `Path::join` paths and no
`cfg(...)` code).

### Flagged for user

- A remote project listed as `folder: false` still shows its Mobile switch and
  phone row but nothing else; opening the project on the desktop once makes the
  mirror. Fine with the plan, noting it is a one-time desktop step.
- Box tabs of a remote member are listed when their cwd is below the member's
  mirror, including shells the box runs locally; nothing narrows by type, per
  decision 1.

## A2. Host gates (plan step 2)

Commit: see `git log` (the commit whose message starts `feat(mobile): host gates
for folder-less`).

### What was built

`services/mobile_control/host.rs`:

- `has_folder(project)` now tests `ResolvedProject::has_folder()` (answers
  `404 not_a_project`), not the scope's kind: every outbox, inbox, upload,
  markup, desktop-image, uncommitted and transcript-worktree route that
  already called it refuses a folder-less scope with no further edit.
- New `is_git_project(project)` = `kind == Project && has_folder()`. It
  replaces every `kind == Project` / `!= Project` gate that means "a real
  project folder": the list's git dots (both probes), the detail's git dot,
  worktree rows and `files` flag, `project_git`, the tab-transcript worktree
  naming, `row_seal`, `markup_banner_files`, `files_scope` (files, search,
  raw, upload). A box and the root console keep their behaviour (folder,
  not a git project).
- New `creatable(project, &CreateTabKind)`: the scope's `create` verdict
  (`all` / `agents` / `none`) against the tab kind, else `409 not_attachable`.
  Called once in each tab-starting route before the window/owner split:
  `create_tab` (after the assistant-shape check), `sign_in_tab` and
  `reopen_tab` (both as an `Agent`). `answer_created` maps a desktop
  `not_attachable` to 409 too, so B1's bridge repeat arrives with the same
  status.
- The detail payload gains top-level `folder` and `create` (beside `files`);
  `PublicProject` gains `host` (a lowercase type word), so the list row and the
  detail's `project` both carry it. `fixture_scope` and the one `headless.rs`
  test literal gained `host`.
- `mobile-web/src/connection.ts`: `not_attachable` ->
  `mobile.failure.notAttachable`, added to `en`, `de`, `es`, `fr`, `it`.
- `docs/filemap_backend.md`: one clause on the `mobile_control/` row.

Tests (host.rs): `every_project_type_says_its_host_folder_and_create_verdict`
(host / folder / create / files per type, and no id, path or remote host in
any body), `a_folder_less_project_is_no_project_to_any_folder_route` (the VM
twin of S5a, plus a remote project with no mirror, plus a direct pin of
`has_folder` / `is_git_project` on a folder-less project, a box and root),
`a_create_the_phone_cannot_attach_to_is_refused_on_the_window_path` (a fake
desktop records what it is asked: only accepted creates and reopens reach it)
and `..._on_the_headless_path` (no spawn, no session file minted).

### Choices where the plan was silent

- The refusal is returned directly as `api_error(CONFLICT, "not_attachable")`;
  there is no `headless::CreateRefusal::NotAttachable` variant yet (the check
  runs before the headless split, so `create_headless` never sees it). A3 adds
  the variant for `launch_options` failures and maps it in
  `headless_create_error`, using the same code and status.
- A folder-less scope answers `not_a_project` on outbox/inbox/markup routes and
  `files_unavailable` on the files routes (the codes the assistant already got);
  no new code, since the phone reads `folder: false` and words the reason.
- `create` serializes as `all` (the plan's wording), not `any`.
- Reopen is gated by the `agent` verdict, so `none` projects (container, VM,
  mirror-less remote) refuse it; a remote project with a mirror still reopens
  (A3 must classify host-side closed tabs there).
- `host` rides on `PublicProject` (list + detail) rather than as a sibling in
  the payloads; `folder` and `create` are detail-only.
- Not changed: headless `activate` still gates on `kind != Project` (it marks
  the registry entry active and touches no folder), the `kind != Project`
  checks inside the markup source handlers (their callers already ran
  `has_folder`), and `no_schedules_here` (assistant only).

### Gotchas for A3 / B*

- With no window a remote project WITH a mirror now gets a headless git dot,
  worktree rows and a Git sheet read from the mirror (the window's probe skips
  remote projects, `mobileGitDots.ts`). Read-only hardened git on a local
  clone, but it disagrees with the window; if the plan's "no git dot on a
  remote project" is meant literally, narrow `is_git_project` with
  `host != Remote` (one place).
- The tab-shaped folder routes cannot be driven by id for a folder-less scope
  (it lists no tab); the test pins the shared gate instead.
- A3: `headless::create_tab` still builds `PtyOptions` from `project.root`;
  that is only safe because `creatable` runs first. A remote project with a
  mirror allows an agent through, and it is still launched with
  `local_only: false` until A3.
- B3: `create` values are `all`, `agents`, `none`; `host` values `local`,
  `remote`, `container`, `vm`.

### Gates

`scripts/gates.sh`: brand, whitespace, lint, clippy (tabtivity + app-serverd
all targets), daemon-lib clippy, daemon clippy, `npm run build` PASS at zero
warnings. `vitest --changed` fails exactly one test,
`CursorPacks.test.ts` "reads the cursor tokens instead of naming a keyword a
pack replaces" (`cursor: pointer;` in the stylesheet): unrelated, no CSS is in
this diff; 6267 others pass. Run by hand because the gate stopped there:
`cargo test -p tabtivity -p app-serverd` (tabtivity lib 4337 passed, 4 ignored;
4 new tests in `mobile_control::host`; 472 in `mobile_control`), daemon build
`--no-default-features --lib --test server_secrets` (4236 + 1) all pass.
`ci-local.sh` and cross-OS checks not run (no `cfg(...)` or path code; the new
tests use `Path::join` only).

### Flagged for user

- The unrelated `CursorPacks` failure above (a bare `cursor: pointer;` in
  the stylesheet) is on this branch's base; not touched.
- The headless git dot for a remote project with a mirror (see Gotchas).

## A3. Launch locality (plan step 3)

Commit: see `git log` (the commit whose message starts `fix(mobile): phone
launches run where the desktop would`).

### What was built

`services/mobile_control/discovery.rs`: the locality table is now one fn,
`runs_on_this_machine(host, shells_in_container, kind, location)`, which
`tab_on_this_machine` (catalog) and the new `launch_place(state_dir, raw_id,
kind, location) -> LaunchPlace` (launch) both call, so there is still one copy.
`LaunchPlace` is `AsRecorded` / `LocalMirror(path)` / `NotAttachable`. It reads
`<state_dir>/projects.json` (the catalog's lenient `ProjectRecord`): missing
file or unknown id (box, root, assistant) is `AsRecorded`; an unreadable file is
`NotAttachable` (nothing guessed); a VM project is always `NotAttachable`
(`launch_prep` refuses a local spawn there); a remote project's local tab is
`LocalMirror(mobile_root)`.

`headless.rs`: `launch_options(state_dir, project_id, tab) -> Result<PtyOptions,
NotAttachable>` (`NotAttachable` is a unit struct with a Display starting
`not_attachable`). `LocalMirror` sets `local_only: true` and `cwd` = the mirror
(so a desktop-made tab saved with `cwd = directory` is started in the mirror
too; `launch_prep` would swap it anyway). The kind is the record's `extra.kind`
(missing = shell), the location its `extra.location`. The assistant branch is
untouched (`Ok`). `CreateRefusal::NotAttachable` (code `not_attachable`).
New `launch_minted` replaces the three copies of "launch, else take the minted
record back out" (`create_chat`, `create_tab`, `reopen_tab`) and maps the
refusal. `start_chat` maps it. `apply_undo_plan`'s relaunch now builds the
options BEFORE `runner.kill`, so a refused relaunch leaves the running session
alone. `reopen_tab` asks the same question about the closed record before
`reopen_tab_in` moves it, so a host-side closed tab stays closed (for the
window) instead of being deleted by a failed launch. `create_tab` stamps
`location: "local"` on an agent of a `ProjectHost::Remote` scope (from
`project.public.host`).

`scheduler.rs`: the relaunch calls `launch_options(&ctx.state_dir, ..)`; a
refusal becomes `Event::Relaunched { error: Some("not_attachable: ..") }` and
nothing is spawned. This applies to every scope regardless of the Mobile switch
(a remote or container agent with a schedule was launched wrongly before).

`host.rs`: `headless_create_error` maps `NotAttachable` to 409.
`docs/filemap_backend.md`: the `discovery.rs` row.

Callers of `launch_options`: `create_chat`, `create_tab`, `reopen_tab`,
`start_chat`, `apply_undo_plan`, `scheduler::tick` (grep-confirmed; the route
`host.rs::launch_options` is a different fn). The first four go through
`launch_minted` or a direct map.

Tests: `a_remote_projects_local_tab_launches_local_only_in_the_mirror`,
`container_and_vm_tabs_are_refused_and_other_scopes_are_unchanged`,
`a_phone_made_agent_of_a_remote_project_launches_in_the_mirror`,
`a_create_in_a_container_project_is_refused_and_leaves_no_tab`,
`a_reopen_follows_the_same_locality_and_leaves_a_refused_record_closed`,
`an_undo_relaunch_of_a_host_side_tab_kills_nothing` (headless.rs) and
`a_dead_agent_is_restarted_where_the_window_would_run_it` (scheduler.rs). The
older in-file `launch_options` tests gained the `state_dir` argument.

### Choices where the plan was silent

- VM: every tab is refused, including a `local_agent` the catalog lists (A1's
  table says local, `vm_spawn_refusal` says no local spawn). Refusing early is
  clearer than a `launch_failed`. A1's catalog still lists that tab.
- A stored remote-project shell with `location: "local"` launches local (the
  window would). Only the phone's create gate (`creatable`) keeps the phone
  from making one.
- Unreadable `projects.json` refuses; a missing one does not.

### Gotchas for B1 / B2 / B3

- **The bridge's `create` must follow this contract** (desktop twin of
  `launch_place`): remote project + agent: run it local (`local_only`/location
  `local`), cwd = the mirror, and save the record with `location: "local"`
  (explicit); remote shell, container (agent, or shell while scope `all`), VM:
  answer `not_attachable` (409 via `answer_created`, already mapped). Host and
  `create` verdict come from the same table as `creatable` in `host.rs`
  (local `all`; remote with a mirror `agents`; else `none`). Remoteness from
  the project record, never a path.
- A phone-made remote agent's saved `cwd` is the mirror (not `directory`), by
  `tab_record(.., &project.root)`; the catalog reads both.
- `location` is the record's loose string key `location`, same spelling as the
  window's `SavedTab`.

### Gates

`scripts/gates.sh` (diff-selected): brand, whitespace, clippy (tabtivity +
app-serverd all targets), daemon-lib clippy, daemon clippy, `cargo test -p
tabtivity -p app-serverd`, daemon-build test (`--no-default-features --lib
--test server_secrets`) all PASS at zero warnings. No frontend change, so
lint/build/vitest were skipped by the selector (the known `CursorPacks`
failure is untouched). Counts: tabtivity lib 4344 passed (was 4337), 479 in
`mobile_control` (was 472, +7 new tests). `project_tree_intent` needed
`// project-tree-read: ok` on test lines reading `.tab_layout`. `ci-local.sh`
and the Windows/macOS cross-checks were not run (new tests build paths with
`Path::join`; no `cfg(...)` code).

### Flagged for user

- A closed host-side agent tab on a remote project now cannot be reopened from
  the phone (`not_attachable`, record kept); it is reopened from the desktop.
- Scheduler: a due prompt for a host/VM agent with no window is not
  delivered by the sidecar any more (it failed on the base too: no pool); the
  `Relaunched` event carries the error, once per backoff window. (A container
  agent IS restarted again, `restart_options`: see R1/R2.)

## B1. Desktop bridge (plan step 4)

Commit: see `git log` (the commit whose message starts `feat(mobile): desktop
bridge serves remote, container and VM projects`).

### What was built

New `src/lib/projectTabHost.ts` (the one helper; filemap row added):
`projectHostKind(project)` (VM before remote, then container, as
`discovery::project_host`), `tabRunsInContainer` (the expression `PaneSlot` had
inline for its `sandbox` flag, extracted; `PaneSlot` now calls it),
`phoneReachesTab(project, tab, scopeKey)` (the Rust `runs_on_this_machine`,
built on `effectiveTabLocation`), `phoneCreateVerdict` (`all` / `agents` /
`none`) and `phoneProjectFolder` (local, container: directory; remote:
`resolveLocalMirror` else `localTabCwd` -> `<directory>/mirror`; VM: the mirror
only, else `""`).

`MobileBridgeHost.tsx`:

- `mobileProject` is the Mobile switch alone (the remote/sandbox/VM refusals
  are gone). `mobileScope`'s `cwd` is `phoneProjectFolder`.
- `phoneTabs(scopeId)` filters the scope's tabs through `phoneReachesTab`; it
  replaced every `tabsByScope[...]` read (9 sites: agent-turn snapshot, status,
  timings, prompts, finished-turn lookup, schedule summaries, `like_tab`,
  `scheduleTargetTab`, `mobileTargetTab`). Those two lookups serve activate,
  rename, close, colour, reorder, schedules, prompts, agent status/transcript,
  tab_seen/input/prompt, hold/edit-held, undo_clear and markup, so a tab the
  phone cannot reach is `tab_not_found` for all of them (`tab_seen` and
  `tab_input` stay silent `seen` for a missing tab, as before).
- `create` answers `not_attachable` (before `enterScope` and before the `cwd`
  check, so a VM answers it rather than `project_ineligible`) when
  `phoneCreateVerdict` forbids the kind; a remote project's agent is created
  with `cwd` = the mirror and `location: "local"` stamped on the spec.
- `reopen_tab` follows the same verdict AND the closed tab's own locality: a
  closed host-side tab answers `not_attachable` and stays in the closed list;
  no id means the newest closed tab the phone could attach to. The catalog's
  `closed` rows list only reachable ones (`closedPhoneTabs`).

`PaneSlot.tsx`: only the `sandbox` extraction. The Mobile switch's tmux wrap
already requires `localRunning` (verified by test, no change).

Tests (new): `MobileTabReach.test.ts` (the helper; every fixture row against a
remote and a VM project; container, create verdict, folder; the `localRunning`
tripwire), `MobileEveryProjectType.test.tsx` (the bridge in a remote, container
and VM scope: switch alone opens them, catalog/activity list reachable tabs
only, 12 handlers x 6 unreachable tabs answer `tab_not_found`, remote create is
local in the mirror, mirror fallback, `not_attachable` for shell/container/VM,
reopen). `ContainerScope.test.ts` now calls the helper and pins that `PaneSlot`
calls it.

### Choices where the plan was silent

- `wrapAgentTabForPhone` was not given a separate container branch: a
  container-running tab is not reachable, so the lookup in front of it already
  answers `tab_not_found` (the catalog does not list it either). Adding a
  `session_gone` branch behind that would be dead code.
- A remote project's create is always `agents` in the window: whether the
  mirror exists on disk is not visible to the renderer (the sidecar's
  mirror-less `none` stays the sidecar's), and `launch_prep` creates the mirror
  at spawn.
- A VM `local_agent` stays reachable in the bridge (same as the catalog, A1's
  table); `create` for a VM is `none`, so none is started from the phone.
- `agentTurnScopes`/the push edges follow the same filter, so no notice is
  raised for a tab the phone cannot attach to.

### Gotchas for B2 / B3

- B2: `phoneProjectFolder` and `projectHostKind` are the places for "what does
  this project type share" texts if the titles need the host word; the
  sidecar's `host` values are the same four words. `ProjectFilesView` can reuse
  `phoneProjectFolder` instead of its own `resolveLocalMirror` copy.
- B3: `not_attachable` also arrives from the window path (409 via
  `answer_created`), same code as the sidecar's own refusal.
- Untouched by design: `untested.ts` row `mobile-every-project-type` is B2's.

### Gates

`scripts/gates.sh` (diff-selected): brand, whitespace, lint (zero new
warnings), clippy x3, `npm run build`, vitest `--changed`, `cargo test -p
tabtivity -p app-serverd`, daemon-build test all PASS. Full `npm test`: 895 of
896 files, 9015 of 9016 tests pass; the one failure is the known
`CursorPacks.test.ts` (develop's 8338634a). New: `MobileTabReach.test.ts` (21
tests), `MobileEveryProjectType.test.tsx` (9 tests); `ContainerScope.test.ts`
still 8. `ci-local.sh` not run (no Rust change).

### Flagged for user

- A remote project whose mirror has never been created is listed on the phone
  as folder-less with no ＋ (sidecar verdict), while the window itself would
  accept an agent create for it; nothing reaches the bridge in that case.
- A phone-reachable VM `local_agent` (A1's table) cannot be relaunched
  (A3: every VM tab is `NotAttachable`); it is listed while it runs.

## B2. Desktop UI + texts (plan steps 5 and 7)

Commit: see `git log` (the commit whose message starts `feat(mobile): phone
button and texts for every project type`).

### What was built

- `ProjectFilesView.tsx`: `mobileEligible` is now just "has a project" (every
  type); the phone button's title appends one sentence per non-local type
  (`mobile.hostReach.remote|container|vm`), and the picker gets `host`. The
  type comes from B1's `projectHostKind`.
- `MobileAccessPicker.tsx`: new optional `host` prop; a non-local project shows
  that sentence plus the `mobile-every-project-type` pill as a first
  `context-menu-note`. `HOST_REACH_KEY` (exported) maps type -> i18n key.
- `PairedDeviceAccess.tsx`: `isMobileEligible` and the `eligibleProjectIds`
  prop are deleted; every project is a scope. `PairedDeviceDialog.tsx` lost its
  project-store read. `MobileSettings.tsx` lists every project; non-local rows
  get the pill and the sentence as the switch's title; the picker gets `host`.
- i18n (en + de/es/fr/it, real translations): new `mobile.hostReach.*` (3), and
  reworded the five "local only" texts: `mobile.noEligibleProjects`,
  `mobile.boxAccessHelp`, `mobile.guideStep5`,
  `lessons.mobileLesson.projectAccessBody` (the key `noEligibleProjects` keeps
  its name; only the text changed). `docs/help/mobile.md` step 5 plus a
  "Remote, container and VM projects" section.
- `src/lib/untested.ts`: row `mobile-every-project-type`.
- Docs: `docs/context/mobile_access.md` layer 2 is now "Which folder a project
  type gives the phone" (folder per type, cwd alias, locality rule, create
  verdict, scheduler); two filemap_frontend rows; `todo/group-h-crossplatform.md`
  box **31ci** (🖐️ + four platform pairs, unticked).
- Tests: `MobilePairedDeviceAccess` (remote/VM/container are offered in Add
  project), `MobileProjectAccess` (+2: title and picker note per type, nothing
  extra for local).

### Choices where the plan was silent

- Kept the existing title text ("…eligible terminal sessions…") and appended the
  per-type sentence rather than adding per-type variants of all four titles.
- The pill sits in the picker head and Settings rows, not on the header icon.
- `ProjectFilesView` still uses its own `resolveLocalMirror` import for other
  things; it needed no `phoneProjectFolder` (the button does not use the folder).

### Gotchas for B3

- Nothing in `mobile-web` was touched. The phone-side wording for `host` should
  match `mobile.hostReach.*` in meaning (remote: local agents + mirror;
  container/VM: listed, tabs inside later).
- Phone lists the VM `local_agent` etc. per A1/B1 (see their sections).

### Gates

`scripts/gates.sh`: brand, whitespace, lint (no new warnings), build PASS;
vitest `--changed` (664 files, 6313 tests) only the known `CursorPacks`
failure. Full `npm test`: 895 of 896 files, 9017 of 9018 tests pass (was 9016:
+2 new); the one failure is `CursorPacks.test.ts`. No Rust change, so cargo
gates were skipped by the selector.

### Flagged for user

- The container/VM sentences say "in a later version" as the plan decided; a
  container project with scope `agents` does list its host-side shells today
  (sentence says "tabs running inside the container").

## B3. Phone (plan step 6)

Commit: see `git log` (the commit whose message starts `feat(mobile): phone
reads host, folder and create`).

### What was built

- `mobile-web/src/api.ts`: `ProjectHost`, `CreateVerdict`; `ProjectRow.host?`,
  `ProjectDetail.folder?` and `.create?` (absent = an older desktop = `true` /
  `all`).
- `screens/Project.tsx`: `createVerdict`, `folderless`, `creates`
  (`terminalsOffered && verdict != none`), `fabOffered`. `creates` replaces
  `terminalsOffered` for the ＋ label, the quick-agent tap, the NewTabSheet
  `creates` prop and the Mark up new-tab; `terminalsOffered` stays for the
  tmux-only things (◷, restart, schedule). Folder-less: `filesOffered` and
  `gitOffered` are false (so the drawer and the swipe vanish unless the outbox
  has files). `none` with a folder (container, VM mirror): the ＋ stays as the
  send-a-file sheet (the no-tmux pattern); `none` and folder-less: no ＋. One
  `notice` under the header: host note (remote / container / VM) plus, if
  folder-less, the reason by type (remote: no local copy yet; VM: files stay in
  the VM; otherwise generic). Recently closed rows are hidden for `none`. The
  empty-state hint follows what ＋ can do.
- `NewTabSheet.tsx`: `agentsOnly` prop (note replaces the Shell button, which
  the caller already leaves out: `shells && verdict == all`).
- i18n in en/de/es/fr/it (the phone shares `src/lib/i18n.ts`): 6 `mobile.project.host*`
  / `noFolder*` keys, `emptyHintAgents`, `emptyHintNone`, `mobile.newTab.agentsOnly`.
  `not_attachable` message already existed (A2) and is shown by the existing
  `describeFailure` on create and reopen (pinned by a test).
- Untested pill on the notice: the B2 register row `mobile-every-project-type`.
- Test: `src/__tests__/mobile/MobileProjectHostTypes.test.tsx` (6).
- `mobile-dist/` is gitignored; `npm run build` (inside `gates.sh`) runs
  `mobile:bundle`. Nothing bundle-related is committed.
- Filemap: no row names `Project.tsx` / `NewTabSheet.tsx`, none changed.

### Choices where the plan was silent

- `none` with a folder keeps ＋ as "Send a file" rather than hiding it (plan:
  "none -> hidden"): hiding would take away a working feature on container/VM
  projects with a folder.
- Phone wording matches `mobile.hostReach.*`; container/VM say "not on the
  phone yet".
- The Home list does not use `host` yet (only the project screen).

### Gates

`scripts/gates.sh`: brand, whitespace, lint, build (incl. mobile bundle) PASS;
vitest `--changed` (671 files, 6373 tests) only the known `CursorPacks`
failure. Full `npm test`: 896 of 897 files, 9023 of 9024 tests pass (was 9018:
+6); the one failure is `CursorPacks`. One earlier full run showed a second
failing test that did not recur in two reruns (not identified). No Rust change.

### Flagged for user

- Live check owed: box 31ci on a real remote/container/VM project and a phone.
- The flaky second failure above.

## R1. Finder review (2026-10-21)

Commits: `418f327b` (fix, container restart) and the commit after it (shared
project-host table, docs); this section's own commit last. Reviewed
`6490fd90..d314af66` file by file against AGENTS.md and the plan.

### Findings

1. **CONFIRMED, fixed in `418f327b`: A3 broke the scheduler's restart of a
   container project's agent** (`discovery.rs` `launch_place`, `headless.rs`
   `launch_options`, `scheduler.rs` tick). See "Evidence" below: on the base it
   was launched correctly, into the container. A3's table returned
   `NotAttachable` for it, so a scheduled prompt for a container agent with no
   window was no longer delivered (the claim "launched in the wrong place" was
   wrong for containers). Fix: `LaunchPlace::InContainer` (a container tab that
   runs in the container) and `headless::restart_options`, used by the
   scheduler only: it launches such a tab as recorded (as on the base). A
   phone's create, reopen, undo relaunch and chat start still use
   `launch_options` and refuse it. Tests: `scheduler::a_dead_agent_is_restarted_
   where_the_window_would_run_it` (container scope `all` and `agents`: launched,
   not `local_only`, cwd as recorded, no error) and the new `restart_options`
   block in `headless::container_and_vm_tabs_are_refused_and_other_scopes_
   are_unchanged` (container launched; VM and `host:w1` agent refused; a remote
   project's local agent `local_only`).
2. **CONFIRMED (test gap, fixed in the second commit): the "shared fixture"
   covered only the remote/VM tab rule.** The container table, the host
   precedence (vm > remote > container, a sandbox record on a remote or VM
   project) and the create verdict were hand-written on each side. New
   `src/__tests__/mobile/projectHostReach.fixture.json` (81 rows: 9 project
   shapes x agent/shell/local_agent x 3 locations -> host word, reach, create)
   is read by `discovery::the_project_host_table_matches_the_windows` and by
   `MobileTabReach.test.ts`. Both agree on every row today; no code drifted.
3. **Doubtful, flagged (R1 — Flagged for user, 1-3 below).**

### Evidence for item 2 (did the base start these agents correctly?)

Headless launch on the base: `launch_options` (`local_only: false`,
`sandbox: false`, `remote_host_id: None`, `project_id: Some(..)`) ->
`HeadlessSpawner.launch` = `launch_prep::prepare(opts, None, None)` then
`tmux_local::spawn_detached_with` (`host.rs:145-149`).

- **Container project (agent, or a shell while scope `all`): worked.**
  `prepare` -> `sandbox::enforce_spawn_authority` re-derives `sandbox` from
  `projects.json` (`resolve_spawn_authority`: toggle on, local project, not
  host-bound -> `sandbox: true, local_only: false`; scope `agents` leaves a
  shell on the host) -> cwd check passes (cwd = the project directory) ->
  `opts.sandbox && !opts.local_only` -> `sandbox::wrap_pty_options_docker`
  (needs no pool; creates the container on demand) -> `cmd` is now the engine,
  so `prepare` skips its own tmux wrap (`launch_prep.rs` ~1283,
  `is_engine_cmd`) -> `spawn_detached_with`/`detached_argv` sees an unwrapped
  command and wraps the `docker exec` client in a detached local tmux session
  (`tmux_local.rs:842-870`: "An unwrapped launch is wrapped here"). So the agent
  ran in the container, under a local tmux session the scheduler could deliver
  to. A3's refusal is a regression.
- **Remote project, any agent: failed on the base** (no spawn). `local_only:
  false` and `remote_target_for_host(project, PRIMARY)` is `Some` -> `prepare`
  reaches `let Some(pool) = pool else { return Err("terminal: tab .. needs a
  window's remote pool ..") }` (`launch_prep.rs:1119`) and returns before
  `ssh_exec::wrap_pty_options`. So the base never started a `host:<id>`/remote
  agent headless; A3's refusal is the same outcome with a clearer error. It also
  means the base failed for a remote project's LOCAL agent (location unset or
  `local`), which A3 now starts `local_only` in the mirror, as the window does
  (an improvement, not a regression).
- **VM project: failed on the base** the same way (VM down: the
  `TABTIVITY_VM_DOWN` sentinel; VM up: the missing pool). A3's refusal matches.

### Checked and found sound

- Every `launch_options` caller: `create_chat`, `create_tab`, `reopen_tab`,
  `start_chat`, `apply_undo_plan`, `scheduler::tick` (grep-confirmed; no other
  `spawner.launch` / `(ctx.launch)` use). The phone's create/reopen/sign-in are
  refused by `creatable` before the window/headless split and again inside
  `launch_options`; the bridge repeats the verdict. Remoteness is read from the
  record (`remote`, `vm`, `sandbox`), never from a path; the cwd alias decides
  how a tab's cwd is READ, not where it runs.
- Folder-less scopes (`host.rs`): every route taking `project.root` is behind
  `has_folder` / `is_git_project` (grep over all 20-odd sites, including the
  headless git dot, worktrees, files/search/raw/upload, outbox, inbox, markup,
  desktop-image, uncommitted). A folder-less scope lists no tab, so the
  tab-shaped routes cannot reach it. `host` is a type word; `folder`/`create`
  are a bool and a word; the body-leak test covers ids, paths and the host name.
- `activate` from the phone is `activateProject` (status flip + background
  restore of the saved layout), the same as startup's
  `restoreActiveProjectScopes`: remote panes stay held until the user's own pool
  is up, a VM tab shows the boot action; no phone route connects, boots or pulls.
- cwd alias: `ResolvedTab.cwd` is the canonical mirror, which is where the agent
  ran (`launch_prep` sets the cwd to `mirror_dir`); transcript, OpenCode and
  uncommitted lookups read it. `since` does not depend on the cwd.
- Round trip: `mirror` is lenient, `location` is a loose `Value`, `create_tab`
  only adds `location` to a remote agent's record (unknown keys preserved).
  New tests build paths with `Path::join`, no absolute literal.
- Rust vs TS locality: identical on all 81 fixture rows (item 2 above).

### R1 — Flagged for user

1. **`attachDesktopImage` (`MobileBridgeHost.tsx`, the `mobile_attach_desktop_image`
   call) passes `scope.cwd` unchecked**; for a VM project without a mirror
   `phoneProjectFolder` is `""`, and `inbox::store(Path::new(""), ..)` would write
   relative to the app's process cwd. Not reachable today: the sidecar resolves
   the tab first and a folder-less scope lists no tab. A one-line
   `if (!scope.cwd)` guard (`project_ineligible`) would make the bridge's repeated
   perimeter hold on its own; left to you because nothing reaches it.
2. **VM detection differs between the catalog and the spawn authority.** The
   catalog and the window use `vm.enabled` (top-level `vm` key); `launch_prep`
   refuses local spawns by `remote.vm == true` (`vm::is_vm_spec`). They are set
   together at VM creation, so no real record disagrees; a hand-edited one with
   only `remote.vm` would be listed by the catalog as a plain remote project (its
   local spawns are still refused by `launch_prep`).
3. **A remote project saved without a `directory` key** (legacy shape: folder
   derived from `local_file`) gets no cwd alias, so its window-made agent tabs
   (cwd = that folder) are not listed. Remote projects are not Python-era and
   carry a `directory`; `ProjectRecord` also never reads the `local_file`
   fallback for a local project (unchanged from the base).
4. **A1/A2 headless git dot for a remote project with a mirror** (already noted
   under A2) remains a deliberate difference from the window.
5. `launch_place` treats an unparseable `projects.json` as `NotAttachable` for
   EVERY scope, including a box or root restart that never looked at the file on
   the base. The catalog fails on the same file, and `launch_prep` fails closed on
   it too, so the practical difference is nil; noted because it is stricter than
   the base.
6. The container/`agents` shell is listed on the phone but a phone create there
   is refused (plan, phase 1); the bridge `phoneCreateVerdict` says `agents` for
   every remote project while the sidecar says `none` for a mirror-less one (B1
   already flagged).

### Gates

Run with `scripts/gates.sh --base 6490fd90` (the range; plain `gates.sh` sees an
empty diff once everything is committed). brand, whitespace, lint, clippy
(tabtivity + app-serverd all targets), daemon-lib clippy, daemon clippy and
`npm run build` PASS at zero warnings. `vitest --changed` (672 files, 6459
tests): 6458 pass, the one failure is the known `CursorPacks.test.ts` (develop's
8338634a); the gate stopped there, so the cargo tests were run by hand:
`cargo test -p tabtivity -p app-serverd` (tabtivity lib 4345 passed, 4 ignored;
479 in `mobile_control`, the same count as before: two tests extended, one
added in `discovery`), daemon build `--no-default-features --lib --test
server_secrets` (4244 + 1) all pass. New: `the_project_host_table_matches_the_
windows` (Rust, 81 rows) and 81 cases in `MobileTabReach.test.ts` (102 total).
`ci-local.sh` and the Windows/macOS cross-checks were not run (no `cfg(...)`
code; the new tests use `Path::join` only).

## R2. Verifier + final review (2026-10-21)

Fix commits: `a1b1134c` (bridge guard, legacy `directory`, root/box restart)
and the `fix(mobile): gate the unix-socket window test` commit after it; this
section's own commit last.

### Part 1: R1 verified independently (base 6490fd90 against HEAD)

- **(a) Container restart fix: CORRECT, confirmed.** `restart_options` is called
  only from `scheduler.rs` (grep: one caller); `launch_options` (create, reopen,
  undo relaunch, chat start) answers `InContainer` with `NotAttachable`, so no
  phone action starts a container process; a remote-host or VM tab is
  `NotAttachable` in both. The base really failed for remote and VM projects:
  `launch_prep.rs` ~1119 returns "needs a window's remote pool" when
  `remote_target_for_host` is `Some` and `pool` is `None` (the headless spawn
  passes `None`); a container agent went `wrap_pty_options_docker` (no pool),
  so the base delivered it and A3's refusal was a regression, now undone.
- **`attachDesktopImage` passing `scope.cwd` unchecked: CONFIRMED (latent), fixed
  in `a1b1134c`.** Also reachable for the assistant scope (`cwd: ""`) on the
  base. It now answers `project_ineligible` when the scope has no folder. Test:
  `MobileEveryProjectType.test.tsx` "copies a desktop image only into a folder
  the scope has" (VM without mirror: refused and no `invoke`; with a mirror:
  written into it). Every other `scope.cwd` use was grepped: `create` (877) and
  the worktree list (1053) already guard; the transcript `tab.cwd || scope.cwd`
  is a read-only lookup of a tab that has its own cwd.
- **VM detection (`vm.enabled` vs `remote.vm`): NOT a bug.** The `vm` spec in the
  entry (`extra["vm"]`, `enabled: true`) is written at creation and is what the
  window (`project.vm?.enabled`), `entry_is_vm`, `vm_spec_for` and `commands/
  projects.rs` read; `remote.vm = true` is set later, by `vm.rs` ~1476 when the
  VM boots and its forwarded endpoint is written. The catalog therefore
  classifies a VM project at least as early as `launch_prep` does; no real
  record has `remote.vm` without `vm.enabled` (VmSpec has "no in-place
  disable"). Adding `remote.vm` to the catalog would only make Rust disagree
  with the window and the shared fixture. No change.
- **Legacy remote project without `directory`: CONFIRMED real shape, fixed in
  `a1b1134c`.** `ProjectEntry::directory()` and `resolveProjectDirectory` fall
  back to the folder of `local_file` (`<dir>/project.json`); startup's
  `normalize_entry` backfills the key, but the sidecar reads the raw file (and
  the daemon never runs that migration). `ProjectRecord` now reads `local_file`
  leniently and `directory()` applies the same rule, for the mirror alias and
  for a local/container root. Test:
  `discovery::a_legacy_record_without_a_directory_key_still_names_its_folder`.
- **R1 flag 5 (unreadable `projects.json` stops EVERY scope's restart):
  CONFIRMED stricter than base, fixed in `a1b1134c`.** `launch_place` returns
  `AsRecorded` for the root console and `box:` scopes before reading the file.
  Test: the root/box lines added to
  `headless::container_and_vm_tabs_are_refused_and_other_scopes_are_unchanged`.
- **R1 flag 4 (headless git dot for a remote project with a mirror): flagged,
  below.** **Flag 6 (bridge `agents` vs sidecar `none` for a mirror-less
  remote): flagged, below.**

### Part 2: integration

- Payload names agree across `discovery.rs`/`host.rs` (`host` on the project row,
  `folder`, `create` on the detail) and `mobile-web/src/api.ts` (`ProjectHost`,
  `CreateVerdict`, `folder?`, `create?`); `not_attachable` is 409 in the sidecar
  (`creatable`, `headless_create_error`, `answer_created`), in the bridge
  (`MobileBridgeHost`, create and reopen) and in `connection.ts`'s table. The two
  shared fixtures are read by both sides (Rust `discovery` tests, `MobileTabReach`
  and `MobileTabLocality`). No TODO/FIXME in the range.
- i18n: all 17 changed/new keys are in `en`, `de`, `es`, `fr`, `it` (same set in
  each dictionary); the new desktop and phone strings go through `t()`. The
  `UntestedTag` row `mobile-every-project-type` exists, with pills in the picker
  head and the Settings rows, and the phone's notice. Filemap rows
  (`mobile_control/`, `discovery.rs`, `MobileSettings`, picker, paired-device
  rows, `lib/projectTabHost.ts`) are updated. Box 31ci has the four platform
  child pairs. `docs/context/mobile_access.md` matches the code (layer 2,
  scheduler placement).
- `scripts/brand-check.sh` and `scripts/privacy-check.sh 6490fd90..HEAD` pass
  (3777 added lines, 40 paths, 11 commits).
- **Found by `ci-local.sh`: a Windows compile error in A2's new host test** (it
  binds `tokio::net::UnixListener`); gated `#[cfg(unix)]` like its siblings.
- The A3 "Flagged" line about the scheduler is corrected (a container agent is
  restarted again).

### R2 — Flagged for user

1. **Headless git dot for a remote project with a mirror** (A2): the sidecar
   reads the mirror (hardened, read-only) when no window is open; the window's
   probe skips remote projects, and `docs/help/mobile.md` says the phone shows
   no git dot for one. Narrowing it is not one place (`is_git_project` also
   gates files/search/upload for the mirror). Pick: keep the dot (it describes
   the local mirror, not the host repo) or fix the help text.
2. **Bridge `phoneCreateVerdict` is `agents` for every remote project** while
   the sidecar says `none` for one with no mirror yet; harmless (nothing reaches
   the bridge then) but the two differ.
3. Live check owed (box 31ci). `npm run mobile:bundle` was reported stale by the
   commit hook (the PWA bundle is not rebuilt from B3's `mobile-web` changes in
   this worktree); rebuild before shipping.

### Gates

`scripts/gates.sh --base 6490fd90`: brand, whitespace, lint, clippy (tabtivity +
app-serverd all targets), daemon-lib clippy, daemon clippy, `npm run build` PASS
at zero warnings (a clippy `cloned_ref_to_slice_refs` in my own new test was
fixed first). vitest: 6459 of 6460 pass, the one failure the known
`CursorPacks.test.ts` (develop's 8338634a). Cargo tests by hand: `cargo test -p
tabtivity -p app-serverd` (tabtivity lib 4346 passed, 4 ignored; 481 in
`mobile_control`, +2 new), daemon build `--no-default-features --lib --test
server_secrets` (4245 + 1) all pass.

`scripts/ci-local.sh --fast`: brand, toolchain, drift, privacy, npm-deps, all
lints, build-frontend, test-backend, test-daemon-lib, daemon-ldd (no GTK/WebKit/
X11/dbus), windows-clippy, windows-check and macos-check (`aarch64-apple-darwin`)
all ok after the Windows fix; test-frontend failed only on `CursorPacks`;
test-core and test-gateway SKIPPED ("nothing it tests changed"); gitleaks
SKIPPED (not installed). No missing target or msvc shim was reported.
