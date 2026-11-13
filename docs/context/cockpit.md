# Desktop cockpit

The cockpit answers the question the phone's Home answers: *is anything waiting
for me, anywhere?* It lists every project's agent tabs, the decisions waiting on
the user, tonight's schedules and the machines. It is not a window of its own:
the root console's window carries nine more
views beside **Root**, the console proper (`docs/context/root_console.md`,
"Views"): Now, Projects, Tonight (the cockpit's own), Mail, Calendar, To-do (the
cross-project apps), Agents, Models, Machines (the machine's system pages). One
frame, one title bar, one Escape rule, one ✓ Approvals pill. Plan and fixed
decisions: `docs/desktop_cockpit_plan.md`; the merge: `docs/cockpit_root_merge_plan.md`
(decisions), `docs/cockpit_root_merge_design.md` (layout), `docs/cockpit_root_merge_handoff.md`
(build log); the apps and system pages: `docs/cockpit_apps_merge_plan.md` and
its handoff. It was an experiment (`cockpit`) until the follow-up round
(`docs/cockpit_root_merge_plan.md`, F2): the gate is gone, the surface is always
on, and a profile's stale `cockpit` settings key is ignored (the backend keeps
it in `Settings.extra`; nothing reads it).

## A fan-out over stores, not a store

Every reading the cockpit shows already lives in a store that owns it:
activity (lamps, turn stamps, read marks), tabs, the agent-models store
(model tag, PLAN/GOAL, last prompt), schedules, the root review queue, the
alerts feed, remote status. `stores/cockpit.ts` holds only UI state (selection,
roster cut, filters, `lastClosedAt`); which view is up is `stores/rootOverlay`'s
`view`. A copy of any row there would be a second answer that can drift from the
first.

The per-tab reading is shared with the phone: `lib/agents/agentRoster.ts` is
what `MobileBridgeHost` used to derive inline (state precedence, model tag,
marks, subagents, turn stamps). The turn-length reading is `shared/turnDuration`,
used by the phone's cards and the cockpit's roster alike. The pure layer is
`lib/cockpit/` (`roster.ts`, `decisions.ts`), with every clock passed in.

## Nothing runs while it is shut

