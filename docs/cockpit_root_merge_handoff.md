# Cockpit + root console merge: handoff

Running log of the implementers of `docs/cockpit_root_merge_plan.md`, one
section per A-step. Baseline before the first edit (develop `b3abe5ba`):
**1058 test files, 10775 tests**.

## I1 (A1 + A2 + A3)

### A1 Shared chrome (plan M0)

- sha: `df3cedce`.
- `lib/window/floatingFrame.ts` (new) holds the pure frame math and types moved
  out of `stores/rootOverlay.ts` (names unchanged: `RootOverlayFrame`,
  `clampRootOverlayFrame`, ...). `useFloatingFrame` imports it, also returns
  `framing`, and its `BAR_NO_DRAG` gained `.root-overlay-rights`.
- `RootOverlay.tsx` takes its frame from `useFloatingFrame(storageKey(
  "rootConsoleFrame"))`; the store lost `frame/filled/setFrame/toggleFilled`.
  The persisted row is the same `{frame, filled}`; a test opens at a frame
  written under the old key.
- The console's ✓ is `<OverlayApprovals advisory={rights.reviewAdvisory}/>`
  (new `advisory` prop). `rootReview.panel/setPanel`, the anchor effect and the
  unmount cleanup are gone; the Escape guard is `e.defaultPrevented`.
- Choices: the `rootOverlay.1` UntestedTag now sits right after the ⚿ badge
  (it is the ⚿ half); OverlayApprovals brings its own `overlayApprovals.button`
  pill after the ✓. `rootConsole.moveHint/resizeHint/fill/restore` keys are
  now unused in code (no other users found); left in the dictionaries, I4 may
  delete them with the parity test.
- Gotcha: a keydown test must fire on `document.body`, not `window`, for the
  portal's document-level Escape handler to run before the shell's.
- Tests moved/added: frame math -> `__tests__/windows/FloatingFrame.test.ts`;
  `OverlayApprovals.test` +2 (whole queue + advisory note); `RootOverlay.test`
  +2 (Escape closes the panel first; opens at an old-key frame).
- Gates: brand, whitespace, lint, build pass; full vitest 1059 files, 10779
  tests (baseline + 4 new).

### A2 Split (plan M1)

- sha: `deb1ea23`.
- `layout/RootOverlay.tsx` (~290 lines) = `RootOverlayHost` + the shell
  (`RootOverlay`: backdrop, frame, bar, controls, Escape, `useRootMcpRights`,
  `loadAgentDrafts` on mount). `layout/RootView.tsx` (new) = everything else:
  layout tree, pane layer, tab drag, `GroupStrip`, `+` menu, `manageAgents`,
  file column, `TabScopeContext.Provider`. Pure move apart from the seams below.
- **Bar slots** (`RootBarSlots`, exported from `RootView.tsx`): the shell renders
  three `display: contents` elements (`.root-overlay-slot`) and keeps them in
  state via callback refs; the view portals into them: `strip` (after the star:
  sole group strip + `+`), `rights` (first in the control cluster: ⚿ badge),
  `files` (before ⤢: ◫ toggle). I2's sub-bar must hand the same `RootBarSlots`
  shape (three elements + the two bar handlers + `setControlsStyle`).
- Seams the plan did not spell out:
  - A portal bubbles React events through the view, not the bar, so the strip
    slot's wrapper forwards `onBarPointerDown`/`onBarDoubleClick` (else the empty
    strip area would stop moving/filling the window).
  - The control cluster's reserved width (docked file column, unsplit) is view
    state: the view calls `slots.setControlsStyle({width})` in a layout effect.
  - `busyRef` (set by the view in a layout effect from `addMenu || manageAgents
    || dragging`) is what the shell's Escape reads, plus `framing` and
    `defaultPrevented`; the region check is `target.closest(".root-overlay-region")`.
  - The frame's `dragging` class (CSS `.root-overlay.dragging .pane-layer`) moved
    to the region (`.root-overlay-region.dragging`); `split-layout` was dead and
    is gone.
  - CSS: `.root-overlay-slot { display: contents }` and a margin reset for the
    ◫ toggle in its slot (`.tab-controls > .subwindow-files-toggle` no longer
    matches a portaled child).
  - The `TabScopeContext.Provider` is now only around the view, not the shell's
    ✓ pill (it needs no tab scope).
- Gates: brand, whitespace, lint, build, vitest pass; full vitest 1059 files, 10781 tests (A1 + 2).
- Tests: existing suites untouched except the earlier A1 edits; +2 in
  `RootOverlay.test` (strip/badge/toggle in the bar; Escape defers to the +
  menu).

### A3 One surface (plan M2)

- sha: the commit whose subject ends `(one surface)`; `git log --oneline | head -3`.
- `lib/cockpit/views.ts` (new): `CockpitView`, `COCKPIT_VIEWS`; `stores/cockpit`
  re-exports them and lost `overlayOpen/view/openOverlay/closeOverlay/
  toggleOverlay/setView` (`showScope` no longer sets a view). `lastClosedAt`
  stays there.
