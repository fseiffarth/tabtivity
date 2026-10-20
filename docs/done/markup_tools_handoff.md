# Markup tools, round 2 — handoff

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Each agent appends its section (`docs/done/markup_tools_plan.md` § Handoff).

## Agent 1 — model, backend, i18n, register

### Built

- **`mobile-web/src/markup/layer.ts`**: stamps, comments, selection, editing,
  shape snapping, logged words, and history kept across reopening. Every
  `kind` switch handles `stamp`: `touches`, `markTop`, `scaleMark`, `sameMark`
  (it also compares `comment`), `markBox`, `validMark`, `eraseMarks` and
  `eraseRect` (a stamp goes whole, like a box). When the eraser cuts a
  commented stroke, only the first piece keeps the comment.
- **`anchors.ts`**: `textMarks` and `wordsIn`. `anchorsFor` handles stamps: a
  caret or pilcrow anchors `at` the two words around its centre; a cross or
  the swap arrows anchor `on` the words under a thin band through their
  middle. A stamp is taller than a line, so its full box would catch the lines
  above and below.
- **`pen.ts`**: the new tools and prefs, presets, pressure curve, palm
  rejection and the snap constants. `parsePenPrefs` reads every new field with
  a fallback. An older record gets the defaults; `presets` falls back to
  `DEFAULT_PRESETS` when it is missing or not a list.
- **`rasterize.ts`**: `drawMark` draws stamps with round caps, and draws a
  speech-bubble badge for any ink, box or stamp that has a comment (never for
  a note). `drawCommentBadge` is exported. `Paint` gains optional `fill` and
  `closePath`; without them the badge's tail is drawn as an outline.
- **`store.ts`**: records keep `past`, the last 20 undo steps. A step that
  cannot be read is dropped; the layer is never dropped for it.
- **Rust**:
  - `markup.rs`: `StampSymbol` and `Mark::Stamp`. `comment: Option<String>`
    (`#[serde(default)]`) on Ink, Box and Stamp. `Mark::comment()` returns the
    comment, or `None` when it is blank.
  - Validation: a stamp's `at` must be on the page and its size 2…200. A
    comment may hold at most `MAX_COMMENT` = 500 characters and no control
    characters, `\n` included.
  - Prompt: stamps read `insert mark at "…"` / `delete mark on` /
    `new paragraph at` / `swap mark on`, with the colour word first. A comment
    closes its line as ` — comment: "…"`. A note that is not black is named as
    `blue note "…"`, and its colour counts for the `Colours:` key.
  - `markup_pdf.rs`: a stamp bakes as an Ink annotation, one `/InkList` path
    per polyline (`stamp_shape`, the same points as `STAMP_SHAPES`). A
    non-blank comment becomes the annotation's `/Contents`.
- **i18n**: all 35 keys from the plan, in English (after
  `mobile.markup.colorOf`) and in de/es/fr/it.
- **Register**: rows `desktop.markup.tools2` and `mobile.markup.tools2` in
  `src/lib/untested.ts`.
- **Tests**:
  - New `src/__tests__/pdf/PdfMarkupTools.test.ts`, 30 tests.
  - Rust in `markup.rs`: `stamps_and_comments_are_read_and_checked` and
    `stamps_comments_and_note_colours_are_named_in_the_prompt`.
  - Rust in `markup_pdf.rs`:
    `a_stamp_bakes_as_its_polylines_and_a_comment_as_contents`.
- **File map**: one clause added to the `MarkupView` row of
  `docs/filemap_frontend.md`.

### API for agents 2 and 3

`layer.ts`:

