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
- Scheduler: a due prompt for a host/container/VM agent with no window is not
  delivered by the sidecar any more (it was launched in the wrong place before);
  the `Relaunched` event carries the error, once per backoff window.

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
