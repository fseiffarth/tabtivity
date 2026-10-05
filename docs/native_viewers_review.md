# Native Viewers Review — 2026-09-16

A read-only review of the four native viewers — TeX, Markdown, YAML/JSON and
PDF — by eight parallel agents, followed by a cross-critique round in which each
agent was shown its peers' findings and asked to defend, correct or withdraw its
own. This document is the result and the work plan.

Scope: `src/lib/viewers/**`, `src/components/embed/**`, `src/components/common/
PageStrip.tsx`, and the `src-tauri/` write paths those depend on. **Styling is
out of scope** — `docs/ui_unification_plan.md` owns every CSS/token item in
viewer territory and its Tier 1 landed the same day; findings of that kind are
handed back there by ID rather than re-filed here.

**Status.** The review itself was read-only — every agent was held to reading,
and no agent edited anything. Since then **V-01 has landed** (`FileViewerPane.
tsx`, +34/−4) and **V-02 was landed and then reverted** (see V-26). Everything
else in this document is still a plan. Live verification is the user's alone —
Tabtivity was not started, and `src/` hot-reloads, so what has landed reaches an
open window without a restart.

### What landed

| ID | Files | Gate |
|---|---|---|
| **V-01** — the editor's line-ending contract | `fileUtils.ts` (+`lineEndingOf`/`applyLineEnding`), `FileViewerPane.tsx` (seed normalizes, the single write restores) | new `ViewerLineEndings.test.ts`, 12 cases |
| **V-05** — YAML flow-context quoting | `yaml.ts` (4 encoders + 5 internal call sites), `YamlTree.tsx` (2 sites) | new `YamlEdgeCases.test.ts`, 11 cases |
| **V-08** — `pointercancel` aborts, never commits | `YamlTree.tsx`, `YamlGrid.tsx` | covered by existing drag tests; the abort path needs its own |
| **V-09** — `PdfThumb` cleanup + annotation mode | `PdfViewer.tsx` | needs a test (fake page whose task rejects) |
| **V-04** — read-at-write-time save gate | `PdfViewer.tsx` `handleSave` | needs the five negative cases named below |
| **V-10** — no reseed when the bytes are identical | `FileViewerPane.tsx` | needs a test |

Of those, only V-01 and V-05 arrived with the tests the plan asked for. V-04,
V-08, V-09 and V-10 are landed and **not** individually pinned — recorded here
rather than implied, because a fix without a test is a fix that can be undone by
accident.

Gates actually run: `npx tsc --noEmit` exit 0. ESLint (unfiltered — the repo's
wrapper mangles its own JSON and still exits 0, so it must be run through `rtk
proxy` to be believed) reports **0 errors, 3 warnings**, all
`react-hooks/exhaustive-deps` and none inside a changed hunk. Targeted suites —
yaml, viewer, pdf, table, bib, tex — **50 files / 942 tests passed**. The
in-tree baseline at HEAD was **479 files / 5166 tests, zero failures**.

**One caveat on that suite, recorded because it cost an hour and will cost the
next person the same.** An intermediate run of the *identical* command with the
*identical* code reported 4 files / 49 tests failing, all of them timing-
sensitive hover-tint and drag-reorder DOM tests in `YamlViewer.test.tsx`, while
the same file passed in isolation. Re-running reproduced nothing. The failures
appeared while other heavy work was in flight, so the suite is **flaky under
load** in its DOM-timing tests — which is dangerous precisely because the
obvious reading is "the change I just made broke this", and here that reading
was wrong. Do not conclude a regression from one red run; re-run it.

