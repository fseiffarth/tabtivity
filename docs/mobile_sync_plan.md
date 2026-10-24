# Remote project sync on the phone — Plan

Status: **proposed, 2026-10-23. Nothing here is built.** Gives a paired phone
the sync controls the desktop side panel has for a remote (SSH) project:
connection state, Sync all / Push all, per-file and per-folder sync, the
Diverged list and the git lockstep bar. Every action rides the desktop
window's existing connection pool and the existing `sync_*` / `git_peer_*`
commands; the phone gets no new power the desktop does not already have.

Related: `docs/mobile_every_project_type_plan.md` (phase 1 put remote
projects on the phone, mirror only) and `docs/mobile_remote_projects_plan.md`
(remote tabs; its R6 "read-only host browsing" is replaced by P3 here, which
goes through the window instead of the sidecar).

## Where it stands

### Desktop (what the phone should match)

Line numbers are from 2026-10-23; verify before relying on them.

- **Remote is decided by the record.** UI: `!!project.remote`
  (`ProjectFilesPane.tsx` ≈701, `FileTree.tsx` ≈1009). Backend:
  `commands::sync::resolve` (`sync.rs` ≈190) → `remote_target_for`, then the
  pooled SFTP or "remote project not connected — reconnect first". Writers
  take `sync_op::acquire(project_id)`.
- **Connection gate.** `useRemoteStatusStore.byProject[id].ssh`
  (`off|connecting|connected|error`); `useRemoteBlocked` = remote and not
  `connected`. Needs the pool: `sync_pull`, `sync_whole_project`,
  `sync_push`, `sync_auto_preview`, `sync_file_meta`,
  `sync_resolve_if_identical`, `sync_apply_delete`, `sync_transfer_preview`.
  Work offline (manifest only): `sync_mark_selected`, `sync_set_auto`,
  `sync_set_excluded`. `sync_status` falls back to stored bases when cold.
- **Local | Remote switch** (`FileSourceSwitch`, `ProjectFilesPane.tsx`
  ≈143): Remote = the host over SFTP with sync badges, Local = the mirror.
  The default follows the lamp once (`connected` → Remote), and a click is
  remembered per project (`stores/remote/fileSourcePref.ts`). Disconnected on
  Remote → placeholder + **Connect** (opens `RemoteMachinesWindow`). ⏻
  **Logout** while connected (`remote_disconnect_all_hosts`).
- **Whole-project row** (`ProjectFilesPane.tsx` ≈783–887, connected only):
  Auto-sync all (`sync_set_auto` on `""`), Large folders…, live `done/total`
  (`sync-progress` event), **Sync all** (Remote side: `sync_whole_project`;
  Local side: `sync_push {relPath:"", force:false}`), each behind
  `confirmSyncTransfer`; result line with `SyncSkippedLarge` (64 MiB cap),
  pushed / conflicts / failed / excluded counts.
- **Per row and folder** (`FileTree.tsx` ≈481–581, ≈3853–3954, menu
  ≈4784–4927): badges none / green / amber / localnew / excluded / auto.
  Actions: Sync to local (`sync_pull`), Push to host (`sync_push`), Stop
  syncing (`sync_mark_selected false`), Auto-sync on/off (`sync_auto_preview`
  above 200 files or 100 MB asks first, then `sync_set_auto`),
  Exclude/Include (`sync_set_excluded`), Download excluded (`sync_pull`),
  Push all (Local root menu).
- **Push conflicts** (`FileTree.tsx` ≈3165–3200, ≈5094–5146): one modal per
  conflicting file: Skip / Take host (`sync_pull`) / Keep local (`sync_push
  force:true`) / Skip all.
- **Transfer confirmation** (`stores/remote/syncConfirm.ts`,
  `common/SyncConfirmDialog.tsx`): `sync_transfer_preview {projectId,
  relPath, direction, force, relPaths}` → files, bytes, overwrites,
  destructive names, conflicts, tracked, exact. Zero files → Cancel only.
  Delete variant priced by `sync_file_meta`. Second ask while open → no.
