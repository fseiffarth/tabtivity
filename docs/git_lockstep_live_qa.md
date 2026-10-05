# Git Lockstep — Live QA against a real SSH host (#28p)

Companion to `docs/git_lockstep_case_matrix.md`, which until now carried the line
*"Unit tests cover every pure decision function; none of this has run against a real
SSH host."* This is that run.

## How it was driven

`src-tauri/examples/lockstep_drv.rs` — an example (never CI; it needs a live host and
mutates both trees). It calls the **same service entry points the Tauri commands call**:

| Driver command | Production entry point | Tauri command it stands in for |
|---|---|---|
| `sync` / `sync-soft` | `git_peer::detect_and_sync` (forced / not) | `git_peer_sync_now`, and the poll loop |
| `pair-confirm` | `detect_and_sync` + `allow_pair_overwrite` | `git_peer_pair_confirm` |
| `resolve local\|remote` | `git_peer::resolve` | `git_peer_resolve` |
| `checkout <t> [side]` | `git_peer::checkout_lockstep` | `git_peer_checkout` |
| `backups` / `restore` | `git_peer::list_backups` / `restore_backup` | `git_peer_backups` / `..._restore_backup` |
| `bs` | `sync_auto::reconcile_once` | the byte-sync engine's pass |
| `ls-enable` / `bs-auto` | `git_peer::save_state` / manifest write | the two opt-in toggles |

Not reproduced: the UI event emits, and the engines' *timing* (the `.git` watcher, the
12 s git poll, the 25 s byte-sync interval). The driver invokes the very passes those
timers invoke — it supplies the *when*, not the *what*.

One production change was needed to get here: `sync_auto::reconcile_pass` took an
`AppHandle` it used for nothing but the completion event, so it now takes an
`Option<&AppHandle>` and `sync_auto::reconcile_once` exposes a single pass. Without it
the byte-sync half of every BS+LS case would have had to be *reimplemented* in the
driver — and a reimplementation proves nothing about the code that ships.

**Subject under test:** project `SSH Git Test` —
mirror `~/tabtivity/projects/ssh-git-test` ↔ `<remote-host>:~/projects/ssh-git-test`.
Baseline for every group: both sides clean on `master` at the same commit.

## Reading the timings

A full reconcile pass costs **~630 ms** (probe + bundle + transfer). The D5 early-out
costs **~280 ms** — the probe still runs. That gap is how the early-out is *observed*
below; it is also a correction to the matrix, which calls case 9 "zero network".

---

## Group A — creates and edits before any commit (cases 1–9): 9/9 as documented

| # | Scenario | Config | Observed | |
|---|---|---|---|---|
| 1 | create untracked `c1.txt` | – | host never saw it | ✅ |
| 2 | create untracked `c2.txt` | BS | pushed; host `git status` → `?? c2.txt` | ✅ |
| 3 | create untracked `c3.txt` | BS+LS | **still pushed** — not in the index, so `drop_tracked` can't see it | ✅ |
| 4 | edit tracked `README.md` | BS | pushed; host content replaced | ✅ |
| 5 | edit tracked `TODO.md` | BS+LS | **not pushed**; host still `# TODO` | ✅ |
| 6 | host creates untracked `host6.txt` | BS+LS | pulled into the mirror | ✅ |
| 7 | host edits tracked `ROADMAP.md` | BS+LS | **not pulled**; mirror still `# Roadmap` | ✅ |
| 8 | `git add c3.txt` | LS | dirty bit 0→1 ⇒ signature moved ⇒ **full** pass (636 ms), and it transferred nothing: host head unchanged, `c3.txt` still `??` there | ✅ |
| 9 | `.git` touched, refs+dirty unchanged | LS | `git status` rewrote `.git/index`'s stat cache; next passes early-outed (281 ms, 272 ms), stayed green | ✅ |

Cases 5 and 7 are the invariant working in both directions: **lockstep owns the tracked
tree, byte-sync owns everything else.** Case 3 is the documented seam between them — a
file is "tracked" only once it is in the *index*, so a brand-new file still rides
byte-sync until the first `git add`.

