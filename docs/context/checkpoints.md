# Per-turn checkpoints

Plan and the user's three decisions: `docs/turn_checkpoints_plan.md`. Build
notes and deviations: `docs/turn_checkpoints_handoff.md`. Code:
`src-tauri/src/services/checkpoints/` (`store`, `snapshot`, `restore`,
`worker`, `mod`), `commands/checkpoints.rs`; window side
`components/terminal/{ReaderCheckpoints,CheckpointRestoreDialog,CheckpointDiffScope}.tsx`.

## Why the store is outside `.git`

T3 Code keeps its snapshots as hidden refs in the project's own `.git`. Inside
the agent fence the agent can write that `.git`: it could delete or forge its
own undo history. And a non-git folder would get nothing. So every folder gets
its own object store under `<state_dir>/checkpoints/<key>/` with the folder as
its work tree (`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`). The fence masks
the whole state dir (`agent_fence::mask_private_state`; the directory is also
named in `private_state_paths`), and a test pins that nothing binds it back.
The cost is duplicated blobs on disk, bounded by retention (14 days, 300 rows,
a `gc` after 50 dropped refs).

## Why no user or project config

The work tree is attacker-controlled and the user's global config may name a
filter driver (`git-lfs`) or an fsmonitor, so a store call reads none of it:
`git_hardened::checkpoint_git_command` sets `GIT_CONFIG_NOSYSTEM`,
`GIT_CONFIG_GLOBAL` = the null device, hooks and `core.fsmonitor` off, drops
every inherited `GIT_*` that could redirect or inject config, and points
`GIT_ATTR_SOURCE` at the empty tree so the folder's `.gitattributes` is not
read: the bytes stored are the bytes on disk (no end-of-line conversion).
The folder's own `.git` is never discovered. The repo's `info/exclude` is the
one thing read from it, through `git_guard::read_info_exclude`, copied into the
store's own ignore file; the folder's `.gitignore` files apply as git applies
them. Commits have no parent (a parent chain would keep every pruned snapshot
alive); `refs/ckpt/<id>` per log row is what keeps a commit.

## The `pre` race

`UserPromptSubmit` fires as the agent starts; the snapshot lands a few hundred
ms later; the agent's first write normally comes seconds later (model latency).
To catch the rare overlap the snapshot compares file mtimes with the turn
record's write time: a newer file marks the row `raced`, and the restore dialog
offers the previous turn's end instead. Cannot be exact: the user's own edits
in that window count too.

## Restore

The renderer names a tab (its launch uid) and an opaque id. The folder is the
one `launch_prep` bound the tab to, found among the fence roots (`projects.json`
/ `boxes.json`), never from the renderer. A file list from the renderer is only
a filter on what git's diff reports. Before any write each path is checked
(`restore::plain_path`: no `..`, no `.git`, no leading link). A swap between
check and write remains a race with another process in the same folder; the
restore refuses while this tab's agent works and the dialog confirms for other
tabs'. A restore takes a `pre-restore` snapshot first: that is Undo restore.
A file that is now over the snapshot cap (or not an ordinary file) is dropped
from the store's index, so git would call the checkpoint's copy "deleted since";
`restore::left_alone` keeps it out of the list and of the restore, since the
`pre-restore` snapshot does not hold it and the write could not be undone.
The folder a tab is bound to is canonical; `Store::for_bound` refuses it once it
resolves elsewhere (a linked worktree's folder lies in the project, where the
agent can swap it for a link).

## Limits worth knowing

- Only the folder's own ignore rules apply: an ancestor repo's `.gitignore` or
  the user's global ignore file is not read (so `.DS_Store`-style files are
  captured).
- The first snapshot of a big folder is bounded by the 256 MiB new-bytes budget
  (every file is new to an empty store): the largest wait for later snapshots.
- Empty folders are not captured and a restore leaves empty folders behind.