**`npm test` runs the suite roughly twice.** `vitest.config` excludes only
`target/**`, so the run also sweeps every `*.test.ts(x)` inside `.claude/
worktrees/` — **952 duplicate test files** across two live worktrees
(`os-parity-sweep`, `perf-runtime`) against 479 in the tree itself. A full run
here executed 1431 files / 15390 tests, where the UI unification plan recorded
today's baseline as 957 / 10282. Consequences: the wall clock roughly doubles
(430 s observed), failures are reported against `.claude/worktrees/…` paths that
look like the tree's own, and a stale worktree's copy of a test can fail a run
for code nobody is editing. Adding `".claude/**"` beside `"target/**"` in the
config's `exclude` is a one-line fix, filed rather than landed because it is
outside this review's scope and affects every suite, not the viewers.

The review's own test baseline, actually executed (`gates` agent):

```
npx vitest run <33 pdf/md/bib/table/pageModel paths>   66 files  1008 tests  passed
npx vitest run <28 tex/yaml/viewer/print/i18n paths>   56 files  1228 tests  passed
```

---

## 1. What the review actually found

Three bug classes account for nearly every finding. Each was found
independently by agents who could not see each other's work, in different
subsystems — which is what makes them classes rather than incidents.

### Class A — a cached proxy standing in for a fact that has moved

A guard, key or baseline is remembered from an earlier read and then trusted at
a moment when it can no longer be true. Every instance latches: once wrong, it
stays wrong for the session, because the thing that would correct it is the same
thing that is broken.

Instances: the autosave gate reading a visibility-gated staleness flag; the
post-write mtime stat that adopts an *external* write as its own baseline; the
TeX hover preview whose cache key hashes a preamble it never re-reads (and
where three distinct failures — no `\begin{document}`, no preamble, a *failed
read* — all hash identically); `setStripMeta` marking a file dirty without
materialising the bytes it will be rebuilt from.

The rule the review settled on, in `pdf-annot`'s words: **the file's identity is
verified at the moment of writing, not remembered from a poll.** And
`tex-ui`'s general form: **no session-lifetime latch or cache without a named
invalidation edge.**

### Class B — an encoder that does not know what context it is writing into

The viewer renders rows and edits *text*, splicing the draft so comments,
quoting and untouched bytes survive. That promise breaks wherever the encoder is
not told where its output will land.

Instances: a YAML flow scalar written unquoted, so retyping an item of
`hosts: [a, b]` as `x, y` silently makes it two items; `markdownEdit`'s
`continueList`/`generateToc` writing LF into a CRLF document; and — the one that
subsumes the rest — the editor `<textarea>` itself.

This repo has solved this class twice already and the fix shape is settled:
`bib.ts:554 bibLiteral(value, delim)` and `table.ts encodeCell(v, delimiter)`
both take the context as an argument and keep the author's form while it can
hold the value, promoting only when it cannot. `yaml.ts` is the one of the three
whose encoders take no context at all.

Precedent: **M#840**, found by an edge-case sweep on 2026-09-15 and fixed the
same day, covering `table.ts` and `bib.ts` only. The files that sweep never
reached are where this review found the survivors.

### Class C — a resource released on the happy path only

Instances: `PdfThumb` calling `page.cleanup()` under `if (painted && !cancelled)`
— so a superseded render keeps every decoded image, which is the measured
660 MB / 4.7 GB class on the one branch the comment above it does not cover; the
redaction rasteriser never releasing a canvas that can reach 40 MP; the outline
hover cache that is never evicted or reset on document change; `sourceBytes`
caching only *after* the await resolves, so a rail drag starts one whole-file
read per crossed slot with no in-flight guard.

---

## 2. Tier 1 — data loss

Every item here can destroy bytes a user typed, or silently rewrite a file they
did not edit. All are `src/`, all hot-reload, each names its test.

