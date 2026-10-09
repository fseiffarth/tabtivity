# Remote projects: how syncing works

The working guide to keeping a remote (SSH) project's **local mirror** and its
**host tree** in step. `docs/context/git_sync.md` records *why* the design is
what it is; this document says *what happens*, in what order, and what to do
when the UI goes amber, orange or red. Code: `src-tauri/src/services/
{remote_sync,sync_auto,git_peer,local_loss,worker_sync}.rs` and
`src-tauri/src/commands/{sync,git_peer}.rs`; UI: `src/stores/remote/sync.ts`,
`src/components/files/{FileTree,ProjectFilesView,ProjectFilesPane}.tsx`,
`src/components/files/GitHistory.tsx` (the Lockstep bar).

## 1. The two trees and the two transports

A remote project has two real working trees:

| Side | Where | Who writes it |
|---|---|---|
| **Mirror** (local) | `~/tabtivity/projects-ssh/<name>/` by default; `extra["mirror"]` in `projects.json` overrides it; legacy fallback `<state_dir>/remote-projects/<id>/mirror/` | local agent tabs, local shells, your editor, and both transports below |
| **Host** (remote) | `host:remote_path` from the project's `RemoteSpec` | remote tabs (`ssh -tt`), anything else on the host, and both transports |

Two independent engines keep them in step. They **split the tree by git**:

| | Git lockstep (`git_peer`) | Byte-sync (`sync_auto` + `commands::sync`) |
|---|---|---|
| Owns | every **git-tracked** file (`git ls-files` in the mirror, i.e. the index) | everything else: untracked and gitignored files |
| Moves | **commits and refs**, via `git bundle` over the pooled SFTP session, then `git merge --ff-only` / `checkout` on each side | **raw bytes**, one file at a time over SFTP (rsync as a fast path for folder pulls) |
| Scope | the whole repo, once enabled | an explicit per-path manifest (`sync.json`) — nothing crosses unless marked |
| Reads `.gitignore`? | yes (it is git) | **no** |
| Trigger | mirror `.git` watcher (800 ms debounce) + a 12 s host poll | mirror watcher (1.5 s debounce) + a 25 s host re-stat, for auto-marked paths only |
| Conflict policy | fast-forward only; a real divergence is reported, never auto-resolved | safe direction only; a file changed on both sides is skipped and painted orange |
| Deletes locally? | yes — a fast-forward/checkout/reset drops the tracked files the incoming commit no longer has; each is logged (`local_loss.json`) and raised by the *Files changed on your local copy* dialog | never in the background; a manual pull over a locally edited file is confirmed first and then logged |

The one rule that makes the two safe together: `sync_auto::drop_tracked` and
`commands::sync::drop_lockstep_tracked` subtract the tracked set from every
byte-sync candidate list whenever lockstep is enabled. Consequences you will
notice:

- With lockstep on, **saving a tracked file does not reach the other side until
  you commit.** Byte-sync will not carry it, and lockstep only carries commits.
- A gitignored folder (`data/`, `checkpoints/`, `.venv/`) is invisible to
  lockstep and crosses **only** if you mark it for byte-sync. That is what keeps
  host-side experiment output on the host by default.
- Turning lockstep **off** hands the tracked files back to byte-sync, with
  whatever bases the manifest recorded for them.

Both engines run only while the project's pooled SSH session is up
(`remote_connect` starts them, `remote_disconnect` stops them). A host tagged
**HPC** gets neither background loop; the manual actions still work.

## 2. Byte-sync, step by step

### 2.1 The manifest

`<state_dir>/remote-projects/<id>/sync.json` maps a project-relative path to a
`SyncEntry`. The fields that matter:

