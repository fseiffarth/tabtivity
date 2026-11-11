# Steering inside popout windows — implementer's handoff

Plan: `docs/steering_popout_plan.md`. Worktree branch starts at `develop`
40f3918b2. Nothing here was run live (the app is never started by the
implementer); everything below is verified by tests and gates only.

## Step 1 — pure move to `hooks/useSteering.ts`

Commit: (see `git log`; message `refactor(steering): move steering mode into useSteering`)

- `src/hooks/useSteering.ts` holds everything from "Keyboard steering mode"
  through `steerKey`, the scroll-release subscription, the layer observer,
  `STATUS_ACTIONS`, `cycleProject` / `landOnStation` (exported; `useKeyboard`'s
  cycle chords import `cycleProject`), `BESIDE_ACTIVE`,
  `STEERING_BLUR_GRACE_MS` (re-exported from `useKeyboard` so the tests and
  any importer keep working).
- `useKeyboard` calls `useSteering({ surface: "main", onTogglePanels,
  onSidePanel })` before its own effect, so the document capture listeners
  are still added before the window ones.
- Choice: the blur grace lives entirely in `useSteering` (its own window
  `blur` / `focus` listeners) instead of `useKeyboard`'s blur handler calling
  `noteBlur` / `noteFocus` as the plan sketches. Same behaviour, and the popout
  surface gets the grace for free. `useKeyboard`'s `onBlur` keeps the Super
  and subwindow-nav resets only; its `focus` listener is gone (it did only
  steering).
- `onTogglePanels` is optional in `SteeringOptions` (a popout has none).
- Net: `src/__tests__/shell/Steering*.test.tsx` + `cockpit/Steering*.test.tsx`
  before: 28 files / 291 tests; after: 28 files / 291 tests, untouched.

## Step 2 — popout as a steering scope

Commit: `feat(steering): a popout's tabs are a steering scope`

- `src/stores/popoutView.ts`: `scope`, `popoutId`, `label`, `tree`, `tabs`,
  `focusedGroupId`; `setView` (focus kept while its group survives, else the
  first group), `focusGroup` (ignores ids not in the tree), helpers
  `popoutFocusedGroup`, `popoutActiveTab`, `popoutTab`. No runtime import of
  `stores/tabs` (that store imports it).
- Choice: `DetachedCenterPanel` writes `scope` / `popoutId` / `tree` / `tabs`
  (a `useLayoutEffect` on its props) and reads/writes focus through the store;
  `DetachedApp` writes only `label`. The plan has `DetachedApp` write
  tree/tabs at every `setGroup` / `setTabs`; writing from the panel's props
  covers every one of those (seeds and optimistic edits) in one place and keeps
  the many tests that render `DetachedCenterPanel` alone working. The
  `onFocusedGroup` prop and `focusedGroupRef` are gone; the store seam's
  `targetGroupId` reads the store.
- `steeringScope.ts`: `SteeringTabs.popout`; `steeringTabs()` /
  `steeringTabsActive()` read the popout view when `isDetachedWindow()`;
  `steeringInRoot()` is false in a popout; `useSteeringTabs()` added.
- `stores/tabs.ts` popout branches (helper `popoutOwns(scope)`: context present
  and scope is the popout's): `focusGroupInScope` → view focus;
  `setGroupActiveInScope` → focus + `activate` edit (only when the tab is in
  that group); `setGroupFilesInScope` → `files` edit; `removeTabInScope` →
  `ctx.closeTab`. `focusGroup` resolves its scope like `addTab` does
  (`ctx.scope` in a popout).
- `closeTabInScope`: in a popout the tab comes from the popout view; the tmux
  kill runs; the reopen record is NOT written in the popout heap, because the
  main window already records it from the popout's `close` edit with
  `user: true` (`noteClosedPopoutTabs`). See Flagged.
- `newTabChord.targetGroupId()` and `statusJump.shownStatusTab()` go through
  the popout view.
- Tests: `src/__tests__/shell/SteeringScopePopout.test.ts` (6),
  `windows/DetachedTwoHeap.test.ts` +4 routing cases (24 → 28). The harness
  `Heap` gained `popoutView`.

## Flagged for user

- Closing a popout tab with its × does not end the tab's minted local tmux
  session (`local_tmux_kill`); the main window's × does (`closeTabInScope`).
  Steering's W in a popout goes through `closeTabInScope`, so it does end it,
  per the plan. Not changed for the ×: whether the popout × should also kill
  the session is a behaviour decision outside this plan.

## Gotchas for whoever continues

- Shell output here goes through the `rtk` proxy: use `rtk proxy <cmd>` for
  raw eslint / grep output.
- Compound shell commands (pipes into `{ …; }`, `cp` chains) are refused by
  the worktree guard; edit through scripts in the scratchpad or plain calls.
