# Git sync: lossless fast-forward over byte-identical dirt — plan

## Problem

A remote project's host checkout sits at an old commit with many uncommitted
changes, while the mirror has committed those same bytes (typically because
file sync carried the files to the host before the commits travelled). Git
sync (lockstep, `services/git/git_peer.rs`) must fast-forward the host, but
`git merge --ff-only` refuses: "Your local changes to the following files
would be overwritten". The project shows Desynchronized forever although the
fast-forward would lose nothing. Same shape in the other direction (mirror
behind the host).

Untracked byte-identical files are already handled
(`retry_ff_clearing_identical`, `parse_untracked_overwrite_paths`, #28q).
Tracked modified files are not.

## Fixed decisions (user, 2026-11-25)

1. **Lossless only.** The pass proceeds automatically only when *every*
   blocking path is provably identical to the incoming commit's version. One
   path that differs (or cannot be proven equal) blocks the whole branch as
   today, and the message names the differing paths, not the identical ones.
2. Equality is by blob hash (`hash-object` of the working file vs the target
   tree's blob from `ls-tree -r -l -z <target>`), plus file mode where git
   reports one. A path deleted in the working tree is identical only when it
   is also absent from the target. Unprovable → different (the safe
   direction, as `reset_collisions` does).
3. The index must not hold content that would be lost: for each dirty path
   the staged blob must equal HEAD's or the target's. Anything else → treat
   as different.
4. Mechanism: stage the identical paths (`git add -- <paths>`, through the
   peer's existing hardened runner), then retry `merge --ff-only`. Git's
   two-way merge accepts an index entry equal to the new tree. If the retry
   still fails, restore the index for exactly those paths to what it was
   (`git reset -q -- <paths>` when it was HEAD's) and report git's stderr;
   the working-tree bytes are never touched by this step.
5. One retry handles tracked and untracked identical paths together: git can
   report both kinds in one stderr; the existing untracked clearing and the
   new tracked staging run before the single retry.
6. Both directions (host as dest and mirror as dest). The force-reset path
   (`force_reset_branch` caller with the `dest.dirty_tracked` refusal, around
   "Refusing: the {where_} has uncommitted changes") uses the same predicate:
   if every dirty tracked path is identical to the target, do not refuse.
7. Nothing is lost, so nothing goes to `local_loss`. The pass result notes how
   many identical paths it absorbed (existing `result.note` / applied count
   pattern), so the UI's sync detail can say so; no new UI.
8. No new Tauri command, no new setting, no change to when lockstep runs.
   Lockstep stays opt-in per project; this only changes what a pass that
   already runs can do.
9. Every git call goes through the existing `Peer::run`/`Peer::stdout`
   (hardened; remote via `hardened_remote_script`). No bare `Command`.

## Steps

1. Pure helpers (unit-tested without git): parse the "local changes would be
   overwritten" path list from merge stderr (both the tracked and untracked
   message blocks, quoted paths via `unquote_git_path`); the identity
   predicate over (target fingerprints, worktree hashes, index blobs, HEAD
   blobs) returning `{identical, differing}`.
2. Peer-side reads: worktree hashes (reuse `hash_objects`), index blobs
   (`ls-files -s -z -- <paths>`), HEAD and target blobs (`ls-tree`). Batch per
   call, not per path: the host is over SSH.
3. Wire into the `FastForwardDest` + `is_head` failure branch next to
   `retry_ff_clearing_identical` (fold into it or a sibling; keep `FfRetry`
   semantics and the existing local_loss reporting for residue untouched).
4. Apply the same predicate to the force-reset dirty refusal (decision 6).
5. Tests in `services/git/git_peer/tests.rs`: pure helper tests, and real-git
   tests on two local temp repos (the file already has Local↔Local
   fixtures; follow them): (a) dest behind + tracked edit identical to target
   → fast-forwards, file bytes unchanged; (b) one identical + one differing →
   blocked, message names only the differing one, index and bytes unchanged;
   (c) identical tracked + identical untracked together → one pass; (d) staged
   blob neither HEAD's nor target's → blocked; (e) deleted file absent from
   target → fine. Cross-OS: paths with `Path::join`, no `"a/b"` literals.
6. Docs: one bullet in `docs/context/git_sync.md` and one row tweak in
   `docs/remote_sync_guide.md` if it lists the dirty-tree refusal; filemap row
   only if a new file appears.

## Organisation (user asked for two subagents)

| Agent | Work | Files |
|---|---|---|
| Implementer (worktree) | Steps 1–6, gates, commit | `services/git/git_peer.rs`, `services/git/git_peer/tests.rs`, `docs/context/git_sync.md` |
| Reviewer (fresh, same worktree branch) | Review the range against this plan and AGENTS.md invariants; fix confirmed bugs only, each with a regression test; doubts go to "Flagged for user" in the handoff | same |

Handoff file: `docs/git_sync_lossless_ff_handoff.md`.