| Field | Meaning |
|---|---|
| `selected` | the path is tracked by byte-sync (set by any pull/push, or *Sync to local*) |
| `is_dir` | a folder marker; its flags apply to the whole subtree |
| `host_size` / `host_mtime` | the **host base**: the host's stat at the last transfer |
| `local_size` / `local_mtime` | the **local base**: the mirror's stat right after that transfer |
| `last_pull_ts` / `last_push_ts` | whether (and when) bytes ever crossed; both `None` = never synced |
| `auto_sync` | the background engine keeps this path (or subtree) in step |
| `auto_off` | carve-out: overrides an ancestor's (or the project-wide) `auto_sync` |
| `excluded` | out of byte-sync entirely — skipped by auto-sync **and** by *Sync all* / *Push all* |

Divergence is always judged **side against its own base**, never host mtime
against local mtime (clocks differ). For one file:

- host stat ≠ host base → *host moved*
- mirror stat ≠ local base → *local moved* (a missing mirror file that was once
  synced also counts)

### 2.2 What the colours mean

| Row state | Meaning | Where |
|---|---|---|
| green | selected, neither side moved from its base | tree badge |
| amber / **orange** | selected, host and/or mirror moved | tree badge, the *± diverged* list |
| none | not selected (or excluded) | no badge |
| `localnew` (⬆) | exists in the mirror, never synced, not tracked by git, not excluded — an upload offer | tree badge, the *new local* list |
| green, no host stat | **lockstep-owned** tracked file; in step as of the last commit | tree badge |

Status is refreshed by the `sync_status` command (on view, every 15 s while the
tree is visible, after every transfer, and after every auto-sync pass). A
metadata-only amber — same bytes, drifted mtime, ≤ 1 MiB — is read on both
sides and healed to green by re-recording the base.

### 2.3 Marking scope

Right-click a file or folder in the **Remote** tree:

