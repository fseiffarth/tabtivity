# Auto-sync safety improvement plan

Status: proposed, 2026-10-20. Source review at `2920161b` on `develop` by three
collaborating agents covering conflict detection, recovery, and coordination.
This document changes no sync behavior. Findings below are from code inspection;
the races have not been reproduced and no live project was used.

Related: [sync guide](remote_sync_guide.md), [sync rationale](context/git_sync.md),
[remote backlog](../todo/group-g-remote.md).

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

## Findings to address

| Priority | Current behavior and code anchor | Consequence |
|---|---|---|
| P0 | `services/sync_auto.rs::reconcile_pass` reuses directory-walk metadata, and `push_decision` checks that same observation | A later host edit may be overwritten despite the apparent second check. |
| P0 | `remote_sync::pull_file_with` reads then replaces the mirror without checking the receiver again; `push_file_atomic` also replaces after a separate check | A receiver edit between check and installation can be lost. |
| P0 | After upload, auto/manual push record local metadata sampled after the read | A later local edit can become the recorded clean baseline even though those bytes never crossed. |
| P0 | Auto-sync converts remote stat errors to `None`; the SFTP metadata helper substitutes zero for missing size | Unknown state can be confused with absence or valid metadata, particularly for new files. |
| P0 | `git_peer::tracked_paths` returns an empty set on probe failure | A failed ownership probe can allow byte-sync to touch Lockstep-owned files. |
| P0 | `sync_auto::pause` sets a flag without draining an active pass; stop can drop a timed-out join handle and release its lease | Git checkout or a new loop can overlap an old transfer that is still running. |
| P0 | Background byte/Git leases are separate, manual paths do not share a writer guard, and `process_lease::claim_at` accepts lock errors | Existing guards do not establish exclusive ownership of project mutations. |
| P0 | Status healing in `commands/sync.rs` combines observations and reads without guarding the original manifest revision | A stale status pass can replace a newer transfer's baseline. |
| P1 | `remote_sync::divergence`/`push_decision` compare size and timestamps at second precision | Different bytes with the same metadata can escape detection. |
| P1 | `remote_sync::load_manifest` falls back to an empty manifest on parse failure | Corruption can hide configuration loss and allow the next save to replace the damaged file. |
| P1 | `local_loss` stores bounded path notifications, not file contents, and excludes automatic transfers | Warnings provide no recovery for overwritten uncommitted bytes. |
| P1 | Manual rsync pulls target the live mirror; merge apply writes locally then force-pushes using separately obtained snapshots | Safer auto-sync primitives alone would leave bypasses and races through manual actions. |
| P1 | Local staging flushes buffers before rename but does not provide the full durable-write protocol; remote rename has no demonstrated fsync guarantee | Atomic replacement is not evidence of power-loss durability. |

Anchors are under `src-tauri/src/services/` unless qualified. Manual paths are in
`src-tauri/src/commands/sync.rs`; merge apply is in
`src/components/embed/SyncMergeView.tsx`. Preserve existing behavior until a
particular replacement is implemented and verified; these are audit findings,
not claims that the proposed safeguards already exist.

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
   hash those exact bytes with the existing SHA-256 dependency, and observe the
   source before/after capture. If it changes, defer and retry with a bound. Keep
   the staged version immutable to this app. Arbitrary concurrent in-place writes
   still require a snapshot or writer cooperation for a strict consistency claim.
4. **Check the receiver and prepare recovery.** Hash a stable receiver and compare
   it with the verified common baseline or the explicit version token approved by
   the user; positively missing receivers instead require exclusive creation.
   Reserve recovery space and durably record the intent, intended staging/recovery
   object ids, and recoverable receiver version before replacement. Also retain
   the staged incoming version.
5. **Revalidate and install.** Recheck scope/manifest generation and receiver
   identity immediately before installation. Use only a capability-tested install
   protocol. A recheck plus ordinary rename is classified as limited protection,
   not compare-and-swap. Unsupported protected automatic replacement is deferred
   with a visible reason, rather than silently falling back to unconditional rename.
   Verify the actual captured receiver against the expected baseline/token, too;
   a different displaced version is a conflict even if both versions were retained.
6. **Verify and record.** Verify installed bytes and commit a transfer receipt
   containing operation id, staged digest, observed source version, displaced
   destination version, and installed digest. Update the common baseline only from
   this evidence. A subsequent source or receiver edit stays pending; never use a
   later source stat as proof that its bytes were transferred.
7. **Finish or recover.** Mark completion durably. Disconnect, cancellation, an
   ambiguous remote response, or manifest failure leaves an incomplete operation
   for reconciliation. Do not retry a mutation blindly or overwrite a new receiver
   as part of rollback. Never display an indeterminate result as green.

### Installation capability decision

