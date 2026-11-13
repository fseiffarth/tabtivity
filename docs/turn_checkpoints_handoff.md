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
