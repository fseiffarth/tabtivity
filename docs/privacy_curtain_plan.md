# Privacy curtain: hide the other windows while presenting

*Status: built 2026-10-27, landed on develop `5d2b1293`, never run live. Deviations from
the plan are in "As built" below.*

## Why

Presenting a PDF opens its own OS window (`present-pdf-*`,
`src/lib/viewers/pdfPresent.ts`, opened by `commands/presenter.rs`). In a video
call the user then picks a window or a screen to share, and both mistakes are
easy to make:

- **Wrong window.** The picker lists the present window next to `main` and
  every popout. Choosing `main` shares the user's mail, terminals and agent
  chats.
- **Wrong screen.** With a projector or a second monitor, the PDF fills one
  screen and the main window sits on the other. "Share entire screen" on the
  wrong monitor shares everything.

The curtain covers every other Tabtivity window while a presentation runs, so
either mistake shares a blank panel.

## Fixed decisions (user, 2026-10-27 — not up for review)

1. **Deck talks curtain the main window except the presenter pane.** The
   deck's speaker notes live in a tab of the main window (`DeckPresenter.tsx`);
   only the audience view is a `present-*` window. During a deck talk the
   presenter pane takes over the main window and everything else in it is
   hidden; popouts are curtained as for a PDF.
2. **Live browser windows** (`browser-*`, external pages with no app IPC, so
   no curtain can be drawn in them) are capture-protected on Windows/macOS
   while presenting, and left alone on Linux.
3. **On by default**, not behind `useExperimental`. A setting turns the
   automatic curtain off.

## Decisions made while planning (mine; change if wrong)

- **An opaque curtain, not a blur.** Blur leaks large text (mail subjects,
  file names, prompts), and blurred text can sometimes be recovered. It is
  also expensive: a full-window `filter: blur()` over live terminals has to be
  redrawn on every frame in WebKitGTK's software path, the same family of
  problem as the blurred `box-shadow` rule. The curtain is a solid panel in
  the theme's background colour with one line ("Hidden while presenting") and
  a **Show** button.
- **Underneath, the shell stops painting and takes no input.** While the
  curtain is up, the shell root gets `visibility: hidden` (layout is kept, so
  xterm's fit and pane sizes do not change, and WebKit stops painting it) and
  `inert` (nothing behind the curtain can take focus or keystrokes, so typing
  can't reach a terminal you can't see). `PaneVisibleContext` is **not**
  flipped: that would put panes to sleep and make lifting the curtain cost a
  wake-up of every pane.
- **Lifting is the user's click, per window.** Esc closes the present window,
  often while the call is still sharing, so the curtain does **not** lift when
  the presentation ends. Each window lifts on its own **Show** click (or
  Enter on the focused button). A window opened while presenting starts
  curtained.
- **Capture protection on Windows and macOS.** The runtime we vendor already
  has `set_content_protected` (`patches/tauri-runtime-wry`, tao's
  `set_content_protection`): Windows' `WDA_EXCLUDEFROMCAPTURE` and macOS's
  `NSWindowSharingNone` make the window black in any capture, including the
  share picker's thumbnail and a full-screen share. On Linux it does nothing
  (X11 and Wayland have no equivalent), so there the curtain is the only
  cover. Newer macOS ScreenCaptureKit is reported to ignore it at times, so it
  is an extra layer, never a replacement for the curtain. Protection is set
  from Rust (no `core:window:allow-set-content-protected` grant to the
  renderer) and follows the curtain: on while it is up, off when that window
  lifts it.
- **Calendar alarms wait.** The only OS notification Tabtivity sends is the
  calendar alarm (`stores/calendar/alarms.ts` `notifyOs`). While a
  presentation runs, it is queued and sent when the presentation ends. The
  phone copy (`notifyPhone`) still goes at once, since the phone is not on the
  call. In-app toasts render inside curtained windows, so they are hidden
  already.
- **Window titles need no change.** The share picker lists windows by title.
  They are already neutral: `main` is "Tabtivity" (`tauri.conf.json`), popouts
  "Tabtivity win-N" (`subwindow::detached_title`), and present windows
  "Tabtivity — Presentation", which is also what tells the user which one to
  pick. No title shows a project or file name.
- **"Presenting" is derived, not stored.** Presenting means at least one
  `present-*` window is open. A pure function in `services::window_service`
  answers it from the window labels; nothing is persisted, and a crash cannot
  leave a stale "presenting" flag behind.
- **The setting.** `privacy_curtain_on_present: bool` in `settings.json`;
  unset means on. The manual toggle below works either way.
- **Deck takeover without moving the pane.** Moving the presenter's React tree
  into an overlay would remount it (timer, slide state). Instead the main
  window's shell root gets `data-curtain="deck"`: everything is
  `visibility: hidden` as in PDF mode, and the presenter root (marked
  `data-curtain-keep`) sets `visibility: visible` and `position: fixed;
  inset: 0` above it. A descendant may override `visibility`, but not
  `inert`, so deck mode uses no `inert` on the root: `visibility: hidden`
  elements already take no clicks or focus, and focus is moved into the
  presenter when the curtain goes up. The **Show** control sits in a corner
  of the takeover. If an ancestor of the presenter has a `transform` (which
  would break `position: fixed`), that is found in step 3 and fixed there.
- **App shortcuts are dropped while curtained.** `inert` does not stop
  window-level `keydown` listeners, so `useKeyboard` returns early while the
  window's curtain is up (except for the curtain shortcut itself, and, in deck
  mode, the keys the presenter handles). Otherwise Ctrl+Tab could switch the
  hidden window to another tab, or switch away from the presenter.