Case 4 left a real artifact worth naming: with lockstep off, byte-sync pushed
`README.md`'s new bytes to the host, where they sat **uncommitted**. That is exactly the
shape case 12 is about, and it arose here by accident — which is the point of that case.

---

## Group B — commits (cases 10–15): 5/6 as documented, **case 15 was broken**

| # | Scenario | Observed | |
|---|---|---|---|
| 10 | local commit, nothing byte-pushed | host ff `08cd8ab → 32ff917`, `f10.txt` tracked+clean there | ✅ |
| 11 | local commit over an **identical** byte-pushed copy | host held `?? f11.txt`; ff refused; `retry_ff_clearing_identical` proved identity, cleared it, retried → green at `97d59d7` | ✅ |
| 12a | local commit over a **differing** byte-pushed copy | byte-sync pass confirmed it would *not* push v2 (tracked); `stale_byte_sync_residue` proved the host's v1 was its own untouched push → cleared → ff to `9f80525`, v2 on disk | ✅ |
| 12b | …but the host copy was **independently edited** | **refused**, exactly as it must: `'master' can't fast-forward: untracked file(s) on the peer differ from the incoming commit: f12b.txt`. Host head did not move; the host's edit survived byte-for-byte | ✅ |
| 13 | local commit, BS only | bytes crossed (`?? f13.txt`), history did **not** (host head unchanged) | ✅ |
| 14 | commit made **on the host** | mirror fast-forwarded to `f085ef9`, `f14.txt` present and clean | ✅ |
| 15 | **both sides commit on `master`** | reported **`Synchronized`** — a false green over a real divergence | ❌ → fixed |

Case 12b is the one that matters most: the residue heuristic is doing real proof, not
blanket clearing. A file byte-sync pushed and nobody touched is disposable; the same file
after a human edits it on the host is not, and the fast-forward fails closed and names it.

### The bug: every genuine divergence reported green

`transfer_and_apply` builds a thin bundle by delta-excluding the shas the dest already
has: `git bundle create … --not <dest tips>`. Those excludes are passed to the **source**,
which in a divergence has *by definition never seen the dest's tip* — so git aborts the
whole bundle with `unknown revision`. That failure is then swallowed by

```rust
if !out.status.success() {
    // Nothing to bundle (e.g. dest already has everything) is reported by git as
    // an error on an empty rev range — treat as a no-op transfer.
    return Ok(result);
}
```

whose comment assumes the only way bundling fails is the benign empty-range case. Both
legs abort identically, `diverged` stays empty, and the pass computes to `Synchronized`.
`decide()` — which the unit tests cover thoroughly — is never reached at all, which is
exactly why 3 400 lines of well-tested pure logic never caught this.

Consequence: two histories drift apart under a green pill, the desync bar never appears,
and Use local / Use remote is never offered. Observed live: mirror `945db03`, host
`3991824`, status `Synchronized`.

**Fix** (`known_shas`): filter the excludes to the shas the source actually has, via one
`git rev-list --no-walk --ignore-missing` round trip. Excludes are only a bundle-size
optimization, so dropping an unknowable one costs bytes and never correctness — a
divergence now simply sends a full bundle, the dest fetches both histories, and `decide`
reaches `Diverged` as designed. Second, the two transfer legs no longer discard an `Err`
(`if let Ok(r) = …`), which had the same green-on-failure shape; a failed leg is now
surfaced as `blocked`.

Re-running the *same* still-diverged repo against the fix:

```
sync    → status=Desynchronized  local=master@945db032  remote=master@39918242
          detail: Diverged: master
mirror  refs/tabtivity/peer/master -> 3991824      # host's tip parked locally
host    refs/tabtivity/peer/master -> 945db03      # mirror's tip parked on the host
        …and neither head moved.
resolve local → green; host reset to 945db03, its f15-host.txt gone from the worktree,
                overwritten tip preserved at refs/tabtivity/backup/1783938132/master.
```

---

## Group C — checkouts (cases 16–21): 5/6 as documented, **case 17 was broken**