Prototype and test local Linux/macOS/Windows and supported SFTP server behavior
before enabling the new overwrite path. Investigate atomic receiver capture
(exchange or replace-with-backup where available), or moving the actual receiver
to a unique recovery location followed by a proven exclusive/no-clobber install.
The latter exposes a brief missing path, needs same-filesystem support, and can
leave open descriptors modifying the displaced object. Explicitly test those
properties rather than describing either protocol as universal CAS.

Recovery storage must be app-controlled and outside project/agent writable
trees. If the filesystem cannot capture the displaced object there atomically,
a copied preimage is a weaker capability; do not hide that distinction. A remote
helper, if needed, requires a separate design review of deployment, permissions,
portability, and failure recovery. Do not silently require new host tooling.

Default fallback: defer automatic replacement of an existing file when the
required preservation/install capability is unavailable. Manual resolution can
explain the limit and offer compare/export/keep both. Replacing the current path
still requires a tested preservation/install protocol; this plan introduces no
weaker manual overwrite exception. A confirmation cannot authorize destroying an
unseen later edit.
New-file creation also needs an exclusive/no-clobber primitive, not an absence
check followed by overwrite. Do not use unconditional rollback to restore a path.

## Implementation phases

### 1. Fail closed and serialize mutations

- Add one per-project async operation coordinator plus an advisory cross-process
  mutation lock covering auto/manual bytes, merge apply, recovery restore/delete,
  selection/scope/exclusion setters, status healing/baseline writes, and Lockstep
  working-tree/ref mutations. Start with project-level serialization;
  optimize to finer locks only after measurements demonstrate a need.
- State the lock's identity boundary explicitly: processes sharing the same state
  directory/project id coordinate. Detect aliases to the same physical checkout
  or canonical remote endpoint, or classify independent registrations/installations
  as external writers. A project-id mutex alone cannot promise endpoint exclusivity.
- Define lock order: project operation guard and process lock, then existing Git
  reconcile guard when needed, then short-lived manifest locks. Refactor public
  wrappers and internal helpers to avoid reacquiring the outer guard. Do not hold
  a manifest mutex across network I/O or await user confirmation while locked.
- Keep background-loop election separate from operation ownership. Make lock
  acquisition errors explicit, scoping strict behavior to sync callers rather
  than changing unrelated container lifecycle semantics. Pause waits for in-flight
  work to drain; stop cancels and joins, or retains ownership until a supervised
  task actually exits.
  A timeout must never detach a writer and advertise the project as free.
- Extend existing tri-state SFTP probing to the auto path; preserve missing
  attributes/errors. Make tracked-file discovery return `Result` and recheck
  ownership/exclusions under the operation guard. Target changes invalidate plans.
- Treat a corrupt/unreadable existing manifest as an error, preserve its original
  bytes, and pause writes; only a positively missing manifest permits initialization.
  Serialize status healing and require its observed revision to remain current.
- Add deterministic regression tests for these failure paths before changing the
  transfer representation. No new "safe sync" UI claims at this stage.

### 2. Record verified content, not later metadata

- Extend `SyncEntry` additively with versioned, optional SHA-256 common-content
  data and explicit verification state. Keep old fields and serde defaults;
  round-trip existing JSON and preserve every selection/exclusion marker.
  Detect incompatible concurrent writers/older binaries before mutation; a format
  addition must not let an older process silently strip verification data.
- Use full available local timestamp precision and file identity as hints. Remote
  seconds/size remain hints. A stable content check is mandatory before overwrite.
- Return a structured transfer receipt from pull/push instead of unrelated
  post-transfer stat tuples. Apply it to auto, manual, status healing, and seeding
  after Git checkout; verify before adopting a content baseline there too.
- Legacy entries without a digest are unverified. A stable equal pair can seed
  the baseline; differing or unreadable pairs require resolution. Never invent a
  common base from which side has the newer clock or from matching metadata.
- Budget periodic content verification so same-metadata edits are eventually
  discovered. Show unverified/stale status until checked; metadata-only polls do
  not establish equality. Bound hashing, memory, retries, and concurrency, respect
  connected/HPC gates, and enforce the 64 MiB limit during reads as well as before.

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
  outside synced/agent-mounted roots. Specify remote placement and quotas during
  the capability prototype. Do not claim encryption at rest or independent backup.
- Keep `local_loss` as a notification compatibility layer; do not use its truncated,
  best-effort metadata log as the durable journal. Emit loss/recovery notifications
  based on completed operations, not before a transfer that might fail.

### 4. Integrate every writer and explain blocked work

- Route SFTP auto/manual transfers through the shared protocol. Rsync may download
  into private staging, then use the same per-file install; otherwise disable its
  fast path. It must not write directly over the live mirror.
- Replace merge's generic local write plus force push with one coordinated backend
  command taking expected side tokens. Revalidate both before apply; preserve the
  current versions and report any partial outcome through the journal.
