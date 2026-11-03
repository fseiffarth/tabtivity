# Desktop cockpit: every project's agents, decisions and machines in one overlay

Status: **plan only.** Nothing here is implemented. Mockups (four artboards:
Now, Projects, Tonight, Usage): design canvas
https://claude.ai/artifact/SnNxvyuUSCibTE8RRqZAkr (2026-11-03, private). Where it
and this text differ, this text wins.

## Why

The phone already has a cross-project cockpit: Home's **Needs you**
(`mobile-web/src/components/NeedsYou.tsx`: agent tabs asking or cut off,
finished tabs not opened yet, then mail / to-do / calendar alerts, each with its
✓ or ▶) and the flat **Agents** list (`mobile-web/src/screens/Activity.tsx`:
every working / waiting / finished agent tab of every project, sorted by
`shared/agentSort.ts`, with model, mode marks, subagents, turn time and the last
prompt). They answer the question a phone is picked up to ask: *is anything
waiting for me, anywhere?*

The desktop has nothing that answers it. The Agents view
(`src/components/agents/AgentSchedulesView.tsx`) and the Prompt chart cover one
scope. The pill strip's status bars say *that* something is waiting in a
project but not *what*. Push and schedule proposals sit in each project's own
Agents view, root approvals are behind the console's ⚿ badge, alerts are behind
the bell, CLI usage is a side-panel view, and machines are another overlay. To
find the one session that stopped to ask something, you open projects one after
another.

The desktop has the room, and it already holds every one of these readings in
its own stores. The phone's list is *built from them* (`MobileBridgeHost.tsx`
`projectAgentStatuses`). So the cockpit is mainly a frontend fan-out over state
that already exists, and it hot-reloads into the running window.

## Fixed decisions (user, 2026-11-03)

- **Surface: a header overlay**, in the Mail / Calendar / To-do family: its own
  header button and a rebindable shortcut, mounted once in `AppShell`, kept
  across project switches, movable and resizable (`useFloatingFrame`). It is not
  a tab and gets no popout window (not mounted in `DetachedApp`).
- **Cockpit first, sphere later.** The v1 views are dense lists and boards. The
  3D sphere from `docs/prompt_universe_plan.md` becomes an optional extra view
  *inside* the cockpit in a later phase (C7), built on the cockpit's data layer
  rather than its own `promptUniverse.ts`. That plan's overlay, store and header
  button (its Step 3) are superseded by this one. Its sphere-engine extraction
  (Step 1) and performance notes still apply to C7.
- **Full detail pane.** Selecting an agent shows its live **Chat view** (the
  Reader, with composer, question cards, queued bubbles and facts row) in a
  right-hand pane, so you can follow and answer a conversation without leaving
  the cockpit. Jump-to-tab is still one key away.
- **Every module in v1**: the agent roster, the **Decisions inbox**, the
  **Project grid**, **Tonight** (schedules and the away recap) and **Usage &
  machines**.

## What the desktop adds over the phone

| Phone (today) | Desktop cockpit |
|---|---|
| Needs you: asking, interrupted, unseen done, alerts; cap 3 + Show all | The **Decisions inbox**, uncapped and grouped. It adds git push / release proposals, agent schedule proposals, root-agent approvals and open markup questions, each with its own action in place |
| Agents list: one flat list, 5 s poll | **Roster**: live from the stores, no poll; flat or grouped by project/box; filter by state, CLI, box, host; keyboard-driven |
| Tap opens the tab full-screen | **Detail pane**: the tab's live Reader beside the list. Answer, queue, send now, read diffs, then pick the next row |
| Project rows: git dot, open tab count | **Project grid**: agent counts by state, git dirty / ahead / behind, sync and SSH / VPN state, run host, time worked today, last activity, quick actions |
| Schedule summary on a project's tab card | **Tonight**: one timeline of every enabled schedule, queued / chained prompt-chart card, auto-continue tab and warm-up, across all projects, plus a **While you were away** recap |
| CLI overview sheet | **Usage & machines**: CLI usage meters with reset countdowns, CPU / RAM / GPU, Ollama loads, remote hosts and workers with connection state |

## Layout

The overlay uses `MailOverlay`'s chrome (glyph mark, title, view tabs,
controls, `.dialog-close-btn`) and joins the shared global-overlay size rule in
`src/styles/mail-todo.css` (`width: min(1680px, calc(100vw - 24px))`), so moving
between ✉ 🗓 ☑ and the cockpit does not make the window jump.

