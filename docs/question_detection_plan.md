# Question detection from the CLI's own output — plan

> **Status (screened against code 2026-11-22):** Phases 0-4 are in code: the screen gate in `src/lib/agents/readerLive.ts`, the waiting-question entry `waiting_question_entry` in `services/agent/agent_transcript.rs`, the phone's `mobile-web/src/terminal/askedQuestion.ts`, permission subjects. Open: "Later: other CLIs" (OpenCode, Codex sync `request_user_input`, Copilot), each behind its own probe. Not live-tested.

Implemented 2026-11-18 by Sonnet subagents (handoff `docs/question_detection_handoff.md`); the probe ran offline against a stub model.

## Problem

Whether an agent tab is asking comes from hooks (`<uid>.turn` = `decision`),
which is reliable. **What** it asks — question text, headers, rows,
descriptions, previews, multi-select — is read off the terminal by
`mobile-web/src/terminal/selectPrompt.ts` (1374 lines) and
`openCodeQuestion.ts` (266), through `readReaderLive`
(`src/lib/agents/readerLive.ts`). That reading:

- breaks when a CLI redraws its dialog (most of `selectPrompt.ts`'s dated
  comments are such breaks);
- is not gated on the turn state: `readReaderLive` reads any tail above the
  input frame as a question if `readSelectPrompt` accepts it. Its row-marker
  class is `[❯▸▶›>→]`, so ordinary output with `>`-led numbered lines can pass
  for a highlighted dialog. **Reported 2026-11-18:** a Claude tab showed a
  question card where there was none (repro pending; Phase 0);
- has to guess whether a dialog has gone away: a declined Claude question
  fires no hook, so `activity.ts` retires `decision` on input and keeps it
  while `dialogOnScreen` still reads a dialog.

