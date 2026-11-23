# CLI session hand-off: implementer notes

> **Status (screened against code 2026-11-22):** Log of `docs/done/cli_session_handoff_plan.md` steps A-D; all in code on develop (`agent_cli_handoff.rs`, `CliHandoffDialog.tsx`); the `cli-handoff` branch is history. Open: the live checks and the plan's "Later" list. Not live-tested.

Running log for `docs/done/cli_session_handoff_plan.md`; each step appends a section.

## Step A

Commit: see `git log --oneline -1 -- docs/done/cli_session_handoff_handoff.md` on `cli-handoff` (a commit cannot name its own sha).

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

## Step C

Commit: see `git log --oneline -1 -- src/components/agents/CliHandoffDialog.tsx` on `cli-handoff`.

**Changed**
- New `src/components/agents/CliHandoffDialog.tsx` (on `DialogShell`, `frame="project-dialog"`): the one dialog. It fetches `list_agents` itself, lists installed CLIs except the source's own by label (`Dropdown`), default `nextLimitCli(...)` (then the first target). A 200 ms-settled effect on the pick calls `agent_cli_handoff_prepare` with `previewOnly: true` and renders the counts; **Continue with <label>** calls it with `previewOnly: false`, then `newAgentTabForDraft` + `addTabToScope(scope, {...spec, location: tab.location, initialInput})`. `initialInput` is the new `cliHandoff.prompt` (`{agent}` = source label, `{file}` = B's `~/handoff/...` path) and nothing else.
- New `src/components/agents/CliHandoffMenuItem.tsx`: the tab menu row (`canContinueInAnotherCli`: `kind === "agent"`, not assistant, `runsLocally`). It subscribes to its own `busyByTab`/`busyKindByTab` entry and is disabled while `busy && kind !== "shell"` (an agent turn, alone or with a job; a bare shell command does not count) with the `cliHandoff.menuBusy` title. Wired into `TabBar.tsx` before Archive, with a `cliHandoffKey` state that renders the dialog like `scheduleDialogKey`.
- New `src/lib/agents/cliHandoff.ts`: types, `cliHandoffRequest` (reader identity fields + `tabId` + `target` + `previewOnly`; no `chat`), error-code to i18n-key mapping (`unsupported`; `no_session`/`no_transcript`/`read_failed`; anything else the old `terminal.limitHandoff.failed`).
- `TerminalLimitHandoff.tsx` keeps only detection; it renders the dialog with `line`. Dialog dismissal is its own effect keyed on `identity`/`visible`, so a store update to the same tab no longer closes it (before, any `tab` identity change did).
- i18n: `cliHandoff.*` in en/de/es/fr/it; `terminal.limitHandoff.body` reworded (no `{next}`, no "text will be sent"); `terminal.limitHandoff.prompt` and `.switch` removed from all five. Register: `agent.cliHandoff` added, `terminal.limitHandoff.what` updated. `DialogShellRatchet` list: `terminal/TerminalLimitHandoff.tsx` removed.
- Tests: new `CliHandoffDialog.test.tsx` (13 incl. each), `CliHandoffMenuItem.test.tsx` (7 incl. each); `TerminalLimitHandoff.test.tsx` rewritten for the moved modal (6).

**Choices**
- Title/pill: opened from the notice (`line` set) it wears the limit title and the `terminal.limitHandoff` pill; from the menu, `cliHandoff.title` and `agent.cliHandoff`.
- A preview that fails with a permanent code (`unsupported`, `no_session`, `no_transcript`, `read_failed`) shows the reason up front and disables Continue; a generic preview error leaves Continue enabled.
- The dialog works from the tab object it is given (via a ref kept current by an effect) and re-previews only when the pick, scope or cwd changes. Opening costs one `previewOnly` call.
- Menu entry is in `TabBar` only; the popout strip has no Archive row either, and its `addTabToScope` would need checking before adding it there.

**Gotchas**
- The pick falls back to the first target when `nextLimitCli` has none (e.g. the source is last in the saved order); the notice itself still opens only when a next CLI exists.

**Gates**: `scripts/gates-job.sh start` stopped at its first gate, brand, which fails on step B's Rust file (see Flagged), so the rest ran by hand: `npm run lint` 0 errors (30 warnings, none in touched files; eslint on the touched files is clean), `npm run build` PASS, `npx vitest run --changed` 914 files: first run 2 failed (BibCards, a load flake that passes alone; and `UntestedRegistry`: its audit cannot read a conditional `<UntestedTag id={…}/>`, fixed with two literal tags), then rerun green for that, 9 276 tests incl. the 26 new/rewritten; `src/__tests__/theme` 22 files PASS. Rust gates skipped (no Rust change). `git diff --check` clean.

**Flagged for user**
- `scripts/brand-check.sh` FAILS on step B's file, `src-tauri/src/services/agent/agent_cli_handoff.rs:310` and `:363` (the app name spelled in the HANDOFF.md text). Not touched here (Rust is out of scope for C); the fix is a `crate::brand` macro or a `brand-check: allow` line. It needs Rust gates rerun, and blocks `gates.sh` before it reaches the others.
- Not run live. Step D (file maps, `agent_sessions.md`, todo boxes) is not done.

## Step D

Commits on `cli-handoff`: `58472fa84` `fix(agents): spell the app name in HANDOFF.md through the brand macro`; `be12aa162` `docs(agents): file maps, context and todo for the CLI hand-off (steps A-D)`; this log is committed after them.