```
┌ ◎ Cockpit   [Now] [Projects] [Tonight] [Usage]      ⌕ filter  Box: All ▾  ✓ Approvals 2   ✕ ┐
├───────────────────────┬────────────────────────────────────────┬──────────────────────────────┤
│ NEEDS YOU          7  │ AGENTS  12 · 4 working · 2 asking  ▾sort│ Paper · claude 2   ↗ Jump   │
│ ● Asking (2)          │ ● claude 2   Paper      opus · PLAN  4m │ ⎇ paper-fix · opus · 61% ctx │
│   Paper · claude 2  4m│   "rewrite §3 so the proof uses…"       │ ┌──────────────────────────┐ │
│   Infra · codex     9m│ ◐ codex      Infra      gpt-5 · 2 sub 12m│ │  …conversation (Reader)… │ │
│ ■ Interrupted (1)     │   "migrate the CI matrix to…"           │ │  ╭ Question ───────────╮ │ │
│   Thesis · claude ▶ Go│ ◐ claude     Thesis     sonnet      31m │ │  │ 1 Keep lemma 2      │ │ │
│ ⇡ Push requests (1)   │ ✓ opencode   Website    qwen3 · done 2h │ │  │ 2 Inline it    (R)  │ │ │
│   Website → main [Push]│ ── Paper ──────────────────────────── │ │  ╰─────────────────────╯ │ │
│ ⧗ Schedule props (1)  │   (grouped mode: one block per project) │ └──────────────────────────┘ │
│ ⚿ Root approvals (2)  │                                         │ [composer……………………] Send ⏎ │
│ ✎ Markup questions (1)│                                         │ Schedules: next 22:00 "…"    │
│ ✉ 🗓 ☑ Alerts (3)  ✓   │                                         │ Last prompts ▸               │
└───────────────────────┴────────────────────────────────────────┴──────────────────────────────┘
```

### View 1: Now (the default)

Three columns. The rail and the detail pane can be resized, and both widths
persist (localStorage, per-viewer convenience only).

**Needs you (left rail).** This is the Decisions inbox, in the urgency order
the phone uses and with the phone's words:

1. **Asking**: agent tabs whose state is `question`, newest first. A click
   selects the tab, and the detail pane's Reader shows the question card. That
   is where it is answered. The rail never parses a screen itself.
2. **Interrupted**: `interrupted` tabs, with the tab strip's ▶ Continue
   (`TabContinueButton` from `tabs/TabLocalityBadges.tsx`, AI switch respected). It vanishes once the
   new turn shows.
3. **Push / release requests**: `git_push_mcp_proposals` for every project,
   each rendered by the existing proposal card from `GitPushMcp.tsx`,
   collapsed to one line until expanded. A push to the default branch still
   goes through that card's own approval. The cockpit adds no shortcut around
   it.
4. **Schedule proposals**: schedules where `isAgentProposal` holds
   (`lib/agents/agentSchedule.ts`: agent origin, disabled, never run), through
   `AgentScheduleProposal.tsx`'s guarded Approve / Dismiss.
5. **Root approvals**: `stores/rootReview.ts`, rendered by `RootReviewStrip`
   (the sections and Approve all it already has). The title bar's ✓ Approvals
   pill is the `OverlayApprovals` the other overlays carry.
6. **Markup questions**: open `markup_ask` cards. A row opens the PDF where
   `PdfMarkupQuestions` answers them. No second answering UI.
7. **Finished, not seen**: done turns with `lastDoneByTab > lastTabReadAt`
   (the desktop's read mark). Selecting one in the detail pane counts as
   reading it.
8. **Alerts**: `useAlertsFeed` rows with their ✓ / mute / Join, through
   `lib/alertDone.ts`. These are the bell's rows, not a copy.

Empty groups are not drawn. A rail with nothing in it says so in one line.

**Roster (middle).** Every agent tab of every hydrated scope (projects, boxes,
root, never the assistant scope), as rows:

- status mark · tab colour stripe · tab label · project (or box) chip
- CLI + model tag (`agentTabModelTag`) · PLAN / GOAL marks · subagent count ·
  ⎇ worktree · ⌂/☁ host chip (`host_down` reads "connect first")
- turn time (the phone's `TurnDuration` reading, moved into the shared roster) or "finished 2h ago", depending on the sort
- last prompt, or the unsent draft marked *Not sent*, two lines at most
- trailing: next schedule time, auto-continue ↻ indicator, untested pill where
  due

Controls: sort (`shared/agentSort.ts`'s three, shared with both Agents views),
**Flat / By project / By box**, state filter chips (Asking, Working, Done, All),
and text filter (tab, project, prompt). Idle tabs are hidden by default, as on
the phone, and shown under **All**. Keyboard: `j`/`k` or ↑/↓ move the
selection, Enter jumps to the tab (`jumpToTab` then close), Space or → puts
the selection in the detail pane, `c` continues an interrupted row, `/` focuses
the filter. All of these are keyboard-steering bindings, so they can be rebound.

**Detail pane (right).** The selected tab drawn through `AttachedAgentPane`
with `readerAlways` (see *Detail pane mechanics*). Above it: a header with
project · tab, ↗ Jump to tab, and the Reader's facts row (model, worktree,
context). Below the Reader, folded: that tab's schedules (the Agents view's
rows) and its last prompts. A CLI without a Reader (plain shell agents, Copilot
without a transcript) shows the attach-only terminal instead. Nothing selected:
the pane shows the top Asking row, and an empty-state line if there is none.

### View 2: Projects

A card grid over `useProjectsStore.projects` (open ones first, then inactive),
grouped by box when the Box filter is *All*. Each card shows:

- name, kind glyph (local / remote / remote-only / VM / container), box colour
- agent counts by state as the pill strip's own `--status-*` colours (the same
  bars `ScopeSetStatusBars` draws)
