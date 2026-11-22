# Per-tab resume for Antigravity and Muse

> **Status (screened against code 2026-11-22):** Steps A-C and the follow-up run are in code: Antigravity resolves by id in `services/agent/google_chat.rs::resolve` (hook in `antigravity_session.rs`), Muse in `services/agent/muse_session.rs::resolve` (`muse_session/hook.rs`), and `agent_resume_pinned` reads the same records. Nothing open but live checks. Not live-tested.

Built 2026-11-16 (probed offline).

## Why

After a restart a Claude, Codex, Copilot, OpenCode or Vibe tab comes back to
its own conversation. An Antigravity or Muse tab comes back to the newest
conversation of its folder (`--continue`, `resume --last`), so two tabs of one
CLI in one folder both reopen the same chat. Both CLIs can resume by id
(`agy --conversation <id>`, `muse resume <id>`) and both resolvers already do
so when the tab has a live-session record (`google_chat::resolve`,
`muse_session::resolve`). Only the Resume menu writes that record today
(`agent_session::resume_chat_plan`). The missing piece is a record written
while the tab runs.

Both CLIs have user hooks that Tabtivity does not use. Probed offline on
2026-11-16 (scripts in `tmp/verify-cli/notes/hook-probes/`, binaries in
`tmp/verify-cli/{antigravity,muse}/bin-*`):

**Antigravity 1.5.9** (`agy_hooks2.py`, stub model)

- File: `~/.gemini/config/hooks.json`. A file at
  `~/.gemini/antigravity-cli/hooks.json` is migrated there once and replaced
  by a symlink.
- Format: `{"<hook name>": {"<Event>": [{"type": "command", "command": "…"}]}}`.
  The Claude shape (`{"hooks": {"Stop": [{"hooks": […]}]}}`) fails to parse,
  and a file that fails to parse runs none of its hooks.
- Events that fired: `SessionStart` (at the first prompt of a conversation,
  not at launch), `PreInvocation`, `PostInvocation`, `Stop`. `/hooks` also
  lists `PreToolUse` and `PostToolUse`.
- Input: JSON on stdin with `conversationId`, `cwd`, `hookEventName`,
  `lastUserInput`, `transcriptPath`; `Stop` adds `fullyIdle`,
  `terminationReason`, `continuationActive`. The binary also has
  `parentConversationId` and `rootConversationId` (subagents; not seen fire).
- The hook process inherits the CLI's environment; its working directory is
  `~/.gemini/config`.

**Muse 1.4.15** (`muse_hooks.py`, `muse_env.py`, `--provider echo`)

- File: `~/.config/muse/settings.json`, which must carry
  `"schema_version": 1`. A settings file Muse cannot parse makes it exit at
  launch (`malformed settings file …`, exit 1).
