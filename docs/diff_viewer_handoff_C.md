# Diff viewer — handoff C (data loading, robustness, big diffs)

## Resume

- Branch `worktree-agent-ae9230fc338dc223d`, worktree
  `.claude/worktrees/agent-ae9230fc338dc223d` under the main checkout,
  from `develop` b07d96c9. Code commit **ef30df5b** (`wip(diff): …`, because
  not every gate ran); this file is the commit after it. Never run live.
- **Done:** all three goals (bug hunt with regression tests, big-diff budget,
  states + Refresh/Retry), backend `git_diff_file` tweaks, i18n in 5 languages,
  untested id `diffView.states`.
- **Half done:** nothing is half-written. Not done: the sync-resolver
  "newer side" request was reassigned by the user and not started; the
  rename case (below, "Not fixed"); `backend:stale` was not run (see below).
- **Gates run (Linux):** `brand-check`, `git diff --check`, `npm run lint`,
  `cargo clippy -p tabtivity -p app-serverd --all-targets`, `cargo clippy -p
  tabtivity --no-default-features --lib`, `cargo clippy -p app-serverd
  --all-targets` — all PASS (first `gates.sh` run). `node
  node_modules/typescript-native/bin/tsc` — PASS standalone (the `npm run
  build` in that run failed on a `SyncHandoffButton.test.tsx` error from a
  file that is not in this worktree — a sibling agent's tree; it did not
  recur). Targeted vitest: `diffBudget.test.ts` 16 + `DiffViewSource.test.tsx`
  16 tests, PASS.
- **Gates not run:** `npm run build` (vite/mobile/web bundles), full
  `npm test` / `vitest --changed` (so `UntestedRegistry`, i18n parity and
  `ViewerDiskReload` tests, which my edits can affect, are unconfirmed), `cargo
  test -p tabtivity -p app-serverd` (my two new Rust tests
  `git_diff_file_staged_only_change_shows_the_index_diff` and
  `git_diff_file_outside_a_repository_says_so` never ran), the daemon-build
  `cargo test --no-default-features`, `npm run backend:stale`.
- **Next steps:** (1) `scripts/gates.sh` in the worktree (cargo compiles from
  scratch here: slow under load); (2) run the two Rust tests by name and
  `npx vitest run src/__tests__/shell/UntestedRegistry.test.ts
  src/__tests__/shell/i18n.test.ts src/__tests__/viewers`; (3) `npm run
  backend:stale` and report it; (4) merge with Agents A/B: A's parser fix for
  the trailing-newline quirk (then drop the `replace(/\r?\n$/u, "")` in
  `DiffView.tsx`), B's layout must render through `drawn.files`/`drawn.lines`;
  (5) squash the `wip` message into a `fix(diff): …` once green.

## What changed

- `src/components/embed/diff/useDiffSource.ts` (new): all of DiffView's data
  loading, extracted from `DiffView.tsx`. Returns `{status, text, against,
  error, whole, relPath, refresh, canRefresh}`; `status` is `loading | ready |
  error | notRepo | blocked`.
- `src/components/embed/diff/DiffStates.tsx` (new): `DiffStateNote` (loading /
  error + Retry / not a repo / not connected / "No changes") and `DiffMoreRow`
  (the slim "Show more" row).
- `src/lib/viewers/diffBudget.ts` (new, pure): `capDiffFiles`, line windows
  (`initialLineWindow`, `growLineWindow`, `clampLineWindow`,
  `firstChangeIndex`), `shortenText` / `shortenLongLines` / `shortenDiffFiles`,
  `isNotARepoError`. Tests: `src/__tests__/viewers/diffBudget.test.ts`.
- `src/components/embed/DiffView.tsx`: uses the hook, draws through the budget,
  Refresh button in the header, state rows. `DiffLineRow` untouched.
- `src/components/embed/fileViewer/editableFile.tsx`: `useReadonlyFile` also
  returns `reload()` (bumps the first-read effect) so a patch file's read error
  can have Retry.
- `src-tauri/src/commands/git.rs` `git_diff_file`: a file outside any
  repository answers `"not a git repository"` (instead of git's two-path
  `--no-index` usage text); a tracked file whose only change is staged now
  shows the index diff (`git diff --cached`) instead of "No changes". Two Rust
  tests in `commands/git/tests.rs`.
- i18n: 11 `diffView.*` keys in all five languages. Untested id
  `diffView.states` (register row in `src/lib/untested.ts`; pills on the error,
  not-a-repo, not-connected, big-diff and long-line rows).
- Tests: `src/__tests__/viewers/DiffViewSource.test.tsx` (16 tests).

## Bugs found

Fixed (each has a regression test unless noted):

