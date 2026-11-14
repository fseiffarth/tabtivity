# Diff notes to the agent — handoff

Implements every step of `docs/diff_notes_plan.md` (frontend only, no Rust).
Never run live: the feature wears the `diff-notes` `UntestedTag`.

## Commits

- `1288b3b1e` feat(reader): notes on diff lines, added to the Chat draft (the whole feature, tests, docs)
- `5ad50fdde` docs: this handoff names its commit
- `aceb58445` fix(reader): diff note box takes the keyboard under steering and keeps its text on Shift+click (review fix)

## What was built

- `src/lib/agents/diffNotes.ts` (pure): `DiffNote`, `buildDiffNotesPrompt`,
  selection helpers (`noteRows`, `rangeLines`, `slotLine`, `describeSelection`,
  `firstNoteLine`). Tests: `src/__tests__/agents/DiffNotes.test.ts`.
- `src/stores/agents/diffNotes.ts`: per-PTY Zustand store (add, update, remove,
  removeMany, clear), memory only; a tab that leaves `tabsByScope` takes its
  notes with it (subscription starts on the first note; a scope the window holds
  no tabs of is left alone, so a popout's empty store never sweeps).
- `src/components/terminal/DiffNoteBox.tsx`: the note box (Ctrl/Cmd+Enter saves,
  Esc cancels, takes focus on open) and the saved-note row (edit, delete).
- `TerminalReaderChanges.tsx`: gutter button and Shift range selection in both
  layouts, notes hung under the last selected row, card count chip, header
  "N notes · Add to draft · Clear", `viewNote` steering key, new required
  `ptyId` prop (passed by `TerminalReaderView`).
- `components/embed/DiffView.tsx`: `DiffLineRow` (`noteAt/onNote/noted/noteLabel`)
  and `SplitRows` (`notes`) take optional note props; the git-panel diffs pass
  none and render as before.
- CSS beside the `.terminal-changes-*` rules in `src/styles/subwindows.css`; the
  note box shares the Reader composer's textarea rule and the shared
  `.btn-primary` / `.btn-quiet` buttons.
- i18n: 17 `diffNotes.*` keys and 3 `steering.*` keys in en, de, es, fr, it.
- Register row `diff-notes` in `src/lib/untested.ts`; file-map row, help text
  (`docs/help/agent-clis.md`, `docs/help/keyboard.md`).
- Tests: `src/__tests__/terminal/ReaderDiffNotes.test.tsx` (UI through the
  Reader: split note + Add to draft, folded-card key + Shift range + edit +
  delete, Clear); existing steering tests updated for the new action.

## Choices where the plan was silent

- **Steering key is `C`, not `n`.** `n` is already the Inside action `viewNew`
  ("Next new"). A new Inside action `viewNote` (default `c`, rebindable) was
  added to `steeringBindings.ts`, the legend (`shortcuts.ts`, "inside Diffs"
  block) and the keyboard help. `c` was a dead letter Inside (calendar, swallowed).
- **Switching to Chat**: no extra code was needed. The Reader composer stays
  mounted under Diffs and its `onReaderInsert` handler calls `onReveal`
  (`onShowChat`), so `insertIntoReader` already flips to Chat and inserts.
  `insertIntoReader` returns false only when no composer is mounted (an earlier,
  read-only chat is open); then the header shows an alert
  (`diffNotes.noComposer`) and the notes are kept.
- **Quote format**: marker, a space, then the line (`+ x`, `- y`, context `  z`),
  exactly as the plan's example shows (not git's marker-flush `+x`).
- **Fence**: a quote that contains backticks gets a fence one longer than its
  longest run, so a quoted fence cannot close it.
- **8 000-character cap**: the first note always goes in, however long; later
  notes stop at the cap. Only the notes that fit are inserted and removed from the
  store; the button then reads "Add N of M to draft" with a title explaining,
  and the rest stay for a second round.
- **Extra fields on `DiffNote`** (`card`, `hunk`, `lines`): where the note sits
  on screen (card key, hunk index, line indices in the hunk). They are not in
  the prompt. Notes of a card that is not shown (another subagent/chat) still
  count in the header and are still inserted.
- **Notes are per card, not per file**: two edits of one file are two cards, and
  a note shows only under its own card; the prompt still groups by file.
- **Split view**: a row of a del/add pair selects both lines; the "note" side is
  `old` only when every selected line is a deletion, else `new` with the range
  taken from the lines that have new-side numbers.
- **One draft box at a time** across cards. Starting a note elsewhere discards
  an unsaved box's text (no prompt).
- **Untested pill** sits beside the existing Diffs pill in the header (always
  visible), not inside the N > 0 actions group, so the feature is flagged before
  the first note is taken.
- **Delete** of a single saved note asks nothing; only Clear with more than one
  note asks (through `useDialogs()`).
