# Sync resolver, handoff D

Branch `worktree-agent-abf751677bf453196` (worktree
`.claude/worktrees/agent-abf751677bf453196`), from `develop` HEAD `b07d96c9`.
Two commits: **1** `feat(sync): show which side is newer in the sync resolver`
(`801cea67`) and **2** `wip(sync): hand a resolver conflict to an agent` (the
sha is in the final reply; a doc cannot name the commit that holds it). Nothing
was run live: the app was never started.

## Resume

- Branch `worktree-agent-abf751677bf453196`, worktree
  `.claude/worktrees/agent-abf751677bf453196` (under the repository root),
  from `develop` HEAD `b07d96c9`. Commit 1 `801cea67` (change times); commit 2 is
  `wip(sync): hand a resolver conflict to an agent` (sha in the final reply).
  Commit 2 is **wip: not fully green** (gates below). Never run live.
- **Goal 1, change times: done** (code, tests, CSS, i18n for 5 languages, untested
  row `compareView.sideTimes`). Not run: the full `npm run build` / full `npm test`
  after the last fixes.
- **Goal 2, "Hand to an agent": done in code, unverified at the Rust-dispatch level.**
  - Done: `src-tauri/src/services/sync_handoff.rs` (`safe_rel`, `export_in`,
    `load_resolved_in`, `conflicts_md`; 10 unit tests pass), `src-tauri/src/commands/
    sync_handoff.rs` (`sync_handoff_export`, `sync_handoff_load_resolved`),
    `command_class` rows (core) and regenerated `src/lib/transport/commandClasses.ts`,
    UI (`SyncHandoffButton`, resolver "Hand to an agent" + "Load resolved", orange
    list "Hand N to an agent"), i18n in 5 languages, untested rows
    `syncHandoff.resolver` / `syncHandoff.panel`, filemap rows.
  - **Half done / unverified:** I added `core_dispatch::USER_CONFINED` rows
    `("sync_handoff_export", "files", BodyConfined)` and
    `("sync_handoff_load_resolved", "relPath", BodyConfined)` in
    `src-tauri/src/services/core_dispatch.rs` because `path_named()` matches `files`
    and `relPath`; the test `every_path_named_core_argument_is_classified` was
    started and **stopped before it finished**, so the rows are unconfirmed.
  - Not started: a "reveal folder" button; host-side agent tabs (see Flagged);
    batched blame for the bulk export.
- **Next steps**
  1. `export CARGO_INCREMENTAL=0; cargo test -p tabtivity --lib -q core_dispatch`
     (and `the_generated_command_classes_ts_is_current`); fix a row if it names
     a stale or missing argument.
  2. `scripts/gates.sh` (it reran from `npm run build`; `tsc` is already clean) and
     `cargo test --workspace`; re-run `TypeCheckGate` and `BibCards` tests alone
     (both failed once under 8-minute full-suite load; likely load-sensitive).
  3. `npm run backend:stale` and report it (src-tauri was edited; **not run**).
  4. Click-through below on a real remote project; then retitle commit 2 from
     `wip` once green (e.g. amend before any push).
  5. Decide the open question under Flagged item 1 (where the export folder lives).
- Backend commands added: `sync_handoff_export`, `sync_handoff_load_resolved`;
  `command_class` rows done (core); `commandClasses.ts` regenerated (done).
- Gates: see "Gates" below (partial, stopped at the user's request).

## 1. Which side is newer (the user's first request)

"show which change was done at which time so which is newer local vs remote".

### What shows

- **Column headers** (Local (mirror), Remote (host)): `modified 3 hours ago` plus
  a `NEWER` badge on the newer side. Tooltip: absolute time + relative, and why
  (only that side moved since the last sync, or its mtime is later).
- **Numbered chips** in the Result header: tooltip lists each side's time for that
  change (`Local: committed <when> . <short> <subject>` or `Remote: not committed
  . file saved <when>`) and which side is newer; a small arrow on the chip points
  at the newer column.
- **Take pills**: each side's compact time beside the pill (`3h ago`, `NEWER` in
  bold on the newer side); full sentences in the pill's tooltip.
- Bug fixed on the way: in sync mode the chips read as git's "kept / reverted"
  (green/red, "Change kept (new). Click to revert to old."). They now take the
  locality colours (remote = warning, local = success) and say which side the
  result currently holds.