- **A manual toggle.** A rebindable shortcut (`SHORTCUT_DEFS`) raises the
  curtain in every app window, for calls where the user shares without
  presenting. Default combo: the first free one from `Ctrl+Alt+H` /
  `Ctrl+Shift+Alt+H`, checked against the existing defs.

## As built

- **No `inert`.** The cover is the last body child at the top z-index and
  opaque; everything under it is `visibility: hidden` (it stops painting and
  takes no clicks or focus). Keys are filtered by a window-capture listener
  (`curtainKeyVerdict`), which also covers what `inert` could not stop:
  window-level shortcut listeners. Focus moves to Show (cover) or the
  presenter (keep).
- **Deck mode needed no takeover CSS.** `DeckPresenter` is already a
  `position: fixed; inset: 0`, opaque portal into `#root`. While curtained its
  root (`data-curtain-keep`) is lifted to the top z-index and every other body
  child is hidden; no `visibility` override is used, so nothing inside the
  shell can leak through. Which mode a window uses comes from
  `usePresentationStore.presenting` (deck presenters in this heap), so a deck
  presenter in a popout works the same, and the cover takes over when the
  presenter closes.
- **The deck curtain starts with the audience window**, not with the
  in-window presenter: "presenting" is a `present-*` window being open.
- **Shortcut:** `Ctrl+Shift+Alt+H` (`privacyCurtain`, View group).
  `Ctrl+Alt+H` is macOS's Cmd+Option+H, "Hide Others".
- **Reminders are held only while the curtain setting is on**
  (`notificationsHeld`): with it off, presenting changes nothing.
- **Commands take `AppHandle`** like the rest of the desktop-only
  `presenter.rs` (window APIs have no `Ctx` seam); `privacy_curtain_set` also
  takes `Ctx` so the label is the calling webview's, never a payload value.

## Steps

