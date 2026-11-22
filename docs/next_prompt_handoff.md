# Local-model "what's next" — handoff

Plan: `docs/next_prompt_plan.md` (Fixed decisions, Contract, Organisation).
Each agent appends its own section: commit shas, choices made, gotchas,
gate status with test counts, and **Flagged for user**.

## A backend

_(not started)_

## B frontend

Commits (on 82047262e): 3cfa57bc0 Suggestions chip + i18n · b0a1f1f6a shared
hook + desktop wiring + untested row + tests · 4f4f8b938 phone wiring ·
8b4972a1c docs. Committed by the main agent after the implementer handed back
with a green tree (gates job `/tmp/gates-job.PuoaJu`: brand, whitespace,
lint-fe, build, vitest `--changed` all PASS; the earlier full run counted 9743
tests, 9 phone tests failing on an unmocked `/next-prompt` fetch, fixed by
`SIDE_READS` in `src/__tests__/helpers/mobileTerminalHost.ts`). Intermediate
commits were not gated one by one; the tip was.

Choices:
- Shared timing core in `mobile-web/src/terminal/nextPrompt.ts`
  (`useNextPrompt`, `cleanNextPrompt`, `useWorkEndKey`, `usePageShown`), used by
  desktop and phone. Warm ≤ 1 per 3 s, one in flight, coalescing; final once
  per ended turn after 400 ms (Claude 1.5 s and only with no screen
  suggestion). Dropped on keystroke / new turn / hide; a dropped turn is never
  asked again; only `status: "ok"` shows.
- Desktop `src/lib/agents/nextPrompt.ts` (`useLocalNextPrompt`,
  `endedTurnKey`, `localAgentWorking`, `nextPromptArgs`): same identity as
  `readerRequest`, **plus `since`**. No warm while any `local_agent` tab works
  or for a local-model tab itself.
- Reader turn key = last prompt + closing answer; warm on transcript version
  changes; `ReaderComposer` got `onDraftEmpty`.
- Steering box asks `final` on each idle while open. Phone: local text joins
  `promptSuggestion`; `getNextPrompt` in `mobile-web/src/api.ts` (30 s timeout
  on final). `localModel.role.suggest`, `localModel.suggestCloudTitle`,
  `terminal.reader.localSuggestion` in all 5 dictionaries.
- Tests: `AgentNextPrompt.test.tsx` (19), `ReaderNextPrompt.test.tsx` (3),
  `MobileNextPrompt.test.tsx` (8), +1 in `SteeringPromptSuggestions.test.tsx`,
  `LocalModelMenu.test.tsx` updated.

Flagged for user:
1. Never live.
2. Args carry `since` beyond the contract — backend must accept or ignore it.
3. `commandClasses.ts` untouched here; tests mock `invoke`.
4. Steering box and phone Terminal view read no transcript, so they never warm;
   only the Chat view warms.
5. The phone sends one warm at turn start even before its session record moves.
6. The existing `localModelMenu.mailCloud` untested pill now also covers the
   Suggestions chip.

## R review

_(not started)_
