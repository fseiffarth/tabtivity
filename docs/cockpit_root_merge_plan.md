# Cockpit + root console: one surface

Status: **plan only, reviewed (2026-11-04).** Nothing here is implemented. The
user asked only to "merge the cockpit with the root"; what that means below is
read from the code (develop). Visual and interaction design is
`docs/cockpit_root_merge_design.md`; this plan covers architecture, ownership,
state, gates and steps, and its steps cover that layout **with the recommended
option of every Open decision taken** (the last section of each step, and
"If the user picks otherwise", say what changes under the others). The review's
corrections are listed under "Review notes" at the end.

Naming used below: the console's view of the merged window is called **Root**
(internal id `"root"`), the four cockpit views `Now`, `Projects`, `Tonight`,
`Usage`. If decision 3 goes to "Terminals", only strings change.

## Why

Two header-level floating windows now answer neighbouring questions, and the
code shows they are one surface built twice:

- **Same chrome, two implementations.** `layout/RootOverlay.tsx` carries its
  own move/resize/fill code (`beginFrameDrag`, `liveFrame`, eight grips) and
  `common/useFloatingFrame.tsx` repeats it for the header overlays, importing
  the math back from `stores/rootOverlay`. The cockpit uses the hook; the
  console does not. Both persist the same `{frame, filled}` row to localStorage
  (checked: `readPersistedFrame` and the hook's `readFrame` are line-for-line the
  same).
- **Two ✓ Approvals pills over one queue.** The console's inline pill (store
  field `rootReview.panel`, anchor effect, `reviewAdvisory`) and
  `OverlayApprovals` (no `domain` = the whole queue, the cockpit's) are two
  doors onto `stores/rootReview`. Nothing outside the console (and one test)
  ever reads or calls `panel`/`setPanel`; `OverlayApprovals` already keeps its
  own local open state.
- **Two attach-only drawers of PTYs, two shown-sets, one refusal rule.**
  The console draws the whole root layout (`TabPane attachOnly`, `CenterPanel`
  stands root down for `rootOverlay.open`). The cockpit's detail pane draws one
  tab of any scope through `AttachedAgentPane` (`scopeShownKeys`, or `shownKeys`
  for root) and refuses a root tab while the console is open
  (`cockpitDetailMode` -> `"console"`). The roster already lists root's agents
  (`useCockpitData` pushes a `kind: "root"` scope once root is hydrated), so the
  cockpit lists tabs it cannot always show.
- **The cockpit's Enter on a root row is wrong today (checked).** `jumpToRow` ->
  `jumpToTab(ROOT_SCOPE, key)` -> `bringUpScope` -> `setActive(null)` whenever
  a project is active: it *switches the workspace to the root scope*, which the
  root-console design removed ("Root is no longer a place to switch to"). Every
  `jumpToTab` caller can hit it with a root tab: the cockpit (`CockpitRoster`,
  `CockpitRail`), `hooks/useKeyboard.ts` (the steering status keys),
  `CommandPalette`, `PillStatusBars`, `PillTabMarks`, `TodoCard`,
  `PromptChart`, `AgentSchedulesView`. A merged surface fixes it at the one place
  (`tabJump.ts`).
- **Same audience.** The root console is the cross-project *home agent*; the
  cockpit is the cross-project *status view* that lists, among others, that
  agent. Both are the answer to "something above one project".

What does not overlap, and stays as it is: Mail / Calendar / To-do overlays and
their docked root-agent column (`OverlayAgentColumn`, `useOverlayAgent`,
`stores/overlayAgent` docks); the phone's root scope (`mobile_control`, its
switch, devices and review gate); the root MCP tools, review gate and staged
writes; `sessions/root/` persistence. `docs/root_cleanup_plan.md` is about the
*repo's* top-level files and has nothing to do with this.

## Proposed shape (recommended options taken)

