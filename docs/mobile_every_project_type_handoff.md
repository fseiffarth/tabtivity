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
