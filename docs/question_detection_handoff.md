# Question detection — handoff

> **Status (screened against code 2026-11-22):** Log of `docs/question_detection_plan.md` (S0-S5, final review, follow-ups of 11-18); all on develop (`waiting_question_entry`, `askedQuestion.ts`, the Reader/phone merge). Open: the "Flagged for user" items and the live click-through; other CLIs not started. Not live-tested.

Plan: `docs/question_detection_plan.md`. Each agent edits only its own section
(use the Edit tool on this file in the **main checkout**,
`docs/question_detection_handoff.md`).

Probe outputs (read-only evidence for tests):
`tmp/verify-cli/claude/2.1.32{6,7}-ask/turn/<case>/`
— `timing.json`, `dump/NN-<event>.json` (hook payloads), `*.esc` frames
(`capture-pane -e`), the session transcript under `home/.claude/projects/`.

## Plan review

Reviewed against the code 2026-11-18; edits are in the plan. Changes:
- **Steps re-split** (old S3 was ~5 large files and needs nothing from the
  backend for Phase 0): S0 frontend gate (Phase 0), S1 backend transcript,
  S2 backend turn, S3 frontend merge (Phase 2), S4 backend permission subjects,
  S5 frontend permission subject. Dependencies and waves are in the plan.
- **`asking` must not be reused** for Claude's waiting question: its
  consumers (`transcriptTurns.ts`, `Terminal.tsx` ~448, `useAsyncAsk.ts`) are
  Codex's async queue and answer with shift+←. New `TranscriptEntry.blocking`.
  Both chat renderers (phone `transcriptTurns.ts`, desktop
  `TerminalReaderView.tsx` ~584 `AskedQuestions`) must drop `blocking` entries.
- **Phase 1 made concrete**: `asked` is an unordered `HashMap`; keep order,
  clear on a typed prompt / interrupt record, skip sidechain, append after the
  loop; the existing test asserting no entry for a trailing question changes;
  `multiSelect` needs a serde rename; previews must not go through
  `bounded_line`.
- **Phase 0**: two copies of the reading (desktop `readReaderLive`, phone's own
  `liveTail`/`liveQuestion` in `Terminal.tsx`); gate at the call sites (also
  `steeringAnswer.ts`), not in the pure reader; the phone has no live lamp
  (`agent_status` is a tab-list snapshot); `activity.ts` has a second,
  screen-based `decision` source (`tailLooksLikeDecision`).
- **Phase 2**: entry-only card only while the lamp says `question` (a dangling
  call in a dead/resumed session would otherwise show a phantom card forever).
- **Phase 3**: no "interrupted" turn word exists (`TurnState` has working/
  decision/done/idle; interrupted is frontend-only), so `done`. Trigger on the
  `[Request interrupted by user for tool use]` notice, not the bare
  `is_error` result. Concrete function names (`settle_claude_turn`,
  `watch_claude_transcript`, `claude_session_log` -> `pub(crate)`), the
  `launch_prep.rs` call and the sidecar `scheduler.rs` `"claude"` arm.
- **Phase 4**: "not probed" was stale (`tui_bash` shows the `tool_use` before
  the dialog). `Bash` needs no new field: `AgentTranscript.shells` already
  carries the waiting command and is masked in `mobile_control/host.rs`
  (`phone_transcript`/`mask_shell_commands`, not a generic "path"). Other
  tools: new `waiting_tools`, masked there; new `shell_mask::mask_url`;
  `wants_tab` condition must include it. Decision 7 is implementable.
- No Tauri command is added: no `command_class` row. i18n is needed in
  S3/S5 only (five dictionaries).
- Uncommitted edits by other sessions overlap the files these steps touch
  (see Organisation in the plan).

## S0 frontend gate

Done. Worktree `.claude/worktrees/agent-ab1805e268383cbf5`,
branch `qd-s0` (from develop a245d4593), commit **39d52ddfb** (not pushed).

**The gate rule.** Claude Code hides its input box while a dialog is up, so
with an input frame found (`inputFrameStart < lines.length`, no press-hint
page) the rows above it are output. New pure `boxHidesDialog(agentLabel,
frameFound)` in `mobile-web/src/terminal/liveDialog.ts` (Claude family only;
other CLIs untouched). Desktop: `readReaderLive` skips `readSelectPrompt`/
`readReviewStep`/`readStrayDialog` when it holds. Phone: its inline
`liveQuestion` chain moved into `readLiveQuestion(tail, screen, label, cols)`
(same file, same order, Codex hooks page first); `Terminal.tsx` calls it.
Lamp gate at the call sites (not inside the pure reader): new
`src/lib/agents/liveCardGate.ts`: `hookLampHidesCard(ptyId, label, asking)` is
true for a Claude tab with a hook verdict (`agentDeliveryTurn` defined) whose
`attentionByTab` is not `decision`. I used `attentionByTab === "decision"`, not
`agentTabStateOf`: that checks busy first, and a running background job
(`jobBusy`) keeps the tab busy while it is on a decision. A tab with no hook
verdict yet (restored session, remote run, first-run screen) keeps the screen's
reading (fail open). `TerminalReaderView`: raw state renamed `screenLive`,
`live` is derived (`withoutCard` when gated), so every consumer (answer
handlers, `shownLive`, voice, empty state) sees the gated reading. `withoutCard`
reports the screen as `stray` (rows = ask + context + option labels) so a real
dialog the lamp does not announce (e.g. a slash-command picker typed in the
pane) is pointed at in the terminal, not dropped silently.
`steeringAnswer.liveQuestion` returns null under the same gate
(`lampHidesCardNow`); `settleAfterAnswer`, `dialogOnScreen`, `tabDialog` stay
ungated on purpose.

**Repro.** Constructed Claude screen: `❯ prompt`, `⏺` answer with
`  > 1. Use a map / 2. / 3.` (also `→`), then labelled rule + `❯ ` box + rule +
`? for shortcuts`. Before the fix `readReaderLive` returned a 3-option question
with the first row highlighted (3 tests red); after, null.

