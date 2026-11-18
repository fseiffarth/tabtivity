# Markup mode, notes-app style — plan

Turn the PDF/picture **Mark up** mode (desktop `PdfViewer`/`ImageView`, phone
`MarkupView`) into a calm writing surface in the manner of handwriting apps:
a small floating tool dock, options only when asked for, saved pens one tap
away, and the agent's round state behind one badge instead of strips and
cards that appear while writing.

Design canvas (user-approved 2026-11-07): Markup Mode Redesign artifact
(desktop clickable board, dock anatomy, iPad, phone). Research and the audit
of the old strip are summarized under **Why** below.

Related: `docs/context/phone_markup.md`, `docs/context/markup_mcp.md`,
`docs/done/markup_tools_plan.md`, `docs/markup_improvement_plan.md`.

## Fixed decisions (the user's answers, 2026-11-07)

1. **One shared design** for desktop, iPad and phone; the shared pen model
   (`mobile-web/src/markup/pen.ts`, `layer.ts`) changes once for both.
2. **Six dock tools:** Pen · Highlighter · Eraser · Lasso · Text · Proof.
   Box, Stamp and Text-mark (strike/underline/highlight words) live in the
   one **Proof** slot; tapping Proof again opens their grid.
3. **Desktop dock floats** over the pages: drag its grip to the bottom, top,
   left or right edge (it docks there and remembers), collapse to the grip.
4. **Agent state behind one badge** in the send header: round pill, the
   agent's question card, ✓ ticks and Approve all, Apply / Undo round,
   Reload, stale/auto-reloaded notes. Nothing of it opens by itself; the `?`
   pins and ✓ badges on the pages show only while that panel is open.
5. **Tap the active tool again** for its options; nothing else opens on its own.
6. Colours stay plain colours (no meanings — `feedback-markup-keep-simple`).

## Decisions made here (recorded, not asked)

- **Highlighter is a tool** (`PenTool` `"highlight"`), drawing the existing
  `InkMark` `style: "marker"` (wire and backend unchanged). The pen's styles
  are Pen / Dashed / Arrow. A stored `style: "marker"` (pen prefs, presets)
  reads as the highlighter tool. Highlighter option **Straight lines** (on by
  default): a released highlighter stroke becomes a straight line from its
  first to its last point.
