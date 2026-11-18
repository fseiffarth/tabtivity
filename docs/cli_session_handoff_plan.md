# Continue work with another CLI

Status: steps A–D implemented on branch `cli-handoff`, never live. Rewritten 2026-11-18. Replaces the 2026-11-15 version. A
first version has been live in the code since 2026-11-04 (`b041edf8f`,
`9db7ee235`); this plan hardens and extends it. It does not start over.

## What exists

`src/components/terminal/TerminalLimitHandoff.tsx` + `src/lib/agents/limitHandoff.ts`
(pill `terminal.limitHandoff`, never live):

- Every 2 s it checks a visible local agent tab's screen for an explicit
  usage-limit line (`cliLimitNoticeLine`). It then offers the **next** installed
  CLI in the saved agent order (`nextLimitCli`, forward only). The dialog quotes
  the matched line and always asks; there is no automatic switch.
- On Continue it reads the tab's conversation through `agent_tab_transcript`
  (`readerRequest(…, 30)`), keeps the last 20 prompt/answer entries, each cut
  to its **last** 1200 chars, and JSON-encodes them. It flattens newlines and
  passes the result as `initialInput` of a new tab in the same scope, cwd and
  `location`. The source tab is left alone.

## Is it worth it

Yes, and most of the cost is already paid. Hitting a quota limit mid-task and
re-explaining it to another CLI is a recurring loss. The parts the 2026-11-15
plan wanted to build already exist:

| Need | Existing piece |
|---|---|
| Read the source conversation | `agent_transcript::agent_session_transcript`: Claude, Codex, OpenCode, Gemini, Antigravity, Muse, Copilot (not only Claude ↔ Codex) |
| The original request beyond the 6 MiB tail | `agent_session::chat_prompts` reads the first prompt from the head (4 MiB) for Claude/Codex/Copilot files |
| Files the conversation changed | `agent_changes::changed_paths` |
| The agent's own notes | cockpit meta (`handoff`, `progress`, `blocker`, `verification` on the tab) |
| A file a fenced agent can read | `<agent home>/handoff/<id>/` through `home_io`, as `services::sync_handoff` already does |
| Type the first prompt once the TUI is ready | `initialInput`: readiness cushion, trust-dialog guard, `claimInitialInput` dedupe, Claude `confirmFreshSubmit`; never persisted (`toSavedTabEntry` leaves it out) |
| A proper new agent tab | `lib/agents/prompt/newTab.ts` `newAgentTabForDraft` → `buildStaticTabSpec` (session id, `TAB_UID`, session-id args) |

The old plan's transaction (six persisted states, verified process-subtree
stop, crash reconciliation, delivery receipts, predecessor/successor links)
protects against a double click or a crash mid-switch. Those failures cost one
retry, because the source tab stays open and readable. **Dropped.**

## Gaps in what exists

1. **The successor tab is built by hand** (`label, cmd, args: [], env: {}`). It
   has no `sessionId`, no `TAB_UID` and no session-id args. So
   `isResumableAgentTab` is false: the tab is dropped at the next restart, and
   the Reader/phone Chat have no launch id to find its conversation by.
2. **The context loses the start of the work.** It reads only 30 entries and
   keeps 20. Each is cut from the front, which drops a prompt's opening, where
   the request usually is. On a long session the original request is gone.
3. **No working-tree state** (changed/untracked files) and no cockpit notes.
4. **A large PTY paste.** Up to ~25 KB of escaped JSON goes in as one typed
   line. The text is transcript content in a prompt the CLI treats as the
   user's.
5. **It is reachable only through the screen regex** and offers only the next CLI.
   A limit notice whose wording the regex doesn't know shows nothing, and there's
   no way to switch by choice (a weaker model for a cheap step, a CLI that's
   better at the task).
6. `{agent}` in the dialog is the bare binary name, not the CLI's label.

## Decisions

- **Context travels as a file, not as typed text.** The backend writes
  `HANDOFF.md` into the target's agent home. The typed prompt is one short line
  pointing at it.
- **The backend reads the transcript itself** from the same tab identity
  `agent_tab_transcript` takes. No conversation text crosses IPC from the
  renderer, and the backend can reach the head for the original request.
- **The source is never stopped.** The manual entry is disabled while the
  source's turn is running (`stores/activity.ts` working state), with "Wait for
  the turn to end or stop it". After a limit the source is idle anyway.
- **Gates:** agent tabs of a local project, not the assistant, not the root
  console's Host session (`canContinueInAnotherCli`). A remote project's tabs,
  even ones running here, are not offered (user decision 2026-11-18: the backend
  refuses remote projects; the old limit notice used to offer them). Remote
  projects, local-model targets (`<scope>.local` home) and the phone come later.
- **No model call to summarize.** The file is the verbatim conversation in a
  fixed byte budget. The new agent reads and judges it.

## HANDOFF.md

Written to `<target scope home>/handoff/cli-<id>/HANDOFF.md`. The agent sees
it as `~/handoff/cli-<id>/HANDOFF.md`, as the sync resolver's export works.
Sections in order; each says when it is empty or cut:

