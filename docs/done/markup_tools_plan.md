# Markup tools, round 2 — plan

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Status: in progress (2026-10-12). Builds on the uncommitted pen-bar work
(`mobile-web/src/markup/pen.ts`, pen styles, area eraser, colour meanings —
memory `project_markup_pen_bar`). Ten features the user asked for, built by
three agents in the shared working tree (no worktree: the base is
uncommitted). **Nobody commits, stashes, checks out or resets.** Another
session is editing the same files ("mark groups": `markGroups`,
`PdfMarkupGroups.tsx`, `groupLayer`): re-read a file right before each edit,
keep edits targeted, never rewrite a whole file, never revert what you did
not write.

## Features

1. **Text marks** — tool `textmark`: drag across words; the marks snap to the
   page's text lines. Modes `strike` / `underline` / `highlight`.
2. **Proofreading stamps** — tool `stamp`: one tap places a symbol:
   `insert` (caret ⁁), `delete` (✕), `paragraph` (¶), `swap` (⇄).
3. **Shape snapping** — hold the pen still (≥ 500 ms within 3 CSS px) at the
   end of a stroke: an almost-straight stroke becomes a straight line, an
   almost-closed one an ellipse, an arrow always straight. Pref `snap` (on).
4. **Note colours** — the note editor gets a colour row (red / blue / black);
   the prompt names a note's colour unless black.
5. **Select tool** — tool `select`: click a mark (topmost unsent) or drag a
   rectangle to select; drag a selection to move it; recolour, restyle,
   delete, comment. Sent marks are never selectable.
6. **Undo history kept** — the store keeps the last 20 undo steps with the
   layer; reopening the file restores them (redo is not kept).
7. **Per-mark comment** — a selected ink/box/stamp mark gets `comment`
   (≤ 500 chars); drawn as a small badge on screen; listed in the prompt on
   the mark's line; `/Contents` in the baked PDF annotation.
8. **Before/after on ticks** — Submit records each mark's anchor words in the
   round log; a ✓ group shows a caption "old → new" when the reloaded page's
   words under the group differ.
