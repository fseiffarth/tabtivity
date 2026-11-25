# Git sync: lossless fast-forward over byte-identical dirt — handoff

Branch: `worktree-agent-a35a95f38067ff2c1` (based on develop `f92da476a`).
Worktree: `.claude/worktrees/agent-a35a95f38067ff2c1` (under the main checkout).
Spec: `docs/git_sync_lossless_ff_plan.md`. Gates skipped at user's request.

## What was done, per plan step

1. **Pure helpers** (`services/git/git_peer.rs`): `overwrite_list` (shared reader of the
   TAB-indented lists; now reads every block in a stderr), `parse_tracked_overwrite_paths`,
   `parse_untracked_overwrite_paths` (same behaviour, via the shared reader),
   `GitBlob`, `parse_ls_tree_blobs`, `parse_ls_files_stage`, `DirtVerdict` +
   `classify_tracked_dirt` (the identity predicate), `blocked_detail_tracked`.
2. **Peer reads**: `read_dirt_verdict` does `ls-tree -r -z <target>`, `ls-tree -r -z HEAD`,
   `ls-files -s -z`, `ls-files -d -z` (all with the path list, chunks of 200) and one
   `hash_objects` pass over the non-deleted paths. A failed read makes every path differing.
3. **Wiring**: `retry_ff_clearing_identical` now handles both blocks in one retry. Order:
   untracked proof, tracked proof (reads only), stage (`stage_identical`), clear untracked,
   one `merge --ff-only`. If it fails the staged paths are `reset -q -- :(literal)path`ed.
   New `FfRetry::Differing(paths)` (named in the message, via `blocked_detail_tracked`) and
   `FfRetry::AbsorbFailed(stderr)` (tracked-only retry failed; git's stderr reported).
   `Cleared` is unchanged in shape.
4. **Force reset**: the `dest.dirty_tracked` refusal in `force_apply` keeps only paths that
   differ (target read on the *source* peer, since the dest has no objects yet); a dirty
   list git cannot produce still refuses.
5. **Tests** (`git_peer/tests.rs`, 11 new): parser, predicate, ls parsers; real-git cases
   (a) absorb, (b) one differs: blocked, only that path named, index/bytes unchanged,
   (c) tracked+untracked in one pass, (d) third staged blob, (e) deleted-and-absent in target;
   plus untracked-differs-stages-nothing, already-staged-to-target, exec-bit mismatch
   (unix), force-reset predicate with a dest lacking the target objects.
6. **Docs**: bullet in `docs/context/git_sync.md`; a row tweak and one paragraph in
   `docs/remote_sync_guide.md` (3.3). No filemap change (no new file).

## Choices

- Equality is the index-level proof: after `git add`, `ls-files -s` must equal the target's
  `<mode, blob>`; this catches the exec bit and symlinks, which `hash-object` cannot see.
- Only paths whose index entry is not already the target's are staged, so everything staged
  had HEAD's entry exactly and `reset -- path` restores it exactly.
- A deleted path counts as identical only if it has an index entry, is missing on disk, and
  is absent from the target.
- `result.absorbed` (new `TransferResult` field) is logged with `eprintln!` like the other
  lockstep notes; see Flagged.

## Observed git stderr (git 2.x, LC_ALL=C set by the test; see the review section: the peer runner does not pin C)

```
error: Your local changes to the following files would be overwritten by merge:
\ta.txt
\tb.txt
Please commit your changes or stash them before you merge.
error: The following untracked working tree files would be overwritten by merge:
\td/n2.txt
\tn.txt
Please move or remove them before you merge.
Aborting
Updating <old>..<new>
```
Tracked block comes first, both appear in one stderr. Verified empirically: an unstaged delete
the target also carries is not listed and does not block; `merge --ff-only` succeeds when
index == worktree == target blob for a path that differs from HEAD, and also when the index
holds the target blob but the worktree differs (the worktree edit is kept); it refuses when
the staged blob is a third version (and names it).

## Gates

Skipped at the user's request (`scripts/gates.sh` not run). Run:
`cargo test -q -p tabtivity --lib -- git_peer`: 103 passed, 0 failed (92 existing + 11 new).
Clippy, `--no-default-features` build and the other gates were not run.

## Flagged for user

- Decision 7 asks for a note the UI can show; `GitPeerState` has no field for a green pass
  and decision 8 forbids new UI, so the absorbed count only reaches the stderr log line
  (`lockstep: <id>: fast-forward absorbed N byte-identical tracked path(s)`). Say if a state
  field is wanted.
- `blocked_detail_tracked` is a new message; mixed refusals (untracked differ and tracked
  differ) still name the untracked ones first, as before.
- File-sync bases of absorbed tracked paths are not re-stamped (their bytes did not change).
- The new code uses `:(literal)` pathspecs; a git too old for pathspec magic would fail the
  read, which reads as differing (safe).
- Windows/macOS were not exercised; the mode test is unix-only, fixtures use `Path::join`.
- Clippy with `-D warnings` was not run: a lint is possible.

## Review (second agent)

Fixed (1 confirmed bug, 2 regression tests; `git_peer` suite 105 passed, `the_force_reset_predicate_refuses_*`):

- Force-reset path accepted a dirty file whose `hash-object` equals the target's blob even when
  `reset --hard` would rewrite it differently: `hash-object` follows a symlink (a link to a
  file holding the target's bytes read as identical) and cannot see the exec bit. The fast-forward
  path was safe (`stage_identical` checks mode/type on the index), the reset path had no such
  check. `read_dirt_verdict` takes `rewrites_worktree`; for the reset caller every identical path
  must also have the working-tree mode (`diff-files --raw -z`, else the index entry's) equal to
  the target entry's, unreadable = differing.

Flagged for user (review):

- Locale: the local `Peer::run` does not pin `LC_ALL=C` (only the checkpoint runner does; the
  remote host never is), contrary to the first handoff. Under a non-English git both stderr
  parsers return nothing, so `retry_ff_clearing_identical` returns `Refused` and the feature is
  silently inert (fail closed, as the untracked retry already was). Pinning C on lockstep peers
  (or deriving the blocking set from `diff --name-only HEAD <target>` instead of stderr) is a
  design change, left to you.
- Force reset and filters: equality is by filtered `hash-object`, but `reset --hard` writes
  `smudge(blob)`. A worktree file that cleans to the target blob yet differs from what the blob
  checks out to (CRLF file under `eol=lf`/`text=auto`, `ident`, a lossy clean filter, LFS
  without the filter installed reads as different, so safe) would be rewritten by the reset.
  The fast-forward path never rewrites it. Decision 2 prescribes the hash, so not changed.
- Merge-stderr paths are `trim`med, so a tracked path with leading or trailing spaces is parsed
  as a different path; that fails closed (the retry fails and the index is put back), but such a
  project stays Desynchronized.
- `unstage` is `reset -q -- path`: it restores mode and blob exactly, but would not restore
  index flags (assume-unchanged, skip-worktree, intent-to-add) on a path the failed retry had
  re-added. Not reproduced; sparse/assume-unchanged checkouts are unusual on a synced host.
- Case-insensitive filesystems (macOS/Windows) were not exercised: `hash-object` of a path that
  the index spells in another case may read a different file. Not reproduced.
