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

## Step 3 — steering runs in the popout

Commit: `feat(steering): steering runs inside a popout window` (one commit: the
planned 3a / 3b split was dropped because both halves touch
`DetachedCenterPanel` and `DetachedApp`).

### Core, bar, title bar

- `useSteering` surface `"popout"`: `focusSomeGroup` writes the popout view's
  focus; no root-console / project-shell / reopen chords (DetachedApp's own
  Ctrl+Shift+T stays); no `carryFullscreen`; Up from tabs with one subwindow,
  or from the subwindows level, enters region `chrome` (never `projects`); Up
  in `chrome` is a no-op until step 4; `steerCommon` swallows every
  `POPOUT_HANDS_OVER` action (step 4/5 send them).
- Choice: `POPOUT_MAIN_ONLY` / `POPOUT_CROSS_WINDOW` / `POPOUT_HANDS_OVER` live
  in a new `src/lib/shortcuts/steeringPopout.ts`, not inside `useSteering.ts`
  as the plan says: the legend's key table (`shortcuts.ts`) needs the main-only
  set too and must not import a hook.
- `steeringRegion.ts`: `regionRoot("chrome")` in a popout is
  `.detached-titlebar`; `regionTargets` keeps to `.detached-titlebar-actions,
  .detached-titlebar-controls` there and does not apply the `.wm-controls`
  exclusion inside it.
- `shortcuts.ts`: `SteeringGroup` `"main"` (label
  `steeringKeys.section.mainWindow`); `SteeringLegendState.popout`; conditions
  `upToTitleBar`, `titleBarRegion`; `chromeRegion` and `upToProjects` are false
  in a popout; rows for ↑ to the title bar, ←/→ along it and ↓ back;
  `steeringKeysFor` regroups the main-only rows as `"main"` in a popout.
- `steeringBar.ts`: `ladder({ popout })` = Main window › Title bar › Subwindows
  › Tabs › Inside (Subwindows rung kept with one subwindow: HEAD always shows
  it; the other session's change hides it); `regionLabel()` names chrome
  "Title bar" in a popout; `BAR_ORDER` ends with `"main"`.
- `SteeringLegend`: reads `useSteeringTabs()`; `popouts` is true in a popout;
  counts and Back come from `popoutView.status` in a popout (zeros until
  step 5); its cap observer falls back to `.detached-center`.
- `DetachedApp`: chord effect deleted; `useSteering({ surface: "popout" })`;
  mounts `ShortcutHelpOverlay`, `SteeringLegend`, `SteeringPromptOverlay`,
  `SteeringConfirmOverlay` (not `SteeringProjectJump`).
- `DetachedCenterPanel`: chord handler returns while steering is on; its
  comment no longer says steering is the main window's.
- CSS: `html[data-steer-bar] .detached-center` padding;
  `html[data-steer-region="chrome"] .detached-titlebar` outline.
- i18n (all five locales): `steering.upTitleBar.label/desc`,
  `steering.titleBarWalk.desc`, `steering.titleBarDown.label/desc`,
  `steering.region.titleBar`, `steering.level.mainWindow`,
  `steeringKeys.section.mainWindow`.
### New-tab keys, focus frame

- `components/layout/RootNewTabKeys.tsx` now exports a shared `NewTabKeys`
  (scope, optional box seed, group ids, `cwdFor`, `onAdd(spec, groupId,
  besideActive)`, `onMenu(groupId, besideActive)`); `RootNewTabKeys` is a thin
  wrapper over it. Choice: that module already was the shared builder (the
  same `buildStaticTabSpec` / `agentShortcutSlots` / `onOwnLogin` /
  monitor spec `TabBar` uses); `TabBar`'s own private handlers were left alone
  (they need its live bar state: worktree question, `ensureTab` for the
  monitor).
- `DetachedCenterPanel` mounts `NewTabKeys` for its groups: shell / monitor /
  agent slots call `onAddTab`; `menu` toggles `addMenu` anchored on that
  group's `.tab-new-btn` and remembers `besideActive` for the pick. The
  monitor key always adds (Root does the same; `TabBar` focuses an existing
  monitor tab).
- `besideActive` travels on the `add` edit (`stores/detached.ts`
  `DetachedEdit`, the plan says `stores/tabs/types.ts` but the type lives in
  `detached.ts`) and `addDetachedTab(…, { besideActive })` inserts after the
  active tab.
- The inline `.focus-frame` is replaced by `FocusFrameOverlay`, which reads the
  popout's focus, layout and tabs through `useSteeringTabs()` /
  `popoutView` in a popout and the workspace's otherwise (main unchanged:
  under the Root view it still reads the workspace's focus). It draws only
  while the window is focused, as the inline frame did.
- Tests: `src/__tests__/shell/SteeringPopout.test.tsx` (11 in all);
  `DetachedTwoHeap` +1 (besideActive add, 29).

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
