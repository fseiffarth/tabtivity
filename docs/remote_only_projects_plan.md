# Remote-only projects — Plan

Status: **plan only** (2026-10-28). Nothing is built. The plan was drafted in
two halves, engine (backend + data model) and cockpit (frontend, creation,
phone, docs), and then merged. Code sites were checked against `develop` at
76ea8097. Reviewed against the code on 2026-10-28; what the review changed is
listed in the last section, "Plan review (2026-10-28)".

## Goal

The user: *"Add remote only projects, additionally to local/remote, where
everything runs on the remote machine and Tabtivity only serves as navigating
cockpit."*

Today there are two project kinds:

- **Local.**
- **Remote (SSH).** Two trees, the host's and a **local mirror**, held
  together by git lockstep (`services::git_peer`), opt-in byte-sync
  (`commands::sync`, `services::sync_auto`), worker fan-out from the mirror
  (`services::worker_sync`) and local-loss records (`services::local_loss`).
  Agents start in the mirror by default.

This plan adds **Remote-only**, which has no local tree at all:

- The file tree and the viewers read over SFTP.
- Every shell, agent, run and build tab runs on the host.
- Git runs on the host.
- Nothing is synced.

Tabtivity keeps only cockpit state: the `projects.json` entry,
`<state_dir>/remote-projects/<id>/project.json`, `<state_dir>/sessions/<id>/`
(the layout and the `remote_transcript` copies), time tracking and notes. Its
job is navigation, tabs, viewers, the agent Reader/Chat and notes.

## Prior art: the VM tier is already remote-only, by accident of code

A VM project (`docs/vm_projects_plan.md`, `docs/context/vm_projects.md`) **is**
a remote project with this posture, but the posture has no name in the code.
It is spread over five implicit signals:

| Where | What makes a VM mirrorless today |
|---|---|
| `commands::projects::create_claimed_project` | `mirror = if is_vm { None }`, lockstep not armed, no local scaffold |
| `services::launch_prep::vm_spawn_refusal` | a `local_only` spawn is refused; VM down → `{UPPER}_VM_DOWN` |
| `services::mobile_control::discovery::{mobile_root, launch_place}` | `ProjectHost::Vm` → no folder, no local launch |
| `commands::vm::has_mirror` | "has a mirror" = the default mirror dir is *non-empty* |
| frontend `effectiveTabLocation({ vmProject })` | locality pinned to the host |

And it leaks: `services::remote::connect_host` runs
`create_dir_all(remote_sync::mirror_dir(id))` for **every** primary connect,
so each VM project gets an empty `<state_dir>/remote-projects/<id>/mirror` on
every boot, and every `mirror_dir()` caller (≈70 sites) falls back to that
default path for a project with no `extra["mirror"]` — which a VM project
never has. The VM's "Phase 5 opt-in mirror" (`todo/group-g-remote.md` G.26) is
still unbuilt.

**Decision: generalize, don't add a parallel path.** "Remote-only" becomes the
named posture; a VM project is *remote-only + VM boot*. The VM keeps everything
only it has (boot, egress, per-VM identity, `TABTIVITY_VM_DOWN`, mail reader);
the mirror/lockstep/locality rules move to the shared posture. The VM's
pending opt-in mirror will later *reuse* the generic Remote-only → Remote
conversion (E8), but it is **not** part of this plan: `docs/vm_projects_plan.md`
requires that mirror to be manual-pull-only (nothing VM→mirror lands without a
click), and E8's reverse pairs through ordinary lockstep, which would land
agent-written VM bytes on this machine. So in v1 both conversions refuse a VM
project, and a VM's `remote_only` is never written (it stays absent = on).

## Fixed design rules

### Engine

1. **The kind lives in the remote spec**: `RemoteSpec.remote_only:
   Option<bool>` in `schema/project.rs`, beside `vm`. Effective value:
   `remote_only.unwrap_or(vm == Some(true))` — `RemoteSpec::is_remote_only()`.
   Every consumer already holds `target.spec` from `remote_target_for{,_dir,
   _for_host}`, so there is no new lookup. Trusted copy: `projects.json`
   `extra["remote"]` (what `remote_target_for` reads); `project.json` is the
   display copy written alongside by `patch_project_entry_mirrored`. A remote
   project's `project.json` sits in the local state dir anyway, never in the
   tree, but the rule holds: the in-folder file grants nothing. At creation
   the renderer asks with a top-level `req.remoteOnly: true`
   (`CreateProjectRequest`/`ImportProjectRequest` are camelCase); the backend
   then writes `spec.remote_only = Some(true)` itself and overwrites any
   `remote_only` the renderer put inside `req.remote`. A VM request ignores
   `remoteOnly` (it is remote-only already).
2. **Round-trip.** Absent = today's behaviour for every existing entry
   (Python-era shapes included); VM entries need no migration (absent + `vm`
   → remote-only). `RemoteSpec`'s `#[serde(flatten)] extra` means an older
   build keeps the key on rewrite. An older build *reading* a remote-only
   entry treats it as a plain Remote (empty mirror dir, agents default local,
   lockstep stays off because no `git_peer` state exists): degraded, no data
   loss. A `ComputeHost` flattens `RemoteSpec` too; the field means nothing on
   a worker and is stripped when a worker is written.
3. **One "local copy" resolver.** `services::remote::local_copy_in(entry,
   state_dir) -> Option<PathBuf>` (pure) and `remote_sync::mirror_dir_opt(id)`
   return `None` for a remote-only project and the explicit-else-default
   mirror otherwise. The callers that resolve "a remote project's local tree"
   for something other than sync move to it (E5). The sync engines keep
   `mirror_dir()` and are never reached, because their entry points refuse
   (E3).
4. **Refusals carry one sentinel**, `{UPPER}_REMOTE_ONLY: <what was refused>`
   (built from `crate::brand::UPPER`, like `_VM_DOWN`), so the cockpit can
   word each one and never shows raw text.
5. **No local execution of project content at all.** With no local tree,
   none of `exec_trust`'s subjects (local git hooks, `latexmkrc`, a project's
   prettier) can run locally. The local attack surface is what crosses SFTP
   into viewers and explicit Download-to writes, which keep their
   `resolve_remote_rel` / `safe_local_name` guards.
6. **`is_reserved_scope` untouched.** The kind is a field on a normal
   project. `services::remote::projects()` already drops reserved ids before anything
   reads the field.

### Cockpit

The frontend half of the same generalization:

VM projects are already remote-only by default (`docs/context/vm_projects.md`,
"The inverse sync posture"). The frontend has no notion of a mirrorless
*remote* project, though. It pins on `project.vm?.enabled` at about 15 sites:
`effectiveTabLocation(tab, { vmProject })` in `stores/tabs/tabLocation.ts`,
and its callers `PaneSlot.tsx`, `TabPane.tsx`, `lib/terminal/terminalSpawn.ts`,
`lib/remote/closeRemoteTab.ts` (×3), `stores/projects.ts:877,1653`,
`stores/agents/agentClearUndo.ts`, `agentLocationSwitch.ts`,
`agentWorktreeSwitch.ts`, `MobileBridgeHost.tsx:1414`, `lib/projectTabHost.ts`,
`TabBar.tsx:518/783` (`isVmScope`) and `DetachedCenterPanel.tsx:1911`.

So the cockpit adds **one predicate** and moves those sites onto it:

```ts
// src/lib/projectTabHost.ts
/** Tabs and files of this project live only on its host: a VM project, or a
 *  remote project created without a local copy. No mirror, locality pinned. */
export function isHostPinned(p: ProjectEntry | null | undefined): boolean
// = !!p?.vm?.enabled || (p?.remote?.remote_only ?? p?.remote?.vm === true)
//   — the TS twin of `RemoteSpec::is_remote_only` (field: E1), OR'd with the VM
//   record so a VM is pinned however its spec reads.
```

`RemoteSpec` in `src/types/index.ts` gains `remote_only?: boolean` (F1). One
predicate is enough because v1 never gives a VM a mirror (see Prior art): "no
local copy" and "locality pinned" are the same set of projects.

The `vmProject` option of `effectiveTabLocation`/`tabTerminalSpawn` is
renamed `hostPinned`. This is a rename, not a parallel flag. VM-only surfaces
keep reading `vm.enabled`: the ▣/▢ glyph, VM settings…, and the egress caveat.
Everything that is really about having no mirror reads `isHostPinned`.