```ts
export type StampSymbol = "insert" | "delete" | "paragraph" | "swap";
export const STAMP_SYMBOLS: readonly StampSymbol[];
export const STAMP_SHAPES: Record<StampSymbol, [number, number][][]>;
export const STAMP_WIDTH = 0.09;
export type StampMark = { kind: "stamp"; color; at: [number, number] /* centre */; size; symbol; comment?: string };
export type Mark = InkMark | BoxMark | TextMark | StampMark;   // InkMark/BoxMark gain comment?
export const MAX_COMMENT = 500;
export const MARKER_FACTOR = 5;                                 // moved here, re-exported by pen.ts
export function stampSize(pageWidth: number): number;           // round(w / 30), 4…200
export function stampLines(mark: StampMark): [number, number][][];   // polylines in page units
export function markSent(layer, only?, roundId?, words?: Record<number, (string | null)[]>): Layer;
export function markSentSome(layer, page, shown, roundId?, words?: (string | null)[]): Layer; // words of `shown`, page order
export function markAt(page: PageLayer | undefined, x, y, radius): number;          // topmost, -1
export function marksIn(page: PageLayer | undefined, rect: [x0, y0, x1, y1]): number[];
export function moveMarks(layer, n, indices, dx, dy): Layer;    // the same layer when nothing moves
export function restyleMarks(layer, n, indices, change: { color?: MarkColor; style?: PenStyle }): Layer;
export function removeMarks(layer, n, indices): Layer;
export function cleanComment(comment: string): string;          // what setComment stores
export function setComment(layer, n, index, comment: string | null): Layer;
export function addMarks(layer, n, size, marks: readonly Mark[]): Layer;
export function canAddAll(layer, n, marks: readonly Mark[]): boolean;
export function snapStroke(mark: InkMark): InkMark | null;
export function startHistory(layer?: Layer, past?: readonly Layer[]): History;
// SentRound gains words?: Record<number, (string | null)[]>
```

`anchors.ts`:

```ts
export type TextMarkMode = "strike" | "underline" | "highlight";
export function textMarks(runs, from: [x, y], to: [x, y], mode, color, width): Mark[];  // [] = no text near
export function wordsIn(runs, box: [x, y, w, h]): string;                              // "" = none
```

`pen.ts`:

```ts
export type PenTool = "ink" | "box" | "text" | "stamp" | "textmark" | "select" | "eraser";
export const PEN_TOOLS;  // that order
export type ColorTool = Exclude<PenTool, "eraser" | "select">;  // colors gains stamp: "red", textmark: "yellow"
export type PressureCurve = "light" | "normal" | "firm";    export const PRESSURE_CURVES, PRESSURE_EXPONENT;
export type PalmRejection = "off" | "normal" | "strict";    export const PALM_MODES, PALM_MAX_TOUCH, PALM_AFTER_PEN_MS;
export const TEXT_MARK_MODES: readonly TextMarkMode[];
export type PenPreset = { tool: "ink" | "box" | "text" | "stamp" | "textmark"; color; style; size };
export const DEFAULT_PRESETS: PenPreset[]; export const MAX_PRESETS = 4;
// PenPrefs gains stamp, textMark, snap, pressure, palm, presets
export function colorsFor(tool, style, textMark: TextMarkMode = "highlight"): readonly MarkColor[];
export function applyPreset(prefs, preset): PenPrefs;
export function savePreset(prefs): PenPrefs;     // no-op for eraser/select; an equal preset moves to the end
export function resetPresets(prefs): PenPrefs;   // presets = DEFAULT_PRESETS
export function strokePressure(style, pressure, curve: PressureCurve = "normal"): number;
export function palmRejects(palm, touch: { width; height }, msSincePenUp): boolean;
export const SNAP_HOLD_MS = 500; export const SNAP_SLOP_PX = 3;
```

`rasterize.ts`:

```ts
drawMark(ctx, mark, badge = COMMENT_BADGE);
drawCommentBadge(ctx, mark, size?);
badgeSize(page);
COMMENT_BADGE;
```

`drawPage` sizes badges to the page.

`store.ts`:

```ts
saveLayer(key, layer, fingerprint, backend?, past?);   // keeps the last MAX_STORED_UNDO
loadLayer(...).past?;                                  // pass it to startHistory
```

Notes for callers:

- **Pressure curve**: pass `curve` only for a real stylus reading:
  `strokePressure(style, isPen ? p : 0.5, isPen ? pen.pressure : undefined)`.
  A finger or mouse reports `0.5`, which must stay the base width. Under
  `light`, 0.5 would become 0.66.
- **Colours for a text-mark tool**: call
  `colorsFor(tool, pen.style, pen.textMark)`. `colorOf` already passes
  `textMark`.
- **Selection indices**: they point into `layer.pages[n].marks`, the unsent
  marks only, so sent marks can never be selected. Clear the selection after
  any change that renumbers marks, such as erase or undo.
- **Before/after captions**: at Submit, compute per page
  `wordsIn(runs, markBox(mark))` for each mark in submitted order, `null`
  where there is no text, and pass that as `markSent`'s `words`. After the
  reload, compare a ✓ group's logged words with `wordsIn` on the group's box
  and show `mobile.markup.tickDiff`.
