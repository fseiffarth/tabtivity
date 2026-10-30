# Phone access for every project type

*Status: plan, 2026-10-21, reviewed the same day (see "Plan review"). Phase 1
landed on develop 2026-10-21 (handoff final review `11c2f9b9`), never run live;
handoff: `docs/mobile_every_project_type_handoff.md`. Phase 2's remote-host
part landed through `docs/mobile_remote_host_tabs_plan.md`; its container and
VM tabs are still open.*

## Why

The phone reaches only plain local projects. A remote, container or VM
project shows no phone icon in its Files header, and the Mobile switch
refuses it ("Mobile access is available only for local projects" /
"…unavailable for container and VM projects"). The rule is the "trust tiers"
of `docs/context/mobile_access.md`, enforced in these places (found by grep,
not four but six, plus the texts that describe them):

- `discovery::mobile_local` (called for a project **and** for a box member);
- `commands::projects::set_project_mobile_access` (the check appears twice:
  before and inside `patch_project_entry`);
- `MobileBridgeHost.tsx` `mobileProject`;
- `ProjectFilesView.tsx` `mobileEligible`;
- `PairedDeviceAccess.tsx` `isMobileEligible` (Settings → Mobile project list
  and the paired-phone dialog);
- texts: `mobile.noEligibleProjects`, `mobile.boxAccessHelp`,
  `mobile.guideStep5`, `lessons.mobileLesson.projectAccessBody`,
  `docs/help/mobile.md`, `docs/context/mobile_access.md`.

The user (2026-10-21): the project already has a Mobile on/off switch, so
the user decides. No project type is special.

## Fixed decisions (user, 2026-10-21)

1. **The trust tiers go.** Every project type gets the phone icon and the
   Mobile switch. The switch (and its per-phone list) is the whole consent;
   nothing else narrows it by project type. The same holds for a box's
   members: any member contributes its folder.
2. **No per-type limits on what the phone may do.** The existing machine-wide
   settings still apply everywhere (`shell_tabs` for phone shells, root's own
   gate, the AI switch). There is no "local agents only" or "agents only"
   rule.
3. **Two phases.** Phase 1 is the policy plus everything the phone can
   already attach to. Phase 2 makes the tabs that have no local tmux session
   (remote host, container, VM) reachable.

## What the phone can reach, and why phases