**Sibling bugs found in VM projects while tracing this (fixed by the same
steps, per house rule):**
- `TabLocalityBadge` calls `effectiveTabLocation(tab)` without the pin. A VM
  agent tab therefore shows ⌂, and `LocalityMenu` offers "Local (mirror)".
  `TabHoverCard.tsx:229` (the hover card's location line) and
  `useSessionPicker.ts:120/255` (the `/model` remember rows, which treat a
  "local" tab as one whose CLI config is this machine's) make the same unpinned
  call.
- The pill's **Show on disk** (`revealOnDisk`) goes to `remote_mirror_status`
  and, if the folder is missing, asks for a new mirror folder and calls
  `set_remote_mirror_dir`. That creates a mirror for a VM project. **Move
  project…** (`moveMirror`), **Detach SSH host…**, **Repair scaffold** and
  `IdeMenuItems` (it reads markers off the mirror) are offered on VM projects
  too.
- `ProjectFilesPane` shows the Local/Remote `FileSourceSwitch` for every
  remote project. On a mirrorless VM, the Local side browses an empty or
  missing `<state_dir>/remote-projects/<id>/mirror`.
- The "+" menu's local-model group, ☁ Cloud sessions and API-key groups start
  `local`-kind tabs. Their cwd is the mirror (`localTabCwd`), which the
  backend "guarantees exists", so it may create one.
- `ProjectSwitcher.addAndAudit` opens the big-folder sync ask
  (`useBigFoldersStore.openOnce`) whenever `project.remote` is set. A VM's
  create result does carry `remote` (`create_project_blocking` synthesizes the
  loopback spec before anything else), so VM projects get the ask today; the
  F2 skip on `isHostPinned` fixes both.

Cockpit rules:

1. **Chosen at creation**, like the VM tier (D7: Remote ⇄ Remote-only conversion comes after creation).
2. **The file source is always Remote.** `useFileSource` and
   `useIndependentFileSource` return `"remote"` for a pinned project and never
   latch. `FileSourceSwitch` and the compact source row are not rendered, and
   no `TabSourceBadge` controls are published. A pinned project's viewer tabs
   show no ☁ badge either, because on such a project it says nothing.
3. **Locality is pinned to the host.** The `TabLocalityBadge` still renders
   (the user needs to know *which* machine). It opens `LocalityMenu` straight
   on the machines view and drops the "Local (mirror)" row. `RunHostPicker`
   gets the same treatment.
4. **Gone on a pinned project:** the Orange/diverged view, `SyncHostOnlyFiles`,
   `SyncMirrorSkips`, the tree's ↓/↑ sync slots and "Sync to local / Stop
   syncing" rows, `AutoSyncHeaderToggle`, the lockstep block in `GitHistory`,
   Show on disk, Move project…, Detach SSH host…, Repair scaffold, Open in
   IDE, ⧉ open-in-file-manager, the big-folder ask, local-model, API-key and
   ☁ Cloud "+" rows, and native drag-out to the OS. `LocalLossDialog` needs no
   change, because no mirror means no record.
5. **Stays, as the exits and the cockpit:** "Download to…" (`FileTree`
   `downloadEntryTo`, already offered on every remote listing), Sessions,
   Jobs, Remarks, Agents, Apps, the Reader/Chat, and the git dot on the pill.
   The dot is the only place unpushed host commits show, and it already
   carries `unpushed` (`stores/gitDirty.ts`, `ProjectHoverCard`).
6. **No new UI treatment.** Creation uses the existing `toggle-card` and the
   kind uses an extra row in `projectTypeTags`. Refusals reuse
   `RemotePaneHold` and the `file-tree-empty` Connect prompt. Menus are only
   filtered.

## Decisions (D1–D15)

The two drafts raised overlapping open questions; numbered once here. *Fixed*
items follow both drafts' recommendation (or the AGENTS.md rule that already
decides them). D3, D6 and D7 were put to the user on 2026-10-28; their answers are
recorded below.

| # | Question | Status |
|---|---|---|
| D1 | How the kind is recorded | **Fixed:** `RemoteSpec.remote_only: Option<bool>`, effective `remote_only.unwrap_or(vm == Some(true))` (engine rule 1). |
| D2 | Fold the VM tier into the posture | **Fixed:** yes, a VM is remote-only + boot. One predicate per side (`RemoteSpec::is_remote_only`, `isHostPinned`), one spawn guard. No parallel variant. |
| D3 | Tabtivity's MCP servers (help, markup, push, schedule) for host agents | **User, 2026-10-28:** none in v1, as for every host tab today. Pushes use the host's own git credentials. |
| D4 | Worker hosts | **Fixed:** shared-filesystem and no-sync workers only. "Sync a copy" is disabled with a reason, because `worker_sync` sources from the mirror. |
| D5 | Host down | **Fixed:** nothing cached. A Connect placeholder, with no stale tree and no local record of host file names. |
| D6 | TeX compile, SyncTeX, IDE | **User, 2026-10-28:** Compile opens a visible host build tab (`latexmk` over ssh). The PDF reloads over SFTP on its mtime, and SyncTeX shows its existing "remote" notice. Host SyncTeX is a later step. **Fixed** for the IDE: hidden or refused in v1. |
| D7 | Conversions in this plan | **User, 2026-10-28:** Remote ⇄ Remote-only in v1 (E8/F9). Local → Remote-only comes later. |
| D8 | Mirror folder on Remote → Remote-only | **Fixed:** never deleted. A default-location mirror is moved out of the state dir as `<name> (local copy)`. F9's confirm wording follows E8, not "will be deleted". |
| D9 | HPC-tagged hosts | **Fixed:** allowed, with a creation-time warning. There is no background sync, and agent load is the user's call per act. |
| D10 | CLI config on the host | **Fixed:** the host login's own config. Tabtivity writes nothing there (AGENTS.md: never edit another app's config). |
| D11 | Local-model (`local_agent`) tabs | **Fixed:** refused; there is no local tree. |
| D12 | Where it is chosen | **Fixed:** a "Keep a local copy" `toggle-card` under the Remote card (F2). |
| D13 | Default for new remote projects | **Fixed:** keep the mirror on by default. |
| D14 | Auto-connect | **Fixed:** the dialog pre-ticks "Connect when I open this project" only when the connect can be silent. It never prompts. |
| D15 | Phone v1 | **Fixed:** host tabs, start on the host, read-only host files. Upload here, Mark up Submit, attachments and the Git sheet are refused with the existing on-host lines. |

Sibling bugs both drafts found in code this plan touches are fixed in the
steps that touch them (house rule):

- `connect_host` creates an empty mirror for VMs (E3).
- `git_push_blocking`'s host arm skips `hardened_git_args` (E4).
- The host arm of `run_git_remote` has no timeout (E4).
- The VM tab badge offers "Local (mirror)" (F1).
- The VM pill offers Show on disk, Move, Detach, Repair scaffold and IDE (F3).
- The VM file-source switch browses an empty mirror (F4).
- The VM "+" local rows (F6).
- `sqlite_tables` cannot open remote-native files (F5): the viewer is disabled
  on host listings.