- `stores/rootOverlay`: `view: "root" | CockpitView` (`RootOverlayView`),
  `openView(view)` (`"root"` = `show()`; a cockpit view never hydrates root),
  `rootViewShown(state)` (`open && view === "root"`), `show()` forces Root,
  `close()` keeps `view`. **`toggleRootConsole` already encodes decision 4**
  (closed -> Root, other view -> Root, Root -> close) so the intermediate commit
  is coherent; A5 only needs the `useKeyboard` side.
- Shell (`RootOverlay.tsx`): view strip `role="tablist"` (`.tab` strip, roving
  Left/Right focus, Enter/Space choose) + divider + Root tab (star), only with
  the `cockpit` experiment; effective view is `root` with the flag off;
  `CockpitViewBody` is `React.lazy` inside `Suspense`; box filter on cockpit
  views only; window label/aria `cockpit.title` (flag on) or `rootConsole.title`;
  flag on = `app-overlay-backdrop` + `.root-overlay-wide` (shared overlay size);
  one Escape rule (defers to `.root-overlay-region`, `.cockpit-detail-pane`,
  `busyRef`, `framing`, `defaultPrevented`).
- `lastClosedAt` is stamped by a store subscription in `RootOverlayHost` (open
  -> closed while the previous view was not Root), not an unmount cleanup:
  StrictMode's simulated unmount would have stamped on open, and the
  subscription catches every close path.
- Deleted `cockpit/CockpitOverlay.tsx` and `LazyCockpitOverlayHost`; CSS:
  `.cockpit-overlay` removed from both `mail-todo.css` lists, new
  `.root-overlay-wide`, view-strip rules in `subwindows.css`.
- Keys (all five dictionaries): `rootConsole.view.root`, `rootConsole.viewStrip`
  (aria label). Register row `rootConsole.viewStrip`.
- **Mechanical rewiring beyond the plan's A3 file list** (the build would not
  pass otherwise; semantics stay A5/A6): `closeOverlay()` callers ->
  `rootOverlay.close()` (`CockpitRoster.jumpToRow`, `CockpitRail`,
  `CockpitProjects.openProject`, `CockpitTonight`, `CenterPanel` Show here);
  `openOverlay()` -> `openView("now")` (`useKeyboard` U, `BoxScopeChip`);
  `CockpitIndicator` reads/toggles `rootOverlay` (`view !== "root"`);
  `CockpitProjects` Agents button and `CockpitTonight` autoContinue call
  `openView("now")`; Machines/Models Escape guards use `rootViewShown` (else,
  with Usage up, `open` would swallow their Escape).
- **Still A5/A6 work:** `jumpToRow` for a root row (`show(key)`, no `close()`),
  `tabJump.ts`, `CockpitDetailPane`'s `inConsole` mode (reads `rootOverlay.open`,
  so with Now up every root row currently shows the "console is open" note),
  `OverlayAgentColumn`/`sourceJump`/`openTexWorkspace`/`CenterPanel` `open` ->
  `rootViewShown` swaps, `AssistantView`.
- Intermediate-state notes for I2: with the flag on, Root's sole-group strip
  portals into the strip slot right after the Root tab in the title bar (no
  sub-bar yet); the Root tab has no lamp yet. The `rootOverlay.1` /
  `rootOverlay.viewers` pills only render on Root.
- Gates: brand, whitespace, lint, build, vitest (changed set) pass; full vitest
  1059 files, 10788 tests (baseline 10775 + 13: A1 +4, A2 +2, A3 +7). One
  full-run failure, `FocusRing` (bare `var(--accent)` outline in my new
  `.root-view-tab:focus-visible`), fixed to `--focus-ring`; theme suite rerun green.
- Tests: `CockpitShell.test` is now the merged shell test (10 cases + the
  indicator); `CockpitNow/ProjectsView/StandDown` use `rootOverlay` for open/
  view.

## Review of I1 (A1-A3, range `develop..8b9c293c`)