| Action | Command | Effect |
|---|---|---|
| *Sync to local* / *Sync folder to local* | `sync_pull` | pull into the mirror now; marks selected and records bases |
| *Push to host* / *Push folder to host* | `sync_push` | push from the mirror now (see 2.5) |
| *Stop syncing* | `sync_mark_selected(false)` | forget the path; mirror bytes stay |
| *Auto-sync this file/folder* | `sync_set_auto(true)` | background engine keeps it in step; folder markers cover the subtree; also lifts the path's own exclusion |
| the same item again | `sync_set_auto(false)` | writes an `auto_off` carve-out (an ancestor's auto no longer applies) |
| *Exclude from sync* / *Include in sync* | `sync_set_excluded` | the strong marker: skipped by auto-sync **and** by whole-project transfers |
| *Auto-sync all* (view header) | `sync_set_auto("")` | the project-wide root marker |
| *Large folders…* (view header) | `sync_big_folders` | census of both sides; ticked folders become `excluded` |

Nearest marker wins, walking from the path's own entry up through ancestor
**folder** markers to the root `""`. So a project-wide auto-sync with `data/`
excluded and `data/configs/` auto-synced does exactly what it says.

Auto-syncing a folder that would pull more than 200 files or 100 MB asks first
(`sync_auto_preview`); byte-sync ignores `.gitignore`, so this is the click that
could otherwise haul a checkpoint tree into the mirror. A new remote project
gets the *Large folders* census once at setup for the same reason.

### 2.4 The background pass (`sync_auto::reconcile_pass`)

Runs every 25 s and ~1.5 s after a write inside the mirror (writes under
`.git/` and `.tabtivity/` do not count — those are lockstep's and the runtime's).
Per pass:

1. Candidates = auto-marked files ∪ host walk of each auto folder ∪ mirror walk
   of each auto folder. Symlinks, nested repositories, `.git`, `.tabtivity` are
   never walked.
2. Drop anything whose effective auto is off, then drop the git-tracked set if
   lockstep is on.
3. For each candidate, stat both sides and pick the **safe direction**:

| host moved | local moved | action |
|---|---|---|
| no | no | nothing |
| yes | no | pull host → mirror |
| no | yes | push mirror → host, but only if the host still matches its base (`push_decision == Safe`) |
| yes | yes | skip; the row stays orange for you |

A file that exists on **both** sides but was never synced counts as "both
moved" (no base to compare against) and is skipped every pass. Pull or push it
once by hand to adopt it; after that it has a base and auto-sync takes over.

Deletions are not propagated in the background: a file deleted on one side
sits orange until you finish the deletion from the diverged list (*apply
delete*) or restore it from the other side.

### 2.5 Manual transfers and the confirmation

Every manual pull or push is priced first (`sync_transfer_preview`) and asks
(`SyncConfirmDialog`) with direction, scope, file count, size, how many files
land on an existing one, and **by name** the receiving-side files whose content
exists nowhere else. "Not now" is always available.

**Pull** (`sync_pull`, *Sync all* in the Remote tree): host bytes over the
mirror's. For a folder, rsync is used when present on both ends, fed the exact
file list the host walker produced; otherwise per-file SFTP. rsync lands only
what SFTP would: `-t -c --no-links --no-devices --no-specials
--max-size=<64 MiB>`, no `-a` and no recursion past the list
(`remote_sync::rsync_pull_flags`), files over the cap left out of the list, and
only a regular file within the cap recorded afterwards. Any rsync error (an old
or foreign rsync refusing a flag included) falls back to SFTP. Locally edited
files it overwrites are logged.

**Push** (`sync_push`, *Push all* in the Local tree): for each file the host is
re-stat'd; a host that moved since the base **blocks** that file and returns it
as a conflict. The tree then asks per file — *keep local* (force push), *take
host* (pull), *skip* — and *skip all* drops the queue, leaving the files orange.

A targeted pull or push whose every candidate was withheld (tracked by git under
lockstep, or excluded) **errors with the reason** instead of reporting success.
Whole-project transfers (`""`) may legitimately move nothing.

### 2.6 Resolving an orange file

From the *± diverged* list or the row's context menu:

- **Merge viewer** (`SyncMergeView`): mirror ⇄ merged ⇄ host, per block. On
  open it byte-compares both sides and self-resolves an identical pair.
- **Take host** for one or all: a confirmed pull.
- **Keep local** for one or all: a confirmed force push.
- **Apply delete** when one side is gone: propagates the deletion, after
  re-verifying live that the side is positively absent.

## 3. Git lockstep, step by step

### 3.1 Enabling and pairing

Lockstep is **on by default** for a new git-backed remote project
(`create_project`, `extend_project_to_remote`) and toggled from the *⇄ Lockstep*
button in the Git panel (`git_peer_set_enabled`). State lives in
`<state_dir>/remote-projects/<id>/git_peer.json`.

The first pass looks at both sides and picks a plan (`pair_plan`):

| Mirror | Host | Plan |
|---|---|---|
| has a commit checked out | has a commit checked out | ordinary sync (3.2) |
| has a commit | not a repo / bare `git init` | **pair**: the mirror is the authority |
| not a repo / bare `git init` | has a commit | **pair**: the host is the authority |
| neither | neither | nothing to do |

Pairing (`init_pairing`) `git init`s the empty side, ships the whole history as
one bundle, points HEAD at the authority's branch and `reset --hard`s to it,
propagates the authority's `origin` URL, and seeds the byte-sync manifest for
every tracked file so the tree reads green. Before any of that,
`pairing_conflicts` compares every file the reset would write against what is
already there: a **differing** file on the empty side **refuses the pairing**
and names the files; the *Overwrite* button (`git_peer_pair_confirm`) is the
explicit consent. Identical files pair cleanly — that is the normal case when
byte-sync mirrored the tree first.

A side whose git probe could not run is never treated as empty.

### 3.2 A normal pass (`reconcile_with`)

Every pass is one of: the 12 s poll, a `.git` write on the mirror, *Sync now* /
*Retry*, or the pass a coordinated checkout runs. Steps:

1. **Connected?** If the pool is cold: status *disconnected*, nothing claimed,
   nothing written.
2. **Probe** both sides in one round trip each: HEAD, branches, tags, tracked
   dirty bit, HEAD subject, and the branches checked out in linked worktrees.
3. **Early-out** when the last pass was green and neither side's ref signature
   (refs + HEAD + dirty bit) changed. `Sync now` bypasses it.
4. **Transfer mirror → host, then host → mirror.** Each leg: thin bundle of the
   source's branches and tags, minus the shas the dest already has and the
   source knows; SFTP it across; `git fetch` it into `refs/tabtivity/incoming/*`;
   classify each branch (`decide`) and apply:

| Classification | Applied as |
|---|---|
| in sync | nothing |
| missing on dest | `update-ref` (create) |
| dest can fast-forward, branch checked out there | `git merge --ff-only` (refuses on a dirty tree or an untracked collision) |
| dest can fast-forward, branch not checked out | `update-ref` with old-value guard |
| dest is ahead | nothing (the other leg carries it) |
| diverged | reported; the peer's tip is parked at `refs/tabtivity/peer/<branch>` so you can merge by hand |

   A branch checked out in a **linked worktree** on the dest is left alone and
   reported, but only when the pass would actually have written it.
5. **Status**: pairing refused → red with the file list; any branch diverged →
   red "Diverged: …"; a refused fast-forward → red with git's own message; refs
   all equal but the two HEADs on different targets → red "Out of step" (no
   side is guessed); otherwise green.

The tracked files a fast-forward changed on the *mirror* are re-stamped in the
manifest (`restamp_after_checkout`) and, if any were deleted, logged.

### 3.3 The blocked fast-forward and what clears it

`git merge --ff-only` refuses to overwrite an **untracked** file even when the
bytes are identical. That is exactly what a byte-synced copy that got ahead of
its commit looks like, so the pass retries after removing only files that are
provably harmless: byte-identical to the incoming blob (`hash-object` vs
`rev-parse <sha>:<path>`), or a stale byte-synced copy whose content git already
holds as an object. One file that is neither, and nothing is touched — the
status names it. Your options: commit it, move it, or delete it, then *Retry*.

### 3.4 Checkouts

A branch switch on either side is replayed on the other
(`detect_and_sync` → `checkout_lockstep`): byte-sync is paused, refs are
reconciled so the peer has the commit, the peer runs a **guarded**
`git checkout <target>` (never `-f`), tracked-file bases are re-stamped, and
byte-sync resumes. What counts as a switch is the **target** changing — another
branch, a detach, a re-attach, or another commit while detached. A commit on the
same branch is a fast-forward, not a checkout, and never moves the peer's HEAD
to a different branch. If **both** sides switched since the last look, nothing
is replayed; the pass reports "Out of step" and the Git panel's checkout does
the move you choose.

A peer with uncommitted tracked changes refuses the checkout; the status
carries git's message. Commit or stash there, then *Retry*.

### 3.5 Divergence: Use local / Use remote / by hand

When both sides committed on the same branch:

- **Use local** / **Use remote** (`git_peer_resolve`): the chosen side wins;
  every diverged branch, and every branch where the loser is ahead, is reset
  to the winner's commit after the overwritten tip is saved to
  `refs/tabtivity/backup/<ts>/<branch>`. A checked-out loser branch is
  `reset --hard` (the mirror side logs what that deleted). The reset is refused
  if an **untracked** file on the loser differs from the incoming tree — those
  were never git objects and no backup could cover them.
- **Resolve in terminal**: opens a shell in the mirror; the host's tip is at
  `refs/tabtivity/peer/<branch>`, so `git merge refs/tabtivity/peer/main` or a rebase
  works as usual, and the next pass fast-forwards the host.
- **Backups**: lists both sides' safety refs and restores one; a restore backs
  up the current tip first and deliberately leaves the sides diverged for you
  to resolve with the authority you meant. Backups are pruned to the newest 20
  or 30 days, never the newest one.

### 3.6 Self-triggering, and why the pill sometimes flickers

Each pass writes inside the mirror's `.git` (bundle, incoming refs, fetched
objects), which is the same directory the watcher observes. A burst that leaves
the mirror's ref signature exactly as the previous pass left it is treated as
the pass's own tail and skipped; the 12 s poll still covers anything real that
arrives in that window. Byte-sync's watcher ignores `.git` and `.tabtivity`
altogether.