- **Snapping**: apply `snapStroke` after `finishStroke`; the result's points
  are already rounded and on the page.
- **Text marks**: add the result of `textMarks` with
  `canAddAll` + `addMarks` (one undo step).

### Deviations from the contract

None in the contract's signatures.

Additions:

- `stampLines`, `cleanComment`, `resetPresets`, `badgeSize`,
  `COMMENT_BADGE`.
- The constants `PRESSURE_EXPONENT`, `PALM_MAX_TOUCH`, `PALM_AFTER_PEN_MS`,
  `TEXT_MARK_MODES`, `PRESSURE_CURVES` and `PALM_MODES`.
- The `PressureCurve` and `PalmRejection` types.
- An optional `words` parameter on `markSentSome`.
- An optional `textMark` parameter on `colorsFor`.

Other behaviour:

- `MARKER_FACTOR` moved from `pen.ts` to `layer.ts`, because `restyleMarks`
  needs it. `pen.ts` re-exports it, so existing imports still work.
- `restyleMarks` multiplies a stroke's width by `MARKER_FACTOR` when it
  becomes a marker and divides it when it stops being one. A marker made
  from a pen stroke would otherwise be thin.

### Gate results

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| `npx tsc --noEmit -p tsconfig.mobile.json` | clean |
| `npx vitest run src/__tests__/pdf/PdfMarkup src/__tests__/mobile/MobileMarkup src/__tests__/shell/i18n --reporter=dot` | 21 files, 310 tests passed (30 of them the new `PdfMarkupTools.test.ts`) |
| `cargo test -q -p tabtivity --lib -- markup host::tests` | 185 passed, 0 failed |
| `cargo clippy -p tabtivity --all-targets -- -D warnings` | clean (no output, exit 0) |
| `npx eslint` on the changed TS files | clean |
| `git diff --check` on the touched files | clean |

`src/__tests__/shell/UntestedRegistry.test.ts` fails, as expected. The
`desktop.markup.tools2` and `mobile.markup.tools2` rows have no call site
until agents 2 and 3 place their `UntestedTag` pills.

### Fixes outside my files

- **Compile fix**: in `src/components/embed/pdf/usePdfMarkup.ts`,
  `MarkupTool` grew to
  `"ink" | "box" | "text" | "stamp" | "textmark" | "select" | "eraser"`.
  `PenTool` widened, and it is assigned to `MarkupTool`. Nothing else in the
  UI files was changed.
- **Prompt-text assertions**: these tests expected the old wording of a blue
  note.
  - `src-tauri/src/commands/pdf_markup.rs`, 2 assertions.
  - `src-tauri/src/services/mobile_control/host.rs`, 1 assertion.
  - `markup.rs`: `a_pdf_submit_bakes…` and `anchors_and_synctex…`.
- **Test constructions**: `comment: None` added wherever the Rust tests build
  `Mark::Ink` or `Mark::Box` (`markup.rs`, `markup_pdf.rs`, `pdf_markup.rs`).

### Flagged for user

- **Notes are now named by colour in prompts.** Any note that is not black is
  named with its colour (`red note "…"`), and that colour joins the
  `Colours:` key. The pen bar's default note colour is **red**, so a default
  note now reads as "red = delete or fix". The plan asks for this. If default
  notes should stay neutral, change `DEFAULT_PEN_PREFS.colors.text` to
  `black`.
- **Stamp shapes are kept in two places.** They are defined in
  `layer.ts` `STAMP_SHAPES` and in `markup_pdf.rs` `stamp_shape`. No test
  compares the TS and Rust copies, so keep them in step by hand.
- **Undo history is stored on the phone and the desktop alike**, since both
  use the IndexedDB `store.ts`. Clearing every mark deletes the record, and
  its undo steps go with it, as a cleared file always has.
- **None of this is live-tested.** The two register rows stand until the
  user confirms.

## Agent 3 (phone)

### Built

All in `mobile-web/src/components/MarkupView.tsx` and `mobile-web/src/style.css`:

- **Toolbar**: Pen, Highlighter, Text note, Mark text, Stamp, Select, Eraser
  (`TOOLBAR`; still scrolls sideways). The Mark text button shows the armed
  mode, and the Stamp button shows the armed symbol.
