# Cockpit apps merge: handoff log

Plan: `docs/cockpit_apps_merge_plan.md`. Branch `cockpit-apps` (worktree
`.claude/worktrees/cockpit-apps`), based on `develop` d6eefa36. Frontend only; not
run live (nothing here can be). Design notes live in `docs/context/cockpit.md`
("The apps and system pages as views") and `docs/context/root_console.md`
("Views", "Docked in the app views").

Baseline (develop d6eefa36, `npm test`): 1088 files, 11187 tests, 1 failing
before any change: `mobile/MobileTerminalTranscript` ("keeps the chat while a
/clear sent mid-turn waits behind the turn"; it is flaky: it passed in one of the
later runs). Under the machine's load three other tests flake in the `--changed`
run and pass alone: `terminal/TerminalAiSwitch`, `pdf/PdfZoomRaster`,
`tex/BibCards`, `mobile/MobileProjectPrompts`.

## Steps and commits

| Step | Commit | What |
| --- | --- | --- |
| S1 | 87e736d8 | View ids and groups, grouped strip with the three bands, gates, Usage view deleted |
| S2 | 6ff58f38 | Agents / Models / Machines views; overlay hosts, `consoleCover`, `consoleFront`, `.under-overlay` deleted |
| S3 | 00a44101 | Mail / Calendar / To-do views; derived open state; `appOverlays` -> `appViews`; docked-column stand-downs deleted |
| S4 | 213cc7bd | `agents` header item and `AgentsButton`; headerPins defaults |
| S5 | 69bf72ac | docs, filemap, register rows, comment pass, dead CSS, to-do close-then-open removal |

Gate results (`scripts/gates.sh`, frontend gates: brand, whitespace, lint, build,
vitest `--changed`): S1 806 files / 7890 tests, S2 806 / 7884, S3 806 / 7880, S4
807 / 7883. Each had only the flakes named above failing (all pass alone).
Lint: no new warnings (28 warnings repo-wide, all pre-existing; the
`MachinesIndicator` unused-disable directive is on develop too). Full `npm test` after S5 (the tree at 69bf72ac): 1088 files, 11174 tests, only
`MobileTerminalTranscript` failing (baseline 1088 / 11187, same single failure). The
13 fewer tests are the deleted machinery's cases net of the new ones (strip, views,
Agents button, shownApp); no suite shrank beyond that.

## Choices the plan left open

- `lib/cockpit/views.ts` keeps `CockpitView` as the three cockpit views and adds
  `AppView`, `ConsoleView`, `WindowView`, `VIEW_GROUPS`; `RootOverlayView` is
  `WindowView`. Feature gates live in `lib/cockpit/viewGates.ts` (`viewEnabled`);
  `rootOverlay.openView` refuses a gated-off view (so an `openOverlay()` call with
  mail switched off, or with settings not loaded yet for mail, does nothing, as the
  old host rendering nothing did), and `RootOverlay` falls a shown view whose gate
  goes off back to Now.
