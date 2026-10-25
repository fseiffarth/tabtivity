# Auto-sync safety improvement plan

Status: proposed, 2026-10-20. Source review at `2920161b` on `develop` by three
collaborating agents covering conflict detection, recovery, and coordination.
Revised 2026-10-23: every anchor re-read at `63676f77` (no sync, Lockstep or lease
code changed since the review); one anchor corrected, five findings added, findings
mapped to phases, interim behavior and install primitives made explicit.
This document changes no sync behavior. Findings below are from code inspection;
the races have not been reproduced and no live project was used.

Related: [sync guide](remote_sync_guide.md), [sync rationale](context/git_sync.md),
[remote backlog](../todo/group-g-remote.md) ("Auto-sync safety and recovery").

## Goal and limits

Make automatic file transfers conservative about overwriting work, retain
recoverable versions before replacement, and stop reporting a file as synced
unless the recorded baseline describes the bytes actually transferred.

Keep the existing ownership split: Git Lockstep owns tracked files while enabled;
byte-sync owns explicitly selected remaining paths. Keep background deletion
disabled, exclusions effective, and HPC hosts free of background sync loops.

Separate three claims in implementation and UI:

- Coordination prevents this app's own transfers and Git operations from racing.
- Recovery retains the versions captured by a transfer, within a disclosed quota.
- Protection against arbitrary external writers requires stronger filesystem or
  transport primitives than a stat/hash followed by an ordinary rename.

An editor, agent, or remote job need not honor this app's locks. Hashing and a
last-minute recheck narrow that race but do not eliminate it. Even moving a
destination into recovery can leave an already-open file descriptor writing to
the displaced object. Do not promise a consistent snapshot of a file being
modified in place, or protection from machine loss through same-machine history.
Nothing below is compare-and-swap unless a tested primitive makes it one.

## Findings to address

Anchors are under `src-tauri/src/services/` unless qualified. Manual paths are in
`src-tauri/src/commands/sync.rs`; merge apply is in
`src/components/embed/SyncMergeView.tsx`. **Ph** is the phase that fixes the row.

| Pri | Ph | Current behavior and code anchor | Consequence |
|---|---|---|---|
| P0 | 1 | `sync_auto::reconcile_pass` reuses directory-walk size/mtime (`walked_host_meta`), and `push_decision` judges that same observation | A host edit after the walk is overwritten despite the apparent second check. |
| P0 | 1 | Auto-sync folds a remote stat error into `None`; `push_decision(entry, None)` answers `Safe` for a never-synced entry. Manual `sync_push` does the same through `metadata_on(..).ok()` | A host file that exists but could not be stat'd (permissions, dropped session) is overwritten as a "create". |
| P0 | 1 | `sftp::metadata_on`/`metadata_opt_on` report a missing size attribute as `0` | Unknown size reads as an empty file and can match or miss a recorded base. |
| P0 | 2 | Every transfer records bases re-stat'd after installation: push re-stats the host after the rename (`push_file_atomic`) and the mirror after the upload; pull stats the mirror after the write (`pull_file_with`); `sync_resolve_if_identical` stats both sides after comparing and substitutes `(len, None)` on a failed host stat | An edit on either side in that window becomes the recorded clean baseline though those bytes never crossed; the next transfer then overwrites it. |
| P0 | 2 | `remote_sync::pull_file_with` reads then replaces the mirror without checking the receiver again; `push_file_atomic` replaces after a separate check | A receiver edit between check and installation is lost. |
| P0 | 1 | `git_peer::tracked_paths` returns an empty set on probe failure, and `drop_tracked`/`drop_tracked_files` treat an empty set as "Lockstep owns nothing" | A failed ownership probe lets byte-sync touch Lockstep-owned files. The test `lockstep_off_changes_nothing` asserts this fallback and must change deliberately. |
| P0 | 1 | `sync_auto::pause` sets a flag read only at pass start, without draining an active pass, and is not a guard (a dropped caller never resumes); `stop` drops a timed-out join handle and releases the lease | Git checkout or a new loop can overlap an old transfer that is still running. |
| P0 | 1 | Background byte/Git leases are separate, manual paths share no writer guard, and `process_lease::claim_at` answers `true` on a lock error | Existing guards do not establish exclusive ownership of project mutations. |
| P0 | 1 | Status healing in `sync_status` applies content rebases without checking the entry is still what was stat'd (its prunes do check) | A stale status pass can replace a newer transfer's baseline. |
| P1 | 2 | `remote_sync::divergence`/`push_decision` compare size and timestamps at second precision | Different bytes with the same metadata escape detection. |
| P1 | 1 | `remote_sync::load_manifest` and `ensure_loaded_at` fall back to an empty manifest on parse failure, and the next save's compare-and-swap passes against the corrupt file's stamp | Corruption hides configuration loss and the next save replaces the damaged file. |
| P1 | 3 | `local_loss` stores bounded path notifications, not file contents, excludes automatic transfers, and records manual-pull overwrites with no recovery source | Warnings provide no recovery for overwritten uncommitted bytes. |
| P1 | 4 | Manual rsync pulls target the live mirror; `sync_push` with `force` replaces the host file unconditionally; merge apply writes the mirror, then force-pushes using separately obtained snapshots | Safer auto-sync primitives alone leave bypasses and races through manual actions. |
| P1 | 4 | Lockstep's cleared fast-forward retry (`git_peer::retry_ff_clearing_identical`) checks untracked blockers, then runs `git clean` on them as separate steps; `ClearedButFailed` leaves them deleted | A byte-sync or editor write between the check and the clean is deleted. |
| P1 | 2 | `sftp::read_file_on` buffers the whole file before the 64 MiB cap is checked; `push_file_atomic` checks size by metadata, then reads unbounded | A file growing during capture exceeds the memory bound the cap is meant to give. |
| P1 | 5 | Local staging flushes buffers before rename but does not provide the full durable-write protocol; remote rename has no demonstrated fsync guarantee | Atomic replacement is not evidence of power-loss durability. |
| P2 | 1 | `tracked_paths` reads only the local index and converts names with `from_utf8_lossy` | A non-UTF-8 tracked name, or a path the host tracks first, is not excluded from byte-sync. |

