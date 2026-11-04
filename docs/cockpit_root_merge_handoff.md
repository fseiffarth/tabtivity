# Cockpit + root console merge: handoff

Running log of the implementers of `docs/cockpit_root_merge_plan.md`, one
section per A-step. Baseline before the first edit (develop `b3abe5ba`):
**1058 test files, 10775 tests**.

## I1 (A1 + A2 + A3)

### A1 Shared chrome (plan M0)

- sha: filled in by the A2 commit (`git log --grep "shared chrome"`).
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