| ID | Where | What | Class | Effort |
|---|---|---|---|---|
| **V-01** | `FileViewerPane.tsx` `useEditableFile` | **The editor normalizes every CRLF file to LF on the first keystroke.** `onTextChange` reads `el.value` (`:3560`) from a `<textarea value={draft}>`; the HTML spec normalizes a textarea's API value to LF, and nothing in the pane handles CRLF. A one-character edit to any CRLF file — md, tex, yaml, `.bib`, code — produces a whole-file diff. Fix: record the file's line ending at seed time, re-apply at write time. | B | S |
| **V-02** | `draftSaver.ts:54` | **Closing a tab with autosave off destroys the draft** — but this is a *stated* contract, not an oversight. **Moved to Tier 3 (V-26); do not land it as a fix.** | A | — |
| **V-03** | `FileViewerPane.tsx:1378-1384` | **Autosave writes straight through its own external-change banner.** `externalChange` is not a parameter of `saver.update`, and the poll advances `lastMtime` *before* raising the banner, so the clobber is undetectable afterwards and Reload then offers the user their own bytes. Fix: re-stat immediately before the write; never advance the baseline before raising the banner. | A | S |
| **V-04** | `PdfViewer.tsx:2691` | **The PDF remark autosave can write over a live latexmk build.** Verified in the backend: `tex.rs`'s only two `fs::rename` calls are the `.fmt` cache — the engine writes the PDF *in place* via `-outdir`, repeatedly across one build — and `write_file_bytes_local` (`fs.rs:1659`) is a plain create+truncate+write with no temp, rename or lock. The autosave is a 1.2 s `setTimeout` no user action triggers, its staleness flag cannot become true while the pane is hidden, and the poll is 1500 ms against a 1200 ms timer even when visible. Either the engine truncates our bytes (remark gone, panel reported success) or we truncate its half-written file. Fix: one re-stat inside `handleSave` before `writeFileBytes`, which subsumes all four reported symptoms. | A | M |
| **V-05** | `yaml.ts:251/295/303/324` | **Flow scalars are written unquoted, tearing the collection.** `needsQuoting` has no notion of flow context. `hosts: [a, b]` → retype item 0 as `x, y` → `[x, y, b]`; as `a]b` → the file no longer parses and the tree collapses to Source. `.json` is safe (strict quotes everything); every `.yml` is not. Fix: thread a `flow` flag through the four encoders and their call sites. | B | M |
| ~~**V-06**~~ | `markdownEdit.ts:187/246` | ~~The two ops that create a line break hardcode LF.~~ **Withdrawn — subsumed by V-01.** `continueList` inserts `` `\n${indent}${marker}` `` and `generateToc` joins with `"\n"`, but there is exactly one write path out of `useEditableFile` (`:1379`), so once V-01 restores the file's ending there, every `\n` an edit op inserts — including the TOC button's own `` `${toc}\n` `` at `:5816` — becomes the file's ending on the way out. Landing it as well would add a **fifth** copy of `lineEndingOf` (see §7) computing over a buffer that is LF by construction, i.e. one that can only ever return `"\n"`. | B | — |
| **V-07** | `markdown.ts:575-615` vs `:639-663` | **Clicking a checkbox can tick a different one.** The list collector has no fence bookkeeping while `toggleTaskCheckbox` does, so a fenced block indented inside a list item renders its `- [ ]` lines as real checkboxes; the DOM ordinal then addresses the wrong source line, and the last box silently does nothing. Fix: emit `data-md-task-line` and address the source line, deleting the second structural analysis rather than resynchronising it. | B | M |
| **V-08** | `YamlTree.tsx:627`, `YamlGrid.tsx:415` | **`pointercancel` commits a reorder.** `hooks/useListReorder.ts:103-107` states the opposite rule for this exact gesture shape — only `TodoBoard`'s card drag commits on cancel, and it is made safe by a no-target no-op. Here the fallback is index 0, and there is no drag threshold, so a cancelled press-and-twitch writes a move. | — | S |
| **V-09** | `PdfViewer.tsx:364-385` | **`PdfThumb` releases nothing on the cancel path** and passes no `annotationMode`, so a superseded render retains every decoded image *and* the rail double-paints taken-over highlights. One function, two defects, one fix. | C | S |
| **V-10** | `FileViewerPane.tsx:1338-1346` | **A silent reseed destroys undo history with nothing on screen.** `seedFromDisk` runs on every detected advance and always `reset()`s, clearing `past` and `future`. Fix (P3a): skip it entirely when `text === baseline` — a recompile that rewrote byte-identical content, or a bare `touch`. | A | S |