The phone attaches to a tab through a tmux session **on this machine** (the
sidecar's `tmux ls` / `pty_bridge`). `launch_prep::prepare` calls
`tmux_local::wrap_pty_options_local` last, and only when the command is
neither `ssh` nor a container engine (`sandbox::is_engine_cmd`), so an
`ssh`- or `docker`-wrapped spawn never has one:

| Where the tab runs | Local tmux session? | Phase |
|---|---|---|
| Local project | yes | already works |
| Remote project, tab local (agents' default: in the mirror) | yes | 1 |
| Remote project, tab on the host or a worker | no, its tmux runs remotely | 2 |
| Container project, tab in the container (`docker exec`: every agent; a shell only while the spec's scope is `all`) | no | 2 |
| Container project, shell with scope `agents` (runs on the host) | yes | 1 (works as local) |
| VM project (pinned to the VM, over SSH; `vm_spawn_refusal` refuses any local spawn) | no | 2 |

## Phase 1: the policy

### Decisions made while planning (mine; change if wrong)

- **Each project's phone folder** (the scope root that files, Upload here,
  inbox/outbox, markup and the git dot use):
  - local and container: the entry's `directory` (a container mounts the
    host folder at the same path, so the bytes are the same);
  - remote (not VM): the local mirror: the entry's `extra["mirror"]` if set,
    else `remote_sync::default_mirror_dir_in(state_dir, id)`. NOT `directory`,
    which holds only `project.json` and `sync.json`. The sidecar computes it
    from its own `state_dir` argument and the `ProjectRecord`, never through
    `remote_sync::mirror_dir` (which reads `storage::projects_path()`, a
    global the sidecar's tests and `Catalog::load(state_dir)` do not use).
    `default_mirror_dir_in` already exists and is public; no new twin is
    written;
  - VM: the `extra["mirror"]` folder only if the user opted into one (VM
    projects have no mirror by default, `docs/context/vm_projects.md`); else
    none on the host (the overlay is the working tree). A VM without a mirror
    is listed with no folder.
- **A folder-less project is listed, not dropped, and is not a folder
  project.** Today `resolve_scope` returns `None` when the first root does
  not resolve (the assistant alone is exempt, keyed on `ScopeKind::Assistant`).
  A project that is missing its mirror (remote not yet opened on the desktop)
  or has none (VM) must be listed with no tabs so the switch is visible on
  the phone. `has_folder()` in `host.rs` and every `== ScopeKind::Project`
  folder gate test the scope's *kind*, so a folder-less `Project` would walk
  straight into them with a root that does not exist. `ResolvedProject`
  therefore gains `folder: bool` (the first root resolved), and one helper
  (`ResolvedProject::has_folder()`) replaces both the `has_folder` kind test
  and the `kind == Project` folder gates (git dot, worktrees, `files`
  flag, files/search/raw, upload, activation-adjacent routes: the sites are
  listed by `rg 'ScopeKind::Project|has_folder' host.rs`, about 20).
- **A remote project's tab `cwd` is not the mirror.** The window stores a
  tab's `cwd` as `resolveProjectDirectory(project)` (the state dir
  `remote-projects/<id>` for a remote project) and swaps in the mirror only
  at spawn (`PaneSlot`: `localTabCwd`). So a desktop-made local agent of a
  remote project is saved with `cwd = directory`, which is outside the mirror
  root: `resolve_scope`'s `canonical_below_any(tab.cwd, roots)` would drop
  every such tab, and `ResolvedTab.cwd` (read by the transcript, OpenCode
  folder lookup and the worktree spots) would name a folder the agent never
  ran in. Fix in `resolve_scope`: for a remote project a tab whose saved
  `cwd` equals the entry's `directory` is read with `cwd = mirror` (an alias
  on `ScopeSource`; any other cwd must lie below the mirror as today).
- **A tab's locality is read from the record, the way the window does.**
  `SavedTab` gains `location` (`"local"`, `"remote"`, `"host:<id>"`, absent).
  The rule is `effectiveTabLocation`/`defaultLocationForKind` in
  `src/stores/tabs.ts`, mirrored in one Rust fn: `local_agent` is local;
  otherwise `location` if set; else an agent is local and a shell is remote;
  a VM project is pinned remote. A stored record often has no `location`
  (`toSavedTabEntry` writes `t.location`, which is undefined until the user
  or the Run-host picker sets it), so the default matters and is safe for the
  backend to apply: it is the same table the window applies, with the same
  inputs (kind, location, VM). On a remote or VM project `resolve_scope`
  lists only tabs that are local by that rule. On a container project it
  drops the tabs that run in the container (every agent; a shell while the
  spec's `scope` is `all`; `scope` read from the record's `sandbox` value).
  A TS fixture and a Rust fixture hold the same table so the two cannot
  drift.
- **A phone-started tab runs where the desktop would run it.** This is a bug
  fix, not a limit. `headless::launch_options` builds every phone spawn with
  `local_only: false` and `project_id: Some(..)`, so on a remote project
  `ssh_exec::wrap_pty_options` would send a phone-made agent to the remote
  host, while the desktop puts the same agent in the mirror. The spawn
  re-derives `sandbox` from `projects.json` (`sandbox::enforce_spawn_authority`
  forces it off for a remote project, on for a container project) but leaves
  `local_only` to the caller for a remote project, so the caller must set it.
  - A phone-made agent on a remote project: `local_only: true`, cwd = the
    mirror (the scope's `root`, which `launch_prep` re-resolves and creates),
    and `location: "local"` stamped on the record (explicit, so a later
    default change cannot move it).
  - Remote shell, container create, VM create: not attachable in phase 1.
    They are refused (`not_attachable`) and the phone is told not to offer
    them, see below. A remote project's "＋ Shell" waits for phase 2.
  - Reopen, undo-relaunch and the scheduler's relaunch go through the same
    classification, so a closed host-side tab is not relaunched headless as a
    process nobody can attach to.
- **Where the refusal sits.** In the sidecar's create handler (`host.rs`
  `create`), once, before it branches to the window or to `create_headless`;
  the desktop bridge's `create` repeats it (the bridge is reachable without
  the sidecar's checks, the existing "perimeter repeated" rule). The detail
  payload carries `create: "all" | "agents" | "none"` and `folder: bool` so
  the phone never hardcodes project types: local `all`; remote with a mirror
  `agents`; remote without one, VM, container `none`. The list row carries
  `host: "local" | "remote" | "container" | "vm"` (a type word, no path or
  id) for the one-line explanation.
