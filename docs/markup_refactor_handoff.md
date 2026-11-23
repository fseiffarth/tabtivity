# Markup refactor — handoff

> **Status (screened against code 2026-11-22):** PARTIAL. Impl 1 to 3 are in code (see `docs/markup_refactor_plan.md`); the open items are step H (`useMarkupHost`, absent from `src/`) and `queueHeldPrompt`. Its "Flagged for user" live click-through is still owed. Never run live.

Plan: `docs/markup_refactor_plan.md`. Base: `develop` at `70df7dc10` and later.
Each agent appends its section; nothing above it is rewritten.

## Plan review

Reviewer #1, 2026-11-14, against the code on `develop` (`fe629c117`) and the
main checkout's working tree. Only the plan changed; decisions 1–9 are
untouched (three clarifications were added under them, restating, not
reversing). What changed, and why:

- **Names/paths.** `PdfMarkupStorage*` / `PdfMarkupReload*` do not exist — the
  desktop load/save/restamp protocol has no test at all; the plan now lists the
  real test files. `PdfMarkupMore` lives in `PdfMarkupBar.tsx`. `TICK_REPEAT_MS`
  is phone-only. `MarkupView.tsx` is 2,657 lines. H's "mount `PdfMarkupLayer`
  on near pages only" is already done (`PdfPageCanvas.tsx` gates on `near`) —
  dropped; §3's other point (memoize `edit`) is explicitly out of scope.
- **A.** Reading `round.undo.logId` after the `await` is unsound: `followRound`
  or a newer Submit replaces the round while the old `undoRounds` map still
  answered. The preview/sheet now carries `logId`. One race outcome differs
  (forgets the undone round's ticks) and is to be recorded.
- **B.** The reason is a worded string, not a key: the phone's `reason()` has a
  `mobile.markup.reason.other` fallback.
- **C.** Added C0 (characterization tests first, since none exist), made the
  `persisted` design precise: identity comparison of fingerprints (value
  comparison would never end a reload of an unchanged file), `persisted` set when
  a save *starts*, effect order (stale check before the save effect, muted while
  the restamp request is set), and do not change `stale()`'s signature. The
  phone's save effect is different (deps include `fingerprint`, `key`,
  `history.past`; `skipSave` only in the stored-record branch; `movedTo` moves
  the layer between keys), so a layer-only ref is unsound there: tuple ref, or
  leave the phone alone. The muted-stale-check-after-failed-read fix is C3.
  C runs last in Impl 1.
- **D.** The desktop guard cannot live in the pure `PdfTickBadges` (remounts
  with the near pages); it lives in `usePdfMarkup`'s `ticks.approve` /
  `approveAll`. Existing `PdfMarkupTicks.test.tsx` cases click at once and need
  a clock skew (deliberate test edit). Approve all included (my reading of
  decision 2); the 350 ms repeat window stays phone-only.
- **E1.** "Cache the unselected marks, draw the moving ones over" changes paint
  order (overlapping/see-through marks), violating decision 8. Replaced by
  "cache `sent` + the unchanged prefix of `page.marks`". **E2** cut to copy
  removal only (incremental drawing of dashed/see-through strokes is not
  pixel-identical). **E3**: "compare the growth" in `within()` is not
  equivalent (a layer already over a ceiling); absolute totals with cached
  counts; the `eraseThrough` signature is spelled out. **E4**: cache key needs
  `rot`; keep `useSearchText`'s own cache (`PdfSearchEfficiency.test.tsx` mocks
  `pageText`); no-op catch when the text read starts before `drawPage`; checked
  no caller mutates the result. **E5**: error/unhandled-rejection and bitmap
  close rules for the pipelines; `inked` must keep `indexOf` (first max).
- **F.** A single hook cannot stand where the code stood (`sizes` → `places` →
  `alive` → render queue is circular), and `reload` resets frame refs/state:
  split into `useSealedPdfFrame` (+ `restart()`) and `useFrameRenderQueue`.
- **G.** Layer shells moved to Impl 2 (same file as E1). `picture` is null until
  the image loads — verify before turning it into a boolean. Added the optional
  queue-and-hold helper for `usePdfMarkup.deliver` + two `MobileBridgeHost`
  sites. Helper location for decision 3 named.