**Changed**
- Brand fix: `agent_cli_handoff.rs` builds the two HANDOFF.md sentences with `concat!(crate::app_name!(), …)`; no test asserted that text. `scripts/brand-check.sh` passes.
- `docs/filemap_backend.md`: row for `agent/agent_cli_handoff.rs`. `docs/filemap_frontend.md`: the `TerminalLimitHandoff`/`limitHandoff` row now says detection only; new row for `CliHandoffDialog` + `CliHandoffMenuItem` + `cliHandoff.ts`.
- `docs/context/agent_sessions.md`: section "Continuing in another CLI". `todo/group-s-agents.md`: A–C ticked with shas, manual box and platform pairs left open. `docs/done/cli_session_handoff_plan.md`: Status line.
- Help docs: `docs/help/` has no passage on the limit hand-off, so nothing added.

**Gates, `gates-job.sh start --all`** (tree as of `be12aa162`): brand, whitespace, lint, clippy (3), build PASS. `npm test` FAILED on 2 load flakes of 12 884 (12 882 passed): `PdfZoomRaster` "re-arms the commit on every tick" and `TerminalAiSwitch` "an agent tab refused while AI is off"; both files pass on rerun alone (9 tests). The run stopped there, so the two Rust test gates were run by hand with the gate's own commands: `cargo test --workspace` 6 556 passed, 0 failed, 17 ignored; `cargo test -p tabtivity --no-default-features --lib --test server_secrets`: lib 5 940 passed, 1 failed (`host_pty::tests::a_dead_remain_on_exit_pane_stays_open_until_killed`, load flake; passes alone) of 5 957, `server_secrets` 1/1. `git diff --check` clean. No code failure in the branch.

**Flagged for user**
- The whole-range gate run never came out as one green `--all` result (three load-flaky tests, each green alone); a clean unloaded rerun would give that.
- Not run live: all of A-D, including both pills (`terminal.limitHandoff`, `agent.cliHandoff`). Backend changed, so `npm run backend:stale` is the main agent's job at landing.

## Final review

Range `7cc15e858..3be507eca`, reviewed against `AGENTS.md` and the plan's Decisions.

**Fixed**
- `ba03f3c12`: `core_dispatch` classed `agent_cli_handoff_prepare.tabDir` as `NotAPath`, but the body runs `git status` in it and writes the names into the agent home. A hosted user account could list any folder the daemon reads. Now `UserPathOpt` (held to the user's roots, empty is absent). Test `a_users_cli_handoff_folder_is_held_to_their_roots`, red without the fix.
- `3c46ad9c1`: HANDOFF.md's "Not included" listed the skipped middle only for a truncated read, not when the 48 KiB budget cut it (the coverage line did say so). Test `turns_the_budget_left_out_are_listed_as_not_included`, red without the fix. Also corrected the `changedFiles` doc in `cliHandoff.ts`: it counts the CLI's recorded edits, not `git status`.

**Rejected**
- Command class `Core` kept. `Core` means "data on the user's daemon", like `agent_tab_transcript` and the `git_*` commands. The hosted web client is the user's own UI, and its path exposure is what `USER_CONFINED` is for (fixed above). The result carries only `~/handoff/…`: no raw project id or path. The phone PWA has no entry, and `mobile_control`'s phone verbs don't expose the command.
- Fence break-out: the fence is longer than any backtick run, and one-line items are flattened (tested). Pruning touches only ledger ids that pass `is_handoff_id`, and the ledger lives in the state dir. The symlink, exclusive-create and `home_io` paths are sound.
- Async over blocking (`try_blocking`); the source scan covers every `commands/*.rs`. No `use tauri` outside `desktop`; reserved scopes go through `storage::is_reserved_scope`; `target` is validated first.
- Frontend: arg names match B; error mapping covers every reader reason (`no_subagent` can't occur); a stale preview is dropped by the per-run `stopped` flag; the successor goes through `newAgentTabForDraft` with `cwd`/`location` and the bootstrap prompt; the `handled` dedupe survives; `.project-dialog` sets `color`; i18n keys are complete in all five locales with no orphans; pills and register rows are present.

**Flagged for user**
- Host session tabs (root console, unfenced, home `agent-homes/host`). Both the menu entry and the limit notice offer the hand-off. The backend reads the root scope's home, so the read fails as "could not be read yet". Moving an unfenced session's work into a fenced tab is also a trust-level choice. Suggest excluding `tab.hostSession` in `canContinueInAnotherCli` and in the notice.
- A remote project's tab that runs locally passes the frontend's `runsLocally` gate. The backend `gate` refuses every remote project (`runs_remote`) with `unsupported`. It fails closed, but the plan's "local tabs (`runsLocally`)" suggests these should work. Before this branch the limit notice handled them.
- `preview.entries` doesn't count an original request recovered from the file head. The dialog shows it on its own line ("original request is included").

**Gates** (`gates-job.sh start --all` on `3c46ad9c1`): brand, whitespace, lint, clippy ×3 and build PASS. `npm test` reported 3 failures of 12 884 (12 881 passed), plus teardown errors in `DetachedRetire`. Those were the load flakes `PdfZoomRaster` "re-arms the commit" and `TerminalAiSwitch` "refused while AI is off", plus a 20 s timeout in `GitCommitSleepHold`. All four files pass when rerun alone (24/24). The Rust test gates never ran inside the job: it stops after vitest fails. The hand run of `cargo test --workspace` and the daemon-lib tests was stopped at the user's request. The targeted Rust tests passed (`agent_cli_handoff` + the dispatch test, 18/18), as did `privacy-check.sh 7cc15e858 HEAD` and `git diff --check`. Not run live.
