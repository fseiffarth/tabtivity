# Cockpit + root console: follow-up round, build log

Plan: the "Follow-up round" section of `docs/cockpit_root_merge_plan.md` (F1-F9).
Previous round: `docs/cockpit_root_merge_handoff.md`. Each implementer appends a
section. Never run live.

## I1: F2, the cockpit is no longer an experiment

Commits (worktree `cockpit-followup`): `201fc8cc` (plan section), `5bdada81` (F2 code, tests, docs), then the handoff commit.

**What changed**
- `cockpit` is out of `EXPERIMENTAL_FLAGS`, `Settings` (TS and Rust), the
  Settings row, `settingsIndex`, and the i18n keys `settings.cockpit`,
  `settings.cockpitHelp`, `settings.searchAlias.cockpit`, `rootConsole.title`
  (the flag-off dialog label; the dialog is now always "Cockpit"), in all five
  languages. The `settings.cockpit` UntestedTag row is deleted (its only purpose
  was the experiment); the other rows lost their "experiment on" wording.
- Call sites now behave as flag-on: `RootOverlay` (view strip, sub-bar,
  `root-overlay-wide`, `app-overlay-backdrop`, `data-band` always written, no
  stale-view reset effect), `RootView` (`RootRail`, `RootStartAgent`),
  `CockpitIndicator`, `BoxScopeChip` row, `SteeringLegend`, `useKeyboard` (`U`),
  `steeringScope.steeringInRoot()` (now just `rootViewShown`).
- The steering condition `when: "cockpit"` (and `apps.cockpit`) is removed: the
  `U` action is always offered.
- `OverlayApprovals` lost its `untested` prop (only the flag-off console used
  `false`); the ✓ pill is always tagged.
- **Persisted state.** `rootConsoleFrame` is untouched (localStorage). A stored
  `cockpit` key in `settings.json` now parses into `Settings.extra` on the
  backend (flattened catch-all) and round-trips there unread; the frontend
  ignores it. Rust test `a_stored_cockpit_experiment_key_still_loads`.
  No migration rewrites the file: the stale key is one harmless line. No other
  graduated experiment needed a migration either (`git log -S` found none).
- Docs: `docs/context/{cockpit,root_console}.md`, filemap rows, the manual-test
  list in `todo/group-l-tabs.md` (the "Experiment off is today's console" box is
  deleted; the others lost the "experiment on" wording). `docs/help` needed no
  change (no mention of the experiment). `docs/desktop_cockpit_plan.md` still
  says "gated by useExperimental" (historic plan, left).

**Tests.** Deleted flag-off tests: RootRail "not there without the experiment";
SteeringInRoot "today's console without the experiment"; CockpitShell
"with the experiment off: no strip", "switched off under an open cockpit view",
"CockpitIndicator absent with the experiment off"; NarrowWindow "without the
experiment no band"; RootViewChrome "absent without the experiment", "the
experiment off" (2 tests); SettingsSearchCoverage "finds the cockpit by another
word". Adapted: CockpitShell centred-wide test (now also asserts the "Cockpit"
label), RootOverlay "strip, + and badge" (now looks in the sub-bar). The
`setFlag` helpers became `setSteeringKeys` / `setRootAgents` where the file still
needed settings. 10 tests were removed, none of them covering behaviour that
still exists.

**Gates.** `scripts/gates.sh`: brand, whitespace, lint (0 errors, no new warnings), clippy x3 `-D warnings`, `npm run build`, vitest `--changed`, cargo test (`tabtivity`, `app-serverd`), daemon build test: all PASS. Full `npm test`: 1064 files / 10846 tests (tip was 10857; -10 deleted flag-off tests, -1 unexplained, likely a baseline difference).

**Flagged for user**
- None in code. One thing to know: the header cockpit button was already pinned
  by default in the apps group, so a fresh profile and an existing one both show
  it; someone who never ticked the experiment sees a new button.

**Gotchas**
- A test that opens the window on any view now gets the strip and the sub-bar:
  title-bar assertions on the Root view's strip must look in
  `.root-overlay-subbar`.
- Tests that mount `RootOverlayHost` and open a cockpit view must still mock
  `CockpitViews` or they time out.