- **Text marks**: while the tool is armed, the view asks the sealed frame for
  the text runs of each nearby page, once per page (`pageRuns`, the same
  `text` request Submit uses). A Reload clears the cache. A drag previews
  `textMarks` and adds them with `canAddAll`/`addMarks` as one undo step.
  The hint reads `mobile.markup.noText` on a picture, or on a page whose runs
  came back empty. The well's popover has a mode picker and, for strike and
  underline, a size row.
- **Stamp**: the stamp follows the finger and lands where it lifts
  (`stampSize(page width)`). The popover has a symbol picker.
- **Snapping**: when an ink stroke rests `SNAP_HOLD_MS` within `SNAP_SLOP_PX`,
  `snapStroke(finishStroke(…))` is previewed, and it is committed if the
  stroke lifts there. Moving on cancels the snap. ⋯ has a switch for
  `pen.snap`.
- **Note colours**: a red/blue/black row in `NoteEditor`.
- **Select**: a tap picks a mark (`markAt`, radius 12 CSS px), and a drag from
  clear page picks with a rectangle (`marksIn`). A dashed `.markup-selection`
  outline marks what is picked. A press on a selected mark, or inside the
  outline, drags the selection (`moveMarks`), one undo step. A selection holds
  only while its layer is `history.present` and Select is armed. A finger
  selects and moves even in pen-only mode, and a move blocks scrolling, as a
  note drag does.
  - Popover: "{count} selected", styles (when strokes are picked), colours
    (yellow only when a box or marker is picked), Delete.
  - With a toolbar colour or a swipe on the well, Select recolours the
    selection instead of the pen.
- **Comment**: one selected stroke, box or stamp gets a comment box in the
  popover (`setComment`; Save, plus Remove comment once it has one).