## 3. Tier 2 — correctness and memory, not data loss

| ID | Where | What |
|---|---|---|
| **V-11** | `tex.ts:2598, 3091, 2943` | Three parsers do not blank comments while their siblings do: the `\ref` dropdown offers a key from a `% \label{…}` that Ctrl+click cannot resolve; a commented-out `\input` feeds completions and the word count; `\begin{align}` with a `% \end{align}` below makes both the completion and the auto-indent Enter decline to write the `\end`. |
| **V-12** | `tex.ts:1198` | `blankTexComments` runs 4× per keystroke over the whole document (five separate `useMemo`s, each blanking independently). A 2–4 entry identity cache removes three of four passes. Do **not** sell this as the fix for the per-keystroke cost — `tex-ui` expects the five whole-document HTML builds to dominate, and that measurement is owed. |
| **V-13** | `PdfViewer.tsx:1495` | The outline hover preview's raster cache is never evicted and never reset on document change; hovering a 300-page outline retains 300 page rasters for the sidebar's life. `useSearchText.ts:20-33` is the correct sibling. |
| **V-14** | `pdfDoc.ts:329-359, 748` | The redaction rasteriser never releases its canvas (both siblings do); `buildPdf` silently `continue`s past a missing page instead of throwing. |
| **V-15** | `pdfDoc.ts:93-99` | `sourceBytes` has no in-flight guard, so a rail drag across ten slots starts ten concurrent whole-file reads of a 130 MB thesis. The fix is to store the promise, not the result — S, no user-visible change. |
| **V-16** | `pdfDoc.ts:767` | `collectGarbage` is correct *today* only because pdf-lib registers a flattened sheet's image at `save()` flush, after `scrubMetadata` runs. A version that pre-registers would blank every redacted page with nothing failing. pdf-lib exposes `PDFDocument.flush()`; awaiting it before the sweep converts the hazard into a structural guarantee. `package.json:46` carries a caret, so only the lockfile holds the version. |
| **V-17** | `FileViewerPane.tsx:7879, 7977` | Two bare `Element.scrollIntoView` calls — exactly what `embed/pdf/scrollBox.ts` exists to prevent. `.subwindow` and `.subwindow-body` are `overflow:hidden` (`subwindows.css:103, 115`), so a fragment jump can displace two ancestors that show no scrollbar to get back. Generalize `scrollIntoPdfBox` into a shared `scrollIntoBox`. |
| **V-18** | `markdown.ts:463, 511/530` | YAML front matter renders as `<hr/>` + an `<h2>` of its first key; repeated headings are not deduped, so a generated TOC links to nothing (and `ViewerFormat.test.ts:129` currently *asserts* the broken anchor). |
| **V-19** | `mdGraph.ts:124-133` | The crawl awaits each read serially — up to 120 sequential SFTP round trips per look on a remote project. Extract a `pMap(limit)` and share it with `PreviewImages`' existing pump. |
| **V-20** | `FileViewerPane.tsx` (TeX) | Four hover-preview defects: the card survives a scroll with a stale anchor; turning Preview off leaves it open; `clearTexPreviews` is dead code so nothing ever invalidates the cache (a cached *failure* outlives closing the tab); the `is-previewed` ring can jump to a twin fragment. |

## 4. Tier 3 — needs a decision before any code moves

- **V-21 — "Delete all metadata" leaves the reader's name in the file.**
  `scrubMetadata` walks `META_KEYS` on the catalog and page nodes, but a remark
  carries `/T` — a real name, typed into the card's author field — and a strip
  does not touch it. The i18n string already promises "no title, **author**,
  producer, dates or XMP packet". `pdf-annot`'s call: fold it into the existing
  action rather than adding a second checkbox, since one intent wearing two
  switches means the one people miss is the one that matters. It strips *every*
  `/T`, a colleague's included. Reword the key; no new surface, so no
  `UntestedTag`.
