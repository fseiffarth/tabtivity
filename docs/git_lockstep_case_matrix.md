# Git Lockstep Case Matrix (#28p)

Snapshot of `services::git_peer` + `services::sync_auto` behaviour as of
2026-07-13 (post D1–D8, `docs/git_lockstep_hardening_plan.md`). Source of truth
is the code; re-scan before trusting this against a later commit.

> **All 28 cases have now been run against a real SSH host** —
> `docs/git_lockstep_live_qa.md`, driven by `src-tauri/examples/lockstep_drv.rs`.
> Four did **not** behave as this document claimed (cases 15, 17, 26, and the
> error-swallowing behind them) and were fixed; the table below describes the
> fixed behaviour. Every one of the four had the same shape — a no-op or failure
> in the transport computing to `Synchronized` — and none was reachable by the
> unit tests, which cover the pure decision functions the bugs prevented from
> ever being called.

## Axes

**BS** = byte-sync auto on for the path · **LS** = git lockstep on. Both default
off. Governing invariant (`src-tauri/CLAUDE.md`,
`sync_auto::drop_tracked`): **lockstep owns the git-tracked tree, byte-sync owns
everything else.** "Tracked" = `git ls-files` in the mirror, i.e. the **index** —
a brand-new file is not tracked until `git add`.

## Creates and edits, before any commit

| # | Scenario | Config | Current behaviour | Status |
|---|---|---|---|---|
| 1 | Local create (untracked) | – | nothing; mirror-only | |
| 2 | Local create (untracked) | BS | pushed to host as an **untracked** file | |
| 3 | Local create (untracked) | BS+LS | still pushed — not in the index yet, so `drop_tracked` doesn't cover it | |
| 4 | Local edit of a **tracked** file | BS | pushed; host sees it live | |
| 5 | Local edit of a **tracked** file | BS+LS | **not pushed** — `drop_tracked` removes it; crosses only on commit | ⚠️ intended, undocumented in CLAUDE.md |
| 6 | Host create/edit, untracked | BS | pulled into mirror | |
| 7 | Host edit of a tracked file | BS+LS | not pulled — symmetric to #5 | ⚠️ intended, undocumented |
| 8 | `git add` (index write) | LS | `.git` watcher → dirty bit flips → signature changes → one full pass, bundle range empty → no transfer | |
| 9 | `.git` touched, refs+dirty unchanged (e.g. stat-cache write) | LS | `can_early_out` → cached status re-emitted; skips the **bundle/transfer** round trip, not the probe (live: ~280 ms vs ~630 ms for a full pass) | ✅ fixed (D5) |

## Commits

| # | Scenario | Config | Current behaviour | Status |
|---|---|---|---|---|
| 10 | Local commit, nothing byte-pushed first | LS | bundle → SFTP → fetch to `refs/tabtivity/incoming/*` → `merge --ff-only` writes files on host → restamp → green | |
| 11 | Local commit, byte-sync already pushed an **identical** copy | BS+LS | ff refused → `retry_ff_clearing_identical` proves identity on the dest (`hash-object` vs `rev-parse <sha>:<path>`), removes it with `git clean -f -x -- :(literal)<path>`, retries → green | ✅ fixed (D1) |
| 12 | Local commit, byte-pushed copy **differs** from the committed content | BS+LS | `stale_byte_sync_residue` proves the differing peer copy is byte-sync's own untouched prior push (manifest base still matches the peer's current stat) → cleared and the ff retried; a genuine independent edit still blocks | ✅ fixed |
| 13 | Local commit | BS only | commit stays local; bytes cross, history doesn't | |
| 14 | Host commit (host CLI, or the Git panel — runs git *on the host*) | LS | 12 s poll → mirror ff → same three sub-cases mirrored | |
| 14b | A commit on either side while the two sides sit on **different** branches (an "Out of step" state) | LS | fast-forward of that branch only; the peer's HEAD is **not** moved. ✅ fixed (2026-09-03): `detect_and_sync` compared whole `HeadRef`s, so the new sha read as a checkout and replayed `git checkout <branch>` on the peer — a silent branch switch on the host | |
| 15 | Both sides commit on `main` | LS | `Diverged` → never auto-applied → desync bar shows both heads as `sha · subject`, offers Use local / Use remote, parks peer tip at `refs/tabtivity/peer/<branch>` for terminal resolution | ✅ fixed (live QA) — **reported green** until then: the thin-bundle excludes name the peer's tip, which in a divergence is a commit the source has never seen, so `bundle create` aborted and both transfer legs no-op'd |

## Checkouts