The shell loads the views lazily (`CockpitViewBody` is `React.lazy`) and only the
shown one mounts; Root mounts only while shown (the one exception is Mail: its
unsent composers keep their text, so the Mail view stays mounted, hidden, while a
composer tab is open, even with the window closed; see "The apps and system
pages as views"). So the backend fan-outs (push requests per git-readable
project, schedules per agent target, markup asks per agent tab), the event
listeners that refresh them and the 15 s clock exist only while the view is on
screen. Root's Needs-you icon rail and its tab lamp read the same live stores as
the header badge and nothing else (the open rail adds the three loads, only
while open). The icon rail is not
drawn at all while no group has a count (the console keeps the 40 px; the live count is
the header badge's, schedule proposals the stores hold included), and the "Needs you N"
chip stands in the window's bar instead, since push / schedule / markup need the open
rail's reads and must stay one click away; an open rail
stays, 280 px by default with Now's resize grip, its width in `cockpitRootRailWidth`
(read tolerantly: a bad value is the default, an out-of-range one the nearest legal width). The header badge reads live stores only: it counts asking +
interrupted + already-loaded schedule proposals + root approvals, and not push
requests, whose read runs git per project.

Remote projects take part in a git read only while their session is connected.
The cockpit never hydrates a scope: a project that is not restored is not
given a row (the Projects view folds it into its box's "Not open" line), and
Restore is an explicit action (that fold button's right-click, or a row's ⋯ menu).

## Layout (the declutter pass)

`docs/cockpit_declutter_plan.md` made the views quieter without adding a read.
No view has a heading row (the strip names it; the untested pill rides each view's
first row, `CockpitUntested`). Now's columns are flat, one hairline apart; the
Needs-you rail has no root-approvals group (they are the title-bar pill and the
header badge only) and draws the Alerts heading once (`AlertsMenu bare`); the
roster toolbar is a filter, the state chips and one `<grouping> · <sort> ▾`
menu; the status dot is filled in the state's colour. With nothing picked and
nothing asking, the detail pane follows the latest working agent: `pickFollow`
keeps it while it works and re-points only once it stops, since every switch
re-attaches a terminal. Projects is one ~34 px row per open project (actions on
hover / focus; Today and Last active drop under the mid band, the actions move into
⋯ under narrow) with the not-open projects as one line per box; a project's
`run_host` is shown by name (`runHostLabel`), never as `host:<id>`. Tonight is one
centred column.

## The detail pane is the real Chat

Selecting an agent draws its tab through `AttachedAgentPane` with the Reader
always on, so question cards, queued prompts, Send now, Diffs and the composer
are the tab's own. The PTY stays owned by the tab's pane in `CenterPanel`.
While the cockpit draws it, its PTY id is in `useOverlayAgentStore`'s
`scopeShownKeys`, which makes that owner stand down (hidden, still mounted,
never asleep) and draw "Shown in the cockpit · Show here" in its slot. Two
visible views of one PTY would take turns resizing it. Root keeps `shownKeys`
and Tabby `assistantShownKeys`, as before.

**Root agents are ordinary rows**, with a star "Root" chip in the scope slot
(`ScopeChip`). A root tab attaches in the pane like any tab (root's `shownKeys`);
the Root view is never mounted while Now is, so one visible view per PTY holds
by construction. Root's rows exist only once root was restored this session
(`show()` restores it; a cockpit view never hydrates a scope). Enter / the
head's "Open in Root" is `jumpToRow`: it opens the Root view of this very window
on that tab, never switches the workspace to the root scope (`jumpToTab` has the
one rule: `jumpToTab(ROOT_SCOPE, key)` is `rootOverlay.show(key)`), and does not
close the window it just opened. Every other row closes the window as before.

Two tabs are not attached: one a popout window draws (a second view would
fight it; the pane offers "Open in its window"), and a remote tab whose host is
down (its owner never spawned a PTY; `lib/tabs/remoteHold`, the pane layer's own
rule, says so). A root tab docked in the Mail / Calendar / To-do view's agent
column needs no line: those views are never mounted with Now.

`CenterPanel` wakes root's sleeping terminals by what is drawn
(`drawnElsewhere`: `rootViewShown || shownKeys.has(key)`), not by whether the
window is up: Projects / Tonight and the app and system views wake none (a docked column wakes the one tab it draws), Now's pane wakes the one it draws, the
Root view wakes all. Its slot stand-down and focus rule still follow `open`.

## Narrow windows

The shell measures the frame, not the viewport (`lib/window/frameBand`): 1180 px
and up is the full layout (the view strip shows icon + label for every view, in
its four groups with a divider between; `layout/RootViewStrip`); 820 to 1179 px
the strip is icons only (the label is the tab's tooltip and accessible name, CSS
hides it); under 820 px it is the current view's tab and a ▾ that opens the rest
as a menu. In the middle band Now's Needs-you column is the 40 px icon
rail (the full rail in a `ContextMenuPortal` popover, `NeedsYouPopover`) beside
roster and detail (detail floors at 360 px); under 820 px Now is master / detail
(a "Needs you N" chip, a click or Space on a row opens the detail, the back bar or
Escape on it returns), Tonight is one column at every width, the title bar drops its label and
folds the box filter into a ▾ icon (the view strip folds too, below), and Root swaps its icon rail for the same
"Needs you N" chip in its sub-bar (or, in a split Root with no sub-bar, in the title
bar's cluster), opening the rail as the same popover (`NeedsYouChip` /
`NeedsYouPopover`; a picked row goes to its tab). Tonight's "Show" on an
item in a narrow window switches to Now and opens that agent's detail (back returns to
the list): `cockpit.detailAsked`, a one-shot request Now takes when it mounts. The band is written
on the frame (`data-band`) for the CSS and provided by context for the views that
swap what they mount, so a column that is not shown mounts nothing (a hidden detail
attaches no terminal). Unsent composer text survives that unmount: the Reader keeps
it per tab in `lib/agents/readerDrafts`, not in the pane (`NowDraft.test`).

## Keys and entry points

Steering enters a dedicated cockpit region (also when U opens Now). In the
roster, E/D or up/down move the selected row; the existing J/K, Enter (jump),
Space/right (show detail), C (continue) and / (filter) bindings use that row.
Tab moves between mounted frame, Decisions, roster and detail areas; Shift+Tab
reverses it. Elsewhere the ordinary region arrows and Enter walk/activate
controls. Enter on a composer or slider hands it native keyboard control.
Escape closes a menu/dialog first, returns a narrow detail to its roster, then
closes the cockpit. The filter's Escape resumes steering. Other cockpit views
walk their visible controls through the same region; Root and the three apps
retain their own navigation. No steering action reads or attaches another PTY.


The roster's keys (J/K or ↓/↑, Enter, Space or →, C, /) live in the steering
bindings table under scope `cockpit`, so they are rebound in Settings with the
other bare keys. They are not steering-mode keys: `scopesMeet` keeps them out of
conflicts with the mode-wide ones. Steering opens the cockpit's Now view with U
(`openView("now")`, then the overlay region); so do the header gauge and the box
chip's row. M / C / T show the Mail, Calendar and To-do views (`appViews.openApp`,
then the app's region, which walks the window's frame but for the view strip). Ctrl+Shift+R is `toggleRootConsole`: closed -> Root, another view ->
Root, Root -> close.

While the Root view is up steering's tab levels walk **Root's**
tabs, not the workspace's (`lib/shortcuts/steeringScope`): the arrows,
close / clear / plan / goal / prompt and the tab's right-click act on Root's
focused subwindow, a status key's jump to a project's tab steps the window aside,
and typing after leaving steering goes to the root terminal. The root window is then the place steered, not a layer over it.
The project ring's first station (steering's projects level: 1, left/right, and
the cycle-project chords) is the **Root view**, not the root scope: landing on it
opens the window on Root and the workspace stays on its project; while the window
shows Root the ring stands on that station, and landing on a project closes it
(`useKeyboard.landOnStation`).

