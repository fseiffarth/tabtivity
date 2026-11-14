# Per-turn checkpoints — handoff

Implements `docs/turn_checkpoints_plan.md` Steps 1–7 (decisions 1–7 unchanged).
Built in the worktree `.claude/worktrees/agent-a3b50c0cd7734fab6`, branch
`worktree-agent-a3b50c0cd7734fab6`, on top of `develop` a2a5ecb45 (v0.2.73).
Design notes for later readers: `docs/context/checkpoints.md`. **Never run
live** (AGENTS.md: the app is not started); the todo in
`todo/group-s-agents.md` holds the click-through. No step is outstanding.

## Commits

- backend (Steps 1–5): the first commit of the branch after a2a5ecb45,
  `feat(checkpoints): …store, snapshot, restore, triggers and commands`
- window + docs (Steps 6–7, help topic, todo, this file): the commit that adds
  this file.

(`git log --oneline a2a5ecb45..HEAD` names both.)

## Files

Backend
- `src-tauri/src/services/checkpoints/{mod,store,snapshot,restore,worker,tests}.rs`
- `src-tauri/src/commands/checkpoints.rs` (+ `commands/mod.rs`, `lib.rs`: handler list, `checkpoints::start`, `stop_for_exit` in the quit teardown)
- `services/git/git_hardened.rs`: `checkpoint_git_command`, `CheckpointRepo`, `NULL_DEVICE`
- `services/agent/agent_turn.rs`: `note_state` returns the previous state; `state_of`; `record_written_ms`; the hand-off to `checkpoints::on_turn` after the locks are released; `unbind` in `on_tab_gone`
- `services/launch_prep.rs`: `checkpoints::bind` beside `agent_turn::bind_tab`
- `services/agent/agent_fence.rs` (`basename` is `pub(crate)`; `checkpoints` and `checkpoints.json` named in `private_state_paths`) and `agent_fence/tests.rs` (the masking test)
- `services/command_class.rs` rows + regenerated `src/lib/transport/commandClasses.ts`
- `commands/projects.rs`: `purge_project` on forget and archive
- `schema/settings.rs`: the `turn_checkpoints` flag; `mobile_control/host.rs`: `checkpoints::start` beside `agent_turn::start` (browser-client host)

Frontend
- `src/lib/agents/checkpoints.ts`, `src/stores/agents/checkpoints.ts`
- `components/terminal/{ReaderCheckpoints,CheckpointRestoreDialog,CheckpointDiffScope}.tsx`, `components/layout/CheckpointsSettings.tsx`
- small edits: `TerminalReaderChanges.tsx` (export `ChangeCard`, open handlers optional, five lines mounting `useCheckpointScope` — `switchEl` after the layout dropdown, `bodyEl ?? <existing body>`), `TerminalReaderView.tsx` (`restore` slot on `Turn`, `useReaderCheckpoints`, `useCheckpointNow`, the dialog), `ReaderComposerChips.tsx` (Checkpoint chip), `SettingsPanel.tsx`, `settingsIndex.ts`, `experimental.ts`, `types/index.ts`
- i18n: one contiguous block at the end of each of the five dictionaries; `lib/untested.ts`: five rows at the end of the table; CSS appended to the end of `styles/subwindows.css`; both filemaps one row each; `todo/group-s-agents.md` one item at the top.

Docs: `docs/context/checkpoints.md`, `docs/help/checkpoints.md` (+ the `Topics` list of `ask-tabtivity.md`), the plan.

## Deviations from the plan, and why

