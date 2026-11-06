# Cockpit apps merge: handoff log

Plan: `docs/cockpit_apps_merge_plan.md`. Branch `cockpit-apps` (worktree
`.claude/worktrees/cockpit-apps`), based on `develop` d6eefa36. Frontend only.

Baseline (develop d6eefa36, `npm test`): 1088 files, 11187 tests; 1 failing
before any change: `mobile/MobileTerminalTranscript` ("keeps the chat while a
/clear sent mid-turn waits behind the turn"), unrelated.

## Steps

### S1 — view ids and strip (87e736d8)
Done. See "Choices" below.

### S2 — Agents / Models / Machines views
In progress (this section is filled in at the S2 commit).

## Choices the plan left open

- `lib/cockpit/views.ts` keeps `CockpitView` as the three cockpit views and adds
  `AppView`, `ConsoleView`, `WindowView`, `VIEW_GROUPS`; `RootOverlayView` is
  `WindowView`. Feature gates live in `lib/cockpit/viewGates.ts` (`viewEnabled`);
  `rootOverlay.openView` refuses a gated-off view, and `RootOverlay` falls a shown
  view whose gate goes off back to Now.
- Narrow band: the strip shows the current view's tab plus a ▾ button that opens
  a menu of every view (`layout/RootViewStrip.tsx`). Mid band hides the tab
  labels in CSS (the label stays as title / accessible name).
- Agents and Models sections are tabs in the window's sub-bar
  (`layout/viewBarSlots.tsx`: `ViewSubTabs`, `ViewBarStrip`, `ViewBarAgentSlot`),
  the same mechanism Mail's tab strip uses. Agents view sections: Agents & CLIs,
  Usage (the CLIs' plan/tokens, `CliOverviewBody`), Skills. Models view sections:
  Local models, Ollama. A visited section stays mounted (hidden) while the view
  is shown, as the old overlay did, so an install log survives a section switch;
  leaving the view unmounts them.
- `stores/modelsOverlay.ts` is now only the sections each view is on plus
  `openOverlay(section?)` (a section opens the view that holds it; no argument
  opens Models). `stores/machinesOverlay.ts` is deleted (two call sites call
  `openView("machines")`).
- Dialogs raised from the Machines view (host-key, HPC guard, Remote machines
  manager, machine monitor, HPC wizard) moved in `AppShell` to after
  `RootOverlayHost`, so they land above the window at the same `--z-modal`.
- Machines view = this machine's meters + project hosts with lamps and Connect
  (from Usage) above the existing machine tiles. "Running models + Unload" needed
  no move: the Models view's Local models section already has them.

## Flagged for user
(see end of S5)

## Click-through
(see end of S5)