Read the whole diff against the plan; compared the old `RootOverlay` body with
`RootView` (normalised diff: a pure move apart from the seams the A2 notes name).
Checked: the `rootConsoleFrame` row (old store and `useFloatingFrame` read and
write the same `{frame, filled}`, same clamp; the cockpit store held no
persisted state, `cockpitOverlayFrame` has no other reader); the shell's Escape
(`busyRef` is read synchronously, so a native Escape that also closes the `+`
menu still defers, as the old closure did), `framing`, `defaultPrevented`,
`BAR_NO_DRAG` + `.root-overlay-rights` (the portal does not bubble to the bar,
the strip slot forwards press/double-click, the ⚿/◫ portals need none: both are
no-drag); no child selector on `.tab-bar` breaks under the `display: contents`
slots; `.root-overlay.dragging` is gone from CSS and JS alike; the ✓ panel needs
no `TabScopeContext`; the cockpit body still gets `.subwindow-body` + the
`.cockpit-overlay-body` rule after the `mail-todo.css` list entries went;
`CenterPanel` only lost an import and swapped `closeOverlay`; lazy mount (the
body is `React.lazy`, no listener/timer outside the host's own); i18n keys in
all five dictionaries; register row present; no animation added; the moved frame
tests are all in `FloatingFrame.test.ts`.

### Fixed

- `a1f63d22` **Experiment switched off under an open cockpit view.** The shell
  showed Root (effective view) but the store kept e.g. `view: "usage"`, so
  `rootViewShown` was false: Ctrl+Shift+R "switched to Root" instead of closing
  the console, and the Machines/Models Escape guards misread it. Flag off must
  be today's console; an effect in the shell now writes `view: "root"` back.
  Regression test in `CockpitShell.test` (failed before the fix).

### Not bugs, noted

- Flag off, the console bar now carries one extra `UntestedTag` pill
  (`overlayApprovals.button`, after the ✓). Cosmetic and a dev marker; I1 chose
  it knowingly. See Flagged.

### Gates / tests

- Full `npm test`: **1059 files, 10788 tests** passed (same as I1's claim; the
  `FocusRing` fix holds), plus 1 new test from the fix = 10789 at the tip.
- `npm run build`, `npm run lint` (0 errors, 29 advisory warnings, none in
  touched lines), `scripts/brand-check.sh`, `git diff --check`: clean. No Rust
  touched, so no cargo gate; `scripts/gates.sh` on the clean tree selects none,
  the gates above were run by hand.
- Not run live (never started the app).

## Flagged for user

- **Machines overlay under the window (pre-existing, not new).** The Machines
  overlay (AppShell, mounted before the root host) and the Usage view's "Open
  machines" button: both are `.modal-backdrop` at one z-index, DOM order decides,
  so Machines opened from Usage lands UNDER the window, exactly as it did under
  the old cockpit overlay (also mounted later). The plan's "check the door still
  shows on top" does not hold today. Fixing it means either raising Machines
  above the root host (then a terminal sign-in opened from Machines lands under
  it) or having the Usage door step the window aside; not decided here.

- **Extra pill in the flag-off console (review of I1).** `OverlayApprovals`
  brings its own `overlayApprovals.button` UntestedTag after the ✓, so the
  experiment-off console shows one more "untested" pill than today. Decision 2
  says "exactly today's console"; the pill disappears once that row is stamped
  tested. Drop it for the console (a prop) or keep it?
- **Escape inside the Machines overlay opened from Usage.** With Machines under
  the window (above), both the window's and Machines' window-level Escape
  handlers fire on one key and both close. Pre-existing (the old cockpit
  overlay did the same); falls out if Machines is raised above the host.

## Next (I2: A4 Root view chrome + A9 icon rail)

- Start from `RootView.tsx` / `RootBarSlots` (see A2). The sub-bar is a second
  host of the same three slots: a row under the title bar (flag on, unsplit
  Root only) containing a strip slot, a rights slot and a files slot, passed to
  `RootView` instead of the title bar's. The shell currently renders the strip
  slot right after the view strip in the title bar; move that slot into the
  sub-bar and keep the rights/files slots wherever the sub-bar wants them
  (`rights`/`files` currently live in the title bar's control cluster).
  `setControlsStyle` reserves width on the title bar's cluster; the sub-bar
  would own its own equivalent. The split layout keeps per-group strips and
  drops the sub-bar (existing behaviour of `stripFor`).
- The Root tab (`viewTab("root", ...)` in the shell) is where the lamp goes.
  Reuse the tab strip's lamp classes (`attentionStateClass`/`busyStateClass`,
  `TabStatusMark`); read `stores/activity` for `ROOT_SCOPE` only.
- Empty card ("Start <agent> in Root"): `rootConsole.emptyTitle/emptyHint`
  live in `RootView`'s `tabs.length === 0` branch.
- Register rows to add: `rootConsole.subBar`, `rootConsole.emptyStart`
  (`rootConsole.viewStrip` already exists); keys `cockpit.view.rootAsking`,
  `rootConsole.emptyStart`, all five dictionaries.
- Hook tests that mock `TabPane`/`NewTabMenu` (`__tests__/root/RootOverlay.test`)
  show how to render the host; the flag is `useSettingsStore.setState({
  settings: { cockpit: true, experimental_explicit: true } })`.
- Filemap rows (`docs/filemap_frontend.md`) for `RootView.tsx`,
  `lib/window/floatingFrame.ts`, `lib/cockpit/views.ts` and the deleted
  `CockpitOverlay.tsx` are not yet updated (plan: A8).
- Unused after A1: dictionary keys `rootConsole.moveHint/resizeHint/fill/restore`.
