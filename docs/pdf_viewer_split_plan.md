# PdfViewer split — plan

Simplify `src/components/embed/pdf/PdfViewer.tsx` (5,537 lines on
2026-11-14) by moving its parts into their own files and pulling
`PdfCanvas`'s feature clusters out into hooks, the way `usePdfMarkup.ts` already
was. Behaviour does not change: every step is a move or an extraction, with no
fixes folded in. A bug found on the way goes in its own commit.

Asked for in `docs/code_quality_screen.md` ("[High] `PdfCanvas` is 3,583
lines …") and `docs/markup_improvement_plan.md` ("the two big files carry too
much").

## What is in the file now

| Lines | Part | Size |
|---|---|---|
| 1–191 | imports | 190 |
| 193–470 | constants, `settledFileSize`, zoom-anchor geometry (`ZoomPreview`, `PendingScroll`, `pageAnchorAt`, `anchoredScrollTarget`), `restoredPdfZoom`, `rescaleScrollTarget`, `shouldArmPdfRestoreDeadline`, `isTextEntry`, `META_FIELD_KEYS`, `ANNOT_MODE`, `nextStripId` | 280 |
| 479–591 | `PdfThumb` (rail thumbnail) | 115 |
| 597–1613 | `syncViewports`, `PdfPageCanvas` (one page: lazy raster, links, remarks, SyncTeX geometry, search hits, blackout drag) | 1,015 |
| 1614–1874 | `OutlineRow`, `OutlinePreview`, `OutlinePane` | 260 |
| 1875–4702 | `PdfCanvas` hooks and logic (~68 state, ~46 refs, ~61 callbacks, 45 effects) | 2,830 |
| 4703–5483 | `PdfCanvas` JSX: toolbar ~300, redact/meta/find bars, banners, side panes, page stack | 780 |
| 5485–5537 | `PdfView` (sleep wrapper) | 50 |

### The clusters inside `PdfCanvas`

Every cluster leans on a shared **core**: `path`, `scope`, `doc`,
`sources`/`sourcesRef`, `pages`/`pagesRef`, `scrollRef`, `contentRef`,
`scale`/`scaleRef`, `viewPos`, `paneVisible`, `setError`/`setEditError`,
`diskVersion`. A hook takes the parts of the core it needs as arguments. The core
stays in `PdfCanvas`.

| Cluster | Lines now | Reads from outside | Written from outside | Coupling |
|---|---|---|---|---|
| Open as deck | 1903–1945 | path, scope, tabKey, setError | — | low |
| Present window | 2086–2147 | path, scope, visiblePage, setError | — | low |
| Metadata (#pdf-meta) | 2061–2073, 2149–2172, JSX 5071–5125 | doc | load effect resets `stripMeta`/`meta`; save and print read `stripMeta` | low |
| Outline / contents | 4449–4551 | doc, t, pages, pagesRef, visiblePage, contentRef | — | low |
| Text selection + copy | 2897–2997 | doc, contentRef, scale, viewPos | `highlightSelection` reads `sel` and clears it | low |
| Find (Ctrl+F) | 3070–3080, 3437–3573, 3851–3859, JSX 5126–5180 | pages, sources, paneVisible, redacting, scrollRef, contentRef, scale | `redactAllMatches` reads `matches`; `useSearchText` also feeds redacting | low |
| Go to page / ←→ | 3575–3620 | pagesRef, contentRef, scrollRef, visiblePage(Ref) | — | low |
| Links (#pdf-links) | 3622–3744 | pagesRef, scrollRef, contentRef, sourcesRef, scale, settings, `restoreScroll` (to cancel it) | — | low–med |
| SyncTeX reverse search | 2752–2808, 3861–3946 | path, scope, fileSource, diskVersion, scrollRef, paneVisible | — | low |
| SyncTeX forward reveal | 2810–2895 | doc, pages, diskVersion, loadedDiskVersion, seedMtime, diskChanged | — | med (disk cluster) |
| Arrangement + undo | 1955–1990, 2189–2245 | — | load effect resets everything; silent save calls `setPages` outside history | med |
| Merge / drag pages / spring rail | 3271–3436 | applyEdit, sourcesRef, selection, redactDpi, stripMeta, railOpen, markingRef | — | med |
| Remarks (#pdf-notes) + autosave | 2247–2508, 3017–3068 | doc, pages, pagesRef, sourcesRef, applyEdit, viewPos, stripMeta, staleOnDisk, `sel` | silent save writes `fileNotes`; autosave calls save via `noteSaveRef` | **high** |
| Save + print | 3081–3269 | nearly everything above, lastMtime, diskVersion | — | **high** |
| Markup glue | 2587–2687 | doc, pages, dirty, docBytes, loadedDiskVersion, marking, rail, redacting | — | med–high |
| Disk / load / reload / worker | 2578–2585, 2688–2722, 3948–4193 | — | resets arrangement, meta, stale, errors, docBytes | **high** |
| Zoom / fit / scroll restore / visible page | 2509–2577, 4195–4447, 4553–4701 | — | links and load both reach into `restoreScroll` | **highest** |
| Host keys | 3746–3850 | dispatch over all of the above | — | (falls out) |

## Phases

Each phase is its own commit (or commits) on `develop`, gated before the next
starts. Hooks are **called at the spot the moved code stood**: React runs
effects in declaration order, and some orders here are load-bearing (see
Risks).

### Phase 1 — move components and pure helpers (mechanical)

No logic edits. Only imports change.

| New file | Takes |
|---|---|
| `pdf/PdfThumb.tsx` | `PdfThumb`, `RAIL_THUMB_H` |
| `pdf/PdfPageCanvas.tsx` | `PdfPageCanvas`, `syncViewports`, `PDF_PAGE_RELEASE_MS`, `ANNOT_MODE` (`PdfThumb` imports it from here; `raster.ts` stays free of pdf.js) |
| `pdf/PdfOutlinePane.tsx` | `leafSign`, `OutlineRow`, `OUTLINE_PREVIEW_W`, `OutlinePreview`, `OutlinePane` |
| `pdf/zoomAnchor.ts` | `ZoomPreview`, `PendingScroll`, `pageAnchorAt`, `anchoredScrollTarget`, `restoredPdfZoom`, `rescaleScrollTarget`, `shouldArmPdfRestoreDeadline`, `clampPdfScale`, `PDF_MIN/MAX_SCALE`, `PDF_ZOOM_STEP` |
| `pdf/reloadSettle.ts` | `settledFileSize`, `RELOAD_SETTLE_MS`, `RELOAD_SETTLE_ROUNDS`, `RELOAD_RETRY_MS`, `RELOAD_MAX_RETRIES` |

**Status (2026-11-14):** done, committed as a move-only commit.
`PdfViewer.tsx` went from 5,537 to 3,936 lines. A line-multiset check shows
every original code line is in exactly one of the six files, with only the
new files' header comments added. The split was made by a script that cuts by
content markers and recomputes imports, so it can be re-run on HEAD to build a
pure-move commit if the tree holds other edits.

The module comment carries over to each file. Update the imports in the tests:
`PdfRestoreZoom.test.ts` (→ `zoomAnchor`), `PdfHiddenPages.test.tsx`
(`PDF_PAGE_RELEASE_MS` → `PdfPageCanvas`), `PdfReloadSettle.test.tsx`
(→ `reloadSettle`), and `TexWorkspace.test.tsx:912` (`PdfThumb`). Its
`vi.mock(".../PdfViewer")` at line 53 needs a look: if it stubs something that
moved, the mock has to follow it. Use no re-export shims.

**Result:** about 4,000 lines.

### Phase 2 — low-coupling hooks

Each hook takes plain arguments and returns state and actions. None of them
reaches into another hook's internals.

| Hook / component | From cluster | Notes |
|---|---|---|
| `usePdfPresent({path, scope, visiblePage, onError})` | Present + Open as deck | returns `openPresentWindow`, `openAsDeck`, `makingDeck` |
| `usePdfMetadata(doc)` + `PdfMetaPanel` | Metadata | returns `{open, setOpen, strip, setStrip, meta, fieldLabel, reset}`; the load effect calls `reset()` |
| `usePdfOutline({doc, pages, pagesRef, visiblePage, contentRef})` | Outline | returns `open/setOpen`, `activeOutline`, `derived`, `placeholder`, `currentId`, `jumpToPage` |
| `usePdfTextSelection({doc, contentRef, scale, viewPos})` | Selection + copy | returns `sel`, `clear()`, `copiedNow`, `copyOnSelect`, `setCopyOnSelect` |
| `usePdfFind({pages, sources, paneVisible, redacting, scrollRef, contentRef, scale})` + `PdfFindBar` | Find | returns `pageText` too (redacting shares it), `matches`, `searchByPage`, `searchScrollNonce`, `markerTops`, `open/close`, `goToMatch` |
| `usePageJump({pagesRef, contentRef, scrollRef, visiblePage, visiblePageRef})` | Go to page / ←→ | returns `stepPage` plus the jump box state |
| `usePdfLinks({pagesRef, sourcesRef, scrollRef, contentRef, scale, cancelRestore, onError})` | Links | `cancelRestore` replaces the direct `restoreScroll.current = null` |
| `usePdfReverseSearch({path, scope, remote, diskVersion, scrollRef, paneVisible})` | SyncTeX reverse | returns `syncable`, `notice`, `dismissNotice`, `onSyncClick`, `armable`; owns the `data-sync-armed` listener |

While moving, fold the three copies of the `buildPdf` options
(`emptyMsg`/`sourceClosedMsg`/`redactDpi`/`stripMetadata` at the print, save
and drag-out calls) into one `buildOpts` value.

**Result:** about 3,000 lines.

**Status (2026-11-14):** done, all eight hooks. `usePdfPresent` takes
`setError` rather than an `onError`. `PdfMetaPanel` and `PdfFindBar` were not
split out: their JSX stays in `PdfViewer`. The `buildOpts` fold was not done
either: the three `buildPdf` calls now sit in `usePdfPrint`, `usePageTransfer`
and `handleSave`.

### Phase 3 — the coupled edits

| Hook | From cluster | How the coupling is cut |
|---|---|---|
| `usePageArrangement()` | Arrangement + undo | returns `sources`, `sourcesRef`, `pages`, `pagesRef`, `applyEdit`, `undo`, `redo`, `reset(src, pages)` (load), `replaceSilently(fn)` (silent save), `addSource(id, src)` (merge) |
| `usePageTransfer({arrangement, selection, buildOpts, rail, markingRef, onError})` | Merge / drag / spring rail | owns `railOpen`, `railAutoOpenedRef` and the `subscribePageDragActive` effect |
| `usePdfNotes({doc, arrangement, viewPos, autosaveGate, saveRef})` | Remarks + autosave + `highlightSelection` | exposes `adoptWritten(written)` for the silent save. The notes ↔ save cycle stays a ref (`saveRef`), as it is now. The render-time reset on `doc` change stays render-time inside the hook |
| `usePdfSave(...)` / `usePdfPrint(...)` | Save + print | the save keeps its order of `lastMtime`/stale checks unchanged |

**Result:** about 2,300 lines. What remains in `PdfCanvas` is the core state,
markup glue, disk and load, zoom and scroll, the host-key dispatch, and the
JSX.

**Status (2026-11-14):** `usePdfNotes`, `usePdfPrint` and `usePageTransfer`
are done; `PdfViewer.tsx` is at 2,695 lines. Two hooks were deliberately not
made:
- `usePageArrangement`: the load effect resets `sources`, `pages`, `past`
  and `future` together, and the silent save sets `pages` outside the
  history. A hook would have to hand every setter back, which moves the state
  without hiding any of it.
- `usePdfSave`: `handleSave` reads about fifteen values from every cluster.

Both stay in `PdfCanvas` as its core. The notes hook returns `writing`, the
guard both saves share, and `noteSaveRef`, as the plan expected.

Hooks receive refs and `useState` setters as parameters. The hooks lint rule
cannot see those as stable, so they are listed in the dependency arrays. That
is behaviour-neutral, because their identities never change. Lint shows the one
warning HEAD already had (the load effect's `viewPos.initial`).

### Phase 4 — document load and viewport (optional; recommended: not now)

`usePdfDocument` (load, reload, retry, poll, compile hold, forward reveal,
worker and cost registry) and `usePdfViewport` (scale, zoom preview, fit, page
sizes, restore, visible page, scroll persist, wheel). These two share
`restoreScroll`, `restoreScale`, `reloadKeepZoom`, `loadedPath` and
`didInitialLoad`, and their effect order is load-bearing (comments at
`:4644–4663`, `:4329–4333`). The tests cover part of it (`PdfRestoreZoom`,
`PdfReloadSettle`, `PdfZoomRaster`, `PdfHiddenPages`, `PdfSleepHidden`), but
the restore-after-recompile timing is the area most often fixed live. Do this
only after phases 1–3 have been used for a while.

### Not planned

- **The toolbar as a component.** It would take about 40 props, which moves the
  noise rather than removing it. Revisit after phase 3, when most of its
  handlers come from hook return values.
- **A `useLatest` helper** for the 30 `xRef.current = x` mirrors. It is
  repo-wide in scope, and the saving is one line per mirror.
- **Splitting `PdfPageCanvas` internally** (a `useRedactDrag` hook, the SyncTeX
  geometry). It is a separate step once that component has its own file.

## Risks

- **Effect order.** Inside one component, effects run in declaration order.
  Call each hook where its code stood. Where code moves earlier or later (for
  example, the notes block is split around `handleSave`), check the
  inter-effect comments: `wasCompileHeld` (`:3972`), the restore layout effect
  vs the fit (`:4329`), and the notes render-time reset (`:2281`).
- **Stable identities.** A callback that used to have `[]` deps must keep
  stable deps once it is in a hook. Otherwise the subscriptions keyed on it
  (`subscribePageDragActive`, `selectionchange`, the wheel listener) will
  re-subscribe on every render.
- **Other sessions' work.** On 2026-11-14 `PdfViewer.tsx`, `usePdfMarkup.ts`
  and six other `pdf/` files had uncommitted edits from another session. Start
  only once those are committed. Otherwise their diff and these moves land in
  one commit.
- **Blame.** Phase 1 is a pure-move commit, so `git log --follow` /
  `git blame -C` track the code into the new files.

## Verification per phase

- Gates: `scripts/gates-job.sh start` (`npm run build`, `npm test`,
  `npm run lint`, `scripts/brand-check.sh`; no Rust is touched).
- The 48 tests in `src/__tests__/pdf/` plus `TexWorkspace.test.tsx` must pass
  unchanged, apart from import paths in phase 1.
- `src/` hot-reloads, so the user can check live (no restart needed). The
  click-through after each phase: open a PDF; Ctrl+wheel zoom; Fit; scroll, then
  switch tabs and back; Ctrl+F with next/previous and the scrollbar ticks;
  Ctrl+G; ← →; follow a `\ref` link, then Alt+←; open the contents pane; select
  text and highlight it; add a remark and let it autosave; reorder pages, then
  undo and redo; Save; print preview; Present; recompile a `.tex` and check the
  position holds; Ctrl-click for reverse search; enter Mark up and leave it.
- File maps: update the `PdfViewer.tsx` row in `docs/filemap_frontend.md` and
  add one line per new file.