- **V-22 — the PDF rail's undo granularity.** Coalescing a rail drag into one
  undo entry is right, but it changes what Ctrl+Z means and `PageStrip` has two
  hosts — the print preview inherits whatever is decided.
- **V-23 — `links.ts`'s documented invariant is false.** It states a `Launch`
  naming a local program and a `GoToR` are "deliberately not rendered"; pdf.js
  sets `url` from `/F` for both, so either arrives as an ordinary external link
  when `/F` is `http://…`. No execution hole (a relative `payload.exe` is
  dropped, and the confirm dialog stands), but a false invariant in a
  security-relevant comment is worse than none. Correcting the doc is in scope;
  really dropping them needs pdf.js to expose the action type, which it does not.
- **V-24 — the backend write path.** The real fix for V-04's *class* is
  compiling into a scratch out-dir and `fs::rename`-ing the finished PDF into
  place, plus a compare-and-swap `write_file_text(expectedMtime)` in `fs.rs`.
  Both are `src-tauri/`, so neither reaches a running window without a restart.
  Filed, not landed.
- **V-25 — accessibility.** `PageStrip` has no keyboard path at all (selection,
  reorder and drag are pointer geometry; only turn/remove are real buttons), the
  TeX completion dropdown has no combobox semantics, and YamlTree's paste cursor
  is click-only. `TableView` is the good sibling to copy.
- **V-26 — does closing a tab with autosave OFF write the draft?** Filed by
  `shared` as Tier 1 ("the four shared viewers never got DeckView's fix"), and
  the unconditional flush *was* landed here and then **reverted**, because the
  gate surfaced what the review had missed: `ViewerEfficiency.test.ts:37` is
  named *"flushes teardown, but leaves autosave-off drafts alone until explicit
  Save"* and asserts `expect(write).not.toHaveBeenCalled()` after `dispose()`.
  Together with `DeckView.tsx:462-470`'s note that Tabtivity has no unsaved-work
  prompt anywhere *"by design"*, that is a deliberate contract: autosave **on**
  means saved, autosave **off** means nothing is written unless asked — and
  closing is not asking. Flushing anyway would write a file behind the back of
  someone who switched autosave off precisely to stop that.
  So the defect is real but the fix is not the obvious one, and the three
  candidates are a user's call, not a reviewer's: (a) leave it, (b) flush on
  close — overriding the stated preference and requiring that test to be
  rewritten, or (c) keep the contract and add the unsaved-work prompt the design
  currently refuses, which is a new user-facing surface in every viewer.
  **Nothing here should move without that decision.** Recorded as the one place
  this review tried to fix a documented intention.

## 5. Verified clean — do not re-litigate

- **No XSS path in `markdown.ts`.** Escape-first holds on every branch including
  the recursive link label; the NUL placeholders are unforgeable (stripped at
  `:467`); `safeHref` rejects `//`, unknown schemes and mixed-case
  `javascript:`; entity double-decode is unreachable. Two hardening *notes*
  only: mermaid renders attacker-controlled source into `innerHTML` with
  `securityLevel:"strict"` as the sole barrier (track it as a security-relevant
  dependency), and KaTeX runs without `maxSize`.
- **i18n is at zero leaks** in the viewer components — a scan of YamlTree,
  TableView, PdfViewer, BibCards, MdGraphView, PageStrip and SqliteView found no
  hardcoded user-facing strings, and `i18n.test.ts` already pins full dictionary
  parity including placeholders. Two leaks live in non-component code: the TeX
  compile-flags placeholder (`FileViewerPane.tsx:9814`) and markdown's
  `ALERT_TITLE` / mermaid error string.
- **`pdfLoad.ts` is the only `getDocument`** — U#836's fix holds across all six
  consumers.