- git: branch, dirty count, ahead / behind (`stores/gitDirty.ts`, the dot the
  phone gets), plus open push proposals
- remote: SSH / VPN lamp per host (`stores/remote/remoteStatus.ts`
  `sshOf`/`hostStateOf`), sync state (`stores/remote/sync.ts`), run host
- time worked today (`stores/timer.ts`) and last activity
- actions: Open (activate + close the overlay), New agent tab (the `+` menu's
  default agent, in that scope), Agents (switches to Now, filtered to that
  project), Restore tabs (inactive projects only, an explicit click, see the
  rules)

An **inactive** project's card says "not open" and shows only what needs no
hydrated scope (git, remote, time). It never shows zero agents, because that is
not known.

### View 3: Tonight

Two sections.

**Coming up**: one time-ordered list across projects, grouped *Now → next hour
→ tonight → tomorrow → later*:

- enabled schedules (`stores/agents/agentSchedules.ts`, every target of every
  hydrated scope) with tab, prompt preview, recurrence; enable / disable and
  "Send now" through the existing schedule commands
- queued and chained prompt-chart cards (`buildPromptChart` per scope, the
  chart's own idea of *queued*), opening the Prompt chart tab for that scope
- auto-continue tabs (`tab.autoContinue`) and their state
- the scheduled warm-ups (`AgentCronSection`'s global and per-agent times)
- calendar events from the alerts feed in the same window, so "the 22:00 run
  collides with the 22:00 call" is visible

**While you were away**: since the window last had input, or since the
cockpit was last closed, whichever is later: turns that finished (with
duration and last prompt), turns cut off, pushes that landed, schedules that
fired, root writes. It is built from timestamps already stored
(`lastDoneByTab`, a schedule's `last` run, proposal outcomes, root-review history).
It is a derivation, not a new log. A **Mark all seen** button stamps
`lastTabReadAt` for the listed tabs.

### View 4: Usage

- **CLIs**: `CliOverviewView`'s body (`shared/cliOverview.ts`
  `overviewMeters`): plan, account, usage bars with reset countdowns, open tabs
  per CLI. It is read while shown, every 5 min, ↻ re-reads, the same cadence
  as the side-panel view (no second poller).
- **This machine**: `useMachineMeters(active)` CPU / RAM / GPU and the Ollama
  loads (`stores/agents/ollamaActivity.ts`) with Unload, the models hub's own
  action.
- **Remote**: every project host and worker (`remoteStatus.byHost`) and the
  global machines (`stores/remote/globalMachines.ts`) with lamp, run-host
  preference and live tmux sessions (`stores/remote/hostSessions.ts`). Connect
  goes through the existing connect flow. Never a probe against a host that is
  not connected.

## Data layer: one roster for both screens

`MobileBridgeHost.tsx` already derives, per tab, exactly what the roster shows:
`mobileAgentState` (precedence decision > interrupted > working > done > idle),
`mobileModelTag`, `withModeMarks`, `mobileSubagentCount`, `working_at` /
`done_at` / `turn_started_at`. Building a second derivation for the cockpit
would give one question two answers (`feedback_no_redundant_variants`). So:

- **C0** lifts those helpers out of the bridge into
  `src/lib/agents/agentRoster.ts` (pure, `now` a parameter), keyed by PTY id.
  The bridge then maps the shared row to its wire shape, and its tests must
  stay green unchanged. The phone's eligibility rule (`phoneListsTab`, Mobile
  access) stays in the bridge. The cockpit lists every scope.
- `src/lib/cockpit/` (new, pure, `now` a parameter, the `lib/alerts.ts` rule):
  - `roster.ts`: `buildRoster(input)` → rows + counts; filter / group / sort
    (sort delegates to `sortAgentTabs`)
  - `decisions.ts`: merges the eight groups into the rail model, with order,
    counts and the derived header badge
  - `tonight.ts`: the coming-up timeline and the away recap
  - `projectCards.ts`: the per-project card model, `loaded: false` for
    inactive scopes
- `src/stores/cockpit.ts` (new): `open`, `view`, `selected` (`scope:key`),
  `rosterMode`, filters, `lastClosedAt`. The data stays in the stores that own
  it. A copy in this store would be a second answer that can disagree with
  them.

**Loading.** Only the open overlay loads. On open, and on the matching
backend events while open, it fans out per project: `git_push_mcp_proposals`
(refresh on `git-push-mcp-changed`), schedules per agent target (on
`agent-schedules-changed`), prompts for the chart cards (on
`agent-prompts-changed`). Each runs under `Promise.allSettled` with a
per-project `.catch`, so one broken project cannot blank a view. Activity, tabs,
alerts, git dirty, remote status and the timer are already live stores and need
no loading. While shut, the cockpit costs nothing: no listeners, no timers.

## Detail pane mechanics

`AttachedAgentPane` (the view the root console, the overlays' docked root
agent and Tabby share) draws a tab of a scope the window is not showing,
attach-only. The PTY stays owned by the tab's pane in `CenterPanel`'s
keep-alive layer, and the attached view's key in `useOverlayAgentStore`'s shown
set makes that owner **stand down**, so there is one visible view per PTY.
Two views would take turns resizing it.

Today the shown sets are root-only (`shownKeys`) and assistant-only
(`assistantShownKeys`), and `CenterPanel` checks them only for those two scopes
(`CenterPanel.tsx` ~:1150 and ~:1223). **C2** generalizes this: `markShown(key,
scope)` stores `scope:key` for any scope, and `CenterPanel`'s stand-down checks
the tab's own scope. A pane that stands down while its project is on screen
behind the overlay draws a one-line placeholder ("Shown in the cockpit · Show
here") instead of a blank. The root and assistant cases keep their behaviour,
and their tests must pass unchanged.

The Reader inside the pane is the real one (`TerminalReaderView` over the
attached PTY), so question cards, queued bubbles, Send now / Cancel and edit,
subagent conversations, slash menu, voice chips and Diffs all work as in the
tab. Nothing is reimplemented. Switching the selection unmounts the old
attached view first, then mounts the new one, so a key is never held by two
views.

If C2's stand-down proves fragile for project scopes (a split, a popout owner,
a sleeping pane), the fallback is a read-only Reader over the transcript
(`transcriptWatch`) with the composer sending through `queuePromptForTab` /
`holdPhonePrompt` (the phone's held-prompt route). Question cards then fall back
to "Answer in the tab ↗". Decide this at C2's review, not in advance.

**Popout-owned tabs.** A tab whose owner is a popout window (`detached`)
cannot be drawn by the main window's attached view. The detail pane says
"Open in its window ↗" and focuses that window. Popout writes still go through
`detachedContext`.

## Rules this must keep (from AGENTS.md and the memory)

- **Never hydrate a scope implicitly.** `restoreActiveProjectScopes()` already
  restores every active project at launch, so an inactive project really has
  no running tabs here. Restoring is the Projects card's explicit button only.
  The cockpit never shows "0 agents" for a scope it has not loaded.
- Gate every remote / git / SSH read on *connected*. A sync command against a
  dead session can freeze the window.
- Gate work on visibility: the overlay's views compute only while open, and
  hidden views (other tabs of the cockpit) do not render their lists.
- WebKitGTK: no animated blurred `box-shadow`. Under `[data-software-paint]`
  rows and the detail pane arrive in one paint, with no slide-ins, no pulsing
  lamps and no new loop (`docs/context/desktop_ui_system.md`). Rounded corners
  (radius 6/10/14), never cut corners.
- One shared menu / dialog scheme. The portaled overlay sets an explicit
  `color`. Questions go through `useDialogs()`.
- Strings via `useT()`, a `cockpit.*` group in all five dictionaries (the
  parity test). No app name in code. Subscriptions via
  `subscribeTauri`/`useTauriListener`. Paths via `lib/paths`.
- `UntestedTag` on the overlay heading, the header button and each view's
  heading, with rows in `src/lib/untested.ts`, until the user stamps them.
- Gated by `useExperimental("cockpit")`: an `EXPERIMENTAL_FLAGS` row, the TS
  `Settings` field and the Rust `Option<bool>` (the one backend line, then
  `npm run backend:stale`, no restart).
- Agents' permission modes stay their CLIs' own. The cockpit has no mode
  control and adds no approval path that skips the existing cards'.

## Steps

Each step lands with its tests and the gates its diff touches
(`scripts/gates.sh`).

- **C0. Shared roster.** `lib/agents/agentRoster.ts` lifted out of
  `MobileBridgeHost.tsx`, the bridge rewired onto it. Tests:
  `src/__tests__/agents/AgentRoster.test.ts` (state precedence, subagents keep
  a turn working, unseen done, model fallback). The existing bridge tests stay
  green untouched. This step changes no behaviour and is worth landing alone.
- **C1. Shell.** `stores/cockpit.ts`, `components/cockpit/CockpitOverlay.tsx`
  (`TodoOverlay`'s shape: gate, Escape, backdrop, frame), the four view tabs
  with empty bodies, `header/CockpitIndicator.tsx` in the global-apps group
  beside ✉ 🗓 ☑. Its badge is the *derived* count of Asking + Interrupted +
  proposals + approvals, never acknowledged (the `TodoIndicator` rule). Also an
  "Open cockpit" row in `BoxScopeChip`'s dropdown, the steering action and its
  default key (pick a free one from the registry), and the experimental flag.
  Mounted in `AppShell` after the other overlay hosts, so it wins the z-order
  tie.
- **C2. Detail pane plumbing.** The generalized shown set and stand-down
  placeholder (`stores/overlayAgent.ts`, `CenterPanel.tsx`), with tests that
  a project tab drawn in the cockpit stands its owner down, and that root /
  assistant behave as before. Popout-owned and sleeping tabs are handled
  explicitly. **The risky step: review it on its own before C3.**
- **C3. Now view.** `lib/cockpit/roster.ts` + `decisions.ts` with their pure
  tests. `components/cockpit/{CockpitNow,CockpitRail,CockpitRoster,CockpitDetail}.tsx`
  reusing `GitPushMcp`'s card, `AgentScheduleProposal`, `RootReviewStrip`, the
  alerts rows and the Continue action, plus keyboard navigation.
- **C4. Projects view.** `lib/cockpit/projectCards.ts` + `CockpitProjects.tsx`,
  with the not-open card and the explicit Restore.
- **C5. Tonight view.** `lib/cockpit/tonight.ts` (boundaries: midnight,
  recurrence, disabled schedules, a card whose tab closed, the away window) +
  `CockpitTonight.tsx`.
- **C6. Usage view.** `CockpitUsage.tsx` composing `CliOverviewView`'s body,
  the machine meters and the remote lists. First split those components so the
  cockpit and their own surfaces render one body (`ProjectFilesView`'s rule:
  one component, several hosts), not a copy.
- **C7 (later, separate decision).** The sphere view from
  `docs/prompt_universe_plan.md` Steps 1–2, fed by `lib/cockpit/` instead of
  `promptUniverse.ts`.

Docs: one row per new load-bearing file in `docs/filemap_frontend.md`, a
`docs/context/cockpit.md` once C3 lands, a help topic
(`docs/help/tabs-and-panels.md` section) once the user has tested it.

## Verification

- Automated: the pure `lib/cockpit/*` and `agentRoster` tests (every
  boundary uses an explicit `now`). Component tests for the overlay
  (opens / closes, Escape, the badge derivation, the view switch), the rail
  order and its empty state, roster keyboard navigation, and the detail-pane
  stand-down. Gates: `npm run build`, `npm test`, `npm run lint`, plus
  `cargo test`/`clippy` for the one settings line, and `scripts/brand-check.sh`.
- Live (the user, in the dev build after commit, never started by an agent):
  open with agents in three projects, one asking; answer it from the detail
  pane; ▶ continue an interrupted one; approve a schedule proposal; switch
  project behind the overlay and check that nothing restarts or resizes; close
  the overlay and check that the tab's own pane comes back intact; repeat on
  Linux (X11), Linux (Wayland), Windows, macOS.

## Open (not decided here)

- Agents of **inactive** projects that still have live tmux sessions (the
  backend `mobile_control::discovery::Catalog` knows them). v1 shows the
  project as "not open". Listing those sessions without hydrating the scope
  would need a backend read and is a later step.
- A cockpit in **popout windows**: declined for v1 (overlay only).
