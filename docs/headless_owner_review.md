# Headless owner implementation review — 2026-10-02

Review of the implementation described in [the plan](headless_owner_plan.md)
and [the handoff](headless_owner_handoff.md), covering shared tab persistence,
desktop reconciliation, timer ownership and headless launches. The review
started at `395dc96b` on `develop`, with existing local changes; the checkout
was being updated during the review. No application source was changed by
the reviewer, and Tabtivity was neither started nor stopped.

When this document was written, `develop` had reached `74798f5d`. A source
check at that revision confirmed a subsequent fix for finding 1; the code
responsible for findings 2–4 remained present. The original reproductions
and full gates were not rerun against that later revision.

| Finding | Priority | Status at `74798f5d` |
|---|---|---|
| 1. Headless launches wrap tmux twice | P1 | Fixed by `456f2de2` |
| 2. Sync responses overwrite newer tab state | P2 | Still present in source |
| 3. Desktop persistence reverses owner tab reordering | P2 | Still present in source |
| 4. Expired timer leases still authorize execution | P2 | Still present in source |

## 1. Headless launches wrap tmux twice

**Location:** `HeadlessSpawner::default` in
[host.rs](../src-tauri/src/services/mobile_control/host.rs),
`launch_prep::prepare` and `tmux_local::spawn_detached_with`.

`prepare()` already called `wrap_pty_options_local`, leaving `cmd = "tmux"`
and the complete session-creation arguments. The headless spawner passed
those options to `spawn_detached_with()`, which wrapped them again. The
outer session started successfully, but its command was another tmux client
trying to attach to the same session. That client refused to nest and fell
through to the trailing login shell, so the requested agent never started.
Create, reopen and scheduler restarts shared this launch path.

**Evidence:** a scratch executable linked against the built Rust library
called the same wrapping and detached-spawn functions on a private tmux
socket. The spawn returned `Ok(())`, but a harmless marker command never
ran. The captured pane displayed “sessions should be nested with care,
unset $TMUX to force”. The private server was removed afterwards; no live
app session was used. The existing detached-spawn test supplied unwrapped
options and therefore missed the production composition.

**Subsequent fix:** `456f2de2` introduced `tmux_local::detached_argv`, which
reuses prepared tmux arguments and adds detached mode without wrapping
again. It also added
`a_prepared_launch_is_detached_without_a_nested_tmux`. The fix was inspected
when writing this document; it was not tested live by this review.

## 2. Sync responses overwrite newer tab state

**Location:** `adoptSyncOutcome` in [tabs.ts](../src/stores/tabs.ts),
particularly label/colour reconciliation and the assignment to
`workspaceVersionByScope`.

The function unconditionally copies returned labels and colours into the
current store. If a save is pending when the user renames a tab, its response
replaces the newer local name with the value sent before that rename. The
queued next save then sees the reverted value. Serializing saves does not
protect edits made while a save is awaiting its response.

There is also no version guard at this entry point. A newer workspace patch
can be adopted while an older sync response is pending; that older response
then restores older fields and moves the recorded version backwards.

**Evidence:** scratch tests reproduced both sequences: a pending save's
answer changed “New name” back to “A”, and adopting version 5 followed by a
delayed version 4 response restored the old label and recorded version 4.

**Suggested correction:** reject obsolete responses and reconcile fields
against the snapshot actually sent, preserving local edits made since that
snapshot. Cover pending edits and patch/response ordering separately.

## 3. Desktop persistence reverses owner tab reordering

**Location:** `reorder_tab_in` in
[workspace.rs](../src-tauri/src/services/workspace.rs), plus
`adoptSyncOutcome`, `loadFromLayout` and `persistScope` in
[tabs.ts](../src/stores/tabs.ts).

The owner reorders `tab_layout`, but leaves the saved group tree unchanged.
An already loaded desktop also adopts the owner's new version without
reconciling its order. `persistScope` derives the next tab list from the
desktop's group tree, so its next save sends the old order with the new
version and reverses the owner's change. On reopening a window, the saved
group tree likewise retains the old order.

**Evidence:** a scratch test adopted an owner result ordered `[B, A]`, then
called `persistScopeStrict`. The outgoing `workspace_sync` contained
`[A, B]` and the newly adopted base version.

**Suggested correction:** define how the shared order maps into client pane
layouts and preserve it through reconciliation and restoration. A client
with an unchanged pane tree must not report that tree's older order as a
new reorder operation.

## 4. Expired timer leases still authorize execution

**Location:** `probe` and `holdsTimerLease` in
[timerLease.ts](../src/stores/timerLease.ts).

The backend grants a lease with an expiry, but the frontend ignores
`expiresAt` and retains its last `held` value when renewal fails. After the
30-second lease expires, another window can acquire it while the original
window still considers itself authorized to run timers. Initialization also
assumes ownership before the first grant arrives.

Scheduled prompts have a separate durable claim, which limits duplicate
delivery there. Cron warmups and auto-continue rely on the window lease and
can run from both windows.

**Evidence:** a scratch test granted a 30-second lease, advanced the clock
31 seconds, and rejected renewal with a lock error. `holdsTimerLease()`
still returned `true`.

**Suggested correction:** retain and enforce the expiry locally and require
a confirmed grant before authorizing timers. Keep compatibility with a
backend lacking the command explicit; ordinary renewal failures must not
extend ownership.

## Verification and limits

The original review ran these repository gates:

| Check | Result |
|---|---|
| `npm run build` | Passed; emitted build warnings |
| `npm test -- --reporter=dot` | 689 files, 6,998 tests passed |
| `cargo test -q --manifest-path src-tauri/Cargo.toml` | 3,381 tests passed across the reported test targets |
| `npm run lint` | Zero errors, 31 warnings; did not meet the zero-warning requirement |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Passed |
| `scripts/brand-check.sh` | Passed |
| `git diff --check` | Passed |

Four additional scratch tests demonstrated the two reconciliation races,
the reorder reversal and expired lease authorization. Their assertions
confirmed the faulty behavior; passing those tests does not mean the
implementation was correct. The separate private-socket check demonstrated
the launch failure using the built library.

Scratch files were kept under `/tmp`, outside the repository. No live
desktop/phone acceptance test was performed. These results describe the
reviewed checkout, not a fresh validation of every subsequent commit.
