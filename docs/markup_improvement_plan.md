# PDF markup mode — review and improvement plan

> **Status (2026-10-25): items 1, 2 and most of 3 are implemented** (not
> live-verified): 1 — the round is bound to the tab its last prompt went to
> (`roundTarget` in `usePdfMarkup.ts`); 2 — a custom instruction in an `apply`
> round that fell back to `list` gets `LIST_FALLBACK_GUARD` appended
> (`mobile_control/markup.rs`); 3 — `PdfMarkupLayer` mounts only on `near`
> pages, and box/arrow/stamp/area drags repaint from a cached copy of the
> committed marks. Not done: memoizing `edit`/`PdfPageCanvas` (item 3's last
> point; the repaint cost is already gone, only React reconciliation of the
> near pages is left), items 4–7 and the smaller items. Line numbers are
> from `develop` at `9be78e95` (v0.2.29) and will drift; grep for the named
> symbol before acting on one.

Two independent read-only passes (same brief, no shared context) over the
phone (`mobile-web/src/components/MarkupView.tsx`, `mobile-web/src/markup/`),
the desktop (`src/components/embed/pdf/PdfMarkup*.tsx`, `usePdfMarkup.ts`,
`src/lib/viewers/pdfMarkup.ts`, `markupPage.ts`) and the backend
(`commands/pdf_markup.rs`, `commands/markup_mcp.rs`, `services/markup_mcp.rs`,
`services/markup_rounds.rs`, `services/mobile_control/markup*`,
`markup_pdf.rs`), merged here. Items 1 and 3 were re-checked against the code
after the merge; everything else rests on the reviewers' cited evidence and
should be verified before it is acted on.

Related: `docs/context/phone_markup.md`, `docs/context/markup_mcp.md`,
`docs/done/pdf_markup_rounds_plan.md`, `docs/done/pdf_markup_direct_apply_plan.md`,
`docs/done/markup_tools_plan.md`, `docs/done/markup_tick_approve_plan.md`.

---

## Before anything else: live QA

None of the 44 markup ids in `src/lib/untested.ts` is stamped tested, and
about 16 manual boxes are open (`todo/group-h-crossplatform.md` ~3937–4081,
"never run on a phone"). Items 1–3 are small and safe to do first; the
refactor (item 7) should wait for a QA pass so it is not refactoring
unverified behaviour.

## Where the two passes agreed

- **The two big files carry too much.** `usePdfMarkup.ts` (1288 lines,
  35 `useState`, 15 effects) inside `PdfViewer.tsx` (5736 lines), and
  `MarkupView.tsx` (2529 lines; one component from ~363 to ~2486 with 55
  `useState`, 26 effects, 60 refs). Both would split into layer/history/
  selection, round/undo, and asks/ticks.
- **Remote/SSH projects have no markup**, and `todo/` does not track it:
  hidden by `markupGate` (`pdfMarkup.ts:26-49`), refused by the backend
  (`pdf_markup.rs:70-75`); a v1 non-goal (`pdf_markup_rounds_plan.md:48`,
  `markup_mcp.md:252`). It is the LaTeX-on-a-cluster workflow.
- **`markup_pdf.rs` deserves a fuzz target.** 2182 lines, hand-written parser
  over PDFs from the project folder (attacker-controlled); 16 hostile-input
  tests, no fuzzing, no corpus of real pdfTeX/LuaTeX/XeTeX output.
- **Already tracked:** screenshot markup (`todo/group-m-viewers.md:2984`);
  reader-tagged quick fixes on a fast model (`docs/pdf_markup_fast_model_plan.md`,
  F2 deferred); Undo reverting the whole work tree (fixed,
  `todo/group-o-security.md:1245-1253`).

## Ranked improvements

### 1. Desktop round follows the picked tab, not the tab it was sent to — bug (S, low risk) ✔ checked

The target tab is the live `chosen` state, and everything round-related reads
it at use time:

- the pill: `tabAgent`/`agent` from the current `target`
  (`usePdfMarkup.ts:484-495`), stepped at `598-617`;
- the undo snapshot settles when *that* tab finishes (`1034-1039`);
- the Undo note is queued to the current `target` (`1104-1111`);
- **Make these changes** goes to the current `target` (`1134-1142`);
- the agent tab's ↩ back-link (`PdfViewer.tsx:2852`).

The picker stays enabled during a round (`PdfMarkupBar.tsx:647-661`), and a
closed chosen tab moves `chosen` (`usePdfMarkup.ts:478-483`). Picking an idle
tab mid-round reads "finished" after ~3 s, so the after-snapshot is settled
while the real agent is still editing: the Undo is partial or conflicts, and
"Make these changes" reaches an agent that never saw the marks.