Preserve existing behavior until a particular replacement is implemented and
verified; these are audit findings, not claims that the proposed safeguards
already exist.

## Interim behavior

User decision, 2026-10-23. Today automatic replacement is already on: auto-sync
pulls and pushes over existing files under the size/mtime policy. The plan does
not switch it off while
the phases land. Phase 1 and 2 changes only make the existing paths more
conservative (an unknown answer defers instead of writing; a baseline comes from
captured bytes), so they ship as soon as each is verified. The "defer automatic
replacement without a tested protocol" default below takes effect in phase 5,
together with the new install path, so no release regresses auto-sync to
"conflict on every edit" before the replacement exists.

## Shared transfer protocol

All automatic, manual, merge, restore, and delete operations must use one backend
mutation boundary. A preview or renderer confirmation is not an authorization to
overwrite a version that appeared afterward.

1. **Acquire ownership.** Take the project operation guard and strict
   cross-process mutation lock. Reload the manifest generation, remote target,
   path scope, exclusions, and Git ownership. An unreadable probe or unavailable
   lock defers the operation; it never means an empty tracked set or absent file.
2. **Observe both sides.** Represent `Present`, positively `Missing`, and `Unknown`
   separately, including missing required attributes. Directory-walk metadata is
   discovery information; it cannot authorize a replacement.
3. **Stage the source.** Copy bounded source bytes into a private staging object,
   hash those exact bytes with the existing `sha2` dependency, and observe the
   source before/after capture. If it changes, defer and retry with a bound. Keep
   the staged version immutable to this app. Arbitrary concurrent in-place writes
   still require a snapshot or writer cooperation for a strict consistency claim.
4. **Check the receiver and prepare recovery.** Hash a stable receiver and compare
   it with the verified common baseline or the explicit version token approved by
   the user; positively missing receivers instead require exclusive creation.
   On the host this hash is a full SFTP read (no remote hash command is assumed);
   keep those bytes as the copied preimage instead of reading the file twice.
   Reserve recovery space and durably record the intent, intended staging/recovery
   object ids, and recoverable receiver version before replacement. Also retain
   the staged incoming version.
5. **Revalidate and install.** Recheck scope/manifest generation and receiver
   identity immediately before installation. Use only a capability-tested install
   protocol (below). A recheck plus ordinary rename is limited protection.
   Unsupported protected automatic replacement is deferred with a visible reason,
   rather than silently falling back to unconditional rename. Verify the actual
   captured receiver against the expected baseline/token, too; a different
   displaced version is a conflict even if both versions were retained.