- **Colours:** `MarkColor` gains `green`, `orange`, `purple`, `pink`
  (TS `INK`, Rust `Color` + `rgb` + `word`, i18n names). Pen/Text/stamps/
  strike/underline offer black, red, blue, green, orange, purple; the
  highlighter, Box and highlight-words offer yellow, green, pink, blue.
  No custom-colour picker (the mock's `+`) — a free colour has no name for the
  prompt.
- **Size is a slider 1–12** (`PenSize` = integer, factor `size / 3` on the old
  base, so old Fine/Normal/Bold = 2/3/6 — stored 0/1/2 map there). `[`/`]`
  step it by 1.
- **Eraser modes:** Whole stroke (default) · Partial (the old rub-cut, medium
  reach) · Area. **Highlighter only** switch. Stored small/medium/large read as
  Partial. **Quick eraser:** hold `E` (desktop) or the pen's barrel button
  (`buttons & 2` on a pen, desktop and phone) — erase while held, back to the
  previous tool on release; a short tap of `E` just arms the eraser.
- **Lasso** replaces Select (key `L`, `S` kept as an alias): Freehand
  (default) or Rectangle; a mark is caught when its box centre lies inside
  the loop. Selected marks get a small bar above them on the page: Colour
  swatches, Copy, Comment, Delete; a drag moves; the selection box's corner
  handle resizes (desktop; phone keeps move + the sheet's actions).
- **Text** stays the existing typed note (the mock's "Text on page" variant
  is dropped: it would be a new mark kind on the wire and the backend).
- **Favourites** = the existing presets, raised to 5, drawn as dots of their
  colour sized by their size; "Save as favourite" in the pen/highlighter
  options; right-click (desktop) / long-press (phone) a favourite removes it.
- **Keys (desktop):** P pen (again: options) · H highlighter · E eraser
  (hold: quick erase) · L lasso (S alias) · T text · K proof (B and M kept as
  aliases arming Box and Text-mark directly) · 1–6 colours · Shift+1–5
  favourites · `[` `]` size · Escape closes the options, then the selection,
  then leaves the mode.
- **Desktop page rail while marking:** a read-only rail of page thumbnails
  (click jumps; a dot on pages with marks). The arranging rail stays off while
  marking, as before.
- **Live smoothing:** the stroke in flight is drawn as midpoint quadratic
  curves (the shape `rasterize.ts` draws on release), so it no longer jumps
  when the pen lifts.
- **Phone:** dock = Draw/Scroll switch (the old ⋯ "Pen only", now always in
  sight) + the six tools + undo; the colour well goes (tap-again opens the
  sheet); the `.markup-notes` stack and the question card move behind an
  **Agent** badge in the header (a sheet); the ↑/↓ mark jumps stay.
- **Untested:** new ids `desktop.markup.dock`, `desktop.markup.agentPanel`,
  `mobile.markup.dock`, `mobile.markup.agentSheet`; existing pills move with
  their controls, none is dropped.

## Steps (commit units)

1. **Shared model** — `pen.ts` (tools, colours per tool, size 1–12, eraser
   modes + highlighter-only, highlighter straight, proof pick, lasso mode,
   presets 5 + remove, parse/migrate), `layer.ts` (erase options,
   `straightenStroke`, `marksInLoop`, `scaleMarks`, `copyMarks`, new colours),
   `rasterize.ts` `INK`, Rust `Color`; tests in `markup/*.test.ts` and
   `markup.rs`/`markup_pdf.rs`.
2. **Desktop dock** — `PdfMarkupDock.tsx` (dock, grip/edges/collapse,
   favourites, options popover per tool), `PdfMarkupLayer.tsx` (highlighter,
   eraser modes, barrel button, lasso loop, selection bar, resize handle,
   copy, live smoothing), keys in `PdfMarkupBar.tsx` `markupStripKey` and
   `PdfViewer` (hold-E keyup), `usePdfMarkup.ts` setters. `ImageView` gets the
   same dock.
3. **Desktop header + agent panel + page rail** — `PdfMarkupBar.tsx` becomes
   the send header (target, model, Go to tab, Agent badge, Submit, Done,
   inline sending/failure); `PdfMarkupAgentPanel.tsx` holds the status items
   and `PdfMarkupQuestions`; pins/badges only while it is open; read-only
   `PdfMarkupPages` rail.
4. **Phone** — `MarkupView.tsx`: toolbar → dock (Draw/Scroll + six tools +
   undo + ⋯), tap-again sheet (favourites, colours, size slider, styles,
   eraser modes, lasso modes, proof grid), Agent badge + sheet, the new
   gestures (highlighter, eraser modes, barrel button, lasso loop, copy);
   `style.css`.
5. **Docs** — filemap rows, `docs/context/phone_markup.md`, untested rows,
   help topic if one documents the strip; gates.

## Organisation

Main loop (no subagent command for this run): one implementer. Steps 1–4
share files and types (`pen.ts` changes break both views until both follow),
so they landed as one feature commit, step 5 (docs) with it; the gates ran
on the whole change.

## As built (2026-11-07, not live-verified)

- Everything in the decisions above, plus: the desktop selection bar keeps a
  style select (pen / highlighter / dashed / arrow) so a stroke can still be
  restyled; the phone keeps restyling in the lasso sheet.
- The "No text on this page" warning now shows in the Proof options.
- The phone's target-tab line (Marks go to … / Open tab) stays in the notes
  stack: it says where Submit goes, not what the agent did.
- The phone's agent sheet has its own open state: drawing and the tool
  sheets leave it open; only the badge closes it.
- Untested ids: `desktop.markup.dock`, `desktop.markup.agentPanel`,
  `mobile.markup.dock`, `mobile.markup.agentSheet`.

## Why

- Old desktop strip: one row of 7 tools + options + presets + undo + ⋯ +
  target/model/Submit/Done, width changing per tool; a status line of up to
  ~15 conditional items; a question card that opens by itself.
- Research (notes apps): one-row tools with tap-again options, saved pens,
  hold-for-eraser, whole-stroke eraser default, highlighter under the text,
  hold-to-straighten, lasso, pen draws / finger scrolls with a visible switch,
  thumbnails; they leave out pop-ups while writing and colour meanings.

## Not in this run

- Custom colours, "text on page" marks, tilt, a zoom-writing window, Pencil
  double-tap/squeeze (not visible to a web page).
- Resize on the phone (move + sheet actions only).