Above Root's tabs steering has one more level, the window's **chrome** (the
`chrome` region, `steeringRegion`): up from the tabs (or the subwindows) walks the
view tabs, the bar's buttons and the rail toggle with left/right, Enter presses
one (a view tab opens that view), down drops a menu or returns to the tabs, up
goes on to the projects. It uses the ordinary steering keys, so rebinding them
rebinds it. The new-tab keys (steering N / O / 1-9 / + and the Ctrl+Shift+N / M,
Ctrl+1-9 chords) open the tab in Root's focused subwindow while the Root view is
up (`RootNewTabKeys`, the same tab the + menu's row builds; the window stays).

The non-steering chords follow the same rule (`useKeyboard`, `windowUp` /
`inRootView`): on the Root view Ctrl+W, the tab stepping chords (prev / next /
cycle, also from Root's own terminal, `terminalTabChord`), the subwindow stepping
chords and the files toggle act on Root's focused subwindow; Close subwindow, Hide
subwindow, Close all tabs and app fullscreen do nothing; on the other views
(Now ...) every one of these does nothing to the workspace behind the window.

## The apps and system pages as views

Mail, Calendar, To-do, Agents, Models and Machines used to float as overlays of
their own over the window (and over each other), which needed a layer of machinery
so the window and an overlay could sit side by side: `consoleCover` /
`consoleFront` / `.under-overlay` for an overlay opened from the window,
`html[data-console-under-overlay]` for the three apps, a "Shown in the {app}
overlay" line in the detail pane, a "Shown in the root console" line in the docked
column, a `STACK` of which overlay gets Ctrl+1-9. All of it is gone: the window
shows **one view at a time**, so "one visible view per PTY" is true by
construction. The pieces:

- **Which view** is `stores/rootOverlay` (`open`, `view`); the ids, groups and
  order are `lib/cockpit/views`. Whether an app is "open" is derived, never stored
  (`viewShown` / `isViewShown` / `useViewShown`); `mail`, `calendar`, `todo` and
  `modelsOverlay` keep `openOverlay()` / `closeOverlay()` as forwarders to
  `openView` / `close`, and the edge effects an open used to run (mail's
  `newCount`, queued search and counts; the board's drag and card request) sit on a
  subscription at the foot of each store.
- **Gates** (`lib/cockpit/viewGates`): `mail_client` (experimental),
  `calendar_global_app`, `todo_board`, `machines_enabled` hide the view's tab and
  its header icon; `openView` refuses a gated-off view and a shown one whose gate
  goes off falls back to Now.
- **Bodies are the existing components.** Mail: `mail/MailView` (`MailPane` and the
  composers); Calendar: `calendar/CalendarView` (`CalendarPane`); To-do:
  `todo/TodoView` (`TodoPane`); Agents: `models/AgentsView` (Settings' `AgentsPanel`
  with `AgentChips`, `CliOverviewBody`, the personal skills library); Models:
  `models/ModelsView` (the Local models section, Settings' `OllamaPanel`); Machines:
  `header/MachinesIndicator`'s `MachinesSurface surface="view"` in
  `header/MachinesView`'s frame: this machine's meters as one band, then one list
  (`header/MachinesTable`, `lib/cockpit/machines`): one row per machine, project
  hosts and global machines merged by host name, sorted by state then name, the
  global machines' tiles folded into their rows (actions, ⋯ menu, forms) and off
  machines no project uses folded into an idle strip. The Usage view is deleted: its CLI overview
  went to Agents, the running models (with Unload) were already in Models, the
  meters and the machine list went to Machines.
- **Sub-bar.** Mail's inbox/message/composer tabs and the Agents and Models
  sections ride in the sub-bar under the title bar, portaled through
  `layout/viewBarSlots` (`ViewBarStrip`, `ViewSubTabs`), as Root's strip is; a view
  with a docked agent puts its star button in `ViewBarAgentSlot` before the ✓ pill.
- **Mail keeps its composers.** `RootOverlayHost` keeps the window mounted but
  hidden (`RootOverlay hidden`, `display: none`, no body but Mail) while a composer
  tab is open and the window is closed; on another view only Mail's body stays,
  hidden. Its docked-agent column, chords and Escape are live only while shown.
- **Dialogs** the Machines view raises (host-key prompt, HPC guard, the Remote
  machines manager, the machine monitor, the HPC wizard, the CalDAV conflict
  prompt) are mounted in `AppShell` AFTER `RootOverlayHost`: all are
  `.modal-backdrop`s at `--z-modal`, DOM order is the tie-break.
- **One frame**, `rootConsoleFrame`; the old per-overlay frame keys are no longer
  read.