1. **Backend.** Gates: cargo test, both clippies, the daemon build.
   - `services::window_service`: `presenting<'a>(labels: impl Iterator<Item =
     &'a str>) -> bool` (any `present-*` label) and `curtain_targets(labels)`
     (every app window that is not `present-*` and not `connect`), with unit
     tests.
   - `commands/presenter.rs`: after a present window is built, emit
     `presenting-changed { presenting: true, kind: "pdf" | "deck" }` and, if
     the setting is on, capture-protect the targets.
   - `lib.rs` `WindowEvent::Destroyed`: when a `present-*` window goes and
     `presenting()` turns false, emit `presenting-changed { presenting: false }`
     and drop protection from `browser-*` windows (app windows keep theirs
     until their curtain lifts).
   - `subwindow.rs`: a popout built while presenting is built
     `.content_protected(true)`.
   - New commands `presenting_state` (→ `{ presenting, kind }`, for windows
     that mount mid-talk) and `privacy_curtain_set(label, up)` (validated app
     label; sets that window's protection). Both
     `#[cfg_attr(feature = "desktop", tauri::command)]`, taking `Ctx`;
     `command_class` rows (`client`, like `open_presenter_window`), then
     regenerate `commandClasses.ts`.
   - `privacy_curtain_on_present` in `settings.rs`, round-tripped.
2. **Frontend curtain.** Gates: `npm run build`, `npm test`, `npm run lint`.
   - `src/lib/window/privacyCurtain.ts`: a small per-window store (`up`,
     `raise()`, `lift()`); `lift()` calls `privacy_curtain_set(.., false)`.
     Subscribes to `presenting-changed` through `useTauriListener`, asks
     `presenting_state` on mount, and listens for a `privacy-curtain-raise`
     broadcast (the manual toggle).
   - `src/components/layout/PrivacyCurtain.tsx`: the overlay, mounted in
     `AppShell` and `DetachedApp` (not in the present apps). Puts
     `visibility: hidden` + `inert` on the shell root, focuses **Show**.
     Uses the shared dialog colours and sets an explicit `color`. An
     `UntestedTag` with its row in `lib/untested.ts`.
   - Shortcut `privacyCurtain` in `SHORTCUT_DEFS` (+ hint), broadcasting the
     raise to every window. `useKeyboard` drops every other app shortcut
     while the window's curtain is up.
   - `stores/calendar/alarms.ts`: `notifyOs` queues while presenting and
     flushes on `presenting: false`; `notifyPhone` unchanged.
   - Setting toggle where the presenter settings live, with its `UntestedTag`.
   - Strings in `i18n/en.ts` and the de/es/fr/it dicts.
   - Tests: the store (raise on event, start up when mounting mid-talk, stay up
     after the presentation ends, lift per window); the shell root gets
     `inert` and `visibility: hidden`; the alarm queue holds and flushes; the
     setting off means no curtain on present but the shortcut still works;
     a shortcut such as Ctrl+Tab does nothing while curtained.
3. **Deck takeover and browser windows** (fixed decisions 1 and 2).
   - `presenting-changed` carries `kind: "deck"`. The main window's curtain
     then sets `data-curtain="deck"` instead of drawing the overlay; popouts
     draw the overlay as usual.
   - `DeckPresenter.tsx`'s root gets `data-curtain-keep`, the takeover CSS,
     focus on raise, and the **Show** corner control. Its keys stay live
     through the `useKeyboard` exemption.
   - Rust capture-protects `browser-*` windows on presenting start (a no-op on
     Linux) and drops it at the end.
   - Tests: in deck mode the presenter root stays visible and focused while
     the rest of the shell is hidden; a non-presenter shortcut is dropped,
     the presenter's next-slide key is not.
4. **Docs.** One row each in `filemap_frontend.md` / `filemap_backend.md`; a
   short section in the presenting page under `docs/help/`; a `todo/` 🖐️ box
   with the `✅ Works on <P>` / `❌ Doesn't work on <P>` pairs for Linux (X11),
   Linux (Wayland), Windows, macOS.

## Organisation

Main loop, sequential 1 → 4, no subagents. About a day and a half of work.
Step 2 depends on the events and commands of step 1, and step 3 builds on the
curtain store from step 2.

## Verification

- `scripts/gates.sh` for the touched gates, then `npm run backend:stale` and
  report its result. Never run the app live.
- Click-through for the user:
  1. Open a popout. Present a PDF. The main window and the popout show the
     curtain; the PDF window does not.
  2. Start a screen share in a call app. The picker's thumbnails of the main
     window and the popout show the curtain (Windows/macOS: black).
  3. Press Esc on the PDF. The curtains stay. Click **Show** in the main
     window: it comes back exactly as it was (terminal sizes, scroll
     positions); the popout stays curtained until its own **Show**.
  4. Set a calendar alarm a minute ahead and present through it. No desktop
     notification during the talk (the phone gets one); it appears when the
     PDF window closes.
  5. Press the curtain shortcut without presenting: every window curtains.
  6. Turn the setting off and present: no curtain.
  7. Present a deck. The main window shows only the presenter (notes, timer,
     next slide), and arrow keys still drive the slides. Popouts are
     curtained. **Show** in the corner brings back the full main window.
  8. Windows/macOS: open a live browser window, present, and check the share
     picker shows it black.
