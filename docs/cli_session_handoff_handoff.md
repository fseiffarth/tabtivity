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

## Step B

Commit: see `git log --oneline -1 -- src-tauri/src/services/agent/agent_cli_handoff.rs` on `cli-handoff`.

**Changed**
- New `src-tauri/src/services/agent/agent_cli_handoff.rs` (+ `agent_cli_handoff/tests.rs`, 16 tests), registered in `services/agent/mod.rs` and re-exported in `services/mod.rs`.
- `commands/agents.rs`: command `agent_cli_handoff_prepare` (async over `agent_cli_handoff_prepare_blocking`, `app_core::rt::try_blocking`). Registered in `lib.rs`; `command_class` row `Core` (same as `agent_tab_transcript`); `commandClasses.ts` regenerated; `core_dispatch` `NotAPath` rows for `tabDir`, `localModel`, `target`.
- Daemon build: nothing needed beyond the above; the module has no Tauri import, the test-dlib / clippy-dlib gates cover it.

**Command signature (step C depends on it)**

`invoke("agent_cli_handoff_prepare", args)`, camelCase keys:
`agent: string`, `projectId: string|null`, `tabDir: string|null`, `since: number|null`, `sessionId: string`, `localModel: bool|null`, `remoteHost: string|null`, `tabId: string|null`, `target: string` (the target CLI binary: `claude`, `codex`, ...), `previewOnly: bool`.
The first seven (minus `tabId`) are `readerRequest(...)`'s fields under the same names; spread it and add `tabId` (the saved tab's stable `id`, for the cockpit notes; without it the notes section is empty), `target` and `previewOnly`. The extra reader keys (`subagent`, `version`, `limit`, `chat`) are ignored. Do not pass `chat`: it would still read the tab's own conversation.

Returns `Result<Prepared, string>`:
```json
{ "preview": { "entries": 14, "total": 14, "truncated": false, "firstRequest": true, "changedFiles": 2, "notes": true },
  "file": "~/handoff/cli-20261118-101500-beef/HANDOFF.md" }
```
`file` is `null` when `previewOnly`. `entries` = conversation entries in the file (the original request counts), `total` = entries the read returned (at most 1000), `truncated` = earlier turns or oldest entries are not in the file, `changedFiles` = a count (not a list).
Errors are short codes (the Promise rejects with the string): `unknown_target` (target not in the registry), `unsupported` (remote host tab, remote project, reserved scope such as the assistant, local-model tab that is not OpenCode, or a CLI whose transcript is not read), `no_session`, `no_transcript`, `read_failed` (the transcript's own reasons), otherwise the text of a failed write. The prompt for the new tab should name the returned `file` path as is.

**Choices**
- No `Ctx` argument: nothing needed it (AGENTS allows "or nothing"). The remote-host case is refused up front, not read through the pool.
- Root console tabs work (`projectId` null -> scope `root`); `Some(reserved)` (assistant, host) is refused. Local-model OpenCode source tabs are supported (`localModel: true`); a local-model *target* is not a thing yet.
- All CLIs of a scope share `agent-homes/<scope>`, so the file goes to the source's scope home; `target` only picks the label in the header and is validated with `agent_label_for_bin`.
- Headings and framing sentences in `HANDOFF.md` are English constants in Rust (the file is for an agent, not UI), as the plan says.
- Recent conversation: 48 KiB of rendered Markdown, newest entries first, contiguous; each entry is cut to 5 000 chars (1 500 head + tail); the newest entry is always in. The original request is cut at 6 000 chars (3 000 head). When no earlier turns exist, the session's first prompt entry becomes the Original request and is not repeated below. When the read is `truncated`, the first prompt comes from `agent_session::chat_prompts` on the head of the Claude/Codex/Copilot file; other CLIs say "starts mid-session" in the coverage line.
- Everything agent- or project-written (transcript, notes, git status, edited files) is in a fenced block longer than any backtick run in it; subagent and interrupt lines are flattened to one line.
- Notes: handoff / progress / blocker / verification from `cockpit_meta`, read by `tabId` from the scope's `terminals.json` under the shared lock; each group carries its own `setAt` time.
- Working tree: `git status --porcelain` through `hookless_git_command_in` + `bounded_output`, at most 200 lines. Exit 128 maps to "Not a git repository." (git's message is localized, so the code is used).
- Ledger `<state_dir>/cli-handoff/<scope>.json` (`{handoffs: [{id, at}]}`), newest 10 kept; ids are `cli-<UTC stamp>-<4 hex>`, which cannot collide with `sync_handoff`'s `conflicts-` ids in the shared `handoff/` folder.

**Gotchas**
- `previewOnly` still reads the transcript and runs git; it just writes nothing (a test checks the state dir stays empty). The dialog may call it on open, then again to commit.
- `changedFiles` is `0` both for "none edited" and "this CLI's edits are not read"; the file text tells them apart, the preview does not.
- The first cargo build of a fresh worktree took ~6 min for clippy and ~12 min for `cargo test`.

**Gates** (`scripts/gates-job.sh start`, frontend + src-tauri): brand, whitespace, lint, clippy (3), build, vitest (--changed) PASS; `cargo test -p tabtivity -p app-serverd` PASS; test-dlib PASS (all 10 gates, `All selected gates passed`; the lib holds 6 147 tests, 16 of them new; the gate log keeps no per-suite counts). The tree changed (this doc) while the gates ran, so no result was recorded for reuse. New tests: 16 in `agent_cli_handoff::tests` (first prompt outside the tail incl. a real file head, head+tail cut mark, budget fill order + chronological render, fence escape, notes as claims, non-git and git cwd, unsupported/remote/reserved/unknown target, preview writes nothing, taken name skipped, prune only recorded ids, planted symlink refused, id shape). One test line was fixed after its first run (it asserted an entry outside the budget); no flake reruns.

**Flagged for user**
- Not run live; backend change, so `npm run backend:stale` is the main agent's job at landing.
- The `unsupported` code covers several causes; step C shows one text for it.
