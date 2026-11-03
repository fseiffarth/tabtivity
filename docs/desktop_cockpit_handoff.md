# Desktop cockpit — implementation handoff

Plan: `docs/desktop_cockpit_plan.md`. Branch `cockpit` (worktree
`.claude/worktrees/cockpit`), based on develop `06905950`. Nothing here has
been run live: every step is gates-only until the user clicks through it in a
dev build.

## Steps

### C0 — shared roster (`src/lib/agents/agentRoster.ts`)

- sha: see `git log --grep "feat(cockpit): shared agent roster"`
- `deriveAgentRosterState` (pure, the phone's precedence: working > question
  > interrupted > done flag > unseen finished turn > idle), `agentRosterState`
  (on the activity store), `agentRosterFacts(scope, tab, now)` (model tag,
  PLAN/GOAL, subagents, working/done/turn-start stamps), `isRosterAgentKind`,
  `rosterModelTag`.
- `MobileBridgeHost.tsx` maps the facts to its wire rows (`withTimings`); the
  phone's eligibility (`phoneTabs`, Mobile access) stays in the bridge. No
  behaviour change: the idle pre-check before the model re-read is kept, so an
  idle tab's model is still re-read only by the timings poll, as before.
- Gates: brand, whitespace, lint, clippy ×3, build PASS. vitest `--changed`
  under `gates.sh` hit 20 s timeouts in three mobile-web screen tests
  (load average ~110 from other sessions; `gates.sh` runs at SCHED_IDLE). The
  same three files pass alone (30/30); `vitest run --changed` at normal
  priority: 32 files, 256 tests PASS; `src/__tests__/mobile` +
  `AgentRoster.test.ts` in full: 214 files, 2091 tests PASS. cargo test (the
  bridge is `include_str!`-scanned by a Rust test): see C1's entry.

### C1 — shell

- sha: see `git log --grep "(C1)"`
- `stores/cockpit.ts` (UI state only: open, view, selected PTY id, roster
  mode / state chip / sort / text / box / scope filters, `lastClosedAt`; the
  `overlayOpen`/`openOverlay`/`closeOverlay` names of the header family).
- `components/cockpit/CockpitOverlay.tsx` (TodoOverlay's shape: gate,
  Escape — ignored inside `.cockpit-detail-pane` —, backdrop, `useFloatingFrame`
  under `cockpitOverlayFrame`), `CockpitViews.tsx` (heading + body switch; only
  the shown view mounts). Joins the shared overlay size rule in
  `mail-todo.css`; own layout in `src/styles/cockpit.css` (imported last).
- Header: `header/CockpitIndicator.tsx` as header item `cockpit` (apps group,
  pinned by default, after ☑; `headerOrder.test.ts` expectations updated for the
  new id). Badge `cockpitBadge` in `lib/cockpit/decisions.ts`.
- `OverlayApprovals` takes an optional `domain`; none = the whole root queue
  (the cockpit's title bar).
- BoxScopeChip dropdown: "Open cockpit" row under the root row.
- Steering: action `cockpit`, default key **U** (the only free tab-bar letter
  that is not already a mode key), legend row, condition `cockpit`
  (`SteeringLegendState.apps.cockpit` optional so existing callers compile);
  opens the overlay and enters the generic `overlay` region.
- Experiment `cockpit`: `EXPERIMENTAL_FLAGS`, TS `Settings.cockpit`, Rust
  `Option<bool>` in `schema/settings.rs`, Settings → Experimental toggle.
  `npm run backend:stale`: the running window's backend predates the tree (it
  only round-trips the flag through its catch-all until rebuilt; nothing in the
  backend reads it).
- Gates: brand, whitespace, lint (`npm run lint`), `npm run build` PASS.
  `vitest run --changed` (758 files affected): 7243 passed, 2 failed —
  `PdfZoomRaster` and `TerminalAiSwitch` timing tests under load average ~100;
  both pass alone (9/9). Rust gates (clippy ×3, cargo test ×2) were still
  running at commit time: see C2's entry. `scripts/gates.sh` itself was too
  slow under this load (SCHED_IDLE): the same gates were run one by one.

### C2 — detail pane plumbing (main approach, no fallback)