One window with a **view strip** in its title bar: `Now`, `Projects`,
`Tonight`, `Usage`, a divider, then **Root** (the star), which holds today's
console unchanged inside (its sole-group tab strip drops to a sub-bar). One store
(`stores/rootOverlay` gains `view`), one frame (`rootConsoleFrame`), one ✓
Approvals pill in the title bar, one Escape rule, one backdrop. Only the shown
view mounts. Every door that runs something in root (`openTabInRootConsole`,
`show(key)`, the phone's "Activate") lands on Root; Ctrl+Shift+R opens Root and
switches to it from another view; the header gauge, steering **U** and the box
chip's row land on `Now`. With the `cockpit` experiment off the strip, sub-bar
and every cockpit door are absent and the window is today's console. The cockpit
overlay host and its store's open/view fields are deleted.

## Fixed decisions (forced by the code or AGENTS.md)

- **`tabsByScope.root`, `sessions/root/`, the root layout JSON, every
  `rootConsole.*` / `cockpit.*` storage key keep their shape.** Persisted
  state must round-trip: `rootConsoleFrame` (`{frame, filled}`, identical to
  `useFloatingFrame`'s row), `cockpitRailWidth`, `cockpitDetailWidth`,
  `overlayAgentWidth`. `cockpitOverlayFrame` is the only key retired: a
  per-viewer window position on an experiment never run live; it is simply no
  longer read or written. Any new remembered value (the icon rail's fold, if
  decision 7 keeps it) is a new `storageKey(...)` row, never a changed old one.
- **`RootOverlayHost` stays always mounted** (root persist, `root-mcp-changed`
  merge and arrivals, `root-mcp-review-changed` refresh, the 5 s review poll
  while open). The cockpit's "nothing runs while shut" rule holds through the
  shell: cockpit views are `React.lazy` and only the shown one mounts; the
  Root view mounts only while shown.
- **Public store API stays**: `useRootOverlayStore.show(key?)`, `close`,
  `open`, `markInstallTab`, `openTabInRootConsole`, `addTabToRoot`,
  `openProjectShellInRootConsole`, `ensureRootScopeHydrated`. `show()` always
  means Root. Callers (`installCommand`, `remoteConnect`, `helpAgent`,
  `DevBuildIndicator`, `MobileBridgeHost.enterScope`, `ProjectSwitcher`,
  `OverlayAgentColumn`) are untouched. The phone needs no backend or
  `mobile-web` change (`mobile_control` root rules are not edited).
- **One visible view per PTY.** Root stays hidden-but-mounted in `CenterPanel`
  while the surface is up (`rootOverlay.open`, unchanged for the slot stand-down
  and the focus rule). A root tab drawn by the Now detail pane marks `shownKeys`
  (root's existing set); the Root view is not mounted at that time, so it never
  draws it too.
- **Opening a cockpit view never hydrates root** (the cockpit's rule for every
  scope: restoring a scope brings its saved agents back up). Root's agents are
  rows only once root was restored this session (`show()` restores it); a fresh
  start shows no Root rows until the first Root open. A known limit, not a bug.
- **Popout-owned tabs stay refused** ("Open in its window"); neither surface is
  mounted in `DetachedApp`, so `jumpToTab` keeps its old path inside a popout.
- **No new Tauri command, no Rust edit.** The `cockpit` experiment keeps its
  `Settings.cockpit` / Rust `Option<bool>`; no `backend:stale` needed.
- **Strings** only through `useT()`, all five dictionaries (en/de/es/fr/it, the
  parity test). `TranslationKey` is typed: **a step adds the keys it uses, in
  all five, in the same step**, never a later one. No app name in code. New or
  changed unverified surfaces carry `UntestedTag`, and a step that adds a pill
  adds its `lib/untested.ts` row in the same step.
- **Steering key tables are not renamed**: action `cockpit` (default **U**) and
  the `cockpit` scope keys (J/K/Enter/Space/C//) keep their ids so user
  rebindings in `settings.json` survive. `cockpit.title` stays a dictionary key
  (it is the steering scope's label even when the window label changes).
- `AttachedAgentPane`, `OverlayAgentColumn`, mail/calendar/to-do keep working
  unchanged; the root console's `+` menu, file column, splits and drag stay in
  the Root view.
- No timers, listeners or backend reads of the cockpit's exist while the surface
  is shut or sits on Root (the Root tab's lamp and the icon rail read live
  stores only). No new animation loop; nothing animates a blurred `box-shadow`;
  view switches arrive without motion (so `[data-software-paint]` needs no
  special case).

## Open decisions for the user

**Settled by the user, 2026-11-04: the recommended option of all eight.** So the
build is A1-A9: A9 (icon rail) is in, A10 (dock) is out. Carried by four
implementers (see Organisation).

Eight, folded from the planner's seven and the design document's conflicts. The
recommended option is first. "Steps that change" is in the table after them.

1. **Shape of the merge, and where the root tabs live.**
   - **(Recommended) One window; views are title-bar tabs, Root is the fifth
     view and its tab strip becomes a sub-bar.** The bar never changes between
     views, so the view tabs never shift; splits keep their per-group strips.
     Cost: one 34 px extra row in Root only.
   - Views pinned in the same strip as the root tabs (the mail overlay's fixed
     Inbox plus message tabs). No extra row and every root lamp shows in every
     view, but a tab means two things, 776 px overflows behind chevrons, split
     consoles and tab drag need rework: a much larger change.
   - Only dedupe the plumbing (shared frame, one ✓ pill, one ownership rule) and
     keep two windows. Smallest, but the user still has two windows.
2. **What does a user without the `cockpit` experiment see?**
   - **(Recommended) Exactly today's console.** No view strip, no sub-bar, no
     gauge, no cockpit doors; the strip stays in the title bar. Graduate later
     with `npm run untested -- tested cockpit.*`.
   - Ship the views for everyone now (flag removed). Faster, but unverified
     views show to people who only use the console.
   - Show the strip with the four views greyed "experimental". Discoverable, but
     advertises something that does nothing until ticked.
3. **Names: the console view and the window.**
   - **(Recommended) View "Root" with the star; the window is labelled
     "Cockpit" while the experiment is on and stays "Root console" (no visible
     label, as today) when it is off.** "Root" is the term the Root chip and the
     project header already use, and the view holds PDFs and Files tabs, not only
     terminals. Cost: the aria/title label depends on the flag.
   - View "Root"; the window is "Root console" in both states. No label switch,
     but a window named for one of its five views.
   - View "Terminals", window "Root console" (the planner's wording). Least
     string churn, but wrong for a view that hosts viewers, and it hides the
     MCP rights it carries.
4. **Which view do the doors open?**
   - **(Recommended) Ctrl+Shift+R: closed -> Root, on another view -> switch to
     Root, on Root -> close. The header gauge, steering U and the box chip's row
     always open `Now`.** Muscle memory kept; the status door always means
     status.
   - Same chord; the gauge, U and the chip reopen the last-used view (Now after a
     relaunch). A tabbed-app feel, but the gauge can land on Root.
   - Ctrl+Shift+R is a plain toggle (closes from any view); the gauge, U and the
     chip open `Now`. Simplest, but there is no key from Now to Root and back.
5. **Size when never dragged.**
   - **(Recommended) One remembered frame. Untouched default is today's console
     size (top-hung, 7vh) when the experiment is off, and the shared overlay
     size (`min(1680px, 100vw - 24px)`, centred like mail) when it is on.** The
     three-column Now view needs the width; existing console users are
     unaffected; the window never jumps between views.
   - Today's console size for everyone (Now is cramped until resized).
   - Wide for everyone (a console that never asked for it grows).
6. **Root agents in the Now roster.**
   - **(Recommended) Root agents are ordinary rows with a star "Root" chip in the
     project slot. Space/-> draws one in the detail pane; Enter (button "Open in
     Root") switches to Root with that tab active, never to the root scope and
     without closing. A root tab also docked in a mail/calendar/to-do column
     shows "Shown in the <app> overlay" and draws nothing.**
   - Root rows only ever "Open in Root" (never drawn in the pane). Fewer moving
     parts, but root agents become second-class in the roster.
   - Hide root agents from the roster. Removes the case; loses the home agent
     from "is anything waiting for me".
7. **Extras on top of the merge** (each its own agent step; none blocks it).
   - **(Recommended) Add the "Start <agent> in Root" action on Root's empty card
     and a collapsed Needs-you icon rail in Root (live-store groups only); no
     dock in the cockpit views.** The rail answers the planner's open question;
     the dock is not cheap (see below) and Root is one chord away.
   - All of the above plus the star-button dock (a root agent column in the
     cockpit views, Ctrl+1..9). Needs a fourth `overlayAgent.docks` key and a
     `frontAppOverlay` entry: `docks` and the chord routing are keyed per
     `SteeringApp` (mail, calendar, todo), so it is more than "the column takes
     a scope".
   - The merge only. Smallest; decisions stay one view away and the empty card
     stays text.
8. **Narrow windows (minimum window 800x600 = a 776 px frame).**
   - **(Recommended) Container-query breakpoints on the frame width: 820-1179 px
     the rail becomes the icon rail and roster and detail sit side by side; under
     820 px master and detail (a "Needs you N" chip opens the rail in a popover,
     selecting a row opens the detail, a back button returns), Tonight/Usage
     stack.** Depends on the icon rail of decision 7; without it the middle band
     keeps the full rail and the chip carries both.
   - Middle band only: 820-1179 px as above, below 820 px Now scrolls sideways
     inside the window.
   - Leave as today (`cockpit.css` has no breakpoint; Now overflows at 776 px).
     No work, but the merged window's smallest size stays unusable for Now.

### If the user picks otherwise

| Decision / option | Steps that change |
|---|---|
| 1 views in the root strip | A2 loses the sub-bar slot design, A3 builds a pinned-tab strip instead of the view tabs, A4 is dropped, drag/split rework added to A2 (a new large step); A9 rail moves to a bar badge |
| 1 dedupe only | A1 only (plus A5's `jumpToTab` fix and A6's root-attach rule as separate small steps); A2-A4, A7-A10 dropped |
| 2 flag removed / greyed | A3 drops the hidden-strip rule; A4 drops the "bar slot for flag off" path; the "experiment off" verification changes |
| 3 other names | strings only (A3, A4, A8; `rootConsole.view.*`) |
| 4 other doors | A5 only (`useKeyboard`, `CockpitIndicator`, `BoxScopeChip`) |
| 5 other sizes | one CSS rule in A3 |
| 6 other root-row rules | A6 (detail pane modes) and A5 (`jumpToRow`) |
| 7 dock | adds A10; merge only drops A4's Start action and A9 |
| 8 other breakpoints | A7 shrinks or is dropped |

## Steps

Each step lands with its tests, its own i18n keys (all five dictionaries) and its
own `UntestedTag` register rows, and the gates its diff touches
(`scripts/gates.sh`); no live run by an agent. Work from a worktree off a clean
base (hardlink `node_modules`, then check the test count): the tree currently
holds other sessions' uncommitted edits in files these steps touch, including
`hooks/useKeyboard.ts`, `stores/tabs.ts`, `cockpit/cockpitFormat.ts`,
`layout/HintHost.tsx` and the steering files (`lib/shortcuts/steeringBar.ts`,
`steeringCaps.ts`, `stores/keyboardSteering.ts`).

- **M0. Shared chrome (no behaviour change).**
  - `RootOverlay.tsx` takes its frame from `useFloatingFrame(storageKey(
    "rootConsoleFrame"))`; delete `beginFrameDrag`, `liveFrame`, `framing`, the
    grips array, `onBarPointerDown` and the store's
    `frame`/`filled`/`setFrame`/`toggleFilled`/`FRAME_STORAGE_KEY`. The hook must
    (a) also return `framing` (the console's Escape guard needs it; today only
    `frameClass` carries it), and (b) add `.root-overlay-rights` to its
    `BAR_NO_DRAG` (the console's own list has it: the ⚿ badge is not a button).
    The hook's `maxWidth/maxHeight: none` and `floatingFrame.*` hints replace
    the console's; `rootConsole.moveHint/resizeHint/fill/restore` become unused
    in the console: leave the keys, they are `rootConsole` help text elsewhere
    (grep before deleting any).
  - Move the pure math (`clampRootOverlayFrame`, `filledRootOverlayFrame`,
    `rootOverlayFrameDrag`, the `MIN_*`/`FILL_MARGIN` constants, the types) to
    `lib/window/floatingFrame.ts`; `useFloatingFrame.tsx` imports it from there.
    The persisted row is the same shape, so existing frames load unchanged.
  - The console's inline ✓ becomes `<OverlayApprovals advisory={...}/>` (new
    `advisory` prop passed to `RootReviewStrip`; its count is already
    `useDomainReview().waiting`, equal to the console's `count + imports +
    drafts`). The Escape guard `reviewPanel` is replaced by `e.defaultPrevented`
    (the portal marks its Escape handled, as `CockpitOverlay` already relies on).
    Delete `rootReview.panel`/`setPanel`, the anchor `useLayoutEffect`,
    `approvalsRef`, `reviewAnchor`, and the unmount `setPanel(false)`.
  - Tests: `RootOverlay.test.tsx` (frame, fill, ✓ pill cases; the `filled` store
    assertion becomes a localStorage/behaviour one), `OverlayApprovals.test.tsx`,
    `RootReviewStore.test.ts`; the math tests follow the file.
- **M1. Split `RootOverlay.tsx` (pure move).** `RootOverlay.tsx` keeps
  `RootOverlayHost` and a new shell (backdrop, frame, bar, controls, Escape,
  `useRootMcpRights` for the ✓ advisory); the layout tree, pane layer, drag,
  `GroupStrip`, `+` menu, `manageAgents`, ◫ file column and the
  `TabScopeContext` provider move to `layout/RootView.tsx`. The shell gets a
  **bar slot** (a ref'd element in the title bar): with the view strip hidden
  (experiment off) the view portals its sole-group strip, `RootRightsBadge` and
  ◫ toggle into it, exactly today's look; the sub-bar (M3) is the other
  placement. The view passes `rights` back as a prop (one fetch, in the shell).
  The Escape handler stays in the shell but must know the view's transient state
  (`addMenu`, `manageAgents`, `dragging`, which live in the view): the view sets
  a `busyRef` the shell reads. Tests keep passing with import changes only;
  `CenterPanelRootStandDown`, `RootConsoleViewers`, `RootTabsPersist` untouched.
- **M2. One store, one surface.**
  - `stores/rootOverlay.ts`: add `view: "root" | CockpitView`, `openView(view)`,
    `rootViewShown(state)` (`open && view === "root"`); `show()` forces `root`;
    `close()` keeps `view` (session-only; a relaunch starts on `Now` when the
    gauge opens it). Import the view types from a new
    `lib/cockpit/views.ts` (`CockpitView`, `COCKPIT_VIEWS`), re-exported by
    `stores/cockpit.ts`, so the two stores never import each other.
  - `lastClosedAt` **stays in `stores/cockpit`** (Tonight's "away since" is about
    the cockpit): the shell stamps it in an unmount cleanup, and only when it
    closes while on a cockpit view.
  - `stores/cockpit.ts`: delete `overlayOpen`, `view`, `openOverlay`,
    `closeOverlay`, `toggleOverlay`, `setView`; keep roster/filter/selection
    state. `showScope` stays a pure filter setter; its caller
    (`CockpitProjects`' Agents button) also calls `openView("now")`.
  - Shell: view strip as `role="tablist"` in the title bar (the shipped `.tab`
    strip; roving Left/Right), hidden unless the `cockpit` experiment is on, and
    the **effective view is `"root"` whenever the flag is off** (the stored view
    may be stale); `CockpitViewBody` stays (`cockpit/CockpitViews.tsx` is the body
    switch, it is not deleted) and is `React.lazy`-loaded here; box filter select
    only on cockpit views; one Escape handler (ignores events from
    `.root-overlay-region`, `.cockpit-detail-pane`; defers to open menus, the
    ✓ panel, drag, `framing`); label and `aria-label` per decision 3.
  - With the flag on the backdrop also wears `app-overlay-backdrop` (centred) and
    the frame takes the shared overlay size (decision 5); off, the classes and
    size are exactly today's (`.root-overlay-backdrop` hangs 7vh from the top, and
    a 93vh frame would run off the bottom).
  - Delete `components/cockpit/CockpitOverlay.tsx` and `LazyCockpitOverlayHost`
    in `AppShell.tsx`; the root host keeps its late mount (DOM order). Note it
    now sits above the Models & agents overlay (the cockpit was below it): check
    the Usage view's door to the Machines overlay still shows on top. CSS: fold
    `.cockpit-overlay` into the console's; remove it from **both** `mail-todo.css`
    shared lists (`.cockpit-overlay` width/height at ~484 and
    `.cockpit-overlay-body` at ~511); the flag-on size rule replaces it.
  - Tests: `CockpitShell.test.tsx` becomes the merged shell test (open on a view,
    strip hidden and effective view `root` with the flag off, Escape/backdrop,
    lazy view mount, `show()` forces Root); `RootOverlay.test.tsx` gains view
    cases. Keys: `rootConsole.view.root` (+ aria), `rootConsole.title` reused.
- **M3. Root view chrome (design layout A).** In `RootView.tsx` and the shell
  (flag on only): the **sub-bar** under the title bar holds the sole-group strip
  and `+`, `RootRightsBadge`, the ◫ toggle (a split layout keeps a strip per
  group and drops the sub-bar); the title bar's **Root tab lamp**: an amber count
  when a root tab asks, the working ring when one works, from `stores/activity`
  and `agentRosterFacts` for `ROOT_SCOPE` only (no timers, no backend; reuse the
  tab strip's lamp classes so the software-paint rule is inherited); the empty
  card's primary "Start <default agent> in Root" (the same door as the `+`
  menu, `useAddTabMenuData(ROOT_SCOPE)` -> `agentShortcutSlots`; with no
  Root-chip agent it shows the `overlayAgent.rootNotAllowed` hint instead).
  Keys: `cockpit.view.rootAsking`, `rootConsole.emptyStart`, register rows
  `rootConsole.viewStrip`, `rootConsole.subBar`, `rootConsole.emptyStart`.
  Dropped if decision 7 is "merge only" (the Start action) or decision 1 is B.
- **M4. Entry points and call sites.**
  - `CockpitIndicator`: pressed/toggle read `rootOverlay` (`view !== "root"`);
    click -> `openView("now")` or close.
  - `BoxScopeChip` "Open cockpit" -> `openView("now")`; `useKeyboard`: steering
    **U** -> `openView("now")` + `enterRegion("overlay")`; Ctrl+Shift+R per
    decision 4 (`toggleRootConsole` encodes it, so the chord and any other
    caller agree); the Ctrl+N "root console steps aside" close keeps `overlay.open`.
  - `closeOverlay()` callers become `rootOverlay.close()`: `CockpitRoster`
    (`jumpToRow`), `CockpitRail`, `CockpitProjects` (`openProject`),
    `CockpitTonight` (open chart), `CenterPanel` (`PaneStandDown` "Show here");
    `CockpitTonight`'s `setView("now")` becomes `openView("now")`. **`jumpToRow`
    for a root row calls `show(key)` and must not then call `close()`** (it would
    close the Root view it just opened); every other row is unchanged.
  - `lib/shortcuts/tabJump.ts` (not `lib/tabs/`): `jumpToTab(ROOT_SCOPE, key)`
    calls `useRootOverlayStore.getState().show(key)` instead of `bringUpScope`
    (outside a popout; inside one keep the old forwarded path). `openPromptChartTab`
    keeps `bringUpScope` (root's prompt chart tab is a separate, pre-existing
    case; note it in the test). Audit every caller: `useKeyboard` (status keys),
    `CommandPalette`, `PillStatusBars`, `PillTabMarks`, `TodoCard`,
    `PromptChart`, `AgentSchedulesView`, `CockpitRail`, `CockpitRoster`.
  - `MachinesOverlay` / `ModelsOverlay` Escape guards (`rootOverlay.open` =
    "a sign-in opened the console above me") become `rootViewShown`: with the
    cockpit's Usage view open underneath, `open` would swallow their Escape.
  - Tests: `headerOrder`, `ProjectPillRemoteOnlyMenu`, `CockpitNow` (Enter on a
    root row), steering suites (U), a new `JumpToRootTab` case (no `setActive`).
- **M5. PTY ownership.**
  - `CockpitDetailPane.tsx`: drop `inConsole` / mode `console` and
    `cockpit.detail.inConsole`; add mode `docked` (decision 6) reading
    `overlayAgent.docks`; root tabs attach via `AttachedAgentPane` (root's
    `shownKeys`); the detail header's button reads "Open in Root" for root rows
    (`CockpitDetail`), "Jump" otherwise; roster rows get the star "Root" chip.
  - `rootViewShown` replaces `open` where the question is "is root's layout on
    screen": `OverlayAgentColumn` (`consoleOpen`), `embed/fileViewer/sourceJump`,
    `viewers/tex/openTexWorkspace`, and the Machines/Models Escape guards (M4).
    Keep `open` for `CenterPanel`'s slot stand-down and focus rule,
    `AssistantView` and the shell's own Escape. In `CenterPanel`,
    `drawnElsewhere` for root tabs follows what is actually drawn
    (`rootViewShown || shownKeys.has(key)`) instead of `open`, so opening
    Projects or Usage does not wake every sleeping root terminal.
  - `PaneStandDown`'s copy says where the tab is ("Shown in the cockpit" stays
    for project tabs; root's is the console's own line).
  - Tests: `CockpitStandDown` (console-mode cases replaced by root-attach and
    docked), `OverlayAgentColumn`, `CenterPanelRootStandDown`, `SleepingTabs`.
- **M6. Narrow windows (decision 8).** `cockpit.css` container queries on the
  body (frame width, not viewport): the icon-rail band, the master/detail state in
  `CockpitNow` (selected row opens the detail, back button, Esc/back returns),
  the "Needs you N" chip opening the rail in a `ContextMenuPortal`, Tonight/Usage
  stacking, the box filter folding to an icon. Keys: `cockpit.narrow.needsYou`,
  `cockpit.narrow.back`; register row `cockpit.narrow`. Dropped or trimmed per
  decision 8.
- **M7. Strings, registers, docs.**
  - Reword (keys added earlier stay): `cockpit.standDown`, `cockpit.showHere`,
    `settings.cockpit(+Help)` ("views of the root console"), remove
    `cockpit.detail.inConsole`; run the dictionary parity test.
  - `lib/untested.ts`: reword `cockpit.title`, `cockpit.indicator`,
    `rootOverlay.1` (the ✓ half moved to `overlayApprovals.button`),
    `cockpit.standDown`; add `rootConsole.rootRow` (Enter/Space on a root
    roster row). Ids already stamped stay.
  - Docs: `docs/context/root_console.md` new "Views" section (one-line pointer,
    no history) and the Escape/ownership rules; `docs/context/cockpit.md`
    ("one header overlay" -> "the console's views", detail-pane root rule, entry
    points); `docs/filemap_frontend.md` rows (`rg -n "cockpit/|RootOverlay|
    useFloatingFrame|OverlayApprovals|overlayAgent"`; the cockpit rows are
    ~189-192) for `RootOverlay.tsx`, `RootView.tsx`, `lib/window/floatingFrame.ts`,
    `lib/cockpit/views.ts`; status lines of `docs/desktop_cockpit_plan.md` and
    `docs/prompt_universe_plan.md` (C7 is now "a fifth cockpit view of the console window").
    Add the 🖐️ boxes with the four platform children in the matching `todo/`
    group (`rg -n` first). Help topic waits for the user's test.
- **M8 (decision 7). Needs-you icon rail in Root.** A 40 px rail beside Root's
  region: one icon per group with its count, amber asking, red interrupted;
  groups from live stores only (asking, interrupted, root approvals,
  finished-not-seen, alerts); never `usePushRequests`, `useMarkupAsks` or
  `useLoadSchedules` (the full rail's groups appear when it is opened). It is
  `CockpitRail`'s data in a different density, not a variant: extract the
  live-store part of `buildDecisions`' inputs into a hook that carries no
  `useCockpitNow` clock. Never takes keyboard focus from a terminal. Fold state
  per machine, new `storageKey("cockpitRootRail")`. Keys `cockpit.rail.collapsed/
  expand/collapse`; register row. Shares the narrow band's icon rail (M6).
- **M9 (decision 7, only if chosen). Dock in cockpit views.** A star button docks
  a root agent column (`OverlayAgentColumn`) on the right of Projects, Tonight,
  Usage; in Now it selects the docked or last root agent in the detail pane.
  Adds a fourth `overlayAgent.docks` key and a `frontAppOverlay` entry without
  making it a walked `SteeringApp`; Esc ignores `.overlay-agent-column`.

## Agent steps

| Agent step | Plan sections | Files |
|---|---|---|
| A1 Shared chrome | M0 | `layout/RootOverlay.tsx`, `common/useFloatingFrame.tsx`, new `lib/window/floatingFrame.ts`, `stores/rootOverlay.ts`, `layout/OverlayApprovals.tsx`, `stores/rootReview.ts`, `__tests__/root/RootOverlay.test.tsx` |
| A2 Split | M1 | `layout/RootOverlay.tsx` (shell + host), new `layout/RootView.tsx`, `__tests__/root/RootOverlay.test.tsx` (imports) |
| A3 One surface | M2 | `stores/rootOverlay.ts`, `stores/cockpit.ts`, new `lib/cockpit/views.ts`, `layout/RootOverlay.tsx` (shell), `layout/AppShell.tsx`, delete `cockpit/CockpitOverlay.tsx`, `styles/subwindows.css`, `styles/mail-todo.css`, `styles/cockpit.css`, `__tests__/cockpit/CockpitShell.test.tsx`, i18n + `untested.ts` rows |
| A4 Root view chrome | M3 | `layout/RootView.tsx`, `layout/RootOverlay.tsx` (title bar lamp), `styles/subwindows.css`, i18n + `untested.ts` rows |
| A5 Entry points | M4 | `header/CockpitIndicator.tsx`, `projects/BoxScopeChip.tsx`, `hooks/useKeyboard.ts`, `lib/shortcuts/tabJump.ts`, `cockpit/CockpitRoster.tsx`, `CockpitRail.tsx`, `CockpitProjects.tsx`, `CockpitTonight.tsx`, `layout/CenterPanel.tsx` (one line), `header/MachinesOverlay.tsx`, `models/ModelsOverlay.tsx` |
| A6 Ownership | M5 | `cockpit/CockpitDetailPane.tsx`, `CockpitDetail.tsx`, `CockpitRoster.tsx` (chip), `layout/OverlayAgentColumn.tsx`, `layout/CenterPanel.tsx`, `embed/fileViewer/sourceJump.ts`, `lib/viewers/tex/openTexWorkspace.ts`, `__tests__/cockpit/CockpitStandDown.test.tsx`, `__tests__/root/*` |
| A7 Narrow windows | M6 | `styles/cockpit.css`, `cockpit/CockpitNow.tsx`, `CockpitRail.tsx`, `CockpitTonight.tsx`, `CockpitUsage.tsx`, `__tests__/cockpit/CockpitNow.test.tsx` |
| A8 Strings + docs | M7 | `lib/i18n/{en,de,es,fr,it}.ts` (rewording), `lib/untested.ts`, `layout/SettingsPanel.tsx` (labels), `docs/context/root_console.md`, `docs/context/cockpit.md`, `docs/filemap_frontend.md`, plan status lines, `todo/` |
| A9 Icon rail (decision 7) | M8 | new `cockpit/CockpitRailIcons.tsx`, a live-decisions hook in `components/cockpit/useCockpitData.ts`, `layout/RootView.tsx`, `styles/cockpit.css` |
| A10 Dock (decision 7, optional) | M9 | `stores/overlayAgent.ts`, `layout/useOverlayAgent.ts`, `layout/OverlayAgentColumn.tsx`, `lib/shortcuts/appOverlays.ts`, `layout/RootOverlay.tsx` (button) |

## Organisation

**Revised 2026-11-04 at the user's request: fewer implementers.** The A-steps
above stay the units of work (and of the "If the user picks otherwise" table);
four implementer agents carry them, one after another in **one worktree**, so no
merges between parallel branches and no shared-file conflicts (i18n
dictionaries, `untested.ts`, `CenterPanel.tsx`, `CockpitRoster.tsx`). A10 is out
(decision 7).

| Implementer | A-steps | Why together |
|---|---|---|
| I1 Shell | A1 + A2 + A3 | all three rewrite `RootOverlay.tsx` and `stores/rootOverlay.ts`; one agent keeps the one large file in one head |
| I2 Root view | A4 + A9 | Root's sub-bar, title lamp, Start action and icon rail all live in `RootView.tsx` |
| I3 Wiring | A5 + A6 | entry points and attach ownership share `CockpitRoster.tsx`, `CenterPanel.tsx` and the `jumpToRow` rule |
| I4 Finish | A7 + A8 | narrow layout, then final strings, `docs/context/*`, filemap rows, `todo/` |

Graph: I1 -> reviewer -> I2 -> I3 -> I4 -> final review. Two reviewers in all:
one after I1 (the store and shell rewrite is the risky part), one final over the
whole range (covers I2-I4). Never more than one agent at a time.
Each implementer commits green **per A-step** inside its run (so a reviewer or a
continuation can bisect), and if it runs low on context it stops at a green
commit, writes `docs/cockpit_root_merge_handoff.md`, and a fresh agent
continues the same implementer step in the same worktree. Cost of fewer
agents: I1 is ~3 agent-days of work in one run, so a continuation there is
likely; the wall-clock is longer than the parallel A4 || A5 || A6 batch.

## Verification

Automated (per step, then `scripts/gates.sh --all` once at the end):
`npm run build`, `npm test` (watch the test count when files move), `npm run
lint` (no new warnings or `any`), `scripts/brand-check.sh`; no Rust gate runs
unless a Rust file is touched (none planned). The i18n parity test and
`SettingsSearchCoverage`, `headerOrder` must stay green. Tests that must stay
green untouched: `RootConsoleViewers`, `RootTabsPersist`, `RootScopeRestore`,
`RootScopeParity`, `AddTabToRoot`, `InstallInRootConsole`,
`ProjectShellInRootConsole`, `MobileRootAccess`, `OverlayAgentStore`.

Live click-through (the user, dev build after commit; agents never start the
app). Report plainly that none of it was run:
1. Experiment **off**: Ctrl+Shift+R opens the console exactly as before (same
   size/position, top-hung, strip in the bar, splits, ◫ files, `+` menu, ✓ pill);
   no view strip; no gauge.
2. Experiment **on**: the bar shows Now / Projects / Tonight / Usage │ Root; the
   gauge, U and the box-chip row open on Now; Ctrl+Shift+R opens Root, and from
   Now goes to Root; on Root it closes.
3. Resize and move the window on Root, switch to Now/Usage: same frame;
   relaunch: frame restored from the old `rootConsoleFrame`. Switch Root -> Now
   -> Root: the terminals re-attach intact (as after a close and reopen today).
4. Run a one-click install and a remote login: the console opens on Root, on the
   new tab, even when it was on Now.
5. With a root agent working: Now lists it with the Root chip; Space draws it in
   the pane; Enter ("Open in Root") shows it in Root without switching the
   project/scope behind. Steering status keys and the palette on a root tab do
   the same.
6. ✓ Approvals: one pill in every view; approve a root proposal; the badge and
   the Needs-you rail agree; Escape closes the open panel before the window.
7. Mail overlay with a docked root agent, open the surface on Now and select that
   agent: the pane says it is shown in the mail overlay; nothing resizes.
8. A project agent selected in Now with that project behind: its pane shows the
   stand-down line; close the surface; the pane returns intact. Open Projects:
   sleeping root terminals stay asleep.
9. Phone: switch to root from the phone: the console raises on Root; the phone's
   terminal keeps working.
10. Usage -> Machines: the Machines overlay opens on top and Escape closes it
    first.
11. At 800x600 (decision 8), Now is usable; the Root view's sub-bar scrolls.
12. Repeat on Linux (X11), Linux (Wayland), Windows, macOS; under
    `[data-software-paint]` views arrive without motion.

## Design/plan conflicts

Resolved by this review: the conflict list in the design document now points at
the Open decisions above. Where they were real choices they are decisions 1
(strip placement), 3 (names), 4 (doors), 5 (size), 7 (rail, dock, empty action)
and 8 (narrow). The rest agreed: box filter only on cockpit views, ✓ Approvals
in the title bar, Enter/Space on root rows, popouts, store and key retirement.

## Open (not decided here)

- C7, the sphere, becomes a fifth cockpit view of this window (it joins the four
  before the divider); its own plan applies.
- A Now view for the **assistant** (Tabby) scope stays out: the roster never
  lists it.
- A global, rebindable chord from a Root terminal to `Now` (there is none: a
  terminal owns the keyboard, so today it is close, then the gauge or U). Add it
  only if the user asks; steering action ids stay as they are.

## Review notes (2026-11-04)

Checked against the tree as it is now (other sessions' edits present).

Confirmed: the `jumpToRow` -> `bringUpScope` -> `setActive(null)` bug
(`tabJump.ts`); `RootOverlay`'s frame code duplicates `useFloatingFrame` with the
same persisted `{frame, filled}` row; the inline ✓ pill and `rootReview.panel`/
`setPanel` are used nowhere else (one test aside); file paths, store fields and
localStorage keys named in both documents exist (`rootConsoleFrame`,
`cockpitRailWidth`, `cockpitDetailWidth`, `overlayAgentWidth`,
`cockpitOverlayFrame`), as do `cockpit.title`, `cockpit.detail.inConsole`,
`overlayAgent.rootNotAllowed` and the experiment `cockpit`.

Fixed in this document:
- **Wrong path.** `jumpToTab` lives in `lib/shortcuts/tabJump.ts`, not
  `lib/tabs/`. The audit list was wrong: `statusJump.ts` is not a caller
  (`useKeyboard` is) and `PromptChart`, `AgentSchedulesView`, `CockpitRail` were
  missing.
- **Deleting `CockpitViews.tsx` contradicted M2** (the body switch is still
  needed); it stays.
- **Typed i18n keys.** The old M5 added keys after the steps that used them, so
  `npm run build` would fail in between; each step now adds its own keys and
  register rows.
- **`jumpToRow` closing the window it just opened**: a root row must `show(key)`
  and not `close()`.
- **Escape guards** after the split: `addMenu`, `manageAgents`, `dragging` live in
  the view, so the shell needs a `busyRef`; `framing` must be exposed by the hook;
  `reviewPanel` becomes `defaultPrevented`.
- **Hook gaps** for M0: `.root-overlay-rights` missing from the hook's
  `BAR_NO_DRAG`.
- **`MachinesOverlay`/`ModelsOverlay` Escape guards** must not keep `rootOverlay.open`:
  opened from the cockpit's Usage view, the merged window would swallow their
  Escape.
- **Backdrop and size**: the console is top-hung (`.root-overlay-backdrop`, 7vh)
  and the shared overlay size would run off the bottom; the flag-on window needs
  `app-overlay-backdrop`. Both `mail-todo.css` lists name `.cockpit-overlay`.
- **Stacking**: the merged window moves above the Models & agents overlay.
- **`lastClosedAt` and the stores**: moving it into `stores/rootOverlay` would add
  a store cycle and change "away since" to include terminal-only sessions; it
  stays in `stores/cockpit`, stamped from a cockpit view's close.
- **Sleeping root terminals**: keeping `open` for `drawnElsewhere` would wake every
  sleeping root terminal when any view opens; it now follows what is drawn.
- **Hydration**: Now never hydrates root (restoring brings saved agents up); a
  Fixed decision records the limit.
- **Popouts**: `jumpToTab` keeps its old path inside a popout.
- **Orphans**: `cockpit.title` stays a key (steering label); `RootRightsBadge`'s
  fetch (`useRootMcpRights`) moves to the shell.
- **Organisation**: A1 held two separate subsystems' worth (frame + split of a
  1300-line file) and A2 held store, shell, CSS and tests; now four steps (A1-A3
  plus the Root view chrome A4), and the design's layout (sub-bar, lamp, Start
  action, narrow, rail, dock) has steps.
- **Dock is not cheap**: `overlayAgent.docks` and `frontAppOverlay` are keyed per
  `SteeringApp`; the design's "the column takes a scope" understated it.
- **Wrong icon path in the design**: the star is `layout/StarIcon.tsx`, not
  `common/icons/Icon.tsx`.

No Fixed decision was undone; two were refined (CenterPanel's wake rule, the
`drawnElsewhere` source) and one added (hydration).