- **The per-phone list and keys are unchanged** (`tabtivity_mobile_access`,
  `tabtivity_mobile_devices` on the `projects.json` entry).
- **No extra warnings.** The switch's title says what it opens for the
  project's type ("Phone: this project, including its remote host" etc.)
  because that is information, not a gate.
- **Activation from the phone is the switcher's.** `enterScope` calls
  `activateProject`, which connects a remote project only if the user opted
  into auto-connect (silent, `autoConnectRemote`; it never prompts). Nothing
  new is added; R1 checks that no phone route connects, boots or pulls.

### Steps

1. **Backend scope** (`services/mobile_control/discovery.rs`, plus the small
   `commands/projects.rs` change).
   - Delete `mobile_local`; `scope_sources` lists every opted-in project.
     `ProjectRecord` gains lenient `mirror: Option<String>` (a flattened
     top-level key in `projects.json`; a malformed value must not fail the
     file, like the device list). `mobile_root(state_dir, &ProjectRecord) ->
     Option<PathBuf>` returns the folder above, using
     `remote_sync::default_mirror_dir_in`.
   - `ScopeSource` gains the cwd alias and the project's host kind
     (local/remote/container/vm, from `remote`, `vm.enabled`,
     `sandbox.enabled`); `ResolvedProject` gains `host`, `folder` and the
     `create` verdict above. `SavedTab` gains `location`.
   - Box members: every member's `mobile_root` is a root (a VM member without
     a mirror contributes none, as a missing member root does today).
   - `resolve_scope`: a missing first root lists the scope with no tabs and
     `folder: false`; the locality filter and cwd alias above.
   - `set_project_mobile_access`: remove both type checks (before and inside
     `patch_project_entry`); keep `mobile_access_prerequisites`.
   - Tests: update the box-member trust-tier test (around
     `discovery.rs:2338`); remote, container and VM records are listed; a
     remote root is the mirror (default and `extra["mirror"]` override, built
     with `Path::join`, cross-OS); a VM scope has no folder unless a mirror
     is set; a remote project without a mirror is listed empty; a tab saved
     with `cwd = directory` is listed with `cwd = mirror`; a remote shell
     with no `location` and a `location: "host:w1"` agent are not listed; a
     container agent tab is not listed, its `scope: "agents"` shell is.
2. **Folder-less and create gates in the host** (`host.rs`, `protocol.rs`).
   - `ResolvedProject::has_folder()` replaces the kind test in `has_folder`
     and the `== ScopeKind::Project` folder gates (see above); the detail and
     list payloads gain `folder`, `create`, `host`.
   - `create` refuses `not_attachable` (new `CreateRefusal::NotAttachable`,
     409; one `mobile.failure.*` key in `mobile-web/src/connection.ts`'s
     table) per the verdict before the window/headless split.
   - Tests: extend the S5a route test
     (`the_assistant_scope_is_no_project_to_any_folder_route`) with a
     folder-less VM project twin that must refuse the same routes; a create
     in a container, VM or mirror-less remote project, and a remote shell,
     answer `not_attachable` on both the window and the headless path; and a
     body-leak check that `host`, `folder`, `create` carry no path or id.