- **H.** `ImageView` has a circular input (`reload` ← `useBlobUrl` ← hook); host
  differences listed. Decision 4's "exists" test sharpened (Phase 1's files are
  untracked in the main checkout now).
- **Organisation.** Step order in Impl 1 is A, B, D, C. Per-step stop rule.
  Other sessions have uncommitted edits in i18n, `untested.ts`, the file maps,
  `PdfViewer.tsx`: landing must be at git level; file-map rows go in one last
  commit per agent. Gates line follows AGENTS.md (`gates-job.sh`).
- **Not changed (checked, fine):** no Rust, no new commands, no strings, no
  brand/privacy exposure; commits in a linked worktree do not queue dev builds.

## Impl 1 — rounds and storage (A, B, C, D)

Branch `worktree-agent-ae3ed2a7a563f1116`, worktree
`.claude/worktrees/agent-ae3ed2a7a563f1116`,
based on `develop` at `fe629c117`. Seven commits, oldest first, each green
through `scripts/gates-job.sh` (build, lint, brand, whitespace, `vitest --changed`):

| sha | step | what |
|---|---|---|
| `3f16e2293` | A | `RoundUndo` carries `logId`; `undoRounds` maps gone on both hosts; preview/sheet carries `logId` |
| `933d77569` | B | `undoFailureNote(failure, step, reason, t)` in `submitState.ts`; both hosts use it |
| `e161ed884` | D | `arrivalGuard()` in `markupQuestionPicks.ts`; both question cards, phone badges, desktop badges + Approve all |
| `07bc6140c` | C0 | characterization tests: new `PdfMarkupStorage.test.tsx` (7 cases), 3 phone cases + 1 past-only case in `MobileMarkupRounds.test.tsx` |
| `4cd233a4b` | C1 | desktop `persisted` / `restamp` refs replace `skipSave` / `pendingSave` / `reloadingRef`; one save effect; `fingerprintChanged` in `store.ts` |
| `6b328bbaa` | C2 | phone `handled` tuple ref replaces `skipSave` (done, not left alone: the C0 phone cases pass unchanged) |
| `e7189d647` | C3 | bug fix + regression test: a failed `file_mtime` after Reload clears `restamp` |

No file-map rows were needed (no new source file; the only new file is a test),
so there is no separate file-map commit. No strings, no Rust, no i18n/`untested.ts` edits.

### Choices and differences to know about

- **A.** One recorded behaviour difference (as the plan said): an Undo answered
  after a newer Submit (or `followRound`) replaced the round now forgets the
  undone round's ticks; before, the cleared map skipped the forget. Pinned by a
  new desktop test in `PdfMarkupTicks.test.tsx` (deferred `pdf_markup_undo`, a
  second Submit in between). The existing "forgets an undone apply round" cases
  on both hosts already covered the plain path; I did not add a phone race test.
- **B.** `undoFailureNote` returns `{ text, alert: true, gone }`. The host words
  `reason` itself (desktop `markupReasonKey`, phone `reason()` fallback). Unit
  test in `MobileMarkupRoundsCore.test.ts`; the host "refused" cases pass unchanged.
- **D.** One `newest` stamp serves card (`arrive`) and badges (`see`); `settlingFor`
  keeps the phone's rule (unseen key refuses, max of the group's stamps, `null` =
  newest of all, empty group never settles). The desktop guard is in
  `usePdfMarkup` (layout effect over `tickBadgesByPage(sentOnly, tickedGroups)`);
  `approve` / `approveAll` return while settling. `TICK_REPEAT_MS` stays
  phone-only. `PdfMarkupTicks.test.tsx` got a clock skew (`settle()`) in the four
  cases that click at once, plus a new "first moment" case; `arrivalGuard` has
  pure tests in `MobileMarkupTicksCore.test.ts`.
- **C1.** Matches the plan: `persisted` set to `startHistory(..).present` in the
  load effect and when a save *starts*; `restamp` compared by identity; stale
  check still declared first and muted while `restamp` is set. Small, harmless
  difference: a change made before the fingerprint is read and then undone back
  to the persisted object before it arrives is no longer saved (the stored record
  already equals it).
