# Markup refactor — plan

The larger half of the markup `/simplify` pass. The small half landed as
`70df7dc10` ("share the duplicated markup code, drop dead code, cut hot-path
work"): the shared helpers in `mobile-web/src/markup/` (`paintLayer`,
`paintStrokePiece`, `boxBetween`, `pagePoint`, `noteSize`, `cleanNote`,
`markKey`, `forgetRoundInHistory`, `ROUND_KEYS`, `NO_UNDO_KEYS`), the
`reasonText` / `deliver` / `beginRound` helpers in `usePdfMarkup.ts`, the
phone's `fail()` / `deliver()`. Read that commit first — this plan builds on
it.

Related plans, read only the named sections: `docs/markup_improvement_plan.md`
§3 (canvas cost) and §7 (one round/undo controller), and
`docs/pdf_viewer_split_plan.md` (another session splits `PdfViewer.tsx`).

Plan reviewed against the code on 2026-11-14 (see the handoff's "Plan
review"); symbol names below were checked with `rg`. Line numbers are not
given: grep the symbol.

## Fixed decisions

Reviewers may not undo these.

1. **Behaviour does not change**, except decision 2. Every step is a
   refactor or a speed-up; a bug found on the way gets its own commit with a
   regression test.
2. **Desktop ✓ badges get the arrival guard** (user, 2026-11-14): a badge
   takes no click for `ARRIVAL_GUARD_MS` after it appears (a group that grew
   arrives anew), as on the phone and the desktop question card. One shared
   helper serves all three.
3. **The OpenCode model-list grouping is decided once** (user, 2026-11-14):
   the four `isOpenCodeTab(..) && title === "Select model"` sites — the markup
   model chip, `TerminalReaderFacts.tsx`, `SteeringPromptOverlay.tsx`, the
   phone's `screens/Terminal.tsx` — call one pure helper. Touching those
   reader/terminal files is in scope for that step only.
4. **`PdfViewer.tsx` is touched only in the last step (H)** and only once the
   split's Phase 1 has landed on `develop` (`src/components/embed/pdf/PdfThumb.tsx`
   exists). The split session leaves the markup glue and the host keys'
   markup branch to us. If Phase 1 has not landed when step H is reached,
   step H is not done; it is recorded in the handoff as open.
5. **No full shared round controller.** `markup_improvement_plan.md` §7 (one
   hook for round, undo, settle, apply, storage) waits for live QA. This run
   only shares pure helpers and moves state into the shared `Round` shape;
   each host keeps its own transport (`invoke` vs the phone's `api.ts`).
6. **Undo and ticks still do not survive closing the view**
   (`markup_improvement_plan.md` §6 is a design reversal; not in scope).
7. **Shared code lives in `mobile-web/src/markup/`** (both bundles import
   it) or in an import-free `src/lib/viewers/*` module the phone already
   imports (`markupQuestionPicks.ts`). Never import a desktop component or
   `invoke` into the phone bundle, nor `mobile-web/src/api.ts` into the
   desktop.
8. **Hot paths keep the current output pixel for pixel.** Caches key on
   object identity (layers, pages and marks are never changed in place;
   `70df7dc10` relies on that too) and are `WeakMap`s.
9. No new user-facing strings unless a step cannot avoid one; then English in
   `i18n/en.ts` and the four other dictionaries.

### Clarifications from the plan review (they restate, not reverse)

- **Decision 4's test.** At review time Phase 1's files (`PdfThumb.tsx`,
  `PdfPageCanvas.tsx`, `PdfOutlinePane.tsx`) exist only as *untracked* files
  in the main checkout. "Landed" means committed on `develop`: check
  `git cat-file -e develop:src/components/embed/pdf/PdfThumb.tsx` in the main
  checkout (a worktree reset to `develop` has the file only then). The split's
  Phases 2–3 keep rewriting `PdfViewer.tsx`; before H, read the split plan's
  status and build on `develop`'s tip.
- **Decision 2 covers "Approve all" too.** The phone guards the strip's
  *Approve all* with the newest badge's arrival; the desktop's does the same
  (same words as "badges, as on the phone"). The phone's second window
  (`TICK_REPEAT_MS`, 350 ms between two approvals) stays phone-only: the
  desktop has its `event.detail <= 1` double-click guard instead and does not
  adopt it.
- **Decision 8 and E2.** Only copy-removal is pixel-safe for a styled stroke
  preview; incremental drawing of dashed or see-through strokes is not. E2
  is cut down to that (below).

## Steps

Steps are commits; test names are the files that exist today. Desktop:
`src/__tests__/pdf/PdfMarkup{Core,Tools,Pen,Layer,DesktopTools,Model,Questions,
Submit,Ticks,Viewer}.test.ts(x)`, `ImageMarkupSubmit.test.tsx`,
`PdfSearchEfficiency.test.tsx`. Phone: `src/__tests__/mobile/MobileMarkup*.test.ts(x)`
(`Rounds`, `RoundsCore`, `Ticks`, `TicksCore`, `View`, `Questions`,
`QuestionsCard`, `VisibleText`, …), `MobilePdfFrame.test.ts`. **There is no
`PdfMarkupStorage*` or `PdfMarkupReload*` test**: the desktop load/save/
restamp protocol has no test today (step C starts by writing them).

### A. The round owns its undo log id (both hosts)

- `submitState.ts`: `RoundUndo` becomes `{ id, state, logId }` — `logId` is
  the Submit's round id (`mintRound()`) the undo belongs to (required, so
  `tsc` finds every literal: `usePdfMarkup.ts` and `MarkupView.tsx` where they
  call `startRound(.., { id: undo, state: "ready" })`, and the `UNDO` / ad-hoc
  literals in `MobileMarkupRoundsCore.test.ts`).