- **Diverged view** (`ProjectFilesView.tsx` ≈2073–2458): amber + new-local
  lists; cue Remote newer / Local newer / Both changed / Remote only / Local
  only / Gone on both. Per file: Take remote, Keep local (both `force`),
  Delete other copy (`sync_apply_delete {side}`), Forget. Bulk: Take remote
  for all, Keep local for all, Upload all new (`resolveAll`). Merge viewer
  `SyncMergeView` (`CompareView`, per-block) and `sync_resolve_if_identical`
  on open.
- **Git lockstep bar** (`GitHistory.tsx` ≈1199–1355): `git_peer_status` +
  `git-peer-status` event; On/Off, Local wins (danger confirm), Sync
  now/Retry, Use local / Use remote (danger), Overwrite & pair (danger),
  Resolve in terminal, Backups / Restore (danger).
- **Large folders** (`projects/BigFolderExcludeDialog.tsx`):
  `sync_big_folders {projectId, scanHost, confirmed}`, size table, Apply →
  `sync_set_excluded`.
- **Local loss** (`stores/localLoss.ts`, `LocalLossDialog.tsx`): backend
  writers record through `services::local_loss`; refreshed on sync events.

### Phone today

- One folder per project: a remote project's mirror (`discovery.rs`
  `mobile_root` ≈920). `folder: false` before the first sync. Files drawer
  (`components/ProjectFiles.tsx` → `FilesLibrary.tsx`): list, search, view,
  add-only "Upload here", behind `project_files` / `project_uploads`.
- `screens/GitSheet.tsx`: read-only overview of the mirror's repo.
- `screens/Project.tsx` shows one fixed line for a remote project
  (`mobile.project.hostRemote`).
- No connection state, no Remote side, no pull/push. `DesktopRequest`
  (`protocol.rs`) and `host.rs`'s `router()` have no sync or remote kind.

### Constraints that shape the design

- `services::mobile_control`: raw project ids, paths, commands and tmux
  targets never cross the browser API. Projects are opaque HMAC ids; files
  are sealed tokens bound to the raw project id (`files.rs` `seal`/`unseal`).
  Sync rel paths and phone tokens share one namespace (both relative to the
  mirror root, `remote_sync::mirror_dir`), so existing tokens can name sync
  targets.
- The SSH pool, sync manifest, auto-sync and git_peer registries live in the
  desktop process. The sidecar cannot run a transfer; with no window there is
  nothing to sync with.
- The phone never calls Tauri commands; `command_class` governs the browser
  desktop client, not the phone. Raw-id commands stay unreachable from it.
- Remote auto-connect never prompts (`docs/context/remote_autoconnect.md`);
  passwords are never persisted by default.

## Decisions to confirm

1. **Connect from the phone.**
   - (a) *Never* (matches `mobile_remote_projects_plan.md` decision 2): the
     phone shows the lamp and "Connect on the desktop".
   - (b) *Promptless only*: the phone's Connect uses the eligibility rule
     the desktop's silent auto-connect uses (`stores/projects.ts`
     `autoConnectRemote`: a host recorded `key_auth`, or a saved SSH password
     via `savedPasswordState`), probes with `ssh_probe`, then
     `remote_connect`. Not eligible, or the host needs a tunnel that is not
     up → "connect on the desktop". Never a prompt, never a password over
     the phone, never brings up OpenVPN.
   Recommended: (b), behind its own sub-switch, so (a) is the default.
2. **The Remote side in Files (P3).** Build it, or keep the phone on the
   mirror with sync actions only. Recommended: build it, after P2.
3. **First delivery.** Recommended: P1 + P2; P3–P5 follow as separate
   changes.
4. **Desktop fixes first** (see "Desktop issues found"). Recommended: yes,
   as P0, so the phone does not copy them.
5. **Consent.** A new host-wide switch `project_sync` beside `project_files`
   / `project_uploads` (`tabtivity_mobile_host`, default off, read per
   request), plus the project's Mobile switch and per-phone list as today.
   With the switch off every sync route answers 403 `sync_disabled` before
   any desktop call. Recommended as stated.

## Design

### Shape of one action

