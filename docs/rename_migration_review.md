# App-name migration code review

Review date: 2026-10-02. Scope: the Eldrun → Tabtivity migration in
`src-tauri/src/services/brand_migration/`, including its startup retry behavior
and agent-home migration. This is a static review; no migration was run against
a live install. The existing test suite was inspected, but the findings below
have not been reproduced by new tests.

## Findings

### 1. State paths can be marked done before the state directory moves — high

`state-dir` runs before `state-paths`. If the directory move fails while the
new directory does not exist, `rewrite_state_paths` returns `NothingToDo` at
`state_dir.rs:229-231`. `run_startup` records `NothingToDo` as `Done` at
`mod.rs:285-287`. On a later launch, `state-dir` may move successfully, but
`state-paths` is skipped because its record already says `Done`.

Saved absolute paths in the registry, sessions, remote-project state, and
archive manifests can therefore remain under the old state directory. They
depend on the old-path link continuing to work, and will break if that link is
absent or later removed.

**Suggested fix:** Return `Pending` while the old state directory still exists
and the new one is absent. Add a test that forces the first move to fail, then
allows it on a second launch and checks that the stored paths are rewritten.

### 2. A failed old-path link is recorded as a completed move — high

After `fs::rename` succeeds, `move_dir` returns `Outcome::Done` even when
`link_dir` fails (`state_dir.rs:205-211`). The same happens on a retry after a
crash between the move and link (`state_dir.rs:170-176`). The startup runner
then records the step as `Done` and never retries the link.

The link is the compatibility path for absolute references that the known
state-file rewrite does not cover. A transient link failure can leave those
references unusable even though the migration reports a completed move.

**Suggested fix:** Keep the step pending until the link exists, or record a
separate retryable link step. Test link failure followed by a successful retry.

### 3. Agent-home rewrite failures can be hidden by marker renames — medium

`rewrite_file` returns `false` both for an unchanged or missing file and for a
failed read or write (`agent_homes.rs:182-192`). `migrate_home` proceeds to
rename the old markers regardless (`agent_homes.rs:229-246`), and the startup
step can report `Done` from those marker changes (`agent_homes.rs:271-289`).
The spawn-time migration only runs if an old marker remains
(`agent_home.rs:127-135`).

If a CLI config write fails, its old hook command can remain in place while
the next spawn registers the new command. Both hooks may then run, and neither
the startup step nor the spawn-time check is guaranteed to retry the rewrite.

**Suggested fix:** Distinguish an unchanged file from an I/O failure. Leave a
retry marker and the step pending until all readable configs have been
rewritten successfully. Test an unwritable config followed by a successful
second attempt.

### 4. State-path rewriting does not serialize with other state writers — medium

`rewrite_state_paths` reads a JSON file, changes it in memory, then calls
`write_json_atomic` (`state_dir.rs:237-245`). It does not hold the file's
`FileLock` across that read-modify-write sequence. The persisted-name rewrite
does hold that lock and bumps `workspaceVersion` or `rev` for writers that
check it (`persisted.rs:129-151`).

If another process updates a state file after the path rewrite reads it and
before the rewrite replaces it, that update can be lost. A running phone host
or second app process makes this possible during a migration retry.

**Suggested fix:** Re-read and rewrite under the file lock, and advance the
relevant version or revision counter when a file changes. Add a concurrent
writer test using the same lock contract as the state stores.

## Test coverage gap

`brand_migration/tests.rs` tests recovery from named crash checkpoints, but
those checkpoints stop execution before a step reports success or failure.
They do not cover a failed directory move followed by a successful move, a
failed link, or a config write failure. The tests proposed above should cover
those retry paths and assert both the migration record and final file content.

No implementation changes are included in this review.
