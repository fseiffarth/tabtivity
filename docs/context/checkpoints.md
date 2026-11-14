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
a `gc` after 50 dropped refs) and a byte cap: a store over
`checkpoints::MAX_STORE_BYTES` (2 GiB) drops the oldest quarter of its
snapshots (never the newest, never a recent `pre-restore`), repacks when idle,
and drops another quarter if it is still over.

## When it runs

Only while both switches are on (`checkpoints::capturing_in`): the backend's
`checkpoints.json` and the window's experimental flag (`settings.json`
`turn_checkpoints`, by the experiments' own rule). The settings card sets both
in one click; if they ever disagree nothing is captured, so a store never grows
behind a window that hides it. A snapshot job that panics is logged and the
folder's queue goes on. An automatic snapshot that fails is remembered per
folder (until one succeeds) and shown on the Reader's Checkpoint chip.

## Why no user or project config

The work tree is attacker-controlled and the user's global config may name a
filter driver (`git-lfs`) or an fsmonitor, so a store call reads none of it:
`git_hardened::checkpoint_git_command` sets `GIT_CONFIG_NOSYSTEM`,
`GIT_CONFIG_GLOBAL` = the null device, hooks and `core.fsmonitor` off, drops
every inherited `GIT_*` that could redirect or inject config, and points
`GIT_ATTR_SOURCE` at the empty tree so the folder's `.gitattributes` is not
read: the bytes stored are the bytes on disk (no end-of-line conversion).
Both need a recent git (`GIT_ATTR_SOURCE` 2.40, `GIT_CONFIG_GLOBAL` 2.32), so
`checkpoints::MIN_GIT` is 2.40: below it checkpoints can't be turned on and
every store call refuses, rather than storing bytes an old git converted.
The folder's own `.git` is never discovered, and `git_bounded`'s precheck of
its files is skipped (`Store::exec`): the store reads none of them, and a pipe
planted at `.git/packed-refs` must not switch the checkpoints off. The repo's
`info/exclude` is the one thing read from it, through
`git_guard::read_info_exclude`, copied into the store's own ignore file; only
the folder's own `.git` or, for a linked worktree, its root's is read
(`snapshot::repo_git_dir`). The folder's `.gitignore` files apply as git
applies them.

## Folders git would wait on, and the excludes that hold

git opens every `.gitignore` it walks past with a plain blocking `open`, so a
named pipe there stalls it until the timeout. An agent can make one (mkfifo
needs no privilege) and so switch off its own undo history. A snapshot keeps
such a folder out instead (`snapshot::stage_with`): the folders the store holds
a file in and the ones found before (`<store>/blocked`) get a `stat`; a new one
makes the first walk stall at 45 s, after which a bounded walk
(200 000 entries) finds it. Its files leave the store's index (an indexed file
draws git into its folder whatever the excludes say), every walk carries an
exclude pathspec for it, the row names it (`blocked`, partial), and a restore
leaves its files alone. A pipe as the top `.gitignore` fails the snapshot at
once with a reason. Left-out files, blocked folders and the linked worktrees
folder are kept out by exclude pathspecs, not by ignore lines: a `.gitignore`
negation (`!big.bin`) outranks `core.excludesFile` and would take them back.
The store's git runs under `LC_ALL=C` because `git add`'s messages are matched.

Paths stay bytes (`store::GitPath`) from git's `-z` output to the file system:
a name that is not UTF-8 is capped, restored and removed by its own bytes; the
window gets a lossy copy for display and filtering only. Commits have no parent (a parent chain would keep every pruned snapshot
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

- Only the folder's own ignore rules apply: an ancestor repo's `.gitignore`,
  `info/exclude` or the user's global ignore file is not read (so
  `.DS_Store`-style files are captured).
- The first snapshot of a big folder is bounded by the 256 MiB new-bytes budget
  (every file is new to an empty store): the largest wait for later snapshots.
- Empty folders are not captured and a restore leaves empty folders behind.