## 4. Workers (multi-host)

Extra compute hosts receive the **mirror's** current HEAD one way
(`worker_sync`): bundle → SFTP → `git fetch` → `reset --hard FETCH_HEAD`,
never `git clean`, so their untracked outputs survive. Triggered on worker
connect, on every commit the lockstep watcher sees (so it needs lockstep
enabled), and by *Sync code now*. A shared-filesystem worker gets nothing —
it already sees the primary's folder. *Pull outputs* is the only worker → local
byte path, into `<state_dir>/remote-projects/<id>/outputs/<label>/`, never
into the mirror.

## 5. Where things live

| Path | What |
|---|---|
| `<state_dir>/remote-projects/<id>/sync.json` | byte-sync manifest |
| `<state_dir>/remote-projects/<id>/git_peer.json` | lockstep state (enabled, status, last observed heads, early-out signatures) |
| `<state_dir>/remote-projects/<id>/local_loss.json` | what lockstep/sync destroyed on the mirror, until acknowledged |
| `<state_dir>/remote-projects/<id>/workers/<host>.json` | each worker's last pushed head |
| `<mirror>/.git/tabtivity-lockstep.bundle`, `<host>/.git/tabtivity-lockstep.bundle` | transient bundle files, removed after each pass |
| `refs/tabtivity/incoming/*` | transient fetch namespace on the receiving side |
| `refs/tabtivity/peer/<branch>` | the other side's tip while a branch is diverged |
| `refs/tabtivity/backup/<ts>/<branch>` | tips overwritten by a resolve, pairing or restore |