- **`page.cleanup()` is correct everywhere except V-09's branch.**
- **No blurred-box-shadow animation** anywhere in the viewers; the two
  `box-shadow` transitions are hairlines with blur radius 0.
- **Pane-visibility gating is correct** in all six polls — but has **zero** test
  coverage (`PaneVisibleContext` appears nowhere in `src/__tests__/`).
- **`UntestedTag` is honest for PDF and bib**; `MdGraphView` carries none and
  probably should.
- **Byte-preservation tests are strong** where they exist: `YamlModel` 25+
  cases, `TableEdgeCases` 15 on CRLF/BOM/astral/ragged, `PdfNotes` pinning
  `isPristineExceptNotes` against moves, rotations and deletions.

## 6. Findings corrected or withdrawn during the cross-critique

Recorded so nobody re-files them.

- **"The PDF viewer gets the autosave gate right."** Filed by `shared`, overturned
  by `pdf-annot`: it does AND `staleOnDisk` into the gate, but that flag cannot
  become true while the pane is hidden and is 300 ms behind while visible. A
  cached flag cannot gate a write. This is why V-03 and V-04 share one contract.
- **"Every markdown block op corrupts CRLF."** Mine, refuted by reading:
  `"a\r\nb".split("\n")` yields `["a\r", "b"]` and `.join("\n")` reproduces the
  CRLF exactly, so `toggleLinePrefix`, `indentLines` and `cycleHeading`
  round-trip safely. Only the two ops that *create* a break were wrong (V-06) —
  and V-01 turned out to sit underneath all of it.
- **"`yaml.ts` carries the M#840 CRLF bug."** Mine, refuted: `yaml.ts:183`
  computes `eol` and the splice path writes it. Confirmed independently.
- **"Unify the three comment-strippers."** `tex-core` withdrew its own proposal:
  `tex.ts` imports `isBeamerDocument` from `beamer.ts`, so importing
  `blankTexComments` back would create a cycle. Needs a third module — a
  shared-plumbing decision, not a TeX one.
- **"An unclaimed PDF clip token leaks."** `pdf-core` withdrew it after reading
  the backend: `commands/pdf_clip.rs` is a bounded in-memory `VecDeque`, evicted
  by the next few transfers.
- **"Front matter breaks every `SKILL.md` in the Skills Library."** `md`
  withdrew its own overclaim: `services/skills.rs:176-194` strips front matter
  before `body` is set. V-18 bites the *file viewer* opening any front-mattered
  `.md`, which is ordinary but narrower.
- **"`preambleVersion` would fix the stale hover preview."** `tex-core` refused
  it: the key already hashes the preamble *text*, so a stale preamble is a stale
  input, not a stale key — bumping a version recompiles with the same wrong
  preamble at the cost of an engine run. Fix the read, not the key.
- **"M#249 covers the per-keystroke cost."** Mine, corrected by `tex-ui`: M#249
  owns the per-*mousemove* hit-test path and its method is already decided.
  Nothing owns the per-keystroke path; that is V-12.
- **Three near-identical cache/latch bugs want one abstraction.** Proposed, then
  rejected by both `tex-ui` and `pdf-core` independently: three different
  mechanisms (an mtime watcher, a missing side-effect, memo deps). One review
  rule and three S fixes, not a shared utility.

## 7. Cross-cutting, filed rather than fixed

**Four near-copies of a five-token helper.** `lineEndingOf` exists as
`bib.ts:632`, inline in `table.ts:183`, inline as `eol` in `yaml.ts:183`, and as
`newlineOf` in `projectRemarks.ts:110`. V-06 adds a fifth locally because
extraction touches four files across three territories. The extraction is its own
item.

**One scanner, not one parser.** Markdown has three near-copies of fence
skipping (`markdown.ts`, `markdownEdit.ts`, `mdGraph.ts`). `md`'s proposal is to
share the *scanner* — one `eachSourceLine(src, cb)` yielding `(line, index,
inFence)` — rather than attempt one authoritative parse.
