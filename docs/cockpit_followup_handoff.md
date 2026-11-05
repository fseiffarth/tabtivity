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