- **C2.** Tuple `{key, layer, past, fingerprint}` set in the stored-record branch
  only, with the *current* fingerprint. Note `forgetRoundInHistory` always builds a
  new `past` array, so the phone saves after every Undo, as before.
- **C3.** Only the `file_mtime` rejection clears `restamp`, and only if that read
  was the one started while the same `restamp` was armed. The `docSize === null`
  case is left as is (a later docVersion read still ends it).

### Gotchas

- `gates-job.sh start` reuses a *failed* result for an unchanged tree; use
  `start --fresh` to rerun.
- `vitest --changed` runs the whole suite when `store.ts` changes. Under load
  (other agents running) one to three unrelated timing tests flaked per run
  (`PdfZoomRaster` "re-arms the commit on every tick", `BibCards` windowing,
  `Autocomplete`, `TerminalAiSwitch`); each passed alone and none touches markup.
  C1 was committed on that basis after the fresh rerun also showed only such flakes.
- Bash in this sandbox refuses compound commands in a worktree; use plain separate commands.

### Gate status

Final tree (`e7189d647`): `scripts/gates-job.sh start` all passed: brand, whitespace,
lint (no new warnings), build (tsc + bundles), vitest. Full-suite counts seen on the
passing C2 run: 906 files, 9,703 tests (one unrelated flake in that run, passing alone);
the last (C3) run ran `--changed` and passed. New/changed test counts: `PdfMarkupStorage` 8,
`PdfMarkupTicks` 12, `MobileMarkupRounds` 31, `MobileMarkup*` 189 in total, all passing.
No Rust touched, so no cargo gates. Not run live; the app was never started.

## Impl 2 — hot paths (E)

Branch `worktree-agent-a9a689eed3296b938`, worktree
`.claude/worktrees/agent-a9a689eed3296b938`,
based on `develop` at `ab90eabd9` (Impl 1's end). Six commits, oldest first, each green
through `scripts/gates-job.sh` (brand, whitespace, lint, build, `vitest --changed`):

| sha | step | what |
|---|---|---|
| `ecb0fff69` | E1 | `CommittedMarks` (in `rasterize.ts`): a move, resize or erase repaints over a copy of the sent marks + the unchanged prefix of `page.marks`; desktop `PdfMarkupLayer` and phone `LayerCanvas` |
| `97d221663` | E2 | the four styled/snapped stroke previews no longer `points.slice()` |
| `c96d871a0` | E3 | eraser culling by cached `markBox`, counts cached per page / per `pages` record, `eraseThrough` |
| `304369bd4` | E4 | `pageTextItemBoxes` caches per document, page and turn; `markupPagePicture` starts the read before drawing |
| `b09464c3a` | E5 | Submit pipelines (desktop encode/draw, phone frame snapshot+text together and upload/next-page overlap), `visibleText.inked` buffers |
| `bb9a670d6` | G shells | `MarkupCard` shell for the note and comment editors; `dashedStroke` for `dashedRect` / `dashedLoop` |

No new source file (new files are tests only), so no file-map commit.

### Choices and differences to know about

- **E1.** The cache class lives in `mobile-web/src/markup/rasterize.ts` so both hosts share it
  (`drawPage` got optional `from`/`to`). A page repaints from the copy when a preview/area/loop is
  up **or** `page !== basePage || sent !== baseSent` (per page, not `edit.layer !== edit.base`, so
  the other pages of a scratch layer build no copy). The prefix is the common identity prefix of the
  gesture's page with the base page; the copy is valid while `page.marks` still starts with the marks
  it drew, else it is rebuilt at the new prefix (never patched). With prefix 0 and no sent marks no
  copy is made. **Gotcha found by a test:** a commit makes the scratch layer the new base, so
  `page` keeps its identity and the paint effect does not rerun: a separate effect on the boolean
  `repainting` drops the copy at gesture end (both hosts). The eraser is included (no "move/resize
  only" fallback needed). Tests: `MobileMarkupCommitted.test.ts` (op-for-op differential against
  `paintLayer`, saves/restores/scales filtered since a split page wraps twice; rebuild on a
  shrinking prefix; no copy at prefix 0) and two component cases in `PdfMarkupLayer.test.tsx`
  (move and eraser; copy back to width 0 after).
- **E2.** `edit.add`/snap build their own marks (`finishStroke`, `snapStroke`), so the preview shows
  the growing mark itself (`shaped(g.mark)`; `straightenStroke` copies or returns the mark). No
  incremental drawing. Test: dashed stroke previewed whole per move, committed stroke finished.
- **E3.** Culling is inside `touches` / `cutStroke` / `cutStrokeByRect` (not their callers) with a
  1e-6 slack, so only a mark clearly out of reach is skipped. `within()` is absolute totals;
  `countPages` caches per `PageLayer` and per `pages` record, `replacePage` (used by `withPage` and
  `eraseSent`) derives the next record's count. `markCount(layer)` now answers from the cache (returns
  a fresh object). `eraseThrough(layer, n, erase(marks, force), sent)` folds `eraseAt` / `eraseRect`
  with their arguments unchanged. Tests: `MobileMarkupEraseCull.test.ts` (seeded differential of
  `touches` / `cutStroke` / `cutStrokeByRect` against plain geometry, counts equal a recount through
  random erase/move chains, a layer over the ceiling takes whole strokes); the old erase cases pass
  unchanged. This caches by object identity: a test or caller that mutates a layer in place would
  see stale counts/boxes (nothing in `src/` or `mobile-web/src` does; checked).
