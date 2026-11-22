# Diff viewer, agent A: parser and word-level highlights

Branch `worktree-agent-a17b139159945edc0` (from `develop` HEAD b07d96c9). The
commit sha is in `git log` (a doc cannot name the commit that holds it).
Nothing here was run live; the app was never started.

## What was done

1. `src/lib/viewers/wordDiff.ts` (new, pure): intra-line marks.
   - `tokenize` (word runs `\p{L}\p{N}_`, whitespace runs, single punctuation
     characters), `wordMarks(old, new)`, `hunkWordMarks(lines)` and
     `splitByMarks(text, marks)`.
   - `hunkWordMarks` pairs the n-th line of a `del` run with the n-th line of
     the `add` run that immediately follows (a `\ No newline` marker between
     them is looked through) and returns `Map<DiffLine, WordMark[]>`, keyed by
     the line object so unified and split layouts share one result.
   - Marks are UTF-16 `[start, end)` offsets into the line text (marker char
     excluded). Neighbouring changed tokens merge; a single blank between two
     changed stretches is absorbed (`foo bar` -> `baz qux` is one mark).
   - Bail-outs (whole-line tint only): line over 2000 chars, over 600 differing
     tokens after trimming the common head/tail, under 40% shared non-blank
     text, identical text, or marks covering the whole line. A hunk has a
     3M-cell LCS budget; once spent, later pairs are not marked.
   - The LCS is a local Uint16 table over tokens, not `linediff.ts`'s: that one
     works on string arrays with a different cap and returns aligned rows, and
     adapting it would have meant a refactor of the CompareView code (not mine).
2. Rendering: `DiffLineRow` takes `marks`; new exports `MarkedText` (text as
   React children, marked stretches in `<span class="diff-word">`) and
   `DiffHunkLines` (memoised marks + the line loop). DiffView's two line loops
   use `DiffHunkLines`; `TerminalReaderChanges` passes marks to the unified
   `DiffLineRow` and to the split `<code>` cells via `MarkedText`.
3. Colours: `ADD_BG`/`DEL_BG`/`lineBackground` are gone. `:root` tokens
   `--diff-add-bg`, `--diff-del-bg` (15% of the theme's `--success`/`--danger`)
   and `--diff-add-mark`, `--diff-del-mark` (38%) live in `subwindows.css`
   with `.diff-line.is-add/.is-del`, `.diff-word`; the Reader's split rows use
   the same tokens (they were 13% before). No shadows, no animation.
4. Parser (`diff.ts`), `DiffFile` gained `status`
   (`modified|added|deleted|renamed|copied`), `binary`, `combined`, `crlf`
   (all required) and `oldMode`, `newMode`, `similarity` (optional); new
   exports `diffFilePath`, `unquotePath`, type `DiffFileStatus`.
   - `diff --git` header paths (quoted, C-style octal UTF-8; unquoted with
     spaces when both sides name the same file), `rename|copy from/to`,
     `similarity index`, `new/deleted file mode`, `old/new mode`,
     `Binary files … differ`, `GIT binary patch` (flag, no hunks; the payload is
     skipped), quoted `---`/`+++` paths.
   - Hunk counts are now tracked: a deleted `-- x` line (`--- x`) is a line, not
     a file header, unless `---`, `+++`, `@@` really follow (forgives wrong
     counts). A second `---` after a file's hunks starts a new file
     (headerless multi-file diffs were merged into one file before).
   - The empty string a trailing newline leaves after the last hunk line is no
     longer a bogus blank context line.
   - Combined diffs (`diff --cc|--combined`, `@@@`): one marker column per
     parent is dropped from the text; line is `del` if any column is `-`, `add`
     if any is `+`; `newNo` follows the result, `oldNo` the first parent only
     (null when the line is not in parent 1).
   - CRLF: `\r` stripped from every line, `crlf` set on the file.
   - `wholeFileHunk` returns null for a binary file.
5. DiffView: one-line `.diff-file-note` under a file header in the changes
   list for rename/copy (with similarity), binary and mode change
   (`fileNotes`, keys `diffView.binary|renamedFrom|copiedFrom|similar|modeChange`
   in `en.ts` only; other locales fall back to English).

## Choices and gotchas

- Mobile (`ChatChanges`, `DivergedSheet`) only flatMap hunks; they compile
  unchanged and show no word marks (their own CSS; out of scope).
- `camelCase`/`snake_case` identifiers are one token, so `isAdmin` ->
  `isOwner` marks the whole identifier.
- Index-wise pairing for unequal runs (2 del, 3 add pairs the first two); the
  similarity bail-out protects against nonsense pairs.
- The word-marks `UntestedTag` is in the changes-list file header only (the
  Whole-file header keeps its own tag). Whole-file mode shows no
  rename/binary notes (it always has one file).
- `docs/filemap_frontend.md` has no rows for DiffView/diff.ts, so none was
  updated; `wordDiff.ts` has none either.
- Whole-file mode is a long hunk: `hunkWordMarks` runs over it once (memoised
  on the `lines` array identity).

## Untested ids added

`diffView.wordMarks` (area viewers) in `src/lib/untested.ts`.

## Gates

`scripts/gates.sh` (diff-selected): brand PASS, `git diff --check` PASS,
`npm run lint` PASS (no new warnings), `npm run build` PASS (re-run after the
last edit), vitest `--changed` ran 742 files on a loaded machine: 733 passed,
9 failed. One of the 9 was mine (the i18n parity test: `de/es/fr/it` lacked the
five new `diffView.*` keys; added). The other 8 files (ManageClisCodexHookTrust,
PdfMarkupQuestions, PdfZoomRaster, BibCards, odtArchive, MobileFocusQuestion,
MobileMarkupTicks, MobileSignInTabRow) are timeouts under load (three gate
runs from sibling agents shared the CPU); all 9 files pass when re-run alone
(79 tests). New tests: `diff.test.ts` 35 (was 10), `wordDiff.test.ts` 32,
`DiffLineMarks.test.tsx` 4; `TerminalReaderChanges.test.tsx` still green.
No Rust touched.

## Flagged for user

- Design: are 15% / 38% tints right on every theme? Never looked at live.
- Design: split the word tokens on camelCase boundaries too?
- Others' areas: DiffView's `.diff-error` still uses a hardcoded `#f85149`
  (could be `var(--danger)`); the whole-file header and changes-list header
  duplicate their inline styles; `git_diff_file` output for a binary file now
  yields a note only in the changes view (whole mode falls through to it since
  `wholeFileHunk` returns null).