- `docs/context/vm_projects.md` names `vm_spawn_refusal` in the wrong module
  (E9). It also says the frontend turns `{UPPER}_VM_DOWN` into a boot action;
  no frontend code reads that sentinel today (E9 corrects the sentence; the
  boot action itself is not this plan's).
- `git_peer`'s `Peer::Remote` arm calls `run_git_remote` with raw args: no
  `hardened_git_args`, hooks live, for background `checkout`/`merge`/`commit`
  on the host (E3).
- `remote_mkdir_p` and `remote_git_init` are unbounded `.output()` calls (E6b).
- The unpinned `effectiveTabLocation` calls in `TabHoverCard` and
  `useSessionPicker` (F1).
- `move_remote_mirror` / `set_remote_mirror_dir` mint a mirror for a VM project
  when called (only the pill hides them today) (E5).

## Inventory — every backend place that reads the mirror or runs locally

Route = runs on the host. Refuse = `{UPPER}_REMOTE_ONLY` error. Hide = the
backend answers "not available" in a shape that already exists.

| Area | Code | Remote-only |
|---|---|---|
| Connect | `remote::connect_host` mirror `create_dir_all` | **skip** (also fixes VM) |
| Byte-sync | `commands::sync::resolve` (shared by the ten transfer/diff/meta commands) **plus** the five that bypass it: `sync_mark_selected`, `sync_set_auto`, `sync_set_excluded` (write `sync.json`), `sync_big_folders` (walks `mirror_dir()`, also run by the on-connect census) and `sync_status` | refuse in `resolve` and the three manifest writers; `sync_big_folders` and `sync_status` answer empty, as `sync_status` already does for a local project (callers probe indiscriminately) |
| Auto-sync | `sync_auto::start` (from `remote_connect`) | no-op |
| Lockstep | `git_peer::start`; `git_peer_set_enabled(true)`, `git_peer_pair_confirm`, `git_peer_mirror_dir` | no-op / refuse |
| Local loss | `local_loss` writers (git_peer, sync) | unreachable, nothing recorded |
| Workers | `worker_sync::sync_worker` / `fan_out` / `on_worker_connect` bundle **from the mirror**; all gate on `wants_code_fanout(host)` | `wants_code_fanout` also takes the posture → `fan_out` and `on_worker_connect` skip silently (background never raises); an explicit `sync_worker` refuses; `add_compute_host` refuses a synced-copy worker (`sync_code && !shared_fs`) on a remote-only project (D4). A `shared_fs` worker or `sync_code: false` works unchanged. `pull_outputs` lands in `<state>/outputs/<label>`, not the mirror: unchanged |
| Mirror relocation | `move_remote_mirror`, `set_remote_mirror_dir` (create a folder and write `extra["mirror"]`) | `move_remote_mirror` refuses; `set_remote_mirror_dir` refuses unless called as the E8 reverse conversion (also fixes VM) |
| Detach | `detach_project_from_remote` | already refuses ("no local mirror to detach to": there is no `extra["mirror"]`); unchanged |
| Activity watch | `usage_stats::watch_root_for` (`mirror_dir`, if it is a dir) | `mirror_dir_opt` |
| VM mirror flag | `commands::vm::has_mirror` (default dir non-empty), fed to `mail_reader::widen_refusal` | `!is_remote_only() \|\| default dir non-empty` — the posture, failing closed on a VM that already has bytes there |
| Tab spawn | `launch_prep` `vm_spawn_refusal` + the local-on-remote mirror-cwd branch | generalize: refuse `local_only` (E2) |
| Run host | `set_project_run_host` (`"local"` = the mirror) | refuse `"local"` |
| Agent move | `agent_host_move::side(None)` (the mirror side) | refuse a local side; host↔worker moves still work |
| Git status/commit/diff/branches | `git_hardened::run_git` / `run_git_hooked` remote arm | route (already host) |
| Git worktrees | `commands::git::worktree_ctx` `WorktreeSite::Local` | refuse the mirror site |
| Publish | `git_publish::parse_publish_from` (default `"local"` = mirror) | default host; local refused |
| Push / pull | `git_push_blocking`, `git_pull` via `git_publish::mirror_origin_repo` (→ `mirror_repo`, `mirror_dir()` + `.git` exists) | route to the host: `mirror_repo` goes through `mirror_dir_opt`, so `None` holds even if an old default mirror with a `.git` is still on disk |
| Lockstep host arm | `git_peer::Peer::Remote` → `run_git_remote` (raw args) | not reached by remote-only; **sibling fix** in E3: hardened args, hooks off (bounded via E4's `run_git_remote` bound) |
| `tabtivity-git` MCP | `root_mcp::grant_lanes` (`Trusted::off_host`) | not granted (as for every host agent today) |
| File tree / viewers | `commands::fs` (`list_dir_remote`, reads, `is_under_mirror`) | route (already SFTP); `file_source` always `"remote"` |
| File watcher | `fs_watch` (no-op for remote) | unchanged; refresh on focus/explicit |
| Search | `commands::search::project_search_blocking` (local walk only); quick open `commands::fs::list_project_paths_blocking` (also used by `ContextFilePicker`) | **route**: new host branch in each (E6a) |
| Python detection | `commands::python::python_interpreters_blocking` | route (already host probe) |
| SLURM, monitor, disk usage, network | `commands::{slurm,monitor,disk_usage,network}` | route (already host) |
| LaTeX build | `commands::tex::compile_tex` (path-based, local) | not called; Compile opens a host build tab (D6) |
| SyncTeX | `commands::synctex` reads local maps | unavailable (TexView already shows `"remote"`) |
| IDE open | `commands::ide::project_root` (mirror) | refuse with sentinel (D6) |
| HPC logs | `hpc_ws::hpc_ws_pull_logs` writes into the mirror | refuse (logs are read over SFTP in place) |
| Restore | `restore_service::project_roots` adds `mirror_dir` | `mirror_dir_opt` |
| Boxes | `box_store::box_allowed_roots` adds member mirrors | member adds no local root |
| Fence roots | `agent_fence::{compute_fence_roots, roots_for_scope, attach_roots}` | no mirror root (no `local_only` tab exists) |
| Mail attach | `mail_attach::root_label` default-mirror fallback | `local_copy_in` |
| Brand migration | `brand_migration::project::on_project_open` (mirror) | skip; `on_remote_connect` (host) unchanged |
| Export | `project_transfer` `include_mirror` (carry the tree) + `MirrorSource::{Local, Host}`; `export_blocker` (refuses VMs) | `MirrorSource::Local` refused; the tree only via `Host` (E5) |
| Agent changes / chat diffs / prompt blame / markup MCP / copilot | `agent_changes`, `mobile_control::{chat_changes, chat_uncommitted}`, `prompt_blame::local_repo_dir`, `markup_mcp::project_root`, `copilot_set_project_policy` | already "remote → unavailable/refused"; unchanged |
| Root MCP | `root_mcp::local_checkout` (`projects_git_status`), `projects_list`, `sync_status` | already skips "no local mirror"; add `remote_only` to `projects_list`, posture row in `sync_status` |
| Mobile catalog | `discovery::{project_host, mobile_root, tab_is_local, runs_on_this_machine, launch_place}` | E7 |
| tmux | `ssh_exec::wrap_pty_options`, `persist_sessions` (default on) | route; every shell survives a drop |
| Time tracking, session state | local | unchanged |

## Agents on the host

- **Spawn**: every agent tab is `ssh -tt` through `ssh_exec::wrap_pty_options`
  with the project's `remote_path` as cwd, resume args resolved before
  wrapping (`launch_prep`). `local_agent` (local-model) tabs cannot run:
  D11.
- **Fence / agent homes**: none of it applies. `agent_fence::decide` returns
  `NotApplicable { reason: "remote host" }`. `agent_home`, `agent_auth`,
  `agent_global` and Tabtivity's session hooks exist only in local homes; a
  host agent uses the login's own `~/.claude` etc. That is today's host-tab
  behaviour, and Tabtivity never edits the host's CLI config (D10).
- **Reader / Focus chat**: `remote_transcript` copies the host transcript
  (Claude only) into `sessions/<id>/` over the pooled SFTP and never dials
  (`disconnected` at once). Other CLIs: no Reader, as for host tabs today.
  Turn state from hooks is absent on the host. Follow-up, not in this plan:
  Claude's `--settings <file>` can add a hook without touching the host's
  config.
- **MCP lanes**: `grant_lanes` gives an off-host spawn no root, schedule,
  push, markup or help lane. Remote-only makes that the default for every
  agent in the project (D3).
- **`agent_host_move`**: local ⇄ host moves are refused, host ⇄ worker moves
  are kept.

## Disconnected behaviour

Nothing is cached in v1 (D5). Contracts kept:

- Every remote-capable command is `async` over a `*_blocking` body or rides
  `pooled_sftp`. `list_dir_remote`'s one-shot fallback is bounded by
  `ConnectTimeout` and subject to the HPC dial policy (`ssh_common::
  declared_dial`). The frontend keeps gating probes on connected.
- **Sibling fix:** the host arm of `git_hardened::run_git_as` →
  `ssh_exec::run_git_remote` is an unbounded `.output()`, while the local arm
  is `git_bounded::output_within`. In a remote-only project *all* git takes
  this arm, so a wedged master piles up blocked workers behind the git bar's
  poll. Bound it with the same `timeout_for`, computed from the **git**
  argument list before it is wrapped into the one ssh command string
  (`git_bounded::verb` cannot find the verb inside `ssh … 'cd … && git …'`),
  and run the ssh `Command` through `git_bounded::output_within` so a timeout
  reaps the ssh child.
- `remote_transcript`, `mobile_control::host_files` and `hpc_ws` already
  never dial and answer "offline" at once.

## Security

- **Trusted source**: `projects.json` decides the posture (engine rule 1),
  and `launch_prep` re-derives it there, as it does for `sandbox` /
  `local_only` (`sandbox::enforce_spawn_authority`). A planted
  `location: "local"` in a layout therefore cannot pull a tab off the host.
- **Spec writers stay field-level.** `patch_remote_spec`, `record_remote_key_auth`
  and `hpc_ws` patch fields (and `vm::record_vm_endpoint` re-serializes the
  typed spec), so `remote_only` survives them. Only
  `extend_project_to_remote`, `create_project`, `import_project`
  (`finish_import`) and the bundle import (`import_project_export`) write a
  whole spec from a request or a bundle; the owning step's tests (E6b for
  create/import/extend, E5 for the bundle) pin that each one sets
  the flag from the trusted input (the request key, or E5's bundle rule) and
  never from a renderer-sent spec field.
- **Git on the host**: `run_git` already applies `hardened_git_args` and pins
  hooks off on the host arm. **Sibling fix:** `git_push_blocking`'s host arm
  calls `ssh_exec::run_git_remote(PUSH_ARGS)` directly and skips
  `hardened_git_args`. Route it through the `run_git_hooked` arm (push keeps
  its pre-push hook, the rest of the hardening applies). A host's own
  `.git/config` is the host's business (`git_hardened` notes); no
  `sanitize_repo_git_config` over SSH. **Sibling fix:** `git_peer`'s
  `Peer::Remote` arm runs its background host verbs with raw args and hooks
  live; it gets `hardened_git_args` (hooks off), the same as the `Peer::Local`
  arm's `hookless_git_command_in`.
- **`exec_trust`**: nothing to gate locally (engine rule 5). Host-side
  hooks run on the host as the login, where the agents already run.
- **`mobile_control`**: host paths, the host name and the spec never cross
  the browser API. Remote-only reuses `host_files` (sealed tokens, the
  `realpath(root+rel)` check, no dial) and the host-tab `machines` list
  (opaque ids).
- **Download-to** (`commands::vm::remote_download_{size,to}`) already serves
  any remote project. It stays the one casual file exit, user-clicked and
  size-confirmed.

## Contract between engine and cockpit (what the UI reads and calls)

| Need | Name the UI uses (engine owns the shape) |
|---|---|
| The flag | `RemoteSpec.remote_only?: boolean` in `projects.json` `extra.remote`, mirrored onto the entry (`ProjectEntry.remote`); the TS `RemoteSpec` type gains it. Entries have no `mirror`. Set at creation (or by an E8 conversion) and read-only to the renderer. |
| Create/import | `create_project` / `import_project` `req.remoteOnly: true` (top-level, camelCase; the backend writes the spec field, engine rule 1). `mirrorParent` is omitted. Creation itself only does the best-effort host `mkdir`; scaffold + `git init` on the host are the separate `remote_project_init_host(projectId, scaffold, git)` the dialog calls after the project's first connect (E6b, F2). A clone calls neither. |
| Search, quick open | `project_search` (`commands/search.rs`) / `list_project_paths` (`commands/fs.rs`) answer for a pinned project from the host. Both are local walks today, so remote projects search only their mirror. The UI passes the project's stored `directory` (its state dir) as `projectDir`, which the engine resolves with `remote_target_for_dir`, as the git commands do; `project_search` gains an optional project-relative `relRoot` for the folder scope (a host path cannot be resolved). |
| TeX | No new engine call (D6): for a pinned project, Compile opens a visible host shell tab running `latexmk -cd … ./<rel>.tex` (F5). `compile_tex` (local-only, `commands/tex.rs:1110`) is never called. SyncTeX keeps the "remote" notice. |
| Spawn refusal | The backend refuses a local spawn for a pinned project (twin of `vm_spawn_refusal`) with `{UPPER}_REMOTE_ONLY: …`. No frontend code maps `_VM_DOWN` today, so there is nothing to share: F1 adds one mapper (`remoteOnlyRefusal(err)` in `src/lib/projectTabHost.ts`, prefix from `BRAND.upper`) that turns the sentinel into a translated line, used by the terminal's spawn-error note and wherever a pinned project's refused call surfaces an error. |
| Phone | `ProjectDetail.folder: false`, `host_files: true`, every `TabRow.on_host: true`. `launch-options` lists no "this computer" row (D15). |
| Fixtures | Two shared tables, both read by the sidecar's `discovery` tests (`discovery/tests.rs:1407`, `:1423`) and by `MobileTabLocality.test.ts` / `MobileTabReach.test.ts`: `tabLocality.fixture.json` (its `vm` column becomes `pinned`; remote-only rows added) and `projectHostReach.fixture.json` (remote-only record rows added: host `remote`, reach false, lists true). A2 does the `tabLocality` rename and its rows; they pass on both sides at once, because `tab_is_local` already takes the pin as a bool. A8 adds the `projectHostReach` rows, since only E7 teaches the sidecar to read `remote_only` off a record. |

## Engine steps (E1–E9)

Each step lands with its tests. Cross-OS: build local paths with `Path::join`;
host paths are POSIX strings, never `Path`; no absolute-path literals except
under `cfg!(windows)`.

E1. **Posture + resolver.** `RemoteSpec.remote_only`, `RemoteSpec::is_remote_only`,
   `remote::local_copy_in` (pure), `remote_sync::mirror_dir_opt`; strip the field on
   `ComputeHost` writes. *Files*: `schema/project.rs`, `services/remote.rs`,
   `services/remote/remote_sync.rs`, the `compute_hosts` writer in
   `commands/projects.rs`. Also `req.remoteOnly` on the two request structs
   (deserialized and stored only; E6b acts on it), and the `{UPPER}_REMOTE_ONLY`
   sentinel builder (one `fn remote_only_refusal(what) -> String` beside the
   resolver, so every step words it the same). *Tests*: serde round-trip (absent / true / false /
   VM default / unknown keys kept), `local_copy_in` over a tempdir state
   (explicit mirror, default mirror, remote-only, VM), worker ignores the flag.
E2. **Pinned locality.** `vm_spawn_refusal` → `pinned_spawn_refusal(pin,
   running, local_only, tab)` with `Pin::{None, RemoteOnly, Vm}`. The VM keeps
   its message and `_VM_DOWN`; remote-only refuses `local_only` with
   `_REMOTE_ONLY`. `set_project_run_host` refuses `"local"`.
   `agent_host_move` refuses a local side. The refusal keeps its place
   *before* the "local-on-remote → mirror cwd" branch (`launch_prep.rs` ~l.795),
   which `create_dir_all`s the mirror; a test pins that a refused remote-only
   spawn creates no mirror folder. `local_agent` tabs are always `local_only`, so
   D11 needs no separate check. *Files*: `services/launch_prep.rs`,
   `commands/projects.rs`, `services/remote/agent_host_move.rs`. *Tests*:
   extend the existing refusal matrix (`launch_prep` tests ~l.1686), plus the
   run-host and move refusals.
E3. **Sync off at the choke points.** `connect_host` skips the mirror mkdir;
   `sync_auto::start` and `git_peer::start` no-op; `git_peer_set_enabled(true)`,
   `git_peer_pair_confirm`, `git_peer_mirror_dir`, `commands::sync::resolve`
   and the three manifest writers that bypass it (`sync_mark_selected`,
   `sync_set_auto`, `sync_set_excluded`), `worker_sync::sync_worker`,
   `add_compute_host` for a synced-copy worker, and `hpc_ws_pull_logs` refuse.
   `sync_big_folders` and `sync_status` answer empty; `wants_code_fanout`
   takes the posture, so `fan_out` / `on_worker_connect` skip. Sibling fix
   (security, in the file this step owns): `git_peer::Peer::Remote` passes
   `hardened_git_args` (hooks off) instead of raw args, matching `Peer::Local`'s
   `hookless_git_command_in`; output parsing is unchanged because the `-c`
   pairs only precede the verb. *Files*:
   `services/remote.rs` (connect), `services/remote/sync_auto.rs`,
   `services/git/git_peer.rs` + `commands/git_peer.rs`, `commands/sync.rs`,
   `services/remote/worker_sync.rs`, `commands/hpc_ws.rs`,
   `commands/projects.rs` (`add_compute_host` only). *Tests*: each
   refusal through its pure gate; the `Peer::Remote` argv carries the
   no-hooks pin. A `connect_host` helper predicate
   (`mints_mirror(spec, host_id)`) tested for primary / worker / VM /
   remote-only.
E4. **Git on the host.** `worktree_ctx` refuses `Local`;
   `parse_publish_from`/site resolution defaults to `Host` and refuses `Local`
   for remote-only. The push host arm goes through `run_git_hooked`'s remote
   path (security sibling fix), and `run_git_remote` gets a bound
   (`git_bounded`, timeout from the git args; see Disconnected behaviour).
   `git_publish::mirror_repo` resolves through `mirror_dir_opt`. (`git_peer`'s
   own host arm inherits the bound through `run_git_remote`; its hardening is
   in E3, which owns `git_peer.rs`.) *Files*: `commands/git.rs`,
   `commands/git_publish.rs`, `services/git/git_hardened.rs`,
   `services/remote/ssh_exec.rs`. *Tests*: site resolution per posture; push
   argv carries `hardened_git_args`; the bound's timeout is the verb's (`push`
   → `LONG_TIMEOUT`, `status` → `READ_TIMEOUT`) when computed for a wrapped
   remote call.
E5. **Local-tree readers.** Move `ide::project_root`,
   `restore_service::project_roots`, `box_store::box_allowed_roots`,
   `agent_fence::{compute_fence_roots, roots_for_scope, attach_roots}`,
   `mail_attach::root_label`, `brand_migration::project::on_project_open` and
   `usage_stats::watch_root_for` to `local_copy_in` / `mirror_dir_opt`.
   `commands::vm::has_mirror` becomes `!is_remote_only() || <default dir
   non-empty>` (posture first, failing closed for `widen_refusal`).
   `move_remote_mirror` refuses a remote-only project; `set_remote_mirror_dir`
   refuses one unless E8's reverse flag is passed (until E8 lands, it simply
   refuses) — both also stop minting a mirror for a VM. `MirrorStatus`
   (`remote_mirror_status`) gains
   `remote_only: bool`. Root MCP `projects_list` gains `remote_only`, and
   `sync_status` reports the posture instead of "lockstep off".
   `project_transfer`: `include_mirror` keeps its meaning (carry the tree);
   for remote-only, `mirror_source: Local` is refused with the sentinel and
   the tree comes only from `MirrorSource::Host` (the export dialog leaves
   `include_mirror` off until the host preview has measured the tree).
   `export_blocker` keeps refusing VMs. On import, a bundle with a tree
   section registers as a plain Remote with that tree as its mirror
   (`remote_only` removed, since a local copy now exists); one without keeps
   `remote_only`. *Files*: many small call sites (`commands/ide.rs`,
   `services/restore_service.rs`, `services/box_store.rs`,
   `services/agent/agent_fence.rs`, `services/mail/mail_attach.rs`,
   `services/brand_migration/project.rs`, `services/usage_stats.rs`,
   `services/root_mcp.rs`, `commands/vm.rs`, the mirror commands in
   `commands/projects.rs`); the one large change is `commands/project_transfer.rs`.
   *Tests*: the pure root planners with remote-only members
   (no default-dir root may appear); export preview per posture; the import
   round-trip; `move_remote_mirror` / `set_remote_mirror_dir` refusals;
   `has_mirror` per posture.
E6a. **Host search and quick open.**
   - `project_search_blocking`: when `remote_target_for_dir(project_dir)`
     resolves to a remote-only spec, run `grep -rnIZF` (`-i` unless
     `case_sensitive`) `--exclude-dir=.git --exclude-dir=<brand dir> -- <q>
     <root>` on the host through `ssh_exec::remote_shell_command`, bounded by
     `git_bounded::run` with `READ_TIMEOUT` and piped through `head -n <cap>`.
     `-Z` (NUL after the file name, GNU and BSD grep both have it) keeps a
     `:` in a path from breaking the parse; lines are truncated to the local
     walk's line cap, `col` is computed from the line text, and the output is
     parsed into `SearchMatch`. The query and `<root>` are `shell_quote`d.
     `<root>` is `.` or the new optional `rel_root` (project-relative, POSIX;
     `..`, absolute paths and NULs refused, as `resolve_remote_rel` does),
     which the folder scope needs because a host folder path cannot be
     resolved back to a project. On an HPC-tagged host the call refuses with
     `hpc_mode`'s `HPC_GUARD` sentinel unless `confirmed` (the
     `sync_big_folders` shape: a whole-tree walk on a login node is the act the
     tag guards). A plain Remote project keeps searching its mirror. This
     extends the one search command; no second one.
   - `list_project_paths` (quick open, and `ContextFilePicker`), same rule: a
     bounded `find . \( -name .git -o -name <brand dir> \) -prune -o -type f
     -print0` on the host (GNU, BSD and busybox `find` all have `-print0`),
     capped at the local walk's entry cap, behind the same HPC guard. It
     returns files only (`is_dir: false`): both callers drop directories
     anyway.
   *Files*: `commands/search.rs`, `commands/fs.rs` (the one function), new
   pure helpers in `services/remote/host_search.rs`. *Tests*: the argv and
   quoting (pure), the NUL-separated parser, `rel_root` validation, the HPC
   refusal.