- **E4.** Cache keyed `${page}:${rot}`, failed reads evicted by identity. `useSearchText` keeps its
  own cache. Re-grepped callers: `anchorsFor` copies before sorting, `visibleRuns` filters,
  `findQuote` reads, `textMarks` reads; `getDocument` is only in `pdfLoad.ts` (new proxy per load).
  The no-op `.catch` the plan asks for is redundant (the cache's own eviction `.catch` already marks
  the promise handled) but kept as the plan says. `PdfPageText.test.ts` (4 cache cases + one
  markupPage case).
- **E5.** Desktop: `encoded[]` promises, `await encoded[i-2]` before drawing page i (two in flight),
  `Promise.allSettled` after the loop: earliest rejected encode wins over a later draw error; request
  order is page order. Phone: `askPage(n)` posts snapshot and text together (the frame serves them in
  order; the 20 s timers now both start at post, as the plan accepted); text is discarded when the
  snapshot itself timed out (as before, when it was not asked); page n+1 is asked right after page n's
  upload starts; page n+1's results are processed (bitmap closed) **before** page n's upload is
  judged, so the earliest page's failure shows and no bitmap leaks; `frameUp` drops after one silent
  frame as before; `setSending` follows the page being worked on. One visible consequence: after an
  upload failure on page n the frame has already been asked for page n+1 (tested). `inked`: shared
  count buffers, `fill(0)` per call, `commonest()` keeps the first max; a randomised differential
  against the original in `MobileMarkupVisibleText.test.ts`. Tests: desktop out-of-order
  pages and a draw failing on page 2 in `PdfMarkupSubmit.test.tsx` (its `beforeEach` now
  `mockReset`s `markupPagePicture` back to the real one), phone upload failing on page 2 of 3 in
  `MobileMarkupRounds.test.tsx`. Not done: nothing skipped in E5.
- **G shells.** `dashedStroke(ctx, dpr, stroke, join?)` takes the whole stroking closure
  (`strokeRect` for the rectangle, path+`stroke` for the loop), so the op sequence is identical;
  `lineJoin` is set only for the loop (the rectangle never had it). Golden op-for-op tests for both
  were written first and pass before and after. `MarkupCard` owns the wrapper, the keys and the
  actions row; the textareas, colours and buttons stay in the two editors. Characterisation tests
  for both cards' Enter/Escape/stop-propagation added (there were none).

### Gotchas

- This sandbox refuses a Bash call that chains `python3 - <<EOF` with another command, or two git
  forms; run them as separate calls (script files in the scratchpad worked).
- The machine was at load 60–80: a full `gates-job` took 8 to 25 minutes (lint alone up to 10).
  Flakes seen: `PdfZoomRaster` "re-arms the commit on every tick" (E1, E4), `TerminalAiSwitch`
  "refused while AI is off" (E1, E2, G); each passed alone, none touches markup.
- `gates-job.sh start` reuses a failed result for an unchanged tree: `--fresh` after a fix.

### Gate status

