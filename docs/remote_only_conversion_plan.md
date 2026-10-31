# Converting a project to Remote-only — Plan

Status: **plan only** (2026-10-29). Nothing is built. Code sites were checked
against `develop` at ab935481, which includes the remote-only work
(`docs/remote_only_projects_plan.md`, handoff
`docs/remote_only_projects_handoff.md` A12 + Final review).

## Why

The user: *"Is it also possible to convert a local/remote project to remote
only (put it to danger zone)"*.

Today the pill offers three of the four conversions:

| From → to | Pill row | Backend |
|---|---|---|
| Local → Remote | Edit · **Extend to remote…** | `extend_project_to_remote` (`commands/projects.rs` ~l.5204) |
| Remote → Remote-only | Edit · **Stop keeping a local copy…** (danger) | `remote_unpair_mirror{,_preview}` (`commands/remote_unpair.rs`) |
| Remote-only → Remote | Edit · **Keep a local copy…** | `set_remote_mirror_dir(keepLocalCopy: true)` |
| **Local → Remote-only** | missing | — |

The remote-only plan already settled how the missing one is built (E8, F9):
**Extend to remote, then Stop keeping a local copy. Never one step.** This
plan turns that into one guided flow and moves the two lossy conversions into
the pill's **Danger zone** (`pill.dangerZone`, `ProjectPill.tsx` ~l.2406).

### What the code does today (and what that means here)

- **Extend uploads nothing.** `extend_prepare_blocking` + `extend_finish_blocking`
  attach the spec, `mkdir -p` the host root (best effort), move `project.json`
  into `<state_dir>/remote-projects/<id>/` and record the project's own folder
  as an **explicit** `mirror`, in place. For a git project it seeds a commit
  when HEAD is unborn and turns lockstep on.
- **Committed history** reaches the host through lockstep's first pass
  (`git_peer::init_pairing`): a `git bundle` of `--branches --tags`, `git init`
  plus `reset --hard` on the host, `origin` copied over. `pairing_conflicts`
  refuses when the host already holds *differing* files. The flow can run it at
  once with `git_peer_sync_now`, which returns the `GitPeerState`
  (`status`, `detail`, `pairingConflict`).
- **Everything else** goes up only through a manual byte push:
  `sync_push(projectId, "", force: false)`, priced first by
  `sync_transfer_preview(direction: "push")`. It walks the mirror
  (`remote_sync::walk_mirror_files`), drops excluded folders and (with
  lockstep on) tracked files, and **ignores `.gitignore`**, so untracked *and*
  ignored files go up. It never sends `.git`, `.tabtivity`, symlinks, nested
  repos or linked worktrees (a dir with a `.git` entry), special files or
  files over the cap. A host file that has no manifest base comes back as a
  conflict and is never overwritten.
- **Stop keeping a local copy** then refuses while commits, `git status`
  entries (untracked included), unpushed byte-sync edits or local tabs remain.
  The Final review found two gaps that matter more here:
  1. For a non-git mirror, files that were never byte-synced block nothing.
  2. Gitignored files are not counted at all.

  Extend + Stop as they are would therefore leave a non-git project's whole
  tree, and every ignored file, only on this computer, without saying so. A
  third gap goes the other way: an untracked file that *was* byte-pushed
  still counts as `uncommitted`, so Stop can never finish for a git project
  with untracked files.
- **The folder stays where it is.** After extend the mirror is the project's
  own folder, an explicit path outside the state dir. `kept_destination`
  therefore leaves it in place (`moves: false`), which is D8. It ends up a
  plain folder with `.git` and without `project.json` (extend moved that out).
  Re-importing it later starts a new project.

## Fixed decisions

1. **One flow built from the existing steps, no new conversion command.**
   The states between the steps are the existing durable kinds: Local, Remote
   (folder kept as mirror), Remote-only. Each is complete and consistent on
   its own. The flow is a dialog that works out its next step from the
   backend each time (is it remote, is it connected, the lockstep state, the
   unpair preview). Closing it, a failure or a crash therefore always leaves a
   project of a known kind, and reopening the Danger-zone row picks up at the
   right step. A dedicated backend command was rejected: it would duplicate
   lockstep, byte-push and the fingerprinted commit, and it cannot move tabs
   (the window owns the PTYs).
2. **Stop keeping a local copy… becomes the finisher for both conversions.**
   Today its dialog only refuses. It gains buttons for the blockers it can
   clear itself: **Send commits** (`git_peer_sync_now`), **Upload N files
   (size)** (`sync_transfer_preview` → `sync_push("")`) and **Move N tabs to
   the host** (`switchTabLocation` per tab; local-model tabs are closed after
   one line, D11). Uncommitted *tracked* changes, and linked worktrees with
   uncommitted changes, get no button ("commit them first"): nothing is ever
   committed for the user. This is the existing dialog extended, not a second
   one (`feedback_no_redundant_variants`).