**Tests added** (all green): `AgentReaderLive.test.ts` +6 (describe "output above
Claude Code's input box is not a dialog": `>` list, other marks `→ ❯ › ▸`, list
right on the box, same rows as a dialog without a box, permission dialog under
a bare labelled rule, Codex `›` dialog still reads) 30 -> 36;
`LiveCardGate.test.ts` 4 (new); `MobileLiveQuestion.test.ts` 5 (new, phone side);
`SteeringAnswer.test.tsx` +1 (15).

**Frames replay.** `scripts/verify-cli/parsers/frames.probe.ts` over all 11
existing Claude labels (906 frames; `.esc` copied to the scratchpad, run with
`VERIFY_OUT`): reader JSON before vs after identical for all 906. Of those, 537
frames read a question (AskUserQuestion, permission prompts, pickers, review
step, stray dialogs): none has an input frame found, the evidence for the rule.

**Gates** (`scripts/gates-job.sh`, frontend only): brand, whitespace, lint,
build PASS; vitest `--changed` PASS (202 s). `privacy-check.sh` passes. No Rust
change. Not run live (app never started).

**Gotchas.** A unit-test tab needs a `useTabsStore` entry or `recompute` drops
its hook verdict. `frames.probe.ts` reads `tmp/verify-cli` relative to the
worktree: use `VERIFY_OUT=<dir>`. Files beyond the plan's list:
`src/lib/agents/liveCardGate.ts` (+ test) and
`mobile-web/src/terminal/liveDialog.ts`. `Terminal.tsx` lost its unused
`readReviewStep`/`readStrayDialog` imports. `npm run mobile:bundle` is stale
after this (mobile-web sources changed).

**Not covered.** The phone has no lamp gate (Phase 2). `activity.ts`
`attentionFor` still lights `decision` from `tailLooksLikeDecision` (screen): if
the user's repro is the lamp and not the card, that is the next gate. Other
CLIs got no frame rule (not captured the same way).

## S1 backend transcript (+ S4 permission subjects)

Worktree `.claude/worktrees/agent-aabfc8ff9092cc241`, branch `qd-s1` (from develop `a245d4593`). Not pushed.
- S1: `fc93bece2` feat(transcript): a waiting Claude question is a blocking entry
- S4: `d5ca7d154` feat(transcript): permission-dialog subjects, masked for the phone

**`npm run backend:stale` is for main** after merging (backend edits; nothing was started or restarted).

### S1: the entry S3 consumes

`agent_transcript.rs` `parse_entries`: `asked` is now an ordered `Vec`. A call still in it after the loop is waiting and its entry is pushed **last** (after every other entry, also after later text records), `at` = the ask's own timestamp. It is dropped (no entry) by a later typed prompt, by an `interrupted` record (`[Request interrupted ...]`), and never made for a subagent file (`sidechain`). A call that has its result becomes the ordinary answered/declined card (no `blocking`), at the question's own time, as before. Same call id seen twice keeps one.

Wire shape (`TranscriptEntry`, also typed in `mobile-web/src/api.ts`: `blocking?`, `AskedQuestion.multiSelect?`, option `preview?`):

```json
{"kind":"answer","at":"2026-11-18T09:19:13.591Z","blocking":true,
 "text":"Which colours should the probe use?\n\nWhich layout should the probe draw?",
 "questions":[
  {"header":"Colours","question":"Which colours should the probe use?","multiSelect":true,
   "options":[{"label":"Red","description":"warm"},{"label":"Blue","description":"cool"}]},
  {"header":"Layout","question":"Which layout should the probe draw?",
   "options":[{"label":"Grid","description":"rows and columns","preview":"+--+--+\n|  |  |\n+--+--+"},{"label":"List","preview":"- one\n- two"}]}]}
```
- `blocking` absent when false (also `multiSelect`, `chosen`); `asking` is never set on it. `answer` absent while waiting. `text` of a waiting entry is the question texts only (no `-> -` arrows).
- `multiSelect` is renamed from Rust `multi_select`; it is also read onto answered/declined cards. `preview` keeps `\n` and `\t`, trailing blanks per line trimmed, bounded to `MAX_PREVIEW_LINES` = 40 lines and `MAX_PREVIEW_CHARS` = 2000 (not through `bounded_line`). Render as preformatted text, never markdown.
- Additive: today's renderers keep working, but they render a waiting entry as an unanswered `AskedQuestions`/`AskedCard` bubble next to the live card, until S3 drops it.

