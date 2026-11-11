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

## Step 4 — between windows: owner, Up, J, main-only keys

Commit: `feat(steering): steering follows the keyboard between windows`

- `stores/detached.ts`: `SteerAct`, `DetachedSteerPayload` (`DETACHED_STEER`,
  now with `label`, `act`, `shown`), `detachedSteerEvent(label)` +
  `DetachedSteerRequest`, `STEERING_OWNER` / `MAIN_STEERING_LABEL` ("main"),
  `STEERING_STATUS` (name only; step 5 uses it). The host's `DETACHED_STEER`
  handler only re-dispatches `STEER_FROM_POPOUT` with the payload as `detail`;
  the focus decision moved into `useSteering` (J may raise another popout
  instead of the main window).
- `useSteering`:
  - `enterSteering` announces `STEERING_OWNER { label }`; a listener on it
    leaves steering (or drops a lent box's `handedTo`) when another label
    announces. A sender never ends its own steering.
  - `whenFocused(run)`: rule 1 (`document.hasFocus()`, else wait for this
    window's `focus` up to `STEER_HANDOVER_WAIT_MS` = 800, then drop).
  - `arrive(act)`: enters (or, already on, resets to the tabs level), announces,
    then runs a handed-over action through `steerCommon` (synthetic keydown
    carrying `shift`).
  - Main: `STEER_FROM_POPOUT` → `raiseMainWindow()` (`unminimize()` then
    `setFocus()`, errors swallowed) + `whenFocused(arrive)`; a popout's J picks
    `popoutAfter(scope, label)` and raises it (`raisePopout`) + sends it
    `enter`, else goes to the main window. A missing `detail` reads as `enter`.
  - Main J: `focusNextPopout` now returns the raised label; the existing visit
    guard now guards sending `enter` to it (it used to `exitSteering()`).
  - Popout: listens on `detachedSteerEvent(label)`; Up in `chrome` sends
    `enter`; `POPOUT_MAIN_ONLY` keys and J send `action`. Status jumps and Back
    are still swallowed (step 5).
  - `STEER_FROM_POPOUT` is listened for only on the main surface.
- `lib/window/focusPopout.ts`: `popoutAfter`, `raisePopout` (sets the shared
  `lastRaised`), `focusNextPopout` → `Promise<string | null>`.
- Legend: row "To the main window" (↑ on a popout's title bar). The J row's
  description (`steering.popout.desc`, all locales) no longer says steering
  ends.
- Tests: new `src/__tests__/windows/SteeringHandover.test.tsx` (5: J with one
  and two popouts, Up from the title bar, `/` = settings handed over, a target
  without focus never announces). It runs one `useSteering` per heap (main +
  1–2 popouts) on the shared jsdom document, with `document.hasFocus` stubbed.
  Rewritten `shell/SteeringFromPopout.test.tsx` (payload, focus wait, drop
  after 800 ms, arrival lands on tabs). Changed existing
  `shell/SteeringCoverage.test.tsx` J case: after a successful raise the main
  window now stays steering and sends `enter` (asserted through a mocked
  `emit`) instead of ending steering — the plan replaces that behaviour.
- Note: the plan's example key `,` for settings is not the default binding
  (`/` is); tests use `/`.

## Step 5 — status jumps across windows

Commit: `feat(steering): status jumps and Back cross windows`

- `lib/shortcuts/tabJump.ts`: `jumpToTab` returns the tab's home
  (`MAIN_TAB_HOME` = "main", or the popout's label). Main window, tab in a
  popout of its scope (`orderedTabKeys(entry.subtree)`): `bringUpScope`, an
  `activate` on the record (`applyDetachedEdit`; the host's sweep reseeds the
  popout), `focus_detached_window(label)`. Callers that ignore the result (the
  command palette, cockpit, pills, to-do) now also raise a popout tab.
- `useSteering` main: `goToTab(target, asker?)` — a popout home gets
  `{ kind: "tab", key }`; a main home asked from a popout raises the main
  window and arrives on its tabs. `statusJump(action, shift, shown, asker?)`
  is the one status / Back implementation for both a key here and a popout's
  request (`runFromPopout`, which uses the popout's `shown`).
- Choice: `SteerAct.action` gained `auto?: boolean` for rule 7: the popout's
  `returnAfterAnswer` sends `jumpBack` with `auto: true`, and only an `auto`
  Back checks that the record landed on `shown` (a manual Back from a popout
  behaves as Back in the main window, which has no such check).
- Popout: all `POPOUT_HANDS_OVER` keys are now sent (status jumps and Back
  too); a received `{ kind: "tab" }` focuses the tab's group in the popout view
  (`setGroupActiveInScope`, an `activate` edit) and lands on the tabs.
- Choice: the `STEERING_STATUS` publisher lives in `useSteering` (main
  surface), not in `listenDetachedHost` as the plan says: it reads the
  steering store's Back record, and keeping it out of the host spares every
  host test a new stream on its bus. It publishes only while some popout is
  open, on a change of the counts / Back (compared before emitting), and
  forced whenever a popout announces `STEERING_OWNER`. `back` is "the record's
  origin is still open" (`jumpBackTarget(record, null, …)`): the main window
  does not know the popout's shown tab between keys. The popout writes it
  into `popoutView.status`, which its bar reads.
- Tests: `windows/SteeringHandover.test.tsx` +6 (11): Q in a popout to a tab
  in main / another popout / the same popout; Q in main to a popout and Back
  across; the auto-return (moves only when the record landed on `shown`; the
  digit answer itself is not driven, the popout's request is emitted
  directly); counts reach the popout.

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