| # | Scenario | Observed | |
|---|---|---|---|
| 16 | checkout a branch locally | host followed onto `feat-x`, `f18.txt` appeared there | ✅ |
| 17 | checkout **on the host** | mirror did **not** follow, and the pass reported green with the two sides on different branches | ❌ → fixed |
| 18 | new branch + commit locally | `CreateOnDest` → host checked `feat-x` out too, at the same sha | ✅ |
| 19 | peer has dirty **tracked** changes | host's guarded checkout refused, carrying git's **actual** stderr: `Your local changes to the following files would be overwritten by checkout: README.md`. Host stayed on `master`; its uncommitted work survived | ✅ |
| 20 | FF a branch **not checked out** on the peer | host's `feat-x` ref moved to `cde335d` by plain `update-ref`; host HEAD still `master`, and `f20.txt` never appeared in its worktree | ✅ |
| 21 | detached HEAD | host detached at the same sha; both sides `DETACHED@945db03` | ✅ |

### The bug: a coordinated checkout left a stale peer head, which masked the peer's next one

`checkout_lockstep` reconciles refs (step 2) and only *then* checks the peer out (step 3),
but it returned the state computed at step 2 — so it persisted a peer head one checkout
out of date. That is not just a wrong pill. `detect_and_sync` decides *"did the peer's HEAD
move?"* by comparing a fresh probe against exactly that stored value, so a stale one
**masks the peer's very next checkout** — and permanently, because the stale state then
agrees with the probe and no later pass sees a move either.

Underneath it sat a second hole: `reconcile_with` compares only **refs**, never HEAD. Two
peers sitting on different branches with identical refs is `Synchronized` *by construction*.
So the mirror stayed on `master`, the host sat on `feat-x`, and nothing ever noticed.

The same hole made case 19 unrecoverable in a subtler way: after the host's checkout was
refused, every ref still matched, so clearing the dirt and hitting Retry reported **green**
while leaving the host on the wrong branch.

**Fixes:**
1. `refresh_heads` — re-probe both peers after a checkout actually moves a HEAD, so the
   persisted heads (and, when green, the early-out signatures) describe reality.
2. `head_mismatch` — a new terminal rule in the status chain: refs agree but the HEADs
   point somewhere different ⇒ `Desynchronized: Out of step: the mirror is on 'x', the host
   is on 'y'`. It *reports* rather than auto-checking-out: with no observed move there is no
   principled way to say which side should follow, and lockstep never rewrites a worktree it
   wasn't asked to. The Checkout action is one click away.
3. `ReconcileOpts::mid_checkout` — suppresses that rule inside `checkout_lockstep`'s own
   reconcile, where the two HEADs are *expected* to disagree for the duration. Without it the
   new rule fired on that normal intermediate state and left its stale red on a checkout that
   had in fact succeeded.

After the fix: the host's switch to `feat-x` brought the mirror with it; the blocked case-19
state reports `Out of step: the mirror is on 'feat-y', the host is on 'master'` instead of
green, and the Checkout action then completes it.

---

## Group D — initial pairing (cases 22–24): 3/3 as documented

The host's repo was destroyed and re-paired from the mirror for each of these (it was
`tar`'d aside first; the mirror holds the full history, which is the point).

| # | Scenario | Observed | |
|---|---|---|---|
| 22a | dest **empty** | `git init` + full bundle + `reset --hard` → all three branches and every file restored at `e71d38b`, clean, no spurious `origin` | ✅ |
| 22b | dest holds only **identical** files (no `.git`) | paired cleanly, worktree already correct, green | ✅ |
| 23 | dest holds files that **differ** | **refused**: `Pairing would overwrite 2 file(s) on the host that differ: README.md, TODO.md`. Both files untouched, and it did not even `git init`. `pair-confirm` then overrode it deliberately and the host took the committed content | ✅ |
| 24 | dest's probe **errored** | **refused**: `Remote host repository could not be read; refusing to auto-initialize it.` Host untouched, still a repo; green again once readable | ✅ |