9. **Pressure curve + palm rejection** — prefs `pressure` (`light` /
   `normal` / `firm`, exponents 0.6 / 1 / 1.6 on a pen's pressure) and, phone
   only, `palm` (`off` / `normal` / `strict`: reject touches wider than
   30 / 18 CSS px; strict also ignores touches for 600 ms after the pen
   lifts).
10. **Pen presets** — up to 4 saved `{tool, color, style, size}`; one tap or
    Shift+1…4 (desktop) applies one; "Save as preset" appends (oldest drops
    at 5), "Reset presets" restores the defaults (red pen, yellow marker,
    blue arrow, black fine pen).

## Fixed decisions (the contract — agents 2 and 3 code against this)

### `mobile-web/src/markup/layer.ts` (agent 1)

```ts
export type StampSymbol = "insert" | "delete" | "paragraph" | "swap";
export const STAMP_SYMBOLS: readonly StampSymbol[];
/** Unit polylines (x, y in −0.5…0.5, y down), drawn at width size × STAMP_WIDTH. */
export const STAMP_SHAPES: Record<StampSymbol, [number, number][][]>;
export const STAMP_WIDTH = 0.09;
export type StampMark = { kind: "stamp"; color: MarkColor; at: [number, number]; size: number; symbol: StampSymbol; comment?: string };
// InkMark and BoxMark gain `comment?: string`. TextMark does not.
export type Mark = InkMark | BoxMark | TextMark | StampMark;
export const MAX_COMMENT = 500;
// SentRound gains `words?: Record<number, (string | null)[]>` — per page, by
// index in that page's logged marks, the anchor words at Submit.
export function markSent(layer, only?, roundId?, words?: Record<number, (string | null)[]>): Layer;
export function stampSize(pageWidth: number): number; // default: round(pageWidth / 30), 4…200

// Selection and editing (all pure; unsent marks only; indices into layer.pages[n].marks)
export function markAt(page: PageLayer | undefined, x: number, y: number, radius: number): number; // topmost, -1
export function marksIn(page: PageLayer | undefined, rect: [number, number, number, number] /* x0,y0,x1,y1 */): number[];
export function moveMarks(layer: Layer, n: number, indices: readonly number[], dx: number, dy: number): Layer; // clamped so every moved mark's box stays on the page
export function restyleMarks(layer: Layer, n: number, indices: readonly number[], change: { color?: MarkColor; style?: PenStyle }): Layer; // colour only where the mark's tool offers it (pen.ts colorsFor); style only on ink (pressure kept; "pen"→ style field removed)
export function removeMarks(layer: Layer, n: number, indices: readonly number[]): Layer;
export function setComment(layer: Layer, n: number, index: number, comment: string | null): Layer; // trimmed, control chars stripped, ≤ MAX_COMMENT; null/empty removes; not on text notes
export function addMarks(layer: Layer, n: number, size: [number, number], marks: readonly Mark[]): Layer;
export function canAddAll(layer: Layer, n: number, marks: readonly Mark[]): boolean;
// Shape snapping: the stroke's points replaced, or null when it is no shape
export function snapStroke(mark: InkMark): InkMark | null;
```

Every place that switches on `mark.kind` handles `stamp` (`touches`,
`markTop`, `scaleMark`, `sameMark`, `markBox`, `validMark`, `eraseMarks`,
`eraseRect` — a stamp goes whole like a box). `isLayer` accepts `comment`,
`stamp` and `SentRound.words` and still accepts every older record.

### `mobile-web/src/markup/anchors.ts` (agent 1)

```ts
export type TextMarkMode = "strike" | "underline" | "highlight";
/** The marks a drag from `from` to `to` makes over the page's words, snapped to
 * whole words and their lines: a box per line (highlight) or a straight even
 * stroke through (strike, y = y0 + 0.55h) / under (underline, y = y0 + 0.9h)
 * each line's words. [] when no text is near. */
export function textMarks(runs: readonly TextRun[], from: [number, number], to: [number, number], mode: TextMarkMode, color: MarkColor, width: number): Mark[];
/** The page's words under a box (page units [x, y, w, h]), "" when none. */
export function wordsIn(runs: readonly TextRun[], box: [number, number, number, number]): string;
```
`anchorsFor` handles stamps (`how`: `at` for insert/paragraph, `on` for delete/swap).

### `mobile-web/src/markup/pen.ts` (agent 1)

`PenTool` gains `"select" | "stamp" | "textmark"`. `PenPrefs` gains
`stamp: StampSymbol` (default `insert`), `textMark: TextMarkMode` (default
`highlight`), `snap: boolean` (true), `pressure: "light" | "normal" | "firm"`
(normal), `palm: "off" | "normal" | "strict"` (normal), `presets: PenPreset[]`
with `PenPreset = { tool: "ink" | "box" | "text" | "stamp" | "textmark"; color: MarkColor; style: PenStyle; size: PenSize }`.
`ColorTool` = every tool but eraser and select. `colorsFor`: yellow for box,
marker and textmark-highlight only. `parsePenPrefs` reads every new field
with fallbacks (old records stay valid).

```ts
export const DEFAULT_PRESETS: PenPreset[];
export const MAX_PRESETS = 4;
export function applyPreset(prefs: PenPrefs, preset: PenPreset): PenPrefs;
export function savePreset(prefs: PenPrefs): PenPrefs;   // current tool's pen appended, oldest dropped past 4; no-op for eraser/select
export function strokePressure(style: PenStyle, pressure: number, curve?: PenPrefs["pressure"]): number;
export function palmRejects(palm: PenPrefs["palm"], touch: { width: number; height: number }, msSincePenUp: number): boolean;
export const SNAP_HOLD_MS = 500; export const SNAP_SLOP_PX = 3;
```

### `mobile-web/src/markup/rasterize.ts` (agent 1)

`drawMark` draws stamps (`STAMP_SHAPES`, round caps) and, for a mark with a
`comment`, a small speech-bubble badge at its box's top-right
(`drawCommentBadge`, also exported). `Paint` gains optional `arc`/`fill`/
`closePath` only if needed (optional members, like `setLineDash`).

### `mobile-web/src/markup/store.ts` (agent 1)

`StoredLayer` gains `past?: Layer[]`; `saveLayer(key, layer, fingerprint,
backend = indexedDbBackend, past?: readonly Layer[])` stores the last
`MAX_STORED_UNDO = 20`; `loadLayer` returns `past` (each through `readLayer`,
unreadable ones dropped). `startHistory(layer, past?)` in layer.ts.

### Backend (agent 1) — `markup.rs`, `markup_pdf.rs`, `commands/pdf_markup.rs`

`Mark::Stamp { color, at, size, symbol, comment }`, `comment:
Option<String>` (`#[serde(default)]`) on Ink, Box and Stamp; validate
(`at` on the page, size 2…200, comment ≤ `MAX_COMMENT` chars, no control
characters). Prompt: stamps `insert mark at
"words"` / `delete mark on` / `new paragraph at` / `swap mark on` (no anchor:
`insert mark (see the page picture)`…), colour word in front like other
drawn marks; a comment goes after the line as ` — comment: "…"`; notes
named with their colour unless black (`blue note "…"`), and their colours
count for the key line. Bake: a stamp is an Ink annotation whose InkList is
its polylines; any comment is the annotation's `/Contents`.

### i18n and register (agent 1 adds ALL keys, both UIs use them)

English + de/es/fr/it (a parity test checks every language). Keys:
`mobile.markup.tool.select` "Select", `mobile.markup.tool.stamp` "Stamp",
`mobile.markup.tool.textmark` "Mark text", `mobile.markup.textMark.strike`
"Strike through", `.underline` "Underline", `.highlight` "Highlight",
`mobile.markup.textMarkHint` "Drag across words — the marks snap to the
lines", `mobile.markup.noText` "No text on this page — draw instead",
`mobile.markup.stamp.insert` "Insert here", `.delete` "Delete",
`.paragraph` "New paragraph", `.swap` "Swap", `mobile.markup.stampHint`
"Tap where the stamp goes", `mobile.markup.selectHint` "Click a mark or drag
a box around marks · drag the selection to move it", `mobile.markup.selected`
"{count} selected", `mobile.markup.deleteSelected` "Delete",
`mobile.markup.comment` "Comment", `mobile.markup.commentPlaceholder` "What
should change here?", `mobile.markup.commentSave` "Save",
`mobile.markup.commentRemove` "Remove comment", `mobile.markup.snap`
"Straighten a held stroke", `mobile.markup.pressure` "Pen pressure",
`mobile.markup.pressure.light` "Light", `.normal` "Normal", `.firm` "Firm",
`mobile.markup.palm` "Palm rejection", `mobile.markup.palm.off` "Off",
`.normal` "Normal", `.strict` "Strict", `mobile.markup.presets` "Presets",
`mobile.markup.preset` "Preset {n}", `mobile.markup.savePreset` "Save as
preset", `mobile.markup.resetPresets` "Reset presets",
`mobile.markup.noteColor` "Note colour", `mobile.markup.tickDiff` "Was
“{before}” · now “{after}”".

Untested rows: `desktop.markup.tools2` and `mobile.markup.tools2` (one row
each describing everything here; pills where the new tools sit).

## Steps

| Agent | Owns | After |
|---|---|---|
| 1 model + backend | `mobile-web/src/markup/{layer,anchors,pen,rasterize,store}.ts`, Rust `markup.rs`, `markup_pdf.rs`, `commands/pdf_markup.rs` tests, i18n dicts, `src/lib/untested.ts`, tests `src/__tests__/pdf/PdfMarkupPen.test.tsx` + new core tests | — |
| 2 desktop | `usePdfMarkup.ts`, `PdfMarkupLayer.tsx`, `PdfMarkupBar.tsx`, `PdfViewer.tsx` (markup keys only), `PdfMarkupTicks.tsx`, `markupPage.ts`, `src/styles/viewers.css`, desktop tests | 1 |
| 3 phone | `mobile-web/src/components/MarkupView.tsx`, `mobile-web/src/style.css`, phone tests | 1 |

Each agent: run `npx tsc --noEmit -p .`, its vitest suites
(`src/__tests__/pdf/PdfMarkup*`, `src/__tests__/mobile/MobileMarkup*`,
`src/__tests__/shell/i18n.test.ts`), and agent 1 also `cargo test -q -p
tabtivity --lib -- markup` and `cargo clippy -p tabtivity --all-targets --
-D warnings` (export `PATH="$HOME/.cargo/bin:$PATH"` first). Report failures
caused by other sessions' files separately; never fix those. Never start
Tabtivity. Desktop keys: S select, M text marks (again: next mode), K stamp
(again: next symbol), Delete/Backspace deletes the selection, Escape clears a
selection before it leaves markup, Shift+1…4 presets.

## Handoff

`docs/done/markup_tools_handoff.md`: each agent appends what it built, API
deviations from this contract (avoid them), gate results with test counts,
and "Flagged for user".