| # | Scenario | Config | Current behaviour |
|---|---|---|---|
| 16 | Checkout a branch locally | LS | pause byte-sync → reconcile → guarded `checkout` on host (never `-f`) → `restamp_after_checkout` → **re-probe** (`refresh_heads`) → resume |
| 17 | Checkout on the host | LS | same, via 12 s poll. ✅ fixed (live QA) — the mirror **never followed**: a checkout persisted the peer head it observed *before* moving it, and the next pass compares a fresh probe against exactly that stored value, so the stale one masked the peer's next move permanently |
| 18 | New branch + commit locally | LS | `CreateOnDest` → `update-ref` → host checks it out too |
| 19 | Peer has dirty **tracked** changes | LS | peer checkout fails → desync carries git's actual stderr (✅ fixed, D2 — was a canned lie) |
| 20 | FF a branch not checked out on the peer | LS | plain `update-ref`, no worktree write |
| 21 | Detached HEAD | LS | peer `checkout <sha>` → both detached |
| 17b | Both sides checked out different branches between two passes (a long disconnect, two windows) | LS | refs reconciled, no checkout replayed, `head_mismatch` reports "Out of step" ✅ fixed (2026-09-03) — the mirror used to win silently and the host was switched to its branch |
| 21c | A branch checked out in a **linked worktree** on one side is merely ahead of the other | LS | the other side fast-forwards; nothing is blocked. ✅ fixed (2026-09-03) — was reported as a block ("left alone") and computed to `Desynchronized` although no ref would have been written (`would_move_ref`) |
| 21b | Refs all match but the two HEADs point somewhere different | LS | `Desynchronized: Out of step: the mirror is on 'x', the host is on 'y'` (`head_mismatch`). Reports rather than auto-checking-out — with no observed move there is no principled way to say which side follows. ✅ added (live QA): `reconcile_with` compares only **refs**, so a half-landed checkout (#19, then Retry) was green by construction |

## Initial pairing (exactly one side is a repo)

| # | Scenario | Current behaviour | Status |
|---|---|---|---|
| 22 | Dest empty, or holds only **identical** files | `git init` + full bundle + `reset --hard` → seed manifest green → propagate source's `origin` URL | ✅ improved (D7) |
| 23 | Dest holds files that **differ** from what pairing would write | Refused. `pairing_conflicts` (`ls-tree -r -l -z HEAD` + hashing) names up to 3 files + "(+N more)"; override requires explicit `git_peer_pair_confirm` | ✅ fixed (D3) — was a silent `reset --hard` clobber |
| 24 | Dest's probe **errored** (either side) | Refused: "…could not be read; refusing to auto-initialize it" | ✅ fixed (D3.4) — guard used to protect only the local side |

## Connectivity, backups, deletions

| # | Scenario | Current behaviour | Status |
|---|---|---|---|
| 25 | Pool cold / disconnected | `SyncStatus::Disconnected`, "Not connected to the remote host". No probes, pairing, or writes; early-out signatures cleared | ✅ fixed (D4) — used to report green |
| 26 | Any resolve or pairing overwrite | Tip saved to `refs/tabtivity/backup/<ts>/<branch>` — listable (`git_peer_backups`), restorable (`git_peer_restore_backup`, backs up current tip first), pruned | ✅ fixed (D6) — was write-only |
| 26b | A resolve/FF where the dest **already has the objects** (they arrived via another branch, or via the peer-tip ref) | The refs still move. ✅ fixed (live QA) — git reports "nothing to bundle" by *refusing to create an empty bundle*, and that was treated as a no-op **transfer** *and* a no-op **apply**: `resolve` transferred nothing, moved nothing, and re-reported the divergence it was asked to end |
| 27 | Committed deletion | rides the fast-forward; git removes it on the peer | |
| 28 | Uncommitted deletion | not propagated (deliberate v1 byte-sync policy) | |

## Resolved items

**#12 — stale byte-synced copy blocking a commit.** `retry_ff_clearing_identical`
was all-or-nothing: one differing file and nothing was deleted. Reachable sequence:
create `f` (v1) → byte-sync pushes v1 untracked → edit to v2 → `git add` + commit.
The commit makes `f` tracked, so `drop_tracked` stops byte-sync from ever pushing
v2 — the host was left with untracked v1, which differs from committed v2, and the
fast-forward blocked.

Fixed by `stale_byte_sync_residue` (`services/git_peer.rs`): for a colliding path
that fails the byte-identical check, look up the sync manifest's recorded base for
it (the size+mtime `divergence`/`push_decision` already trust elsewhere) and compare
against the peer's *current* stat. An exact match proves the peer's content is fully
explained by byte-sync's own prior push — nothing has touched it since — so it is
disposable regardless of differing from the incoming commit; a genuine post-push
edit on that peer changes the stat and is never treated as safe. Cleared paths have
their manifest base dropped (`forget_synced_paths`) since lockstep now owns them.

**#5/#7 — tracked-file sync model change was undocumented.** Enabling lockstep
silently converts tracked files from *continuous byte mirror* to *commit-gated*:
saving a tracked file no longer reaches the peer until committed. Intended (it's
what makes #11 and #16–19 safe); now recorded in `src-tauri/CLAUDE.md` next to the
sync/lockstep invariant.

## Live QA — done

All 28 cases have been run against a real SSH host; see
**`docs/git_lockstep_live_qa.md`** for the full log, the four bugs it found, and the
fixes. Re-run it with `src-tauri/examples/lockstep_drv.rs`:

```bash
TABTIVITY_PROJECT=<project-id> cargo run --example lockstep_drv -- <script>
```

The driver calls the same service entry points the Tauri commands call, so a case
exercised through it exercises the code that ships. It needs a live host and mutates
both trees — point it at a scratch project, never at CI.

Still uncovered: the engines' **timing** (the `.git` watcher, the 12 s poll, the 25 s
byte-sync interval — the driver invokes the passes those timers invoke, but does not
prove the timers fire), **tags**, and the **UI layer** (desync bar, pairing-conflict
dialog, the Use local / Use remote / Restore buttons).

One timing defect was found by reading rather than by the driver (2026-09-03): every
pass writes inside the mirror's `.git`, the lockstep watcher observes that directory,
and a non-green state never early-outs — so a diverged or blocked project re-ran the
full SSH pass every debounce window for as long as it stayed red. `poll_loop` now skips
a watcher burst that leaves the mirror's ref signature as the previous pass left it
(`watcher_burst_is_own`, unit-tested); the byte-sync watcher ignores `.git`/`.tabtivity`
altogether. Still not proven live — it is the timing gap above.
