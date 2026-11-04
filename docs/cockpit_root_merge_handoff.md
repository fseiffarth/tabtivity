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

## I2 (A4 + A9)

### A4 Root view chrome (plan M3)

- sha: `d29dcad0`.
- **Sub-bar.** The shell derives `split` from root's layout in the store and
  `subBar = cockpitOn && view === "root" && !split`. With a sub-bar the three
  slots (strip, rights, files) are rendered in a second `.tab-bar
  .root-overlay-bar.root-overlay-subbar` row under the title bar (own
  `.tab-controls` cluster, which now takes `controlsStyle`, the docked file
  column's reserved width); without it they stay in the title bar exactly as
  before. `RootBarSlots` is unchanged; the same callback refs feed whichever
  host renders. The sub-bar forwards the bar's move/fill handlers.
  Flag on + split: no sub-bar, the ⚿ badge stays in the title bar.
- **Root tab lamp.** `lib/cockpit/scopeLamp.ts` (pure: asking = agent tab with
  a decision that is not working, the header badge's rule; working = busy PTY
  tab) read by `RootTabLamp` in the shell (own component, so a busy terminal
  re-renders the tab and not the window). The tab wears the strip's own state
  classes (`attentionStateClass`/`busyStateClass`), a `TabStatusMark`, and an
  amber `.root-view-count` (`cockpit.view.rootAsking` as title/aria). A question
  outranks work. Reads root's tab list and the activity store only.
- **Start action.** `layout/RootStartAgent.tsx` on the empty card (flag on):
  `useAddTabMenuData(ROOT_SCOPE)` -> `agentShortcutSlots(...)[0]` ->
  `buildStaticTabSpec` -> the view's `addTab`; no root-allowed default agent
  shows the `overlayAgent.rootNotAllowed` hint; nothing while the probe is
  pending. Mounted only on the empty card, so the agent probe runs only there.
  Class `.center-placeholder-action` (the empty-state button elsewhere).
- **Flag-off pill (the reviewer's flag): fixed.** It was a difference introduced
  on this branch: `OverlayApprovals` brought its own `overlayApprovals.button`
  tag, which the old console's inline ✓ never had, and A1 had also moved
  `rootOverlay.1` before the ✓. Now `OverlayApprovals` takes `untested`
  (default true; the console passes `untested={cockpitOn}`) and `rootOverlay.1`
  / `rootOverlay.viewers` sit after the ✓ again, so flag off the bar's pills are
  ⚿, ✓, the two tags, as on develop. Test: `RootViewChrome.test` "carries
  exactly the pills the console always had" (fails without the prop).
  Flag on the ✓ keeps its own tag. Known difference left alone: the ⤢ button's
  title is the shared `floatingFrame.*` hint, not `rootConsole.fill/restore`
  (A1's choice).
- Keys (five dictionaries): `rootConsole.emptyStart` ("Start {agent} in Root"),
  `cockpit.view.rootAsking`. Register rows: `rootConsole.subBar` (its pill sits
  in the sub-bar's cluster), `rootConsole.emptyStart`.
- Tests: new `__tests__/root/RootViewChrome.test.tsx` (16): `scopeLamp`, sub-bar
  placement and file toggle, split drops it, none on a cockpit view, lamp
  quiet/asking/working/outranks, Start (opens a root agent, hint when not
  allowed, absent flag off), flag-off bar and pills.
- Gates: `scripts/gates.sh` (brand, whitespace, lint, build, vitest --changed)
  green before the commit.

### A9 Needs-you icon rail (plan M8)

- sha: `eaa467ee`.
- `components/cockpit/useCockpitData.ts`: `useRosterInputs(scopes, now,
  { refresh })` (false = no model-store reads); new `useDecisionsFor(scopes,
  extras?)`: rows -> `buildDecisions` with `useDomainReview().waiting` and
  `useAlertsFeed()`; no `useCockpitNow`, `now` is only the minute. `CockpitNow`
  is untouched (it still builds its own pipeline).
- `CockpitRail` gained two optional props: `onPick(row)` (default: select for the
  detail pane) and `headAction`; `GROUP_LABEL` is exported.
- `cockpit/CockpitRailIcons.tsx`: the 40 px `<nav>`: expand button, one button per
  non-empty group (icon + count, `group-asking` amber, `group-interrupted` red);
  `onMouseDown preventDefault` so a press leaves a terminal's focus alone.
- `cockpit/RootRail.tsx`: fold in `storageKey("cockpitRootRail")` ("open" /
  "closed", default collapsed); collapsed = `CockpitRailIcons` over
  `useDecisionsFor(scopes)`; open = the real `CockpitRail` in
  `.cockpit-root-rail-full` (280 px) plus the loads that need a read
  (`usePushRequests`, `useLoadSchedules`, `useScheduleProposals`,
  `useMarkupAsks`), scrolled to the clicked group. Mounted by `RootView` as the
  first child of `.subwindow-body` when the flag is on. A picked row: a root row
  -> `rootOverlay.show(tab.key)` (no close), any other -> `jumpToRow`.
- Keys: `cockpit.rail.expand`, `cockpit.rail.collapse`. (The plan's
  `cockpit.rail.collapsed` was not needed.) Register row `cockpit.rootRail`
  (pill: inside the icon nav, vertical; in the open rail's heading).
- CSS in `styles/cockpit.css` (end of file): flat, static, no animation.
- Tests: new `__tests__/cockpit/RootRail.test.tsx` (11).
- Gotcha: tests that open a cockpit view through the real lazy
  `CockpitViewBody` time out under a loaded full run; mock
  `components/cockpit/CockpitViews` (done in both new files).

### Gates / tests (I2)

- `scripts/gates.sh` green before each commit (brand, whitespace, lint 0
  errors / 29 advisory warnings unchanged, build, vitest --changed). No Rust.
- Full `npm test` at the A9 tip: **1061 files, 10816 tests** passed (tip before I2:
  1059 / 10789; +2 files, +27 tests = 16 + 11).
- Not run live (never started the app).

### Flagged for user (I2)

- **Empty icon rail.** With the experiment on, Root always has the 40 px column
  (just the expand button when nothing needs you), as the design says
  ("collapsed by default"). If a permanently empty strip beside the terminals
  is unwelcome, hide it while `decisions.groups` is empty; not done.
- **The open rail is 280 px, fixed** (no grip). The Now view's rail resizes
  (`cockpitRailWidth`); Root's does not.

## I3 (A5 + A6)

### A5 Entry points (plan M4)

- sha: `c1b4842d`.
- `jumpToTab(ROOT_SCOPE, key)` calls `rootOverlay.show(key)` and returns (outside
  a popout; inside one the old forwarded `setActive` path stays). It never
  reaches `bringUpScope`, so no caller can `setActive(null)` with a root tab.
  `openPromptChartTab(ROOT_SCOPE)` still goes through `bringUpScope` (the plan's
  call; a comment says so, and a test pins it).
- `jumpToRow`: a root row leaves the window up (it just opened Root in it);
  every other row still closes. `CockpitRail`'s markup row now goes through
  `jumpToRow` (it did `jumpToTab` + `close()`, which would have closed the Root
  view it opened for a root-tab ask). `RootRail.pickRow` is just `jumpToRow`.
- Caller audit (all route through `jumpToTab`, so the fix is at the one place):
  `useKeyboard` status keys, `CommandPalette`, `PillStatusBars`, `PillTabMarks`,
  `TodoCard` (closes the to-do overlay first, then the Root view opens),
  `PromptChart`, `AgentSchedulesView`, `CockpitRail`, `CockpitRoster`. Two
  follow-on fixes found in the audit:
  - Steering status keys walked on from the workspace's `activeKey`; a root
    jump no longer changes it, so pressing the key again landed on the same root
    tab forever. `statusJump.shownStatusTab()` is the Root view's focused tab
    while Root is up, else the workspace's.
  - `CommandPalette.showTab` "open beside" would `splitWithTab` a root tab into
    the workspace when `scope === tabs.scope === root`; root tabs now always
    take `jumpToTab`.
- Already done by I1 and verified, nothing to change: gauge, steering **U** and
  the box chip open Now; Machines/Models Escape guards use `rootViewShown`;
  `closeOverlay()` callers; Ctrl+N's "console steps aside" keeps `open`.
- The remaining `rootViewShown` swaps are in A6's commit (they are the
  ownership rule, not an entry point): `OverlayAgentColumn`, `sourceJump`,
  `openTexWorkspace`, `CenterPanel.drawnElsewhere`. `AssistantView`'s focus rule
  and `CenterPanel`'s slot stand-down/focus rule keep `open`, as planned.
- Tests: new `__tests__/cockpit/JumpToRootRow.test.ts` (5: root row opens Root
  with scope/activeId unchanged and no close; project row and other project
  close; `shownStatusTab` both ways); `TabJump.test` (the old "root = null
  project" case replaced by the regression: no `setActive`, scope unchanged;
  popout keeps old path; the prompt-chart case); `CockpitNow` (Enter on a root
  row); `RootRail` (pickRow -> `jumpToRow`).

### A6 Ownership (plan M5)

- sha: `203907cd`.
- `CockpitRoster.ScopeChip` (also used in `CockpitDetail`): the root scope's chip
  is the `StarIcon` + "Root" (`cockpit-chip root`). The detail head's button
  reads "Open in Root" (`cockpit.detail.openInRoot`) for a root row, "Jump to
  tab" otherwise; both call `jumpToRow`.
- `CockpitDetailPane`: mode `console` / `inConsole` / `cockpit.detail.inConsole`
  removed. New mode `docked`, from `useDockedApp(scope, key)`: an app (mail,
  calendar, todo) whose overlay is open (+ its settings gate) with its dock open
  on that root key draws the tab in `OverlayAgentColumn`, so the pane shows
  "Shown in the {name} overlay." (`cockpit.detail.docked`) and mounts no
  `AttachedAgentPane`. Otherwise a root tab attaches like any tab; it marks root's
  `shownKeys`. The Root view is never mounted with Now, so "never two attached
  views of one PTY" holds structurally; the docked case is the only second
  drawer, and it is now excluded.
- `{app}` is the brand placeholder in the dictionaries: the docked string uses
  `{name}` (a param called `app` rendered "Shown in the Tabtivity overlay").
- `rootViewShown` replaces `open` in `OverlayAgentColumn` (`consoleOpen`: the
  column keeps drawing while the window is on a cockpit view), `sourceJump`
  `tabKeyForPath`, `openTexWorkspace`, and `CenterPanel`'s `drawnElsewhere`
  (`rootDrawn || shownKeys.has(key)`): opening Projects/Usage/Now no longer wakes
  every sleeping root terminal; a root tab drawn by the Now pane wakes just that
  one; Root's view wakes all, as before. Root's slot stand-down and focus still
  follow `open`.
- Now never hydrates root: untouched (no `ensureRootScopeHydrated` anywhere in
  the cockpit views; `CockpitShell` already tests it).
- `PaneStandDown` is unchanged: it only exists for `scopeShownKeys` (non-root),
  and root tabs' slots are left blank by `slotShown`, so "root's own line" never
  applies.
- Keys (five dictionaries): `cockpit.detail.openInRoot`, `cockpit.detail.docked`;
  `cockpit.detail.inConsole` deleted. Register row `rootConsole.rootRow` (pill:
  the detail head of a root row, and the docked note).
- Tests: `CockpitStandDown` (root tab attaches via root's set; docked draws
  nothing and names the overlay; overlay open/close hands the PTY over with
  exactly one attached view at each step, using a reduced `MailColumn` that
  mounts the real `AttachedAgentPane`; a project tab is never docked);
  `CockpitNow` (star chip, Space draws it, "Open in Root"); `OverlayAgentColumn`
  (stands down on Root only); `CenterPanelRootStandDown` (a cockpit view hides
  the slot too); `SleepingTabs` (Projects does not wake, Now's pane wakes one,
  Root wakes all).

### Gates / tests (I3)

- `scripts/gates.sh` green before each commit (brand, whitespace, lint 0
  errors, build, vitest --changed). No Rust. Full `npm test` at the A6 tip:
  **1062 files, 10832 tests** passed (I2 tip 1061 / 10816: +1 file, +16 tests).
- Not run live (never started the app).

### Flagged for user (I3)

- **Steering status keys with a root target** still `setLevel("tabs")` after the
  jump, as before, but the tab level walks the workspace's tab bar behind the
  Root view. Kept (the repeat key now advances correctly); say if steering
  should rather hand the keyboard to the Root terminal (`exitSteering`).
- **Docked-note scope.** "Shown in the <app> overlay" appears only while that
  overlay is open and its dock open on the key. A docked agent whose overlay is
  shut is drawn by the pane (the column is not mounted), which is the intent.
- `openPromptChartTab(ROOT)` still switches the workspace to root
  (`bringUpScope`); the plan keeps it, but it is the same bug class.

## Next (I4: A7 narrow windows + A8 strings, docs, filemap)

- A8 owes the filemap rows for I1-I3 new files: `layout/RootStartAgent.tsx`,
  `cockpit/RootRail.tsx`, `cockpit/CockpitRailIcons.tsx`,
  `lib/cockpit/scopeLamp.ts`, `lib/cockpit/views.ts`, `lib/window/floatingFrame.ts`,
  `layout/RootView.tsx`; plus `docs/context/root_console.md` / `cockpit.md` text:
  the detail pane's root rule is now "attach via root's shownKeys, `docked`
  note, no `console` mode", `jumpToTab` root rule, `drawnElsewhere` rule.
- A8 rewording list: `cockpit.standDown` / `cockpit.showHere` (still project-tab
  only), `settings.cockpit(+Help)`, untested rows `cockpit.title`,
  `cockpit.indicator`, `rootOverlay.1`, `cockpit.standDown`; `rootConsole.rootRow`
  is already added. Unused after A1: `rootConsole.moveHint/resizeHint/fill/restore`.
- A7: the Root rail's open state is a fixed 280 px (`.cockpit-root-rail-full`);
  the Now view's rail resizes. The icon rail is shared with the narrow band
  (`CockpitRailIcons`): `RootRail.tsx` is the example of how to open the full
  rail from it (`onExpand(group)`).
- `jumpToRow` is the one door for "go to this roster tab": use it, not
  `jumpToTab` + `close()`, in any new narrow-band control.
- Tests opening a cockpit view must mock `components/cockpit/CockpitViews`.

## Next (was: I3, done above)

- `RootRail.pickRow` special-cases a root row with `show(key)` because
  `jumpToRow` still closes the window and goes through `bringUpScope` for a
  root row. After A5 fixes `jumpToRow`/`jumpToTab` for root, `pickRow` can call
  `jumpToRow(row.ptyId)` alone (the test mocks `CockpitRoster.jumpToRow`).
- The Root tab lamp and rail read only live stores; keep them out of any A6
  "who draws the PTY" rule (they draw nothing).
- Filemap rows (`docs/filemap_frontend.md`) for new files are still A8:
  `layout/RootStartAgent.tsx`, `cockpit/RootRail.tsx`,
  `cockpit/CockpitRailIcons.tsx`, `lib/cockpit/scopeLamp.ts` (plus I1's).
- Unused after A1: dictionary keys `rootConsole.moveHint/resizeHint/fill/restore`.