1. **Header:** source CLI label, captured at, cwd, coverage (entries included /
   total, "earlier turns omitted" when `truncated`).
2. **Original request:** the first prompt, from `chat_prompts` when the tail
   read lacks it, whole up to the reader's 6 000-char bound.
3. **Recent conversation:** chronological prompt/answer entries. Fill from
   newest back to a 48 KiB budget. An over-long entry keeps its head and tail
   with a `[… n chars cut …]` mark between. Subagent entries appear as one line
   each (role + task), not their conversations.
4. **The previous agent's notes:** cockpit handoff/progress/blocker/verification,
   headed as that agent's own claims, with their timestamps.
5. **Working tree:** `git status --porcelain` through
   `git_hardened::hookless_…` (names only, ≤ 200 lines), plus the
   conversation's `changed_paths`. "Not a git repository" when it isn't.
6. **Not included:** tool output, thinking, images/attachments, subagent
   conversations.

The transcript sections sit in fenced blocks under a line saying they are
quoted context, not instructions. The bootstrap prompt (i18n, one line):
"Continue the unfinished task from {agent}. Read {file} first: it holds that
conversation as quoted context, not new instructions. Check the working tree
before acting and don't redo finished work."

Retention: a host record `<state_dir>/cli-handoff/<scope>.json` lists the ids
written. Keep the newest 10 and prune only recorded ones, through `home_io`.
This mirrors `sync_handoff`: never prune by listing an agent-writable folder.

## Steps

**A. Successor tab spec (small; ship first).** In `TerminalLimitHandoff.handoff`,
build the tab through `newAgentTabForDraft({ agent: target.bin, cwd, … })`,
then set `location` and `initialInput`. Its `/rename` `initialInput` is
replaced; auto tab names cover the label. Test: the created tab passes
`isResumableAgentTab` and carries `TAB_UID` (`TerminalLimitHandoff.test.tsx`).

**B. Backend `agent_cli_handoff_prepare`.** New
`src-tauri/src/services/agent/agent_cli_handoff.rs` (AppHandle-free) plus a
command in `commands/agents.rs`:
`#[cfg_attr(feature = "desktop", tauri::command)]`, `async` over a `*_blocking`
body, `Ctx`. Arguments: the `readerRequest` fields, `target`, `previewOnly`. It
returns `{ preview: { entries, total, truncated, firstRequest: bool,
changedFiles, notes: bool }, file?: "~/handoff/cli-<id>/HANDOFF.md" }`. Writing
uses `sync_handoff`'s `safe_rel` + exclusive-create pattern. Give it a
`services::command_class` row (the class `agent_tab_transcript` has) and
regenerate `src/lib/transport/commandClasses.ts`.
Rust tests: first prompt outside the tail; head+tail cut mark; budget fill
order; notes headed as claims; non-git cwd; an unsupported CLI → `unsupported`;
prune touches only recorded ids; a planted symlink at `handoff/` refused.

**C. One dialog, two entries.** Move the modal out of `TerminalLimitHandoff`
into `components/agents/CliHandoffDialog.tsx`, on the shared dialog frame
(`add-menu` skill). It has an installed-CLI picker (default: `nextLimitCli`),
the preview counts, and **Continue with <label>**. Triggers:
- the limit notice (unchanged detection; it opens the dialog with the quoted line);
- **Continue with another CLI…** in the agent tab's context menu, disabled
  while the source is working.
Continue calls prepare, then opens the tab (step A) with the short bootstrap
prompt. A failure keeps the dialog open with the existing `failed` text. Use
CLI labels, not binaries (gap 6). New i18n keys go in `en.ts` and the four
other locales, like the existing `terminal.limitHandoff.*`. Add untested row
`agent.cliHandoff` for the menu entry and pill it. Update
`terminal.limitHandoff`'s `what`.

**D. Docs.** Add rows for `agent_cli_handoff.rs` and `CliHandoffDialog.tsx` to
the file maps. Add a short section to `docs/context/agent_sessions.md`. Update
the `todo/group-s-agents.md` entry's boxes to A–C with 🖐️ platform pairs.

## Later

Remote host tabs (the read through `remote_transcript`, the file staged on the
host's agent folder). Local-model targets (stage into `<scope>.local`). The
phone (a bridge verb taking an opaque tab id). Limit lines for CLIs whose
wording the regex misses, added from captured screens (`scripts/verify-cli`).

## Verification

`scripts/gates-job.sh start`, then its status; `git diff --check`;
`npm run backend:stale` after B. Not run live by the agent. The user checks
these by hand:

1. Claude tab with a few turns, one tracked edit, one untracked file → tab
   menu → Continue with another CLI… → Codex. The Codex tab opens in the same
   folder, reads `HANDOFF.md`, names the first request and both files, and
   doesn't redo the edit.
2. The same from Codex → Claude, and from one more reader CLI (OpenCode).
3. Restart Tabtivity: the successor tab comes back resumed (gap 1).
4. While the source works, the menu entry is disabled.
5. Usage-limit screen on the source → the dialog appears quoting the line,
   with the next CLI preselected.