- sha: see `git log --grep "(C2)"`
- `stores/overlayAgent.ts`: `markShown(key, scope)` records root in
  `shownKeys` and Tabby in `assistantShownKeys` exactly as before, and any
  other scope in the new `scopeShownKeys` as `scope:key` (before, a project
  scope would have landed in root's set). `isShownElsewhere` reads all three.
- `CenterPanel.tsx`: a pane whose PTY id is in `scopeShownKeys` is not visible,
  counts as `drawnElsewhere` (so it is never asleep while drawn — a sleeping
  owner wakes when the cockpit marks it, as root's does for the console), and
  its slot, when it would have been on screen, gets `PaneStandDown`: "Shown in
  the cockpit · Show here" (Show here closes the cockpit). Placeholders render
  after the pane map, so no existing pane element changed key or position.
- `AttachedAgentPane` takes `scopeDir` (a project's / box's folder fallback).
- `lib/tabs/remoteHold.ts` `paneRemoteHost`: PaneSlot's per-pane remote hold,
  extracted unchanged so the cockpit can refuse to attach to a held tab.
- `components/cockpit/CockpitDetailPane.tsx`: modes attach / popout ("Open in
  its window ↗" → `focus_detached_window`) / console (root tab while the root
  console is up) / held ("Connect first" → connect hub) / missing.
- Why the main approach held: the stand-down is one extra set lookup per pane,
  the pane stays mounted (PTY untouched), sleeping is covered by the existing
  `drawnElsewhere` rule, popouts and held tabs are refused before any view
  attaches. Root and Tabby code paths are byte-for-byte the same sets.
- Tests: `src/__tests__/cockpit/CockpitStandDown.test.tsx` (13: shown-set
  slots, CenterPanel stand-down + placeholder + unmark, Show here, other
  scope untouched, root key never hides a project tab, detail pane mark /
  hand-over / popout / held / missing, sleeping owner woken and kept awake).
  Root / assistant / tabs / remote / calendar-overlay suites unchanged and
  green: 141 files, 1163 tests.
- Rust gates from C1: clippy ×3 PASS (`-D warnings`); cargo tests: see C3.

### C3 — Now view

- sha: see `git log --grep "(C3)"`
- `lib/cockpit/roster.ts` (filter / count / sort via `sortAgentTabs` / group /
  `stepSelection`), `lib/cockpit/decisions.ts` (`buildDecisions`: the eight
  groups in rail order, empty ones dropped, `topAsking` for the default detail),
  `shared/turnDuration.ts` (the phone's `turnDuration` now delegates to it).
- `components/cockpit/`: `CockpitNow` (three columns, resizable rail/detail
  widths in localStorage), `CockpitRail`, `CockpitRoster`, `CockpitDetail`,
  `useCockpitData` (loads only while mounted), `cockpitFormat`,
  `CockpitViewHeading` (own file, no import cycle with the body switch).
- `agentRosterFacts(..., { reread: false })`: the cockpit derives in render and
  asks the model store to re-read on its own 15 s tick, never per render.
- Rail groups reuse: `TabContinueButton` (▶, AI switch respected; its prompt
  `CONTINUE_PROMPT` is now exported for the roster's C key),
  `GitPushProposalCard` folded in a `<details>` (its own approval, incl. a
  push to the default branch), `AgentScheduleProposal`, `RootReviewStrip`
  (no domain = whole queue), `AlertsMenu` with `useAlertsFeed()` (the bell's
  rows). Selecting an unseen finished turn stamps the read mark
  (`clearAttention`); questions and interruptions are never cleared by a look.
- Keys: steering table scope `cockpit` (`cockpitDown/Up/Jump/Show/Continue/
  Filter`, defaults J/↓, K/↑, Enter, Space/→, C, /); `scopesMeet` keeps them out
  of conflicts with mode-wide keys; Settings shows them as their own section.
- Tests: `CockpitRoster.test.ts` (pure: sort tiers, chips, text/box/scope
  filters, grouping, turn length, step wrap, rail order/empty/newest-first,
  finished push listed not counted), `CockpitNow.test.tsx` (lists hydrated
  scopes only, empty rail line, asking → rail + default detail attached, J/K/
  Enter, text filter). cockpit + steering + mobile + roster suites: 219 files,
  2138 tests PASS.
- Rust gates (from C1's settings line): clippy ×3 PASS; cargo test: see C4.
- The phone PWA source changed (`AgentModeMarks.tsx` delegates to
  `shared/turnDuration`, no behaviour change); it reaches the binary with the
  post-commit dev build (`npm run mobile:bundle`).

### C4 — Projects view

- sha: see `git log --grep "(C4)"`
- `lib/cockpit/projectCards.ts` (`buildProjectCards`: open first then pill
  order, by box in box order with loose projects last, or one box; counts only
  when loaded), `components/cockpit/CockpitProjects.tsx`.
- Card readings, all from existing stores, nothing probed: agent bars
  (`ScopeSetStatusBars`, the pill strip's own) + counts, git dot level
  (`gitDirty`), pending push requests (git-readable projects only), amber
  byte-sync entries (`sync`), SSH/VPN lamp per host (`hostStateOf`), run host,
  time today (`get_time_today`, once a minute while shown), last activity
  (newest working/finished stamp of its agent tabs).
- Actions: Open (activate + close), New agent tab (Open, then the focused
  pane's agent slot 1 — `requestNewTab`), Agents (Now narrowed to the scope,
  with an "Only <name> ×" chip to clear), Restore (inactive →
  `activateProject`, active but unrestored → `restoreProjectScope`).
- Box filter: a select in the overlay's title bar (all views), shown when boxes
  exist.
- Tests: `CockpitProjects.test.ts` (pure: counts only when loaded, ordering,
  box grouping / narrowing), `CockpitProjectsView.test.tsx` (not-open card has
  no counts, Restore is the only hydrate, Agents narrows Now). Cockpit suite:
  6 files, 40 tests (before the two new files: see below).
- cargo test (from C1's settings line): `-p tabtivity -p app-serverd` 5196
  passed, 0 failed.

### C5 — Tonight view

- sha: see `git log --grep "(C5)"`
- `lib/cockpit/tonight.ts`: `tonightBucket` (≤5 min / ≤1 h / before the next
  local midnight / before the one after / later), `scheduleItems` (enabled
  rules' next occurrence; disabled and agent proposals have none),
  `warmupItems` (`agent_cron` slots, today's while ahead else tomorrow's),
  `buildComingUp` (standing items under Now, 7-day horizon), `awaySince`,
  `buildAway`.
- `CockpitTonight.tsx`: loads prompts / links / history per loaded project
  while shown (and on `agent-prompts-changed`) to build each scope's Prompt
  chart with live strands, keeping only `queued` and `chained` cards. Schedule
  rows: Disable (`upsert … enabled: false`, the Agents view's guarded write) and
  Send now (`queuePromptForTab`, the composer's route). Calendar events come
  from `useAlertsFeed` (the bell's rows; timed events only).
- Away recap: finished turns use `lastDoneByTab` (also those already read),
  cut-off turns `lastWorkingByTab`, pushes `status: pushed` by `created_at`
  (the proposal keeps no decision time), fired schedules `last.at`, root writes
  `status: applied` by `created`. Mark all seen stamps `clearAttention` on the
  finished rows. "Last input" is the newest `lastUserInputAt` over agent tabs
  before the view opened (there is no window-wide input clock).
- Tests: `CockpitTonight.test.ts` (7: bucket edges incl. midnight, enabled vs
  disabled, daily recurrence across midnight, timeline order + horizon +
  standing items, warm-up slots, away window and recap).

## Flagged for user

- Header badge does not count **push requests** while the cockpit is shut:
  `git_push_mcp_proposals` settles against git per project, and the plan says
  nothing of the cockpit runs while shut. It counts asking + interrupted +
  schedule proposals already loaded + root approvals.
- Steering default key for the cockpit is **U** (C, K and the rest were taken).
- Roster rows show no ⎇ worktree chip and no *Not sent* draft: `TabEntry` has
  no worktree field and the composer's draft is the Reader's own state; both
  need a reading the desktop does not keep per tab yet. The last prompt is the
  model store's `promptByTab` (what the Agents view shows).
- A Markup-questions row jumps to the asking agent's tab rather than opening
  the PDF itself: an ask carries a project-relative file, and there is no
  shared "open this file in that project's scope" helper to call; answering
  stays in `PdfMarkupQuestions` either way.
- Projects cards show the git *dot level* (clean / to push / staged / dirty),
  not branch name or ahead/behind counts: those need a git read per project,
  which the view does not run (the switcher's own timer keeps the dots).
- Tonight's "since the window last had input" is approximated by the newest
  per-tab input stamp (`lastUserInputAt`); a window-wide input clock would be
  a new always-on listener, which the cockpit avoids while shut. A push's
  "landed" time is its proposal's `created_at`.