**Next (I2: F1, F4, F6 steering)**
- `steeringInRoot()` is now just `rootViewShown(...)`; there is no flag branch to
  keep. F1: the project ring lands on Root by `openView`/`show()` instead of
  `setActive(null)`. F4: a chrome steering level for the view tabs, rail and
  buttons (the window's DOM: `.root-view-strip`, `.cockpit-rail-icons`,
  `.root-overlay-controls`). F6: Ctrl+W and tab-cycling chords in `useKeyboard`
  should go through `steeringTabs()` while `steeringInRoot()`.

## I2: F1, F4, F6 (steering and keyboard)

Commits (worktree `cockpit-followup`): `5fd3b740` (F1), `37799227` (F4), `bdb530e2` (F6), then the handoff commit.

### F1: the ring's root station opens the Root view
- `useKeyboard.landOnStation(target)`: `null` -> `rootOverlay.show()` and nothing
  else; a project -> close the Root view if it was up, then `setActive` if it is
  not already active. Steering's digits, left/right (`cycleProject`) and the
  cycle-project chords all go through it.
- The ring's current position is the root station while the window shows Root
  (`rootViewShown`), whatever project the workspace is on; so right from Root
  lands on the first project and left on the last.
- Tests: new `cockpit/ProjectRing.test.tsx` (5); `SteeringHiddenProjects` and
  `KeyboardNavDom` assertions changed from `setActive(null)` to "Root view up, no
  `setActive(null)`" (the latter also resets the overlay store in `beforeEach`).

### F4: chrome level, new-tab keys in Root
- **Chrome = a region, not a base level.** `SteeringRegion` gained `chrome`
  (`stores/keyboardSteering`): up from Root's tabs (one subwindow) or panes level
  enters it when the window's frame is in the DOM; down drops a menu or returns
  to the level it came from, up goes on to the projects level, Escape/back leaves.
  No new binding: it uses `up/down/left/right/press/back`, so everything stays
  rebindable through `steeringBindings`. A region (not a fifth ladder rung) was
  the cheapest fit: the ladder already shows `Tabs > Window bar`.
- Targets: `steeringRegion.regionRoot("chrome")` returns the root window's frame,
  and `regionTargets` narrows to `CHROME_ZONE` (`.root-overlay-bar`, the rail's
  expand/collapse buttons) minus Root's own strip (`.root-overlay-slot .tab-strip`,
  `.tab-new-wrap`). The frame is marked in a WeakSet by `regionRoot("chrome")` and
  unmarked by `regionRoot("overlay")` (the same frame is the overlay region's root
  on a cockpit view opened with U, which must walk the whole view).
- View tabs picked on `mousedown`, so `RootOverlay` got an `onClick` that picks
  when `detail === 0` (a keyboard/steering `click()`).