The phone already binds the round to its tab (`undoTab.current = tabId`,
`MarkupView.tsx:1551`). Fix: record the round's `scheduleTargetId`/`ptyId` on
the round at Submit and read those for pill, settle, undo note and apply;
optionally disable or warn on the picker while a round is out. Test: switch
target mid-round (`PdfMarkupSubmit.test.tsx:279-313` only switches before
Submit).

### 2. One custom instruction for both modes → edits without an Undo (S–M, low risk)

A user instruction is sent "as written in either mode" (`markup.rs:702-708`);
Settings has one field (`SettingsPanel.tsx:2000-2009`), the phone one
`markupInstruction` (`prefs.ts:84`). An `apply` round silently falls back to
`list` when no snapshot can be taken (no git, too big, filtered:
`markup_rounds.rs:214-230`; `markup.rs:744-755`). A custom apply text ("…and
rebuild") then edits files with no Undo, while the strip offers **Make these
changes**.

Fix: one instruction per mode, or on fallback with a custom text append the
default's "do not change any file yet" guard. Test: custom instruction in a
round that fell back to list.

### 3. The desktop markup canvas is too expensive on long PDFs (S, then M; low risk) ✔ checked (first point)

- `PdfMarkupLayer` mounts on **every** page whenever markup is on
  (`PdfViewer.tsx:1674-1676`), without the `near` gate the page canvas, links
  and text layer use (`PdfViewer.tsx:798-808, 907, 1077`). Each gets a
  full-resolution backing store drawn on mount (`PdfMarkupLayer.tsx:177-181,
  208-213`, cap `MAX_BACKING = 8192`). The phone mounts only `shown` pages
  (`MarkupView.tsx:2255-2258`). → add the `near &&` gate (S).
- Every `preview`/`area` change resets `canvas.width` and repaints all marks
  (`PdfMarkupLayer.tsx:208-215`): every pointer move for marker, dashed,
  arrow, box, text mark, stamp and area drags. Only the plain pen paints
  incrementally (`:267`). → cached committed-marks canvas + overlay (M).
- `edit` is rebuilt every render (`usePdfMarkup.ts:870`) and neither
  `PdfPageCanvas` (`PdfViewer.tsx:603`) nor `PdfMarkupLayer` is memoized, so
  scratch updates (erase, move, note drag: `PdfMarkupLayer.tsx:418-433`)
  re-render every page. → memoize (M).

Test: far-off pages mount no markup canvas.

### 4. What the agent receives loses information (S–M each, low risk)

- **Arrows have no direction.** Anchors use the bounding box
  (`anchors.ts:101-110`), the prompt says "arrow on <every word in the box>"
  (`markup.rs:1007`), SyncTeX is asked about the box centre
  (`markup.rs:1249-1257`). → "arrow from «…» to «…»" with a source line per
  end; optionally pair a margin note with the arrow touching it. No anchor test
  covers arrows.
- **Overflow marks lose their labels.** Past the 12 KB budget
  (`markup.rs:1330`) extra marks become "(N more marks — read them in the
  pictures)" (`markup.rs:1226-1235`): no `p/m` reference, no `file:line`, so
  `markup_done` cannot tick them. → write the full list to an inbox
  `…-marks.md` beside the PNGs and point at it.
- **Fixed 1200 px pages** (`rasterize.ts:24`) are coarse for dense or large
  pages. → add higher-resolution crops around the marks.
- **Unverified:** the prompt relies on `@path` for every CLI
  (`markup.rs:1135-1175`); check that Codex actually opens a pasted `@….png`,
  else say "open the page images with your image tool".
- Only Claude and Codex get the markup MCP (`services/markup_mcp.rs:55`);
  other CLIs are told to list questions in their reply, which the reader at
  the PDF never sees. → the pill could say "agent replied in chat".

### 5. Markup vanishes or dead-ends without saying why (S–M, low risk)

- `markupGate` returns `show: false` for remote projects, popouts and PDFs over
  24 MB (`pdfMarkup.ts:47-49`); the button just disappears
  (`PdfViewer.tsx:5025-5028`); `docs/help/pdf-and-markup.md` names none of
  these. → disabled button with the reason (S).
- The 24 MB cap exists for the marked-copy bake (`pdfMarkup.ts:17-19`), but the
  bake is already optional — its failure costs only the copy
  (`markup.rs:682-693, 1149-1150`). → allow big PDFs by skipping the bake (M).
