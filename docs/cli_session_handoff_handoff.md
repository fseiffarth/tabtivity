# CLI session hand-off: implementer notes

Running log for `docs/cli_session_handoff_plan.md`; each step appends a section.

## Step A

Commit: see `git log --oneline -1 -- docs/cli_session_handoff_handoff.md` on `cli-handoff` (a commit cannot name its own sha).

**Changed**
- `src/components/terminal/TerminalLimitHandoff.tsx`: `handoff()` builds the successor through `newAgentTabForDraft` (the "+" menu's `buildStaticTabSpec`), then overrides `location` (`tab.location`) and `initialInput` (the existing hand-off prompt, unchanged). `cwd` is `tab.cwd || cwd`. The tab now carries `sessionId`, the `TAB_UID` env, session-id args and a `scheduleTargetId`, so `isResumableAgentTab` is true.
- `src/__tests__/agents/TerminalLimitHandoff.test.tsx`: new test: the added tab passes `isResumableAgentTab`, has a `sessionId`, `env[envName("TAB_UID")] === sessionId`, a `scheduleTargetId`, the prompt as `initialInput`, no `/rename`.

**Choices**
- `customAgents` is read with `useSettingsStore.getState().settings?.custom_agents` inside `handoff()` (not a hook), so a custom-agent target resolves to its own spec and the test's settings-store mock keeps working.
- `projectName: ""`: it only feeds Claude's `/rename` `sessionRename`, which the hand-off prompt replaces anyway; the tab has no project name in scope here. With `""` the spec's `initialInput` is already undefined.
- The tab label is now the "+" menu's label for that CLI (`itemLabel`), not `target.label` from `list_agents`. They match for built-ins.
- Prompt content, detection and dialog untouched.

**Gotchas**
- `TerminalAiSwitch.test.tsx > an agent tab refused while AI is off waits…` failed once in the gate's `vitest --changed` run (load flake, see memory on load-flaky tests); it passes alone and in a rerun of `npx vitest run --changed` (72 files, 562 tests).

**Gates** (`scripts/gates-job.sh start`, frontend-only change): brand PASS, whitespace PASS, lint PASS (errors only), build PASS; vitest: first run 561/562 (the flake above), rerun 562/562 in 72 files; the new test file 6/6. Rust gates skipped (no Rust change). `git diff --check` clean.

**Flagged for user**
- Label source change (above) is a small behavioural difference for custom agents.
- Not run live; the restart-resume claim rests on `isResumableAgentTab` being true, not on a restart.