E6b. **Host creation and init.**
   - `create_claimed_project` with `req.remote_only`: as today, a
     best-effort `remote_mkdir_p`, then no mirror, no local scaffold, no
     `git_peer` state, and no local `.git` honesty downgrade (it is the VM's
     skip: the repo is made on the host later). Split out a pure
     `remote_creation_plan(req) -> {mirror, local_scaffold, arm_lockstep}` so
     the VM, Remote and remote-only rows are unit-tested.
   - `finish_import` with remote-only: no mirror. `remote_git_init` stays.
   - **New command `remote_project_init_host(project_id, scaffold, git)`**,
     `async` over a `*_blocking` body; needs a connected pool (refuses "connect
     first" otherwise). It runs `mkdir -p`, writes the `SCAFFOLD_FILES` over
     SFTP no-clobber (create-new; an existing entry, link or not, is left
     alone, as `write_scaffold_file` does), then `remote_git_init` and the
     scaffold commit via `run_git(Some(target), …)` (hardened, hooks off). If
     the host `git init` fails it downgrades the entry's `git_type` to `none`
     (the honesty rule `finish_import` applies). The dialog calls it after the
     project's first connect (F2), so password-auth hosts work too. It is
     idempotent, so a retry after a dropped connection is safe. Clones never
     call it: they stay a visible host tab (`git clone --progress <url> .`)
     into the empty folder, as `submitVmProject` does. VM creation is
     unchanged (it has no scaffold step today; adopting this command for VMs
     is a follow-up).
   - Sibling fix: `remote_mkdir_p` and `remote_git_init` run through
     `git_bounded::output_within` (`WRITE_TIMEOUT`) instead of a bare
     `.output()`.
   *Files*: `commands/projects.rs`, new `services/remote/remote_scaffold.rs`,
   `services/remote/ssh_exec.rs` (the two helpers). *Tests*:
   `remote_creation_plan`, and the scaffold write plan (which files,
   no-clobber decisions) against a fake lister; the git-type downgrade.
E7. **Mobile control.** `project_host` stays `Remote` for remote-only (the
   browser API word is unchanged). `ScopeSource` gains `pinned: bool`, and
   `tab_is_local` / `runs_on_this_machine` pin like the VM. `launch_place`
   returns `NotAttachable` for a local kind. `mobile_root` → `None` (`folder:
   false`). `primary_host` and `machines` are filled, so the 📁 library's host
   side and phone-started host agents work (`docs/mobile_remote_host_tabs_plan.md`).
   `headless.rs` never chooses `LocalMirror`. `ProjectRecord` reads
   `remote.remote_only` (falling back to `remote.vm`) so the pin is the
   backend's `is_remote_only`, decided from the record, never from a path.
   *Files*: `services/mobile_control/discovery.rs` (+ `discovery/tests.rs`),
   `services/mobile_control/headless.rs`. *Tests*: discovery fixtures for
   a remote-only record, and the `projectHostReach.fixture.json` remote-only
   rows (both readers; `tabLocality.fixture.json`'s rows already came with A2).
E8. **Conversion Remote ⇄ Remote-only** (plain Remote projects only; both
   directions refuse a VM project in v1, see Prior art).
   - **New `remote_unpair_mirror_preview(project_id)`**, read-only, `async`
     over a `*_blocking` body, refuses "connect first" while disconnected (the
     lockstep probe needs the host). It reports: lockstep in step?
     (`git_peer` probe, hookless on the mirror side), mirror commits and
     uncommitted changes not on the host, byte-sync entries with unpushed
     local edits, **open local tabs** (saved tabs of the project whose
     effective location is local: an agent or shell running in the mirror),
     synced-copy workers (`sync_code && !shared_fs`) that would stop receiving
     code (D4), the mirror path and where it will end up, and a `fingerprint`:
     a hash of the mirror's `HEAD`, its `git status --porcelain=v1 -z` and
     `sync.json`'s `(len, mtime)`.
   - **New `remote_unpair_mirror(project_id, expect: <fingerprint>)`**,
     `async` like `detach_project_from_remote` (blocking halves around the
     async state clear; the move-out's cross-device fallback is a
     `remove_dir_all`, so it runs on a worker). It refuses if the fingerprint
     changed, or while any local tab is open (close it or move it to the host
     first: the existing locality move). It stops `git_peer` /
     `sync_auto`, runs `clear_host_bound_state` (`local_loss.json` survives,
     as on detach), sets `remote_only: true` and removes `extra["mirror"]`
     and a `"local"` run host. The mirror **folder is never deleted**
     (D8): an explicit-path mirror stays where it is; a default-path
     one (inside the state dir, where `mirror_dir()` would still find it) is
     moved out to the projects-ssh root as `<name> (local copy)` (a ` 2`, ` 3`
     suffix if taken), and that path is returned.
   - **Reverse**: `set_remote_mirror_dir` gains an optional `keepLocalCopy:
     true`. Only with it does the command accept a remote-only project, and
     then it removes `remote_only` along with recording the mirror; without it,
     a remote-only project is refused (E5), so the old "relocate a missing
     mirror" caller can never convert one by accident. Pairing then goes
     through the existing `git_peer_set_enabled` + `git_peer_pair_confirm`
     flow (`git_peer::pairing_conflicts`), host authoritative. No new pairing
     engine.
   - Local → Remote-only: later (D7). It would be
     `extend_project_to_remote` followed by `remote_unpair_mirror`.
   - New commands (`remote_unpair_mirror{,_preview}` here,
     `remote_project_init_host` in E6b) use
     `#[cfg_attr(feature = "desktop", tauri::command)]` and take `Ctx` or
     nothing. Each gets a `services::command_class` row (`core`, like
     `detach_project_from_remote`). None takes a local path argument, so no
     new `core_dispatch` row; `set_remote_mirror_dir`'s `path` row exists.
     Then regenerate `src/lib/transport/commandClasses.ts`
     (`UPDATE_COMMAND_CLASSES=1 cargo test -p tabtivity --lib --
     the_generated_command_classes_ts_is_current`). The steps that add a
     command list its row in the handoff file; the main agent regenerates once
     at merge. *Files*: `commands/projects.rs` (or a new
     `commands/projects/remote_unpair.rs` if `projects.rs` has no room),
     `services/git/git_peer.rs` (probe reuse only). *Tests*: the preview
     fingerprint refusal, the open-local-tab refusal, the VM refusal, the
     state-file clears (tempdir), the default-mirror move-out (and its name
     suffix), and that `set_remote_mirror_dir` without `keepLocalCopy` refuses
     a remote-only project.
E9. **Docs.** Add a "Remote-only" section to `docs/context/remote_projects.md`;
   in `docs/context/vm_projects.md`, state "a VM project is remote-only +
   boot" and fix its stale `commands::terminal::vm_spawn_refusal` reference
   (the function is in `services::launch_prep`), and its claim that the
   frontend turns `_VM_DOWN` into a boot action (no code does). One-line
   `filemap_backend.md` rows for the new `remote_scaffold.rs` and
   `host_search.rs`, and the changed `vm.rs` / `search.rs` rows.

## Cockpit steps (F1–F10)

### F1 — the predicate and the rename
`src/lib/projectTabHost.ts`: `isHostPinned`. Rename `vmProject` →
`hostPinned` across the call sites listed above. In
`phoneReachesTab`/`phoneListsTab`, a pinned remote lists every tab and reaches
none locally. A VM keeps today's "listed local only" until its own phase.
`TabLocalityBadge` takes a `pinned` prop and passes the pin to
`effectiveTabLocation`. `LocalityMenu` takes `pinned` (no Local row, starts on
`machines`), and `RunHostPicker` drops its "this computer" choice on a pinned
project the same way (cockpit rule 3; E2 refuses a stored `"local"`). The
`addMenuMachines` and `DetachedCenterPanel` `machines` gates move to the
predicate. Also in this step: `remote_only?: boolean` on the TS `RemoteSpec`
(`src/types/index.ts`); the pin passed in the unpinned calls of
`TabHoverCard.tsx:229` and `useSessionPicker.ts:120/255` (sibling fix); and
the one refusal mapper `remoteOnlyRefusal(err)` (contract table), wired into
the terminal's spawn-error note. `tabLocality.fixture.json`: rename the `vm`
column to `pinned` in the fixture and in all three readers
(`MobileTabLocality.test.ts`, `MobileTabReach.test.ts`, and the Rust reader in
`discovery/tests.rs`, a two-line change), and add remote-only rows.
*Tests:* `__tests__/tabs/TabLocality.test.ts` (pinned overrides a stored
`local`; `local_agent` is unreachable on a pinned scope), the fixture readers
above, and a `remoteOnlyRefusal` unit test (sentinel → translated line, any
other error → `null`).

### F2 — creation flow (`components/projects/ProjectDialog.tsx`)
Under the "Remote (SSH) project" `toggle-card`, a second `toggle-card`
**"Keep a local copy"** appears, on by default (D12). Turning it off
hides "Local location" (`mirrorParent`, `chooseLocalMirrorLocation`) and its
`folderRequired` error, and shows one `project-dialog-path` hint. The
connect → browse → details steps of `RemoteProjectSection`/`useRemoteSession`
stay unchanged: New creates `<browsed>/<name>` on the host, and Import
registers the browsed folder. Submit sends `remoteOnly: true`. Clone import
becomes selectable when remote-only (`isCloneImport` drops `!isRemoteProject`
in that case only). It reuses `submitVmProject`'s pattern: create, then
`onProject`, then one visible host shell tab running
`git clone --progress <url> .` (house rule: a visible one-click tab). The
backend has already created the folder empty. `publishesAtCreation` already
excludes remote projects, and the pill's Publish… for a pinned project offers
only `publishFrom: "remote"` (`commands/git_publish.rs`
`parse_publish_from`). The trust-tier dropdown stays hidden for remote
(`containerAvailable = !isRemoteProject`). `ProjectSwitcher.addAndAudit`
skips the big-folder ask when the project is pinned.

Order after `create_project` for a remote-only **New** (not Import, not
clone): today's submit fires `connectCreatedRemoteProject` without awaiting
it and then opens the scaffold-fill and description agent tabs. For
remote-only it awaits the connect, then calls `remote_project_init_host`
(`scaffold: !skipScaffold`, `git: gitType !== "none"`), and only then opens
those agent tabs (they are host tabs now, and they edit the scaffold the init
just wrote). If the connect or the init fails, the project still exists; the
dialog shows the error with a retry of the init alone (the
`publishCreated` pattern), and skips the agent tabs.

D14: for a remote-only project the dialog shows the existing auto-connect
choice (`pill.autoConnectOnLaunch`, title
`remoteConnect.autoConnectTitleEligible`) as a `toggle-card`, pre-ticked only
when the dialog's own connect used no password (key/agent auth) and the spec
has no OpenVPN tunnel (auto-connecting a VPN reroutes the machine's traffic
without a prompt, so the user ticks that one). Ticked → the spec carries
`auto_connect: true`; the backend's never-prompt path still re-checks on every
connect. A plain Remote creation is unchanged.

D9: when the browsed host is HPC-tagged (the same `hpc_hosts` check the
careful-mode surfaces use), the remote-only hint gains one warning line
(`projectDialog.remoteOnlyHpcWarning`: every agent and build runs on that
machine; search and quick open ask first). Creation is not blocked.
*Tests:* new `__tests__/projects/ProjectDialogRemoteOnly.test.tsx`. It checks
that the toggle hides Local location, that the payload carries `remoteOnly`
and no `mirrorParent`, that a New awaits the connect and calls
`remote_project_init_host` before any agent tab opens, that a clone opens one
host tab with the clone argv and never calls the init, and that auto-connect
is pre-ticked only for a password-less, VPN-less connect.

### F3 — pill and kind indicator (`ProjectPill.tsx`, `projectTypeTags.ts`)
`projectTypeTags` gets one more tag `key: "remoteOnly"`, labelled
`projectType.tagRemoteOnly` ("Host only") with a title naming the host. It
sits beside the SSH tag, and the colour is a token, not a new hue family. The
pill menu hides Show on disk, Move project…, Detach SSH host…, Repair scaffold
and `IdeMenuItems` on `isHostPinned`. Archive keeps
`pill.archiveRemoteNotTouched*` and adds one line: "No local copy exists. What
is not pushed lives only on the host." Export (`ProjectExportDialog`) for a
remote-only project hides the "mirror" source and offers only the host tree,
streamed over SSH (E5, `MirrorSource::Host`), with the existing size preview.
A VM keeps its up-front export refusal (`project_transfer::export_blocker`,
pinned by `a_vm_project_is_blocked_up_front`). `RemoteConnMenu` lamps and the
reconnect stay as they are. The pill's Publish… window for a pinned project
offers only `publishFrom: "remote"` (F2's note; this step owns the pill).
`RemoteMachinesWindow`'s add-machine form, on a remote-only project, offers
only "Shared filesystem" and "No code sync"; "Sync a copy" is disabled with a
reason line (D4; E3 refuses it in the backend too). Show on disk is hidden on
a pinned project; on a plain Remote it now also reads
`MirrorStatus.remote_only` so a stale window can never offer to create a
mirror for a remote-only one.
*Tests:* `ProjectTypeTags.test.ts` (tag present, SSH tag kept), and a new
`ProjectPillRemoteOnlyMenu.test.tsx` (the rows above absent, Archive line
present, the same rows absent on a VM), and the add-machine form's disabled
"Sync a copy".

### F4 — the file panel (`ProjectFilesView.tsx`, `ProjectFilesPane.tsx`, `sidePanelViews.ts`, `FileTree.tsx`)
`SidePanelViewGates` gains `mirror: boolean`, and `orange` requires
`remote && mirror`. `AppShell`'s edge rail passes the same value, so the
rail and the row cannot drift. `ProjectFilesPane` resolves `treeDir =
projectDir` (remote) for a pinned project and never computes `mirrorDir`.
Disconnected, it shows the existing `file-tree-empty` Connect prompt with no
Local escape, worded `projectFilesPane.disconnectedHostOnly` ("The files live
only on {host}. Connect to browse them."). `FileTree`: for pinned only,
`canSearch = !remoteListing || hostPinned`, gated on connected; the
content search passes the project's `directory` as `projectDir` and, in the
folder scope, the folder as `relRoot` (project-relative). An HPC-tagged host
answers `HPC_GUARD`, which goes through the existing `withHpcConfirm`
(`lib/remote/hpc/hpcGuard`) and one retry with `confirmed: true`. The UI test
mocks the command, so this step does not wait for E6a. On a pinned
tree, `handleEntryDragStart` and the Ctrl handoff skip `beginNativeFileDrag`
(host paths are not OS paths). In-app drags to tabs keep working. Shift-open
in an external app shows a message pointing at "Download to…". Its
`openFile` path otherwise hands the OS a host path. `GitHistory` gets
`remote={!pinned}`, so `lockstepEligible` is false. `QuickOpen` (and
`ContextFilePicker`) keep passing the project's `directory`, are gated on
connected for a pinned project, and use the same `withHpcConfirm` retry. The ⧉ buttons
(`ProjectFilesView:1322`, `ProjectFilesPane:393`) are hidden.
*Tests:* new `__tests__/files/SidePanelViews.test.ts` (no Orange on pinned,
Sessions kept), `FileSourcePref.test.ts` (pinned is always remote and never
latches), and `FileTreeSearch.test.tsx` (pinned remote listing offers search,
passes the project directory and `relRoot`, retries once after the HPC
confirm).

### F5 — viewers (inventory)

| Viewer | Today on a remote-native file | Pinned plan |
|---|---|---|
| Code/Text/Markdown/YAML/Table/Bib/Remarks | `readFileText`/save over SFTP via `projectId`; `file_mtime` polls gated on visible | works; nothing to do |
| Image/GIF/ODT/Media | `readFileBytes` → Blob URL (`MediaView` `useMediaBlobUrl`) | works; large media reads whole over SFTP. A size note before loading is v2 |
| PDF/Deck/presenter | `lib/viewers/pdfLoad.ts` `getDocument({ data })` from `readFileBytes` | works |
| SyncTeX (PdfViewer, TexView) | refused with `pdfViewer.syncRemoteMsg` (`remoteSource`) | the "remote" notice stays (D6); host SyncTeX is a later step |
| TeX compile (`TexView`, `TexWorkspaceView`) | `compile_tex` runs locally on the mirror (`localMirrorRootFor`) | Compile opens a host build tab (D6), the same one-click tab pattern as clone: a `shell` tab with `cmd: "latexmk"`, `args: ["-cd", <engine flag from the viewer's setting, e.g. "-pdf">, "-interaction=nonstopmode", "-synctex=1", "./<rel>.tex"]` (`-cd` builds in the file's folder although a host tab starts at the project root; the `./` keeps a leading `-` in a name from reading as a flag; `remote_command` quotes each arg). A project's `latexmkrc` runs on the host, as the login (engine rule 5). Pressing Compile again reuses the tab while it is open. The PDF tab reloads on its mtime poll. TeX hover preview is off |
| TeX hover preview | runs in the local document folder | off on pinned unless the engine routes it (missing `\usepackage` files) |
| SQLite | `sqlite_tables` opens a local path (`commands/sqlite.rs`) | the viewer is disabled on a pinned listing and "Download to…" is offered (this is broken for any remote-native file today) |
| Notebook | read-only render from text | works |
| PDF markup | desktop markup refuses remote projects (`docs/context/markup_mcp.md`) | unchanged; the refusal line is reused |
| `ViewerHeader` auto-sync toggle | shown for remote | hidden on pinned |

### F6 — tabs (`TabBar.tsx`, `DetachedCenterPanel.tsx`, `NewTabMenu.tsx`, `PaneSlot.tsx`)
"+" menu on a pinned scope: Agents (no ▾ machine list unless workers exist),
Shell, Files, Monitoring and Workspace stay. `localModelMenuGroup`,
`apiKeyMenuGroups` and the ☁ `pickCloud` fly-out are omitted. Restore on
restart is unchanged: host tabs are tmux-wrapped by default (`persist_sessions
!== false`), `tmux new-session -A` reattaches, and agents re-run `--resume` on
the host. While the host is down, `PaneSlot`'s `holdRemoteTerminal` holds
*every* pinned pane on `RemotePaneHold`. Today's "local panes work offline"
branch can't apply, because pinned tabs never resolve local. Any new probe
added here (search, quick open, git) is gated on connected and on
`PaneVisibleContext` and catches up on show.
*Tests:* `AddTabMenuNav.test.tsx` / `AgentMachineMenu.test.tsx` (pinned scope
has no local-model, API-key or cloud rows), and a `PaneSlot` hold test (a
pinned agent tab holds while disconnected).

### F7 — disconnected cockpit
What the user sees: the lamp is red; the file panel shows the host-only
Connect prompt; every tab and viewer shows `RemotePaneHold` with Connect;
Sessions, Jobs and Git show their own "connect first" states (already gated on
`remoteBlocked`); notes, Remarks cache, Chat history of closed agents and the
to-do board still work. Connect always opens `RemoteMachinesWindow` /
`RemoteConnectDialog` on a click. Auto-connect stays `remote.auto_connect`'s
never-prompt path (`docs/context/remote_autoconnect.md`). D14 is
whether the creation dialog pre-ticks it.

### F8 — phone (`mobile-web/`)
Most of this is already built for "a VM without a mirror". `Project.tsx`
`folderless` hides files, Git and send-a-file. `FilesLibrary` opens on the
host side with no switch (pinned by `MobileProjectFiles.test.tsx`, "opens on
the host's side with no switch when there is no mirror yet"). `TabCard` shows
the on-host chip. `Terminal.tsx` drops Mark up Submit and attach tiles for
`tab.on_host`. Remaining work: `NewTabSheet` `MachinePicker` omits
`mobile.newTab.thisComputer` when every machine row is the project's own
(remote-only), preselects the primary, and shows the existing
`machineConnectHint` when it is offline. The desktop access picker's title
uses a new `mobile.hostReach.remoteOnly` line, chosen by `isHostPinned` at
both `HOST_REACH_KEY` uses (`ProjectFilesView.tsx:1681` and
`MobileAccessPicker.tsx:124`). Refused on the phone, with the
existing one-liners: Upload here, Mark up Submit, attachments other than the
project reference, local-model and API-key rows, and the Git sheet (D15).
Another session has uncommitted work in `mobile_control/host.rs`,
`Terminal.tsx` and `MobileBridgeHost.tsx` (2026-10-28); this step starts from
whatever HEAD holds then and rebases onto it, never onto a dirty tree.
*Tests:* `MobileNewTabSheet.test.tsx` (no "This computer", primary
preselected, offline host disabled), and `MobileProjectFiles.test.tsx` (a
remote-only detail renders like the folderless VM case).

### F9 — conversion (v1 per D7; confirm wording per D8)
Two pill-menu rows in the Edit group, each behind `AsyncConfirmDialog`, both
hidden on a VM project (E8 refuses VMs in v1):

- **"Stop keeping a local copy…"** (Remote → Remote-only) is marked danger.
  It is enabled only while connected (the preview needs the host). It calls
  `remote_unpair_mirror_preview` and shows its counts: commits and
  uncommitted changes not yet on the host, byte-sync edits not pushed, and
  open local tabs. It refuses while any of these is non-zero ("Push, sync or
  close these first"; the local-tab line points at the tab badge's existing
  move to the host). Synced-copy workers are not a blocker: the confirm names
  them as machines that stop receiving code. The confirm then says the mirror
  folder is **kept** as a plain folder and names the path it ends up at (D8).
  It calls `remote_unpair_mirror` with the preview fingerprint and shows the
  returned path; a changed-fingerprint refusal re-runs the preview.
- **"Keep a local copy…"** (Remote-only → Remote) is additive. The user picks
  a folder, `set_remote_mirror_dir` is called with `keepLocalCopy: true`, then
  pairing runs through the existing lockstep pairing flow, host
  authoritative, with a size-confirmed first pull.

Local → Remote-only (later) will be **Extend to remote…** followed by Stop
keeping a local copy. It is never one step.

*Tests:* the preview counts (local tabs included) block the confirm, the
kept-folder path is shown, `keepLocalCopy: true` is sent, and both rows are
absent on every VM project.

### F10 — strings, register, docs, todo
- **i18n (`src/lib/i18n/en.ts`, English holds every key):**
  `projectDialog.keepLocalCopyTitle`, `.keepLocalCopyDesc`,
  `.remoteOnlyHint`, `.cloneOnHostTab`; `projectType.tagRemoteOnly`,
  `.titleRemoteOnly`; `projectFilesPane.disconnectedHostOnly`;
  `pill.archiveRemoteOnlyLine`; `fileTree.externalOpenHostOnly`,
  `fileTree.sqliteHostOnly`; `tabLocality.pinnedHostTitle`;
  `mobile.hostReach.remoteOnly`; `projectExport.remoteOnlyNote`;
  `projectDialog.initHostFailed` + `.initHostRetry`, `.remoteOnlyHpcWarning` (F2);
  `tabs.remoteOnlyRefused` (the F1 mapper's line);
  `remoteMachines.syncCopyRemoteOnly` (F3's disabled "Sync a copy" reason);
  `tex.compileOnHostTab` (F5's tab label); (F9)
  `pill.stopLocalCopy*`, `pill.keepLocalCopy*`. D14's auto-connect choice
  reuses `pill.autoConnectOnLaunch` and `remoteConnect.autoConnectTitleEligible`.
  All text goes through `useT()`, and the app name only through `{app}`.
- **`src/lib/untested.ts` rows** (area · what):
  `projectDialog.keepLocalCopyTitle` (projects · ProjectDialog · Keep a local
  copy off = remote-only project), `projectDialog.cloneOnHostTab` (projects ·
  clone into a remote-only project in a host tab), `projectType.tagRemoteOnly`
  (projects · Host only tag), `projectFilesPane.disconnectedHostOnly` (files
  · host-only connect prompt), `tabLocality.pinnedHostTitle` (tabs · pinned
  locality menu), `mobile.hostReach.remoteOnly` (mobile · remote-only access
  line), `mobile.newTab.remoteOnlyHost` (mobile · Runs on without This
  computer), `tex.compileOnHostTab` (viewers · TeX compile in a host tab),
  and `pill.stopLocalCopy` / `pill.keepLocalCopy` (projects · Remote ⇄
  Remote-only conversion). `UntestedRegistry.test.ts` enforces call site ⇄ row.
- **Help:** `docs/help/remote-projects.md` gets a "Remote-only projects"
  section (create with Keep a local copy off; where things run; Download to…;
  what is absent and why), and `docs/help/sync.md` gets one line saying
  remote-only has no sync. `DOCUMENTATION.md` §"Remote, Sync, and Multi-Host"
  (`rg -n` line ~1322) gets one paragraph. The context doc and the filemap
  rows go in for `projectTabHost.ts` and `sidePanelViews.ts`.
- **Todo:** `todo/group-g-remote.md` gets a new `### G.27 — Remote-only
  projects` with 🤖 boxes per step, and 🖐️ boxes (each with the four-platform
  ✅/❌ pair: Linux (X11), Linux (Wayland), Windows, macOS):
  create New remote-only → no mirror folder appears, the tree is the host's
  with no Local switch; clone into remote-only → host tab clones; agent and
  shell tabs start on the host, the badge shows ☁ with no Local row; quit and
  relaunch → tabs reattach or resume on the host; disconnect (pull the
  network) → every pane holds, no freeze, Connect restores; Download to… a
  folder; the phone lists host tabs, opens host files, and its ＋ starts on the
  host; TeX Compile opens a host build tab and the PDF reloads; Stop keeping a
  local copy on a Remote → the folder is kept at the reported path, and Keep a
  local copy pairs it back.

## Organisation

**Shape:** the subsystems are disjoint once the contract above is fixed, and
the risky steps are security/invariant work. The plan itself fixes every
shared name (the field, the request key, the sentinel, the predicate, the new
commands' signatures), so the engine contract (A1) and the cockpit contract
(A2) start together; everything else waits only on the step whose code it
actually calls. Implementers work in worktrees
(`.claude/worktrees`, hardlinked `node_modules`). Steps marked **sec** get
independent finder + verifier reviewers with no shared context (the spawn
boundary, sync/lockstep, host git, and `mobile_control`); the others rely on
the final review.

*Build-heavy* = runs the cargo gates. At most 3 build-heavy steps and at most
5 subagents (implementers + reviewers) run at once; frontend steps run
`npm run build` and only their own test files, not the whole vitest suite,
until the final review.

| Agent step | Plan sections | Main files | Depends on | Kind |
|---|---|---|---|---|
| A1 engine contract **sec** | E1, E2 | `schema/project.rs`, `services/remote.rs` + `remote_sync.rs` (resolver), `services/launch_prep.rs`, `commands/projects.rs` (run host, worker strip, request field), `agent_host_move.rs` | — | cargo |
| A2 cockpit contract | F1 + `tabLocality` fixture | `src/lib/projectTabHost.ts`, `stores/tabs/tabLocation.ts`, the ~15 renamed call sites, `TabLocalityBadges.tsx`, `LocalityMenu`, `src/types/index.ts`, the fixture + its 3 readers | — | npm (+ one Rust test reader line) |
| A3 sync off **sec** | E3 (+ `git_peer` host-arm hardening) | `commands/sync.rs`, `services/git/git_peer.rs` + `commands/git_peer.rs`, `worker_sync.rs`, `sync_auto.rs`, `connect_host` | A1 | cargo |
| A4 git on host **sec** | E4 | `commands/git.rs`, `commands/git_publish.rs`, `git_hardened.rs`, `ssh_exec.rs` (`run_git_remote`) | A1 | cargo |
| A5 local-tree readers + export | E5 | `commands/project_transfer.rs`, the small reader sites, `commands/vm.rs`, the mirror commands in `commands/projects.rs` | A1 | cargo |
| A6 host search | E6a | `commands/search.rs`, `commands/fs.rs` (one fn), new `remote/host_search.rs` | A1 | cargo |
| A7 host creation + init | E6b | `commands/projects.rs` (create/import), new `remote/remote_scaffold.rs`, `ssh_exec.rs` (two helpers) | A1, A4 (both edit `ssh_exec.rs`; A7 rebases on A4) | cargo |
| A8 phone **sec** | E7, F8, `projectHostReach` rows | `mobile_control/discovery.rs` (+ tests), `headless.rs`, `mobile-web/` `NewTabSheet.tsx`, `MobileAccessPicker.tsx` | A1, A2 | cargo |
| A9 creation dialog + pill | F2, F3 | `ProjectDialog.tsx`, `ProjectPill.tsx`, `projectTypeTags.ts`, `ProjectExportDialog`, `RemoteMachinesWindow.tsx`, `ProjectSwitcher` | A2, A5 (`MirrorStatus`, export), A7 (create + init) | npm |
| A10 file panel | F4 | `ProjectFilesView.tsx`, `ProjectFilesPane.tsx`, `FileTree.tsx`, `sidePanelViews.ts`, `AppShell` rail, `GitHistory`, `QuickOpen`, `ContextFilePicker` | A2 | npm |
| A11 viewers + tabs | F5, F6, F7 (filters and gates only; no file gets a large change) | `TexView`/`TexWorkspaceView` (compile tab), the SQLite viewer gate, `ViewerHeader`, `NewTabMenu.tsx`, `TabBar.tsx`, `DetachedCenterPanel.tsx`, `PaneSlot.tsx` | A2 | npm |
| A12 conversion | E8, F9 | new `remote_unpair_mirror{,_preview}` (`commands/projects.rs` or a submodule), `set_remote_mirror_dir`, pill Edit group | A3, A5, A9 | cargo |
| A13 docs | F10 (help, `DOCUMENTATION.md` range, `todo/group-g-remote.md` G.27), E9 (context docs, filemap rows) | docs only | all others | light |

Suggested waves under the bounds: **W1** A1, A2. **W2** A3, A4, A5 (3 cargo)
+ A10, A11 (npm). **W3** A6, A7, A8 (3 cargo) + A9 once A5 and A7 are in.
**W4** A12, then A13 and the final review. Reviewers of a **sec** step start
when its implementer has finished and take freed slots; they count toward the
5, so a wave's later steps wait for them rather than exceed it.

The hot shared files are i18n (`en.ts`), `untested.ts`, `command_class` +
`commandClasses.ts`, `commands/projects.rs` (A1, A3, A5, A7, A12 each touch a
different function) and the filemaps. Parallel implementers list their
i18n/register/command-class edits in `docs/remote_only_projects_handoff.md`,
and the main agent applies them once at merge and regenerates
`commandClasses.ts` once. The final review covers the whole range:
cross-step integration, i18n keys, `UntestedTag` rows, filemap rows,
brand-check and privacy-check.

## Verification

- Each step: `scripts/gates.sh` for the gates its diff touches. The engine
  steps run `cargo test --workspace`, the daemon build test, the three clippy
  lines and `scripts/brand-check.sh` (the sentinel goes through
  `brand::UPPER` / `BRAND.upper`); the cockpit steps run `npm run build`
  (the only type-check; also covers `commandClasses.ts`), their own test
  files and `npm run lint`. After any backend edit, run
  `npm run backend:stale` and report it; never restart the app.
- Final review: `scripts/gates.sh --all`, and `scripts/ci-local.sh` once,
  because this touches ssh argv and `cfg`-free path code (its Windows and
  macOS checks are the only cross-OS signal before CI). Pushing follows the
  house push rule.
- Live QA, run by the user (the steps are the G.27 🖐️ boxes, F10): create a
  remote-only project on a key-auth host; check that no folder appears under
  `<state_dir>/remote-projects/<id>/mirror`; open shell + agent tabs (both on
  the host); commit and push from the git bar; search; Download-to; drop the
  connection and check that nothing freezes; convert to Remote and back,
  checking that the mirror folder survives with the path reported.
- Not run live by any agent. The user clicks through the G.27 list on the
  frozen dev build after commit.

## Plan review (2026-10-28)

Checked against the code at the same `develop` HEAD. What changed:

- **VM conversion out of v1.** E8's reverse paired through ordinary lockstep,
  which would land VM-written bytes on this machine; the VM plan requires a
  manual-pull-only mirror. Both conversions now refuse every VM, a VM's
  `remote_only` is never written, and `isHostPinned` stays one predicate.
- **Byte-sync choke point corrected.** `commands::sync::resolve` serves ten
  commands; five bypass it (three `sync.json` writers refuse;
  `sync_big_folders` / `sync_status` answer empty).
- **Missed mirror sites added:** `move_remote_mirror` / `set_remote_mirror_dir`
  (refuse, also fixing VMs; the reverse needs an explicit `keepLocalCopy`),
  `usage_stats::watch_root_for`, `commands::vm::has_mirror` (posture, fail
  closed), `git_publish::mirror_repo`, worker fan-out (`wants_code_fanout`,
  `add_compute_host`). Detach already refuses.
- **New sibling fixes:** `git_peer`'s `Peer::Remote` runs host git unhardened
  with hooks live (E3); `remote_mkdir_p` / `remote_git_init` unbounded (E6b);
  `TabHoverCard` and `useSessionPicker` unpinned (F1). The `run_git_remote`
  bound must take its timeout from the git args, not the ssh argv.
- **Contract fixes:** the creation key is top-level `req.remoteOnly` (the
  backend writes the spec field); search passes the project `directory` (not
  `projectId`) plus a new `relRoot`; `project_search` lives in
  `commands/search.rs`; host search and quick open go behind the HPC guard;
  there is no existing `_VM_DOWN` frontend mapping to reuse, so F1 adds one
  `remoteOnlyRefusal` mapper; a second shared fixture
  (`projectHostReach.fixture.json`) and reader (`MobileTabReach.test.ts`) were
  missing.
- **Creation order:** the host init is now called by the dialog after an
  awaited first connect and before the scaffold-fill agent tabs; clones never
  call it; VM creation does not adopt it (there is no in-guest scaffold to
  replace). D14's pre-tick is specified (password-less, VPN-less connect).
- **Conversion safety:** the preview also counts open local tabs (they would
  otherwise come back pinned to the host with a local session id) and names
  synced-copy workers; the fingerprint is defined; both commands are async
  over blocking bodies; no new `core_dispatch` row is needed.
- **Export:** `include_mirror` keeps its meaning; `MirrorSource::Local` is
  refused for remote-only (the names are `{Local, Host}`, and the VM test is
  `a_vm_project_is_blocked_up_front`).
- **Organisation:** 8 steps → 13 (A1/A2 engine and cockpit contracts in
  parallel; E3 and E4 separate, both security-reviewed; E6 split into search
  and creation; phone backend + UI together; F4 alone; docs last). A1 and A8
  join A3/A4 under finder + verifier review (spawn boundary, `mobile_control`).
- **Smaller corrections:** `pairing_conflicts` (not `pairing_conflict`), the
  F8 "decision 6" reference is D15, `RunHostPicker` (cockpit rule 3) and D9's
  creation warning now have an owning step (F1, F2), the duplicated verification paragraph was
  merged, the latexmk argv is spelled out (`-cd`, `./<rel>`), and the
  `vm_projects.md` `_VM_DOWN` claim is corrected in E9.