**What S3 must do** (frontend files I did not touch):
- phone `mobile-web/src/terminal/transcriptTurns.ts` (feeds `Terminal.tsx` `AskedCard`) and desktop `TerminalReaderView.tsx` (`if (turn.questions) return <AskedQuestions ..>`, ~l. 584): drop entries with `blocking` (in `transcriptTurns.ts` if the desktop shares it, else both). `chatFiles.ts`/`chatLinks.ts` already skip `questions`.
- Merge input: the entry is the *last* element of `entries`, `blocking === true`; match to the screen by headers (`questions[i].header`). The entry may be absent when the dialog is already on screen (probe `tui_ask_multi` 2.1.327: screen before transcript), and may linger in a dead/resumed session: only while the lamp says `question`.
- Do not key on `asking` (Codex's queue, shift+left).

### S1 tests (`agent_transcript/tests.rs`)
Changed `a_claude_question_stays_in_the_chat_with_its_answer_once_answered` (trailing `toolu_C` now a blocking last entry). New (7): `a_claude_question_still_waiting_is_the_last_entry_marked_blocking` (probe tui_ask lines, wire shape), `an_answered_claude_question_loses_its_blocking_mark_and_keeps_rows_and_previews`, `a_declined_claude_question_is_the_plain_card_with_no_answer_and_the_interrupt_notice` (tui_ask_esc), `a_waiting_question_of_an_earlier_turn_or_before_an_interrupt_is_not_waiting`, `two_waiting_claude_questions_come_last_in_the_order_they_were_asked`, `a_subagent_files_questions_are_never_waiting`, `a_preview_is_bounded_by_lines_and_characters_and_keeps_its_breaks`. Fixtures are inline constants from the probe records (2.1.327 `tui_ask`, `tui_ask_esc`), `cwd`, ids and session ids scrubbed; no host paths. `agent_transcript` suite: 50 passed.

### S4: waiting tool calls, masked for the phone

Backend (`agent_transcript.rs`): `AgentTranscript.waiting_tools: Vec<WaitingTool { name, subject, at }>`, wire key `waitingTools` (omitted when empty; `subject` omitted when empty). Every Claude `tool_use` since the last typed prompt with no result, oldest first, newest 16 (`MAX_WAITING_TOOLS`), except `Bash` (stays `shells`) and `AskUserQuestion` (the blocking entry). Cleared by a typed prompt and an interrupt notice; none for a subagent file. Subject: `Edit`/`Write`/`MultiEdit` -> `file_path`, `NotebookEdit` -> `notebook_path`, `WebFetch` -> `url`, anything else empty (name only); one line, <= 500 chars. A tool name outside `[A-Za-z0-9_.:-]` or > 120 chars is not listed (`tool_name_ok`). `ExitPlanMode` and `Agent` are listed too (name only) next to their own records. Example desktop (raw) value: `{"name":"Edit","subject":"/work/proj/src/a.rs","at":"..."}`. For a Bash dialog S5 uses the newest `shells` entry. Desktop Reader gets the raw values.

**Masking rule** (`mobile_control/host.rs` `phone_transcript`, the single chokepoint also for the headless sidecar): `mask_waiting_tools` next to `mask_shell_commands`; the tab lookup/`folders` now also runs when `waiting_tools` is non-empty (`wants_tab`). Path subject -> new `shell_mask::mask_path(subject, folders)` (project-relative; anything still absolute or `~/` -> `.../leaf` as ONE path, so a space in a folder name leaks nothing; secrets hidden; relative paths stay). **Deviation from plan wording:** the plan said `mask_command`; that cuts at whitespace, so `/home/my user/secret dir/x` would leak `user/secret dir/x`, hence the dedicated `mask_path`. URL -> new pure `shell_mask::mask_url` (scheme + host only; no userinfo, port, path, query, fragment; IPv6 literal kept; `""` for anything not `scheme://valid-host`; random-run host labels hidden). Any other tool's subject is forced empty, and entries with an invalid name are dropped (a transcript read from a remote host is not ours to trust). Questions/labels/descriptions/previews cross unmasked, as the plan's Security section says.

S4 tests: `shell_mask/tests.rs` +3 (`mask_path` posix, `mask_path` Windows, `mask_url`: userinfo, port, query, `\@`, IPv6, odd inputs), `host/tests.rs` +1 `a_phone_transcript_masks_the_waiting_tools_subjects` (path, leaf, `~`, URL with userinfo/port/path/token, a non-file tool's smuggled subject dropped, bad tool name dropped, shells alongside; asserts none of the raw root/path/URL pieces appear anywhere in the wire JSON), `agent_transcript/tests.rs` +3 (listing incl. Bash/AskUserQuestion exclusion and wire shape; rejected/new prompt/interrupt end the wait; sidechain/bad name/cap/subject bound). `Edit`/`Write`/`WebFetch` fixtures are hand-built in the `tool_use` block shape (unprobed; add them to `turn_hooks.py` when probing), `Bash` is the `tui_bash` probe record shape.

Also touched: `opencode_store.rs` (one `waiting_tools: Vec::new()` in an exhaustive `AgentTranscript` literal).

### Gates
S1 tree (gates-job, 10 gates): brand, whitespace, lint, clippy x3, `npm run build`, vitest PASS; `cargo test -p tabtivity -p app-serverd` failed only `voice::session::{a_phantom_partial_writes_nothing, every_partial_is_the_whole_open_segment_and_none_follows_its_final}` (known load flake, project_load_flaky_tests): both pass alone (18 passed); daemon-build test (`--no-default-features --lib --test server_secrets`) 5933 passed. S4 tree: brand, whitespace, clippy x3 PASS (clippy first failed on a needless borrow in a new test, fixed); `cargo test -p tabtivity -p app-serverd` failed only load flakes (`markup_rounds` x4, `voice::session` x1), all 45 pass when rerun alone; daemon-build test 5939 passed. Only a test literal changed after (private-range IP -> 203.0.113.7 for the privacy hook), `shell_mask` tests rerun green. No frontend change in S4, so build/vitest skipped.

### Gotchas
- Shells/tools of the screen-before-transcript race: never assume the waiting entry exists when the dialog is on screen.
- Each commit queues the frozen dev build via `post-commit` (left alone).
- RTK rewrites what Bash prints: used `rtk proxy` to read source.
- Worktree: `node_modules` hardlinked, first cargo build cold (~15 min under load).

### Flagged for main
- No i18n, `untested.ts`, filemap rows added. Needed: filemap rows for the new `shell_mask::mask_path/mask_url` and `WaitingTool` (one line each, `docs/filemap_backend.md`); S5 owns i18n for tool labels and the `UntestedTag` row; S3 the entry-only-card rows.
- `mask_command` leaves a URL's host/path in a shell command line unmasked (pre-existing: `https://h.example.org/secret/path` passes `leaf_only_paths` since `//` is not a path start). Not changed here; worth a follow-up since decision 7 says a URL goes to host only for waiting tools but a Bash command with a URL still shows it.

## S2 backend turn

Branch `qd-s2` in the worktree `.claude/worktrees/agent-ab3adc35dda7538d7`
(from develop a245d4593). Commit sha: 811bf6839. Not pushed.

**What fires when**
- `launch_prep.rs`, right after `bind_tab`: a local Claude tab (`cmd ==
  "claude"`, not `remote_agent_run`, not `assistant`) calls
  `agent_turn::watch_claude_transcript(uid)`.
- The watcher's 2 s timeout arm calls `settle_claude_turns()` (new), **before**
  the `job_poll_due()` gate. Reason: a `decision` tab is "settled" for the job
  scan, which then runs only every 30 s; behind the gate a declined question
  would retire up to 30 s late. The call is a lock + filter when no watched
  tab reads `decision`.
- `settle_claude_turn(live_root, uid, project_id, projects_root) -> bool`:
  only for a record that reads `decision` (root and/or slice copy; never
  `working`). Session id from `read_live_session_in`, transcript via
  `claude_session_log` (now `pub(crate)`), opened with `home_io::open_regular`,
  last 64 KB read. Writes `done <secs>` (via `HomeFile`) iff
  `claude_tool_declined_at(tail)` is strictly later than the record's mtime.
  A write re-checks that the record is still `decision` with an unchanged
  mtime, so a `working` written by the next prompt's hook meanwhile is not
  overwritten.
- `claude_tool_declined_at`: newest user record whose content is exactly
  `[Request interrupted by user for tool use]`, no assistant `tool_use` after
  it; skips `isSidechain`/`isMeta` records and cut lines. A plain
  `[Request interrupted by user]` (Esc mid-turn) is not a trigger. Feedback
  rejection / "Chat about this" stay `decision` (not probed, as planned).
- Sidecar: `mobile_control/scheduler.rs` calls it for `claude` tabs before the
  `ready(record, ..)` check (projects root `scope_home_in(state_dir,
  project).join(".claude").join("projects")`).
- Per-uid cache `ClaudeLog` (sid, path, looked, read_len) is dropped in
  `bind_tab` and `on_tab_gone` via `forget_claude`.

**Tests** (agent_turn tests, 4 new): `a_claude_transcript_says_when_a_call_was_declined`
(notice -> ms; cut line; still waiting / plain interrupt / sidechain notice /
call after notice -> None), `a_declined_claude_question_is_recorded_done`
(decision -> declined -> done; done again -> false; planted symlink untouched
on unix; `../escape` refused), `a_claude_record_is_left_alone_unless_a_newer_notice_ends_its_decision`
(answered; stale notice older than record; `working` + notice; other
session's file; sidechain notice; other notice text), `an_unchanged_claude_transcript_is_not_read_again`.
Fixtures are synthetic records in the probe's shapes (`tui_ask_esc`, 2.1.327),
no absolute paths. All use `Path::join`.

**Gates**: `scripts/gates-job.sh` (brand, whitespace, clippy x3, `cargo test -p tabtivity -p app-serverd`, daemon-build test) all PASS, 0 warnings. `npm run backend:stale`: not run in this worktree (main reports it after merge).

**Gotchas / for the merge by hand**
- **develop has no `settle_codex_turn`**: it exists only as an uncommitted edit
  in the main checkout. So I could not "share `CodexRollout`'s cache": the
  Claude side has its own `ClaudeLog` / `claude_logs()` / `claude_uids()` /
  `forget_claude()`, in a self-contained block placed just before `mod tests`
  in `agent_turn.rs` (main's Codex block sits before `start`). When merging,
  either keep both caches (simplest) or fold `ClaudeLog` into `CodexRollout`
  (same four fields).
- Merge points in main's uncommitted files: `bind_tab` (`forget_claude(uid)`
  beside `forget_codex`), `on_tab_gone` loop, the `Timeout` arm in `start`
  (`settle_claude_turns()` goes **before** `job_poll_due()`; main's
  `settle_codex_turns()` is after it), `launch_prep.rs` (a `claude` `if` next
  to the `watch_codex_rollout` one), `scheduler.rs` (the Claude `if let`
  sits where main has the Codex one; turn both into one `match` on the cmd if
  wanted).
- `claude_session_log` is `pub(crate)` (one-word change in `agent_session.rs`).
- Frontend `settleAnswer` / `dialogOnScreen` keep-alive untouched.

**Flagged for main**
- No i18n / untested / filemap / command_class edits. Optional filemap row:
  `agent_turn.rs` now also settles a declined Claude question.
- Not probed: a rejection with feedback and "Chat about this" (they may write
  a different/no notice); until probed they stay `decision`. Add them to
  `turn_hooks.py`.
- Not live-run (stub transcripts only); after merge `npm run backend:stale`.

## S3 frontend merge (+ S5 permission subject)

Worktree `.claude/worktrees/agent-a8f3be5065ef9adc1`, branch `qd-s3` (from `qd-int` 2e815812d = develop + S0, S1, S4, S2). Not pushed. Frontend only: `npm run mobile:bundle` is main's to run.

- S3: **ea112a2a3** feat(reader): a waiting Claude question is read from the transcript, over the screen
- S5: **37f21da70** feat(reader): a permission dialog names the call it waits on

### S3: the merge rule

`mobile-web/src/terminal/askedQuestion.ts` (pure, shared desktop and phone). `mergeAskedQuestion(entry, live, entryOnly = false) -> AskedCard | null`, `waitingQuestion(entries)` (last entry with `blocking` and questions, searched from the end so a phone-pending prompt after it is fine), `entryCardAllowed(screen, label)` (phone).

- **Gate = the tab row.** `live` is the screen's dialog (`question` + `ask`/`context`/`tabs`/`tabFocus`/`tabSubmit`/`tabKeys`, built from `readReaderLive` on the desktop, `readLiveQuestion` + `questionParts` on the phone). The screen's tab labels must equal the entry's headers (same count, same order, whitespace collapsed), else `null` and the caller keeps the screen's reading **unchanged** (permission prompt, another dialog, the OpenCode path, a review step). `question.review` also gives `null`.
- **Page** = `tabFocus` if it is a question index; the Submit step (`tabFocus === tabs.length`) gives `null`; a tab row that paints no focus: the one question of a single-question entry, else the question whose text equals the screen's `ask`, else `null`.
- **Rows.** The first N screen options must be the entry page's N answers (label equal after dropping the `[x]` box, whitespace collapsed, or the pane's `...` cut a prefix of the entry's). Any miss gives `null`. Then those rows take the entry's `label` and `description`, plus `preview` (re-bounded to 40 lines / 2000 chars, breaks kept) and, on a `multiSelect` question, `ticked` from the screen's box glyph. Rows after N (`[ ] Type something`, `Next`/`Submit`, `Chat about this`) stay exactly the screen's. Each kept row keeps the screen's `index`/`number`/`keys`; the prompt keeps `current`, `start`, `question`, `context`, `title`.
- **Card fields.** `question.source = "entry"`, `question.multiSelect`; `ask` = the entry's question text; tabs/focus/submit/keys/context are the screen's. `signature` = `selectSignature` of the **screen's** prompt (so a tick, a glyph in the screen's label, still counts as a redraw, and a merge arriving is not read as one).
- **Entry only** (no dialog on screen, `entryOnly` true): `kind: "entry"`, read-only card of the first question: `question.readOnly = true`, `current = -1`, options numbered 1..N, tabs = all headers unanswered, `tabFocus 0`, `signature = "entry:<at>"`. Nothing can be sent from it: desktop `answer`/`answerText`/`step` return on `readOnly`, the rows are `disabled`; phone `answerQuestion`/`stepQuestion`/`answerQuestionText` return on `readOnly`; `voicePickable` is false for it.
- **Answer keys stay the screen's.** `answerKeys`/`answerTextKeys`/`tabStepKeys` are untouched and run on the merged prompt, whose `index`/`number`/`current` are the screen's (tested: same keys per row as the screen reading, free-text row still `[]`).
- **Both chat renderers drop `blocking`**: it is in `transcriptTurns.ts` `buildTurns` (flatMap, `index` stays the position in `entries`), which the desktop Reader already shares, so one change covers `AskedCard` (phone) and `AskedQuestions` (desktop).

### S3: where the entry-only card may stand (the phone decision)

- **Desktop**: `withWaitingEntry(live, entry, lampAsking)` in `src/lib/agents/liveCardGate.ts`. Entry-only only while `attentionByTab[ptyId] === "decision"` (S0's lamp). With the lamp not asking, `withoutCard` leaves no dialog and the entry gives nothing. The merge itself (a screen dialog that matches) applies whatever the lamp says, since the S0 gate has already kept the dialog or not. The desktop passes the entry from `transcript.entries` (Claude, not a browsed earlier chat).
- **Phone**: the plan said `agent_status === "question"`, but S0 flagged that `tab.agent_status` is the tab list's snapshot from when the screen opened (the tab row is frozen in `App.tsx`'s `terminal` state), so that would be wrong or stale almost always. I decided on the **live screen as the stand-in** (`entryCardAllowed`): Claude only, the screen is not blank, and either **no input box is on it** (Claude hides the box while a dialog is up) or **a busy row is on it** (the 0.3 s window where the `tool_use` is recorded and the dialog is not drawn yet). A screen with a box and no busy row is an idle session, and its leftover `blocking` entry (dead or resumed session) shows nothing. The phone also requires `sessionFocus` (the live screen is only read then). Open: if a real user finds a leftover card, tighten here or give the phone a live lamp (a tab-state poll).

### S5: the permission subject

`mobile-web/src/terminal/permissionSubject.ts`: `permissionSubject({shells, waitingTools}) -> {kind: "command"|"file"|"url"|"tool", tool, subject} | null`. Newest by `at` of (newest `shells` entry with `!background`) and (newest `waitingTools`); a tie goes to the later in the list (oldest first); `Edit`/`Write`/`MultiEdit`/`NotebookEdit` with a subject -> file, `WebFetch` with a subject -> url, everything else (and a subject the phone's mask left empty) -> the tool's name only, a subject on a tool that takes none is not shown. Subject text is plain text, cut to 500 chars / 8 lines. `isPermissionDialog(question, tabCount)` = no tab row, not the review step, `source` unset (so not the entry card, not OpenCode's). Never markdown or HTML: a `<code>` element, text node.

- Desktop: `LiveQuestion` `subject` prop; computed `lampAsking && Claude && isPermissionDialog(shownLive.question, tabs.length)`. Heading line "Waiting for approval to run / change / fetch / use {tool}" over the dialog's own context.
- Phone: the same `permission` after `useLiveQuestion`, shown above `QuestionList` while the dialog is on the live screen (no lamp there; the dialog is the sign). The values arrive already masked from `phone_transcript` (S4); nothing is masked in the frontend.
- `api.ts`: `SessionTranscript.waitingTools?: WaitingTool[]`, `WaitingTool { name; subject?; at? }`.

### i18n keys added (en, de, es, fr, it)

`terminal.reader.questionWaiting`, `terminal.reader.permissionRun`, `terminal.reader.permissionFile`, `terminal.reader.permissionUrl`, `terminal.reader.permissionTool` (`{tool}`). The phone reuses the `terminal.reader.*` keys, as it already does for the step buttons.

### New untested ids (`src/lib/untested.ts`)

`terminal.reader.questionWaiting`, `terminal.reader.questionPreview`, `terminal.reader.permissionSubject` (desktop); `mobile.question.waiting`, `mobile.question.preview`, `mobile.question.permissionSubject` (phone).

### Tests (all green)

- `src/__tests__/mobile/MobileAskedQuestion.test.ts` (new, 13): the entry pick; merge from the probe's multi-select page and its preview page (frames from `tmp/verify-cli/claude/2.1.327-ask/turn/tui_ask_multi`, colours stripped); same answer keys as the screen reading; previews bounded; page by focus / by text; fallbacks (other headers, fewer headers, permission prompt, reworded row, review step, no/non-blocking entry); truncated label; entry-only card and its gate; `entryCardAllowed` (busy row over box, no box, idle box, blank, non-Claude).
- `src/__tests__/mobile/MobileLiveQuestionEntry.test.tsx` (new, 2, `useLiveQuestion`): merged card lists the entry's text and answers with the screen's keys; entry-only card sends nothing from a tap, a step or typed words.
- `src/__tests__/agents/LiveCardGate.test.ts` +3 (`withWaitingEntry`); `src/__tests__/mobile/MobileTranscriptTurns.test.ts` +1 (`blocking` dropped, indexes kept).
- `src/__tests__/mobile/MobilePermissionSubject.test.ts` (new, 5).
- `src/__tests__/terminal/TerminalReaderView.test.tsx` +3 ("through the stored session's record of the call": subject for Edit under the lamp only; Bash command in full; waiting question read-only with the lamp, no chat bubble, then merged on the screen's rows with box and preview, click sends the screen's `\r`).

### Gates

`scripts/gates-job.sh` (frontend only, no Rust change so the cargo gates were skipped), per commit: brand, whitespace, `npm run lint`, `npm run build` PASS (S3 and S5 trees); `privacy-check.sh` PASS on both commits. vitest `--changed` (925 files affected): S3 tree 9380 passed, 1 failed (`TerminalAiSwitch` "agent tab refused while AI is off waits": `pty_resize` seen last, not `pty_spawn`); S5 tree 9362 passed, 2 failed (`TerminalAiSwitch` same test, `BibCards` "mounts only a window" 23.8 s timeout). Machine load average was 57 during both runs. Every failed file passes when rerun alone (`TerminalAiSwitch`, `BibCards`, `TerminalReaderView`, `UntestedRegistry`: 82 and 16 tests green), and none touches this diff: load flakes (see project_load_flaky_tests). The untested register audit (`UntestedRegistry.test.ts`) and the i18n parity tests pass.

### Gotchas

- RTK / Bash: compound commands with a heredoc and `&&` are refused in a worktree; use Edit/Write.
- `console.log` in vitest is swallowed here; to look at a reading write to a file.
- The first 3 s of the probe's dialog: `readReaderLive` reads a plain (colour-stripped) probe frame with `tabFocus` null, so the merge picks the page by the question text; a real pane paints the chip and the focus is used. The unit tests cover both.
- A busy row plus an input box is also what an idle Claude with a *background job* might show; if the phone ever shows an entry-only card there with a leftover record, that is this heuristic (see the phone decision).
- Multi-select rows: the merged label no longer carries `[✔]`; the tick is `option.ticked` and the phone's `QuestionRows` draws the box (`box`/`checked`), the desktop draws `CheckboxIcon`/`SquareIcon`. The free-text row `[ ] Type something` keeps the screen's label (its regex needs it).
- A waiting `Bash` from `shells` that was already approved and still runs can be taken for a dialog's subject if the dialog is for a tool the backend does not list (name outside `[A-Za-z0-9_.:-]`); the lamp gate bounds it.

### Flagged for main

- Filemap rows added (one line each, no whole-file reads): `docs/filemap_frontend.md` (liveDialog.ts + liveCardGate.ts + askedQuestion.ts + permissionSubject.ts, one row), `docs/filemap_backend.md` (`shell_mask` mask_path/mask_url, `agent_transcript` blocking entry / WaitingTool / `waitingTools`, `agent_turn` Claude settle).
- Run `npm run mobile:bundle` (mobile-web sources changed) and `npm run backend:stale` after merging (S1, S2, S4 are backend).
- Previews cross to the phone unmasked, as the plan's Security section says (agent-written text, like option labels).
- **Not run live.** The app was never started.

### Click-through for the user (live checks)

Desktop Reader (Claude tab):
1. Ask Claude something that makes it call AskUserQuestion with a multi-select question and an option that has a preview (e.g. "ask me which colours I want, multiple choice, and which layout, with a preview for each layout"). While Claude works, then the dialog draws: the chat must show **one** question card (headed "Waiting for your answer"), not an extra "Question" bubble above it. Check: full question text, descriptions under rows, the boxes (checkbox icon) on a multi-select page ticked as in the terminal, the preview as a grey monospace box under its row. Click a box: it ticks in the terminal and in the card; the ← → steps still walk the pages; the review step ("Submit answers") is the screen's own card.
2. A flash of the read-only card (rows greyed, "The terminal is still drawing this question") for a moment before the dialog is there is expected; its rows must not respond to a click.
3. Decline the question in the terminal (Esc): the card goes away (S2 settles the lamp) and the chat shows the declined card (a "Question" card, "Not answered").
4. Permission dialog: ask Claude to run a long command (`rm -rf build && make all`) and to edit a file; while the approval dialog is up the card must open with "Waiting for approval to run" + the whole command, or "... to change" + the whole path. Approve a long-running command, then trigger a *different* dialog: it must name the new call, not the old command.
5. Leave a tab with a stale question (kill the app mid-question, relaunch with resume): no read-only card should linger while the lamp is not asking.

Phone (PWA, after `npm run mobile:bundle` and a running window that has the backend half; `npm run backend:stale` says so):
1. Same prompts as 1 and 4 above; open the Chat view on the phone. One question card, ticks as boxes, preview in a dark monospace box, tapping a row answers with the terminal's keys. The permission card is headed with the command/path/URL (the path is project-relative or just its file name, a URL only its host, a command with secrets as `•••`).
2. Open a tab that sits idle with an old unanswered question in its record: no question card should show on the phone.

## Final review

Worktree `.claude/worktrees/agent-a6c1b752f44c3e5d1`, branch `qd-final` (qd-s3 + 2 fixes). Not pushed.

### Fixed
- **ab308a065** phone: stale `blocking` entry re-showed a read-only "still drawing" card after every answer (phone reads the session 1.2-5 s late; busy row over the box looks like "before the dialog draws"). New `useAskedCard` (moved out of `Terminal.tsx`): an entry whose dialog was seen on the screen never stands alone again. Test: `MobileLiveQuestionEntry.test.tsx` "stands alone before the dialog is drawn, but not again once the dialog was on screen" (fails without the fix, verified).
- **53bf70e13** S2: `settle_claude_turns()` sat in the `recv_timeout` Timeout arm; any tab's record write restarts that clock, so a busy neighbour tab starved the settle and a declined question stayed `decision`. Now `settle_due()` at the loop top, at most every JOB_POLL. Test: `the_claude_settle_runs_on_its_own_clock_not_the_channels_timeout` (agent_turn). NOT compiled/run: cold cargo build was still going at 14:2x under load 60+.

### Security verify + fix

Every finding was traced in the code, then each new test was run with the fix
neutralised (all fail) and again with it (all pass). Quadratic test (ratio of 30k vs 120k records): >16 min (killed) before, 9 s for the whole module after


1. CONFIRMED-fixed (29aae6b6d). `tools.retain` / `asked.retain` rescanned an
   unbounded Vec per record. The walk now keeps at most 64 unanswered tool
   calls (`MAX_WALK_TOOLS`) and 8 asks (`MAX_WALK_ASKS`), and a Claude result
   drops its call from `tools`. Tests: `a_tail_of_unique_tool_calls_and_asks_is_walked_in_linear_time`
   (fails before), `a_result_ends_the_wait_of_a_call_among_many_unanswered_ones` (guard).
2. CONFIRMED-fixed (29aae6b6d). `phone_transcript` seeded the mask folders
   from the transcript's `cwd`. New `masking_folders` (host.rs) takes catalog
   folders only and adds the transcript cwd only if it is equal to or under
   one (no `..` component). Affects shells too. Test:
   `a_phone_transcript_trusts_no_cwd_outside_the_tab_and_bounds_the_waiting_tools`
   (checks a shell command and an Edit subject, plus the still-allowed cwd below the tab).
3. CONFIRMED-fixed (29aae6b6d). `mask_path` returned any non-absolute string
   as is (`/proj/../../../home/alice/x` became `../../../home/alice/x`; also
   `file:///`, `~alice/`, `\Users\alice\x`, `notes /home/alice/x`). A path
   that is not plain relative (a `..` component, `:`, leading `\` or `~`, a
   later word starting an absolute path) now keeps only its leaf. Test:
   `a_path_that_climbs_out_or_names_another_place_keeps_only_its_leaf`.
4. CONFIRMED-fixed (29aae6b6d). `claude_question` and `codex_async_ask` had no
   caps; a tail can be up to 64 MB. New `cap_questions`: 8 questions, 12 rows
   each, 64,000 characters per ask (first question's first row always kept).
   Test: `an_ask_is_held_to_a_few_questions_rows_and_characters`.
5. CONFIRMED-fixed (29aae6b6d), low. `mask_url` accepted any Unicode letter in
   the host, so a Cyrillic look-alike showed as the real name; it now shows
   ASCII hosts only (an IDN host arrives as `xn--` or shows nothing, the phone
   then shows the tool name alone). `mask_path` drops control, bidi, zero-width
   and tag characters before masking (RLO extension spoof). Tests:
   `a_host_in_another_script_shows_nothing`, `invisible_and_reordering_characters_are_dropped_from_a_path`.
6. CONFIRMED-fixed (29aae6b6d), low. `mask_waiting_tools` now keeps the newest
   `MAX_WAITING_TOOLS` (16), cuts each subject to `MAX_TOOL_SUBJECT_CHARS`
   before masking, and drops an `at` that is over 40 chars or not RFC 3339.
   Same host test as 2.

Not fixed, noticed (flag for the user):
- `shells` (and `commands`, `RunningShell`s from a remote host) are not
  count-capped in the walk or in `mask_shell_commands`; they are linear, not
  quadratic, so left alone.
- Codex `async_open.retain` per reply is still O(open asks) per record, so
  a hostile Codex rollout of many unanswered async asks is quadratic too.
  Not in the S1/S4 findings, so left.
- A catalog `cwd` that is itself above the project (a tab opened at `/`-level)
  is trusted as before; only the transcript-supplied cwd was the hole.

## Follow-ups (2026-11-18, after landing)

- Probes `tui_edit`/`tui_write`/`tui_fetch`/`tui_ask_chat`/`tui_bash_no`
  (2.1.327): the Edit/Create/Fetch wording matches `permissionSubject.ts`'s
  matchers (now pinned by `MobilePermissionDialogs.test.ts`); `Chat about
  this` and `No` + feedback are ended by `Stop` / `UserPromptSubmit` hooks,
  so no settle change. Findings are in the plan's probe table.
- The phone gets a `blocking` entry only while the tab's turn record says
  `decision` (`phone_transcript`, fail closed: host/remote tabs fall back to
  the screen-read card); a read that dropped one hands out no `version`, so
  the phone does full reads until the record flips (cost: a full read per
  poll for a tab with a stale unanswered question the phone is viewing,
  until the next prompt — accepted).
- The desktop shares the phone's "spent once its dialog was seen" rule
  (`askedQuestion.ts` `entryStands`), ending the flash after the last answer.
- Previews stay unmasked on the phone (user's decision, 2026-11-18).
- Still open: other CLIs (OpenCode `question.asked`, Codex sync
  `request_user_input`), each behind its own probe; the user's own repro of
  the original misread.

## Flagged for user
- S0 lamp gate turns user-opened Claude pickers (`/resume`, `/config`...) on a tab with a hook verdict into a `stray` pointer, no longer clickable cards/digit-answerable (plan says they stay unaffected).
- Phone answers call `noteUserInput` with no dialog info, so the desktop lamp drops after page 1 of a multi-question dialog; with the Reader open on that tab the S0 gate hides page 2.
- S5 subject = newest waiting call; with parallel Edits/approved running Bash the dialog may be for an older call. A non-Bash/`Agent` call in flight can head an unrelated no-tab dialog ("approval to use Agent").
- Phone entry-only card for a never-seen leftover entry while Claude is busy (resumed dead session) is still possible; desktop can flash the read-only card <1 s after the last answer.
- Local-model/Host-session Claude tabs keep transcripts in another home, so S2 never finds them (no settle, harmless).
- Checked clean: serde names/optionals vs TS types, blocking dropped from both chat renderers, answer keys from screen rows, i18n x5, untested ids, brand-check, no console/any/bare listen.

### Gates
Not run (time/load). Only: new vitest file 3 passed, eslint 0 errors (1 pre-existing warning), brand-check, privacy-check pass. Needs `scripts/gates-job.sh start --base develop` incl. cargo.

### Follow-up fixes (main's request) — commit b721158f3
- **Lamp gate removed for screen-read cards.** `hookLampHidesCard`/`lampHidesCardNow`/`withoutCard` deleted; `TerminalReaderView` and `steeringAnswer.liveQuestion` read the screen as before (S0's frame rule stays). The lamp now gates only `withWaitingEntry`'s entry-only read-only card. Tests: `LiveCardGate.test.ts` "does not rule a screen-read card out" (a /resume-style picker on a hook-driven tab, lamp not asking, still reads and `answerKeys` walks to the row; page 2 of a several-question dialog still reads after the lamp dropped); `SteeringAnswer.test.tsx` (hook-driven Claude tab, lamp not asking, digit answers the screen's dialog).
- **Permission subject belongs to the dialog.** `permissionSubject(transcript, dialogLines)`: Bash = newest non-background shell whose command the dialog prints (word by word, so the phone's masked command — relative paths, `…/leaf`, `•••` — still matches; a fully masked command matches nothing); else, by the dialog's wording (`make this edit` / `want to create|overwrite` / `Edit|Create file` -> Edit/Write/MultiEdit/NotebookEdit; `fetch` -> WebFetch), the newest call of that family, preferring one whose file leaf (`basename`) the dialog names; else null (no ExitPlanMode/Agent/MCP name-only headings any more). Callers pass ask + context + option labels (desktop, phone). Tests: `MobilePermissionSubject.test.ts` (parallel Bash calls, masked match, parallel edits naming a.rs, unrelated Agent/running Bash in flight, no-family dialog), `TerminalReaderView.test.tsx` Bash dialog now prints the command with an Agent in flight. Wording for Edit/Create/Fetch dialogs is from existing fixtures/knowledge, only "Bash command" is in probe frames (tmp/verify-cli/.../tui_bash): a Claude version wording the fetch/edit prompt otherwise just shows no subject.

## Flagged for user
- S0 lamp gate turns user-opened Claude pickers (`/resume`, `/config`...) on a tab with a hook verdict into a `stray` pointer, no longer clickable cards/digit-answerable (plan says they stay unaffected).
- Phone answers call `noteUserInput` with no dialog info, so the desktop lamp drops after page 1 of a multi-question dialog; with the Reader open on that tab the S0 gate hides page 2.
- S5 subject = newest waiting call; with parallel Edits/approved running Bash the dialog may be for an older call. A non-Bash/`Agent` call in flight can head an unrelated no-tab dialog ("approval to use Agent").
- Phone entry-only card for a never-seen leftover entry while Claude is busy (resumed dead session) is still possible; desktop can flash the read-only card <1 s after the last answer.
- Local-model/Host-session Claude tabs keep transcripts in another home, so S2 never finds them (no settle, harmless).
- Checked clean: serde names/optionals vs TS types, blocking dropped from both chat renderers, answer keys from screen rows, i18n x5, untested ids, brand-check, no console/any/bare listen.

### Gates
Not run (time/load). Only: new vitest file 3 passed, eslint 0 errors (1 pre-existing warning), brand-check, privacy-check pass. Needs `scripts/gates-job.sh start --base develop` incl. cargo.

## Flagged for user

- ~~**Agent count vs the "max 5 subagents" routine.**~~ Resolved by main: the cap is concurrency; S4 folded into S1's agent, S5 into S3's. Original note: The split needs 6
  implementers + final reviewer + finder + verifier. Proposed: this run =
  S0-S3 + final reviewer; Phase 4 (S4, S5; Fixed decision 6 keeps it in
  scope) as a second run after you live-check Phases 0-3. Or allow the larger
  count.
- **Decision 8 (`done`)**: there is no interrupted turn word, so a declined
  question settles as `done`; the "interrupted" mark still comes from the Esc
  keystroke (`noteUserInput`). Declining by the "Chat about this"/feedback
  row may not write the interrupt notice and then stays `decision` as today
  until probed; it is not covered by Phase 3.
- Question previews are agent-written text and cross to the phone unmasked,
  like option labels and answers do today. Say so if you want them masked.

## Flagged for main

## 2026-11-23: entry card answers by number (desktop)

The user's Chat view kept a one-question ask grey (read-only entry card) for
77 s while the terminal showed the dialog. Not reproduced: the exact dialog
(Claude 2.1.330, stub model) reads as a clickable card in tmux frames and as
a raw byte stream replayed into xterm, fullscreen TUI or not, at 80–170
columns, after long tool output, after a focus-out. Fix by the user's choice:
`liveCardGate.answerableByNumber` makes the desktop entry card of a
one-question single-choice ask answerable, each row sending its digit
(2.1.330 answers and submits on the digit; probed). Several questions and
multi-select stay read-only. The phone is unchanged (no live lamp to gate a
blind key on). Probes: `tmp/rawprobe/` (gitignored). If it recurs, get the Terminal view's screen at that moment:
the reader's miss itself is still unexplained.