6. **Verify and record.** Verify installed bytes and commit a transfer receipt
   containing operation id, staged digest, observed source version, displaced
   destination version, and installed digest. Update the common baseline only from
   this evidence. A subsequent source or receiver edit stays pending; never use a
   later stat of either side as proof of the transferred bytes.
7. **Finish or recover.** Mark completion durably. Disconnect, cancellation, an
   ambiguous remote response, or manifest failure leaves an incomplete operation
   for reconciliation. Do not retry a mutation blindly or overwrite a new receiver
   as part of rollback. Never display an indeterminate result as green.

### Installation capability decision

Prototype and test local Linux/macOS/Windows and supported SFTP server behavior
before enabling the new overwrite path. Two protocol shapes are candidates:

- **Atomic receiver capture**: exchange or replace-with-backup, so the displaced
  object is exactly what stood at the path when the install happened.
- **Move aside, then exclusive install**: rename the actual receiver to a unique
  recovery name, then install with a no-clobber primitive. This exposes a brief
  missing path, needs same-filesystem support, and leaves open descriptors writing
  to the displaced object.

Candidate primitives, each to be tested, not assumed:

| Side | Exchange / backup | No-clobber install | Notes |
|---|---|---|---|
| Linux | `renameat2(RENAME_EXCHANGE)` | `renameat2(RENAME_NOREPLACE)`, `link`+`unlink` | Not every filesystem supports the flags (network filesystems, older kernels); detect per mirror, `EINVAL` means unsupported. |
| macOS | `renamex_np(RENAME_SWAP)` | `renamex_np(RENAME_EXCL)` | Supported on APFS; verify on the mirror's volume. |
| Windows | `ReplaceFileW` with a backup name | `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` | Replacing a file another process holds open without delete sharing fails; that failure is a deferral, not an error to retry in a loop. |
| SFTP | OpenSSH's `hardlink` extension captures the receiver's inode before a replace | Plain v3 `SSH_FXP_RENAME`: OpenSSH's `sftp-server` implements it as `link`+`unlink`, which refuses an existing target (a racy stat+rename only on filesystems without hard links) | `openssh_sftp_client::Fs::rename` sends OpenSSH's `posix-rename` extension whenever the server advertises it, so today's push is an unconditional overwrite and `Fs::rename` alone cannot request no-clobber. The `fsync` extension is the only durability hook. Servers other than OpenSSH must be classified individually. |

A hard link captures in-place writes to the receiver but not an editor's
rename-over save between the link and the install; only the move-aside shape
captures whatever object is at the path. Pick per backend from test results.

Recovery storage must be app-controlled and outside project/agent writable
trees. On the host, same-filesystem capture conflicts with that: a captured
object must sit beside the receiver, inside the remote project tree. Treat the
host-side object as short-lived staging and keep the durable recovery copy in the
local store, verified by digest against the captured object. If the filesystem
cannot capture the displaced object atomically, a copied preimage is a weaker
capability; do not hide that distinction. A remote helper, if needed, requires a
separate design review of deployment, permissions, portability, and failure
recovery. Do not silently require new host tooling.

Default fallback (from phase 5, see Interim behavior): defer automatic
replacement of an existing file when the required preservation/install capability
is unavailable. Manual resolution can explain the limit and offer
compare/export/keep both. Replacing the current path still requires a tested
preservation/install protocol; this plan introduces no weaker manual overwrite
exception, and a confirmation cannot authorize destroying an unseen later edit.
New-file creation also needs an exclusive/no-clobber primitive, not an absence
check followed by overwrite. Do not use unconditional rollback to restore a path.

## Implementation phases

Each phase lands and is verified on its own; later phases build on, never replace,
the earlier ones' guarantees.

### 1. Fail closed and serialize mutations

Split for landing (user decision, 2026-10-23):

- **1a, fail-closed probes** — implemented 2026-10-23, not live-verified:
  strict tri-state host stats (`sftp::metadata_opt_{,with_mode_}on`, no size =
  `Err`) in the auto pass and manual push, a fresh host stat before each auto push,
  `tracked_paths` → `Result` with deferral while Lockstep is on, unreadable
  `sync.json` kept and never replaced (`remote_sync::check_manifest_readable`,
  gated in `commands::sync::resolve`), `process_lease::claim_sync` for the two sync
  loops, and revision-checked status heals (`apply_status_heal`).