- Legend/cheat sheet: conditions `chromeRegion`, `upToChrome` (+ `inRoot` in
  `SteeringLegendState`); rows "To the window bar" (tabs/panes), and for the
  region: move (left/right), "Its menu" (down), up to the projects (the existing
  `steering.up.*` strings). `walkRegion` excludes the chrome. 6 new i18n keys x 5
  languages. The legend now reads Root's subwindow count and active tab while
  Root is up (it used the workspace's).
- `UntestedTag`: register row `steering.rootChrome` (pill next to
  `steering.rootView` in the cheat sheet's heading); `steering.rootView`'s text
  lost "the new-tab keys do nothing" and the experiment sentence.
- **New-tab keys in Root.** `newTabChord.targetGroupId()` is Root's focused
  subwindow (or `EMPTY_GROUP_ID` for an empty Root) while the Root view is up.
  New `layout/RootNewTabKeys.tsx` (mounted by `RootView`, renders nothing) answers
  the window events for Root's groups, like `TabBar` does: shell, monitor, agent
  slot N (root-allowed agents from `useAddTabMenuData(ROOT_SCOPE)`, own login,
  `buildStaticTabSpec`), and the + menu (opens `NewTabMenu` at the group's + button,
  the `addTab` region follows). The Host session is a menu row only, never a slot.
  The **global chords** (Ctrl+Shift+N / M, Ctrl+1-9) go the same way, and the
  window then stays (it used to step aside because the tab landed in the workspace).
  `OverlayAgentChord.test` "keeps the old path" now uses the Now view.
- Tests: new `cockpit/SteeringRootChrome.test.tsx` (11, integrated: real
  `RootOverlayHost` + `useKeyboard`, `useAddTabMenuData` and `CockpitViews`
  mocked); `SteeringInRoot` "new-tab keys open nothing" became "addressed to Root's
  subwindow".

### F6: Ctrl+W and the tab chords on Root's tabs
- `useKeyboard` computes `windowUp` (`rootOverlay.open`) and `inRootView`
  (`steeringInRoot()`). On the Root view: closeTab (`closeTabInScope(ROOT, ...)`),
  prev/next/cycle tab (`setGroupActiveInScope`), subwindow up/down (focus step
  without the Shift preview, whose badges are the workspace's) and the files
  toggle act on Root's focused subwindow. `terminalTabChord.isPaneTerminalTarget`
  admits terminals in `.root-console-backdrop` while Root is shown, so Ctrl+Shift+
  left/right from Root's own terminal step Root's tabs.
- **Choice recorded: other views (Now, Projects, Tonight, Usage).** The chords do
  nothing to the workspace behind the window (no `preventDefault`, so a focused
  terminal in the view sees the key as it would for any unhandled chord). Also no-ops
  whenever the window is up, Root included: Close subwindow, Hide subwindow, Close
  all tabs, app-internal fullscreen toggle (destructive or invisible behind it).
- Popout rule: popped-out subwindows are not in Root's shown layout
  (`steeringTabs`) and the popout window has its own handler, untouched. Host
  session: Ctrl+W closes a Host-session tab like its x does (`closeTabInScope`;
  `closedAgentTabs` already refuses to record it for reopen); no new path to start one.
- Tests: new `cockpit/RootChords.test.tsx` (8).

### Gates
- `scripts/gates.sh` green before each commit (brand, whitespace, lint 0 errors/no new
  warnings, build, vitest `--changed`); `untested.mjs check` clean. No Rust touched.
  On the F4 run two unrelated tests (`RootRail` "not there on a cockpit view",
  `TerminalAiSwitch`) timed out once under machine load and passed alone and on rerun.
- Full `npm test`: **1067 files, 10871 tests** passed (tip 1064 / 10846: +3 files = ProjectRing, SteeringRootChrome, RootChords; +25 tests net).
- Not run live.

### Flagged for user
- **The global new-tab chords also go to Root** while the Root view is in front (the
  window used to step aside and the tab landed in the workspace). Say if only
  steering's keys should.
- **Close subwindow / Hide subwindow / Close all tabs** do nothing while the window is
  up, Root included (only Ctrl+W, tab steps, subwindow steps and files are Root's).
- **Chrome walk includes the x and the fill button**; Enter on x closes the window. The
  cursor starts on the shown view tab so it is not the first press.
- **Chrome is a region**, so ladder reads `Tabs > Window bar`, not a new rung.
- A project-station landing from Root **closes** the Root view; on Now/Projects/Tonight/
  Usage views the ring leaves the window as is.

### Next
- F3, F5, F7, F8 (cockpit/Root layout), then F9. F8's resize grip adds more targets
  inside `CHROME_ZONE`-adjacent rail markup: re-check `regionTargets` if the rail
  toggle moves out of `.cockpit-rail-expand/-collapse`.

## Review of I1+I2

Range `develop..5ca2a8d2`. Reviewer commits are listed under Fixes.

### Findings

**F2 (gate removal): clean.**
- No `useExperimental("cockpit")` / `experimentalEnabled(..., "cockpit")` / `cockpitOn`
  is left in `src/`; `rg` for "cockpit experiment" finds only the Rust test name.
  `cockpit` is out of `EXPERIMENTAL_FLAGS` (so `explicitExperimentalPatch` and the
  `migrateExperimentalOnce` loops no longer write it), out of `Settings` (TS), and
  the Rust field is gone. An old `settings.json` with `"cockpit": true` parses into
  `Settings.extra` (test `a_stored_cockpit_experiment_key_still_loads`); the TS
  store spreads unknown keys and never reads it; nothing writes it. A file without
  the key loads as before (the window is now simply the cockpit, as F2 decided).
- **The 11th test.** Not a lost test. A full vitest run of `develop` (1064 files /
  10857 tests) against the tip, compared by name, shows 20 names gone: 10 deleted
  flag-off tests, 9 renamed ones (the "with the experiment on" wording; each has a
  successor), and 1 that is generated per Settings control:
  `SettingsSearchCoverage` "finds settings.cockpit by its label" (one `it` per
  searchable control; the cockpit row is gone). Hence -11 rather than -10.
  Nothing to restore.

**F1/F4/F6: one real bug (and a regression of my own fix), the rest holds.**
- Bindings: everything goes through `steeringBindings` / `resolveChord`; no
  hard-coded chord. The chrome level adds no binding.
- `Ctrl+W` cannot close a hidden workspace tab: every workspace branch is behind
  `!windowUp`; on the Root view it goes through `steeringTabsActive()` (Root's
  focused subwindow). Popouts have their own handler and a separate store
  (`rootOverlay.open` is false there). The Host session closes like its x.
- Escape: `leaveRegion` skips `closeApp` for `chrome`; the window's own Escape
  only fires with steering off. Hidden panes: `RootNewTabKeys` is mounted by
  `RootView` only, so nothing sleeping is woken.
- i18n: the 6 new keys are in all five dictionaries; `rootConsole.title`,
  `settings.cockpit*` are gone from all five. Register rows `steering.rootChrome`
  present, pill in the cheat sheet heading; legend and cheat-sheet rows present.

**Bug: an empty Root's new-tab keys also opened a tab in an empty workspace.**
`newTabChord.targetGroupId()` addressed an empty Root as `EMPTY_GROUP_ID`, the id
the empty workspace's placeholder `TabBar` (behind the window) also answers to.
With both empty, Ctrl+Shift+N, steering's N/O/1-9 and + reached both
`RootNewTabKeys` and that bar: one key, two tabs (or two menus).

### Fixes
- `97c06828` Root's empty target gets its own id `ROOT_EMPTY_GROUP_ID`; regression
  test in `SteeringRootChrome.test.tsx` (fails with the old id).
- `c7f43af9` The + menu lookup / add menu in `RootView` still keyed on the
  placeholder id; mapped. Test: the + key opens the menu of an empty Root.
- A stale "with it off the strip is absent" sentence in the `rootConsole.viewStrip`
  register row removed; the empty-Root chord test in `OverlayAgentChord.test.tsx`
  updated to the new id.

### Flagged for user
- None new beyond I2's three. One observation (read from code, not run): Enter on a view tab
  with Enter switches the window to that view while steering stays in the chrome
  region; Escape then returns to the tabs level of whatever is behind (the
  workspace on Now / Projects). Harmless, but the ladder reads `Tabs > Window bar`
  there too.

### Gates (worktree, clean tree)
- `npm run build` ok; `npm run lint` 0 errors (29 warnings, none in touched code);
  `scripts/brand-check.sh` ok; `git diff --check develop..HEAD` clean.
- Full `npm test`: **1067 files, 10873 tests** passed (I2 tip 10871, +2 reviewer
  tests). A first full run found the one test my id change broke
  (`OverlayAgentChord`, fixed in the last commit); a name-by-name run of `develop`
  gave the baseline 1064 / 10857.
- `cargo test --workspace -q` ok (tabtivity 5054, app-serverd, core crates);
  `cargo test -p tabtivity --no-default-features --lib --test server_secrets -q`
  ok (4894 + 1); `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings` clean.
- Not run live.

## I3: F3, F5, F7, F8, F9 (cockpit and Root layout, overlay order)

Commits (worktree `cockpit-followup`): `645bfc34` (F3), `5c6d47ef` (F5), `0ff30ac6` (F7), `280bcb11` (F8), `0a099de2` (F9), then the handoff commit.

### F3: the detail's composer draft across the narrow unmount
- **Verified, not a bug, no code change.** The Reader's composer already keeps an
  unsent draft per tab in `lib/agents/readerDrafts` (the Reader unmounting, the
  Chat/Terminal switch and another tab shown already relied on it), so Now's detail
  pane unmounting loses nothing. A mutation check (dropping the composer's
  `setReaderDraft` effect) fails both tests.
- Test `cockpit/NowDraft.test.tsx` (2): mounts the REAL `TerminalReaderView` where
  `TabPane` would be (stand-in), wide -> narrow -> wide, and narrow list -> detail ->
  back -> detail. Only `TabPane`/`TerminalView` is replaced, so the composer, its
  draft store and the Now/detail mount/unmount path are real.

### F5: Root's sub-bar "Needs you N" chip
- Under 820 px `RootRail` portals Now's chip into a new bar slot `RootBarSlots.chip`
  (before the ⚿ badge): the sub-bar's controls, or the title bar's controls when a split
  Root has no sub-bar. Click opens `NeedsYouPopover` (the same component Now uses);
  a picked row goes to `jumpToRow` like the open rail's.
- **Shared, no variant.** `NeedsYouChip` is extracted from `CockpitNow` into
  `NeedsYouPopover.tsx` and used by both; `useColumnWidth` moved to its own module
  (`cockpit/useColumnWidth.tsx`, with `ColumnGrip`) for F8; Now uses both.
- Closed, the chip reads live stores only (`useDecisionsFor` without extras, the
  header badge's counts); the popover mounts the three loads only while open
  (`RootRailPopover`). The chip shows even at 0, like Now's.
- Tests in `NarrowWindow.test.tsx` (the old "Root has no rail" test now asserts the chip):
  chip in `.root-overlay-subbar`, popover, pick -> `jumpToTab` and the window closes,
  toggle, popover does not outlive the wide band.

### F7: Tonight's Show in a narrow window
- `stores/cockpit`: one-shot `detailAsked` / `askDetail()`. Tonight's Show calls it
  only when the band is narrow; `CockpitNow` takes it (first render when it mounts, and
  an effect, which also focuses the detail) and clears it. Back returns to the list with
  the row still selected.
- Tests `cockpit/TonightShow.test.tsx` (3): narrow lands on the detail then back; wide
  unchanged and no flag left over; a later ordinary narrow Now starts on the roster.
  Mutation checked.
- Only `autoContinue` items have a Show button in Tonight; that is the only entry.

### F8: Root's rail column
- The collapsed icon rail renders nothing while no live-store group has a count. An
  **open** rail stays open when empty (its push / schedule / markup groups are not in
  the live count; the user opened it), folding it then leaves nothing.
- The open rail's width is `useColumnWidth("cockpitRootRailWidth", 280, +1)` + `ColumnGrip`
  (`flex-basis` inline, `max-width: 60%` in CSS). Read tolerantly (`readWidth`: garbage,
  empty, 0, negative, NaN -> 280; out of range -> clamped 220..1100; unreadable storage
  -> 280). Now's rail keeps `cockpitRailWidth`.
- Tests in `RootRail.test.tsx` (+13): empty vanishes and returns, open-and-empty stays,
  280 default + grip, drag + persist + remount + Now's key untouched, clamp, 8 tolerant
  reads, throwing storage. `SteeringRootChrome` "left / right walk" needed an asking tab
  in the store, since the rail toggle it walks to exists only when something waits.

### F9: Machines / Models over the window
- Cause: Machines, Models and the window are `.modal-backdrop` at one z-index, the window
  last in DOM; the Machines handler only deferred to the window for the Root view, so on
  Usage both closed on one Escape (and the overlay sat under the window).
- Rule (a front rule, no remount): the overlay frame sets `stores/consoleCover` on mount
  (`coverConsole(windowOpen)`); the window opening afresh (`show` / `openView` when it was
  closed) clears it; the window then wears `.under-overlay` (`--z-modal` - 1) only while
  the flag is set AND Machines or Models is open (`lib/window/consoleFront`). A
  dialog the overlay raises (host-key, HPC guard, connect) is later in DOM at `--z-modal`,
  so it still lands on top; a z-index above 100 for the overlay would not have kept that.
- Escape: the overlays' handlers defer to the window only when it is in front
  (`consoleInFront()`: open and not covered), the window's handler waits while an overlay
  covers it (`consoleUnderOverlay()`). The old "defer when the Root view is shown" check
  became "when the window is in front, any view".
- The same fix covers the Root view's "Add agent..." (Models overlay, Agents & CLIs), which
  had the same under-the-window landing.
- Tests `cockpit/OverlayOverWindow.test.tsx` (6): overlay in front and Escape order, Escape
  aimed at `<body>` (the old both-close case), window raised later stays in front, window
  reopened clears the flag, Models from the Root view, Models from the header. 3 fail
  without the window's guard. The CSS (jsdom has no layout) is the class only.

### Gates
- `scripts/gates.sh` run before each commit: brand, whitespace, lint (0 errors, no new
  warnings), build, vitest `--changed`, `untested.mjs check`. No Rust touched.
  `MobileTerminalTranscript` "keeps the chat while a /clear sent mid-turn..." failed twice
  in the `--changed` run (not touched by this round; 33/33 alone, three times) and passed
  on the other runs: load-dependent flake.
- Full `npm test`: **1070 files, 10901 tests** passed (tip 1067 / 10873: +3 files = NowDraft, TonightShow, OverlayOverWindow; +28 tests).
- Not run live.

### Flagged for user
- **F3 needed no code**: the draft already survived; there is only the regression test.
- **A split Root has no sub-bar**, so its narrow chip sits in the title bar's cluster,
  which is already tight at 820 px (not looked at, no layout engine here).
- **Root's empty rail cannot be opened** (nothing to open it from): push requests,
  schedule proposals and markup questions do not count toward the collapsed icons (same as
  the header badge), so they are reachable only with the rail already open, or below 820 px
  via the chip, which is always there.
- **F9 limit**: mail / calendar / to-do overlays are also at `--z-modal`; with one of them
  open beneath, a lowered window can paint under it while the Machines / Models overlay is
  up (all of it behind the overlay's own backdrop).
- Tonight's Show reaches Now's detail only for auto-continue rows (the only Show button).

### Click-through (F1-F9)
Chords below are the defaults; all are rebindable in Settings.
1. **F1 project ring lands on Root.** Window closed, workspace on project A. Press the
   steering key (Shift+Space), go to the projects level (Up from the tabs level), press
   `1`, or Left/Right until the ring's first station: the Cockpit window opens on Root,
   the project behind stays A. From a project's station, Right/Left past the end lands on
   Root again; landing on a project from Root closes the window and shows that project.
2. **F2 no flag.** Settings has no "Cockpit" experiment row; the header cockpit button
   opens a window titled "Cockpit" with Now / Projects / Tonight / Usage / Root tabs. If
   `rootConsoleFrame` was never dragged it opens wide.
3. **F3 draft.** Window narrower than 820 px (drag its edge): Now -> pick an agent (opens
   the detail) -> type text in the composer, do not send -> Agents (back) -> open the same
   agent again: text is there. Then widen past 1180 px and back: still there.
4. **F4 chrome level.** On the Root view with steering on, press Up from Root's tabs: the
   cursor sits on the view tab; Left/Right walk the view tabs, ✓, fill and x; Enter on a view
   tab opens that view; Down returns. Ctrl+Shift+N (shell), Ctrl+1 (agent) and steering's `+` /
   `N` open the tab in Root's focused subwindow while Root is shown.
5. **F5 chip.** Narrow the window under 820 px on the Root view with an agent asking: the
   sub-bar shows "Needs you N" (amber while asking). Click: the rail opens as a popover; pick
   a row: the window goes to that tab. Widen: the chip goes, the icon rail returns.
6. **F6 chords.** Root view: Ctrl+W closes Root's active tab, your tab-step chord steps Root's tabs. On Now, Ctrl+W and the tab chords do nothing to the
   project tabs behind the window.
7. **F7 Tonight Show.** Under 820 px, give an agent "auto-continue" so Tonight lists it, open
   Tonight, press Show: Now opens on that agent's detail with the row selected; Agents
   returns to the list with the row still highlighted. Wide, Show selects it beside the roster.
8. **F8 rail.** Root view with nothing waiting: no 40 px column at the left. Make an agent
   ask: the column appears. Open it (click an icon): drag its right edge to resize; close and
   reopen the window: the width is kept. Now's rail width is separate.
9. **F9 overlays.** Usage view -> "Open Machines" (needs at least one machine): the Machines
   overlay is in front of the window. Escape closes only Machines; a second Escape closes the
   window. Same from the Root view's `+` -> "Add agent...": the Models & agents overlay is in front.
   Open Machines from the header first, then Ctrl+Shift+R: the window is in front, Escape closes it
   first.
