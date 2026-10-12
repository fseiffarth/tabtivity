# Markup quick fixes on a fast model — plan

User request (2026-10-12): in Mark up, send different marks of the same
document to different agents — easy text changes to a small model (Haiku),
the rest to the main one.

Decision: **not** to different tabs. One Submit stays one round in one tab;
that tab's agent hands the quick marks to a subagent on its fastest model.
Separate tabs would edit the same sources at once (an `apply` round's Undo
snapshot in `services::markup_rounds` would then revert or conflict with the
other tab's edits), and the round's pill, question card and ticks are all per
tab, so one document would show two of each.

Two steps, the second only if the first sorts badly in practice:

- **F1 — the agent sorts.** A switch adds one prompt line; the agent decides
  which marks are quick fixes.
- **F2 — the reader tags (deferred).** A **Quick fix** toggle in the palette
  tags the marks drawn while it is on; tagged marks always go to the fast
  subagent. Colour keeps its meaning to the reader — routing is never read off
  a colour.

## 1. What already exists

- Subagent mode: `MARKUP_SUBAGENT_LINE` + `markupForSubagent`
  (`mobile-web/src/markupInstruction.ts`), re-exported for the desktop in
  `src/lib/viewers/pdfMarkup.ts`. Desktop switch `Settings.pdf_markup_subagents`
  (`src-tauri/src/schema/settings.rs`, `src/types/index.ts`, `SettingsPanel`
  PDF markup section), read in `usePdfMarkup.ts` after `submitPdfMarkup`
  answered; phone flag `markupSubagents` (`mobile-web/src/prefs.ts`, ⋯ switch
  in `MarkupView.tsx`), applied at Submit. Added on the viewer's side, so the
  backend never sees it.
- The prompt (`services::mobile_control::markup`): one line per mark run
  (`mark_runs`, consecutive marks with the same description within `RUN_GAP`),
  each named `p<page> m<n>` (or `m<a>–m<b>`) when the Submit has a round, with
  the anchored words, the line around them and, for a project PDF with
  SyncTeX, `file:line`. The agent ticks handled marks with `markup_done`.
- The model chip beside the wired agent (`PdfMarkupModel.tsx`, phone head
  chip; uncommitted at the time of writing, see the tick-groups work) switches
  the **tab's** model. This plan does not touch it: it picks the subagent's
  model for part of a round.

## 2. F1 — "Quick fixes to a fast model" (agent sorts)

### 2.1 The line

In `markupInstruction.ts`, beside the subagent line:

```ts
export const MARKUP_FAST_MODEL_LINE = "Quick fixes: sort this round's marks. A mark whose change is spelled out — a typo, a single word, punctuation, a struck word with typed replacement text, a typed note saying exactly what to write — is a quick fix. Hand all quick fixes of this round together to one subagent on your fastest, cheapest model (Claude: model haiku) and do the rest as you otherwise would. Handwriting the fast subagent would have to read off the page picture is not a quick fix. Edits to the same file never run at the same time: the quick-fix subagent re-reads a file right before each edit and changes only what its own marks ask for. It ticks its marks off with markup_done as you would. If you cannot choose a subagent's model, do every mark yourself.";

/** A Submit's prompt with the fast-model line, after the subagent line when
 * both switches are on. */
export function markupWithFastModel(prompt: string): string;
```

Order when both switches are on: `MARKUP_SUBAGENT_LINE`, then
`MARKUP_FAST_MODEL_LINE`, then the prompt — the master starts the round's
subagent (own model) **and** the round's quick-fix subagent, both in the
background; the existing re-read / own-marks-only rule covers them running side
by side, as it already does for overlapping rounds. (Claude subagents cannot
start subagents, so the master has to start both.) With subagent mode off, the
tab's agent does the substantive marks itself and waits for the quick-fix
subagent before it ends its turn, so the round's Undo snapshot settles over
both.

Wording points to verify live: Claude Code's Task tool takes `model:
"haiku"`; Codex has no per-subagent model and falls back to doing all marks;
the subagent reaches the tab's `markup_done` (same MCP wiring as its parent).

### 2.2 Desktop

- `settings.rs`: `pdf_markup_fast_model: Option<bool>` (`None` = off), doc
  comment naming `MARKUP_FAST_MODEL_LINE`; `src/types/index.ts` the same key.
- `pdfMarkup.ts`: re-export `markupWithFastModel`.
- `usePdfMarkup.ts` Submit, next to the subagent wrap: fast line first, then
  the subagent line in front of it (§2.1 order).
- `SettingsPanel` PDF markup section: a `ToggleCard` after
  **Subagent mode**, `UntestedTag id="desktop.markup.fastModel"`.
- `i18n.ts` + `de/es/fr/it`: `settings.pdfMarkupFastModel`,
  `settings.pdfMarkupFastModelHelp` ("Marks whose change is spelled out go to
  a subagent on the agent's fastest model. Claude only; other CLIs do every
  mark themselves.").

### 2.3 Phone

- `prefs.ts`: `MobileFlag` gains `markupFastModel` (read with an off fallback).
- `MarkupView.tsx`: state + ⋯ switch after the subagents switch (icon ⚡),
  `t("mobile.markup.fastModel")`, untested id `mobile.markup.fastModel`;
  Submit wraps as the desktop does — including the shell-tab `newTab` path
  (`markup/newTab.ts`), which holds the same prompt.
- Phone i18n keys in the phone dictionaries.

### 2.4 Register, docs, tests

- `src/lib/untested.ts`: rows `desktop.markup.fastModel`,
  `mobile.markup.fastModel`.
- `docs/help/mobile.md`: a sentence after the subagent switch (≈ line 136)
  and the desktop setting beside it in the Settings list (≈ line 145).
- `docs/filemap_frontend.md`: the `PdfMarkup{Layer,Bar}` and `MarkupView`
  rows mention `pdf_markup_fast_model` / `markupFastModel` in one clause.
- Tests: `markupWithFastModel` order with and without the subagent line;
  desktop Submit queues the wrapped prompt when the setting is on (existing
  `usePdfMarkup` submit test); phone ⋯ switch persists and wraps the Submit;
  settings round-trip of the new key (absent stays absent).

### 2.5 Gates

`npm run build`, `npm test`, `npm run lint`, `cargo test --workspace` +
clippy (settings field), `scripts/brand-check.sh`; `npm run mobile:bundle`
for the phone. No backend behaviour changes; `backend:stale` will still flag
the settings struct.

### 2.6 Live check (manual)

A round with three marks — a struck typo with typed replacement, a circled
paragraph with "tighten this", a handwritten word — on a Claude tab:
the typo goes to a Haiku subagent, the other two stay with the tab's model,
all three get ticks, Undo restores all of them. Repeat with subagent mode on,
and once on a Codex tab (all marks done by the tab itself).

## 3. F2 — Quick-fix tag (deferred)

Start only if F1's sorting misroutes marks in real rounds.

### 3.1 Marks

- `layer.ts`: every mark kind gains `quick?: true`
  (`InkMark`, `BoxMark`, `TextMark`). Absent = untagged; old IndexedDB layers
  read as untagged. Mark identity for `sent`/ticks must not change when the
  field is absent.
- Palette (phone `MarkupView`, desktop `PdfMarkupBar.tsx`): a **Quick fix**
  toggle (⚡), independent of colour and tool; marks drawn while it is on carry
  `quick: true`. Drawn the same as untagged marks plus a small ⚡ badge at the
  mark's top-left corner (`rasterize.ts` for screen and page PNGs, so the
  agent sees it on the picture too). Not a new colour.

### 3.2 Backend

- `markup.rs` `Mark`: each variant gains `#[serde(default)] quick: bool`.
  The enum is `deny_unknown_fields`, so an older backend refuses a new viewer's
  body — fine for the phone (baked into the same binary) and the desktop (same
  build), worth one line in the release note for a phone with a stale cached
  PWA.
- `mark_what`: a tagged mark's description starts `quick fix: `. That also
  splits `mark_runs`, since a run needs the same description.
- `markup_pdf.rs`: no change needed; optional `/Subject (Quick fix)` on the
  baked annotation.

### 3.3 The line

With F2, `MARKUP_FAST_MODEL_LINE` gains: "Marks listed as `quick fix:` are
quick fixes whatever they look like; sort the others yourself." The tag works
only while the F1 switch is on; with the switch off the label is still in the
prompt, so the agent may treat those marks as easy, but nothing routes them.

### 3.4 Tests

Serde round-trip with and without `quick`; `mark_what` prefix; a run of
tagged + untagged marks splits; layer round-trip of `quick`; the ⚡ badge in
`pagePng`; palette toggle tags new marks only.
