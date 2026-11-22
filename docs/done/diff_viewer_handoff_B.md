# Diff viewer, part B: layout and navigation

Branch `worktree-agent-ac84388c94ef34606` (from `develop` HEAD b07d96c9). Not run live.

## What changed

- `src/lib/viewers/diffRows.ts` (new, pure, tested): `splitDiffRows` (moved out
  of `TerminalReaderChanges`; rows now also carry `at` and `start`),
  `changeStarts` / `changeAnchors` / `stepChange`, `foldRanges` / `foldSegments`
  (`FOLD_MARGIN` 4, `FOLD_MIN` 6), `fileStats`, `fileLabel` (rename arrow),
  `scrollTopFor`.
- `DiffView.tsx`:
  - Unified / Split `Dropdown` in the header (`storageKey("diffView.split")`,
    default unified), same `.terminal-changes-split*` markup and CSS as the
    Reader's Diffs tab. Works in Changes and Whole file.
  - Previous / next change buttons with an `n / m` counter (`– / m` until one is
    landed on). Keys while the diff has focus: `n` / `p`, `F7` / `Shift+F7`,
    `Alt+Down` / `Alt+Up`. Scrolls by computing `scrollTop` on the viewer's own
    scroller (`useLayoutEffect` on a `data-jump` target), centring the change.
    The landed-on change gets a static inset accent bar (`data-current`).
    Stepping into a collapsed file opens it first.
  - Multi-file patches: a file index (`<nav class="diff-index">`, max 9.5em then
    scrolls) with path, `old → new` for renames, `+/−` counts; clicking jumps to
    the file's top. Every file header is a fold button (caret) and shows counts.
  - Whole file: long unchanged runs fold into a "Show N unchanged lines" row
    (4 lines kept beside a change, a run folds only when at least 6 lines are
    hidden); a click expands in place. Whole mode is now rendered as a
    one-file, one-hunk `shown` list through the same path as patches.
  - The old "open whole file at first change" effect now uses the same jump
    (no `Element.scrollIntoView`) and selects change 1.
- The per-hunk line loop moved into the memoised `HunkBody` component; the
  per-line call is still `<DiffLineRow line={line} />` (wrapped in a
  `div.diff-anchor` only for a change's first line). Agent A's marks prop goes
  there. Split rows are drawn there too, and have no word highlight yet.
- `subwindows.css`: block after `.terminal-changes-split-note`.
- i18n: `diffView.{split,unified,layout,prevChange,nextChange,changeCount,
  showUnchanged,fileIndex,foldFile,unfoldFile,renamedFrom}` in en/de/es/fr/it;
  the Before / After headings reuse `terminal.changes.before/after`.
- `docs/filemap_frontend.md`: one new row for DiffView + diffRows.

## Choices

- Default layout is unified (the existing look); the Reader's tab stays split.
- Fold/expand state and collapsed files reset when the tab's `path` changes; a
  fold's key includes its line range, so an edit that moves it re-folds it.
- Next from nothing selected goes to change 1, previous to the last; both wrap.
- Keys are bare letters on the viewer's scroller only (focus is taken by a
  click or by the nav buttons), so they never reach the steering/keymap code.

## Tests

- `src/__tests__/viewers/DiffRows.test.ts` (pure parts).
- `src/__tests__/viewers/DiffViewLayout.test.tsx` (index, rename arrow, file
  fold, stepping buttons + keys, collapsed file reopening, split pref
  persisting and restoring, whole-file folds expanding in place).
- `TerminalReaderToolbar.test.tsx` now imports `splitDiffRows` from `diffRows`.

## Untested ids added

`diffView.layout` (row in `src/lib/untested.ts`; pill sits beside the change
counter). `diffView.wholeFile`'s pill moved into the file header unchanged.

## Gates

`scripts/gates.sh` (frontend only): brand-check PASS, whitespace PASS,
`npm run lint` PASS (no new warnings), `npm run build` PASS. `npm test`
(`vitest --changed`, 752 affected files, 7166 tests): 18 files / 21 tests failed
in the first run while the machine was at load ~80 (timeouts in unrelated mobile,
tex, git, pdf, root and tab tests); re-running exactly those files with 4 workers:
225 files / 2129 tests all passed. The new tests (DiffRows, DiffViewLayout: 6)
and TerminalReaderToolbar passed in the full run too.

## Flagged for user

- `parseUnifiedDiff` turns the final empty string of a text ending in `\n` into
  a context row with empty text (the Reader strips the trailing newline before
  parsing for that reason). A `.patch` file opened in `DiffView` therefore shows
  one blank numbered row at its end, and a git diff whose backend text keeps its
  final newline would defeat `wholeFileHunk`. Agent A's area; not touched.
- Pure renames (git's `similarity index 100%`, no `---`/`+++`/hunks) parse to a
  file with empty paths, so the index shows an empty name. The label helper
  handles `oldPath !== newPath` once the parser fills them in.
- The diff body's long lines do not wrap in unified mode, so a line's colour
  band stops at the viewport width when scrolled sideways (existing behaviour).
- Design question: the keys are `n`/`p` (plus F7, Alt+arrows). Say if you want
  them rebindable like the steering keys.