3. **Local → Remote-only = Extend to remote's dialog in a `remoteOnly` mode,
   which then hands off to Stop.** `ExtendToRemoteDialog` keeps its
   connect/browse/details steps. In this mode it:
   - requires an empty or absent host folder;
   - awaits the connect instead of firing and forgetting it;
   - pins the project's live agent/shell tabs that have no `location` to
     `"local"`, because they really run here, so that the counts see them;
   - opens `StopLocalCopyDialog` with `origin="local"`. Same copy rules, but
     the wording says the folder stays at its path as a plain folder, no
     longer the project.
4. **The preview counts what the push would send and what it never will.**
   New `UnpairPreview` fields (camelCase on the wire):
   - `filesNotOnHost` / `filesNotOnHostBytes` (blocker): files the push
     would send that have no in-step manifest record.
   - `dirtyWorktrees: string[]` (blocker).
   - `leftBehind` (listed, not blocking): `{ excludedFolders: string[],
     symlinks, nestedRepos: string[], unpushable, sample: string[] }`.

   An untracked `git status` entry no longer counts as `uncommitted` when its
   manifest record is in step. All of this goes into the fingerprint. One rule
   for both conversions, so it also fixes the two Final-review gaps above.
5. **Refusals** (in `unpair_refusal` and the extend mode's precheck): VM
   (already), a reserved scope (`storage::is_reserved_scope`, the pill never
   shows for root/assistant, the backend still refuses), and a project whose
   container is on (`sandbox.enabled`, see Open decision 3).
6. **Danger zone placement.** **Move to the host only…** (Local →
   Remote-only, new) and **Stop keeping a local copy…** (moved out of Edit)
   sit in the Danger zone, beside Detach SSH host…, with
   `className="untested danger"`. **Keep a local copy…** stays in Edit beside
   **Extend to remote…**. Both are additive: they add a copy and never remove
   one, and nothing is lost if the user regrets it, so they are not dangerous.
   The rows reuse the existing context-menu group markup. No new UI treatment.
7. **Nothing on disk is deleted or moved by this flow.** The folder is never
   deleted (D8). For Local → Remote-only it is not moved either: it was never
   inside the state dir.
8. **Foreground only.** Every step runs from a click in the open dialog:
   `remote_connect` with `background: false`, manual `sync_op` locks. No
   background step can prompt (password hosts authenticate in the dialog's
   session, as Extend does today). OpenVPN stays `VpnIndicator`'s, reached
   through `RemoteProjectSection` as in Extend.

## What happens to each piece of state

| Thing | Outcome |
|---|---|
| Registry, `project.json`, time tracking, notes, categories, boxes | Same id. `project.json` moves into the state dir (extend). Box membership stays; `box_store::compute_box_allowed_roots` already skips a remote-only member. A kept folder inside a box's own `folder` stays visible to box agents as plain files, and the confirm says so. |
| Claude agent tabs | Moved by `agent_host_move::move_session` (copy; the local transcript stays in the agent home). |
| Other agent CLIs | Start a new conversation on the host (`Moved::Fresh`). The confirm names them. |
| Shell tabs | Respawn on the host (`setTabLocation`). Shell history is not carried. |
| Local-model (`local_agent`) tabs | Closed after one confirm line (refused on remote-only, D11). |
| Viewer tabs with a path in the folder | Retargeted to the host path with `retargetTabs` if the remote-only viewers address host files that way (the step verifies this). Otherwise closed. This also fixes the Final-review flag for Stop. |
| Linked worktrees (`.tabtivity/worktrees/…`) | Branches travel with lockstep. Uncommitted work in a worktree blocks; clean ones are listed under `leftBehind`. |
| `local_loss.json` | Survives (`clear_host_bound_files` keeps it). |
| `exec_trust` approvals | Keyed by folder. They no longer apply; host git runs hardened on the host. Nothing to migrate. |
| Container (`sandbox`) | Refused while on (Fixed 5). |
| HPC-tagged host | Allowed. The confirm repeats `projectDialog.remoteOnlyHpcWarning` and shows the upload size. Every step is foreground (D9). |
| Phone (`mobile_control`) | No change: the phone already reads the posture (A8) and offers no conversion. The step checks that the phone's project list picks up the new kind, as for Stop. |

## Failure states (all leave a known kind)

| Fails at | Project is | The dialog says |
|---|---|---|
| Extend prepare (refused, unreadable `project.json`) | Local, untouched | the error |
| Connect after extend | Remote, disconnected | "Now a Remote project; your files are untouched at `<path>`. Connect, then finish with **Stop keeping a local copy…**" (`pill.toRemoteOnlyHalfway`) |
| Lockstep seed (`pairingConflict`, transfer error) | Remote | lockstep's `detail`; pairing conflicts go to the existing `git_peer_pair_confirm` card |
| Upload: some files failed or conflicted | Remote, pushed files recorded | failed sample + Retry (sends only the rest) |
| A tab move fails | Remote; that tab respawned where it was | which tab; the count stays |
| Unpair: `_MIRROR_CHANGED` or blocked | Remote | re-preview (existing) |

## Steps

**S1 — preview and refusals (engine).** `commands/remote_unpair.rs`:
- Add a bounded mirror scan next to `preview_blocking`, using the walk rules of
  `remote_sync::walk_mirror_files`. If the rules cannot be shared, add a
  tally-collecting variant there; never a second copy of them. The scan
  prunes excluded folders, subtracts `git_peer::tracked_paths` when lockstep
  is on, and fills `filesNotOnHost`/`Bytes` and `leftBehind`. Over a cap
  (200 000 entries) it refuses with "too many files to check; exclude big
  folders first" (refuse when in doubt).
- Make `porcelain_z_entries` return paths, so in-step untracked entries can be
  subtracted.
- Fill `dirtyWorktrees` from `git worktree list --porcelain` plus a hookless
  status per linked tree.
- Extend `blocked()` and the fingerprint.
- Add the `sandbox.enabled` and reserved-scope refusals to `unpair_refusal`.
- Check whether `tab_runs_here` misses a kind that can run locally on a plain
  Remote project (a run tab on a `"local"` run host); extend the rule if so.
- Sibling check: whether `push_file_atomic` keeps the executable bit. Fix it
  in this step if not (house rule).

*Tests*: a non-git mirror with an unsynced file blocks; a byte-synced
untracked file no longer counts; an ignored file counts in `filesNotOnHost`;
symlinks, nested repos and excluded folders land in `leftBehind`; a dirty
worktree blocks; a container project and a reserved id are refused; the scan
cap; the fingerprint changes with the new counts; the existing 12 tests stay
green. Run `npm run backend:stale` after.

**S2 — the finisher dialog (cockpit).** `components/projects/LocalCopyDialogs.tsx`
(`StopLocalCopyDialog`, `unpairBlocked`), `stores/agents/agentLocationSwitch.ts`,
`stores/projects.ts`, `src/types/index.ts` (`UnpairPreview`):
- The three helper buttons of Fixed 2, each re-running the preview after it.
  The upload uses the transfer preview's count and bytes and opens
  `BigFolderExcludeDialog` (`useBigFoldersStore.openOnce`) before it. It never
  sends `force`. Conflicts are shown, never overwritten.
- The `leftBehind` list with paths (sample) and the kept path.
- `origin="local"` wording.
- `switchTabLocation` and `setTabLocation` act on the active scope. The
  helper either runs only when the project is the active scope (switching to
  it first) or gains scope-aware variants (`relaunchTabInScope` already
  exists). The step picks one and says which.
- Viewer-tab retarget or close (the table above).

*Tests* (`ProjectPillLocalCopy.test.tsx` + a new `StopLocalCopyHelpers.test.tsx`):
each helper calls its command and re-previews; `force` is never sent; local
model tabs are closed only after the confirm line; a failed tab move keeps the
count.

**S3 — Local → Remote-only flow + pill rows.** `components/projects/ExtendToRemoteDialog.tsx`
(`remoteOnly` prop; title/lede; empty-host check through the browse
session's `ssh_list_dir`, or after extend over the pooled SFTP on the Windows
`winManual` path, where lockstep's `pairing_conflicts` and the push conflicts
are the backstop; awaited connect with the existing retry loop; live
unlocated tabs pinned `"local"`; hand-off), `components/projects/ProjectPill.tsx`
(Danger zone: new **Move to the host only…** on `!project.remote` non-VM
projects, enabled always since the dialog connects; **Stop keeping a local
copy…** moved here, still disabled until connected; Keep stays in Edit). VM
and container rows: hidden or disabled with the refusal as title.
*Tests*: the rows sit in the Danger zone, Keep in Edit; the mode refuses a
non-empty host folder; a failed connect shows the halfway message and leaves
the project Remote; the hand-off opens Stop with `origin="local"`.

**S4 — strings, register, docs, todo.**
- i18n, en plus the four others, one block after the `pill.stopLocalCopy*`
  keys: `pill.toRemoteOnly{Ellipsis,MenuTitle,Halfway}`,
  `extendRemote.remoteOnly{Title,Lede,HostNotEmpty,Confirm}`,
  `pill.stopLocalCopy{FilesNotOnHost,UploadFiles,UploadBusy,SendCommits,MoveTabs,MoveTabsFresh,CloseLocalModels,DirtyWorktrees,LeftBehind,LeftExcluded,LeftSymlinks,LeftNested,LeftUnpushable,KeptPlainFolder,BoxFolderNote,Sandbox}`.
  The app name only via `{app}`.
- `src/lib/untested.ts`: a new row `pill.toRemoteOnly` (projects · Local
  project · Move to the host only…: extend, seed, upload, move tabs, stop
  keeping the folder; the folder stays in place). Update the `pill.stopLocalCopy`
  "what" for the helpers and the Danger zone. Run `npm run untested -- list`.
- `docs/help/remote-projects.md` § Remote-only projects: one paragraph on
  the Local → Remote-only flow, the Danger zone location, what is uploaded and
  what stays.
- `docs/context/remote_projects.md`: two lines.
- Filemap rows: `LocalCopyDialogs.tsx`, `ExtendToRemoteDialog.tsx`,
  `remote_unpair.rs`.
- `todo/group-g-remote.md`: new `### G.28 — Converting to Remote-only`
  (`docs/remote_only_conversion_plan.md`), with 🤖 boxes per step and 🖐️
  boxes, each with the ✅/❌ pair for Linux (X11), Linux (Wayland), Windows
  and macOS:
  - a git Local project → Move to the host only: commits, untracked and
    ignored files reach the host; the folder stays at its path, not
    registered;
  - a non-git Local project → the whole tree is uploaded, and the size is
    shown first;
  - open Claude, Codex and shell tabs → each lands on the host (Claude resumes
    its conversation);
  - pull the network mid-upload → the project is Remote, the dialog says so,
    and reopening the row finishes the job;
  - a password-auth host and an HPC-tagged host → no prompt outside the
    dialog;
  - Stop keeping a local copy on a Remote project with unsynced files → the
    Upload button clears the block.

## Verification

- S1: `scripts/gates.sh` (cargo test, the daemon build, the three clippy
  lines, brand-check), then `npm run backend:stale` and report it. Never
  restart the app.
- S2/S3: `npm run build`, their own test files, `npm run lint`.
- Final review: `scripts/gates.sh --all`, and `scripts/ci-local.sh` once
  (the walk is path code, and the Windows local side is new to this flow).
  `scripts/privacy-check.sh` before any push.
- Live: by the user only, through the G.28 🖐️ list on the frozen dev build.
  No agent runs it live.

## Organisation

**Shape:** a short chain. S1 fixes the contract (the `UnpairPreview` fields
above are final), so S2 can start against the TS type while S1 builds. S3
needs S2's dialog. S1 is data-loss gating, so it gets an independent finder +
verifier review. Worktrees under `.claude/worktrees` with hardlinked
`node_modules`. At most 5 subagents at once.

| Agent step | Sections | Main files | Depends on | Kind |
|---|---|---|---|---|
| C1 preview + refusals **sec** | S1 | `commands/remote_unpair.rs`, `services/remote/remote_sync.rs` (walk tally, push mode) | — | cargo |
| C2 finisher dialog | S2 | `LocalCopyDialogs.tsx`, `agentLocationSwitch.ts`, `stores/projects.ts`, `types/index.ts` | contract (C1 for the live run) | npm |
| C3 local flow + pill | S3 | `ExtendToRemoteDialog.tsx`, `ProjectPill.tsx` | C2 | npm |
| C4 docs + register | S4 | i18n ×5, `untested.ts`, help, context, filemaps, `todo/group-g-remote.md` | C1–C3 | light (main agent at merge) |

Waves: **W1** C1 + C2. **W2** C1's reviewers + C3. **W3** C4, then the final
review (cross-step integration: the TS ⇄ Rust preview fields, `blocked()` ⇄
`unpairBlocked`, i18n keys used, untested register, brand-check, privacy).
Each step is one subsystem, ≤ ~1 day, ≤ 3 large files.

## Decisions (answered by the user, 2026-10-29)

1. **What goes up besides commits:** everything not in an excluded folder,
   gitignored files included, with the size shown first. The big-folder
   prompt catches `.venv`/`target`.
2. **Things the push can never send** (symlinks, nested repos, excluded
   folders, oversized files): listed in the confirm, never blocking. The folder
   stays in place, so nothing is lost.
3. **A project with its container on:** refused until the container is turned
   off.
4. **The halfway state** (Remote, conversion not finished): no marker. The
   dialog says what is left, and the Danger-zone row resumes. *(Not asked:
   decided per the recommendation. Remote is a complete kind, so one state
   machine is enough.)*
5. **The new row's label:** "Move to the host only…".