Final tree (`bb9a670d6`): brand, whitespace, lint (30 warnings, 0 errors, the same count as the base),
build (tsc + bundles) all PASS; vitest `--changed` 1089 passed + 1 known flake (`TerminalAiSwitch`,
passes alone). Per-commit vitest totals: E1 2054+2 flakes (alone: pass), E2 1923+1, E3 pass, E4 1284+1,
E5 pass, G 1089+1. New test counts: `MobileMarkupCommitted` 3, `MobileMarkupEraseCull` 4,
`PdfPageText` 5, `PdfMarkupLayer` 19 (was 11), `MobileMarkupVisibleText` +1,
`PdfMarkupSubmit` +2, `MobileMarkupRounds` +1. No Rust touched. Not run live; the app was never
started.

## Impl 3 — structure (F, G, H)

Branch `worktree-agent-a782055885b910fb4`, worktree
`.claude/worktrees/agent-a782055885b910fb4`,
based on `develop` at `f191a35c4` (Impl 2's end). Five commits, oldest first:

| sha | step | what |
|---|---|---|
| `18ddef1d3` | F | `useSealedPdfFrame` + `useFrameRenderQueue` in `mobile-web/src/markup/`; `MarkupView` loses ~250 lines |
| `7e885e491` | G picture | `usePdfMarkup` returns `picture`; `PdfMarkupAgentPanel`, `PdfMarkupDock`, `PdfMarkupMore` read it |
| `a17bfc235` | G stable list | `useStableList` in `src/hooks/` at the idle ids, tick ids and `useQuestionPins` (+ 2-case unit test) |
| `a6b0c32c4` | G OpenCode | `isOpenCodeModelList(agentLabel, stepTitle)` at the four sites (+ test) |
| `c498ac6e5` | file map | rows for the three new source files |

**Not done:** G's optional `queueHeldPrompt` (see below) and **H: held, PdfViewer.tsx dirty in
main checkout** (a `diff` of the working file against `develop:src/components/embed/pdf/PdfViewer.tsx`
is ~1,580 lines: the split session's Phase 2 is uncommitted). `git cat-file -e
develop:src/components/embed/pdf/PdfThumb.tsx` succeeds, so Phase 1 itself has landed; only the
dirty tree blocks H. Nothing in `PdfViewer.tsx` or `ImageView`'s host wiring was touched.

### Choices and differences to know about

- **F, the split.** `useSealedPdfFrame({ isPdf, url, size, generation, frame, setReopening })` owns
  the `sizes` / `pictures` / `pageFailures` / `download` / `failure` / `found` / `renderTick` state,
  every frame ref, the byte fetch, the message listener, `askFrame` and its `[generation]`
  settle-effect, and the unmount cleanup of the bitmaps. It returns `sizes, setSizes, pictures,
  setPictures, pageFailures, download, failure, setFailure, found, renderTick, inFlight,
  renderTimer, post, askFrame, nextCallId(), renderFailed, askFind(page, quote), ready(),
  restart()`. `reopening` / `setReopening` stay in the view (Reload sets it; the `meta` message
  clears it through the setter passed in). It is called at the refs block, before the load/save
  effects; `useFrameRenderQueue({ sealed, isPdf, reopening, alive, pixelWidth, asks })` stands where
  the old block stood (render queue effect, then the `findText` effect, in that order).
- **`restart()`** carries everything `reload` reset for the frame: the render timer, `frameReady`,
  `opened`, `inFlight`, `bytes`, `pageCount`, `awaitingMeta`, the pictures (bitmaps closed), page
  failures, the find caches, `found`, and `failure`. `reload` keeps `setChanged`, `setCheck`,
  `setReloaded`, `setReopening(true)`, `setFile`, `setGeneration`.
- **Find state moved into the first hook** behind `askFind(page, quote)` (dedup by `page\nquote`,
  id, post) so `restart()` can clear `findAsked` / `findKeys` without the queue hook's refs; the
  queue hook's effect only loops over the asks and calls it.
- **Kept `isPdf` guards.** The plan said to drop the redundant ones; a picture sets `sizes` from its
  own load handler, so the render-queue effect would otherwise `post` and arm timers at a frame that
  does not exist. The fetch and the message listener keep theirs too (they are the hook's switch).
- **One new lint dependency** (`nextCallId`, stable) in the runs-asked effect of `MarkupView`, since
  the id source is now a callback; no new warnings (lint run, warning count unchanged).
- **`picture`: separate `isPicture` option, not `picture !== null`.** `shown` and `natural` are set in
  the same `onImgLoad`, but `PdfMarkupAgentPanel` is rendered while marking whether or not the
  image has loaded (`marking && markup.panel`, only the dock waits for `natural`): deriving it
  from the element would have shown the PDF wording until the load. `ImageView` passes
  `isPicture: true`; the hook returns it as `picture`. The old `picture` element option is
  unchanged. `ImageMarkupSubmit.test.tsx`'s harness (it plays the host) was updated the same way:
  `isPicture: true`, and no `picture` prop on the panel and the dock.
- **`useStableList(list)`** compares items by `===` and keeps the previous array; it replaces the
  `join("\n")` / `split("\n")` strings (an id with a newline cannot occur). `useQuestionPins`' effect
  now depends on `pageList` (stable) instead of the `wanted` string; its `missing` filter works on
  the numbers directly. The surrounding `eslint-disable` stays.
- **OpenCode.** `isOpenCodeModelList` lives in `openCodeModelGroups.ts` (it now imports
  `isOpenCodeTab` from `openCodeMini.ts`; no cycle). `SteeringPromptOverlay` keeps `ownCursor` for
  its other uses; the phone keeps `tab.kind === "agent"` in front of the call (as `openCode` had).
  The markup chip keeps its own rendering.

### Skipped: `queueHeldPrompt`

Placing it in `src/lib/agents/phoneHolds.ts` breaks the unchanged tests: `PdfMarkupSubmit`,
`ImageMarkupSubmit`, `PdfMarkupTicks`, `PdfMarkupQuestions` and `PdfMarkupDesktopTools` all
`vi.mock("../../lib/agents/phoneHolds", () => ({ holdPhonePrompt }))`, so a new export from that
module is `undefined` under them (and a helper in `agentPrompts.ts` has the same problem with
their `queuePromptForTab` mocks). Doing it means editing five mocks: left for the user to decide.

### Gate status

F (`18ddef1d3`): `gates-job` on the working tree: brand, whitespace, lint, build (tsc + bundles),
`vitest --changed` all PASS. G: gates were run once over F plus the three G commits
(`gates-job.sh start --fresh --base 18ddef1d3`, 15 files changed): the same four PASS. By hand:
`src/__tests__/pdf` 637 passed on the stable-list tree; `MobileOpenCodeMini` + `PdfMarkupModel` 62
passed; `UseStableList` 2 passed. No flakes seen in this agent's runs. No Rust touched. The app was
never started.

### Gotchas

- The sandbox refused `git -C <main>` and heredocs mixed with other commands; to test whether
  `PdfViewer.tsx` is dirty in the main checkout I diffed it against `git show develop:<path>`.
- `gates-job.sh start` on a clean (committed) tree says "no frontend change" and skips every
  gate; use `--base <rev>` to gate commits already made.
- A foreground wait longer than 180 s is moved to the background by the harness; wait on the
  job's `exit-code` file in slices.

## Final review

Reviewer #5, 2026-11-14, worktree
`.claude/worktrees/agent-af7e13c012113d673`
(branch `worktree-agent-af7e13c012113d673`, reset to `58f9337d8`). I read every
old-vs-new diff of the 18 commits in scope (`git diff 716413ff1..58f9337d8`, the
markup files only) and reasoned through the cross-step cases below.

**Result: no confirmed bug, so no fix commit.** The branch has no commit of its own.

Checked and found sound (with the reason, so nobody redoes it):

- **A.** `logId` is read before the `await` into the preview/sheet and `holdsUndo`
  is re-checked after it; no other `RoundUndo` literal exists (`rg`), `followRound`
  and `answerAsk` carry `undo` as a whole.
- **B.** Conflict is tested before the code on both hosts; the desktop words its
  reason eagerly (harmless).
- **C1.** Save effect versus old `skipSave`/`pendingSave`/`reloadingRef`: same
  outcomes for load, first change, change before the fingerprint, Reload with
  and without a changed file, failed save, undo back to an older layer (saves
  it: `persisted` is the last *started* save), key switch (`loaded` gates it,
  `persisted` and `setHistory` are set in one batch). Stale check still runs
  first and is muted by `restamp`. No save loop (`setStoredFingerprint` is not a
  save dependency).
- **C2.** The tuple `{key, layer, past, fingerprint}` set only in the stored-record
  branch gives the old results for Reload to a new key (`movedTo`), a new
  fingerprint, a `past`-only change and a fresh file with no record.
- **C3.** `armed` is the `restamp` object the read was started under; a late or
  cancelled read cannot clear a newer one.
- **D.** The guard sees `history.present.sent`'s mark objects, and the badges and
  `approve` are built from `edit.base` (the same object), so a legitimate click
  is never "unseen" for good; a group that grew or came back arrives anew.
  Approve all uses the newest arrival, as on the phone. Phone rule reproduced
  (empty group never settles, unseen key refuses).
- **E1.** The copy is valid only while `marks` still starts with the marks it
  drew and `sent`, width, height are the same; it is dropped by the
  `repainting` effect on commit, undo and cancel (pointercancel), and by unmount.
  Overlapping/see-through order is kept (copy = sent + prefix, rest drawn over).
- **E2.** The preview shows the live `g.mark` (its `points` are pushed in place),
  but it never enters a layer (`finishStroke`/`snapStroke` build their own), so
  the identity caches of E3 never see it; every `setPreview` makes a new array,
  so the paint effect reruns.
- **E3.** I ran a temporary old-vs-new differential (not committed) on 1,500
  random layers (ink in 5 styles, boxes, text, stamps, sent side, `whole`,
  `highlights`, `eraseAt`/`eraseAlong`/`eraseRect`, a chained second erase, counts
  after each) and a layer at the points ceiling: results `toEqual` the code at
  `716413ff1`. In-place mutation of a counted/boxed object: only `g.mark.points.push`
  (the stroke in hand, never in a layer); the other `pages[...] =` writes are on
  locals built before any count.
- **E4.** All callers of `pageTextItemBoxes` only read the result; failed reads are
  evicted; the text read starts before the draw and carries a no-op catch.
- **E5.** Desktop: two in flight, request in page order, earliest failure wins, no
  unhandled rejection. Phone: both frame calls always resolve (timeout), page
  n+1's bitmap is closed before page n's upload is judged, and no frame call is
  made past a failure, so nothing leaks; `marked` is non-empty (guard at the top).
- **F.** `restart()` carries every reset the old `reload` did (checked line by
  line); the message-listener and fetch effects have the same dependencies plus
  stable ones; the desktop does not import the new hooks.
- **G.** `isOpenCodeModelList(agent, title)` equals the four old conditions
  (`SteeringPromptOverlay`'s `ownCursor` is `isOpenCodeTab(agent)`);
  `useStableList` / `useQuestionPins` effect keys unchanged in meaning;
  `MarkupCard` and `dashedStroke` keep the class names and the op sequence.
- **Hygiene.** No i18n, `untested.ts`, Rust or CSS file touched by the 18 commits (so no
  parity work); file-map rows exist for `useStableList` and (inside the
  `MarkupView` row) the two frame hooks; no leftover `skipSave`, `pendingSave`,
  `reloadingRef`, `undoRounds`, `tickSeen`, `paintCommitted` anywhere;
  `scripts/brand-check.sh` and `scripts/privacy-check.sh` pass.

Gates on the final tree: `npm run lint` PASS (123 s, in the `gates-job` run
over `--base 716413ff1`), `npm run build` PASS (tsc + bundles), `npx vitest run
--changed 716413ff1`: 349 files / 3,648 tests PASS, plus the 29 markup/frame files
(396 tests) run on their own. I stopped the `gates-job` after lint because its range
also selected cargo clippy for other sessions' Rust commits (not markup); no Rust
is touched by the 18 commits.

## Flagged for user

- Impl 1: desktop Approve all / ✓ now refuse a click in the first 1.2 s after a badge
  (new or grown group) appears, as on the phone: tell me if that feels sticky live.
- Impl 1: an Undo answered after a newer Submit now forgets the undone round's ticks
  (previously it kept them). Intended; never run live.
- Impl 1: a failed fingerprint read after a desktop Reload now leaves the record with its
  old stamp and lets the stale strip flag a later changed file (C3); before, a later
  read silently restamped it.
- Impl 2: all of E is "never live". Look for these live: dragging a selection or the eraser over
  overlapping marker/pen marks (same look as before while dragging, nothing left over after the
  drop), Submit of a many-page PDF on the desktop and the phone (pages in order; on the phone an
  upload failure now shows after the next page's frame work, so up to one page later than before).
- Impl 2: the phone asks the frame for a page's picture and words in one go, so both share one 20 s
  timer; a very slow render can now cost the words as well as the picture (marks then go without
  anchors, as for any frame timeout).
- Impl 3: **H is not done** (`useMarkupHost` in `PdfViewer` / `ImageView`): `PdfViewer.tsx` has
  ~1,580 lines of uncommitted split-session edits in the main checkout. Run H once Phase 2 is
  committed, from `develop`'s tip.
- Impl 3: `queueHeldPrompt` skipped: five desktop tests mock `phoneHolds` with only
  `holdPhonePrompt`, so the helper needs those mocks edited (see the Impl 3 section).
- Impl 3: the phone's sealed-frame code now lives in `markup/useSealedPdfFrame.ts` /
  `useFrameRenderQueue.ts`. Look at live: open a PDF (download line, pages appear nearest-first),
  Reload under marks, scroll a long PDF (far pictures let go), a question with a quote (the pin
  finds its words), Submit and Print. Never run live.
- Impl 3: `usePdfMarkup` now returns `picture` and takes `isPicture`; the image viewer's
  panel/dock wording should be as before. `useStableList` replaces the newline-joined id strings
  (idle-ask and tick reads of the other agent tabs; the question pins' page list).
- Final review: no bug found, nothing fixed. Live click-through worth doing first, in
  this order (riskiest first): (1) desktop and phone, drag a selection and the eraser over
  overlapping marker and pen marks, drop it, undo, redo: no ghost marks, the same look
  while dragging; (2) Submit a 3+ page PDF on the phone and on the desktop, and one with
  the network cut mid-way on the phone (the error now shows up to one page later);
  (3) Reload under marks on both hosts (stale strip clears, marks stay, close and reopen
  brings them back); (4) a ✓ badge and Approve all on the desktop: a click within about a
  second of the badge appearing does nothing, later clicks work; (5) Undo round on both
  (the round's ✓ go); (6) phone: open a PDF (download line, nearest pages first),
  scroll a long one, answer a question with a quote (the pin finds its words).
- Final review (design, no change made): `markup/useSealedPdfFrame.ts` and
  `useFrameRenderQueue.ts` live in `mobile-web/src/markup/`, the folder the desktop also
  imports from (decision 7), but they are phone-only and import the phone's `api.ts`: the
  desktop must never import them. A comment or a lint rule would keep it so.
- Final review (minor): `FrameBoxes` in `useSealedPdfFrame.ts` is exported but used only
  inside it; in `usePdfMarkup`, a Reload whose `docSize` is still `null` when the mtime
  read answers leaves `restamp` armed (the Impl 1 note on C3), which keeps the stale strip
  muted until the next read; a change made and undone back to the loaded layer before the
  fingerprint arrives is no longer saved (the record already equals it).

## Main agent — after the review

- The phone-only note is now a header comment in both hooks, and `FrameBoxes` is no longer
  exported (one cleanup commit; build, lint, brand and whitespace checks pass).
- Still open: step H (`useMarkupHost`) waits until `PdfViewer.tsx` is clean on `develop`
  (the split's Phase 2 was uncommitted when the review ended); the main agent does it
  after that, since all five agents are used. `queueHeldPrompt` is skipped (five
  `phoneHolds` test mocks would need the new export).

## Docs sync (2026-11-14)

- The blocker above is gone: the PdfViewer split's phases 2–3 are committed (`59bd44b79`,
  after `716413ff1` for phase 1). H (`useMarkupHost`) is still not done; run it from
  `develop`'s tip, reading `docs/pdf_viewer_split_plan.md`'s status first (`usePdfPrint`,
  `usePdfNotes`, `usePageTransfer` etc. now hold code that used to sit in `PdfCanvas`).