- With no agent tab, desktop Submit only says "Open an agent tab in this
  project to send" (`PdfMarkupBar.tsx:640-641`); the phone opens the default
  agent and holds the prompt there (`mobile-web/src/markup/newTab.ts`,
  `phone_markup.md:8`). → same "Open <default agent> and send" path on the
  desktop (M).

### 6. Undo and ticks do not survive closing the view (M, medium risk)

The round lives in component state only, deliberately
(`pdf_markup_direct_apply_plan.md:167-168`), though the backend keeps snapshots
7 days / 30 rounds (`markup_rounds.rs:122-123`). Ticks are memory-only
(`markup_mcp.md`: "nothing survives a restart") while sent marks and the round
log persist (`store.ts`). After a close or restart Undo is unreachable and ✓
badges vanish. → store `{roundId, undoId, target}` in the layer record and add
a `pdf_markup_undo_status` lookup. Reverses a design decision: decide first.

### 7. One round/undo controller shared by phone and desktop, then split (L, medium risk)

The flows are near line-for-line copies: undo (`MarkupView.tsx:1599-1643` vs
`usePdfMarkup.ts:1064-1121`), Submit tail (`1534-1558` vs `1006-1025`), layer
load/save (`697-733` vs `401-471`). Item 1 is the drift this already produced.
The phone has `useMarkupAsks` (`markup/questions.ts`) while the desktop keeps
its own copy of that state (`usePdfMarkup.ts:352-356, 369`). A shared hook in
`mobile-web/src/markup/` (round, undo, settle, apply, layer storage) fixes it
at the root; `PdfViewer.tsx`'s markup glue (`2776-2870`) could move into a
`usePdfMarkupHost`. Tests are dense, so it is safe but large — after QA.

## Smaller items

**UX**
- Desktop Submit shows only "Sending marks" (`PdfMarkupBar.tsx:788`) while it
  draws pages one by one (`usePdfMarkup.ts:968-980`); the phone shows per-page
  progress (`MarkupView.tsx:1443`).
- The undo snapshot runs before the prompt is queued and may take up to 30 s
  (`OPERATION_BUDGET`, `markup_rounds.rs:102`) with no indication → "saving
  undo snapshot…".
- Six markup settings exist twice: desktop `pdf_markup_*` and per phone
  (`prefs.ts:24-28, 84`), so the same project behaves differently by device →
  the phone inherits the desktop's values unless overridden.
- No shared layer across devices (each side has its own IndexedDB). Not
  tracked.

**Correctness**
- A queue failure after a successful submit leaves the inbox PNGs and the undo
  snapshot orphaned; a retry takes a second snapshot
  (`usePdfMarkup.ts:984-1004`).
- An apply round queued behind a working agent also snapshots that agent's
  previous-turn edits — documented (`pdf_markup_direct_apply_plan.md:133-137`),
  but the existing `queued` flag (`usePdfMarkup.ts:997`) could warn.

**Performance**
- Every `markup-mcp-changed` makes one IPC call per agent tab, twice (asks and
  ticks: `usePdfMarkup.ts:551-583`) → one batched list command.
- Every committed stroke saves immediately and runs `withinLimits` over up to
  21 layers (`store.ts:175-178`) → debounce.
- Desktop Submit sends pages as base64 JSON (`pdf_markup.rs:116-121`, up to
  `MAX_LAYERS_TOTAL` = 64 MB) → binary IPC, or the phone's separate inbox
  upload (`MarkupView.tsx:1461`).

**Tests to add**
- target switched mid-round (item 1);
- custom instruction in a round that fell back to list (item 2);
- far-off pages mount no markup canvas (item 3);
- arrow anchors (item 4);
- a `markup_pdf.rs` fuzz target with a real-TeX-output corpus.

## Judged fine

- Prompt design: deterministic, budgeted; SyncTeX lines skip edited and
  out-of-project sources (`markup.rs:1273-1324`); the default instruction asks
  for a rebuild (`markup.rs:64`).
- Submit hardening: root from `projects.json`, remote refused, base64 sized
  before decode (`pdf_markup.rs:67-75, 110-118`).
- `markup_pdf.rs` bounds, deadline, step budget, encrypted PDFs refused
  (`markup_pdf.rs:1-48`, tests 2072-2156).
- Undo's git calls go through `hardened_git_command_in`
  (`markup_rounds.rs:71, 461`).
- Drawing during a Submit (`asSent`, `usePdfMarkup.ts:1011-1013`); the phone's
  4 MB request cap is not hit (pages uploaded separately).
- The questions MCP: non-blocking ask, reopen receipt, rate limits; undo steps
  stored once in IndexedDB; `pen`/`layer`/`rasterize`/`submitState` already
  shared.
- Open markup items in `todo/` are almost all manual QA, not code gaps.