- **1b, the operation guard** — implemented 2026-10-23, not live-verified:
  `services::sync_op` (in-process mutex + `<state_dir>/leases/` file lock),
  replacing `git_peer::reconcile_guard`, held whole by the auto pass, manual
  pull/push/delete/resolve-if-identical, the lockstep pass and every lockstep
  command; one lock, so no order to get wrong. The auto pass re-reads each
  entry and its auto marker under the manifest lock before acting (the marker
  setters do not wait for a pass). `sync_auto::pause` returns a nesting
  `PauseGuard`; a stop that times out leaves the task registered as stopping,
  `process_lease::RunnerExit` releases the lease only when the task ends, and
  `start` defers behind it (both loops), dropping the restart when a newer stop
  came meanwhile; a loop stopped while it waited for the lock runs no pass.
  Every holder resolves its target and session after taking the lock, and a
  project detach/extend (`clear_host_bound_state`) takes it too. Reviewed by an
  independent subagent pass; its findings are fixed. Not covered: alias
  detection of one checkout under two registrations; status heals and the
  marker setters (lock-free by design: heals are revision-checked, the pass
  re-reads markers); `remote_upload_file` (the file manager's upload into the
  host tree). Unit tests cover the lock, the pause guard, a timed-out stop and
  the restart decision, not a live loop's deferred restart. Unreadable-manifest errors are not yet shown in the
  status view (`sync_status` failures stay silent; phase 4 surfaces blocked work).

- Add one per-project async operation coordinator plus an advisory cross-process
  mutation lock covering auto/manual bytes, merge apply, recovery restore/delete,
  selection/scope/exclusion setters, status healing/baseline writes, and Lockstep
  working-tree/ref mutations. Start with project-level serialization;
  optimize to finer locks only after measurements demonstrate a need.
- State the lock's identity boundary explicitly: processes sharing the same state
  directory/project id coordinate. Detect aliases to the same physical checkout
  or canonical remote endpoint, or classify independent registrations/installations
  as external writers. A project-id mutex alone cannot promise endpoint exclusivity.
- Define lock order: project operation guard and process lock, then the existing
  `git_peer::reconcile_guard` when needed, then short-lived manifest locks.
  Refactor public wrappers and internal helpers to avoid reacquiring the outer
  guard. Do not hold a manifest mutex across network I/O or await user
  confirmation while locked.
- Keep background-loop election separate from operation ownership. Make lock
  acquisition errors explicit in `claim_at` for the sync keys only; its other
  caller, the VM runner (`services::vm`), keeps its semantics until reviewed on
  its own. Pause becomes a guard that waits for the in-flight pass to drain and
  resumes on drop; stop cancels and joins, or retains ownership until a supervised
  task actually exits. A timeout must never detach a writer and advertise the
  project as free.
- Extend the existing tri-state SFTP probing (`metadata_opt_on`) to the auto and
  manual push paths; keep a missing size attribute `Unknown` instead of `0`, and
  make `push_decision` refuse to create over `Unknown`. Make tracked-file discovery
  return `Result`, keep raw path bytes, and recheck ownership/exclusions under the
  operation guard; with Lockstep enabled, a failed probe defers the pass. Target
  changes invalidate plans.
- Treat a corrupt/unreadable existing manifest as an error, preserve its original
  bytes, and pause writes; only a positively missing manifest permits initialization.
  Serialize status healing and require its observed revision to remain current.
- Add deterministic regression tests for these failure paths before changing the
  transfer representation; rewrite `lockstep_off_changes_nothing`'s empty-set case
  to assert the new deferral. No new "safe sync" UI claims at this stage.

Ships when: every P0/P1 row marked phase 1 has a failing-then-passing test.

### 2. Record verified content, not later metadata

- Extend `SyncEntry` additively with versioned, optional SHA-256 common-content
  data and explicit verification state. Keep old fields and serde defaults;
  round-trip existing JSON and preserve every selection/exclusion marker.
  Detect incompatible concurrent writers/older binaries before mutation; a format
  addition must not let an older process silently strip verification data.
- Use full available local timestamp precision and file identity as hints. Remote
  seconds/size remain hints. A stable content check is mandatory before overwrite.
- Return a structured transfer receipt from pull/push instead of post-transfer
  stat tuples. Apply it to auto, manual, status healing, `sync_resolve_if_identical`
  and seeding after Git checkout; verify before adopting a content baseline there
  too. A failed host stat records no base, never a fabricated one.
