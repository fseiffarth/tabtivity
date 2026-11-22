# Diff notes to the agent — plan

> **Status (screened against code 2026-11-22):** Built in `1288b3b1e` (+ `aceb58445`): `lib/agents/diffNotes.ts`, `stores/agents/diffNotes.ts`, `DiffNoteBox.tsx`, `TerminalReaderChanges.tsx`. Differs from the text below: steering key is `C` (`viewNote`), not `n`; notes are per card, not per file; the 8 000-character cap inserts the notes that fit and keeps the rest. "Later" (phone `ChatChanges`, git-panel `DiffView`) is open and unbuilt. Live QA tag: `diff-notes`. Not live-tested unless the doc/todo says so.

## Why

Reviewing an agent's work happens in the Reader's Diffs tab
(`TerminalReaderChanges.tsx`), but answering it means switching to Chat and
retyping "in foo.ts around line 40, the …" by hand. T3 Code lets you comment
on diff lines and send the comments back to the agent. We already have every
piece: the diff lines carry old/new line numbers (`DiffLine.oldNo/newNo`,
`src/lib/viewers/diff.ts`), and the Reader composer takes inserted text
(`insertIntoReader`, `src/lib/terminal/terminalDrop.ts`). The new part is only
the note UI and the prompt it builds. It is a frontend-only change.

## Fixed decisions (user, 2026-11-13)

1. **Collect, then insert into the draft.** Notes are gathered across lines
   and files; **Add N notes to draft** inserts them as one prompt into the
   Chat composer. The user reads, edits and sends it. Nothing is ever sent
   directly, so there is no new PTY write route.

Decided here:

2. **Desktop Reader Diffs tab only** in phase 1, in both the *Agent's edits*
   view and, once `docs/done/turn_checkpoints_plan.md` lands, its *Since
   checkpoint* view (the same `ChangeCard`). The phone's `ChatChanges` and
   the shared `DiffView` (git panel diffs, which has no agent tab to target)
   come later.
3. **The quote travels with the note.** Line numbers go stale the moment the
   agent edits again, so every note carries the lines it is about, copied
   from the diff. The agent finds them by content, not just by number.
4. **Notes belong to the tab**, not the file. They are kept per PTY in a small
   store with the Reader draft's lifetime (`lib/agents/readerDrafts.ts`), and
   inserting them clears them. Switching subagent or chat in the Diffs tab
   keeps them (each note names its own file).

## Design

### Taking a note

- Each body row of a card's diff (unified and split) gets a gutter button on
  hover/focus: **＋ note**. Click starts a note on that line; Shift+click on
  another row of the same hunk extends it to a range.
- An inline note box opens under the last selected row: textarea, **Save**
  (Ctrl+Enter), **Cancel** (Esc). The lines stay highlighted
  (`.diff-line.noted`, a static tint, no animation).
- A saved note shows as a compact row under its lines: the text, ✎ edit,
  🗑 delete. Its card head gets a count chip.
- The Diffs header gets **N notes · Add to draft · Clear**, shown only when
  N > 0. Clear asks through `useDialogs()` when N > 1.
- Steering: inside the Diffs target (`changesSteerKey`), `C` starts a note on
  the cursor card's first changed line; the box then takes focus.

### The note record

```ts
interface DiffNote {
  id: string;
  path: string;            // as the card shows it (shownPath: relative to the tab's cwd)
  side: "new" | "old";     // old only when every selected line is a deletion
  from: number; to: number;// line numbers on that side
  quote: string[];         // the selected lines with their +/−/space marker
  text: string;
  at: number;
}
```

### The prompt it builds

`buildDiffNotesPrompt(notes, t)` in `src/lib/agents/diffNotes.ts`, pure and
unit-tested. Notes are grouped by file in first-noted order, and the lead line
comes from i18n. In English:

````
Review notes on your changes:

src/lib/foo.ts:42-44
```diff
+ const limit = opts.limit ?? 10;
+ if (items.length > limit) {
+   items.length = limit;
```
→ Don't mutate the caller's array; slice instead.

src/lib/bar.ts (removed lines 12-13)
```diff
- // keep in sync with baz.ts
- export const SIZE = 4;
```
→ baz.ts still imports SIZE.
````

- The quote is capped at 12 lines per note, with `… (N more lines)` after
  that, and the whole prompt at 8 000 characters. The button says when the
  cap would cut notes, and inserts nothing silently.
- Inserting goes through `insertIntoReader(ptyId, text)`. When no composer
  is mounted, the Reader switches to Chat first, then inserts. The text is
  never typed into the terminal, because the draft is what the user reviews.

## Steps

1. `src/lib/agents/diffNotes.ts`: `DiffNote`, `buildDiffNotesPrompt`, range
   and side helpers; tests in `src/__tests__/agents/DiffNotes.test.ts` (ranges,
   deletions, grouping, caps, a fenced-code line inside a quote).
2. `src/stores/agents/diffNotes.ts`: a per-PTY note list with add, edit,
   remove and clear; dropped when the tab goes away.
3. `TerminalReaderChanges.tsx`: gutter button and range selection in
   `DiffLineRow`/`SplitRows`, the inline `DiffNoteBox` (new
   `terminal/DiffNoteBox.tsx`), the card count chip, the header actions, the
   `C` steering key.
4. CSS beside the existing `.terminal-changes-*` rules. The note box uses the
   shared field/button classes ("copy the working sibling": the Reader
   composer's).
5. i18n keys in all five dictionaries; an `UntestedTag` row
   (`diff-notes`) in `src/lib/untested.ts` on the header actions.
6. File map rows for the two new files; one line in the Reader's help topic.

## Verification

- `npm run build`, `npm test`, `npm run lint` (via `scripts/gates-job.sh start`).
- Never live until the user clicks through it: in a Claude tab with a few
  edits, open Diffs, note one added range and one deleted line in two files,
  then press Add to draft. The Chat composer should hold the prompt shown
  above, and the notes should be gone. Repeat in split view and on a
  subagent's Diffs.

## Later

- Phone `ChatChanges`: the same notes with a long-press start, into the phone
  composer.
- `DiffView` (git panel diffs, sync diffs) with a "Send notes to…" agent-tab
  picker.