- `+` is a plain ASCII glyph on the gutter button (no emoji, no new icon).

## Gotchas

- `hunk.lines` starts with the `@@` header line (type `hunk`), so line indices in
  a hunk are one more than the body-line position; `noteableLine` skips it.
- The Reader's footer chips have a "Clear" button too; query the header actions
  by `.terminal-changes-notes` in tests.
- `scripts/gates-job.sh` runs vitest with `--changed`; the full count is below.

## Gate results

Run with `scripts/gates-job.sh start` (frontend scope, 24 files against a2a5ecb45):

- `scripts/brand-check.sh`: PASS
- `git diff --check`: PASS
- `npm run lint`: PASS (no new warnings)
- `npm run build` (tsc + desktop, mobile, web bundles): PASS
- `vitest run --changed`: 8 468 tests in 817 files (count plausible; the pdf.js
  tests ran). 35 failed, all in 25 files unrelated to this change, and all
  timeouts under a machine load average of ~90 from other sessions (`Test timed
  out in 20000ms`). Re-running exactly those 25 files on a quieter machine:
  146 of 147 passed. The one real failure was
  `shell/SteeringReaderInside.test.tsx` "lets a dead pane key reach the target":
  it used `c` as its example dead key, and `c` is now `viewNote` Inside. The
  test now uses `m` (mail); the same swap was made in `SteeringBindings.test.ts`.
  Then `src/__tests__/shell` (all), `ReaderChangesSteering`, `ReaderDiffNotes`
  and `DiffNotes`: 102 files / 972 tests pass.
- The gate job's own result was not recorded for reuse ("the tree changed while
  they ran": the handoff file and that one test fix were written meanwhile).
- No Rust gates: no backend change. `scripts/privacy-check.sh`: pass.

## Flagged for user

- Key change from `n` to `C` (conflict with Next new). Say if you want `n`
  moved or another letter.
- Not verified live. Click-through: Claude tab with a few edits, Diffs, note an
  added range and a deleted line in two files (split, then unified), Add to
  draft: the Chat composer should hold the prompt of the plan and the notes
  should be gone; repeat on a subagent's Diffs. Also check the `+` hover button
  placement on the real WebKitGTK paint path (absolute button over the first
  line-number gutter) and the sticky note box with a horizontally scrolled diff.
- Phone `ChatChanges` and the git-panel `DiffView` are not covered (plan: later).
- No backend change, so `npm run backend:stale` does not apply.

## Reviewer notes (2026-11-13)

Reviewed `develop..HEAD` (1288b3b1e, 5ad50fdde); fixes in aceb58445: prompt builder, store, UI,
steering, i18n, CSS, docs. Two confirmed bugs, both fixed with a test:

- **`C` opened a note box that could not be typed into while steering was on.**
  Steering's `handToField` never lends the keyboard to a field inside a
  `.center-pane` (a tab's own editor must not grab it), and the Reader lives in
  one, so after `C` the box had focus but every key was swallowed by the mode.
  The new `ReaderDiffNotes`-level test had called the Inside target directly and
  never went through `useSteering`. Fix: `DiffNoteBox`'s textarea carries
  `data-steering-field`, and `handToField` admits such a field after a steering
  key (then Esc / Ctrl+Enter-and-unmount bring steering back as for any inline
  field). Test: `shell/SteeringReaderInside.test.tsx` "hands the keyboard to a
  marked text field".
- **Shift+click lost the typed text** when it moved the box to a later row (the
  box remounts under another row, its text started from the empty draft). The
  text is now kept in a ref as it is typed and carried by the extend. Test:
  `terminal/ReaderDiffNotes.test.tsx` "keeps what was typed when Shift+click
  moves the box to a later row".

Checked and fine: side/range/quote logic (deleted, added, context, mixed,
split pairs), grouping, 12-line cap, 8000-char cap (`included` is exactly what
is inserted and removed), fence escaping, path relative to the tab's folder;
store lifetime and sweep; card keys stable as `agent_tab_changes` refreshes
(`at|path|n`; a diff is immutable once written); `insertIntoReader` fallback;
`c` collision (no other Inside binding uses it; the `c` -> `m` test fixture
change was right, `c` was only ever a swallowed dead key Inside); all five
dictionaries translated; `UntestedTag` row, filemap rows, help lines.

Flagged for the user (not changed):

- Notes of a card that is not on screen (another subagent / chat) count in the
  header and go into the prompt, but cannot be edited or deleted one by one
  until that card is shown again; Clear removes them all.
- Starting a note on another line while a box holds unsaved text discards that
  text without asking (documented above as a decision).
- The prompt lead line and "removed lines" wording follow the UI language, not
  the language the user writes to the agent in.
- A single note longer than 8000 characters is still inserted whole (the first
  note always goes in).