Case 24's *cause* is simulated — the driver hands `detect_and_sync` a spec whose
`remote_path` fails `validate_arg`, so `run_remote_script` returns `Err`. That is exactly
the input which sets `PeerSnapshot::probe_error` on a remote peer, so the guard under test
and the refusal it produces are the real ones; only the reason the probe couldn't run
(rather than a flaky link or a missing `git`) is synthetic.

---

## Group E — connectivity, backups, deletions (cases 25–28): 3/4, **case 26 was broken**

| # | Scenario | Observed | |
|---|---|---|---|
| 25 | pool cold | `Disconnected` + "Not connected to the remote host", in **0 ms** — it bailed before probing, kept the last-known heads, claimed nothing | ✅ |
| 26 | backups listable + restorable | listable ✅, restorable ✅ (host went back to the discarded tip, worktree and all), and the restore was itself backed up. But the **`resolve` that follows it silently did nothing** | ❌ → fixed |
| 27 | committed deletion | rode the fast-forward; `f10.txt` removed on the host, tree clean | ✅ |
| 28 | uncommitted deletion | not propagated — host kept the file. The engine logged the documented mechanism: `push skip 'del28.txt': No such file or directory` | ✅ |

### The bug: an empty bundle skipped the ref update, not just the transfer

`git` refuses to create an **empty** bundle, which is how it reports *"the dest already has
every object I would have sent"*. `transfer_and_apply` treated that as a no-op and returned
— skipping step 4, the ref application. But a no-op *transfer* is not a no-op *apply*: the
dest's refs still have to move onto those objects.

Hit live by `resolve local`: the host already had the winning commit (via a descendant
branch and its own backup refs), so the bundle came out empty, so nothing was transferred
**and nothing was updated** — the resolve reported the very divergence it had just been
asked to end. It is not specific to resolve: any branch whose commits reached the peer via
another branch would fail to have its ref moved.

Note this only became reachable *because* the divergence fix worked: parking the peer's tip
is what gives the host the objects that make the bundle empty. It also explains why the
first `resolve` (case 15) worked and the second didn't — the `feat-*` branches created in
Group C were descendants of `master`, so their exclusion covered `master`'s objects.

**Fix:** only the transfer (`move_bundle` + `fetch`) is skipped when there is nothing to
send; step 4 always runs.

---

## Summary

**28/28 cases now behave as `docs/git_lockstep_case_matrix.md` documents.** Four did not
when first run live, and all four were the *same shape*: **a no-op or failure in the
transport computing to `Synchronized`.**

| Bug | Blast radius |
|---|---|
| Excludes the source doesn't have abort the bundle ⇒ **every genuine divergence reported green**, desync bar never shown, Use local / Use remote never offered | two histories drift apart silently, forever |
| Transfer legs discarded their `Err` (`if let Ok(r) = …`) | any failed transfer reported green |
| Coordinated checkout persisted a stale peer head ⇒ **masked the peer's next checkout**; and `reconcile_with` never compared HEADs at all | the two sides sit on different branches under a green pill, permanently |
| An empty bundle skipped the **ref application**, not just the transfer | `resolve` (and any ref whose objects arrived via another branch) silently did nothing |

None of these were reachable by the existing unit tests, which are thorough over the *pure
decision functions* — `decide`, `can_early_out`, `blocked_detail`, the parsers. Every one of
these bugs lives in the I/O orchestration *around* those functions, and three of the four
prevented `decide` from ever being called. That is the gap this run existed to close, and it
is the argument for keeping `lockstep_drv.rs` around.

New regression coverage: `head_mismatch` is pure and unit-tested (3 cases). The other three
fixes are in async I/O paths; they are covered by this driver, not by `cargo test`.

## Still not covered

- The **engines' timing** — the `.git` watcher, the 12 s git poll, the 25 s byte-sync
  interval. The driver invokes the passes those timers invoke; it does not prove the timers
  fire. (Case 8/9's *content* — dirty-bit signature and early-out — is covered.)
- **Tags.** The matrix never mentions them; `transfer_and_apply` and `resolve` both handle
  them, and nothing here exercised one.
- The **UI layer**: the desync bar, the pairing-conflict dialog, and the Use local / Use
  remote / Restore buttons were never clicked — only the commands behind them were called.
