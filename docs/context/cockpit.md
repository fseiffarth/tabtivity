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
while open). The header badge reads live stores only: it counts asking +
interrupted + already-loaded schedule proposals + root approvals, and not push
requests, whose read runs git per project.

Remote projects take part in a git read only while their session is connected.
The cockpit never hydrates a scope: a project that is not restored is not
listed (the Projects view says "not open"), and Restore is an explicit button.

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
Escape on it returns), Tonight and Usage stack, the title bar drops its label and
folds the box filter into a ▾ icon, and Root has no icon rail. The band is written
on the frame (`data-band`) for the CSS and provided by context for the views that
swap what they mount, so a column that is not shown mounts nothing (a hidden detail
attaches no terminal).

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
the new-tab keys do nothing there, and typing after leaving steering goes to the
root terminal. The root window is then the place steered, not a layer over it.
The project ring's first station (steering's projects level: 1, left/right, and
the cycle-project chords) is the **Root view**, not the root scope: landing on it
opens the window on Root and the workspace stays on its project; while the window
shows Root the ring stands on that station, and landing on a project closes it
(`useKeyboard.landOnStation`).
