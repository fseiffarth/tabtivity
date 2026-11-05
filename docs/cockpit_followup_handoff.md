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