- Legacy entries without a digest are unverified. A stable equal pair can seed
  the baseline; differing or unreadable pairs require resolution. Never invent a
  common base from which side has the newer clock or from matching metadata.
- Budget periodic content verification so same-metadata edits are eventually
  discovered. Show unverified/stale status until checked; metadata-only polls do
  not establish equality. Bound hashing, memory, retries, and concurrency, respect
  connected/HPC gates, and enforce the 64 MiB limit while reading (streamed reads
  that stop at the cap), not only before.

Ships when: no code path records a base from a stat taken after the bytes were
read, and legacy manifests round-trip unchanged.

### 3. Preserve versions and recover incomplete operations

- Introduce a separate backend recovery service and durable journal. Reuse strict
  file locking and private atomic storage primitives, auditing fsync/error handling
  rather than assuming ordinary atomic JSON writes provide every guarantee.
- Journal at least prepared, receiver-preserved, installed, verified,
  manifest-committed, and completed states. Persist the intended staging and
  receiver-preservation object ids/locations before the first receiver mutation,
  so recovery handles a crash after rename but before its journal transition.
  Completion requires durable evidence of manifest commitment, not just installed
  bytes. An immutable receipt references private blobs and validated project-relative
  paths. Retain digests and provenance for both sides; raw project-controlled paths
  must never select arbitrary recovery files or deletion targets.
- Reconcile incomplete operations before starting new writes after reconnect or
  restart. Resolve ambiguous remote outcomes by reading state, not by blindly
  repeating rename/delete. Keep incomplete and conflicted versions pinned.
- Proposed configurable defaults: 30-day retention target, 2 GiB/project and
  10 GiB overall hard budgets. Reserve bytes for receiver history, incoming staging,
  and journal overhead before writing. Prune eligible completed versions first;
  never evict pinned unresolved/incomplete operations to make a transfer proceed.
  If capacity cannot be reserved, pause the affected transfer and explain why.
- Acknowledging a notification only marks it read. History deletion is separate.
  Restore defaults to a separate copy; replacing the current file uses this same
  protocol and first preserves it. Keep recovery private, owner-only where supported,
  outside synced/agent-mounted roots. Do not claim encryption at rest or
  independent backup.
- Keep `local_loss` as a notification compatibility layer; do not use its truncated,
  best-effort metadata log as the durable journal. Emit loss/recovery notifications
  based on completed operations, not before a transfer that might fail. A manual
  pull over unsynced local edits preserves them here first, so its warning can name
  a recovery source instead of `None`.

Ships when: a fault injected at every journal boundary restarts into a
recoverable state, and the budgets hold under the harness.

### 4. Integrate every writer and explain blocked work

- Route SFTP auto/manual transfers through the shared protocol. Rsync may download
  into private staging, then use the same per-file install; otherwise disable its
  fast path. It must not write directly over the live mirror.
- `sync_push`'s `force` keeps its meaning (the user chose the local version) but
  goes through the same protocol: the host version is preserved first, and a host
  version that changed after the preview is a new conflict, not part of the force.
- Replace merge's generic local write plus force push with one coordinated backend
  command taking expected side tokens. Revalidate both before apply; preserve the
  current versions and report any partial outcome through the journal.
- Manual deletion remains explicit and positively verifies absence on the other
  side. Preserve the surviving bytes before delete; no background delete is added.
- Include Lockstep pairing/checkout/resolve in coordination; retain Git backup refs
  and current dirty-tree protections. Hold the operation guard across the cleared
  fast-forward retry's check, `git clean`, and merge, and preserve the cleared files
  first, so `ClearedButFailed` loses nothing. Workers keep push-only tracked-code
  ownership and never gain `git clean` or automatic output mirroring.
  At that boundary, add a regression for pinning the worker's planned commit to the
  exact commit bundled/applied instead of re-reading mutable `HEAD`; a larger worker
  redesign is a separate follow-up.
- Expose durable per-file outcomes: verified, unverified/checking, conflict,
  deferred/busy, recovery space full, disconnected, and incomplete/recovery needed.
  A notification shows the affected side and offers compare, keep both, or history.
  Failed/skipped auto work must surface even when no file transferred successfully
  (today the `auto-sync` event fires only when something moved).
