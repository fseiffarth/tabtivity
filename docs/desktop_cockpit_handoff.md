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

## Flagged for user

- (none yet)
