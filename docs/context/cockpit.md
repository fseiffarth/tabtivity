# Desktop cockpit

The cockpit answers the question the phone's Home answers: *is anything waiting
for me, anywhere?* It lists every project's agent tabs, the decisions waiting on
the user, tonight's schedules and the machines. It is not a window of its own:
the root console's window carries four more
views (Now, Projects, Tonight, Usage) beside **Root**, the console proper
(`docs/context/root_console.md`, "Views"). One frame, one title bar, one
Escape rule, one ✓ Approvals pill. Plan and fixed decisions:
`docs/desktop_cockpit_plan.md`; the merge: `docs/cockpit_root_merge_plan.md`
(decisions), `docs/cockpit_root_merge_design.md` (layout), `docs/cockpit_root_merge_handoff.md`
(build log). It was an experiment (`cockpit`) until the follow-up round
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
shown one mounts; Root mounts only while shown. So the backend fan-outs (push requests per git-readable
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
centred column; Usage is a top strip (CLIs, this machine) over `CockpitMachineList`,
one row per machine with project hosts and global machines merged by host name.

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

Three tabs are not attached: one a popout window draws (a second view would
fight it; the pane offers "Open in its window"), a root tab docked in an open
mail / calendar / to-do overlay's agent column (mode `docked`, from
`useDockedApp`: "Shown in the {name} overlay"; the column is the one drawer),
and a remote tab whose host is down (its owner never spawned a PTY;
`lib/tabs/remoteHold`, the pane layer's own rule, says so).

`CenterPanel` wakes root's sleeping terminals by what is drawn
(`drawnElsewhere`: `rootViewShown || shownKeys.has(key)`), not by whether the
window is up: Projects / Usage wake none, Now's pane wakes the one it draws, the
Root view wakes all. Its slot stand-down and focus rule still follow `open`.

## Narrow windows

The shell measures the frame, not the viewport (`lib/window/frameBand`): 1180 px
and up is the full layout; 820 to 1179 px Now's Needs-you column is the 40 px icon
rail (the full rail in a `ContextMenuPortal` popover, `NeedsYouPopover`) beside
roster and detail (detail floors at 360 px); under 820 px Now is master / detail
(a "Needs you N" chip, a click or Space on a row opens the detail, the back bar or
Escape on it returns), Usage's top strip stacks (Tonight is one column at every width), the title bar drops its label and
folds the box filter into a ▾ icon, and Root swaps its icon rail for the same
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

The roster's keys (J/K or ↓/↑, Enter, Space or →, C, /) live in the steering
bindings table under scope `cockpit`, so they are rebound in Settings with the
other bare keys. They are not steering-mode keys: `scopesMeet` keeps them out of
conflicts with the mode-wide ones. Steering opens the cockpit's Now view with U
(`openView("now")`, then the overlay region); so do the header gauge and the box
chip's row. Ctrl+Shift+R is `toggleRootConsole`: closed -> Root, another view ->
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

## Machines and Models over the window

The Usage view's "Manage machines…" and the Root view's "Add agent..." open the Machines /
Models & agents overlay from the window. All three are `.modal-backdrop`s at one z-index
with the window last in DOM order, so the overlay used to land under it and one Escape
closed both. Now an overlay that mounts while the window is up sets `stores/consoleCover`
(`coverConsole`), the window wears `.under-overlay` (one layer down: `--z-modal` - 1, so the
overlay and the dialogs it raises, which are later in DOM, stay above it), and the Escape
handlers ask `lib/window/consoleFront`: the overlay closes on the first Escape, the window on
the next. An overlay opened first with the window raised over it later (a terminal sign-in or
install) is unchanged: the window opening afresh clears the flag and is in front. So does
`show(key)` on an already-open window (an install or sign-in tab the covering overlay starts).
The mail / calendar / to-do overlays are also at `--z-modal` and precede the window in the
DOM (Machines precedes them, Models follows), so while the window is under an overlay
`RootOverlay` sets `html[data-console-under-overlay]` and `apps.css` drops those three to
`--z-modal` - 2: window above them, the overlay above the window, as before. The window's
Escape marks the key handled (`preventDefault`) so an overlay opened after it does not
take the same press.