3. **Phone spawns follow the desktop's locality** (`headless.rs`,
   `scheduler.rs`).
   - `launch_options(state_dir, project_id, tab) -> Result<PtyOptions,
     String>`: classifies the scope from `projects.json` read through
     `state_dir` (the same lenient record as step 1, so it agrees with the
     catalog and is testable), by the rule in "A tab's locality". Remote
     project + local tab: `local_only: true`. Remote project + host tab,
     container tab, VM tab: `Err` (a new `CreateRefusal::NotAttachable` for
     create/reopen; an `Event::Relaunched { error }` for the scheduler, which
     today relaunches a bound agent of *any* scope with no catalog, so a
     remote or container agent with a schedule is already launched wrongly
     today when no window is open: this fixes that regardless of the switch).
     Every other scope: unchanged. The assistant branch is untouched.
   - Every caller passes `state_dir` and handles the `Err`: `create_chat` (no
     change in behaviour), `create_tab`, `reopen_tab`, `start_chat`,
     `apply_undo_plan`'s relaunch and the scheduler's relaunch. (The route
     handler `host.rs::launch_options` is a different function: the phone's
     launch list.)
   - `create_tab` stamps `location: "local"` on a remote project's agent
     record; `tab_record`'s cwd is already `project.root`, which is now the
     mirror.
   - The in-file tests call `launch_options("p1", ..)` about ten times: they
     gain the `state_dir` argument and `.unwrap()`.
   - Tests: a remote project's phone-made agent launches `local_only` with
     cwd = the mirror; a location-less stored agent of a remote project
     resolves local and a location-less shell, a `remote` and a `host:w1`
     agent do not; a container agent and any VM tab are refused; a local
     project's options are byte-identical to today's.
4. **Desktop bridge** (`src/components/mobile/MobileBridgeHost.tsx`,
   `PaneSlot.tsx`, one new tiny helper).
   - `mobileProject` drops the remote/sandbox/VM refusals. `mobileScope`'s
     `cwd` is the same folder as step 1 (`resolveLocalMirror(project)`, else
     `${directory}/mirror` for a non-VM remote project, as
     `ProjectFilesView` already does; empty for a mirror-less VM, so the
     folder-shaped handlers answer `project_ineligible`, as for the
     assistant). `create` repeats the `not_attachable` verdict and follows
     step 3's locality.
   - `wrapAgentTabForPhone` already honours `effectiveTabLocation`; it must
     also answer `session_gone` for a tab that runs in the container. Extract
     the container test that `PaneSlot` has inline (`sandbox` flag) into a
     helper both use, so there is one copy.
   - `PaneSlot.tsx`'s Mobile-switch tmux wrap already requires a local
     location (`localRunning = !paneRemoteProj || location === "local"`), so
     the switch starts no tmux session on a remote host or HPC login node
     (verify with a test; no change expected there).
5. **Desktop UI and texts** (`ProjectFilesView.tsx` `mobileEligible`,
   `PairedDeviceAccess.tsx` `isMobileEligible`, `MobileAccessPicker`,
   Settings → Mobile list, `PairedDeviceDialog`, i18n).
   - Show the button and list rows for every project type; delete
     `isMobileEligible` rather than making it always true. The title names
     what is shared per type. New keys in all five dictionaries
     (`en`, `de`, `es`, `fr`, `it`); reword the texts listed under "Why".
     `UntestedTag` + a `src/lib/untested.ts` row `mobile-every-project-type`.
   - Tests that assert the old filter (`MobileProjectAccess`,
     `MobilePairedDeviceAccess`) change to the new rule.
6. **Phone** (`mobile-web/src`, `api.ts` types, `Project.tsx`,
   `NewTabSheet.tsx`). The row/detail carry `host`, `folder`, `create`. ＋
   offers what `create` allows (agents only for `agents`, nothing for
   `none`); a project with `folder: false` says why in one line; a listed tab
   that is not available keeps today's behaviour. `npm run mobile:bundle`.