- **History kept**: `startHistory(stored.layer, stored.past)` on load, and
  `saveLayer(…, history.past)` on every save (Done's direct save too).
- **Before/after**:
  - At Submit, each page with text runs gets
    `wordsIn(runs, markBox(mark)) || null` per mark, passed to `markSent` /
    `markSentSome`.
  - `loggedWords` maps each logged mark object to those words.
  - Pages with a ✓ group whose marks have logged words fetch their current
    runs. `.markup-tick-diff` (`mobile.markup.tickDiff`) appears beside the
    badge, or under it near the right edge.
- **Pressure**: `strokePressure(style, p, pen.pressure)` for a real pen only.
  A finger or mouse keeps 0.5.
- **Palm rejection**: `palmRejects(pen.palm, {width, height}, now − penUpAt)`
  ignores a touch whole. `penUpAt` is set when a pen lifts.
- **⋯ rows**: Pen pressure and Palm rejection each cycle to the next choice on
  a tap and show the current one.
- **Presets**: a chip row at the top of the pen popover (`applyPreset`; the
  armed one is ringed), plus Save as preset and Reset presets at its foot.
- **Untested pill**: `mobile.markup.tools2` on the new tools' hints, the
  presets row, the select popover and the snap switch.

### Deviations

- **Before/after** compares mark by mark. Each mark's logged words are set
  against `wordsIn` on that mark's own current box, joined with " … ", not
  against `wordsIn` on the whole group box. A multi-mark group's words
  overlap, so a group box would always differ from the joined words. For a
  single-mark group the two give the same result.
- **Stamps** land where the finger lifts, not where it first touched. The
  finger covers the spot, so the stamp follows it. A plain tap gives the same
  result.
- **No shared files changed.** Model, i18n and register were left alone.

### Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.mobile.json` | clean |
| `npx tsc --noEmit -p .` | clean in the last run (earlier runs showed agent 2's in-progress `PdfMarkupLayer.tsx`/`PdfViewer.tsx` errors) |
| `npx vitest run src/__tests__/mobile src/__tests__/shell/i18n src/__tests__/shell/UntestedRegistry --reporter=dot` | 161 files, 1384 tests: 1383 passed, 1 failed |
| `npm run lint` | 0 errors, 28 warnings (none in my files; `eslint` on `MarkupView.tsx` and the test file is clean) |
| `git diff --check` on my files | clean |

- **New phone tests**: 10 in `src/__tests__/mobile/MobileMarkupView.test.tsx`,
  under "MarkupView · tools round 2". The file now has 27 tests, all passing.
- **`UntestedRegistry` fails on other sessions' rows.**
  - `desktop.markup.pen` is agent 2's: `PdfMarkupBar.tsx` names it only in a
    ternary, which the audit cannot see.
  - `mobile.home.reorder` belongs to another session.
  - `mobile.markup.tools2` and `desktop.markup.tools2` both have call sites
    now.

### Try it on the phone

1. Open a PDF from a tab's outbox or Files, then tap Mark up.
2. **Text marks**: tap the toolbar's "ab" (Mark text). The hint says "Drag
   across words…". Drag across a line: yellow boxes snap to whole words.
   - Tap the well and pick Strike through or Underline, then drag again.
   - On a picture or a scanned page, the hint says "No text on this page —
     draw instead".
3. **Stamps**: tap ⁁ (Stamp), then tap the page: a caret lands. In the well,
   pick ✕ / ¶ / ⇄ and the next tap places that symbol.
4. **Snapping**: with the Pen, draw a rough line or circle and hold still for
   half a second before lifting. It snaps to a straight line or an ellipse.
   ⋯ → "Straighten a held stroke" turns this off.
5. **Note colours**: with the Text note tool, tap the page. Pick Blue in the
   editor, type something, then tap Add. The note is blue.
6. **Select**:
   - Tap ↖ (Select), then tap a mark: a dashed ring appears and the hint says
     "1 selected". Drag it to move it, and Undo puts it back.
   - Drag from an empty spot around several marks to pick them all.
   - Tap the well: recolour, restyle (strokes), Comment (type, Save, then a
     badge appears on the mark), Delete.
   - In ⋯ with "Draw with the pen only" on, a finger still selects and moves.
7. **History kept**: draw a few strokes, tap Done, then reopen the file. Undo
   steps back through them.
8. **Pressure and palm** (Pencil):
   - ⋯ → Pen pressure: Light / Normal / Firm changes how pressure maps to
     width.
   - ⋯ → Palm rejection: with Normal, a resting palm draws nothing. With
     Strict, touches right after the Pencil lifts are ignored too.
9. **Presets**: tap the well. The chips at the top arm a saved pen: tap the
   yellow-marker chip. Save as preset adds the current pen, and Reset presets
   restores the four defaults.
10. **Before/after**: Submit a mark over a word, let the agent change that
    word and tick the mark, then Reload. Beside the ✓ a caption reads
    "Was “old” · now “new”".

### Flagged for user

- **Nothing here has been run live.** The pill `mobile.markup.tools2` stays
  until you confirm.
- **No test covers the before/after caption or Submit's `words`.** Both need
  the sealed frame's text at Submit and ticks from `useMarkupAsks`. Step 10
  is the live check.
- **The toolbar now holds 11 buttons**, so on a narrow phone Undo, Redo and ⋯
  sit past the right edge and need a sideways swipe. If that is too hidden,
  the tool buttons could fold into a picker.
- **Each save now writes up to 20 undo layers** along with the layer, in
  IndexedDB (agent 1's store). This is fine for normal markup, but heavier on
  very large layers.
- **Text runs that time out are not asked for again** until a Reload. Text
  marks then do nothing, with no "no text" hint.

## Agent 2 (desktop)

### Built

- **`usePdfMarkup.ts`**:
  - Text runs per page, cached per loaded document: `edit.text(n)` and
    `edit.wantText(n)`, read through `pageText.ts` `pageTextItemBoxes`.
  - `edit.addAll`: `canAddAll` + `addMarks`, one undo step.
  - The selection `{ n, indices, layer }`, shown only while
    `layer === history.present` and the select tool is armed.
    `commitSelection` keeps it after a move, a restyle or a comment.
  - `restyleSelection`, `deleteSelection`, `canComment`, `openComment`, and a
    comment draft: `edit.comment`, `editComment`, `saveComment` (null
    removes), `cancelComment`.
  - `edit.editNoteColor`.
  - Pen settings: `setTextMark`, `setStamp`, `setSnap`, `cyclePressure`,
    `applyPreset(i)`, `savePreset`, `resetPresets`. `pressTool` steps the
    text-mark mode on `textmark` and the symbol on `stamp`. `setColor`
    restyles the selection when there is one.
  - History: `saveLayer(.., history.past)`, and `startHistory(stored.layer,
    stored.past)` on load.
  - Submit logs `words` per page: `markSent(.., words)`, or
    `markSentSome(.., words[page])` for a group Submit.
  - `ticks.captions`: a Map from each tick group to its `{ before, after }`.
    The text of caption pages is read while the pane is visible.
- **`markupPage.ts`**: `MarkupPagePicture.words?`, from
  `wordsIn(runs, markBox(mark)) || null` per mark. Left out when the page's
  text cannot be read.
- **`PdfMarkupLayer.tsx`**:
  - The preview is now a list of marks.
  - Text-mark drag: previews the marks, then `addAll` on release.
  - Stamp: the preview follows the pointer, and release places it at
    `stampSize(page width)`.
  - Snapping: a hold of `SNAP_HOLD_MS` within `SNAP_SLOP_PX` (client px)
    previews `snapStroke(finishStroke(..))` at once, and release keeps it.
    Moving on past the slop unsnaps the stroke.
  - Pressure: `strokePressure(.., pen.pressure)` only for a real pen with
    pressure > 0.
  - Select tool:
    - Click: `markAt`, within 6 CSS px.
    - Drag: a dashed box, then `marksIn`.
    - Shift+click or Shift+drag adds to the selection. Shift+click on a
      selected mark removes it.
    - Dragging inside the selection's outline moves it: `moveMarks` as
      scratch, then one `commitSelection`.
    - A dashed outline is drawn around the selection.
  - `MarkupCommentEditor`: the note card chrome, `MAX_COMMENT`. Enter saves,
    Escape cancels, a click on the page saves.
  - The note card has a red/blue/black colour row.
- **`PdfMarkupBar.tsx`**:
  - The tools are now Pen, Highlighter, Note, Stamp (shows its symbol), Mark
    text (shows "ab" in its mode), Select and Eraser, with key hints.
  - Options:
    - Text marks: their modes, sizes and colours (`colorsFor(.., textMark)`).
    - Stamp: the four symbols and the colours.
    - Select: "n selected", styles (when strokes are selected), colours
      (`selectionColors`), Comment and Delete.
  - Preset chips: each shows its tool or style glyph over a bar in its colour
    (inset line).
  - ⋯ menu: Straighten a held stroke (checkbox), Pen pressure (steps the
    curve and stays open), Save as preset, Reset presets.
  - Hints: `textMarkHint` / `noText` (warn style, for the page on screen),
    `stampHint`, `selectHint`.
  - `COLOR_KEYS` is now exported.
- **`PdfMarkupTicks.tsx`**:
  - `tickCaption(layer, group, runs)` and `tickBadgesByPage(.., captions)`.
  - `.file-viewer-pdf-tick-diff`: the caption beside the ✓, or on its left
    at the page's right edge.
- **`PdfViewer.tsx`**:
  - `markupKey(e)` now takes the event, for `code` and `shiftKey`.
  - Escape clears a selection before it leaves markup.
  - `tickBadgesByPage` gets the captions.
- **`viewers.css`**:
  - Layer cursors: `is-textmark`, `is-select`.
  - Strip: the presets group, the text-mark glyph, the preset chip and the ⋯
    menu value.
  - Cards: the note colour row, and a pressed swatch in the note card.
  - The tick caption.
- **File map**: one clause on each of the two rows (`PdfMarkup{Layer,Bar}`
  and `PdfMarkupTicks`).

### Keys (desktop)

| Key | Action |
|---|---|
| P | Pen (again: next style) |
| B | Highlighter |
| T | Note |
| M | Mark text (again: next mode) |
| K | Stamp (again: next symbol) |
| S | Select |
| E | Eraser (again: area eraser and back) |
| 1–4 | The armed tool's colours. With a selection, its colours, applied to it; with the select tool and nothing selected, nothing. |
| Shift+1…4 | A preset, read from `e.code` `Digit1…4`, so it works on any layout |
| [ / ] | Size |
| Delete / Backspace | Delete the selection, only when there is one; otherwise Backspace is left alone |
| Escape | Clear the selection first; with nothing selected, leave markup |

### Deviations

- **Before/after captions are compared mark by mark, not over the group's
  box.** For each mark with logged words, the logged words are set against
  `wordsIn(runs, markBox(mark))` now, and the words are joined with repeats
  dropped. Using `wordsIn` over the group's box would invent a change
  whenever two marks sit apart on one line (`the … cat` against
  `the big cat`).
  - Logged words are found by the mark's object in the round's page list.
    In a record rebuilt from a copy the objects no longer match, so those
    marks get no caption.
  - A known "before" and an empty "after" still shows, as `now “”`.
- **Shift+letter no longer arms a tool.** Shift is kept for the presets.
- **Text-mark stroke width** follows the pen size, through
  `strokeWidth(width, { size, style: "pen" })`. The size row also shows for
  the text-mark tool.
- **Note colour** changes only the draft. It is not remembered as the note
  tool's colour.
- No shared model file, i18n row or register row was changed.

### Gate results

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| `npx vitest run src/__tests__/pdf src/__tests__/shell/i18n src/__tests__/shell/UntestedRegistry --reporter=dot` | 40 files, 501 tests: 500 passed, 1 failed |
| `npm run lint` | 0 errors, 28 warnings, none in my files |
| `git diff --check` on my files | clean |

- **The one failure** is `UntestedRegistry`, on the row
  `mobile.home.reorder`. That row belongs to another session and has no call
  site. `desktop.markup.tools2` and `mobile.markup.tools2` both have call
  sites now.
- **The one lint warning in `PdfViewer.tsx`** is at 4225 (`viewPos.initial`).
  It was there before and is not in my hunks.
- **New tests**:
  - `src/__tests__/pdf/PdfMarkupDesktopTools.test.tsx`, 17 tests: text-mark
    drag with stubbed runs, stamp click, snap after a hold (fake timers), no
    snap unheld or with snapping off, pressure curve for a pen only,
    select/box-select/move, note colour, then over the real hook
    select+recolour+move+delete+undo, restyle and comment save/remove, preset
    chip plus Save/Reset, the ⋯ snap and pressure entries, stamp and
    text-mark options, history restored and stored, words logged at Submit,
    and `tickCaption` with the caption rendered.
  - One test in `PdfMarkupViewer.test.tsx`: M/K stepping, Shift+Digit3
    preset, S, a click selects, Escape clears the selection and stays in
    markup, Delete deletes.
- **Test stubs**: `stubEdit` in `PdfMarkupLayer.test.tsx` and
  `PdfMarkupPen.test.tsx` gained the new `MarkupEdit` members.

### Click-through (desktop, not run live)

1. Open a project's PDF that has text, then click **Mark up**.
2. **Text marks**:
   1. Press **M**. The hint reads "Drag across words…".
   2. Drag across two lines. Yellow boxes preview over whole words, and one
      Undo removes both lines.
   3. Press **M** again (Strike through) and drag. A red line runs through
      the words.
   4. On a scanned page with no text, the hint reads "No text on this page".
3. **Stamp**: press **K**, then click. A ⁁ is placed. Press **K** again for
   ✕ and click again.
4. **Snapping**: with the Pen, draw a rough line and hold still for half a
   second before letting go. It straightens. Do the same with a rough circle:
   it becomes an ellipse. Turn snapping off in ⋯ → "Straighten a held
   stroke", and a held stroke stays as drawn.
5. **Note colour**: press **T**, click, type, pick Blue in the card, then
   **Add**. The note is blue.
6. **Select**:
   1. Press **S** and click a stroke. A dashed outline shows and the strip
      says "1 selected".
   2. Drag it. It moves, and one Undo moves it back.
   3. Click Blue, then Dashed.
   4. Click Comment, type, press Enter. A speech-bubble badge appears on the
      mark.
   5. Drag a box around several marks, then press Delete.
   6. Press Escape once: the selection clears. Press Escape again: markup
      ends.
7. **Pressure**: with a stylus, step ⋯ → "Pen pressure" to Light. Light
   strokes now draw wider. A mouse draws the same as before.
8. **Presets**: click the chips, or press Shift+1…4. Arm a box in red and
   use ⋯ → "Save as preset". It becomes chip 4. "Reset presets" brings the
   defaults back.
9. **History**: draw three strokes, close the tab and reopen the PDF in
   markup. Undo still steps back through them.
10. **Captions**:
    1. Mark a typo and Submit.
    2. Let the agent fix it and tick it.
    3. Reload. The ✓ shows "Was “teh” · now “the”".

### Flagged for user

- **None of this is live-tested.** It is tagged `desktop.markup.tools2`:
  pills on the tool group, on the text-mark and stamp options, and on each
  tick caption.
- **The tool strip is wider now**, with seven tools and up to four preset
  chips. On a narrow pane it wraps, as the redact bar does.
- **A preset chip for a stamp shows ⁁ whatever symbol is armed.** Presets do
  not store a stamp symbol.