The hooks see the question in full, and so does the transcript JSONL, but both
throw that away: the hook script writes one word, and `agent_transcript.rs`
holds a Claude `AskUserQuestion` back until it has its result
(`TranscriptEntry.questions` doc, "a question still waiting is the live
screen's").

## Probe findings

`scripts/verify-cli/claude/turn_hooks.py <label> <bin> <port> tui_ask
tui_ask_esc tui_deny`, Claude 2.1.326 and 2.1.327, scratch HOME,
`stub_anthropic.py`, `--permission-mode default`. Outputs under
`tmp/verify-cli/claude/<v>-ask/turn/` (`timing.json`, `dump/`, frames).

| What | Finding |
| --- | --- |
| `PreToolUse` for `AskUserQuestion` | Full `tool_input.questions[]`: `question`, `header`, `multiSelect`, `options[]` with `label`, `description`, `preview`. Has `tool_use_id`. |
| `PermissionRequest` for `AskUserQuestion` | Same `tool_input`, **no** `tool_use_id`; shares `prompt_id` with `PreToolUse`. |
| `PermissionRequest` for `Bash` | `tool_input.command` / `description`, plus `permission_suggestions` (`addDirectories` with paths, `setMode: acceptEdits`, destination `session`). The `permission_prompt` notice follows. |
| Order after Enter | Hook 0.18–0.69 s, transcript `tool_use` record 0.33–0.88 s, dialog on screen 0.65–0.76 s (50 ms poll). Usually hook → transcript → screen, but in one run (`tui_ask_multi`, 2.1.327) the screen came **before** the transcript: never assume the entry is there when the dialog is. |
| Several boxes ticked | `answers[q]` = `"Red, Blue"` (`, `-joined, `tui_ask_multi`). |
| Bash approval | The `Bash` `tool_use` is in the transcript before the dialog draws (hook 0.31 s, transcript 0.46 s, dialog 0.68 s; `tui_bash`). Dialog: `Bash command` / description / the command between dashed rules / `Do you want to proceed?` / rows naming a path (`Yes, and always allow access to <dir>`). Esc → the same `User rejected tool use` result. |
| Edit / Write / WebFetch approvals | `tui_edit`, `tui_write`, `tui_fetch` (2.1.327): headed `Edit file` + leaf / `Do you want to make this edit to <leaf>?`; `Create file` + leaf / `Do you want to create <leaf>?`; `Fetch` / `Claude wants to fetch content from <host>` / `url: …` / `Do you want to allow Claude to fetch this content?`. `tool_use` in the transcript before the dialog draws (0.27–0.38 s vs 0.65 s). |
| `Chat about this` | `tui_ask_chat`: no `PostToolUse`; an `is_error` `tool_result` ("…the user said: The user wants to clarify these questions…", `(No answer provided)`), then `Stop`. The hooks already end `decision`; no settle needed. |
| `No` + feedback | `tui_bash_no`: the `User rejected tool use` result and the interrupt notice, then the feedback as `UserPromptSubmit` and `Stop`. Ended by hooks too. |
| Between pages | No hook fires while ticking a box, moving rows, going Next or reaching the review step. |
| Answered | One `PostToolUse` with `tool_response` = the transcript's `toolUseResult`: `questions`, `answers` keyed by question text, `annotations[q].preview` for the picked preview; then `Stop`. Transcript gains the `tool_result`. |
| Esc (declined) | **No hook.** The transcript gains, at once, a `tool_result` with `is_error: true` (`toolUseResult: "User rejected tool use"`) and a user record `[Request interrupted by user for tool use]`. |

Caveat: the stub sends the whole `tool_use` block at once. A real model
streams the input for seconds. That needs checking in a real tab.

## Fixed decisions

Reviewers may not undo these.

1. **The transcript is the content source.** No new hook-written record, no
   use of hook stdin beyond today's one word, no `stream-json`, no answering
   through hook output.
2. **The hooks stay the authority for "is it asking".** The screen stays the
   authority for the cursor (tab focus, highlighted row, ticks, review step).
   Answer keystrokes stay `answerKeys` / `answerTextKeys` / `tabStepKeys`,
   computed from the screen reading.
3. **Either source may come first.** The merge works with entry-only (read-only
   card, decision 2 below), screen-only (today's full screen reading,
   unchanged) and both (merged).
4. **Open decision 2 is taken: show the read-only card** from the entry while
   the screen has no dialog yet, rows tappable only once the screen confirms.
5. **Phase 0 runs without the user's repro** (pending). Build the failing
   test from a constructed Claude screen: answer text with `>`-led and
   `❯`-free numbered lines above a present input box. When the repro
   arrives, it is added as a test; the gate must not need changing for it.
6. **Phase 4 is in scope** (open decision 1). Subjects: `Bash` → command;
   `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → file path; `WebFetch` → URL;
   any other tool → its name only. The backend lists waiting calls (a
   `tool_use` with no result in the current turn) for **every** tool. A
   running approved Bash call has no result either, so the frontend uses the
   list as a dialog's subject only while `agentTabState` is `question`.
7. **The phone never gets a raw subject.** A Bash command crosses the browser
   API only through `mobile_control::shell_mask`, the same as running shells.
   A path is cut the same way (project-relative, other paths to the leaf).
   A URL goes to host only. This is in the backend, not the phone.
8. **Phase 3 writes the word an interrupted turn already uses** for Claude
   (check `agent_turn`/`activity.ts`; `done` if there is none) on a rejected
   `tool_result` newer than a `decision` record. It never writes `working`.
   *Plan review: there is none.* `TurnState` is `working`/`decision`/`done`/
   `idle` and the hook script (`agent_session.rs`) maps no event to an
   interrupt; "interrupted" exists only in the frontend (`interruptedByPty`,
   set by `noteUserInput(.., interrupt)`, kept across a later `done`). So the
   word is `done`. The trigger is the transcript's `[Request interrupted by
   user for tool use]` notice (a `Turn("interrupted", ..)` record already
   parsed by `claude_interrupt`), not the bare `is_error` result: see Phase 3.
9. **Multi-select answers are `, `-joined** (probed); keep
   `AskedQuestion.answer` as is.

## Design

**Source: the transcript, not the hook payload.** Both lead the screen. The
transcript wins because:

- `claude_question` already parses the block, and Codex's async question
  already ships a waiting entry this way (`asking`), to the Reader and the
  phone (also headless, through the sidecar);
- the transcript has the only decline signal (the error `tool_result`);
- a payload record from the hook would be a new agent-writable file format
  (threat model gap 29 rules: `home_io::read_record`, bounds). That is more
  surface for 0.1 s.

The hooks remain the authority for "is it asking" (the lamp). The screen
remains the authority for where the cursor is: which question page, the
highlighted row, ticked boxes, the `Type something` / `Chat about this` rows,
the review step. Answering stays keystrokes into the TUI (`answerKeys`).

### Phase 0: gate the screen reading (the reported misread)

1. Reproduce it: get the screen from the user (screenshot or `pty_scrollback`
   capture) and turn it into a `src/__tests__/agents/AgentReaderLive.test.ts`
   case that fails today.
2. Fix the reading so that text above a present input box is not taken for
   a dialog. Claude hides its input box while a dialog is up. Where that
   holds, `readSelectPrompt` on `screen.slice(start)` with a frame found
   reads output, not a dialog. Check against every Claude frame in
   `tmp/verify-cli/claude/*/` with `scripts/verify-cli/parsers/frames.probe.ts`
   (`VERIFY_CLI=claude VERIFY_NEW=<label> node_modules/.bin/vitest run
   --config scripts/verify-cli/parsers/vitest.config.mts`) before narrowing
   anything: other CLIs (Codex's `›` box) differ, and `inputFrameStart`
   deliberately refuses a box-like row that is a dialog's highlighted option,
   so a dialog's `❯ 1.` row must still pass. **There are two copies of the
   reading, fix both:** the desktop's `readReaderLive`
   (`src/lib/agents/readerLive.ts`: `frameStart`, `start`, `tail`) and the
   phone's own `liveTail`/`liveQuestion` in
   `mobile-web/src/screens/Terminal.tsx` (~l. 2070-2100). Put the shared rule
   in one pure function in `mobile-web/src/terminal/` and call it from both.
3. Gate by the hook lamp at the call sites, not inside `readReaderLive`
   (pure; also called by `dialogOnScreen`, `steeringAnswer`, `frames.probe`):
   for a hook-driven Claude tab the card is shown only while
   `agentTabStateOf(..) === "question"` (desktop: `TerminalReaderView.tsx`,
   where `shownLive` feeds `<LiveQuestion>`; and
   `src/lib/shortcuts/steeringAnswer.ts` `liveQuestion(scope, tab)`, or the
   steering keys answer a phantom). Phase 2 adds "or a waiting entry exists".
   The phone has no live lamp: `tab.agent_status` is the snapshot of the
   tab list (see the `markupAgent` comment in `Terminal.tsx`), so the phone
   gate in Phase 0 is the frame rule of step 2 only; it gets the
   lamp-or-entry condition in Phase 2. User-opened pickers (`/model`,
   `/resume`, the theme picker) keep their own paths (`readModelPicker`,
   `readStrayDialog`) and are not affected. Out of scope, noted:
   `activity.ts` `attentionFor` also lights `decision` from
   `tailLooksLikeDecision` (screen) under any verdict but `done`; if the repro
   turns out to be the lamp and not the card, that is the next gate.

### Phase 1: backend, a waiting Claude question

`src-tauri/src/services/agent/agent_transcript.rs` (+ `agent_transcript/
tests.rs`):

- In `parse_entries`, `asked` is a `HashMap` (no order) whose unanswered
  calls are dropped silently. Make it keep ask order (a `Vec`, or an order
  list beside it), clear it on a typed prompt (`typed && role == "prompt"`,
  where `shells.clear()` is) and on a `Turn("interrupted", ..)` record, and
  skip it for a sidechain file (`sidechain`). After the loop, each call still
  in `asked` is waiting: push its entry last, `at` = the ask's own time, with
  `questions` and **`blocking: true`** (below). The existing test
  `a_claude_question_stays_in_the_chat_with_its_answer_once_answered`
  asserts a trailing unanswered `toolu_C` yields no entry: that changes.
- New `TranscriptEntry.blocking: bool` (`skip_serializing_if = Not::not`;
  doc: the agent is blocked on this question *on its own screen*, Claude's
  `AskUserQuestion`; the live card shows it, the chat does not). **Do not
  reuse `asking`**: every consumer of `asking` (`transcriptTurns.ts`,
  `Terminal.tsx` l. ~448, `useAsyncAsk.ts`) is Codex's async queue and
  answers it with shift+←. Update the `questions` and `asking` doc comments
  ("a question still waiting is the live screen's").
- `AskedQuestion` gains `multi_select: bool` with `#[serde(rename =
  "multiSelect", default, skip_serializing_if = "std::ops::Not::not")]` (the
  probe's and the phone's key). `AskedOption` gains `preview: Option<String>`.
  Read in `claude_question` from `multiSelect` / `preview`. A preview keeps
  its line breaks, so it does not go through `bounded_line` (`clean_text`
  keeps `\n` and `\t`); bound it by a new `MAX_PREVIEW_LINES` and
  `MAX_PREVIEW_CHARS`. Shown as preformatted text, never markdown.
- A declined call's entry: questions with no answer (already the case).
- Tests in `agent_transcript/tests.rs` from the probe's transcript lines
  (paths scrubbed): waiting; answered; declined; a waiting call from an
  earlier turn (a later typed prompt) ignored; a waiting call followed by an
  interrupt notice ignored; two waiting calls in order; a subagent file's
  none; `multiSelect` and `preview` read and bounded.
- `mobile-web/src/api.ts`: `AskedQuestion.multiSelect?`, option `preview?`,
  `TranscriptEntry.blocking?`. The phone's `transcriptTurns.ts` is S3's.

### Phase 2: the Reader and the phone read the entry

A pure merge in `mobile-web/src/terminal/` (shared by the desktop Reader and
the phone's `useLiveQuestion`):
`mergeAskedQuestion(entry, live) → card | null`.

- The card's question text, headers, rows, descriptions, previews and
  multi-select come from the entry.
- From the screen it takes only the focused tab (`tabFocus`), the highlighted
  row, the ticked boxes and the review step, matched by headers. The live
  tab row's labels must equal the entry's headers, else the full screen
  reading is used unchanged (another dialog, a permission prompt).
- A `blocking` entry renders as the live card, never as a chat bubble plus a
  card. Both chat renderers build a turn from every `questions` entry: the
  phone's `mobile-web/src/terminal/transcriptTurns.ts` (feeding `Terminal.tsx`
  `AskedCard`) and the desktop's `TerminalReaderView.tsx`
  (`if (turn.questions) return <AskedQuestions ..>`, ~l. 584). Drop the
  `blocking` entry there (in `transcriptTurns.ts` if the desktop shares it,
  else both). `chatFiles.ts`/`chatLinks.ts` already skip `questions`. On
  answer the entry loses `blocking` and is the existing answered card
  (`mobile.focus.askedCard`).
- The merge feeds the desktop `LiveQuestion` input (`TerminalReaderView`
  `shownLive`) and the phone's `useLiveQuestion` (`questionParts`; the
  `liveQuestion` that `Terminal.tsx`, `useHandsFree`, `useTerminalSteering`
  read): keep the `SelectPrompt` shape plus a `source: "entry"` marker so
  those consumers need no change beyond the read-only rule.
- No screen match yet (the 0.3 s before the dialog draws, or a hidden pane):
  show the card read-only from the entry ("waiting for your answer"), with
  rows tappable once the screen confirms the dialog. **Only while the lamp
  says `question`** (desktop `agentTabStateOf`; phone `agent_status ===
  "question"`): a dangling call in a dead or resumed session keeps a
  `blocking` entry forever, and the card must not outlive the dialog. This is
  also the phone's lamp condition from Phase 0 step 3. Never send keys from
  an entry-only card (`answerKeys` needs the screen's `SelectPrompt`).
- New strings through `i18n` (`useT()`, `en.ts` plus `de/es/fr/it`); an
  `UntestedTag` pill and a `src/lib/untested.ts` row per new surface (the
  entry-only card; the preview/multi-select card).

### Phase 3: retire `decision` from the transcript

The declined question is the one gap the hooks leave (a declined `Bash` or
`Edit` approval too: `tui_bash`'s Esc fires no hook either). While a local
Claude tab's `.turn` reads `decision`, the `agent_turn` watcher's poll
(`JOB_POLL`, where `start` calls `settle_codex_turns()`) reads the transcript
tail. Mirror `settle_codex_turn` in `src-tauri/src/services/agent/
agent_turn.rs`:

- `watch_claude_transcript(uid)` / `claude_uids()` / its `forget_*` beside the
  Codex ones (`watch_codex_rollout`, `codex_uids`, `forget_codex`), called
  from `services/launch_prep.rs` next to the `watch_codex_rollout` call
  (`opts.cmd == "claude" && !remote_agent_run && !assistant`). Share
  `CodexRollout`'s per-uid cache (sid, path, `read_len`) instead of copying.
- `settle_claude_turn(live_root, uid, project_id, projects_root) -> bool`:
  only when a record reads `Decision` (never `Working`; the Codex fn settles
  both, this one must not). The transcript is `claude_session_log(
  projects_root, sid)` (`agent_session.rs`, private today: make it
  `pub(crate)`); `projects_root` from `claude_projects_roots(project)` in the
  window and `agent_home::scope_home_in(state_dir, project).join(".claude")
  .join("projects")` in the sidecar. Read the file's last `CLAUDE_TAIL` bytes
  by handle (`home_io::open_regular`: the file is agent-writable).
- The trigger is the **`[Request interrupted by user for tool use]` notice**
  (`claude_interrupt`) whose own `timestamp` is later than the record's write
  (`record_written_ms`) and with no `tool_use` after it. Not the bare
  `is_error: true` result: a rejection with feedback may also be an error
  result while the turn goes on. Not probed: add a feedback rejection and
  "Chat about this" to `turn_hooks.py` and read both records; until then
  those stay `decision` as today. On a match write `done <secs>` the way
  `settle_codex_turn` does (`HomeFile::open`) into whichever of the root and
  slice copies is `decision`. An answered question needs nothing
  (`PostToolUse` already writes `working`).
- The sidecar: `services/mobile_control/scheduler.rs` calls `settle_codex_turn`
  inside `if let (Some(uid), "codex") = (target.uid(), target.tab.cmd.as_str())`
  before `ready(record, ..)`; make it a `match` on the cmd with a `"claude"`
  arm.
- Tests next to `settle_codex_turn`'s (`agent_turn.rs` `mod tests`): decision
  + notice newer -> `done`; notice older than the record -> nothing;
  `working` record + notice -> nothing; unchanged length -> not read again;
  `../escape` uid refused. Paths via `Path::join`.

Frontend consequence (S3 verifies, no change expected): `noteAgentTurn("done")`
keeps `interruptedByPty` (set by the Esc through `noteUserInput(.., true)`,
also for the phone's `tab_input interrupt`), and `awaitingHookByPty` ends on
this non-replay event. `dialogOnScreen`'s keep-alive for Claude multi-page
questions (`settleAnswer` in `activity.ts`) is then not needed for a
*declined* question. **Do not remove it in this run**: it also covers
permission dialogs and typing into a free-text row. Remove only after a live
check, as its own commit.

### Phase 4: permission dialogs

Probed already: `tui_bash` (2.1.327) has the `Bash` `tool_use` in the
transcript (0.456 s) before the dialog draws (0.682 s), and Esc leaves no
hook. No further probe for `Bash`. `Edit`/`Write`/`WebFetch` share the
`PermissionRequest`/`tool_use` path but are unprobed: add them to
`turn_hooks.py` for the test fixtures.

- **`Bash` needs no new field.** `AgentTranscript.shells` already lists
  `Bash` calls since the last prompt with no result (`ShellCalls.waiting`),
  and the phone gets them masked (`mask_shell_commands` in
  `mobile_control/host.rs`). The dialog's subject is the newest `shells`
  entry (`at`), used only while the lamp says `question`.
- Other tools: `AgentTranscript.waiting_tools: Vec<WaitingTool { name,
  subject, at }>` (not `Bash`; `Edit`/`Write`/`MultiEdit`/`NotebookEdit` ->
  `file_path`/`notebook_path`, `WebFetch` -> `url`, anything else -> name,
  empty subject; bounded). Computed in `parse_entries` like `shells` (since
  the last typed prompt, no result, not a sidechain).
- **Phone masking, in the backend** (`mobile_control/host.rs`
  `phone_transcript`): next to `mask_shell_commands`, mask `waiting_tools`: a
  path `subject` through `shell_mask::mask_command(subject, &folders)` (same
  folders: project-relative, other paths to the leaf), a URL through a new
  pure `shell_mask::mask_url` (scheme and host only; no userinfo, port, path
  or query), unit-tested in `shell_mask/tests.rs`. `phone_transcript` builds
  `folders` and looks the tab up only when `shells` is non-empty
  (`wants_tab`): add `waiting_tools` to both conditions. A test beside
  `a_phone_transcript_masks_the_running_shells_command_lines`
  (`host/tests.rs`). The desktop Reader gets the raw values.
- The option rows stay the screen's, since only Claude words them ("don't ask
  again for ..."). **Invariant:** a command line crosses the phone API only
  through `mobile_control::shell_mask`; a raw `waiting_tools` or `shells`
  value never reaches `json!(transcript)`.
- Frontend (S5): the permission card heading shows the subject; i18n keys for
  the tool labels; `UntestedTag` + register row.

### Later: other CLIs, each behind its own probe

- OpenCode: does the session plugin's `question.asked` / `form.created` event
  carry the question (`opencode/hooks.py events`)? If yes, the plugin writes
  it next to `.turn`, or the store has it (`opencode_store`).
- Codex: the sync `request_user_input` in the rollout, read the way the async
  one already is; `PermissionRequest`'s command.
- Copilot: the `notification` payload.

## Not doing

- Answering through `PermissionRequest`'s hook output (allow/deny). It is a
  blocking hook: the app would sit in the CLI's approval path, a stalled
  window would stall the CLI, and it pulls against "an agent's permission
  mode is its own CLI's".
- `--output-format stream-json`: `-p` only, not the interactive TUI.
- A new hook-written payload record. See "Source" above.

## Security

The transcript is written inside the fence, so it is attacker-controlled.
The same bounds as today (`bounded_line`, `MAX_QUESTION_CHARS`), plus the
preview bound. Option labels are typed back only as the keys `answerKeys`
computes, never as text sent from the entry. A question's text never becomes
a command. Question text, labels, descriptions and previews cross to the phone
unmasked, as answered questions and the agent's answers already do (the paired
phone can read the same off the Terminal view); only Phase 4's subjects (a
command, a path, a URL) are masked.

## Gates

Per step, `scripts/gates.sh` (started with `scripts/gates-job.sh`) runs the
gates the diff touches. Frontend (S0, S3, S5): `npm run build`, `npm test`,
`npm run lint`, `scripts/brand-check.sh`, frames replay over the existing
Claude labels. Backend (S1, S2, S4): `cargo test --workspace`, the three
clippies, the daemon build (`cargo test -p tabtivity --no-default-features
--lib --test server_secrets`; `agent_transcript`/`agent_turn` are in it, so no
`tauri` import), tests cross-OS (`Path::join`); then `npm run backend:stale`,
reported. No Tauri command is added, so no `command_class` row. Live steps go
to the user (never start the app); each new surface gets an `UntestedTag` row.

## Agent steps

The first version had one frontend step (Phases 0, 2 and 4 across
`readerLive.ts`, the 2.9k-line `TerminalReaderView.tsx`, the phone
`Terminal.tsx`, a new merge, `useLiveQuestion`, i18n, `untested.ts`): far over
~1.5 days and 3 large files, and Phase 0 needs nothing from the backend. Split:

| Step | Plan sections | Files (main ones) | Depends on |
| --- | --- | --- | --- |
| S0 frontend gate | Phase 0 | `src/lib/agents/readerLive.ts`, a shared pure frame rule in `mobile-web/src/terminal/`, `mobile-web/src/screens/Terminal.tsx` (`liveTail`/`liveQuestion` only), `TerminalReaderView.tsx` (`shownLive` gate), `src/lib/shortcuts/steeringAnswer.ts`, `src/__tests__/agents/AgentReaderLive.test.ts` | — |
| S1 backend transcript | Phase 1 | `services/agent/agent_transcript.rs` + `agent_transcript/tests.rs`, `mobile-web/src/api.ts` types | — |
| S2 backend turn | Phase 3 | `services/agent/agent_turn.rs`, `services/launch_prep.rs`, `services/mobile_control/scheduler.rs`, `agent_session.rs` (one `pub(crate)`) | — |
| S3 frontend merge | Phase 2 | new `mobile-web/src/terminal/askedQuestion.ts` (merge), `transcriptTurns.ts`, `TerminalReaderView.tsx`, phone `screens/terminal/useLiveQuestion.ts` (+ small `Terminal.tsx`), `untested.ts`, i18n | S0 (same files), S1 (entry shape) |
| S4 backend permission subjects | Phase 4 backend | `agent_transcript.rs` (`waiting_tools`), `mobile_control/host.rs` `phone_transcript`, `shell_mask.rs` (+ tests) | S1 (same file) |
| S5 frontend permission subject | Phase 4 frontend | the permission card in `TerminalReaderView.tsx` / phone `Terminal.tsx`, i18n, `untested.ts` | S3, S4 |

## Organisation

Plan review (1 reviewer, done). Wave 1: S0, S1, S2 (disjoint files; run any
two at a time, each in its own worktree). Wave 2: S3 on top of S0+S1, S4 on
top of S1 (frontend vs backend, disjoint). Wave 3: S5. Then one final
reviewer over the whole range, with a security pass on S4's phone masking
(finder), whose findings a second agent verifies (verifier). The main agent
merges in order (S0, S1, S2, S3, S4, S5) and runs the gates. That is 6
implementers, a final reviewer, a finder and a verifier (the plan reviewer
is a ninth). If the "at most 5 subagents" routine stands, run S0-S3 plus the
final reviewer as this run and Phase 4 (S4, S5) as a second run after the user
has live-checked Phases 0-3 (see Flagged for user).

Why it fits: S0/S1/S2 touch disjoint files; S3 needs S1's entry shape and
S0's files; only S4 touches an invariant (`mobile_control`), so only S4 gets
the two-agent security pass.

Hot shared files: `src/lib/i18n/*`, `src/lib/untested.ts` and the filemaps
are edited only by S3 and S5 (S0 needs none: no new string). S1, S2 and S4
list any row they need under "Flagged for main" in the handoff.
**Uncommitted edits by other sessions** sit in the main checkout at plan time
on files these steps edit (`agent_turn.rs`, `launch_prep.rs`, `scheduler.rs`,
`api.ts`, `Terminal.tsx`, `TerminalReaderView.tsx`, `useSessionChat.ts`,
`untested.ts`, `i18n/*.ts`, the filemaps). Worktrees start at origin/main: the
main agent reads those files' diff before each merge and merges by hand
(never stash or `checkout --`).

**Main agent's run shape (2026-11-18, supersedes the wave list above):**
"at most 5" is a cap on agents running at once, not a total, so Phase 4 stays
in this run. To keep implementers few, S4 is folded into S1's agent (same
file, done after S1's commit, in its own commit) and S5 into S3's agent
(likewise). That makes 4 implementers: wave 1 = S0, S1+S4, S2 (parallel, at
most two cargo builds); wave 2 = S3+S5. Then the final reviewer and the
security finder run in parallel, and the verifier checks the finder's
findings.

## Open decisions

None. Both are taken in Fixed decisions 4 and 6.
