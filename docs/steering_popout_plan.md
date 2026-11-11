# Steering inside popout windows — plan

Status: plan only, 2026-11-11. Decisions U1–U4 settled with the user the same
day. Frontend only (no `src-tauri/` change). Nothing implemented, never run
live.

## Why

Steering does not exist in a popout. This is by design today, and the design
is what the user reports as broken ("no steering markers on the popout,
steering does not seem to work there"):

- The chord in a popout does not steer the popout. `DetachedApp.tsx:284-303`
  emits `DETACHED_STEER`; the main window answers (`stores/detached.ts:1242`)
  with `getCurrentWindow().setFocus()` and `STEER_FROM_POPOUT`, and
  `useKeyboard.ts:333` turns steering on **in the main window**. The markers
  appear there, on a window the user is not looking at. When the window
  manager refuses the focus move, the keys keep going to the popout's terminal
  while the main window shows the bar.
- J in the main window (`popout` action, `lib/window/focusPopout.ts`) raises a
  popout and ends steering.
- Nothing steering draws is mounted in a popout: `SteeringLegend`,
  `SteeringPromptOverlay`, `SteeringConfirmOverlay` and `ShortcutHelpOverlay`
  live only in `AppShell.tsx:1546-1565`, and `SteeringLegend` is what sets
  `html[data-steer]`, which every marker rule in `styles/subwindows.css` keys
  on.
- The handler cannot simply be mounted there. It reads the tabs store
  (`useTabsStore.getState().layout`, `.focusedGroupId`, `.tabsByScope`), and a
  popout's tabs store holds no tabs and no layout: the popout renders from
  streamed props (`DetachedApp` `group` / `tabs` state, `DetachedCenterPanel`'s
  local `focusedGroupId`).

What already fits, so the work is smaller than it looks:

- The popout's markup uses the main window's class names: `.subwindow.focused`,
  `.tab.active`, `.tab-new-btn`, `.subwindow-files-toggle`, `.focus-frame`,
  `.center-pane[data-tab-key]`, and the shared `NewTabMenu`. The marker CSS and
  the selector-driven libraries (`steeringCaps.ts`, `steeringRegion.ts`,
  `documentScroll.ts`) work on it unchanged.
- The terminal registry, the Reader, the session picker and the activity lamps
  are per heap and already live in a popout.
- `steeringScope.ts` is already the seam for "which tabs do the tab levels
  walk" (workspace or Root). A popout is a third source.
- Store writes from a popout already have a convention: the store action
  forwards through `stores/detachedContext.ts`. Steering's writes join it.

Gaps found on the way, fixed by this plan because they sit in the touched code:

- `NEW_TAB_SHORTCUT_EVENT` / `NEW_TAB_SLOTS_EVENT` are answered only by
  `TabBar.tsx:1073` and `RootNewTabKeys.tsx`. A popout has no listener, so
  Ctrl+Shift+N / M and Ctrl+1–9 do nothing there.
- `jumpToTab` (`lib/shortcuts/tabJump.ts:37`) to a tab that lives in a popout
  only switches the project; the popout is not raised. Q / R / X from the main
  window therefore "land" on a tab nobody sees.

## Fixed decisions

### The user's (2026-11-11; a reviewer may not undo them)

U1. **Up above the popout's top level = its title bar, then the main window.**
    The title bar's buttons are walked as a row (the popout's `chrome` region,
    as Root has one). One more Up hands the keyboard to the main window with
    steering on there.
U2. **Steering follows the keyboard, and J cycles.** J in the main window
    raises the next popout with steering already on in it. J in a popout goes
    to the next popout of the scope, and after the last one back to the main
    window. Only one window steers at a time.
U3. **Status jumps work across windows.** Q / R / X and Back in a popout walk
    the same list as in the main window. The jump lands on the tab wherever it
    lives (main window or any popout) and steering follows it. The same holds
    for a jump started in the main window to a tab in a popout.
U4. **Main-only keys hand over.** A key whose target exists only in the main
    window (projects and the project jump, mail / calendar / to-do, cockpit,
    settings, side panel, panels) brings the main window forward and runs
    there, steering on. The popout's bar lists these keys in their own
    "Main window" group.

### Design (decided here)

D1. **One handler, two windows.** The steering half of `useKeyboard` moves to
    `hooks/useSteering.ts` and takes a surface, `"main"` or `"popout"`. There
    is no second hand-written dispatcher: `DetachedCenterPanel.tsx:389-507`
    already duplicates the main window's chord handling, and steering is ten
    times that size.