7. **Docs.** `docs/context/mobile_access.md`: layer 2 "Trust tiers" becomes
   "Which folder a project type gives the phone" (with the cwd alias and the
   locality rule); update the file-map rows (`discovery.rs`, `headless.rs`,
   `host.rs`, `ProjectFilesView.tsx`, `PairedDeviceAccess.tsx`),
   `docs/help/mobile.md`, and a `todo/` QA box with the four platform
   children (grep `todo/` for the Mobile group; never read it whole).

### Known limits of phase 1 (stated, not fixed)

- A remote project's phone files are the mirror: tracked files as of the
  last lockstep, byte-synced paths only where opted in. A file uploaded from
  the phone lands untracked in the mirror and reaches the host only through
  an opted-in byte-sync path or after it is committed (lockstep owns tracked
  files; AGENTS "Remote & sync"); it does not "arrive through normal sync".
- On a remote project the phone has no git dot (the window's probe skips
  remote projects, `mobileGitDots.ts`), no "uncommitted changes" card
  (`chat_uncommitted::for_tab` answers `unavailable("remote")`) and no
  markup Undo (`NoUndo::Remote`); the phone already renders each of these.
- Tabs on a remote host, in a container (agents) or in a VM are not on the
  phone until phase 2. Their project is listed and its local tabs are
  reachable.
- A container project whose spec scope is `agents` has its shells on the
  host, so those are reachable; its agents are not.

## Phase 2: reach tabs with no local session (outline, planned after phase 1)

Wrap the tab's **client** process (`ssh …`, `docker exec …`) in a local tmux
session when its project's Mobile switch is on, so the sidecar attaches to it
like any local tab. Open questions for that plan:

- **Container:** local tmux around `docker exec -it`. Closing must still
  reach the agent inside (`sandbox.rs` notes that killing the exec client
  leaves it running). Phone creates then work too.
- **VM:** the same around the VM's SSH client. The VM's files need their own
  route (none on the host).
- **Remote host:** the remote side already runs tmux, so this is tmux inside
  tmux. Prefix keys, status lines and resize must stay invisible to the
  desktop terminal. The alternative is a sidecar-side attach over the pooled
  connection, which would need the desktop's SSH credentials (keychain,
  askpass) in the sidecar.
- HPC hosts: whether a background local session holding an SSH client open
  is acceptable under `hpc_hosts`.

## Organisation (phase 1)

Shape: **coupled chain + security review**. B reads A's scope/locality
behaviour, and the work sits in `mobile_control` and remote spawning, so the
Rust steps run in sequence (they share files and the same worktree) and two
independent reviewers follow. The frontend steps touch disjoint files from
the Rust ones and may run beside them once step 1's payload names (`host`,
`folder`, `create`) are fixed, which this plan does. Model: Sonnet (user,
2026-10-21). Worktree `.claude/worktrees/mobile-every-type`, branch
`mobile-every-type`; handoff `docs/mobile_every_project_type_handoff.md`.
Each agent step: one subsystem, at most about 1.5 days, at most about three
large files.

| Agent step | Plan steps | Main files | After |
|---|---|---|---|
| 0. Plan review | whole plan | this file | done |
| A1. Catalog | 1 | `mobile_control/discovery.rs`, `commands/projects.rs` | 0 |
| A2. Host gates | 2 | `mobile_control/host.rs`, `protocol.rs`, `mobile-web/src/connection.ts` (one key) | A1 |
| A3. Launch locality | 3 | `mobile_control/headless.rs`, `scheduler.rs`, a one-line variant mapping in `host.rs` | A2 |
| B1. Desktop bridge | 4 | `MobileBridgeHost.tsx`, `PaneSlot.tsx`, a helper in `src/lib/` | 0 (contract fixed above) |
| B2. Desktop UI + texts | 5, 7 | `ProjectFilesView.tsx`, `PairedDeviceAccess.tsx`, `MobileSettings.tsx`, `PairedDeviceDialog.tsx`, `i18n.ts` + 4 dicts, `untested.ts`, docs | 0 |
| B3. Phone | 6 | `mobile-web/src/api.ts`, `screens/Project.tsx`, `screens/NewTabSheet.tsx`, bundle | A2 (field names) |
| R1. Finder | all diffs | every `launch_options` caller (list in step 3), every `ScopeKind::Project`/`.root` site in `host.rs`, every bridge handler using a scope `cwd`, the box path, round-trip | A1-B3 |
| R2. Verifier + final | diffs + R1 | confirms R1's findings independently; integration, i18n, untested row, filemaps, brand/privacy, cross-OS paths | R1 |