## 6. Symptom → cause → fix

| You see | Usual cause | Do |
|---|---|---|
| a saved edit is not on the host | the file is git-tracked and lockstep is on | commit it |
| a host-side output folder appeared in the mirror | it is (or is under) an auto-synced folder; byte-sync ignores `.gitignore` | *Exclude from sync* on it |
| orange row, both sides changed | real conflict | merge viewer, or take one side |
| orange row for a file you deleted | one-sided deletion is never propagated automatically | *apply delete* or restore |
| ⬆ "new local" on a file the host already has | never synced on either side, so no base | push it once (accept the conflict prompt) or pull it once |
| lockstep red: *untracked file(s) on the peer differ* | a file byte-synced or created before its commit, with different content | commit, move or delete it on that side, *Retry* |
| lockstep red: *Diverged* | both sides committed | Use local / Use remote / merge in terminal |
| lockstep red: *Out of step* | the two sides sit on different branches and no side is authoritative | pick a branch in the Git panel; that checkout replays on the peer |
| lockstep red: *Pairing would overwrite N file(s)* | the empty side already holds differing files | inspect, then *Overwrite* if they are disposable |
| lockstep *disconnected* | the pool is cold | reconnect; nothing was claimed or written |
| *Files changed on your local copy* dialog | a fast-forward, checkout, reset, or confirmed pull removed or overwrote mirror files | read the entry; git-side losses name the restore command |
| pull/push of one file "did nothing" | it is lockstep-owned or excluded — the command now says which | commit it / include it |

## 7. Verifying a change

Unit tests cover the pure decision functions (`cargo test git_peer`,
`sync_auto`, `remote_sync`, `commands::sync`). The I/O orchestration is only
proven live: `src-tauri/examples/lockstep_drv.rs` drives the same service
entry points the commands call against a real host —

```bash
TABTIVITY_PROJECT=<project-id> cargo run --example lockstep_drv -- <script>
```

— and `docs/git_lockstep_case_matrix.md` is the case list it walks. Point it at
a scratch project; it mutates both trees.