D2. **Reads go through `steeringScope`.** New popout-heap store
    `stores/popoutView.ts` (`scope`, `popoutId`, `label`, `tree`, `tabs`,
    `focusedGroupId`), written by `DetachedApp` on every seed and by
    `DetachedCenterPanel` for focus (its local `focusedGroupId` state moves
    into it). `steeringTabs()` / `steeringTabsActive()` return it when
    `isDetachedWindow()`. A reactive `useSteeringTabs()` serves the legend.
    The popout's `useTabsStore` stays empty; nothing mirrors a layout into it.
D3. **Writes go through the store actions**, routed in a popout by the detached
    context, per the standing rule ("route it in the action, no window
    awareness at the call site").
D4. **A window enters steering only when it has the keyboard**, and announces
    it. Entering emits `STEERING_OWNER { label }` to every window; any other
    window that is steering (or waiting on a handoff box) leaves quietly. A
    handover never ends steering in the source by itself: the source leaves
    when it hears the target's announcement. A focus move the window manager
    refused therefore leaves steering where the keyboard still is, the same
    rule `docs/steering_gaps_plan.md` §2 set for J.
D5. **Every arrival in a window lands on its tabs level**: the chord, J, Up
    from a popout's title bar, a main-only key (which then runs its action).
    A status jump lands on the target tab.
D6. **The main window stays the owner of everything cross-project**: the
    status lists, the Back record (`jumpBack`), the popout order. A popout
    asks; it never computes these from its own empty store.
D7. **No backend change.** Main → popout focus uses the existing
    `focus_detached_window`; popout → main uses the main window's own
    `setFocus()` (what `DETACHED_STEER` does today) plus `unminimize()`. If
    the live check shows a platform where that does not move the keyboard, a
    `focus_main_window` command is the follow-up, not part of this plan.

## What steering is in a popout

| Level | In a popout |
| --- | --- |
| projects | None. Its keys are main-only (U4). |
| panes | The popout's subwindows, when it is split. Same keys, same ↓/↑ badges. |
| tabs | The focused subwindow's tabs. Entry level. |
| scroll (Inside) | Terminal, Reader views, document. Unchanged code. |
| region `addTab` | The popout's own `NewTabMenu`. |
| region `overlay` | Any dialog or menu in the popout (confirm, context menu, `DetachedCloseChoice`). |
| region `card`, `subagents` | Unchanged (selector-driven). |
| region `chrome` | The popout's title bar: dock back, hide, minimize, maximize, close. |
| regions `side`, `header`, `settings`, `mail`, `calendar`, `todo`, `cockpit` | None. Reached by handover (U4). |

Ladder in the bar: `Main window › Title bar › Subwindows › Tabs › Inside`
(no Subwindows rung with one subwindow, as today).

Keys that act in the popout: arrows / E S D F, Tab (Reader view), Shift+arrows,
W (close, asked first), N / O / 1–9 / + (new tabs), V (files column), `.`
(tab menu), Space / I / L / G (prompt box), digits on an asking tab, K / L
queue keys, A (card), subagents, H (fold), ? (cheat sheet), Enter / Esc / the
chord (leave).

Keys that hand over: project ←/→/digits do not exist (no projects level);
`newProject`, `jumpProject`, `mail`, `calendar`, `todo`, `cockpit`,
`sidePanel`, `panels`, `settings`. Cross-window keys: `popout` (J),
`nextDecision` / `nextWorking` / `nextDone`, `jumpBack`.

## The cross-window protocol

Two events, one payload type. All of it in `stores/detached.ts` beside the
existing events.

```ts
/** popout → main (the existing event, payload extended). */
DETACHED_STEER: { scope; groupId; label; act: SteerAct; shown?: StatusTab }
/** main → one popout, namespaced like the seed. */
detachedSteerEvent(label): { act: SteerAct }
/** any window → all: "I am steering now". */
STEERING_OWNER: { label }            // "main" for the main window

type SteerAct =
  | { kind: "enter" }                               // land on the tabs
  | { kind: "tab"; key: string }                    // land on this tab
  | { kind: "action"; action: SteeringAction; shift: boolean };
```

A second, tiny stream for the bar's counts:

```ts
/** main → all popouts, on change and on STEERING_OWNER from a popout. */
STEERING_STATUS: { decision: number; working: number; done: number; back: boolean }
```

Rules:

1. **Receiving `enter` / `tab` / `action`.** The window enters steering only
   if `document.hasFocus()`; otherwise it waits for its own `focus` event for
   800 ms and then drops the request. On entering it emits `STEERING_OWNER`.
2. **Sending.** The sender keeps steering. It leaves when `STEERING_OWNER`
   names another window. No timer ends it.
3. **Popout → main, `enter`** (Up from the title bar): main calls
   `unminimize()` + `setFocus()`, then rule 1.
4. **Popout → main, `action`** for a main-only key: as 3, then main runs the
   action through `steerCommon` (it opens mail, settings, the side panel and
   enters that region exactly as if pressed there).
5. **J.** Main: `focusNextPopout(scope)`; on `true`, send `enter` to that
   label (replaces today's "exit after focus"; the visit guard in
   `useKeyboard.ts:940-954` stays, it now guards the send). Popout: send
   `action: "popout"` with its own label. Main does not take focus; it picks
   the label after the sender in `detachedGroupsByScope[scope]`. If there is
   one: `focus_detached_window(next)` + `enter` to it. If not: rule 3.
   `focusPopout.ts` gains `popoutAfter(scope, label)`; `lastRaised` is set by
   both paths so the cycle has one position.
6. **Status jump from a popout.** Popout sends `action: "nextDecision"` (etc.)
   with `shift` and `shown` (its active tab). Main computes
   `nextStatusTab(statusTabs(...), shown, dir)`, records `jumpBack` with
   `afterStatusJump`, and goes to the target (rule 8). `jumpBack` the same,
   with `shown` in place of `shownStatusTab()`.
7. **Auto-return after a digit answer** (`returnAfterAnswer`) in a popout:
   sends `action: "jumpBack"` with `shown`; main applies its existing
   conditions (`record.landed` equals `shown`) before moving.
8. **Going to a tab, window-aware** (main only, in `jumpToTab` and steering's
   `goToTab`): find the tab's home.
   - In the scope's visible tree: as today. If the request came from a popout,
     main also takes focus (rule 3) and lands on the tabs level.
   - In a popout of that scope (`detachedGroupsByScope[scope]`, by
     `orderedTabKeys(entry.subtree)`): bring the scope up if it is not
     (`bringUpScope`, which un-parks its popouts), apply an `activate` edit to
     the detached group, `focus_detached_window(label)`, and, when steering
     asked, send `{ kind: "tab", key }` to that label. `jumpToTab` without
     steering (command palette, cockpit) does everything but the send.
   - In the popout that asked: the same path; the popout already has the
     keyboard, so rule 1 enters at once and nothing visibly changes window.

## Steps

Each step is one commit and leaves the gates green.

### 0. Before starting

The main checkout holds another session's uncommitted steering edits
(`hooks/useKeyboard.ts`, `components/layout/SteeringLegend.tsx`,
`lib/shortcuts/steeringBar.ts`, `styles/subwindows.css`, five i18n files,
three tests: a one-subwindow scope gets no Subwindows level or rung). Step 1
moves most of `useKeyboard.ts`, so the two cannot land in either order
without a rebase.

Organisation (user, 2026-11-11: "use opus subagent to implement"): one Opus
implementer, steps 1–6 in order, one commit per step, in a worktree reset to
`develop` HEAD (not `origin/main`), with the handoff log
`docs/steering_popout_handoff.md`. The implementer builds on what `develop`
HEAD does and never reads or writes the main checkout's working files. The
main agent lands the range: only after the other session's edits are
committed, rebasing onto them (their two `useKeyboard.ts` hunks then apply to
the moved code in `useSteering.ts`).

### 1. Pure move: `hooks/useSteering.ts`

- Move out of `useKeyboard.ts`: everything from "Keyboard steering mode"
  (`:266`) through `onSteeringPointerDown`, the scroll-release subscription,
  the layer observer, the blur-grace bookkeeping, `STATUS_ACTIONS`,
  `cycleProject` / `landOnStation` (exported, `useKeyboard`'s chords still use
  them).
- `useKeyboard` keeps the window chords (`onKeyDown`, `onKeyUp`, lone Super)
  and calls `useSteering({ surface: "main", onTogglePanels, onSidePanel })`
  first, so listener order is unchanged. Its blur handler asks the steering
  hook's `noteBlur` / `noteFocus` instead of touching `steeringBlurredAt`.
- No behaviour change. The net is the existing suite: every
  `src/__tests__/shell/Steering*.test.tsx` and `cockpit/Steering*.test.tsx`
  renders `useKeyboard` and must pass untouched.
- Update the `useKeyboard.ts` row and add a `useSteering.ts` row in
  `docs/filemap_frontend.md`.

### 2. Popout as a steering scope

- `stores/popoutView.ts`: the store of D2. `focusGroup(id)` ignores ids not in
  the tree; a new seed keeps the focused id when it survives, else the first
  group (the effect now at `DetachedCenterPanel.tsx:372-375`).
- `DetachedApp.tsx`: write `tree` / `tabs` into it wherever `setGroup` /
  `setTabs` run; `DetachedCenterPanel.tsx`: read and write focus through it,
  drop the local state and the `onFocusedGroup` prop (`focusedGroupRef` in
  `DetachedApp` reads the store).
- `lib/shortcuts/steeringScope.ts`: `SteeringTabs` gains `popout: boolean`;
  both functions return the popout view in a popout. Add
  `useSteeringTabs()` (subscribes to the tabs store, the root overlay store
  and the popout view; returns `{ scope, layout, focusedGroupId, activeTab,
  inRoot, popout }`).
- `stores/tabs.ts`, popout branches (context present, scope is the popout's):
  `focusGroupInScope` → `popoutView.focusGroup`; `setGroupActiveInScope` →
  focus + `pushEdit({ kind: "activate", key })`; `setGroupFilesInScope` →
  `pushEdit({ kind: "files", groupId, open })`; `removeTabInScope` →
  `ctx.closeTab(key)` (so W's confirm closes the last tab's window exactly as
  × does). `closeTabInScope` (`lib/remote/closeRemoteTab.ts:129`) reads the
  tab from `tabsByScope`; give it the popout view's tab so the reopen record
  and the tmux kill still happen.
- `lib/shortcuts/newTabChord.ts` `targetGroupId()`: use `steeringTabs()` for
  every case.
- `lib/shortcuts/statusJump.ts` `shownStatusTab()`: the popout view's active
  tab in a popout.
- Tests: `SteeringScopePopout.test.ts` (reads), and store-routing cases in
  `windows/DetachedTwoHeap.test.ts` (each routed action produces the edit and
  the main heap's detached record changes).

### 3. Steering runs in the popout

- `hooks/useSteering.ts`, surface `"popout"`:
  - `enterSteering` focuses a group through `steeringTabs()` (the store calls
    it makes are routed by step 2).
  - Not in a popout: the `rootConsole` and `projectShell` chords, the
    hook's own `reopenClosedTab` branch (`DetachedApp` already forwards
    it), the projects level (`setLevel("projects")` is never reached: see the
    Up rule below), `carryFullscreen`.
  - Up on tabs with one subwindow, or on panes: `enterRegion("chrome")`. In
    `chrome`: ←/→ walk, Enter presses, ↓ leaves to the level it came from,
    Up is the handover of step 4 (a no-op until then).
  - Main-only and cross-window actions: collected in one
    `POPOUT_HANDS_OVER: ReadonlySet<SteeringAction>` beside
    `STATUS_ACTIONS`; in a popout `steerCommon` sends them (step 4/5) instead
    of running them.
- `lib/shortcuts/steeringRegion.ts`: `regionRoot("chrome")` returns
  `.detached-titlebar` in a popout. `regionTargets` (`:447`) filters it by a
  popout zone, `.detached-titlebar-actions, .detached-titlebar-controls`,
  the way `CHROME_ZONE` filters Root's frame, so the logo, the grip and the
  name are never targets. `NOT_A_TARGET` (`:441`) excludes `.wm-controls`
  everywhere today; that exclusion must not apply inside the popout zone, or
  minimize / maximize / close (U1) are unreachable. `regionForLayer` needs no
  change (no root overlay in a popout).
- `DetachedApp.tsx`: delete the chord effect (`:284-303`), call
  `useSteering({ surface: "popout" })`, mount `SteeringLegend`,
  `SteeringPromptOverlay`, `SteeringConfirmOverlay`, `ShortcutHelpOverlay`.
  Not `SteeringProjectJump`.
- `DetachedCenterPanel.tsx`:
  - Its chord handler (`:408-507`) returns early while steering is active
    (the capture listener already stops the event; this is the belt).
  - Answer `NEW_TAB_SHORTCUT_EVENT` and `NEW_TAB_SLOTS_EVENT` per group:
    `menu` toggles `addMenu` anchored on that group's `.tab-new-btn`; shell,
    monitor and agent slots build the tab with the same builders `TabBar`
    uses (`SHELL_ITEM`, `agentShortcutSlots`, `onOwnLogin`, the monitor spec)
    and call `onAddTab`. Whatever of that is private to `TabBar.tsx` moves to
    a shared module; no copy. `besideActive` travels on the `add` edit
    (`stores/tabs/types.ts`, applied in the main window where
    `besideActive` is already honoured, `stores/tabs.ts:1398`).
  - Replace the inline `.focus-frame` (`:1969-1982`) with
    `FocusFrameOverlay`, which gets its focused id from `useSteeringTabs()`
    instead of `useTabsStore` (`CenterPanel.tsx:1387`), so the panes level
    shows the ↓/↑ badges.
- `components/layout/SteeringLegend.tsx`: the six `useTabsStore` selectors
  (`:99-110`) become `useSteeringTabs()`; `popouts` is true in a popout (J
  always has the main window to go to); status counts and the Back cap come
  from `STEERING_STATUS` in a popout (zero until step 5).
- `lib/shortcuts/shortcuts.ts` / `steeringBar.ts`: `steeringKeysFor` and
  `ladder` take the surface. Popout: no projects rows; the hand-over actions
  render in a group with section key `steeringKeys.section.mainWindow`; the
  ladder of "What steering is in a popout"; `REGION_LABEL.chrome` reads
  "Title bar" there (`steering.region.titleBar`).
- `styles/subwindows.css`: `html[data-steer-bar] .detached-center` gets the
  same `padding-bottom: var(--steer-bar-h)` as `.app-shell`. Check each
  `html[data-steer…]` rule for an `.app-shell` / `.app-header` ancestor it
  would need in a popout; the lit tab and focus-frame rules have none. No new
  animation, no blurred shadow.
- i18n: the new keys in `en.ts` and the four other locales.
- Tests: `shell/SteeringPopout.test.tsx` — render `DetachedApp`'s steering
  parts over a seeded popout view: chord enters on tabs and sets
  `html[data-steer]`; ←/→ produce `activate` edits; Shift+←/→ and the panes
  level move the popout view's focus; W raises the confirm and its yes calls
  `ctx.closeTab`; N / 1 call `onAddTab`; `+` opens the menu and enters
  `addTab`; Up enters `chrome` with the cursor on a title bar button; a
  main-only key changes nothing locally. `shell/SteeringFromPopout.test.tsx`
  is rewritten in step 4.

After this step the user's report is fixed: steering and its markers work in
a popout by themselves.

### 4. Between windows: owner, Up, J, main-only keys

- `stores/detached.ts`: the events of "The cross-window protocol";
  `listenDetachedHost` replaces the `DETACHED_STEER` handler (`:1242`) with
  one that dispatches `STEER_FROM_POPOUT` carrying the payload.
- `hooks/useSteering.ts`:
  - `enterSteering` emits `STEERING_OWNER`; a listener leaves steering
    (and drops a pending handoff) when another label announces.
  - `onSteerRequest(act)` implements rule 1 (focus check, 800 ms wait) for
    both surfaces: main via `STEER_FROM_POPOUT`, popout via
    `detachedSteerEvent(label)`.
  - Popout: Up in `chrome` → `enter`; the `POPOUT_HANDS_OVER` actions →
    `action`.
  - Main: the `popout` case sends `enter` after a successful raise; a
    received `action: "popout"` runs rule 5.
- `lib/window/focusPopout.ts`: `popoutAfter`, shared `lastRaised`.
- Tests, on `helpers/detachedHarness.ts` (two heaps, one event bus):
  `windows/SteeringHandover.test.ts` — J main → popout → main with one and
  with two popouts; Up from the title bar; `,` in a popout opens settings in
  main with region `settings`; a target without focus never announces and the
  source keeps steering; two windows never both hold `active`. Rewrite
  `shell/SteeringFromPopout.test.tsx` for the new payload.

### 5. Status jumps across windows

- `lib/shortcuts/tabJump.ts`: `jumpToTab` rule 8 (home lookup, `activate`
  edit, raise). Returns where the tab lives (`"main"` or the popout label) so
  steering knows where to send.
- `hooks/useSteering.ts` main: `goToTab` uses that result; a received status
  or `jumpBack` action runs rules 6–7 with the sender's `shown`. Popout: a
  received `{ kind: "tab" }` focuses the tab's group in the popout view and
  lands on tabs.
- `stores/detached.ts` host: emit `STEERING_STATUS` when the three counts or
  the Back availability change (subscribe to the activity store, the tabs
  store and the steering store's `jumpBack`; compare before emitting), and
  once whenever a popout announces `STEERING_OWNER`.
- Tests: in `windows/SteeringHandover.test.ts` — Q in a popout to a tab in
  main, to a tab in another popout, to a tab in the same popout; Q in main to
  a tab in a popout; Back returns across windows; the auto-return after a
  digit answer; counts reach the popout's bar.

### 6. Paperwork

- `src/lib/untested.ts`: ids `steering.popout` (step 3) and
  `steering.popoutHandover` (steps 4–5), tagged where the newest steering ids
  are (`ShortcutHelpOverlay.tsx:110`).
- `docs/help/keyboard.md`: the steering section says it works in popouts,
  what Up and J do there, and which keys go to the main window; the
  new-tab chords row loses its main-window-only reading.
- `todo/group-l-tabs.md`: `213k`, a 🖐️ manual item with the four platform
  child pairs.
- `docs/filemap_frontend.md`: rows for `stores/popoutView.ts`, and one-line
  updates to `DetachedApp.tsx`, `DetachedCenterPanel.tsx`,
  `steeringScope.ts`, `focusPopout.ts`, `tabJump.ts`.
- Fix the now-false comments: `steeringChord.ts:1-6`,
  `DetachedCenterPanel.tsx:396-405`, `subwindow.rs`'s "the main window walks
  no popout itself" is backend and stays (D7).

## Verification

Gates: `scripts/gates.sh` (build, tests, lint, brand check are the ones this
touches). Report that it was not run live.

Live steps for the user (the dev build after the commits land):

1. Pop a subwindow with two tabs out. Click into it, press Shift+Space: the
   bar appears at the popout's bottom, the active tab is outlined, the main
   window shows nothing.
2. ←/→ switch its tabs; ↓ goes inside the terminal and scrolls; Up comes back.
3. N opens a shell beside the active tab; `+` opens the menu under the
   cursor; W asks, then closes.
4. Space on an agent tab opens the prompt box in the popout; Enter sends.
5. Up from the tabs: the cursor is on the title bar; Enter on ⤓ docks back.
   Pop out again; Up twice: the main window has the keyboard and the bar.
6. J in the main window: the popout has the bar. J again with one popout:
   back in the main window. With two popouts: main → first → second → main.
7. `,` in a popout: settings open in the main window, steering on its pages.
8. An agent in the main window asks a question; Q in the popout: the main
   window comes forward on that tab. Answer with a digit: back in the popout.
9. Split the popout (drag a tab to an edge): Up from tabs reaches the
   subwindows level with ↓/↑ badges, Shift+←/→ jumps between them.
10. On Wayland, repeat 5 and 6. A refused focus move must leave steering
    where the keyboard is, never markers in one window and keys in another.

## Out of scope

- The project jump box inside a popout (it hands over, U4).
- Walking a subwindow's docked files column (V toggles it in both windows;
  neither walks it today).
- A `focus_main_window` backend command (D7, only if step 10 fails).
- The phone's steering (`mobile-web/src/steering/`), which shares only the
  bindings.

## Risks

- **Focus across windows is the window manager's.** D4 makes a refusal
  harmless, but on a compositor that never grants it, Up / J / hand-over keys
  do nothing visible. The bar should not then pretend: if no `STEERING_OWNER`
  arrives within 800 ms of a send, flash nothing and keep the level; the
  follow-up is D7's command.
- **`FocusFrameOverlay` in the popout** draws only while the window is
  focused, as the inline frame does today. Keep that, or a blurred popout
  shows a frame beside the main window's.
- **Reseed during steering.** Every edit reseeds the popout
  (`DetachedApp` seed listener). The popout view must keep the focused group
  across a reseed and the region cursor must survive React rewriting
  `className` (the known `setCursor` re-add in `steeringRegion.ts`).
- **A popout webview reload** (renderer watchdog) drops steering in that
  window. Acceptable: it re-enters with the chord; the main window never
  thought it owned steering meanwhile.