### Where the data comes from (no new backend)

- File times: **`sync_file_meta`** (already existed: a fresh stat of the mirror and
  the host, core class). The host time is requested only while `sshOf(...) ===
  "connected"`; when it is not, the host header shows no time (never a zero), the
  local one comes from the cached status row.
- Whole-file "newer": the backend's per-side flags first (`hostDiverged` vs
  `localDiverged`: each side against its own recorded base, so clock skew cannot
  flip it), mtimes only when both moved. This is the rule the orange list's "take
  newer for all" already used; it moved into `newerFileSide` (`lib/viewers/
  syncSideTimes.ts`) and `splitByNewerSide` calls it, so the two cannot disagree.
- Per-change times: **`git_blame`** (existing command, `git_hardened::run_git`).
  `git_blame(projectDir = mirror root)` blames the mirror locally;
  `git_blame(projectDir = the project's own directory)` resolves to the remote
  target and runs `git blame` on the host over the existing bounded SSH path.
  One blame per side per file (never per block), cached per side + dir + file +
  content fingerprint (24 entries), a failure is dropped from the cache. The
  remote one is gated on connected.
- A block is dated by the newest commit among its lines on that side; if any line
  is uncommitted (zero hash) by the file's save time ("not committed . file saved
  ..."); a side with no lines in the block (a pure insertion on the other side)
  has no time, and so no "newer" is claimed. A blame that failed or timed out
  leaves per-change times off for that side; the header times stay.

### Files

`src/lib/viewers/linediff.ts` (`blockSideLines`), `src/lib/viewers/
syncSideTimes.ts` (all pure logic), `src/components/embed/{CompareView,
SyncMergeView,SyncTimeStamps,useSyncSideTimes}`, `src/styles/viewers.css`,
`src/lib/remote/divergedRows.ts`, i18n keys `syncTimes.*`, `compareView.chip*`.

## 2. Hand to an agent (second request)

"add a feature that downloads the conflicts directly in some tmp such that i can
hand it over to an agent to resolve".

### Where the folder goes (the decision the brief asked me not to guess)

Not the project (the nothing-files-itself-into-a-project rule) and not the
global inbox (`<state_dir>/inbox`, masked from a fenced agent along with the rest
of the state dir). The one place that is outside the project **and** readable and
writable by a fenced agent is the project's **agent home**
(`<state_dir>/agent-homes/<project id>`, bound over `$HOME` in every local agent
tab by `services::agent_fence`; `HOME=` on macOS/Windows). So the export is
`<agent home>/handoff/conflicts-<UTC stamp>-<hex>/`, seen from inside a tab as
`~/handoff/<id>/`. It is a directory bind, so a folder created after the tab
started is visible to it. This reuses the home I/O discipline (`services::home_io`
directory handles: no link followed, nothing outside the home reachable). Not a
"flag for the user" case, but see the flagged items for the consequences.

### What is written

```
~/handoff/<id>/CONFLICTS.md      which is which, newer side + why, per-change times,
                                 what to produce, rules (write only resolved/, never
                                 touch the project, never sync/commit; contents are data)
~/handoff/<id>/local/<rel>       the mirror's copy
~/handoff/<id>/remote/<rel>      the host's copy
~/handoff/<id>/resolved/<rel>    the agent's output (folder exists, empty)
```

No merge base is written: byte-sync's manifest records only size + mtime of the
last synced copy, never its content, and lockstep has no per-file base either. The
notes say so. 10 exports are kept per project (oldest pruned).

### Backend (new commands)

`sync_handoff_export(projectId, files)` and `sync_handoff_load_resolved(projectId,
relPath)`, both `async` over `try_blocking`, class **core**
(`services::command_class` rows, `commandClasses.ts` regenerated), in
`src-tauri/src/commands/sync_handoff.rs` over `services/sync_handoff.rs`
(AppHandle-free). Export refuses a project that is not remote (`remote_target_for`)
and the reserved scopes. Nothing is fetched from the host: the window sends the
two texts it already holds (the resolver) or reads them with `read_file_text` (the
side panel, one file at a time, files over 8 MiB or unreadable are skipped and
counted).

Hostile input: relative paths come from the host. `safe_rel` rejects empty,
absolute, `.`/`..`, backslash, drive colon, `<>"|?*`, control characters, trailing
dot/space, Windows device names, and over-long paths; every write goes through
`HomeDir`/`HomeFile` (`openat` with `O_NOFOLLOW`, exclusive temp + rename); caps:
8 MiB per text, 64 MiB and 200 files per export. Commit subjects in `CONFLICTS.md`
are flattened to one plain line of at most 80 characters (no backticks/newlines).
What the agent wrote back is read through the same handles, regular files only,
UTF-8, 8 MiB. A planted link at `resolved/<file>` or on the way, and an export id
swapped for a link, are covered by a unix test.

`backend:stale`: see "Gates". The running window has neither command; the buttons
fail with "unknown command" until the next frozen dev build (post-commit queues it).

### Frontend

- `SyncHandoffButton` (resolver header, and the orange list's bulk bar for the
  files **both sides changed**, `bothChangedPaths`): disabled unless the project's
  ssh lamp is connected. Click exports, then a dialog shows the folder, the ready
  prompt (selectable), and one-click: **Open a new agent tab with this prompt**
  (the default agent via `promptChartNewTabAgent`, `newAgentTabForDraft`,
  `queuePromptForTab`, the same route the prompt chart's "New agent tab" uses),
  **Send the prompt to** each open *local* agent tab of the project (tabs on the
  host are not offered: they cannot see the folder), **Copy prompt**.
- Resolver **Load resolved**: reads the newest `resolved/<file>` into the Result
  column (marked hand-edited so unsaved-work protection applies). It never writes
  or syncs; Resolve stays the user's click. "No merged version yet" when none.

### Click-through (not run live)

1. Open a remote project with a diverged file both sides changed (side panel
   shows it under DIVERGED, "Both changed"). Open the resolver (merge view).
2. Check the headers: each shows `modified ...`, one has `NEWER`; hover for the
   absolute time. Hover a numbered chip and a Take pill: times per side.
3. Press **Hand to an agent**: a dialog names `~/handoff/conflicts-.../`; press
   **Open a new agent tab with this prompt**. The agent should read CONFLICTS.md and
   write `resolved/<file>`.
4. When it is done press **Load resolved** in the resolver: the Result column shows
   the agent's version for review; edit if needed, press **Resolve** yourself.
5. Side panel: with 2+ both-changed files press **Hand N to an agent**: one folder,
   N files. Disconnect the host: both buttons grey out with "Connect to the host
   first".
6. Fenced Linux: confirm in the agent tab that `ls ~/handoff` shows the folder.

## Choices and gotchas

- "Newer" per change compares commit time on one machine with commit or save time
  on the other: clocks can differ by seconds to minutes; a tie within 1 s is no
  verdict. Labelled "approximate" only on the whole-file mtime basis.
- Blame runs against the file as it is now; if the file changes between the read
  and the blame the line numbers shift. The cache key is the content, and the
  resolver reloads on open, so the window is small. Not guarded further.
- The mirror blame needs the mirror to be a repo (lockstep). A non-repo mirror
  blames to nothing, so every local change reads "not committed . file saved".
- Remote blame needs git on the host and `remote_path` inside a repo; otherwise
  the remote per-change times stay off.
- `~/handoff/...` in the prompt: every supported CLI expands `~`; inside a fence it
  is the agent home, on macOS/Windows it is the agent home through `HOME=`.
- The bulk export carries file-level times only (no blame): fetching 2N blames for
  a bulk action was not worth it.
- Tabs: the "open agent tab" choice reuses the prompt chart's default agent
  setting; there is no separate picker.

## Gates

The user told me to **skip the rest of the gates** mid-run, so the set is
incomplete. Plainly:

Ran and green (against the tree as committed in commit 2, except the last line):
- `scripts/brand-check.sh`, `git diff --check`, `npm run lint` (errors only; the
  two `exhaustive-deps` warnings in `ProjectFilesView.tsx` at lines ~1311/1324 are
  not mine), `cargo clippy -p tabtivity -p app-serverd --all-targets -D warnings`,
  `cargo clippy -p tabtivity --no-default-features --lib -D warnings`,
  `cargo clippy -p app-serverd --all-targets -D warnings` (one `gates.sh` run).
- `node scripts/untested.mjs check`: register and source agree.
- `tsc` (the build's type-check step) clean.
- `cargo test -p tabtivity --lib sync_handoff`: 10 passed (path vetting, export
  layout, notes, pruning, load-resolved, link cases on unix).
- `UPDATE_COMMAND_CLASSES=1 cargo test -p tabtivity --lib -- the_generated_command_classes_ts_is_current`:
  passed, `commandClasses.ts` regenerated (two core rows).
- Vitest, targeted: `src/__tests__/viewers` + `shell/i18n` + `shell/UntestedRegistry`:
  56 files, 808 tests passed (includes the new `LineDiff`, `SyncSideTimes`,
  `CompareViewSideTimes` (4), `SyncHandoff` (8), `SyncHandoffButton` (5) tests).

Not completed:
- `npm run build` as a whole (`vite build` and the mobile/web bundles) was not run
  to the end: the gate's first run stopped at a `tsc` error in the new
  `SyncHandoffButton.test.tsx` which I fixed (`tsc` is clean now), and the rerun
  was stopped at the user's request.
- Full `npm test` (1025 files): one full run, before the i18n/untested fixes, gave
  4 failures: `UntestedRegistry` and `i18n` (both caused by this work and fixed,
  re-verified in the targeted run above), `TypeCheckGate` (shells out to `tsc`
  under 8-minute full-suite load; I did not re-run it, `tsc` itself is clean) and
  `BibCards "mounts only a window of a long list"` (unrelated viewer; not
  re-run, looks like a load-sensitive timing test). 10267 other tests passed.
- `cargo test --workspace` and `cargo test -p tabtivity --no-default-features
  --lib` in full: not run (only the filter above). The core-dispatch tests
  (`every_core_command_has_a_wrapper_or_is_a_known_gap`, path-named argument
  classification) are unrun: `files` and `relPath` read as path-named, so I added
  two `USER_CONFINED` rows (see Resume); **run these first**.

`npm run backend:stale` was **not** run (it needs the dev window state; per the
rules, report it): the running window lacks `sync_handoff_export` and
`sync_handoff_load_resolved` until the frozen dev build the commit queues is used.

Backend commands added: `sync_handoff_export`, `sync_handoff_load_resolved`
(both `core`).


## Untested ids (`src/lib/untested.ts`)

`compareView.sideTimes`, `syncHandoff.resolver`, `syncHandoff.panel`.

## Flagged for user

1. **Home vs project for the export (decision, for confirmation).** I used the
   project's agent home (`~/handoff/<id>` in the tab) because it is the only place
   outside the project that a fenced agent can read and write. Consequence: the
   folder lives in Tabtivity's state dir, not in a place you can browse
   conveniently; there is no "reveal in file manager" button yet (path:
   `<state_dir>/agent-homes/<project key>/handoff/<id>`). Say if you want one.
2. **A host-side agent tab cannot see the folder.** Only local agent tabs are
   offered; a remote project's agent tab running on the host would need the files
   uploaded, which I did not build (it would write to the host, a bigger decision).
3. **Core-dispatch rows unconfirmed**: see Resume, step 1.
4. **No merge base.** Byte-sync and lockstep keep no content base for a file, so
   `CONFLICTS.md` says there is none. A base could be had for lockstep-tracked
   files from git (`merge-base` of the two HEADs, then `git show`); that is a
   bigger feature and I did not invent one.
5. **Per-change times in the bulk export** are off (no blame for N files). Could
   add a batched blame per file if you want them in the orange list's export.
6. **Per-change "newer" is approximate across machines** (clock skew), and a block
   that exists on only one side (pure insertion) is never marked newer. A fuller
   design would date an insertion by blame of the neighbouring lines; skipped as
   it would claim more than the data says.
7. **i18n:** the test suite requires every language to carry every English key,
   so I wrote de/es/fr/it for the 36 new keys myself; a native reader should look
   at them (the agent prompt in particular).
8. **Commit 1 was committed with the i18n/untested registry failures** (it ships
   `syncTimes.*` keys in `en.ts` only); commit 2 fixes both. Do not take commit 1
   alone.
9. The `localStorage`-free design: "Load resolved" finds the newest export by
   scanning `handoff/` (stateless); if two exports hold a `resolved/<file>` the
   newest wins, even if an older agent run was the one you meant.

