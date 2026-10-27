# Phone Mark up — module notes (`mobile-web/src/components/MarkupView.tsx`, `markup/`, `pdfFrame/`)

Detail of the phone's PDF markup view. The agent-side questions and ticks:
`markup_mcp.md`. The file map keeps one line for the view.

Moved verbatim from the file map on 2026-10-19; verify against the code.

Phone **Mark up** (`docs/done/mobile_pdf_markup_plan.md`), opened from `OutboxViewer`'s `markup` prop (agent tabs, `Terminal.tsx`) or its `newTab` prop (project screen, shell tabs: Submit opens a tab of the desktop's default agent — catalog `default` flag — and holds the prompt there; the view stays, its pill polling that tab's row, `markup/newTab.ts`; its Open tab hands the file along, `MarkupBack`, and the tab's `Terminal` opens with that view tucked away under the bar over the composer) — on a PDF switched on/off in place from the reader, floating palette, fingers draw until a pen has (then pen only), note tool drags notes: pen draws / fingers scroll+pinch / palm rejection, layer per page in page units (`markup/layer.ts`), phone-only IndexedDB (`markup/store.ts`), one drawing routine for screen and PNGs (`markup/rasterize.ts`, curves match `markup_pdf.rs`). The pen bar's choices — tool, a colour per tool (yellow only for box/marker; plain colours, no meanings — the prompt names a mark's colour only to find it, `markup.rs`), pen style (pen / marker / dashed / arrow, `InkMark.style`, drawn alike by `rasterize.ts` and `markup_pdf.rs`), size, eraser reach or area (`eraseRect`) — are `markup/pen.ts`, shared with the desktop strip (`PdfMarkupBar`, keys in `PdfViewer`), kept per viewer in localStorage.

PDF pages come from the sealed frame `pdf-frame.html` (`pdfFrame/main.ts`: legacy pdf.js, no worker, classic IIFE from `vite.pdf-frame.config.ts`); every frame message passes `markup/frameProtocol.ts`.

Submit: per page the frame's `snapshot` drawn with the marks (`rasterize.ts` `pagePng`; marks alone if it fails) and its `text` runs, those the drawn page shows ink for (`markup/visibleText.ts`) → the words each mark is on (`markup/anchors.ts`; both shared with the desktop) → inbox, `submitMarkup` → prompt → `submitDraft`; the prompt's instruction is worded only in Home's phone settings (`markupInstruction.ts`, `MarkupInstructionSheet`).

A pen touching a page while reading switches marking on (and draws); the mode the reader opens in is Home's `markupOpen.ts` / `MarkupOpenSheet`.

Rounds (`docs/done/pdf_markup_rounds_plan.md`): Submit keeps the view open and moves the marks to `layer.sent` (dimmed, never resent), the pill runs `markup/submitState.ts` on `MarkupTarget.agent` (Terminal's live screen), Reload remounts the frame on the host's `refresh` (newer outbox copy / fresh listing row, `moveLayer`) — on its own once the agent finished and the file changed, unless ⋯ turned `markupAutoReload` off.

⋯ subagent mode (`markupSubagents`, off) starts each Submit's prompt with `markupForSubagent` (`markupInstruction.ts`, shared with the desktop's `pdf_markup_subagents`): the agent hands every round to a new subagent.

The agent's `markup_ask` (`docs/done/markup_questions_mcp_plan.md` P3): `MarkupQuestionsCard.tsx` docked above the palette (rows = `QuestionRows.tsx`, shared with Terminal's Focus `QuestionList`; picks from `src/lib/viewers/markupQuestionPicks.ts`; answer/dismiss via `api.ts`, the desktop builds and queues the prompt), polled by `markup/questions.ts` (`useMarkupAsks`: 3 s while shown + visible, on agent edges; also Terminal's Focus banner); `?n` pins at the quote's boxes, which the frame finds on request (`findText` → `found`, `markup/findText.ts`).

An outbox copy with a `file_row` (the sidecar's sealed row of the project file it was sent from) opens that file instead, on the `files:` key, adopting the copy's layer once (`adoptFrom`; `docs/done/mobile_markup_shared_layer_plan.md`); ⋯ Clear all marks (`clearAll`), ↑ ↓ jump between marks (`markAnchors`).

Apply marks directly (`docs/done/pdf_markup_direct_apply_plan.md`; `markupDirect`, on): Submit sends `mode`, the answer's `undo` id rides the round (`submitState.ts` `canUndo`), settled on each finish (`settleMarkupUndo`); pill **Undo** → `OptionSheet` with the preview → `runMarkupUndo` → `reload` + `markupUndoNote` into the chat (no new round); a `list` answer's `noUndo` shows one line and Make these changes.

Ticks (`markup_done`, `docs/done/markup_tick_approve_plan.md` §4): Submit sends a `mintRound` id and logs the marks (`markSent(.., round)`); `useMarkupAsks` also returns the route's `ticks` (`readMarkupQuestions`, none without a source); `tickedMarks` → `tickGroups` (near marks of a page = one remark) → one ✓ `markup-pin is-tick` badge per group just outside its box's corner (`tickBadgeSpot`, never over the marked words) (keyed by first mark identity, `ARRIVAL_GUARD_MS` per badge — a grown group arrives anew, double tap ignored; a tap approves the group, `approveShown`), **n done · Approve all** under the pill; a successful Undo `forgetRound`s its round.

While marking in an agent chat the head's model chip (`pickModel`, not local-model tabs) opens Terminal's model sheet over the view (`.sheet-lift`).

Pill **Chat** (`toChat`, agent tabs, a round out): Terminal's `markupAway` hides the viewer in a `.markup-host.away` box (still mounted) and a bar over the composer brings it back.

Tools round 2 (`docs/done/markup_tools_plan.md`): `layer.ts` stamps (`StampMark`, `STAMP_SHAPES` = `markup_pdf::stamp_shape`), `comment`, selection (`markAt`/`marksIn`/`moveMarks`/`restyleMarks`/`removeMarks`/`setComment`), `snapStroke`, `SentRound.words`; `anchors.ts` `textMarks`/`wordsIn`; `pen.ts` presets, pressure curve, palm; `store.ts` keeps 20 undo steps (`past`).

**Annotate** (2026-10-27): on a project PDF the reader also offers Annotate while the desktop's "Phone may write remarks into PDFs" (`project_remarks`, default off, needs `project_files`; the listing's `remarks`) is on. Same view, its own layer (`REMARKS_KEY`, switched by `switchLayer`, never saved under the agent's key), tools `REMARK_TOOLBAR` (text marks are highlights); **Save** → `saveRemarks` → `mobile_control/remarks.rs` appends `/Highlight` + `/Text` remarks to the PDF itself (the desktop Remarks pane's shapes), then the layer clears and the file reloads. A PDF changed since opening is `file_changed`, with Reload. The phone draws the saved notes as icons only; their words show on the desktop.
