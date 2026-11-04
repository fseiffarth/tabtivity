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

- sha: see `git log --grep "split the root console"`.
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