- Format: Claude's — `{"schema_version": 1, "hooks": {"SessionStart":
  [{"hooks": [{"type": "command", "command": "…"}]}]}}`.
- Events that fired: `SessionStart` (at launch, `source: "startup"`),
  `UserPromptSubmit`, `PreLLMCall`. The binary names many more
  (`PermissionRequest`, `PostToolUse`, `Notification`, `SessionEnd`,
  `SessionFork`, `StopFailure`, `PreCompact`, …).
- Input: JSON on stdin with `session_id`, `cwd`, `hook_event_name`,
  `permission_mode`, `source`.
- The hook's environment is an allow-list: `HOME LANG LOGNAME
  MUSE_SESSION_ID MUSE_THREAD_ID PATH PWD SHELL SHLVL TERM TRACEPARENT USER`.
  The tab variables do **not** reach it. On Linux the hook's parent is the
  `muse` process and `/proc/$PPID/environ` still holds them.
- The installed launcher reports Muse 1.3.0; whether 1.3.0 accepts a `hooks`
  key was not checked.

## Fixed decisions

Reviewers and implementers do not reopen these.

1. **Scope.** Antigravity and Muse, local tabs. Remote tabs, local-model tabs
   and the assistant scope stay as they are. Gemini, Qwen, Cursor, Grok and
   Droid stay on folder's latest.
2. **The record is the existing one.** The hook writes the conversation id to
   `live_sessions/<TAB_UID>` in the directory `agent_session::live_record_dir`
   resolves, the file the Resume menu already writes and both resolvers
   already read. No new store, no frontend change, no new Tauri command.
3. **One hook script per CLI**, written by that CLI's own module into
   `<state_dir>/hooks/` (as `agent_hint::write_script` and the OpenCode plugin
   are). The shared Claude/Codex/Vibe session script in `agent_session.rs` is
   not touched.
4. **Only the tab's own main conversation moves the record.** The script
   writes only when the tab-agent variable names its CLI (the resolver sets
   it, as `opencode_session::resolve_in` does), the id is uuid-shaped, and the
   event is not a subagent's (Antigravity: a parent conversation id is set). A
   nested run of the same CLI started from the tab's own shell tool must not
   move it; each implementer proves that with a test or a probe.
5. **A session that took no prompt is not the tab's own.** Muse mints a
   session at launch; it is recorded at the first prompt, not at
   `SessionStart`.
6. **Resolve rule**, the same for both CLIs. The host writes a launch note
   `live_sessions/<uid>.<cli>` at each spawn where the hook is registered
   (host-only, as `<uid>.opencode` is). The hook writes a proof file in the
   record directory the first time it fires in a scope.

   | Launch note from an earlier spawn | Record names a conversation the store has for this folder | Launch |
   | --- | --- | --- |
   | yes | yes | resume that id; the "began none since" check is skipped |
   | no | yes | today's rule (the Resume menu's pick, while the tab began none since) |
   | yes | no, and the scope has the hook proof | fresh |
   | otherwise | no | today's fallback (`--continue`, `resume --last`) |

7. **The Reader follows the same rule.** Where the record is authoritative,
   the tab's chat is that conversation, not the folder's newest since launch.
8. **Registration never breaks a launch.** It merges into the user's file
   under its own key and leaves everything else. A file it cannot parse, or a
   Muse settings file with another `schema_version`, is left untouched. Muse's
   file is written atomically. Registration is gated on a CLI version the
   probes showed accepts it.
9. **No record means today's behaviour.** Where the hook cannot learn the tab
   (Muse on a platform with no way to read the parent's environment, an old
   CLI version), nothing is written and the tab resumes as it does now.
10. **Turn state is out of scope.** The same hooks could drive the working /
    decision / done marks; that is a follow-up (below).

## Steps

### A. Antigravity

Files: `src-tauri/src/services/agent/google_chat.rs` (the resolver and record
reader live here; a new `antigravity_session.rs` beside it is fine if the file
grows), the home registration list in `agent_session.rs` (where
`opencode_session::register_in_home` is called), `agent_transcript.rs` (the
`own` passed for `agy`).

1. Probe first, with `tmp/verify-cli/notes/hook-probes/agy_hooks2.py` as the
   base: which event fires when a tab relaunches with `--conversation <id>`
   and `--continue`, when a new conversation starts inside a running TUI, for
   a subagent, and for `agy -p` run inside a tab. Run the format against the
   oldest kept baseline (`bin-1.5.2`) to find the version from which the
   chosen events parse. Move the probe into `scripts/verify-cli/antigravity/`.
2. Hook script (POSIX and PowerShell) and its registration in the scope home's
   `.gemini/config/hooks.json`, after the Tabtivity-wide layer is merged.
   Fenced and container tabs must be able to write the record, as Vibe's hook
   does.
3. Launch note, proof file and the resolve rule in `resolve`.
4. Reader: the authoritative record in `agy_tab_conversation`'s callers.
5. Tests: registration merge (keeps the user's hooks, idempotent, unparsable
   file untouched), the script run for real on unix (own conversation
   recorded; subagent, foreign tab agent and junk id refused), each row of the
   resolve table, two tabs in one folder resolving to two conversations.

### B. Muse

Files: `src-tauri/src/services/agent/muse_session.rs`, the same registration
list, `agent_transcript.rs` (the `own` passed for `muse`).

1. Probe first, with `muse_hooks.py` and `muse_env.py` as the base: whether
   Muse 1.3.0 (`bin-1.3.0`) accepts `hooks` in `settings.json` or exits;
   whether the settings format has a way to pass environment to a hook; what
   fires on `resume <id>`, `resume --last`, `/clear` or a new session inside
   the TUI, a fork, a subagent, and `muse exec` run inside a tab; whether
   `resume <id>` of a session that took no prompt opens or exits.
2. How the hook learns the tab, in this order: a settings-level way to pass
   the variables, if one exists; else `/proc/$PPID/environ` on Linux and the
   macOS equivalent if it works unprivileged; else no record (decision 9).
   Windows is expected to land in the last case; say so in the report.
3. Hook script and registration in the scope home's
   `.config/muse/settings.json`, gated on the version step 1 found.
4. Launch note, proof file and the resolve rule in `resolve`; keep the
   existing "no session in this folder → drop `resume --last`" rule.
5. Reader: the authoritative record in `tab_session`'s callers.
6. Tests: as A.5, plus the settings merge (creates the file with
   `schema_version` 1, keeps other keys, leaves another schema version
   alone) and the parent-environment lookup.

### C. Docs (main agent, at merge)

`README.md` table rows and footnote, `docs/guide/features.md` resume table and
paragraph, `docs/context/agent_sessions.md` (one section per CLI, written by
its implementer), `docs/filemap_backend.md` rows,
`docs/third_party_update_checklist.md` (the hook file formats and input fields
are now depended on), a 🖐️ manual test in `todo/group-s-agents.md` per CLI.

## Organisation

Two implementers in parallel, one per CLI, each in its own worktree reset to
`develop`; no reviewer subagents. The steps share no module, only three
additive touch points (`agent_session.rs` registration list,
`agent_transcript.rs`, the docs), so the main agent cherry-picks A then B onto
`develop`, resolves those, runs the gates on the result and writes step C.

| Agent step | Plan section | Main files |
| --- | --- | --- |
| 1 | A | `google_chat.rs`, hook script, `scripts/verify-cli/antigravity/` |
| 2 | B | `muse_session.rs`, hook script, `scripts/verify-cli/` Muse probe |

Implementers do not edit `README.md`, `docs/guide/features.md` or `todo/`;
they put the wording in their report.

## Verification

- `scripts/gates.sh` green in each worktree and on the merged result.
- Each implementer's offline probe: two tabs' worth of launches in one scratch
  home and folder, each relaunch back on its own conversation.
- Not run live. Click-through for the user after the next dev build: open two
  Antigravity tabs in one project, send a different prompt in each, restart
  the app, and check each tab shows its own chat; the same with Muse.

## Follow-up: hooks seen but not used

Not part of this plan.

- **Turn state for Antigravity and Muse.** Antigravity's `PreInvocation` and
  `Stop` (`fullyIdle`), and Muse's `UserPromptSubmit`, `PermissionRequest`,
  `Notification` and `SessionEnd`, map onto the `working` / `decision` /
  `done` / `idle` record that `services::agent_turn` relays for Claude and
  Codex. Both CLIs are on the terminal-output heuristic today.
- **Muse permission mode and `/clear`.** Its `SessionStart` input carries
  `permission_mode` and `source`, what the Claude hook uses to re-apply a mode
  on resume and to offer Undo clear.
- **The `tabtivity-send` hint.** Neither CLI gets it today; both have a
  `SessionStart` hook that could carry it, if its output reaches the model.
- **Claude.** Registered today: `SessionStart`, `Stop`, `UserPromptSubmit`,
  `PostToolUse`, `PermissionRequest`, `Notification`, `SessionEnd`
  (`agent_session::HOOK_EVENTS`). Its release notes (through 2.1.323, saved in
  `tmp/verify-cli/notes/claude.md`) name others that fit the turn record; none
  was probed:
  - `StopFailure` (a turn ended by an API error such as a rate limit or a
    failed sign-in) and `PostToolUseFailure`: check whether `Stop` /
    `PostToolUse` fire in those cases; if not, the tab's working or decision
    mark has nothing to end it.
  - `Elicitation`: the dialog opening, where the `decision` mark now waits for
    the late `Notification`, as it did for permissions before
    `PermissionRequest`.
  - `PermissionDenied`: an auto-mode classifier refusal.
  - `SubagentStart` / `SubagentStop`: the running-subagent count, replayed from
    the transcript today.
  - `PreCompact` / `PostCompact`: a "compacting" state.
  - `CwdChanged`: the Reader's folder and worktree fact, read from the
    transcript's newest `cwd` today.
- **Codex 0.169.0.** Registered: `SessionStart`, `Stop`, `UserPromptSubmit`,
  `PostToolUse`, `SessionEnd` (`CODEX_HOOK_EVENTS`). The binary also has
  `PermissionRequest` (left out so far only because nobody verified it; the
  approval wait is read off the screen), `PreToolUse`, `SubagentStart`,
  `SubagentStop`, `PreCompact`, `PostCompact`. Its release notes say nothing
  about hooks.
- **Copilot 1.0.112.** Registered: `sessionStart`, for the `tabtivity-send`
  hint only; the tab's session is pinned by `--session-id`, and its turn state
  is the terminal-output heuristic. Its release notes name
  `userPromptSubmitted`, `preToolUse`, `postToolUse`, `postToolUseFailure`,
  `permissionRequest`, `notification`, `agentStop`, `subagentStart`,
  `subagentStop`, `preCompact`, `sessionEnd` and `errorOccurred`: the whole
  turn record is available.
- **OpenCode 2.2.7 / 2.3.0.** The plugin uses `chat.message` (the record) and
  the `event` bus only to skip child sessions. The bus also carries
  `permission.asked` / `permission.replied`, `session.status`, `session.idle`,
  `session.error`; plugin hooks `execute.before` / `execute.after`,
  `session.fork` and `experimental.idle` exist (the last two experimental).
  Turn state is the heuristic today.
- **Vibe 3.1.2** (`vibe/core/hooks/models.py`). Registered: `post_agent`. Also
  there: `pre_agent`, `pre_tool`, `post_tool`, `notification`,
  `session_start`, `session_end`. The last three are "host" hooks its app
  server fires; whether the TUI fires them is not checked. `pre_agent` would
  record the session at the first prompt instead of after the first finished
  turn, and with `post_agent` gives working / done.

## Follow-up run: turn state from hooks

Starts once A and B are on `develop`. Three implementers in parallel, split by
who owns which hook mechanism, so no two edit the same script.

| Agent step | CLIs | Owns |
| --- | --- | --- |
| F1 | Antigravity, Muse | the two hook scripts steps A and B added |
| F2 | Claude, Codex, Vibe | the shared session hook script and its registration in `agent_session.rs` |
| F3 | Copilot, OpenCode | Copilot's hook file (`agent_hint`, `copilot_session`), the OpenCode plugin (`opencode_session`) |

Fixed decisions for the follow-up:

1. **The turn record is the existing one**: `live_sessions/<key>.turn`, the
   words `working` / `decision` / `done` / `idle`, relayed by
   `services::agent_turn`. A CLI that writes it is treated as Claude and Codex
   are; the terminal-output heuristic stays for a tab whose hook never fired.
2. **Probe before registering.** An event is registered only after an offline
   probe of the real binary showed it firing, with the input it carries. What
   a probe could not reach is reported, not registered.
3. **The nested-CLI rule holds for every new event** (decision 4 above; for
   Claude and Codex the existing continuity rule).
4. **First the gaps, then the extras.** In this order: a turn that ends
   without `Stop` (Claude `StopFailure`, `PostToolUseFailure`; the equivalents
   elsewhere), the approval wait (`decision`: Codex `PermissionRequest`,
   Claude `Elicitation`, Copilot `permissionRequest`, OpenCode
   `permission.asked`, Muse `PermissionRequest`), then working / done / idle
   for the CLIs on the heuristic.
5. **No new UI.** A compacting state, a hook-driven subagent count, the folder
   from `CwdChanged` and a notice for `PermissionDenied` need frontend work;
   an implementer reports what the hooks would give and leaves them.
6. **F1 extras**: Muse re-applies no mode (Tabtivity chooses none; the mode
   record is Claude's alone) — only `source: clear` for Undo clear, and the
   `tabtivity-send` hint through `SessionStart` for both CLIs where its output
   reaches the model.
7. **F2 extra**: Vibe's record moves to `pre_agent` if the probe shows it
   fires at the prompt with the session id.

### Outcome of the follow-up run

Built, each event probed offline first:

| CLI | Turn record from | Not built |
| --- | --- | --- |
| Claude | `StopFailure` → done, `PostToolUseFailure` → working, `Elicitation` / `ElicitationResult` → decision / working | `PermissionDenied`, subagent, compact and `CwdChanged` events fire and are reported, no UI |
| Codex | `PermissionRequest` → decision | a failed API call fires nothing (Codex keeps retrying) |
| Vibe | `pre_agent`, `post_agent`, `post_tool`, `notification`, `session_end`; the session is recorded at the prompt | a failed API call was not seen to end |
| Copilot | its own hook file, from 1.0.112 | Esc on an approval fires nothing; a retried model call reads done during the retries |
| OpenCode | the session plugin's bus subscription | 1.x not run (its binary could not be run here) |
| Antigravity | `PreInvocation` → working, `Stop` → done; the send hint at `SessionStart` | no approval or session-end event exists |
| Muse | `UserPromptSubmit`, `Stop`, `Interrupt` (1.4.15), `SessionEnd`; the send hint | `PermissionRequest`, `Notification`, `StopFailure` unreachable with the echo provider; no Undo-clear record (Muse reports a clear only with the next prompt) |

Found and fixed on the way: a nested `copilot -p`, `opencode run` (OpenCode 2)
or `vibe -p` started from the tab's own shell tool took the tab's session
record over.

Decided by the user afterwards (2026-11-16) and built: the Codex hook status
counts `PermissionRequest` too (`codex_reported_state_in`; the binder's gate
stays on `SessionStart`), and the comment in `src/stores/activity.ts` names
which CLIs have an approval hook.

Open, for the user:

- Adding `PermissionRequest` makes Codex show "Hooks need review" once in a
  home that trusted the other hooks; a home that skips it now reports
  Untrusted until the hooks are trusted.
- OpenCode 1.x needs a real run of the plugin's turn half.