- `usePdfMarkup.ts` and `MarkupView.tsx`: drop the `undoRounds` ref. Do **not**
  read `round.undo.logId` after the `await` in `confirmUndo` / `runUndo`: a
  `followRound` or a newer Submit has replaced the round by then and the old
  map still answered. Instead the preview state (desktop `undoPreview`, phone
  `undoSheet`) carries `logId` next to `id`, set in `askUndo` / the phone's
  `askUndo` from the round that `holdsUndo` just confirmed; `confirmUndo` /
  `runUndo` pass that to `forgetRoundInHistory`. `answerAsk` (desktop) and the
  phone's re-`startRound(.., was?.undo)` already carry `undo` forward, so the
  id travels with it.
- One difference to record in the handoff, not to hide: a Submit that lands
  *while* an Undo's request is in flight used to skip the forget (the map was
  cleared); it now forgets the undone round's ticks, which is the correct
  outcome (its files did go back).
- Tests: `MobileMarkupRoundsCore` (literals), `PdfMarkupSubmit` ("settles as the
  round finishes, and the dialog's Undo …", "says which files changed since …"),
  `MobileMarkupRounds` round-trip the undo; add one case: the undone round's
  ticks are forgotten after Undo on both hosts.

### B. One undo-failure reading (both hosts)

- `mobile-web/src/markup/submitState.ts` (it already takes `t` for
  `undoSummary`): a pure `undoFailureNote(failure, step, reason, t)` with
  `failure = { code: string; conflict: { files: string[]; more: number } | null }`
  and `reason: string` already worded, returning `{ text, alert, gone }` —
  conflict → the files line (`named || "…"`, `andMore` when `more > 0`);
  `undo_gone` / `round_not_found` → `gone: true` and the "gone" text (the
  caller then does `undoneRound`); else `previewFailed` / `failed` with
  `reason`. The conflict check runs before the code check on both hosts.
- The reason is a **string the host words**, not a key: the desktop uses
  `t(markupReasonKey(code), { code })`; the phone's `reason(error)` falls back
  to `mobile.markup.reason.other` with `code || "error"`.
- Each host keeps only how it reads its error: desktop
  `pdfMarkupUndoFailure(error)` (`code` `undo_conflict` + `files`/`more`);
  phone `markupUndoConflict(error)` + `ApiError.code`.
- Tests: the two "refused" cases above, the phone's equivalent in
  `MobileMarkupRounds`.

### D. Arrival guard, one helper, desktop ticks too

(Run before C: it is the cheaper of the two.)

- `src/lib/viewers/markupQuestionPicks.ts` (import-free; keep
  `ARRIVAL_GUARD_MS` re-exported by `markupQuestions.ts`): a tiny
  `arrivalGuard()` — `arrive(now)` / `settling(now)` for a card, and the
  per-key variant the ✓ badges need (`see(keys, now)` replaces the seen map —
  a key gone from the list is forgotten, a new key stamps `now`;
  `settlingFor(keys | null, now)`: `null` = the newest arrival of all; a key
  never seen counts as settling). Reproduce the phone's rule exactly
  (`approvable` in `MarkupView.tsx`: unseen mark → refuse; max of the group's
  stamps).
- Card hosts: `PdfMarkupQuestions.tsx` (stamp at mount) and
  `MarkupQuestionsCard.tsx` (re-armed by a new ask) call `arrive` / `settling`.
- Phone ✓ badges: `MarkupView.tsx` replaces `tickSeen` / `tickArrived` with the
  per-key guard; `lastApprove` / `TICK_REPEAT_MS` stay in `MarkupView.tsx`.
- **Desktop ✓**: the guard lives in `usePdfMarkup.ts`, not in the pure
  `PdfTickBadges` / `PdfTicksStatus` components (they remount with the near
  pages and would re-arm on scrolling): a per-key guard over the sent `Mark`
  objects of `tickedGroups`, updated in an effect when the groups change, and
  `ticks.approve(page, marks)` / `ticks.approveAll()` return without
  approving while it is settling. `PdfMarkupTicks.tsx` keeps
  `event.detail <= 1` and is otherwise unchanged. (`PdfViewer.tsx` and
  `ImageView.tsx` pass `markup.ticks.approve` through: no change there.)
- Tests: add "a desktop badge and Approve all ignore a click in the first
  `ARRIVAL_GUARD_MS`". **The existing `PdfMarkupTicks.test.tsx` cases approve
  right after the badge renders and will fail: give them a clock skew like
  `settle()` in `MobileMarkupTicks.test.tsx`** (a deliberate test edit, decision
  2). The phone's tick tests pass unchanged.

### C. Save protocol without "skip the next save" flags

Highest risk of the run; do it last in Impl 1 and stop at a green earlier step
if anything below does not hold.

**C0 — characterization tests first, against today's code (own commit).** The
desktop protocol is untested. Write, with `loadLayer` / `saveLayer` /
`fileMtime` mocked, a `PdfMarkupStorage.test.tsx` that pins:
(1) loading a record writes nothing back; (2) the first change saves, stamped
with the fingerprint read after the load; (3) a change made before the
fingerprint is read is saved once it arrives; (4) a stored fingerprint that
differs from the read one sets `changed` (the stale strip) and an empty,
unsent layer does not; (5) `beforeReload()` mutes (4), changes made while it
waits are saved with the *old* fingerprint, and the new fingerprint — even one
equal in value, a new object — saves once more, stamps it and clears
`changed`; (6) a failed save shows "unsaved" and is not retried until the next
change. The phone needs only what is missing in `MobileMarkupView`: a Reload
that moves the layer to a new key (`moveLayer` + `movedTo`) saves it there; a
Reload that changes the fingerprint saves; a `history.past`-only change
(`forgetRoundInHistory`) saves; a fresh file with no record saves once (the
empty layer, i.e. a delete) on the phone and never on the desktop.

**C1 — desktop (`usePdfMarkup.ts`)**: replace `skipSave` / `pendingSave` /
`reloadingRef` with
- `persisted = useRef<Layer | null>` — set to the very object put in
  `history.present` by the load effect (`startHistory(...)`, incl. the shared
  `EMPTY_LAYER`) and to `history.present` when a save is *started* (not when it
  succeeds: today a failed save is not retried);
- `restamp = useRef<{ from: Fingerprint | null } | null>` — set by
  `beforeReload` to the fingerprint of the file being replaced. Compare by
  **object identity** (`fingerprint !== restamp.from`), as today: a Reload of
  an unchanged file still produces a new object; value comparison would never
  end the reload and would mute the stale check for good;
- the save effect (one, replacing the two): `if (!loaded || !key || !fingerprint) return;`
  `const arrived = restamp && fingerprint !== restamp.from;` if `arrived`:
  clear `restamp`, `setChanged(false)`; write when `arrived || history.present !== persisted.current`.
- **Effect order is load-bearing**: the stale-check effect is declared before
  the save effect and must keep running first, while `restamp` is still set
  (that is what mutes it in the very commit that delivers the new fingerprint).
  Keep their order and the "stale check muted while `restamp` is set" rule; do
  not merge them.
- The stale check's fake `StoredLayer` goes: add `fingerprintChanged(a, b)` to
  `store.ts` and have `stale(stored, current)` call it. **Do not change
  `stale`'s signature** (`MobileMarkup.test.ts` and `MarkupView.tsx` call it).
- `fileMtime(..)` failing after a reload (the `() => {}` catch), or `docSize`
  being `null`, leaves `restamp` set and the stale check muted until the next
  successful read: separate commit **C3** — clear `restamp` in the catch (no
  restamp, the record keeps its old stamp), with a regression test (decision 1).
- Layer switching between keys: `loaded` gates the save effect, the load effect
  sets `persisted` together with `setHistory`/`setLoadedKey` in one batch; keep
  that.

**C2 — phone (`MarkupView.tsx`)**: the phone's save effect is *not* the
desktop's. It depends on `[loaded, canLayer, key, history.present, history.past,
fingerprint]` and saves on a change of any of them (a Reload's new fingerprint
or key, a `past`-only change), and `skipSave` guards only the first run after a
stored layer was read (the null/unavailable branches do not set it). So the
"last handled" ref must be a tuple `{ key, layer, past, fingerprint }` set by
the load effect **only in the stored-record branch**, with the *current*
fingerprint (not the stored one: that would stamp a stale record, which the
comment above the effect forbids), and the effect writes when any member
differs. `movedTo` (the Reload that moves the layer to a new key) stays and
must still write to the new key. If this cannot be made to pass the C0 phone
cases unchanged, **leave the phone as it is** (one ref) and say so in the
handoff.

Tests: C0's, plus all `MobileMarkup*` storage tests unchanged.

### E. Hot paths

1. **Committed-marks cache for every gesture** (`PdfMarkupLayer.tsx`
   `paintCommitted`): today it covers `preview` / `area` / `loop`; a select
   move/resize and the eraser go through `edit.scratch` and repaint every mark
   per pointer move. The cache must keep the painting order (decision 8:
   overlapping, see-through marks), so it cannot be "all unselected marks, then
   the moving ones": cache **`sent` plus the unchanged prefix of `page.marks`**
   (the marks below the first one the gesture changes — for a move/resize
   `min(selection.indices)`; a prefix is identical object for object to
   `edit.base`'s page) and redraw only the rest per move. The cache is
   rebuilt (never patched) when the prefix shrinks (an eraser reaching a lower
   mark) or the size changes; dropped at gesture end so nothing holds a second
   backing store at rest. The gesture signal is `edit.layer !== edit.base`
   (both exist in `MarkupEdit`) as well as the current preview/area/loop test.
   If the eraser cannot be done simply this way, ship move/resize only and say
   so. The phone's `LayerCanvas` (`MarkupView.tsx`) has no cache: port it, with
   a `gesturing` prop for the one page being drawn on (preview or scratch);
   other pages keep their page objects and need no cache. Same drop-at-end
   rule (Safari counts canvas memory).
   Tests: `PdfMarkupLayer.test.tsx` — pixel-identical output (compare the
   canvas ops/`toDataURL` with and without the cache for a move over
   overlapping highlighter and pen marks), and a drop at gesture end.
2. **Styled/snapped stroke preview** (`PdfMarkupLayer.tsx` and
   `MarkupView.tsx`: the four `points.slice()` previews): stop copying
   `points` where the previewed mark is not kept — confirm the commit path
   (pointer up, snap) builds its own mark and never stores the preview's.
   That is all: no incremental drawing of dashed, arrowed or see-through
   strokes (dash phase and alpha overlap would differ from the whole path).
3. **Eraser culling** (`layer.ts` `touches` / `cutStroke` / `eraseMarks`):
   a `WeakMap<Mark, box>` of `markBox(mark)` (it already includes half the
   stroke width and an arrow's head) rejects, before the per-segment test, a
   mark whose box grown by `radius` misses `(x, y)`; same for
   `cutStrokeByRect` against `rect`. `markBox` for ink allocates per call:
   that is what the cache saves. **`within()`**: do not "compare the growth"
   (a layer already over a ceiling would then behave differently); compare
   the absolute totals, with `markCount`-style counts cached per immutable
   `pages` record and derived from the previous record's count when
   `withPage` builds the next (count − old page + new page), so `eraseAlong`'s
   up-to-500 steps stop recounting every page; `eraseSent`'s `SENT_LIMITS`
   check likewise. Fold the try-cuts-then-whole skeleton of `eraseAt` and
   `eraseRect` into `eraseThrough(layer, n, erase, sent)` with
   `erase(marks, force)` — for `eraseAt` bake the option in
   (`eraseMarks(.., whole || force)`), for `eraseRect` `erase(marks, force)` is
   the existing closure — so the page pass, the whole-stroke retry and the
   sent pass keep today's arguments exactly.
   Tests: `PdfMarkupTools.test.ts` / `MobileMarkup.test.ts` erase cases
   unchanged, plus a differential test (culled vs. an unculled reference on
   random strokes/radii) and an over-the-ceiling case.
4. **Page text once per document** (`pageText.ts` `pageTextItemBoxes`): a
   `WeakMap<PDFDocumentProxy, Map<string, Promise<TextItemBox[]>>>` keyed
   `` `${page}:${rot}` `` (the function takes `rot`; `useSearchText` passes
   one), same signature, a rejected promise evicted as `useSearchText`'s own
   cache does. Callers that gain: `usePdfMarkup.wantText`,
   `PdfMarkupQuestions` (`useQuestionPins`' texts), `markupPagePicture`.
   Safe because: a reload makes a new `PDFDocumentProxy` (check with
   `rg getDocument src/components/embed/pdf/pdfDoc.ts` that no path reuses a
   proxy for new bytes), and no caller mutates the arrays or boxes (checked:
   `visibleRuns` filters, `anchorsFor` copies before sorting, `findQuote` reads;
   the implementer re-greps before landing). Leave `useSearchText`'s own cache
   in place: `PdfSearchEfficiency.test.tsx` mocks `pageText` and counts through
   it. In `markupPage.ts` start the text read before `drawPage` **and attach a
   no-op catch to it** (a draw that throws before the read is awaited would
   otherwise leave an unhandled rejection), then await it inside the existing
   `try`.
5. **Submit pipelines its pages**:
   - desktop `submit` (`usePdfMarkup.ts`): overlap the `blobBase64` of page n
     with `markupPagePicture` of page n+1, at most two pages in flight; the
     request body keeps page order and `words[n]` is still set in order. A
     rejection must not leave the other promise unhandled: settle both, report
     the earliest page's error (same `sendFailed` text). The picture branch
     (one page) stays as is.
   - phone `submit` (`MarkupView.tsx`): post the frame's `text` request together
     with the `snapshot` request (today `text` is asked only if the snapshot
     answered; both then time out together, not one after the other), and
     overlap the upload of page n with the snapshot of page n+1. On a failure
     of page n's upload, the already-asked page n+1 frame call must still be
     awaited and its bitmap closed (`shot.bitmap.close()`); the failure shown
     is the earliest page's; `frameUp` still drops to false after one silent
     frame. `setSending(sendingPage)` follows the page being worked on.
   - `visibleText.ts` `inked`: hoist the three `Uint32Array(256)` buffers
     (`fill(0)` per call) and replace `Math.max(...count)` with a loop that
     keeps the **first** index of the maximum (`indexOf` semantics).
   Tests: `PdfMarkupSubmit`, `ImageMarkupSubmit`, `MobileMarkupView` Submit
   cases unchanged; add an upload failing on page 2 of 3 on the phone, and a
   draw failing on the desktop's page 2.

Not in this run: memoizing `edit` / `PdfPageCanvas` (`markup_improvement_plan.md`
§3's last point; it would touch the file the split moved) and mounting
`PdfMarkupLayer` on near pages only (already done: `PdfPageCanvas.tsx` gates it
on `near`).

### F. Phone sealed-frame hooks

`MarkupView.tsx` (2,657 lines; ~32 `isPdf` mentions): the sealed PDF frame code
sits in "The sealed frame (PDF only)" (`post`, `renderFailed`, `openIfReady`,
`askFrame`, the byte fetch with `STALL_TIMEOUT` / `OPEN_TIMEOUT`, the message
listener, the render queue with `RENDER_TIMEOUT`, the `findText` effect).

- **One hook cannot stand where the code stood**: `sizes` (set by the message
  listener) feeds `places` → `near` → `alive`, which feed the render-queue
  effect. Split in two in `mobile-web/src/markup/`:
  - `useSealedPdfFrame({ isPdf, url, size, generation, frame, reopening,
    setReopening })` — called where the `sizes` / `pictures` / `failure` /
    `pageFailures` / `download` state is declared (before `places`); owns that
    state, the frame refs (`frameReady`, `opened`, `bytes`, `pageCount`,
    `awaitingMeta`, `inFlight`, `renderTimer`, `frameCalls`, `frameCallId`),
    the byte fetch and the message listener; returns `{ sizes, pictures,
    pageFailures, download, failure, setFailure, post, askFrame, nextCallId,
    renderFailed, ready(), restart(), … }`. `restart()` is the frame part of
    `reload` (the refs and states `reload` resets today: `frameReady`,
    `opened`, `inFlight`, `bytes`, `pageCount`, `awaitingMeta`, pictures'
    bitmaps closed, page failures, find caches, `setFound({})`, `setFailure(null)`)
    — `reload` calls it; the plan must not leave those resets behind.
  - `useFrameRenderQueue({ sealed, alive, pixelWidth, asks, … })` — the render
    queue and the `findText` effect (they need `alive`, `pixelWidth`, `asks`),
    called exactly where the "sealed frame" block stands now, so those two
    effects keep their place in the declaration order.
- The fetch effect and the message listener move earlier than the layer
  load/save effects; they share no state with them (the C0/C2 work does not
  touch them). The `generation` cleanup effect (settling pending `askFrame`
  calls) moves with `askFrame`.
- Drop the `isPdf` guards that become redundant; inert for a picture.
- Tests: `MobilePdfFrame.test.ts`, `MobileMarkupView.test.tsx` (download
  progress, stall, Reload) unchanged.

### G. Small structure

- (Impl 2, with E1 in the same file) `PdfMarkupLayer.tsx`: `MarkupNoteEditor`
  and `MarkupCommentEditor` share one `MarkupCard` shell (card, Escape/Enter
  handling, actions row); `dashedRect` / `dashedLoop` become one
  `dashedStroke(ctx, dpr, trace)`.
- `usePdfMarkup.ts` returns `picture` (a boolean: the hook's `picture` option
  is `shown` in `ImageView.tsx`, null until the image has loaded — confirm
  `shown` and `natural` are set in the same load handler, else give the hook a
  separate `isPicture` option); `PdfMarkupAgentPanel` and `PdfMarkupDock`
  read it, and `PdfMarkupMore` (in `PdfMarkupBar.tsx`) via the dock, instead
  of the `picture` prop `ImageView.tsx` passes by hand.
- The "join ids with `\n`, split again" stable-list idiom
  (`usePdfMarkup.ts` idle ids and tick ids, `PdfMarkupQuestions.tsx`
  `useQuestionPins`): one `useStableList(list)` in `src/hooks/`.
- The OpenCode grouping helper (decision 3): a pure
  `isOpenCodeModelList(agentLabel, stepTitle)` next to `groupOpenCodeModels`
  in `mobile-web/src/terminal/openCodeModelGroups.ts`, used by the four sites
  (`SteeringPromptOverlay.tsx` already has `ownCursor`; it keeps that for its
  other uses). `PdfMarkupModel.tsx` keeps rendering its own list but no longer
  decides. Tests: `PdfMarkupModel.test.tsx` plus the existing reader/phone
  picker tests unchanged.
- Optional, last in G, skip if the agent is long: the queue-then-hold pair
  (`queuePromptForTab` + `holdPhonePrompt`) is written in `usePdfMarkup.ts`'s
  `deliver` and twice in `MobileBridgeHost.tsx` (`holdTabPrompt`,
  `answerMarkupFromPhone`; the third `holdPhonePrompt` there, in
  `editHeldTabPrompt`, is a different case — leave it). One
  `queueHeldPrompt(projectId, targetId, prompt, options)` in
  `src/lib/agents/phoneHolds.ts`; each caller keeps its own bookkeeping
  (`noteInputFrom`, `agentTabStateOf` for `queued`, the reopen-on-failure).

### H. Host wiring in PdfViewer and ImageView (held: decision 4)

- `useMarkupHost({ markup, tabKey, name, reload, onEnter, … })` in
  `src/components/embed/pdf/`, returning `{ marking, enter, leave,
  onDiskChange(reload, { dirty }), onKey(e), onKeyUp(e), toggleProps }`:
  the claim/release (`useSyncExternalStore(subscribeMarkupClaims)` +
  `markupGate`), the "end the mode when not allowed" effect,
  `usePdfMarkupLink`, enter/leave/`reloadUnderMarks`, the `diskChangeAction`
  dispatch, the Ctrl+Z / Ctrl+Y / Escape cascade (beside `markupStripKey`)
  and the toggle's title. `markupGate`'s `pristine`/`dirty` become optional
  (`ImageView` passes constants today). One `isTextEntry` for both hosts
  (leave `lib/shortcuts/steeringRegion.ts`'s differently-typed copy).
- Differences that stay explicit options: `ImageView.tsx`'s
  `if (!m?.holdsReload) return reload()`; `PdfViewer.tsx` `enter` also closes
  redact and the rail, `ImageView` focuses its viewport (`onEnter`);
  `PdfViewer`'s `reloadUnderMarks` also calls `seedMtime` and bumps
  `diskVersion`, `leave` re-reads through `setDiskVersion`; `diskChangeAction`'s
  `"stale"` result is `PdfViewer`-only.
- **Circular input in `ImageView`**: `reload` comes from `useBlobUrl(..,
  diskChanged)`, and `diskChanged` comes from the hook — pass `reload` through
  a ref-backed thunk (`() => reloadRef.current()`), as `markupRef` is used
  today.
- Run after reading `docs/pdf_viewer_split_plan.md`'s status; rebase on
  `develop`'s tip, since the split session keeps moving `PdfViewer.tsx`.
- Tests: `PdfMarkupViewer.test.tsx` (gate, claim, the three disk-change paths),
  `ImageMarkupSubmit.test.tsx`, `PdfSleepHidden` / `TexWorkspace` unchanged.

## Agent steps

| Agent | Plan steps (in this order) | Main files |
|---|---|---|
| Impl 1 — rounds and storage | A, B, D, then C (C0 tests, C1, C2, C3) | `usePdfMarkup.ts`, `MarkupView.tsx`, `submitState.ts`, `store.ts`, `markupQuestionPicks.ts`, `PdfMarkupQuestions.tsx`, `MarkupQuestionsCard.tsx`, tests |
| Impl 2 — hot paths | E1–E5, then G's `PdfMarkupLayer` shells | `PdfMarkupLayer.tsx`, `MarkupView.tsx` (`LayerCanvas`, Submit), `layer.ts`, `pageText.ts`, `markupPage.ts`, `visibleText.ts`, `usePdfMarkup.ts` (Submit) |
| Impl 3 — structure | F, then the rest of G, then H if decision 4 allows | `MarkupView.tsx`, new `useSealedPdfFrame.ts` / `useFrameRenderQueue`, `PdfMarkupAgentPanel.tsx`, `PdfMarkupDock.tsx`, `PdfMarkupBar.tsx`, the four OpenCode sites, `ImageView.tsx`, `PdfViewer.tsx` |

Each plan step is its own commit (E may be one commit per numbered point).
Why this split: C is the risky step and gets an agent whose other work is
small and ordered before it; G's `PdfMarkupLayer` items share a file with E1,
so they ride with Impl 2; F is a day alone in `MarkupView.tsx`.
**Stop rule** for every step: if the stated safety condition (a test that must
pass unchanged, "pixel-identical", "same arguments") does not hold, revert that
step, record it under **Flagged for user**, go on to the next.

## Organisation

Five subagents in all (the user's bound): **plan reviewer → Impl 1 → Impl 2
→ Impl 3 → final reviewer**, strictly one after another. Serial because
`MarkupView.tsx`, `usePdfMarkup.ts` and `layer.ts` run through every agent
step: parallel worktrees would conflict on them. No per-step reviewers: the
steps are refactors under dense tests (`src/__tests__/pdf/PdfMarkup*`,
`src/__tests__/mobile/MobileMarkup*`), so the final reviewer covers the
range.

Each implementer works in its own worktree (`isolation: "worktree"`), which
starts at `origin/main`: run `git reset --hard develop` first, and
`cp -al <main>/node_modules node_modules` (never a symlink: pdf.js tests
silently collect zero). It implements only its agent step, commits each
plan step green (`scripts/gates-job.sh start`, then `status`), and updates
`docs/markup_refactor_handoff.md` (shas, choices, gotchas, gate status with
test counts, **Flagged for user**). It never pushes and never edits
`develop` in the main checkout. Low on context: stop at a green commit,
write the handoff.

The main agent lands each implementer's commits on `develop` before the next
starts (cherry-pick in a scratch worktree, then `update-ref` +
`git checkout <new> -- <paths>` in the main checkout once those paths are
clean there), so each implementer starts from the previous one's work.
**Other sessions have uncommitted edits in the main checkout** (at review
time: `src/lib/i18n/{en,de,es,fr,it}.ts`, `src/lib/untested.ts`,
`docs/filemap_*.md`, `PdfViewer.tsx` and `PdfNoteLayer.tsx` among them), so
those paths are not "clean there": the landing has to be done with the
cherry-pick/`update-ref` at the git level and the dirty paths merged by hand,
not overwritten. To keep that small, implementers (a) add no strings (decision
9), (b) leave `untested.ts` alone, and (c) put the file-map rows for new files
(`docs/filemap_frontend.md`) in **one separate last commit** of their agent,
so the main agent can land it when the map is clean.

The final reviewer reads the whole range: cross-step integration, leftover
dead code, i18n parity, file-map rows for new files, `brand-check`,
`privacy-check`. It fixes confirmed bugs only, each with a regression test;
design objections go under **Flagged for user**.

## Verification

- Gates per step (no Rust is touched), as AGENTS.md says: `scripts/gates-job.sh
  start` (it runs the touched gates: `npm run build`, `npm test`,
  `npm run lint`, `scripts/brand-check.sh`), then `status` on the printed
  directory; `git diff --check`. Zero new lint warnings (do not add a
  dependency just to silence a `react-hooks/exhaustive-deps` one; the existing
  mount-only `eslint-disable` lines stay), no new `any`. Without the RTK hook:
  `npm test -- --reporter=dot`, `npm run build 2>&1 | tail -40`.
- Record shapes in `store.ts` (layer + `fingerprint` + `saved` + `past`) do not
  change; persisted records round-trip.
- The phone bundle is built by `npm run build`; it reaches the app with the
  next dev build. No agent starts or stops the app.
- Live click-through (never run by agents; listed for the user in the final
  report): on the desktop and the phone, mark a PDF (pen, marker, box, text
  mark, stamp, note, comment), move and resize a selection over overlapping
  marks (same look as before while dragging), erase (stroke, partial, area) on
  a page with many marks, Submit, answer a markup question, Make these changes,
  Undo round (the round's ✓ badges go), approve a ✓ group and Approve all (a
  click right as it appears does nothing — on the desktop too), Reload under
  marks (stale strip clears), close and reopen the file (marks come back), the
  OpenCode model chip and the reader's model list.