- Manual deletion remains explicit and positively verifies absence on the other
  side. Preserve the surviving bytes before delete; no background delete is added.
  Include Lockstep pairing/checkout/resolve in coordination; retain Git backup refs
  and current dirty-tree protections. Workers keep push-only tracked-code ownership
  and never gain `git clean` or automatic output mirroring.
  At that boundary, add a regression for pinning the worker's planned commit to the
  exact commit bundled/applied instead of re-reading mutable `HEAD`; a larger worker
  redesign is a separate follow-up.
- Expose durable per-file outcomes: verified, unverified/checking, conflict,
  deferred/busy, recovery space full, disconnected, and incomplete/recovery needed.
  A notification shows the affected side and offers compare, keep both, or history.
  Failed/skipped auto work must surface even when no file transferred successfully.
- Put viewer behavior in `ProjectFilesView`, reuse shared dialogs and i18n, and gate
  expensive visible UI work on `PaneVisibleContext`. New recovery commands follow
  `tauri_host::Ctx`, desktop cfg, command classification, and generated TS rules.
  Browser clients receive opaque operation ids and revision-checked commands.
- Tag new unverified UI with `UntestedTag` and register ids. Do not clear them from
  automated test results; only the user's verification clears the live-test tag.

### 5. Qualify the guarantees and enable automatic overwrite

Build a deterministic transfer harness with fake transport and pause points around
observation, source capture, recovery persistence, receiver capture, installation,
verification, and manifest commit. Use real isolated files and Git repositories
where their filesystem/Git semantics matter. No sleeps to approximate races.

| Scenario | Required result |
|---|---|
| Same-size edit within one second or preserved mtime | Digest detects difference; metadata alone never authorizes overwrite. |
| Source changes during read/download/upload | Only staged bytes can be recorded; later edits stay pending or transfer defers. |
| Receiver changes after walk, after hashing, or immediately before install | Tested capability preserves displaced work or refuses installation; no false claim of CAS. |
| Permission failure, missing attrs, dropped SSH, malformed response | Unknown/deferred; never missing, zero, green, or an automatic create over a real file. |
| File grows past the cap during capture | Bounded read aborts without replacing the receiver. |
| Auto/manual/merge/Git and second-process overlap | Shared ownership serializes writes; failed locks/probes stop mutation. |
| Pause/stop/timeout/reconnect and target/scope changes | Old work drains or remains owned; stale plans cannot mutate the new target. |
| Crash/fault at every journal/install boundary, including ENOSPC | Old or new captured version remains recoverable; restart reconciles without blind replay. |
| Crash after receiver capture but before journal transition; destination recreated meanwhile | Prepared intent locates retained bytes; recovery never clobbers the recreated destination. |
| Remote rename succeeds but reply is lost; receiver changes before manifest commit | Indeterminate state is verified on reconnect; no false clean or destructive rollback. |
| Recovery full, pruning, acknowledgement, restore | Pinned versions survive; writes pause; acknowledgement deletes no bytes; restore preserves current data. |
| Legacy manifest, missing hashes, two divergent initial copies | Markers round-trip; no baseline guessed; explicit adoption or stable equality required. |
| Corrupt manifest, stale status healing, incompatible older process | Preserve original state; refuse unsafe writes; a stale read cannot erase a newer baseline. |
| Symlink/nested repo/path substitution, rsync fallback, malicious recovery id | Existing confinement survives; no arbitrary read, overwrite, or deletion. |
| File deleted on either side | No automatic deletion propagation; manual delete retains a recoverable version. |

Run isolated SSH/SFTP tests for each supported server's rename/no-clobber, fsync,
disconnect, and open-handle behavior. Test real local replacement and cross-process
locks on Linux, Windows, and macOS. Where durability or replacement semantics
cannot be established, document the limitation and keep protected overwrite off.
Measure hash/recovery overhead on large selected trees without using a live project.

Implementation gates: `scripts/gates.sh` for each change; Rust changes must include
the daemon build. Before pushing, privacy check, all gates, and `ci-local.sh` with
the required Windows/macOS checks. After backend edits run `npm run backend:stale`
and report it. Never start, stop, or restart the user's app for validation.

Live acceptance belongs in the matching remote TODO with the required per-platform
Works/Doesn't work child pairs. Give the user exact steps using a disposable project
to verify conflicts, keep-both recovery, full recovery storage, and interrupted
transfers. Shipping tests is distinct from the user's live verification.

## Completion criteria

Automatic replacement is enabled only when the selected backend's verified
preservation/install protocol applies. Every baseline identifies actual captured
bytes; unknown/error states cannot authorize a write; this app has one mutation
owner per project; recoverable versions precede destructive actions; and faults
or cancellations leave a durable, explainable state. The documentation states
external-writer and hardware-loss limits alongside the tested guarantees.
