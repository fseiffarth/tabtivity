## Group V — Native Presenter ("Deck"): Post-Phase-7 Hardening & Gaps

*Follow-on work for Group M #90, which is code-complete through Phase 7 plus the
dual-window presenter but has **never been run live**. Everything below came out
of a three-way static analysis (authoring / presenting / feature-gap) of the
shipped code; each item cites the evidence it rests on.*

*Files: `src/lib/viewers/deck/{model,sidecar,present,export,fonts,snap,shapes,
icons,template,transform,deckBase,gifPlayback}.ts`,
`src/components/embed/deck/{DeckView,DeckStage,DeckObjectView,DeckSlideView,
DeckInspector,DeckAnimate,DeckNotes,DeckTexPanel,DeckPresenter,DeckAudienceApp}.tsx`,
`src/components/embed/deck/deckAssets.ts`, `src/components/embed/pdf/PdfViewer.tsx`,
`src/components/embed/fileAccess.ts`, `src/components/PresentationOverlay.tsx`,
`src/hooks/useKeyboard.ts`, `src/styles/themes.css` (`.deck-*`),
backend `src-tauri/src/commands/{presenter,tex,fs}.rs`. *

> **Line references are as of this analysis** (2026-07-25, `develop` @ v0.1.40)
> and will drift; treat them as pointers, not addresses.
>
> **Coverage note.** The 148 vitest cases behind #90 exercised only the *pure*
> modules (`model`, `sidecar`, `snap`, `export`, `present`, `template`,
> `transform`). Every data-loss item in V.1 lived in `DeckView`'s effects or in
> `presenter.rs` — surfaces with **no test coverage at all**. That gap is closed
> for the write policy: `src/__tests__/deck/DeckAutosave.test.tsx` mounts the real
> `DeckView` over a fake backend and asserts the three properties #93/#94 are
> about (open-does-not-write, unmount-flushes, lossy-is-held).
>
> **Status: V.1 and V.2 (#93–#122) are ✅ done** as of 2026-07-26 on `develop`.
> V.3 (#123–#141) is untouched. Per the status legend each landed item carries
> its two verification boxes; **no 🖐️ manual box is ticked** — the presenter has
> still never been run live, and every one of these fixes is a claim about
> behaviour only a real talk can confirm.
>
> The backend gained two commands and a dependency along the way:
> `tex::synctex_page_lines` (parses the `.synctex.gz` a compile already emits —
> the producer half of the line anchor, which #100a found did not exist at
> runtime; needs `flate2`, already in the tree via `zip`), and
> `presenter::presenter_{inhibit,release}_sleep` (#121). `compile_tex` is now
> `async` (#105).

---

## V.1 — Blockers: loses work, or breaks a real talk

*These come first. Items #93 and #94 destroy authored work with no prompt;
#95–#100 are the failures most likely to show up in front of a room.*

93. ✅ **The debounced autosave is cancelled on unmount — the last edit is lost.**
    The autosave effect returns `clearTimeout(t)` as its cleanup
    (`DeckView.tsx:280-289`), so closing the tab (or quitting) within the 800 ms
    debounce silently discards the pending write. There is no unmount flush, no
    `beforeunload` handler, and `closeTabWithConfirm` is literally `removeTab`.
    The module's own comment claims the interval is "short enough that closing
    the tab right after an edit still catches it" — the cleanup makes that false.
    *Fix:* mirror the latest deck into a `deckRef` plus a `dirtyRef` cleared on a
    successful write; add a mount-scoped cleanup that flushes when dirty, and
    register the same flush on the window-close path. Drive the toolbar label
    from `dirtyRef` while you're there — it currently reads `saving ? "Saving…"
    : "Saved"` (`DeckView.tsx:1158-1160`), i.e. it says **"Saved" for the entire
    debounce window**, which is actively misleading.
    *Test:* mount, edit, unmount inside the debounce, assert the file on disk
    carries the edit.
     - [x] 🤖 Automated test — `DeckAutosave.test.tsx` — mounts the real `DeckView`, edits, unmounts inside the debounce, asserts the edit is on disk
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

94. ✅ **Opening a newer-version deck silently downgrades and overwrites it.**
    `normalizeDeck` always stamps `version: DECK_VERSION` (`sidecar.ts:326`)
    even when the file declared a higher one — it merely *reports* the mismatch
    (`sidecar.ts:344-347`). Unknown object kinds are dropped
    (`sidecar.ts:223-228`) and every unmodelled field vanishes through the
    coercion. Then autosave fires 800 ms later and writes the lossy result over
    the original: no prompt, no read-only mode. The same mechanism destroys any
    hand-added field surviving a git merge.
    Related, and cheap to fix in the same pass: **merely opening a deck rewrites
    the file.** `loadedRef` is set true immediately after the load's `setDeck`
    (`DeckView.tsx:265`), so the reconciled deck — with `anchor.print` refreshed
    on every slide (`sidecar.ts:474-478`) — is written unconditionally. On a
    git-tracked, lockstep-synced sidecar, *looking* at a deck produces a diff.
    *Fix:* have `normalizeDeck` return the observed version and a `lossy` flag
    (higher version, dropped object kind, or unparseable slide). On `lossy`,
    leave `loadedRef` false, show a blocking banner with an explicit "Open anyway
    (this will rewrite the file)", and preserve the declared version verbatim
    rather than stamping `DECK_VERSION`. Suppress the write when the load
    produced `parsed.error`, and don't arm autosave until the deck is actually
    dirty.
     - [x] 🤖 Automated test — `DeckAutosave.test.tsx` (open-does-not-write, newer-version held, override) + `DeckSidecar.test.ts` (version kept, lossy vs. repaired)
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

95. ✅ **An auto-advancing GIF double-steps whenever the second display is open.**
    `DeckPresenter.tsx:398` renders the interstitial with `onEnded={next}`;
    `DeckAudienceApp.tsx:278` renders the *same* interstitial with
    `onEnded={() => send({ kind: "next" })}`. Both windows decode and play the
    clip on their own rAF clock (`gifPlayback.ts:122-146`), so for any
    `advance: "end"` / `"end-after"` interstitial **both fire**, and `applyNav`
    is an unconditional `index + 1`. The presenter advances on its own clip end,
    the audience's forwarded `next` lands one IPC hop later and advances again —
    **the deck skips the slide after every auto-advancing GIF**, but only in
    dual-window mode. In front of a room it reads as a nondeterministic "it
    sometimes jumps two".
    *Fix (minimum):* thread a `drivesAdvance` / `mirror` prop into
    `InterstitialView` — presenter `true`, audience `false` — so the one-owner
    rule already stated in `present.ts`'s header holds for time-driven
    transitions as well as key-driven ones. *Fix (better, do it anyway):* make
    nav idempotent — add `from?: number` to `NavAction` and have `applyNav`
    return `index` unchanged when `from != null && from !== index`. That closes
    the whole "two nav requests raced" class, including a double clicker press
    and a forwarded key arriving after a local one.
    *Test:* extend `DeckPresent.test.ts` with the stale-`from` case.
     - [x] 🤖 Automated test — `DeckPresent.test.ts` — the stale-`from` case, and that an unstamped request still works
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

96. ✅ **PDF export throws on any character outside WinAnsi.**
    `export.ts:337-364` calls `page.drawText` with no `try`/`catch`;
    `fonts.ts:104-112` guards only *measurement*. A Greek letter (`σ`, `μ`,
    `α`), a CJK glyph or a math symbol throws straight out of `exportDeck` and
    is caught only by the generic handler at `DeckView.tsx:577` — the whole
    export fails with a raw error, no partial PDF, no warning naming the
    character. It renders fine on screen, because `DeckObjectView.tsx:230-238`
    uses CSS font stacks — so the failure is invisible until export, which for a
    talk means the night before. This is exactly the editor/exporter drift the
    shared-`fonts.ts` design set out to prevent, in a worse form.
    *Fix:* wrap each `drawText` in a catch that pushes a warning naming the
    object and the offending character and falls back to the encodable subset,
    so the rest of the deck still exports; add an `encodableIn(text, style)`
    helper in `fonts.ts` and a **pre-export scan** in `DeckView.doExport`
    (`DeckView.tsx:532-582`) so the author learns at edit time. Highest
    severity-to-effort ratio in this group. See #120 for the real fix.
    *Test:* `DeckExport.test.ts` cases with a Greek and a CJK string.
     - [x] 🤖 Automated test — `DeckExport.test.ts` — Greek and CJK strings export the rest of the deck and name the character
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

97. ✅ **The audience window can open black on the projector.**
    `presenter.rs:127-133` applies position/size and then `set_fullscreen(true)`
    immediately after `build()`. The deferred first-paint kick 250 ms later
    (`presenter.rs:141-169`) is guarded by `if let Ok(false) = w.is_fullscreen()`
    — so whenever a second monitor *was* found, the window is already fullscreen
    and **the resize nudge never runs**. The module's own comment says WebKitGTK
    presents "an unpainted BLACK GL surface until a genuine OS-level resize" and
    then relies on the fullscreen transition counting as one. If it doesn't,
    first real use is a black projector — and the guard skips the workaround in
    precisely the case it exists for.
    *Fix:* keep `set_position`/`set_size` where they are (physical,
    pre-fullscreen) and move `set_fullscreen(true)` *into* the deferred
    `run_on_main_thread` closure, after the ±1 resize nudge.
     - [ ] 🤖 Automated test — none: needs a real window manager — `presenter.rs` has no harness for a live window
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

98. ✅ **`Escape` is triply bound — holstering the laser ends the talk.**
    Three independent `window` keydown listeners can see one Escape, and none
    stops propagation: `DeckPresenter.tsx:305-311` (peel grid → peel blank →
    **end the talk**), `PresentationOverlay.tsx:312-319` (disarm the
    marker/laser, registered whenever a tool is active), and
    `useKeyboard.ts:122-128` (exit subwindow fullscreen). Press Escape to put the
    laser away with the grid closed and nothing blanked and you get `closeAll()`.
    A second `PresentationOverlay` also stays mounted underneath by
    `FileViewerPane.tsx:513` over the deck editor, keeping its own Escape
    listener live behind the portal.
    *Fix:* let `DeckPresenter` check whether a presentation tool is armed before
    treating Escape as "peel a layer" — lift the overlay's tool state into a ref
    the presenter can read, or give `PresentationOverlay` an `onEscapeHandled`
    callback and bail when it returns true. Stop rendering `FileViewerPane`'s
    overlay while `presenting`.
     - [ ] 🤖 Automated test — none: three window-level keydown listeners in two webviews; needs a live Tabtivity
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

99. ✅ **"Present fullscreen" is not fullscreen.**
    `.deck-presenter` is `position: fixed; inset: 0; z-index: 200`
    (`themes.css:19843-19850`) inside a window that is `maximized: true,
    decorations: false, fullscreen: false` (`tauri.conf.json`), and
    `AppShell.tsx:163-171` deliberately never enters fullscreen on Linux/Windows.
    There is no `requestFullscreen`, no Tauri `set_fullscreen` on the main
    window, and no use of `useTabsStore.toggleFullscreen(groupId)` — `groupId` is
    threaded into `DeckView` and then parked in a hidden span
    (`DeckView.tsx:1374-1376`). On a single monitor — the common conference case
    — the talk is presented with the desktop panel and app chrome around it.
    *Fix:* on `DeckPresenter` mount, `getCurrentWindow().setFullscreen(true)`;
    on unmount, **read-and-restore** the prior value rather than blindly setting
    `false` (`AppShell` keeps Linux out of fullscreen on purpose). Windows should
    `maximize()` instead, matching `useKeyboard.ts:67-77`'s existing reasoning.
     - [ ] 🤖 Automated test — none: asserts against the OS window state; nothing to drive it in jsdom
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

100. ✅ **Anchoring can scramble layers on a Beamer recompile — the failure the
     sidecar design exists to prevent.**
     Two compounding defects:
     (a) **The SyncTeX anchor is dead code.** `BasePage.lines` is documented as
     the resolution that survives inserting a slide (`sidecar.ts:376-381`,
     `model.ts:272-278`) and `reconcile` step 2 consumes it
     (`sidecar.ts:499-508`) — but `loadBase` never populates it
     (`deckBase.ts:59`) and **nothing anywhere writes `SlideAnchor.line`**. The
     mechanism described as "strictly better than any content heuristic" does not
     exist at runtime. (`deck.source` is likewise never written, only read —
     `sidecar.ts:327` — so a deck doesn't record the `.tex` that produced it,
     which a SyncTeX anchor would need.)
     (b) **The fingerprint is the wrong tool for a Beamer deck.** `fingerprint`
     hashes the page box plus the first 200 whitespace-collapsed characters
     (`sidecar.ts:385, 396-403`), and step 3 trusts it only when unique
     (`sidecar.ts:510-523`). Beamer `\pause`/overlays emit consecutive pages
     whose leading 200 characters are *identical by construction* — so those
     pages produce identical fingerprints, get skipped, and fall through to the
     order fallback (`sidecar.ts:528-535`), which hands out uncovered pages in
     **deck order**. On a deck the author has manually reordered, that re-anchors
     layers onto the wrong pages — and autosaves the result 800 ms later.
     *Fix:* (a) `compile_tex` already passes `-synctex=1`; parse the
     `.synctex.gz` (or expose a backend command that does) in `loadBase`, and
     write `anchor.line` during `reconcile`'s placement. Populate `deck.source`
     at generation time (`DeckView.tsx:608-640`). (b) Until then, make the
     fingerprint discriminating — hash the whole page text, or the first N chars
     *plus* text length and item count, so consecutive overlay pages differ. And
     gate the order fallback: if more than one content-bearing slide would be
     re-anchored by order alone, **hold the autosave** and surface "the base PDF
     changed in a way Tabtivity can't match; review before saving."
     *Test:* `DeckSidecar.test.ts` — a synthetic overlay deck (N pages sharing
     leading text) must not silently reorder layers.
     - [x] 🤖 Automated test — `DeckSidecar.test.ts` (overlay fingerprints differ, within-line matching, `line` written back, `ambiguous`) + `tex.rs` (SyncTeX parse, main-input tag, postamble)
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

---

## V.2 — Correctness and core usability

101. ✅ **The "Next slide" preview shows the *current* slide.**
     `DeckPresenter.tsx:373` computes `stops.slice(index + 1).find((s) => s.kind
     === "slide")?.slide` — on a slide with builds, the next `kind: "slide"` stop
     is the *same slide's* next build step. So while stepping builds (i.e.
     exactly on the slides that matter) the speaker console's preview
     (`:463-481`) and the footer "Next: slide N+1" (`:487-495`) both render the
     slide the room is already looking at, labelled with the wrong number. This
     is the core of the dual-window value proposition.
     *Fix:* add `&& s.slide !== stop.slide` to both. Better: extract a pure
     `nextSlideOf(stops, index)` into `present.ts` so the arithmetic is testable
     rather than living inline in JSX.
     - [x] 🤖 Automated test — `DeckPresent.test.ts` — `nextSlideOf` skips the current slide's own build steps
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

102. ✅ **The overview grid does not stop navigation.** The keydown handler
     (`DeckPresenter.tsx:318-342`) gates on `blank` but never on `grid`, so with
     the overview open `→`/`Space`/`↑`/`↓` still call `setIndex` and stream
     straight to the projector — the speaker browsing for slide 23 advances the
     live talk while doing it. *Fix:* return early from the movement branch when
     `grid` is true; arrows should move the grid *selection*, Enter commits.
     - [ ] 🤖 Automated test — none: presenter keyboard state; would need the presenter mounted with a portal + pdf.js
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

103. ✅ **The audience window has no exits of its own.**
     `keyToAction("Escape")` → `{kind:"close"}` only *forwards* the request
     (`DeckAudienceApp.tsx:222-232`); the window never closes itself. Three
     consequences: **(a) orphaning** — if the main webview dies (this repo has a
     documented WebKitGTK renderer-crash history) or the main window is closed,
     the audience keeps a fullscreen slide on the projector with no key that
     dismisses it, no titlebar in fullscreen, and `.deck-audience { cursor:
     none }` so no pointer either. **(b) display unplug** — the WM relocates the
     still-fullscreen window over the speaker's notes; `D` is dead there
     (`keyToAction("d")` → `null`) and the only key that reacts is Escape, which
     ends the entire talk. There is no monitor-change handling in `presenter.rs`.
     **(c)** nothing re-focuses the main window after `open_presenter_window`, so
     immediately after pressing `D` the speaker's keystrokes land on the
     projector window, where `N`/`G`/`D`/digit-goto are all inert.
     *Fix:* bind a local-only close in `DeckAudienceApp` ahead of `keyToAction`
     (`Escape` → emit `PRESENT_CLOSED`, then destroy *this* window; reserve
     `Shift+Escape`/`Q` for "end everywhere"); add `F11` → toggle fullscreen (the
     capability is already granted); scope `cursor: none` to an `.is-fullscreen`
     class so a windowed audience window keeps a draggable pointer; add an
     `onResized`/monitor re-check that drops fullscreen if the window lands on
     the main window's monitor; and `setFocus()` the main window after
     `openAudience` resolves.
     - [ ] 🤖 Automated test — none: a second OS window and a monitor unplug
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

104. ⚠️ **PARTIAL — the ✅ overstates it.** The StrictMode/impure-updater half is
     genuinely fixed (coalescing + push moved outside the updater,
     `HISTORY_MAX=400`, `DeckView.tsx:501-551`). But the per-keystroke half is
     **only fixed on the stage**: the sole keyed caller is `DeckStage`'s
     `onTextChange` (`DeckView.tsx:1846`). Still one undo step per keystroke —
     `DeckInspector.tsx:27` (its `onChange: (next: ObjectList) => void` prop has
     no key parameter at all), `DeckNotes.tsx:28-31` → `patchSlide` → `commit`
     (`DeckView.tsx:554,957-962`), and `DeckAnimate.tsx:38-39`. Route those
     three through a key before ticking this.
     Original text: **Undo is per-keystroke, and the history updaters are impure.**
     Every inspector `onChange` calls `setObjects` → `commit` → one history
     snapshot (`DeckInspector.tsx:69`, `DeckView.tsx:294-303`). Typing a
     40-character title is 40 undo steps; typing 100 characters of speaker notes
     (`DeckNotes.tsx:26-29`) evicts **all** prior structural history via
     `past.current.slice(-99)` (`DeckView.tsx:299`). For a talk, text and notes
     are the bulk of the typing, and they destroy the undo stack for the layout
     work. Separately, `commit` mutates `past.current` *inside* a `setDeck`
     updater (`:294-302`) and `undo`/`redo` `pop()` inside theirs (`:335-351`) —
     React 18 StrictMode is on (`main.tsx:12`) and double-invokes updaters in
     development, which is exactly the build where `deck_presenter` is on by
     default. Anyone who *can* test this feature sees doubled/broken undo.
     *Fix:* add `commitCoalesced(key, next)` — replace the top of `past` when the
     previous push carries the same key and is younger than ~600 ms; key on
     `("text", objectId)`, `("notes", slideId)`, `("num", objectId, field)`, and
     route `DeckInspector`'s textarea/number handlers, `DeckNotes`, and
     `DeckAnimate`'s step/loops/poster inputs through it. Raise the 99 cap once
     entries are meaningful. Move the history push *out* of the updater: compute
     `next` from a `deckRef` and call `setDeck(next)` non-functionally.
     - [ ] 🤖 Automated test — none: the dirty/flush half is covered by `DeckAutosave.test.tsx`; the coalescing window itself is not
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

105. ✅ **`compile_tex` is synchronous — every compile freezes the whole window.**
     `commands/tex.rs:310-311` declares a sync Tauri command with a 600 s timeout
     (`:124`). The repo's own convention documents that sync commands run on the
     main thread and freeze the webview (`commands/credentials.rs:13`,
     `commands/clipboard.rs:21-24`). Every TeX-figure add (`DeckView.tsx:717`),
     Recompile (`:782`) and starter-deck generation (`:626`) blocks the entire
     app for the duration of `latexmk` — today that's up to 600 s of frozen UI.
     *Fix:* `pub async fn`, or wrap the body in `spawn_blocking`. ~5 backend
     lines, and it removes the worst-feeling part of TeX-figure authoring.
     - [x] 🤖 Automated test — `tex.rs` — the rejection path still tested against `compile_tex_blocking`
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

106. ✅ **Slides cannot be deleted or skipped — and deletion is structurally
     undone.** `removeSlides` exists and is tested but has **no caller**
     (`model.ts:636-639`); `blankSlide` (`model.ts:389`) likewise —
     `insertSlide` is used only by slide-duplicate (`DeckView.tsx:434`). The rail
     offers only ▲ ▼ ⧉ (`DeckView.tsx:1215-1248`). Worse, `reconcile` re-adds a
     blank slide for every uncovered base page on the next load
     (`sidecar.ts:557-568`), so a deck always has ≥ one slide per base page — you
     cannot drop a title page or a backup slide from the sequence, and an
     accidentally duplicated slide is permanent short of hand-editing the JSON.
     *Fix:* wire `removeSlides` to a rail delete (confirm when the slide has
     content; route its layers into `deck.detached` rather than dropping them,
     per the module's non-destructive contract at `model.ts:299-310`), add a
     "+ blank slide" at the rail foot, and add `Slide.skip?: boolean` honoured by
     `sequence()` (`model.ts:687-697`) and the exporter. Crucially `reconcile`
     must not resurrect a removed slide — record dropped pages (e.g.
     `deck.skippedPrints: string[]`) and check it in the uncovered-page fill.
     - [x] 🤖 Automated test — `DeckSidecar.test.ts` (no resurrection) + `DeckPresent.test.ts` (sequence, goto) + `DeckExport.test.ts` (page count and page mapping)
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

107. ✅ **A deck cannot be created without an existing PDF, and creation is
     undiscoverable.** The only affordance in the whole app is the "Present"
     button *inside an already-open PDF viewer* (`PdfViewer.tsx:685-725, 1854`).
     `generateBase()` can write and compile a starter Beamer `.tex`
     (`DeckView.tsx:608-640`, `template.ts:49-90`) but only renders when
     `deck.slides` is empty (`DeckView.tsx:1277-1303`), which requires an
     `.eldeck.json` to already exist — and the file tree's "New file" produces an
     *empty* file, which `parseDeck("")` rejects hard (`sidecar.ts:79-83`) with
     "This deck could not be read: not valid JSON". So the from-blank path the
     plan promised is unreachable in
     practice.
     *Fix:* treat empty/whitespace/`{}` input as a fresh `emptyDeck` in
     `parseDeck`, and add a "New presentation" entry to the project **+** menu
     and/or the file tree's new-file path that writes
     `serializeDeck(emptyDeck(null))` to `<name>.eldeck.json` and opens it —
     gated on `useExperimental("deck_presenter")` like the PDF button.
     - [x] 🤖 Automated test — `DeckSidecar.test.ts` — empty/whitespace/`{}` read as a fresh deck, malformed JSON still refused
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

108. ✅ **Asset paths break portability, sometimes permanently.**
     `toDeckRelative` relativizes only when the file sits under the deck's own
     directory (`DeckView.tsx:584-590`), so an image picked from
     `<project>/figures/` while the deck lives in `<project>/talks/` is stored
     **absolute** — contradicting the model's promise at `model.ts:159`. Worse,
     the picker is unrestricted (`DeckView.tsx:649-652`), so a file from outside
     the project is stored absolute and then permanently unreadable, because
     `read_file_bytes` confines to project roots (`commands/fs.rs:1430-1432`):
     a permanent placeholder on the slide and a "not available" warning in every
     export (`export.ts:126`).
     *Fix:* a real relativizer (walk up with `..` within the project root);
     refuse out-of-scope picks with a clear message and an offer to copy the file
     into the deck's folder. Add the missing "Replace image…" action to the
     inspector while in there.
     - [x] 🤖 Automated test — `DeckView.test.ts` — `deckRelative` walks up, `withinProject` refuses a look-alike sibling
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

109. ✅ **Duplicate ids are not defended against.** `normalizeObject` mints a fresh
     id only when one is *missing* (`sidecar.ts:136`), same for slides (`:268`).
     A bad git merge that duplicates an object makes
     `updateObjects`/`removeObjects`/selection act on both at once; a duplicated
     *slide* id corrupts `reconcile`'s `placed` map (`sidecar.ts:491-497`). The
     whole id design exists to survive exactly this (`model.ts:39-44`) but the
     reader never enforces it. *Fix:* thread a `seen: Set<string>` through slide
     and object normalization and re-mint on collision, counted as a repair.
     - [x] 🤖 Automated test — `DeckSidecar.test.ts` — a duplicated object id and a duplicated slide id are both re-minted
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

110. ✅ **Replacing an interstitial's GIF keeps playing the old one.** `pickGif`
     reuses the existing id (`DeckAnimate.tsx:77`) and `useDeckGifs` keys its
     decoded cache by `a.id` (`deckAssets.ts:144`), so picking a different file
     never re-decodes. Same class of bug the image hook already fixed with
     `refresh(src)` (`deckAssets.ts:54-63`), just not applied here. *Fix:* key on
     `` `${a.id}:${a.src}` `` (or mint a new id when `src` changes) and give the
     GIF hook the same `refresh` escape hatch.
     - [ ] 🤖 Automated test — none: needs a decoded GIF and a file swap
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

111. ✅ **Rotation is ignored by resize, selection and alignment.** `applyHandle`
     applies the pointer delta in page space irrespective of `obj.rot`
     (`DeckStage.tsx:523-536`), so dragging a handle on a rotated object moves
     the wrong edges. `boundingBox` is axis-aligned over the *unrotated* box
     (`model.ts:597-610`), so the selection rect (`DeckStage.tsx:400-402`), the
     marquee hit test (`:292-297`) and every align/distribute are wrong for
     rotated content. *Fix:* rotate the delta into the object's local frame
     before `applyHandle`, and compute bounds from the rotated corner set. Until
     then, consider hiding the resize handles for `rot !== 0` — a handle that
     moves the wrong edge is worse than no handle.
     - [x] 🤖 Automated test — `DeckModel.test.ts` — rotated bounds, the aspect-corrected turn, unrotated unchanged
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

112. ✅ **Mixed page sizes collapse to page 1's box.** `reconcile` unconditionally
     sets `pageWidth`/`pageHeight` from `pages[0]` (`sidecar.ts:472-473,
     577-578`), so a base PDF with a portrait appendix or an inserted landscape
     figure page mis-scales every layer on those pages. *Fix:* store the box per
     `Slide` (falling back to the deck's) and set it from each `BasePage`;
     touches `model.ts`, `sidecar.ts`, `DeckStage`, `DeckSlideView`,
     `export.ts:144-145`.
     - [x] 🤖 Automated test — `DeckSidecar.test.ts` — a differing page box is recorded per slide, a matching one is not
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

113. ✅ **Editor background work keeps running during the talk, and desyncs the two
     windows.** The TeX-figure mtime poll (`DeckView.tsx:815-864`) has no
     `presenting` gate. A figure that recompiles mid-talk calls
     `refreshImage(src)` (`deckAssets.ts:54-63`), which revokes the blob URL and
     re-fetches — but updates **only** the presenter window's asset map. The
     audience window owns its own and never hears about it, so the two displays
     show different versions of the same figure: the one thing the dual-window
     design says cannot happen. Under a remote `scope`, `fileMtime` is also a
     synchronous Tauri command per figure per tick — an SFTP round trip on the
     main thread every 1.5 s during a presentation.
     *Fix:* gate the poll (and the autosave) on `presenting`. If a live refresh
     is genuinely wanted, it must re-seed the audience window, not just the
     editor's map.
     - [ ] 🤖 Automated test — none: an interval racing a presenter mount
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

114. ✅ **Present always starts at slide 1.** `startAt={0}` is hardcoded
     (`DeckView.tsx:1349`), so "let me see how this slide looks" costs walking
     the whole deck. The prop and its clamp (`DeckPresenter.tsx:92`) already
     exist. *Fix:* pass `slideStopIndex(sequence(deck), slideIndex)`, and offer
     both — Present resumes at the current slide, shift-click/menu presents from
     the beginning.
     - [ ] 🤖 Automated test — none: trivial prop threading, but only observable with the presenter mounted
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

115. ✅ **Two WebKitGTK paint traps in the presenter path.**
     (a) `themes.css:20063-20065` claims "Transform and opacity only. Nothing
     here animates a blurred shadow" — but `deck-build-wipe` (`:20069`),
     `deck-build-draw` (`:20070`) and `deck-trans-wipe` (`:20115`) all animate
     `clip-path`, which is **not** compositor-only in WebKit; each frame repaints
     the clipped element. For `deck-trans-wipe` that element is the entire slide
     *including the pdf.js canvas* — a full-slide software repaint at 60 fps for
     300 ms on every slide change, on a transition the deck ships as a choice.
     (b) `PresentationOverlay.tsx:207` sets `ctx.shadowBlur = 18 * dpr` on every
     frame of an unconditional rAF loop while the laser is armed (`:180-223`) — a
     per-frame Gaussian over a full-window canvas under software rendering, on
     the machine also driving a second webview. Same class as the animated
     blurred box-shadow already fixed elsewhere, just on canvas instead of CSS.
     *Fix:* express wipe as a `transform: translateX` on a masking pseudo-element
     (or demote wipe/draw to a documented "may stutter" choice and default new
     decks to `fade`/`push`); replace the laser's `shadowBlur` with two or three
     pre-blurred concentric `arc` fills at decreasing alpha.
     Cosmetic, same area: `renderPage` floors the canvas to integer device pixels
     while `.deck-presenter-page` is sized to the unrounded value and has
     `background: #fff` (`themes.css:19873`) — up to ~1 px of white can show at
     the right/bottom edge of a dark slide on a projector.
     - [ ] 🤖 Automated test — none: CSS animation and canvas paint cost
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

116. ✅ **No external-change detection for the sidecar.** TeX figures get an mtime
     poll (`DeckView.tsx:815-865`); the deck file itself gets none. Two deck tabs
     on one file (main window + popout), or editing the JSON in a text tab
     beside it, is last-writer-wins with no warning. *Fix:* poll the deck's own
     mtime and offer reload-vs-keep on a foreign write.
     - [ ] 🤖 Automated test — none: an mtime poll against a real second writer
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

117. ✅ **`DeckTheme` has readers but no writers — its stated purpose is
     unimplemented.** `margin`, `shapeFill`/`shapeStroke`, `iconColor`, the
     default text style and `exportInterstitials` are all read
     (`DeckView.tsx:451-453, 474, 515-516, 1265`; `export.ts:153`) and **never
     written** by any UI. Changing a deck's default font, size, colour or safe
     margin means hand-editing JSON, and `exportInterstitials` is currently
     unreachable. There is no master slide, no deck-wide restyle, and no slide
     numbering or footer facility of any kind — despite `model.ts:316` declaring
     the type exists "so a deck looks consistent without effort".
     *Fix:* a "Deck" panel as a fifth toolbar mode (`DeckView.tsx:1112-1139`)
     editing every `DeckTheme` field, plus "make this object's style the deck
     default" and "apply to all text objects". Extend `DeckTheme`
     (`model.ts:317-328`) with an optional footer/slide-number spec rendered by
     `DeckObjectView`/`export.ts` as a synthetic per-slide object; add coercion
     in `sidecar.ts:340` and cases in `DeckSidecar.test.ts`. Highest
     value-to-code ratio in V.2 — the model, defaults and consumers all exist;
     only the form is missing.
     - [x] 🤖 Automated test — `DeckExport.test.ts` — the footer draws, numbers by talk position, and adds no stored object
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

118. ✅ **No in-place text editing.** `DeckObjectView.tsx` has no `contentEditable`,
     no overlay `<textarea>`, no double-click-to-edit; `DeckStage`'s
     `onEditObject` handles only TeX figures (`DeckView.tsx:1273-1275`,
     `DeckStage.tsx:386-395`). Every character of every slide is typed into a
     3-row side-panel textarea (`DeckInspector.tsx:89-99`) while the object
     renders somewhere else. For a direct-manipulation design tool this is the
     single largest usability gap. *Fix:* double-click mounts an
     absolutely-positioned `<textarea>` on the object's box sharing `TextBody`'s
     computed style (`DeckObjectView.tsx:230-238`) — the metrics-driven layout
     already computes exact line boxes (`:266-305`), so the overlay can sit
     directly on them — committing on blur/Escape through #104's coalescing path
     (never per keystroke). The `onEditObject` hook needs only a second branch,
     and the keyboard guard at `DeckView.tsx:873-882` already exempts form
     controls.
     - [ ] 🤖 Automated test — none: a double-click gesture on a measured stage
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

119. ✅ **Half the model has no control surface.** The toolbar offers align
     left/hcenter/right only, while `alignObjects` supports top/vcenter/bottom
     (`model.ts:514`) and `distributeObjects` is tested but uncallable
     (`model.ts:558`). Text objects have no control for `padding`, `lineHeight`,
     `fill`, `stroke`, `strokeWidth` or `list.start` (all modelled at
     `model.ts:141-153, 107-111`). `hidden` has no UI anywhere — only `locked`
     (`DeckInspector.tsx:421-437`). Images cannot be replaced (see #108). Also:
     `defaultTheme().shapeFill` is 8-digit `#00000000` (`model.ts:363`), a new
     rect inherits it (`DeckView.tsx:451`), and the inspector feeds it straight
     to an `<input type="color">` (`DeckInspector.tsx:237`) which accepts only
     `#rrggbb` — the swatch silently shows `#000000`, and one interaction turns a
     transparent rect opaque black. *Fix:* complete the toolbar and inspector;
     switch fill/stroke to a swatch that understands 8-digit hex plus an alpha
     slider.
     - [ ] 🤖 Automated test — none: form controls only; the model ops behind them are already covered
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

120. ✅ **Typography cannot match the plate, and standard-14 is the root cause of
     #96.** `fonts.ts:29-48` is standard-14 only and `@pdf-lib/fontkit` is not a
     dependency. A Beamer plate is typeset in Computer Modern / Latin Modern, so
     *every* layer caption sits in Helvetica on top of it; combined with #96,
     non-Latin talks are out of reach entirely. *Fix:* add
     `@pdf-lib/fontkit`, register it on both the metrics document
     (`fonts.ts:92`) and the export document (`export.ts:91`), and widen
     `FontFamily` (`model.ts:81`) from a closed union to
     `"sans"|"serif"|"mono"|{custom: path}`. The load-bearing constraint must
     survive: whatever face is embedded has to be the same one `fonts.ts`
     measures with, or the single-source-of-truth property (`fonts.ts:1-23`) is
     lost. Needs font discovery + a picker, hence the size. Do this **after**
     #96's safety net, not instead of it.
     - [x] 🤖 Automated test — `DeckExport.test.ts` — the substitution face matches what the metrics fall back to; unparseable fonts report rather than pretend
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

121. ✅ **Nothing inhibits display sleep or the screensaver during a talk.** No
     inhibit call exists in the deck subsystem or `presenter.rs`. A 45-minute
     talk with a long Q&A pause will blank the projector. *Fix:* a small command
     pair beside `presenter.rs` (`presenter_inhibit_sleep` / `_release`) — on
     Linux an `org.freedesktop.ScreenSaver` Inhibit DBus call or an
     `xdg-screensaver` spawn — called from `DeckPresenter`'s mount/unmount effect
     alongside #99. Ship the Linux path and no-op elsewhere, as `platform/`
     already degrades.
     - [x] 🤖 Automated test — `presenter.rs` — releasing an unheld inhibitor is not an error
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

122. ✅ **`onCloseRequested` races its own notification.** `DeckAudienceApp.tsx:143-150`
     passes a **non-async** handler that fire-and-forgets `emit(PRESENT_CLOSED)`,
     while Tauri's `onCloseRequested` awaits the handler and then `destroy()`s.
     Same-channel IPC ordering probably saves it, but it is one `await` from
     being guaranteed; if it loses, the presenter keeps `audience` set, keeps
     emitting state at a dead label, and reports a second display that is gone.
     *Fix:* `onCloseRequested(async () => { await emit(PRESENT_CLOSED, { label }) })`.
     Two related minor items in the same file: the `PRESENT_NAV` effect
     (`DeckPresenter.tsx:222-246`) re-subscribes when `closeAll` changes, and
     because `listen()` is async there is a sub-round-trip window where an
     audience keypress is silently dropped; and the audience emits its first
     `PRESENT_READY` (`:122`) *before* its own `listen()` promises resolve
     (`:105-117`), so the first seed can be dropped and the 400 ms retry covers
     it at the cost of up to 400 ms of "Waiting for the presentation…" on the
     projector.
     - [ ] 🤖 Automated test — none: Tauri window teardown ordering
     - [ ] 🖐️ Manual test — present a real deck and confirm it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

---

## V.3 — Performance, polish, and the differentiated bet

*★ marks the items that make this a presenter no other tool can be — the ones
that exist because the deck lives inside the project that produced the results.
The strategic read from the gap analysis: the competitive future is **not**
"become Slidev". For a pure markdown-technical-talk, Slidev and Marp are
strictly better today. The defensible position is Beamer-as-source plus
annotation plus animation (already built, and unique), and then #133–#138.*

123. **Binary IPC for what is currently a JSON number array.** `writeFileBytes`
     does `Array.from(content)` through `invoke` (`fileAccess.ts:70-75`) and
     `read_file_bytes` returns a plain `Vec<u8>` (`commands/fs.rs:1406-1410`),
     which Tauri serializes as one JSON number per byte — no `ipc::Response`
     anywhere in the tree. So every autosave ships a 150 KB deck as a ~150 000
     element array (~600 KB of JSON) every 800 ms of editing, and an export with
     20 × 1 MB figures moves ~20 M array elements through JSON before pdf-lib
     does any work. The deck only uses bytes because `write_file_text` refuses a
     non-existent path (`DeckView.tsx:6-10`). *Fix:* a create-capable text write
     (or `create: true` on `write_file_text`) cuts the autosave payload 5–10×;
     `tauri::ipc::Response` on `read_file_bytes` fixes the asset side — and
     benefits the PDF and image viewers too, not just the deck.

124. **Editor render and load pass.** **The GIF failed-decode cache is already
     done** (`deckAssets.ts:149-154,185`) — the sentence below claiming a failed
     GIF is "re-read *and re-decoded* every time" is stale. Everything else in
     this item is verbatim still true: uncached failed image reads
     (`deckAssets.ts:76-87`), per-frame marquee (`DeckStage.tsx:322`),
     unmemoized `wrapText` and no `memo()` on `DeckObjectView`
     (`DeckObjectView.tsx:277`), the rail rendering every slide with no
     `IntersectionObserver` (`DeckView.tsx:1690-1802`), serial `loadBase`
     (`deckBase.ts:58-64`), and one-at-a-time export asset reads
     (`DeckView.tsx:906-915`).
     Original text: Concretely: failed asset reads are never
     cached as failed, so a missing image re-issues its disk read on **every
     edit**, and a GIF that fails to decode is re-read *and re-decoded* every
     time (`deckAssets.ts:65-71, 97, 141-166`). Marquee selection calls
     `onSelectionChange` on every pointer frame (`DeckStage.tsx:298`),
     re-rendering the rail, stage and inspector at pointer rate — while move and
     resize correctly stay local via `pending`. `TextBody` calls `wrapText`
     unmemoized (`DeckObjectView.tsx:267`) and `DeckObjectView` is not `memo`'d,
     so a drag re-wraps every text object each frame with per-word pdf-lib
     measurement (`fonts.ts:250-274`). The rail renders a live pdf.js page per
     slide with no virtualization (`DeckView.tsx:1176-1250`) — a 120-slide deck
     spawns 120 concurrent render tasks at mount. `loadBase` awaits `getPage` +
     `getTextContent` serially for every page before anything renders
     (`deckBase.ts:42-60`) — 400 sequential awaits for a 200-page plate, for text
     only needed for fingerprints. Export reads assets one at a time
     (`DeckView.tsx:548-557`) where `Promise.all` is a one-line change.
     *Fix:* all of the above; together maybe 40 lines for the render half, and
     it's the difference between a smooth and a stuttering drag.

125. **Rail as a first-class strip.** Pointer drag-reorder (the repo's
     `PageStrip`/`TabBar` pattern — today reorder is ▲/▼ one step at a time,
     `DeckView.tsx:1216-1237`), shift-multi-select, Arrow-key slide navigation
     (arrows currently nudge objects, `:932-943`), a right-click menu
     (duplicate/delete/skip), and `IntersectionObserver` thumbnail
     virtualization.

126. **Presenter console polish.** **PARTIAL — 4 of 6 sub-items already shipped**
     (recorded 2026-07-28): speaker stage no longer blanked in dual mode
     (`DeckPresenter.tsx:628`), real grid thumbnails (`:92-111,649`), timer
     pause/reset/target with amber/red tone (`:134-138,240-248,550-556,692-714`),
     notes font-size stepper (`:139,708-713`). **Remaining two:** a freeze/hold
     key distinct from blackout, and an audience-window health check
     (`openAudience` `:263-279` still trusts the resolved `invoke`).
     Original text: Don't blank the *speaker's* stage in dual
     mode — the blank overlay renders inside `.deck-presenter-main`
     (`DeckPresenter.tsx:420`), so blanking the room also blanks the speaker's
     view of the slide (notes survive; the slide doesn't). Render real
     thumbnails in the overview grid (`:422-435` shows numbers on empty tiles
     with a dot for notes — unusable as a jump target past ~15 slides;
     `DeckRailThumb` already does exactly this). Add timer controls — pause,
     reset, an optional target duration with the elapsed field turning
     amber/red; today it is elapsed-only from mount (`:97, 123-126`) and a laptop
     suspend adds the sleep to it. Add a notes font-size stepper (fixed 13 px in
     a fixed 340 px column, `themes.css:19966-20005`). Add a freeze/hold key
     distinct from blackout. Add a health check — the presenter shows "Audience
     view is on the second display" purely because `invoke` resolved, whether or
     not the window ever painted.

127. **Mirror the laser/marker to the audience window.** *(Moved here from #90's
     known-gap list.)* `DeckAudienceApp` contains no `PresentationOverlay`, so in
     dual-window mode — the mode most people would use a laser in — the room sees
     no pointer at all. *Fix:* stream normalized points over the existing
     `present.ts` bus as a fourth event (the `DETACHED_DRAG_*` cursor stream in
     `stores/drag/pdfDrag.ts` is the precedent) and mount a read-only overlay in the
     audience window. **Note the trap:** strokes are currently normalized to the
     *stage host*, which includes the letterbox bars — normalize to
     `.deck-presenter-page` before streaming or the two windows' different
     letterbox proportions put the mark in the wrong place.

128. **Detached-layer management.** `deck.detached` only grows: re-attach is
     offered (`DeckView.tsx:1354-1373`) but there is no discard, no preview of
     what a detached layer contains, and no way to attach it to a slide other
     than the one currently open.

129. **SVG / vector figures, and an honest `cover`.** `export.ts:73-77` sniffs
     only PNG/JPEG and the picker filters to `png|jpg|jpeg`
     (`DeckView.tsx:651`), so a vector figure must be laundered through the
     TeX-figure raster path, losing vector quality. *Fix:* accept SVG, render
     natively in `DeckObjectView`, and for export parse to path data through
     `drawSvgPath` (already used by shapes and icons, `export.ts:213, 228, 250`),
     falling back to a rasterization warning for gradients/groups. Separately,
     implement `cover` via a clipping rectangle instead of degrading it to
     `contain` with a warning (`export.ts:282-293`) — that's a WYSIWYG break.

130. **Accessibility: alt text and a tagged export.** Images hardcode `alt=""`
     (`DeckObjectView.tsx:111`) with no alt-text field on `ImageObject`, and the
     exported PDF is untagged — `export.ts` draws only primitives and sets no
     structure tree, title or language. Many institutions now require accessible
     decks. *Fix:* `alt?: string` on `ImageObject`/`IconObject`
     (`model.ts:157-211`), surfaced in the inspector; write a structure tree plus
     document title and language on export.

131. **Route deck strings through i18n.** ✅ **DONE** (likely landed under
     Group N #92). All 13 deck components call `useT()` and route their literals
     through `deckView.*` / `deckPresenter.*` keys — `DeckView.tsx:123,231`,
     `DeckInspector.tsx:22`, `DeckAnimate.tsx:33`, `DeckPresenter.tsx:71`,
     `DeckTexPanel.tsx:12`, `DeckNotes.tsx:12`, `DeckAudienceApp.tsx:53`,
     `DeckStage.tsx:49`, `DeckObjectView.tsx:25`, `DeckSlideView.tsx:19`,
     `DeckThemePanel.tsx:32`, `FontField.tsx:24`, `IconPicker.tsx:18`.
     The old claim that "the only key today is `viewerLabel.eldeck`" is false.

132. **Stage zoom and pan.** `DeckStage` always fits the pane
     (`DeckStage.tsx:144-166`); precise work at 14 pt in a split pane has no
     magnification, no grid and no rulers.

133. ★ **Live file-bound figure objects.** The TeX-figure mtime poll
     (`DeckView.tsx:815-865`) is already a general "watch a file, re-render onto
     a slide" engine. Generalize it to a `watch?: string` on `ImageObject` so
     *any* project file — a matplotlib PNG, a generated SVG, a plot pulled off a
     cluster — refreshes on the slide when it changes. No other presentation tool
     can do this, because no other one lives next to the build. The engine
     exists; this is a field, a coercion, an inspector row, and generalizing one
     loop. Must respect #113's presenting gate (or re-seed the audience window).

134. ★ **A code object with real syntax highlighting.** `lib/viewers/highlight.ts`
     already exists and is XSS-safe. A fifth object kind `{kind:"code"; src?;
     text; lang; theme}` (`model.ts:213`) rendered through it, exported by
     `export.ts` as per-token `drawText` runs in Courier — standard-14 has mono,
     so this lands *before* #120. An optional `src` + line range makes it a live
     view of a project file at the actual commit, which is #133's first customer.
     Showing the real file rather than a screenshot is the most-wanted thing in a
     technical talk, and it is table stakes every markdown competitor clears.

135. **Markdown → deck.** `---`-separated markdown → a generated Beamer `.tex`
     via `template.ts`, reusing `lib/viewers/markdown.ts`. Explicitly deferred in
     the plan (§7); it is the fastest authoring path and closes most of the
     Slidev/Marp gap in one move.

136. ★ **Agent-authored decks.** "Turn this README / this paper / this week's
     commits into a talk" — Tabtivity has the agent tabs in-app. The sidecar is
     small, plain, schema-validated JSON whose defensive parser
     (`sidecar.ts:77-88, 291`) repairs anything malformed rather than crashing,
     which makes it an unusually safe LLM output target. Pairs naturally with
     #135.

137. **Rehearsal timing and deck-aware history.** The presenter already ticks a
     clock (`DeckPresenter.tsx:123-126`); record per-stop dwell time, persist via
     the usage-stats infrastructure, and surface "you always overrun on slide 7".
     Separately, the deck is a tracked text file — "what changed in this deck
     since my last rehearsal" is a diff nobody else can offer; add a deck-aware
     view to the existing diff viewer.

138. ★ **Terminal / live-demo object.** A slide object hosting a real PTY — the
     demo that always breaks when you alt-tab to a terminal mid-talk. Tabtivity is
     the one presentation surface that already owns a terminal. Largest surface
     of anything here: PTY lifecycle tied to slide visibility, a sane export
     fallback (a captured still), and a decision about what happens when the same
     deck is presented twice.

139. **Phone as a clicker.** The dual-window protocol (`present.ts:66-113`) is
     already a clean one-owner event bus with a validated label; a third
     "window" is a small step from there.

140. **Assorted smaller gaps.** Video interstitials (GIF-only today, and
     `gif.ts` warns each frame is a full RGBA copy — a 4K training animation as a
     GIF is punishing). A table/chart object from a CSV (`TableView` +
     `lib/viewers/table.ts` already parse and model it). Deck templates / brand
     themes beyond the single starter Beamer file. Find/replace across slides;
     spell-check. Speaker-notes export, handout N-up, self-contained HTML export.
     Hyperlinks on deck objects (base-PDF link annotations survive `copyPages`,
     but a layer object cannot be a link). Auto-fit / shrink-to-fit text on
     overflow. Click-on-slide-to-advance and touch/swipe in the presenter. The
     global `useKeyboard` hook is also unaware of presenter mode — `Super` still
     toggles panels behind the slide, `Shift+←/→` still cycles tabs, `Ctrl+±`
     still zooms the webview; none are catastrophic but all mutate app state
     mid-talk.

141. **Interop: deliberately declined, worth revisiting once.** No PPTX in or
     out, no PDF *content* import (the base is a background only), no
     reveal.js/Marp path. Plan §8 declares PPTX out of scope, which is
     defensible — but a collaborator handing over a `.pptx`, or asking for one
     back, is an academic-talk reality with no answer here today. Rich text runs
     within one object are likewise declined by §8 (reasonable). Revisit as a
     decision, not as a bug.

> **Also tracked in Group M #90, not duplicated here:** `compile_tex` is
> local-only (no remote dispatch), so a remote project must compile on its local
> mirror — which means the HPC story and the deck story do not currently meet.

---

## Suggested order

**V.1 and V.2 (#93–#122) are done.** What is left is V.3, whose own ordering the
gap analysis already argues for:

- **#123 and #124 before any large-deck use.** Every autosave still ships the
  deck as one JSON number per byte, and the editor still re-wraps every text
  object per drag frame. Neither is felt on a ten-slide deck and both are on a
  hundred-slide one.
- **#133/#134 first if the differentiated bet is the priority.** Live file-bound
  figures and a real code object are the two V.3 items that make this a
  presenter no other tool can be, and both are small — the mtime-poll engine
  #133 generalises is already written, and `lib/viewers/highlight.ts` already
  exists and is XSS-safe. #134 also lands *before* any font work, since
  standard-14 has a mono face.
- **Everything else by appetite.**

---

## What landed, and what it means for the rest

Two things are worth carrying forward from this pass.

**The anchoring mechanism now exists at runtime.** #100 found that
`SlideAnchor.line` — documented as "strictly better than any content heuristic"
— was read but never written, so every deck fell back to fingerprinting. The
producer is now real (`tex::synctex_page_lines` parses the `.synctex.gz` the
compile already emits), and the consumer matches *within* a line group, because
a Beamer frame with `\pause` attributes all of its pages to the same source
lines. A line names a **frame**, not a page — that is the fact the k-th-slide
-takes-the-k-th-page rule encodes, and it is the thing to remember before
touching `reconcile` again.

**The write policy is now the load-bearing part of the editor.** Three
independent conditions hold the autosave (a lossy read, a parse error, an
ambiguous re-anchor), the flush runs on unmount and on window close, and merely
opening a deck no longer writes it. Any new mutation path must go through
`apply()` — which is also what pushes history *outside* the state updater, the
StrictMode double-invoke bug #104 was about. A `setDeck` called directly would
silently skip the dirty flag and never be saved at all.

> One V.3 item was partly paid for here: #124's "failed asset reads are never
> cached as failed" is fixed for GIFs (a broken clip is no longer re-read and
> re-decoded on every edit), because #110 needed the same cache. The image half,
> the memoization and the rail virtualization are untouched.