- One source of truth for "is X open": `rootOverlay.open && view === X`, exposed as
  `viewShown` / `isViewShown` / `useViewShown`. The old `overlayOpen` / `open` flags
  are gone; `openOverlay()` / `closeOverlay()` stay on the mail, calendar and todo
  stores as forwarders. What `openOverlay` / `closeOverlay` used to do besides
  flipping the flag (mail's `newCount` = 0, queued search resume/drop, unread and
  priority counts; todo's drag and `focusTaskId` reset) runs on a
  `useRootOverlayStore.subscribe` at the foot of `stores/mail.ts` / `stores/todo.ts`,
  so every door counts (a view switch, the window's Escape). I checked statically
  that `rootOverlay`'s import graph never reaches the mail, todo or calendar
  stores, so there is no cycle.
- `stores/machinesOverlay.ts` is deleted (two call sites call `openView("machines")`);
  `stores/modelsOverlay.ts` is now only the section each of the Agents and Models
  views is on plus `openOverlay(section?)` (a section opens the view that holds it;
  no argument opens Models).
- Agents view sections (Agents & CLIs, Usage = `CliOverviewBody`, Skills) and Models
  view sections (Local models, Ollama) are tabs in the window's sub-bar
  (`layout/viewBarSlots.tsx`), the same mechanism as Mail's strip. A visited section
  stays mounted (hidden) while the view is shown, as the old overlay did, so an
  install log survives a section switch; leaving the view unmounts them. The
  overview grid of four tiles is gone.
- Machines view = this machine's meters + the project hosts with lamps and Connect
  (Usage's "Remote" part) above the existing machine tiles. "Running models +
  Unload" needed no move: the Models view's Local models section already has them.
- Narrow band (< 820 px): the strip shows the current view's tab plus a ▾ that opens
  a menu of every view; mid band hides the labels in CSS (they stay as title and
  accessible name). The Mail account switcher moved from the old mark to the start
  of Mail's sub-bar strip; the ✦ docked-agent button is portaled into the title
  bar's controls before the ✓ pill (`ViewBarAgentSlot`).
- Per-app ✓ Approvals pills (`OverlayApprovals domain="mail"|"calendar"|"todo"`) are
  gone: the window already has the one whole-queue pill on every view.
- Mail keep-alive: `RootOverlayHost` keeps `RootOverlay` mounted with `hidden`
  (`display: none`, no body but Mail, Escape off, gate fall-back off) while a
  composer tab exists and the window is closed; on another view only `MailView`
  stays, hidden. `MailView` is a lazy chunk, loaded only when shown or a composer
  is waiting.
- Dialogs: host-key, HPC guard, Remote machines manager, machine monitor, HPC
  wizard, and the CalDAV conflict prompt are mounted in `AppShell` after
  `RootOverlayHost` (same `--z-modal`, DOM order). `RemoteConnectDialog` portals
  to `<body>` and was on top already. Verified by reading mount order and the
  `.modal-backdrop` CSS only.
- Steering: `mail` / `calendar` / `todo` regions walk the window's frame minus the
  view strip (`steeringRegion`'s `appFrames`); `regionForLayer` maps the window to
  the shown app. The chrome level walks all ten tabs (and the ▾ in the narrow band).
- To-do's four "open the mail / calendar" doors no longer close the board first
  (`TodoMailRail`, `TodoPane`, `TodoAgendaRail`, `TodoCardDialog`): the open call
  switches the view, and a close-then-reopen across an `await` would have flashed
  the window and stamped Tonight's "away since".
- Header: `agents` sits between `inbox` and `models` in the apps run and is pinned by
  default; Mail / Calendar / To-do / Models / Machines buttons already pinned.
  Machines' click now toggles like the others.
- Calendar has no "arrivals" to clear on show (its badge is derived and the
  arrival marks expire by timer), so only Mail's `newCount` is cleared on show.
- Dead CSS removed: the Models overview grid and trail, Usage view. Class names
  `models-overlay-*`, `*-overlay-body` are kept on the new view wrappers because
  pane rules are written against them.

## Gotchas

- `npx eslint` under the RTK hook prints a summary ("No issues found") that can
  hide warnings; use `rtk proxy npx eslint ...` to see them.
- vitest `--changed` runs ~800 files in ~6 min when a shared store is touched.
- The tests that asserted the deleted machinery were deleted, not bent:
  `cockpit/OverlayOverWindow`, `cockpit/CockpitUsage`, the "docked" cases of
  `cockpit/CockpitStandDown`, the two stand-down cases of
  `root/OverlayAgentColumn`, the `frontAppOverlay` cases of
  `tabs/OverlayAgentChord` (now `shownApp`). The overlay suites were ported to the
  views: `agents/ModelsAgentsViews` (from `ModelsOverlay`), `remote/MachinesView`,
  `calendar/CalendarView`, `todo/TodoView`, `mail/MailView`; new:
  `cockpit/ViewStrip`, `shell/AgentsButton`.

## Flagged for user

- Nothing was run live. The riskiest step is S3 (Mail keep-alive with the window
  closed, docked-agent ownership, Ctrl+1-9): review it on its own.
- A one-frame concern: all ten views share `rootConsoleFrame`, so Mail now shares
  Now's size. (Plan risk; no per-view size in v1.)
- Mid band with ten icons: not measured live; the title bar's strip may crowd the
  box filter and ✓ pill at 820 px. The ▾ fold could start earlier.
- The Root view's "Add agent..." / Manage CLIs doors now switch the window to the
  Agents view (they used to float an overlay over the Root view), so the Root view
  is one tab-click away instead of underneath.
- Settings flipping `mail_client` off with an unsent composer: `MailView` drops the
  composers (`dropComposeTabs`) as before, the window falls back to Now.
- `openView("mail")` is refused while settings have not loaded (mail's experimental
  gate reads as off then); the old overlay flag would have been set and rendered
  nothing.
- The Agents view's Usage section and the Models view mount `CliOverviewBody` /
  `useModelsHub` polls only while their section is the visible one (existing
  `active` gating); a section visited earlier stays mounted hidden.
- i18n: the four non-English dictionaries got translations I wrote for the new
  labels (Agents, Models, Machines, Mail, To-do, "More views", section tabs,
  "Project hosts"); worth a native read.
- Old localStorage frame keys (`mailOverlayFrame` and four siblings) are no longer
  read; they stay in storage, harmless.

## Click-through (live, for the user)

1. Click each of the six top-bar icons (✉, 🗓, ☑, Agents, Models brain, Machines):
   the window opens on that view; a second click on the same icon closes it.
2. Mail: start a composer (+), type something, click the Now tab, come back: the
   draft is still there. Close the window with the composer open, reopen Mail: still
   there. Close the composer's tab with text: it asks.
3. Calendar: press Ctrl+1: a root agent docks on the right. Type "meeting Friday
   14:00" and watch it land (approve in the ✓ pill if asked). Switch to Now and
   select that agent: it attaches there. Back on Calendar the column draws it again.
   Escape typed in the agent does not close the window.
4. To-do: open a card with a linked mail (rail) -> Mail opens on it; the agenda
   rail's "open calendar" -> Calendar. No flash of the window closing.
5. Machines: Add machine / connect to a host never connected: the host-key dialog is
   above the window. System monitor on a machine: above the window.
6. Agents: Agents & CLIs / Usage / Skills tabs in the sub-bar; start a CLI install and
   switch to Skills and back: the log is still there. Models: Local models / Ollama;
   Unload a running model; "Manage models" jumps to Ollama.
7. Narrow the window: below 1180 px the strip is icons only (hover for names);
   below 820 px it is the current tab and a ▾ with every view.
8. Settings -> turn `mail_client` (Experimental) off: the Mail tab and the ✉ icon are
   both gone; with the window on Mail it falls back to Now. Same for the calendar,
   to-do and machines switches.
9. Steering mode: M / C / T show Mail / Calendar / To-do; Escape leaves; U opens Now
   and the up-arrow level walks all the view tabs left/right.
10. Open Root (Ctrl+Shift+R): the tab strip sits in the sub-bar as before; a root
    agent docked in Calendar is drawn in the Root view when Root is shown and in the
    Calendar column when Calendar is.