- Put viewer behavior in `ProjectFilesView`, reuse shared dialogs and i18n, and gate
  expensive visible UI work on `PaneVisibleContext`. New recovery commands follow
  `tauri_host::Ctx`, desktop cfg, command classification, and generated TS rules.
  Browser clients receive opaque operation ids and revision-checked commands.
- Tag new unverified UI with `UntestedTag` and register ids. Do not clear them from
  automated test results; only the user's verification clears the live-test tag.

Ships when: no byte-writing command reaches the mirror or host outside the shared
boundary (checked by a grep test over the transfer helpers' callers).

### 5. Qualify the guarantees and enable protected overwrite

Build a deterministic transfer harness with fake transport and pause points around
observation, source capture, recovery persistence, receiver capture, installation,
verification, and manifest commit. Use real isolated files and Git repositories
where their filesystem/Git semantics matter. No sleeps to approximate races.

| Scenario | Required result |
|---|---|
| Same-size edit within one second or preserved mtime | Digest detects difference; metadata alone never authorizes overwrite. |
| Source changes during read/download/upload | Only staged bytes can be recorded; later edits stay pending or transfer defers. |
| Either side edited between installation and the receipt | The edit stays pending; it is never recorded as the baseline. |
| Receiver changes after walk, after hashing, or immediately before install | Tested capability preserves displaced work or refuses installation; no false claim of CAS. |
| Permission failure, missing attrs, dropped SSH, malformed response | Unknown/deferred; never missing, zero, green, or an automatic create over a real file. |
| File grows past the cap during capture | Bounded read aborts without replacing the receiver or exceeding the memory bound. |
| Auto/manual/merge/Git and second-process overlap | Shared ownership serializes writes; failed locks/probes stop mutation. |
| Pause/stop/timeout/reconnect and target/scope changes | Old work drains or remains owned; stale plans cannot mutate the new target. |
| Crash/fault at every journal/install boundary, including ENOSPC | Old or new captured version remains recoverable; restart reconciles without blind replay. |
| Crash after receiver capture but before journal transition; destination recreated meanwhile | Prepared intent locates retained bytes; recovery never clobbers the recreated destination. |
| Remote rename succeeds but reply is lost; receiver changes before manifest commit | Indeterminate state is verified on reconnect; no false clean or destructive rollback. |
| Server with and without `posix-rename`/`hardlink` extensions | The detected capability selects the protocol; a missing one defers, never silently overwrites. |
| Recovery full, pruning, acknowledgement, restore | Pinned versions survive; writes pause; acknowledgement deletes no bytes; restore preserves current data. |
| Legacy manifest, missing hashes, two divergent initial copies | Markers round-trip; no baseline guessed; explicit adoption or stable equality required. |
| Corrupt manifest, stale status healing, incompatible older process | Preserve original state; refuse unsafe writes; a stale read cannot erase a newer baseline. |
| Lockstep cleared fast-forward races a byte-sync or editor write | The write survives or is preserved; nothing is cleaned outside the guard. |
| Symlink/nested repo/path substitution, rsync fallback, malicious recovery id | Existing confinement survives; no arbitrary read, overwrite, or deletion. |
| File deleted on either side | No automatic deletion propagation; manual delete retains a recoverable version. |

Run isolated SSH/SFTP tests for each supported server's rename/no-clobber, fsync,
disconnect, and open-handle behavior. Test real local replacement and cross-process
locks on Linux, Windows, and macOS. Where durability or replacement semantics
cannot be established, document the limitation and keep protected overwrite off
for that backend. Measure hash/recovery overhead on large selected trees without
using a live project.

Implementation gates: `scripts/gates.sh` for each change; Rust changes must include
the daemon build. Before pushing, privacy check, all gates, and `ci-local.sh` with
the required Windows/macOS checks. After backend edits run `npm run backend:stale`
and report it. Never start, stop, or restart the user's app for validation.

Live acceptance belongs in the matching remote TODO with the required per-platform
Works/Doesn't work child pairs. Give the user exact steps using a disposable project
to verify conflicts, keep-both recovery, full recovery storage, and interrupted
transfers. Shipping tests is distinct from the user's live verification.

## Completion criteria

Automatic replacement runs only when the selected backend's verified
preservation/install protocol applies. Every baseline identifies actual captured
bytes; unknown/error states cannot authorize a write; this app has one mutation
owner per project; recoverable versions precede destructive actions; and faults
or cancellations leave a durable, explainable state. The documentation states
external-writer and hardware-loss limits alongside the tested guarantees.