1. **Whole file view never laid out (parser quirk).** A git diff ends in `\n`;
   `parseUnifiedDiff` reads the final empty piece as one more blank context
   line, which makes `wholeFileHunk` return null (`source[n] !== ""`), so the
   default Whole file view silently fell back to bare hunks, plus a phantom
   blank last line in Changes view. Worked around in DiffView (strip one final
   newline before parsing, as `TerminalReaderChanges` already does); the
   parser itself is Agent A's — **see Flagged**.
2. **Stale answer under a retargeted tab.** After the tab switched file, the
   previous file's diff (and, in Whole mode, its text pair) stayed on screen
   until the new answer landed, and a late answer for the old file could land
   after the new one. Answers are now stored with their target and ignored on
   mismatch.
3. **Whole file view of an unreadable file** (deleted, binary, too big) showed
   the read error and hid the diff. It now falls back to the changes.
4. **Changes view did not follow edits** while open (only Whole did, through
   `against`); a differing re-read now re-asks.
5. **Hidden panes asked git at mount.** Every restored diff tab (and on a remote
   project, an SSH round trip) fired immediately. The first request now waits
   until the pane has been shown once; later changes are caught up by the file
   poll, which already stops while hidden and checks at once on show.
6. **Remote project, disconnected.** Neither git nor `sync_diff` was gated on
   the connection. Now a remote project's in-project git diff and every sync
   diff ask nothing until `ssh === "connected"` and say so.
7. **Sync mode keyed the file wrongly.** `sync_diff` was called with the path
   relative to the project directory, but the backend keys on the path under
   the mirror root (as `SyncMergeView` does). Now uses `localMirrorRootFor`.
   (Nothing in the desktop UI opens `syncdiff` tabs today, only the phone
   bridge calls `sync_diff`, so this was latent.)
8. **File outside git** showed a git usage dump / blank. Now says so.
9. **Staged-only change** showed "No changes" (backend, above).
10. **A transient failure replaced a good diff** (re-ask in Whole mode while git
    held `index.lock`): a shown answer now stays through a failed re-ask.

Not fixed:
- Renamed file with edits: `git diff -- <one path>` cannot see renames; the new
  path shows as added (untracked fallback) or the old as deleted. Needs a
  `git diff -M` with both paths; left.
- A file with both staged and unstaged edits shows the unstaged part only (the
  documented "working tree against the index" meaning, unchanged).
- The 252 GB `target/` of the main checkout is not shared; the first cargo gate
  in this worktree compiles everything.

## Big diffs

- Changes view: first 1500 rows (`DIFF_LINE_BUDGET`), then "Show 3000 more
  lines" / "Show all N lines". Files that fit keep their object identity.
- Whole file view: a 1500-row window opening 200 rows above the first change
  (the scroll-to-first-change still works because it is inside the window),
  with "Show N earlier lines" / "lines below" rows that grow it.
- Any line over 2000 characters is cut with `…` until "Show full lines" is
  pressed (one row of text can no longer lay out a megabyte). No
  `content-visibility`: WebKitGTK support was not verified, and the row cap
  makes it unnecessary.
- Parsing is already memoised on the text; the cap sits after it.

## Choices / gotchas

- Window/budget state is keyed by `path` and reset when the tab shows another
  file, not by the diff text, so a refresh keeps what the user opened.
- "Show all" on a 200k-line file will still be slow; that is the user's choice.
- `git_diff_file` returns the whole diff over IPC; a multi-MB lockfile diff is
  one big string. Not capped on the backend.
- Refresh clears the shown answer (so a failure is visible) — the automatic
  follow-edit path keeps it.
- Hook order: DiffView.tsx edits are confined to the top of the function (data)
  and the render's state rows; merging with A (`DiffLineRow`, parser) and B
  (layout) should be mostly mechanical. B will need to render through
  `drawn.files` / `drawn.lines` (not `files`/`wholeHunk.lines`) to keep the cap.

## Gates

See "Resume" at the top: which gates ran and which did not.

## Untested ids added

`diffView.states`

## Flagged for user

- **Parser quirk (Agent A's area, `src/lib/viewers/diff.ts`):** a diff text ending
  in `\n` yields a phantom blank context line in the last hunk. DiffView now
  strips the final newline before parsing; the cleanest fix is in the parser
  (ignore the empty last split piece), after which the workaround is harmless.
  Before this, the default Whole file view could not lay out any real git diff.
- `FileTree`'s diverged-file diff button and the phone bridge are the only
  callers of the host diff; the desktop never opens a `syncdiff` tab (see bug 7).
- Sync resolver (SyncMergeView/CompareView): the "which side is newer" request
  was reassigned and not touched here. One thing seen while reading
  `SyncMergeView.tsx`: it reads the local side with `.catch(() => "")`, so a
  mirror file that cannot be read looks identical to an empty file in the
  three columns.
- Backend was edited (`git_diff_file`) but `npm run backend:stale` was not
  run; the running window does not have this change until it is rebuilt.
