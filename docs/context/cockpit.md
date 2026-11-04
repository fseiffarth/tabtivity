# Desktop cockpit

The cockpit is one header overlay that answers the question the phone's Home
answers: *is anything waiting for me, anywhere?* It lists every project's agent
tabs, the decisions waiting on the user, tonight's schedules and the machines.
Plan and fixed decisions: `docs/desktop_cockpit_plan.md`. Build log:
`docs/desktop_cockpit_handoff.md`. Behind the `cockpit` experiment.

## A fan-out over stores, not a store

Every reading the cockpit shows already lives in a store that owns it:
activity (lamps, turn stamps, read marks), tabs, the agent-models store
(model tag, PLAN/GOAL, last prompt), schedules, the root review queue, the
alerts feed, remote status. `stores/cockpit.ts` holds only UI state (open,
view, selection, roster cut). A copy of any row there would be a second answer
that can drift from the first.

The per-tab reading is shared with the phone: `lib/agents/agentRoster.ts` is
what `MobileBridgeHost` used to derive inline (state precedence, model tag,
marks, subagents, turn stamps). The turn-length reading is `shared/turnDuration`,
used by the phone's cards and the cockpit's roster alike. The pure layer is
`lib/cockpit/` (`roster.ts`, `decisions.ts`), with every clock passed in.

## Nothing runs while it is shut

`AppShell` mounts the overlay lazily and only while `overlayOpen`, and only the
shown view mounts. So the backend fan-outs (push requests per git-readable
project, schedules per agent target, markup asks per agent tab), the event
listeners that refresh them and the 15 s clock exist only while the view is on
screen. The header badge reads live stores only: it counts asking +
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

Three tabs are not attached: one a popout window draws (a second view would
fight it; the pane offers "Open in its window"), a root tab while the root
console is open (the console draws all of root), and a remote tab whose host is
down (its owner never spawned a PTY; `lib/tabs/remoteHold`, the pane layer's own
rule, says so).

## Keys

The roster's keys (J/K or ↓/↑, Enter, Space or →, C, /) live in the steering
bindings table under scope `cockpit`, so they are rebound in Settings with the
other bare keys. They are not steering-mode keys: `scopesMeet` keeps them out of
conflicts with the mode-wide ones. Steering opens the cockpit with U.