- **No parent on a checkpoint commit.** The plan chains each commit to the previous one "for delta packing". A parent keeps every pruned snapshot reachable, so retention could never free anything; git packs by object similarity, not by commit parents. Rows are kept alive by `refs/ckpt/<id>` only.
- **Ignore file is `<key>/ignore` via `core.excludesFile`, not `store.git/info/exclude`.** Same effect (the repo's `info/exclude` read through `git_guard::read_info_exclude`, plus `/<worktrees dir>/` and the left-out paths), but the repo's guarded-file source scan (`guarded_project_files_are_only_opened_through_the_guarded_helpers`) flags any fn that names `info/exclude` and does raw IO.
- **`pre-restore` is not a toast.** There is no generic toast surface; the restore dialog's result step offers **Undo restore** (it restores the `pre-restore` row, everything). The row also stays in the Since-checkpoint picker ("Before a restore").
- **No Reader ⋯ menu or terminal tab-menu entry for Checkpoint now** (neither exists in this build). It is a **Checkpoint** chip beside Commit in the Chat composer. Tabby chats get none.
- **Settings card sits in Settings → Experimental**, not Agents: one switch sets the experimental flag `turn_checkpoints` (window gate; a new `Settings` key in Rust and TS, listed in `EXPERIMENTAL_FLAGS`) and the backend's `checkpoints.json` in the same click, so there is no second switch to forget.
- **"Another tab changed it" is per file, from the log**, not from a diff per tab: for each later `post` of another tab, the files between that tab's `pre` and `post` trees (`restore::others_changed`, 60 turns at most).
- **A tracked file that grows past the cap, or becomes a pipe, is dropped from the store's index** (`update-index --force-remove`) and named on the row; git itself never lists a pipe, but a tracked one would make `git add` fail.
- The plan says the renderer passes "a tab key"; that is the tab's launch uid (`TabEntry.sessionId`, the `TAB_UID` env), the key `agent_turn` already uses.
- `checkpoint_restore` takes `only` (not `paths`) and `confirmOthers`: `core_dispatch` classifies every argument named like a path (`path`, `file`, `dir`, …) and a new one needs a confinement row. `only` is a filter on what git's diff reported, never a path handed to the file system as given.

## Security checks, and the tests that pin them

- Store git (`checkpoint_git_command`): `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` at the store, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` = null device (`NUL` on Windows), hooks and `core.fsmonitor` off, `GIT_ATTR_SOURCE` = empty tree, inherited `GIT_CONFIG_*`/`GIT_COMMON_DIR`/… dropped, every run bounded (`git_bounded`, FIFO pre-check). Tests: `nothing_the_folders_own_repo_names_runs_during_a_snapshot` (the folder's `.git/config` names a clean/smudge filter, `core.fsmonitor`, `core.hooksPath`, a hook, `diff.*.textconv`, and a `.gitattributes` binds the filter; a control run of plain git proves it would run), `the_users_global_config_is_not_read` (a `HOME` with a `~/.gitconfig` filter; control again), `a_nested_repo_is_a_gitlink_and_nothing_it_names_runs`, `the_byte_exact_file_is_stored_whatever_the_attributes_say`.
- The repo's `info/exclude` is only read through `git_guard::read_info_exclude`; the file-scan test stays green.
- Restore: `plain_path` (no `..`, `.git`, empty parts, no leading link/non-folder), `:(literal)` pathspecs in chunks, the renderer's list only a filter. Tests: `a_leading_folder_that_became_a_link_is_never_written_through`, `plain_path_refuses_…`, `paths_are_literal_pathspecs`, `undo_restore_round_trips`. Residual: a swap between check and write by another process in the same folder (documented in `restore.rs`).
- Fence: the whole state dir is masked; `the_checkpoint_stores_stay_under_the_state_mask` pins that nothing binds anything below `checkpoints/`.
- Snapshot work is queued from `agent_turn`'s watcher thread after `note_state` returned (no `agent_turn` lock is held) and runs on a per-folder serial worker (`worker::Queues`, tested) under a cross-process file lock.
- The renderer names a tab and an opaque id only; the folder was found among the fence roots (`projects.json`/`boxes.json`) at launch (`resolve_folder`, tested), and a folder holding the state dir, the home folder or a filesystem root is refused (`unsuitable`).

## Gotchas

- `git ls-files --others` never lists a pipe/socket/device; only a *tracked* file turning into one reaches the `special` branch.
- `core.worktree` must not be stored in the store config (`ensure` unsets it); the work tree is passed in the environment on every call.
- Dedupe: a snapshot whose tree equals the newest row's reuses its commit, so two rows can share a commit; each keeps its own ref, and pruning deletes refs per row.
- `restore` and `since` both run `stage` (an `add -A`) first, so opening the dialog costs a snapshot-sized pass over the folder; they hold the store lock, so they queue behind a snapshot in flight.
- The first snapshot of a big folder: every file is new to an empty store, so the 256 MiB new-bytes budget applies at once (largest files wait for later snapshots, row `partial`).
- Only the folder's own ignore rules apply (not an ancestor repo's `.gitignore` nor the user's global ignore file).
- The `pre` race detection compares file mtimes with the turn record's write time; the user's own edits in that window also mark a row `raced`.
- `app_core::rt::spawn_blocking` bodies: the command layer uses `async` over `checkpoints::*` blocking functions; git runs on that blocking pool.

## Gate results

All ten gates (`scripts/gates-job.sh`) on the final tree: brand PASS, whitespace PASS, lint PASS (errors only; no new warnings), clippy ×3 PASS at zero warnings (`-p tabtivity -p app-serverd --all-targets`, `--no-default-features --lib`), `npm run build` PASS, vitest PASS, `cargo test -p tabtivity -p app-serverd` PASS (lib 5624 tests, of which 38 are `services::checkpoints` and one is the fence masking test), the daemon's `--no-default-features --lib --test server_secrets` PASS. New tests: 38 Rust in `services::checkpoints` (`tests.rs`, `store.rs`) and 1 in `agent_fence/tests.rs`, and 8 vitest (`__tests__/terminal/Checkpoints.test.tsx`).

## Flagged for user

- **Privacy of the store.** It holds a copy of every non-ignored file of every checkpointed folder (secrets in a non-ignored `.env`, for instance) under the state dir (0700, masked from fences). Clear and project removal delete it; nothing else does before 14 days.
- **Disk.** Duplicated blobs up to 300 rows / 14 days per folder; check `<state_dir>/checkpoints` after a day. A big first snapshot is capped at 256 MiB of new files and 25 MiB per file.
- **Empty folders** are not captured, and a restore leaves empty folders behind.
- **Codex tab**: capture needs its hooks to be trusted (`/hooks`); an untrusted Codex never reports a turn, so it gets none. Worth checking on the Codex click-through.
- **Generic help text** now mentions the feature in the `ask-tabtivity` Topics list (a test requires it).
- Not live-verified anywhere; every control wears an `UntestedTag` (`settings.turnCheckpoints`, `checkpoints.now|bubble|restore|scope`).

## Reviewer notes (review of a8b8d2b1b + 1346f3af1, rebased on develop)

Merge resolution verified: `ChangeCard` is exported with the diff-notes props
optional (no `onStartNote` means no note gutter: `DiffLineRow onNote` and
`SplitRows notes` are undefined, so the checkpoint scope draws no `+`); the
agent's-edits scope passes every note prop and is unchanged. `npm run build`
(tsc 7 and the bundles) passes; `ReaderDiffNotes`, `DiffNotes`, the five
`SteeringReader*`/`SteeringDiffs*` files and `Checkpoints.test.tsx` pass. Both
filemap rows are present. i18n: 44 keys in each of the five dictionaries, real
translations.

Checked and found sound: the store's git environment (every `GIT_*` that can
redirect or inject config is dropped; `GIT_CONFIG_GLOBAL`/`NOSYSTEM`, hooks,
fsmonitor, attributes and the excludes file are pinned; the folder is only the
work tree, never discovered), pathspec/leading-dash handling (the work tree is
passed as `cwd` and environment, never as an argument; restore uses
`:(literal)` chunks), `plain_path` and the `-z` parsing, the `pre-restore`
snapshot before any write (and its failure aborting the restore), the refusal
while the tab's agent works, the fence (state dir masked, `checkpoints` and
`checkpoints.json` named, nothing binds back), the command classes (generated
TS current), `async` over `*_blocking`, no lock held by `agent_turn` during a
hand-off, the per-folder serial worker plus a cross-process `flock` that also
excludes threads, prune removing refs and log rows together with a `gc` that
frees the unreachable commits, and `purge_project` on forget and archive.

### Fixed (commit 69eac26dd)

- **A restore overwrote a file that had outgrown the 25 MiB cap, with no way
  back.** Such a tracked file is dropped from the store's index
  (`update-index --force-remove`), so `diff-index` reported the checkpoint's
  copy as "deleted since"; the restore checked it out over the bigger file, and
  the `pre-restore` snapshot (which also leaves it out) could not undo that.
  Same for a tracked file that became a pipe. `restore::left_alone` now keeps
  them out of `since` and `restore` (they count as "left out", as the dialog
  text already promised). Test:
  `a_file_that_outgrew_the_cap_is_left_alone_by_a_restore` (fails before).
- **A swapped worktree folder redirected the host's snapshot.** A linked
  worktree's folder (`<root>/<worktrees dir>/<name>`) lies inside the project;
  `Store::for_folder` re-canonicalized the bound folder on every call, so an
  agent that replaced it with a link made the host snapshot (into a store of
  its own) whatever the link names, and later rows in that store would restore
  there. `Store::for_bound` (used by `snapshot`, `list`, `store_row`) refuses a
  folder that no longer resolves to itself. Test (unix):
  `a_bound_folder_swapped_for_a_link_is_not_snapshotted_as_the_place_it_points_to`
  (fails before).

### Flagged for the user

Also fixed 2026-11-14, found while fixing these: an exclude line in the
store's ignore file (the size cap, the budget, the worktrees folder) could be
taken back by a `.gitignore` negation (`!big.bin` outranks
`core.excludesFile`); they are exclude pathspecs now. Still open: Codex with
untrusted hooks, and the authorization by launch uid (below).

- **Old git — resolved 2026-11-14:** `checkpoints::MIN_GIT = (2, 40)`; turning
  them on is refused, snapshots/since/restore/now refuse, and the settings
  card greys the switch with a line naming the local git. Original note:
  `GIT_ATTR_SOURCE` needs git 2.40+ (`markup_rounds` gates on
  `MIN_GIT = (2, 40)`; the checkpoints do not) and `GIT_CONFIG_GLOBAL` 2.32+.
  On an older git the folder's `.gitattributes` still applies (end-of-line
  conversion, `ident`, `working-tree-encoding`: the stored bytes are no longer
  the bytes on disk) and the user's global config is read, so a global filter
  driver (Git LFS) that a `.gitattributes` binds would run on the files. No
  folder-defined program can run (nothing defines one), but the snapshot would
  hold pointers instead of content. Suggest: refuse to enable (or snapshot)
  below 2.40, with a line in the settings card.
- **A named pipe as `.gitignore` — resolved 2026-11-14:** a nested one keeps its
  folder out of the snapshot (`blocked` on the row, a restore leaves it alone,
  remembered in `<store>/blocked`), found by a `stat` of stored folders or
  after a 45 s stall; the top one fails at once with the reason, shown on the
  Checkpoint chip. The folder's own `.git` is no longer prechecked. Original
  note: a named pipe as `.gitignore` (or any nested `.gitignore`) blocks git's
  listing until `git_bounded`'s timeout (2 min), under the store lock, on every
  snapshot, `since` and restore of that folder. The agent can thereby switch off
  its own undo history. Bounded, and a log line on stderr, but silent in the UI.
- **Non-UTF-8 file names — resolved 2026-11-14:** paths stay bytes
  (`store::GitPath`) to the file system. Original note: they are decoded lossily: the size cap and the budget do
  not see them (`look` finds no such path) and a restore that "removes" one
  counts a success for a path that does not exist.
- **`repo_ignore` walks up four ancestors — resolved 2026-11-14:**
  `snapshot::repo_git_dir`. Original note: it walks up four ancestors for a plain folder too, so a
  dotfiles-style repo above the project can exclude its files from the store;
  the context doc says only the folder's own rules apply. Should be limited to
  the linked-worktree case.
- **A panic in a snapshot — resolved 2026-11-14:** `catch_unwind` in
  `Queues::drain`. Original note: a panic strands the folder's queue (map entry never
  removed, `active` never decremented): later jobs for that folder are never run
  until restart. Wrapping `run_job` in `catch_unwind` (or a drop guard) would
  close it.
- **No total store cap — resolved 2026-11-14:** `MAX_STORE_BYTES` (2 GiB per
  folder), a quarter at a time with a repack between. Original note: 14 days / 300 rows / 25 MiB per file / 256 MiB new per
  snapshot, but a large folder that changes a lot grows without a byte cap.
- **Window flag vs backend switch — resolved 2026-11-14:** capture needs both
  (`capturing_in`). Original note: the card sets both; editing
  `settings.json` or a Debug-mode profile can leave the flag on with the backend
  off (the card says so, controls hidden: safe) or the flag off with the backend
  still capturing (invisible but running).
- **Codex with untrusted hooks** reports no turn state, so the "agent is
  working" refusal cannot see it; a restore is then allowed mid-turn.
- **Resolved 2026-11-14:** `remove_store` renames the store aside under its
  lock, and `since`/`restore` re-read the row under it. Original note:
  `remove_store` drops the store lock before `remove_dir_all`; a snapshot
  starting in between fails or recreates the store. `restore`/`since` read the
  row before taking the lock; a row pruned in that window (14 days old, plus a
  gc) makes the checkout fail with every path listed as failed (nothing lost).
- The authorization is the tab's launch uid (the same credential
  `agent_turn` uses); the commands are `core`, so any client that can call
  commands and knows a uid can list or restore that tab's folder.

### Review gates

`scripts/gates-job.sh start --all` on the tree after 69eac26dd: all ten PASS
(brand, whitespace, lint, clippy ×3 at zero warnings, `npm run build`, vitest
with no timeouts, `cargo test --workspace`, the daemon's `--no-default-features`
lib and `server_secrets`). The `services::checkpoints` module has 40 tests (the
two new ones included).
