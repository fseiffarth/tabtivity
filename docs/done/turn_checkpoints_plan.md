# Per-turn checkpoints — plan

> **Status (screened against code 2026-11-22):** Steps 1–7 are in code: `services/checkpoints/{store,snapshot,restore,worker,mod}.rs`, `commands/checkpoints.rs`, `components/terminal/{ReaderCheckpoints,CheckpointRestoreDialog,CheckpointDiffScope}.tsx`, help topic `checkpoints`. Deviations: `docs/done/turn_checkpoints_handoff.md`; design: `docs/context/checkpoints.md`. "Later" items (conversation rewind, remote, phone) are not built. Open: the click-through in `todo/group-s-agents.md`. Not live-tested unless the doc/todo says so.

## Why

An agent turn can leave a folder in a state you don't want, and the way back
is manual: `git diff`/`git checkout` for tracked files, nothing at all for new
or never-committed files. Claude has its own `/rewind`, but only inside Claude
and only for its own edits. T3 Code (pingdotgg/t3code) snapshots the tree
around every turn and offers "revert to this message"; it is the feature its
users single out. Tabtivity already knows exactly when a turn starts and ends
(`services::agent_turn`, from the agents' own hooks), so it can do the same
for every hook-backed CLI, outside the agent's reach.

What T3 Code does and we don't copy: it stores the snapshots as hidden refs in
the project's own `.git`. Inside our fence the agent can write that `.git`, so
it could delete or forge its own undo history; and non-git folders get
nothing.

## Fixed decisions (user, 2026-11-13)

1. **Own store in the state dir.** One git object store per folder under
   `<state_dir>/checkpoints/<key>/`, with the folder as its work tree. The
   project's `.git` is never written. Agents can't reach it (not mounted into
   any fence), and non-git folders work too. The cost is duplicated blobs on
   disk, bounded by retention (§Retention).
2. **Scope: tracked + untracked, not ignored**, `git add -A` semantics against
   the folder's own `.gitignore` files and its `info/exclude`. Ignored files
   (build output, `.env`, data) are neither captured nor touched by a restore.
   Files over a size cap are skipped and listed on the checkpoint.
3. **Restore puts back files only.** The CLI conversation stays as it is. The
   restore dialog has a pre-ticked checkbox that puts a short note into the
   Reader composer ("Files were restored to before turn N …") for the user to
   send or delete. Rewinding the conversation as well (Claude/Codex fork at a
   prompt) is out of scope; it would be a later, per-CLI phase.

Decided here (conventional, no user call needed):

4. **Local folders only** in phase 1: local projects, their linked worktrees,
   box member folders, container tabs (same absolute path). Remote projects,
   the root console's Host session and the assistant scope are skipped.
5. **Hook-backed CLIs only for automatic capture** (Claude, Codex today; any
   CLI whose hooks reach `agent_turn`). The byte heuristic is too noisy to
   mark a turn edge. Every agent tab gets a manual **Checkpoint now** instead.
6. **Off by default, behind `useExperimental`** for the first release: it runs
   git on every turn and writes to disk. The switch is a backend setting
   (`checkpoints.json { enabled }`), since capture happens in the backend.
7. **Opaque ids across the bridge.** The renderer names a tab and a checkpoint
   id, never a folder path; the backend resolves the folder from the tab's
   bound cwd and checks it against `projects.json` (as `agent_relocate` does).

## Design

### Store layout

```
<state_dir>/checkpoints/<key>/          key = first 16 hex of sha256(canonical folder)
  store.git/                            git dir, core.bare=false, no core.worktree
  store.git/info/exclude                regenerated each snapshot (§Snapshot)
  index                                 GIT_INDEX_FILE (stat cache, keeps re-snapshots fast)
  meta.json                             { folder, projectId, created }
  log.jsonl                             one row per checkpoint / restore
```

A `log.jsonl` row: `{ id, commit, tree, kind: "pre"|"post"|"manual"|"pre-restore",
tabUid, tabLabel, cli, sessionId?, at, promptAt?, raced, partial, skipped: [{path, bytes}] }`.
Refs: `refs/ckpt/<id>` per row, so `gc` keeps exactly what the log lists.
Each commit's parent is the folder's previous checkpoint commit (better delta
packing; no meaning beyond that).

### Snapshot

One function, `services::checkpoints::snapshot_blocking(folder, kind, tab)`,
AppHandle-free, run on a per-folder serial worker (two tabs in one folder
never snapshot at once; a queued duplicate of the same kind is coalesced).

Git runs with our store and **none of the user's or project's config**, because
the work tree is attacker-controlled and the global config may name filter
drivers (`git-lfs`) or an fsmonitor:

- `GIT_DIR=<store.git>`, `GIT_WORK_TREE=<folder>`, `GIT_INDEX_FILE=<index>`
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` = the null device (`/dev/null`,
  `NUL` on Windows), `core.hooksPath` = an empty dir, `core.fsmonitor=false`,
  `core.symlinks=true`
- built through `git_hardened` (a new `checkpoint_git_command` beside
  `hookless_git_command_in`, added to its `BARE_GIT_ALLOWED` file note); the
  store's own config is written by us and contains nothing executable.
  A `.gitattributes` `filter=` in the tree names a driver no config defines,
  so git stores the raw bytes.

Steps:

1. Regenerate `store.git/info/exclude`: the project's `info/exclude` (read
   through the guarded `read_info_exclude`, never raw `fs`), plus
   `/.tabtivity/worktrees/` (linked worktrees nested in the root are their own
   folders), plus the size-skipped paths from step 2.
2. `git ls-files -o --exclude-standard -z`, `lstat` each: files over
   **25 MiB** are skipped; if the new untracked bytes exceed **256 MiB** the
   largest are skipped until under budget and the checkpoint is `partial`.
3. `git add -A` → `git write-tree`. If the tree equals the folder's newest
   checkpoint tree, log the row against the same commit (no new objects).
4. `git commit-tree <tree> -p <prev>` → `git update-ref refs/ckpt/<id>`, append
   the `log.jsonl` row.

Nested repos are stored as gitlinks (their contents are not captured); the
restore dialog says so when the tree has one.

### When it runs

`agent_turn::note_state` already sees every transition. It gains a hand-off
(not under its locks) to `checkpoints::on_turn(uid, prev, state)`:

- entering `Working` from anything but `Working`/`Decision` → `pre`
- the first `Done` of a turn (the same edge `turn_ends` records) → `post`
- `Idle` (session end) → nothing

The uid → folder binding comes from `launch_prep`, where `bind_tab` is called:
the tab's `opts.cwd`, `project_id`, and whether it is remote/host/assistant.
A new `checkpoints::bind(uid, folder, project_id)` sits beside that call; a
moved worktree (`agent_relocate` → relaunch) re-binds on the relaunch.

**The `pre` race.** `UserPromptSubmit` fires as the agent starts; the snapshot
lands some 100 ms later (inotify + a warm-index `add -A`), the agent's first
write normally seconds later (model latency). To catch the rare overlap, the
snapshot compares captured mtimes with the turn's start (`promptAt`, the
`.turn` record's write time): a newer file marks the row `raced`. A restore to
a raced `pre` offers the previous turn's `post` instead and says which
changes between turns (the user's own) that would miss.

### Restore

`checkpoint_restore { tabKey, id, paths, note }`:

1. Refuse while this tab's agent is `Working`/`Decision`; for other tabs
   bound to the same folder that are working, the dialog has already warned
   and the call carries `confirmOthers: true`.
2. Take a `pre-restore` snapshot (this is the **Undo restore** target).
3. For the selected paths, per the dialog's diff (`git diff --name-status -z
   <ckpt>` against the work tree, through the store):
   - modified/deleted since → `git checkout <ckpt> -- :(literal)<path>…`
     (git's checkout refuses to write through a symlinked leading directory)
   - added since → removed (the `pre-restore` snapshot holds it)
4. Append a `restore` row to `log.jsonl` (from, to, paths count).
5. Return; the frontend puts the note into the composer
   (`insertIntoReader(ptyId, text)`) when the box was ticked.

A restore is a foreground action with its own undo, so it does not go through
`local_loss` (that record is for background moves).

### Retention

Per folder: keep checkpoints younger than **14 days**, at most **300**; the
`pre-restore` rows of the last 7 days are never pruned early. Pruning deletes
refs and log rows; a `git gc --prune=now` runs on the store when it is idle
and has dropped ≥ 50 refs since the last gc. Settings shows each folder's store
size and a **Clear checkpoints** button. Removing a project deletes its stores.

## UI

- **Reader Chat:** a prompt bubble's hover actions get **↶ Restore files to
  before this**. The bubble's prompt is matched to a `pre` row by `sessionId`
  and `promptAt` (±5 s); with no match the action is absent, never guessed.
- **Reader Diffs tab** (`TerminalReaderChanges.tsx`): a scope switch beside
  the layout toggle: *Agent's edits* (today's view, from the CLI's record) /
  *Since checkpoint ▾* (a picker of this tab's checkpoints; the diff of that
  snapshot against the folder now, every file, whoever changed it). The
  restore button lives in that scope.
- **Restore dialog** (shared dialog frame, `add-menu` skill): file list with
  status letters and checkboxes (all ticked), files another tab's agent changed
  since the checkpoint flagged, skipped/partial/nested-repo notes, the note
  checkbox, Restore / Cancel. After a restore a toast offers **Undo restore**.
- **Checkpoint now** in the Reader's ⋯ menu and the terminal tab menu.
- Settings → Agents (experimental): enable switch, per-folder sizes, Clear.
- Strings via `useT()` in all five dictionaries; new controls carry
  `UntestedTag` rows in `src/lib/untested.ts`.
- Phone: none in phase 1.

## Steps

1. **Store + snapshot** — `src-tauri/src/services/checkpoints/{mod,store,snapshot}.rs`:
   layout, `checkpoint_git_command` in `services/git/git_hardened.rs`,
   snapshot, dedupe, size budget, log rows. Unit tests in a temp folder:
   new/modified/deleted/ignored/oversized files, a `.gitattributes` filter
   that must not run, a symlink, a non-git folder, dedupe.
2. **Triggers** — `checkpoints::bind` from `services/launch_prep.rs` beside
   `bind_tab`; `on_turn` from `agent_turn::note_state`; per-folder worker;
   `raced` detection; the setting file. Tests: transition table → kinds.
3. **Diff + restore** — `checkpoints/restore.rs`: name-status diff, per-path
   diff text (bounded like `agent_changes`), restore with `pre-restore`, the
   `restore` row. Tests: restore of modified/deleted/added, a path whose
   leading dir became a symlink is refused, Undo restore round-trips.
4. **Commands** — `src-tauri/src/commands/checkpoints.rs`: `checkpoint_list`,
   `checkpoint_diff`, `checkpoint_restore`, `checkpoint_now`,
   `checkpoint_settings_get`/`_set`, `checkpoint_clear`, each
   `#[cfg_attr(feature = "desktop", tauri::command)]`, `async` over a
   `*_blocking` body, all `Core` in `services::command_class`; regenerate
   `src/lib/transport/commandClasses.ts`. Register in `lib.rs`.
5. **Retention** — prune on each snapshot, idle gc, project-removal cleanup.
6. **Frontend** — `src/lib/agents/checkpoints.ts` (invoke wrappers + types),
   `stores/agents/checkpoints.ts` (per-tab list, refreshed on `agent-turn`
   done), Chat bubble action in `TerminalReaderView.tsx`, Diffs scope in
   `TerminalReaderChanges.tsx`, `terminal/CheckpointRestoreDialog.tsx`,
   settings card, i18n, untested rows.
7. **Docs** — rows in `docs/filemap_backend.md` / `docs/filemap_frontend.md`;
   `docs/context/checkpoints.md` (why the store is outside `.git`, why no
   user config, the `pre` race); a help topic; a todo with the 🖐️ platform
   pairs.

## Verification

- Gates for the touched areas (`scripts/gates-job.sh start`), including the
  cross-OS rules: store paths via `Path::join`, the null device by `cfg!`.
- Never live until the user clicks through: in a test project, let Claude
  edit two files and create one → Diffs *Since checkpoint* shows three →
  Restore → files back, new one gone → Undo restore → all three back. Same in
  a non-git folder and in a Codex tab. Check `<state_dir>/checkpoints` size
  after a day of normal use.

## Later

- Conversation rewind per CLI (Claude fork at a prompt, Codex resume at a
  turn), together with the file restore.
- Remote projects (snapshot on the host over the existing SSH git lane).
- Phone: restore from the chat bubble's ⋯ sheet.
- Hookless CLIs, if `agent_turn` ever gets a trustworthy edge for them.