```
phone (api.ts)          GET/POST /api/v1/projects/{opaqueId}/sync/...   (tokens only)
sidecar (host.rs)       auth → catalog → project_sync switch → remote? → unseal tokens
                        → admin::desktop_call(DesktopRequest::Sync…)     (raw id + rel)
window (MobileBridgeHost.tsx)
                        → invoke("sync_*" | "remote_*" | "git_peer_*")   (existing commands)
sidecar                 rel paths in the answer → sealed tokens + trail; errors → fixed codes
```

- **No new Tauri commands**, so no `command_class` rows and no
  `commandClasses.ts` regeneration.
- **No window → 503 `desktop_unavailable`**, no headless fallback (as
  `local_models.rs`). The phone says "Open the desktop app to sync".
- **Not remote → 404** (indistinguishable from an unshared project). A box
  scope is refused in this plan (the desktop's row is hidden in boxes too).
- **Answers never carry a path.** A file outside the browsed folder is a
  `files::Hit` (token + `trail` of folder crumbs), the shape search already
  uses. Desktop error strings are mapped to fixed codes (`not_connected`,
  `busy`, `conflict`, `too_large`, `failed`) in the sidecar, as
  `local_models.rs` allow-lists its refusals; `first_error` text is not
  forwarded.
- **Gates live in the window too.** `MobileBridgeHost` re-checks the project
  is remote and, for pool verbs, that `ssh === "connected"`, and answers
  `not_connected` without invoking. Nothing on the phone path ever dials,
  except P1's Connect under decision 1(b).
- **Each mutation is a `DesktopRequest` with `is_mutation() == true`**, so
  the existing audit and `device_id` stamping apply. A mutation pokes other
  windows the way the desktop's own does (status refresh, `sync-progress`).

### New `DesktopRequest` kinds

| Kind | Mutation | Window calls | Answer |
|---|---|---|---|
| `SyncState { project, dir: Option<rel> }` | no | `remoteStatus` store, `sync_status`, `progressByProject`, last outcome | `connection`, `auto_all`, `progress {done,total}?`, `diverged`, `new_local`, `last?`, `rows` for `dir`'s direct children (`state`, `auto`, `excluded`, `selected`) |
| `SyncPreview { project, direction, rel, is_dir, rels?, force, delete_side? }` | no | `sync_transfer_preview` / `sync_file_meta` | counts, `destructive` (≤ 50 `Hit`s + total), `conflicts`, `tracked`, `exact` |
| `SyncRun { project, op, rel?, rels?, force }` (`op`: `pull`, `pull_all`, `push`, `push_all`, `take_host`, `keep_local`, `delete_host`, `delete_local`, `forget`) | yes | `sync_pull` / `sync_whole_project` / `sync_push` / `resolveAll` / `sync_apply_delete` / `sync_mark_selected` | `accepted { job }` at once (see Jobs) |
| `SyncMark { project, rel, kind: auto\|excluded\|selected, on, is_dir }` | yes | `sync_set_auto` / `sync_set_excluded` / `sync_mark_selected` (offline-capable) | the refreshed row |
| `SyncAutoPreview { project, rel }` | no | `sync_auto_preview` | files, bytes |
| `SyncJob { project, job }` | no | the window's job table | `running {done,total}` / `done { outcome }` |
| `RemoteConnect { project, action: connect\|logout }` (P1, decision 1) | yes | eligibility check, `ssh_probe`, `remote_connect` (background: false, password: None) / `remote_disconnect_all_hosts` | new `connection` |
| `RemoteList { project, dir }` (P3) | no | `list_dir` on the host + `sync_status` | `files::Listing`-shaped rows + sync state |
| `GitPeer { project, action }` (P5) | per action | `git_peer_*` | status, pairing/desync payload with paths as `Hit`s |
| `BigFolders { project, measure_host, apply? }` (P5) | apply only | `sync_big_folders`, `sync_set_excluded` | size table rows as `Hit`s |

`rel` here is always the raw relative path the sidecar unsealed; the phone
only ever sent its token.

### Jobs (long transfers)

Sync all can outlast the bridge's request deadline. `SyncRun` answers
`accepted { job }` after starting the transfer in the window
(`MobileBridgeHost` holds a small per-project job table, one running job per
project, mirroring `sync_op::acquire`). The phone polls `SyncJob` every 1 s
while its sheet is open, 5 s otherwise, and stops on `done`. Progress comes
from the existing `sync-progress` event. The outcome keeps the desktop's
fields: pulled/pushed counts, `conflicts` (as `Hit`s, feeding the conflict
sheet), failed count, `skipped_excluded`, `skipped_too_large` (`Hit`s). A
window reload drops the table; the phone then sees `unknown_job` and
re-reads `SyncState`. A second `SyncRun` while one runs → 409 `busy`.

### Confirmations

The phone mirrors `SyncConfirmDialog`, as a bottom sheet on `ConfirmSheet`:

1. Phone asks `SyncPreview`, shows the sheet with "N files, X MB, M
   overwritten" plus the destructive names (folded beyond three), conflicts,
   tracked count, and the not-inspected note when `exact` is false.
2. Zero files → Cancel only. A failed preview still shows the sheet and needs
   the tap.
3. On yes → `SyncRun`. The preview does not bind the run (same as desktop).

Delete-other-copy uses the delete variant and its "last copy" wording. Git
lockstep danger actions use the desktop's danger texts. HPC/careful hosts:
Connect and Measure host show an extra "this is an HPC host" line
(`confirmOnHpcHost`'s text) before running.

## Phases

### P0 — Desktop fixes (optional, decision 4)

- Local tree while disconnected: gate the ⬆ buttons and "Push all to host" on
  connected (`FileTree.tsx` `remoteBlocked` is false for a Local tree today).
- "Auto-sync all" gets the `sync_auto_preview` size check like a folder.
- "Upload all new" asks without `force` but `resolveAll(…,"local")` pushes
  with `force:true`: make them agree (no force for new files).
- Show "Auto-sync all" while disconnected (`sync_set_auto` works offline),
  hide only the transfer buttons.

### P1 — Connection state (and Connect)

- Sidecar: `GET /sync/state` → `SyncState` (no `dir`). Route guard order:
  auth, origin, catalog, `project_sync` switch, remote, window.
- Phone `screens/Project.tsx`: the remote line becomes a row with the lamp
  (off / connecting / connected / error), the diverged + new-local count as a
  chip, and the last result. Polled on open and on focus, 15 s while visible
  (none on a careful/HPC host: on open and on pull-to-refresh only, like the
  desktop's tick rule).
- Connect / Logout per decision 1, `POST /sync/connect`.
- Settings → Mobile: the `project_sync` switch with one line ("A phone can
  pull and push between this computer and the remote host"), and the Connect
  sub-switch if 1(b).
- Tests: switch off → 403 before any desktop call; local project → 404; no
  window → 503; a `SyncState` answer holds no raw id or path (the existing
  `host.rs` leak test pattern); Connect refused when a password would be
  needed, with no `remote_connect` invoke (bridge test).

### P2 — Whole project

- Phone: on the remote row, **Sync all ↓** (host → this computer) and **Push
  all ↑** (this computer → host), each preview → sheet → `SyncRun` → job
  progress → result line (counts, skipped-large names, conflicts).
- Push conflicts open a per-file sheet: Take host / Keep local / Skip / Skip
  all (`SyncRun take_host|keep_local` on one token, no second preview; the
  sheet is the confirmation, as on the desktop).
- **Auto-sync all** toggle (`SyncMark` on the root, size-checked if P0 lands).
- Refused with a clear line while not connected; never dials.
- Tests: job lifecycle (accepted → running → done, `busy`, `unknown_job`);
  outcome conflicts come back as tokens that unseal to the right rel; force
  never set by the phone for a plain push; phone component tests for the
  sheet (zero files → Cancel only).

### P3 — Local | Remote in Files

- `FilesLibrary`: a Local | Remote switch on a remote project, default as the
  desktop (Remote when connected, remembered per project in phone prefs by
  opaque id).
- **Remote** lists through `RemoteList` (window `list_dir` on the host,
  sealed in the sidecar with the same key and namespace). Viewing a host file
  that is not in the mirror offers "Sync to local" first; no direct host
  file streaming in this phase. Disconnected → placeholder (+ Connect if
  allowed).
- **Local** stays the sidecar-answered mirror listing.
- Both sides: a sync badge per row from `SyncState { dir }`, one call per
  folder shown (never per row).
- Long-press menu: Sync to local, Push to host, Stop syncing, Auto-sync
  on/off (`SyncAutoPreview` above 200 files / 100 MB asks first), Exclude /
  Include (folders), Download (stays excluded). Folder header: the folder's
  own slot (↓ / ⬆ / ✓ / ±).
- Tests: a host listing never yields a token outside the project (links and
  `..` refused as `files.rs` does); excluded nearest-marker rule matches
  `isPathExcluded`; switch remembered per project.

### P4 — Diverged

- Phone sheet "Diverged (N)" from the remote row: amber files and new local
  files as `Hit`s with the desktop's cue words.
- Per file: Take remote, Keep local, Delete other copy (one side gone; the
  mirror copy only when `hostChecked`), Forget (gone on both). Bulk: Take
  remote for all, Keep local for all, Upload all new. All behind the preview
  sheet with `rels`.
- Opening a diverged file runs `sync_resolve_if_identical` first (heals
  identical bytes), then shows the local copy in the phone viewer with a
  "Merge on the desktop" note. No per-block merge on the phone.
- Tests: Delete-other-copy refused without `hostChecked`; bulk with `rels`
  previews exactly those files.

### P5 — Git lockstep and Large folders

- Phone Git sheet, remote project: the lockstep line (synchronized / syncing
  / desynchronized / disconnected), On/Off, Sync now/Retry, Local wins,
  Use local / Use remote, Overwrite & pair. Danger confirmations with the
  desktop texts; pairing conflict paths as `Hit`s.
- Desktop-only: Backups / Restore and "Resolve in terminal" (a remote
  project offers no phone shell). The phone says where to do them.
- Large folders sheet: both-sides size table (Measure host confirms on an HPC
  host), Apply.
- Tests: each danger action needs the confirmed flag in the request
  (sidecar refuses without it); git_peer status answers carry no path.

## Out of scope

Per-block merge (`CompareView`) on the phone; worker-host sync toggles
(`RemoteMachinesWindow`); "Download to…" outside the mirror; box scopes;
container and VM projects; OpenVPN; any headless sync without a window;
remote tabs (`mobile_remote_projects_plan.md`).

## Strings, untested tags, docs

- Every string through `src/lib/i18n.ts` (`mobile.sync.*`), English holds all
  keys; the phone's existing words where they exist (Pull/Push etc. stay the
  desktop's terms "Sync to local" / "Push to host").
- `UntestedTag` rows in `src/lib/untested.ts`: `mobile.sync.state`,
  `mobile.sync.whole`, `mobile.sync.files`, `mobile.sync.diverged`,
  `mobile.sync.lockstep` (one per phase), plus `desktop.sync.p0` if P0 lands.
- Update `docs/context/mobile_access.md` (what a phone may do to a remote
  project) and `docs/context/mobile_sidecar.md` (new `sync.rs` routes, no
  headless fallback); filemap rows for any new or reshaped file
  (`mobile_control/sync.rs`, `lib/mobileSync.ts`, the phone sheets).
- `todo/group-h-crossplatform.md`: one 🖐️ QA box per phase with the four
  platform children.

## Verification

- Gates: `scripts/gates.sh` (build, tests, clippy, the daemon build since
  `mobile_control` is in it), `npm run mobile:bundle`. Backend changes need
  `npm run backend:stale`; the phone half fails until the running window has
  the backend half.
- Live (the user, needs a real host):
  1. `project_sync` off → the phone shows no sync row. On → the lamp matches
     the desktop's; disconnect on the desktop → the phone shows off within
     one poll.
  2. Change a file on the host, **Sync all ↓** on the phone: the sheet names
     it as an overwrite; after yes the desktop tree shows it green.
  3. Edit the same file on both sides, **Push all ↑**: the conflict sheet
     opens; Take host / Keep local each end green on the desktop.
  4. Close the desktop window: every sync action answers "open the desktop".
  5. (1b) A key-auth host: Connect from the phone works; a password host
     says "connect on the desktop" and no prompt appears anywhere.