B2 and B1 may run beside A1/A2; A2, A3 share `host.rs` and so are never
concurrent. At most five subagents at once.

## Verification

- Gates: `scripts/gates.sh` (build, tests, both clippies, daemon build); the
  change touches `mobile_control`, which the daemon builds: run the daemon
  gates too. `npm run mobile:bundle`.
- Live (manual, the user):
  1. A remote project: the phone icon shows; turn it on. The phone lists the
     project and its local agents, including one the desktop started earlier.
  2. Start an agent from the phone's ＋. On the desktop it runs locally in
     the mirror (tab badge local), and no new process appears on the host.
     No "＋ Shell" is offered.
  3. A container project and a VM project: the switch turns on and the phone
     lists both projects, with no ＋ yet; a container project with scope
     `agents` lists its shells.
  4. A remote project with no mirror yet and a VM project with none: listed
     on the phone with the one-line reason, and no Files/Upload offered.

## Plan review (2026-10-21)

Checked against the code; changes made above, briefly:

- **More enforcement sites than listed:** `PairedDeviceAccess.isMobileEligible`
  (separate from `mobileEligible`), the box-member use of `mobile_local`, the
  duplicated check in `set_project_mobile_access`, and five user-visible
  texts. Added to "Why" and the steps.
- **`launch_options` is the right seam but not the only fault.** All callers
  are `create_chat`, `create_tab`, `reopen_tab`, `start_chat`,
  `apply_undo_plan`, `scheduler::tick`; the scheduler's relaunch is not
  limited to Mobile-enabled scopes, so it misplaces remote/container agents
  today. Needs `state_dir`, so it is made fallible, not just parameterised.
  `local_only` is the only flag the caller must set (`sandbox` is
  re-derived by `enforce_spawn_authority`).
- **A catalog blocker the plan missed:** a remote project's saved tab `cwd`
  is the state dir, not the mirror. With the mirror as the only root the
  catalog would drop every desktop-made agent and read transcripts from the
  wrong folder. Fixed with the cwd alias (step 1).
- **`SavedTab` had no `location`.** The default (`effectiveTabLocation`) is
  applied in Rust with the same table, test-pinned against a TS fixture.
- **Folder-less scopes** need a real `folder` flag: the assistant branch is
  keyed on `ScopeKind`, not on a missing root, and about 20 `host.rs` sites
  would otherwise run git/files on a path that does not exist.
- **Mirror path:** `remote_sync::default_mirror_dir_in(state_dir, id)`
  already exists; no `mirror_dir_in` twin. VM mirror is opt-in only.
- **Container:** a scope-`agents` spec leaves shells on the host, so the
  "container: nothing reachable" line was wrong; a phone create there is
  still refused in phase 1 (simple, stated).
- **Wrong claims fixed:** no `needs_desktop_session` code exists (new
  `not_attachable`, since `desktop_unavailable` means "no window");
  `PaneSlot` already gates on locality (step 5 became a verify); uploads do
  not reach the host "through normal sync".
- **AGENTS.md:** remoteness is read from the record (`remote`, `vm`,
  `sandbox`), never from a path; no raw id/path to the browser (new fields are
  a type word and two flags); no new Tauri command (so no `command_class`
  row); i18n in five dictionaries; `UntestedTag` row; `hpc_hosts`: the phone
  agent contacts no host, and activation is the switcher's.
- **Agent steps:** the old A (four Rust files, ~800 KB incl. `host.rs`) and B
  (six subsystems) were too large; split into A1-A3 and B1-B3.

No question needs the user: nothing here changes a fixed decision.
