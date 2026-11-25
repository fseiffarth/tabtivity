# Agent session persistence

Referenced from `AGENTS.md`.

The per-project tab layout (`tab_layout`/`tab_groups`) lives in
`<state_dir>/sessions/<id>/terminals.json` (see "Persistence" in `AGENTS.md`;
the copy inside a project folder is export-only). Shell/files tabs are always
restored on relaunch; agent tabs are normally dropped, **except resumable agent
tabs** — Claude and Codex tabs that carry a `sessionId` are persisted (with
their `sessionId`) and restored, respawning the agent so the prior conversation
comes back (see `isRestorableTab` in `src/stores/tabs.ts` and `RESUMABLE_AGENTS`
in `src/lib/agents/agentClis.ts`). Which CLIs are agents and how each resumes
is the backend registry's (`commands/agents.rs` `AGENTS`, its `resume` field):
the frontend reads it as the generated `src/lib/agents/agentCliTable.ts`
(`UPDATE_AGENT_CLI_TABLE=1 cargo test … the_generated_agent_cli_table_ts_is_current`),
and the restore allow-list (`terminal_service`) and the phone's resumable set
(`mobile_control`) read it directly — one table, so a new CLI never restores
as a shell.

## Startup model and effort defaults

Manage CLIs → each installed CLI → Default model and effort saves
`agent_launch_defaults` in application settings, keyed by CLI binary.
`services::agent_defaults` supplies both the UI capabilities (`list_agents`)
and native launch arguments / environment values. Blank means CLI default.
`launch_prep` applies them after session resolution, before SSH/container/fence
wrapping, so desktop and headless phone launches use the same defaults.
MCP grants are decided first: Vibe's native `VIBE_ACTIVE_MODEL` is also a
legacy local-model marker and must not change the tab's authority.

A resume request is noted before resolving it (Copilot consumes `--continue`),
and resolved resume arguments are checked again. Explicit model/profile
choices keep their own effort; an explicit effort alone can use the default
model. Local-model tabs, logins, assistant chats and tmux attaches are excluded.
OpenCode v2 combines model and effort as `provider/model#variant`; an effort
there and in Junie requires a model. Unsupported startup options are explained
in the card instead of guessed. These controls are tagged as untested live.

## Mechanism

`services/agent/agent_session.rs`, installed at startup: Tabtivity installs a
`SessionStart` hook — into each Tabtivity-owned agent home
(`register_hooks_in_home`: `.claude/settings.json` JSON, `.codex/config.toml`
TOML text-append, Vibe's `hooks.toml`; never the user's own `~/.claude` or
`~/.codex`) — that records each tab's live
`session_id` under `<state_dir>/live_sessions/<key>` (`~/.local/share/tabtivity/`
on Linux), keyed by the
`TABTIVITY_TAB_UID` env var Tabtivity sets on the agent. At spawn,
`resolve_{claude,codex}_session` reads that to resume the *current* session,
following a `/clear`. The same script is also registered as a Claude `Stop`
hook: `Stop` fires after every response and — unlike `SessionStart` — carries
`permission_mode` in its payload, which the script records to
`live_sessions/<key>.mode`. The resolver re-applies that record as
`--permission-mode` on the `--resume` respawn, because Claude restores a mode
given at launch but *not* one reached via shift+tab mid-session (no hook event
fires for the cycle; verified empirically on CLI 2.1.251). This record is the
**only** thing that carries a mode across a respawn — Tabtivity has no mode toggle
of its own; a mode flag a custom agent's own spec puts on the args outranks it,
and values outside the known mode set are discarded (the record is hook-parsed
JSON becoming a CLI argument).

The same `SessionStart` also writes `live_sessions/<key>.src` — the payload's
`source` (`startup`, `resume`, `clear`, `compact`) — *before* the id, so a
reader that sees a new id sees what rolled it. The prompt history is that
reader (`services::agent_prompts::resolve_live_session`): when a prompt is
archived or recorded, the tab's launch id the frontend sent as `session_id` is
resolved through `read_live_session_and_source_for` to the live id and stored
as the row's `session_id`, with the launch id kept as `tab_id`. That is what
lets the prompt chart show the prompts after a `/clear` as a second session
card of the same tab, joined to the first by an edge the history draws itself
(`link_session_roll`: `after` + `/clear` for a clear, `related` for a resume).
The frontend's `tab.sessionId` stays the launch id throughout; nothing pushes
the live id into the window, and nothing needs to.

A `clear` start also writes `live_sessions/<key>.prev` — the id the clear
rolled away from — before the source. That is "Undo clear"
(`undo_clear_plan`, `agent_tab_undo_clear`, frontend `stores/agents/agentClearUndo`):
Claude, while the source still says `clear` and that transcript exists, gets
`/resume <prev>` typed into the running session; the resume's own
`SessionStart` moves the source on, so there is nothing left to undo. Codex
(whose in-session `/resume` is a picker) has its record written back to
`<prev>` with source `resume` and the tab is relaunched — the restart path for
one tab: its minted tmux session ends and the pane respawns with the restore
args, so `resolve_codex_session` resumes the cleared conversation. Every other
resumable agent is relaunched the same way on its `RESUMABLE_AGENTS` flag —
Vibe by the id its hook still holds, the continue-last agents on "latest",
which is the cleared conversation only while the new chat holds nothing (the
undo is withdrawn at the next prompt for that reason). Local tabs only. The id
never crosses to the phone: its Undo asks the desktop (`undo_clear`).

### The turn state (working / decision / done)

The same script serves four more events since 2026-09-15 — `UserPromptSubmit`,
`PostToolUse`, `Notification` (Claude only; Codex 0.154 has none) and
`SessionEnd` — and writes a second record, `live_sessions/<key>.turn`, holding
one word: `working` (a prompt was submitted, or a tool finished — which is also
how an approval wait ends), `done` (`Stop`, or the idle notice), `decision` (a
permission or elicitation notice) or `idle` (the session ended). The backend
(`services::agent_turn`) watches the tree and relays each write as an
`agent-turn` event keyed by the PTY id `pty_spawn` bound to the tab's uid; the
frontend's activity store treats that as the authority for the tab's working /
finished marks and keeps its byte heuristic only for agents that fire no hooks.
The reason is that no reading of the bytes survives every agent TUI: Codex
repaints a spinner and its title on a timer whether it works, waits or idles,
and while it thinks the only text that changes is one digit of its timer a
second. The nested-CLI guard applies to the turn events too — for Codex, every
event after `SessionStart` must carry the session the tab already recorded —
so a `claude -p` or `codex exec` the agent runs from its own shell tool never
moves the tab's state. `pty_spawn` deletes the record on every spawn, so a tab
resumed after a crash never starts out "working" from a stale file. Codex's
new hooks need the same one-time `/hooks` trust as its `SessionStart` one;
until then a Codex tab stays on the byte heuristic. Adding an event to a home
that trusted the others makes Codex (0.169.0) show "Hooks need review — 1 hook
is new or changed" at its next start (Review / Trust all and continue /
Continue without trusting); skipped, the new hook stays inert and the trusted
ones keep running. The app's own trust action (`trust_codex_hooks`) covers
every event `codex_event_label` names. The status the UI reads
(`codex_hook_state`, `codex_reported_state_in`) counts `PermissionRequest`
beside `SessionStart`, so a home that skipped that review reads as untrusted
and is offered the one-click trust; until then its approval wait is read off
the screen. `codex_binder_enabled` still goes by `SessionStart` alone: an
untrusted approval hook must not put the guessing binder back beside a live
session hook.

Since 2026-11-16 (probed offline on Claude 2.1.325, Codex 0.169.0, Vibe
3.1.2 with `scripts/verify-cli/{claude,codex,vibe}/turn_hooks.py`; never run
live) the script also serves the events that close the gaps those probes
showed:

| CLI | Event | Word | Why |
| --- | --- | --- | --- |
| Claude | `StopFailure` | done | a turn the API refused (rate limit, sign-in, bad request) fires it and **no** `Stop` |
| Claude | `PostToolUseFailure` | working, none when `is_interrupt` | a failed tool fires it instead of `PostToolUse`, so an approval it ran after was never ended |
| Claude | `Elicitation` / `ElicitationResult` | decision / working | an MCP server's question opening and its answer; the `elicitation_dialog` notice comes 6 s late |
| Codex | `PermissionRequest` | decision, none under auto-review | the approval dialog opening; accepted → `PostToolUse`, declined → no hook (input retires it, as for Claude). With `approvals_reviewer = "auto_review"` (top level of `$CODEX_HOME/config.toml`) it fires before the reviewer agent answers and no dialog opens — in the fence before nearly every command — so the hook writes nothing (2026-11-17, seen in a live rollout's `guardian_review` threads) |
| Codex | `PostToolUse` of `request_user_input_async` | decision while open | the async question (0.169.0): the turn works on and the question waits in Codex's queue (screen: `? 1 question · shift+← to answer`). Its call id goes into `<uid>.ask`; each later `working` is written as `decision` until the reply — a `UserPromptSubmit` whose prompt is `<send_user_message_question_reply>` naming the call — or `Stop`/`SessionStart`/`SessionEnd` (Codex drops a waiting question at the turn's end). A skip (^]) fires nothing: the mark stays until the turn ends. The chat shows it from the rollout (`agent_transcript`, `asking`), its rows answered through Codex's own picker (phone `useAsyncAsk`) |
| Vibe | `pre_agent` / `post_agent` | working / done | each prompt / each turn's end; both record the session |
| Vibe | `post_tool`, `notification` (`approval_requested`), `session_end` | working, decision, idle (not on `reason: clear`) | as for Claude |

Not registered, reported only: Claude's `PermissionDenied` (auto mode's
classifier, `reason`), `SubagentStart`/`SubagentStop` (`agent_id`,
`agent_type`; compaction runs as a subagent with an empty type),
`PreCompact`/`PostCompact` (`trigger`, `compact_summary`) and `CwdChanged`
(`old_cwd`, `new_cwd`) all fire, but would need new UI; Codex's
`SubagentStart`/`SubagentStop`/`PreCompact`/`PostCompact` likewise (its
subagent's own `UserPromptSubmit` carries the parent's `session_id` and an
`agent_id`, so it counts as the tab working). An interrupted Claude tool fired
no failure event on 2.1.325 (the `is_interrupt` guard is cheap insurance). A
Codex or Vibe turn that fails on the API was not seen to end: both retry for
longer than the probe waited. A Codex turn stopped by its usage limit (a 429
`usage_limit_reached`, never retried; 0.169.0, `turn_hooks.py … usage`,
2026-11-18, never live) fires `UserPromptSubmit` and **no** `Stop`; its
rollout ends the turn with `task_complete` carrying `error.codex_error_info:
"usage_limit_exceeded"`. `agent_turn::settle_codex_turn` reads that: while a
local Codex tab's record is in flight, the watcher's 2 s poll (and the Mobile
sidecar's scheduler, with no window) reads the rollout's last 64 KB when it
grew, and a `task_complete` no older than the record (2 s slack) is written
over it as `done`, `.ask` removed, as the hook's `Stop` would. Without it a
prompt scheduled for after the limit's reset found the tab `working` and was
recorded as missed. An interrupt (`turn_aborted`) is left alone: the probe's
Esc did not reach the tool call, so its rollout shape is unverified.

Four more CLIs write the same record, each from a hook of its own module and
never from the shared script (2026-11-16, probed offline, never live):
Antigravity (`antigravity_session`: `PreInvocation` → working, `Stop` → done),
Muse (`muse_session/hook.rs`: `UserPromptSubmit` → working, `Stop` and, from
1.4.15, `Interrupt` → done, `SessionEnd` → idle), Copilot from 1.0.112
(`copilot_session/turn.sh`, its own `.copilot/hooks` file: `userPromptSubmitted`
and `postToolUse` → working, the dialog's `notification` → decision, `agentStop`
and a failed model call's `errorOccurred` → done, `sessionEnd` → idle) and
OpenCode (its session plugin: the prompt → working, `permission.asked` or a
question → decision, V2's `session.execution.*` or V1's `session.idle` → done).
Antigravity and Muse have no approval event a probe could reach, so their
approval wait is still read off the screen. Each counts only the session the
tab is in and refuses a nested run of its CLI; the sections below say how.
Nothing tells the relay which CLI a tab runs: a tab is hook-driven from its
first `agent-turn` event, and one whose hook never fires stays on the byte
heuristic.

Claude's `decision` comes from `PermissionRequest` (Claude only, since
2026-11-10), the dialog opening: the notice alone came 6 s late, and never for
a dialog the user had pressed a key in (2.1.322). Answering retires the
verdict — a declined question fires no hook at all — except where the pane is
on screen: there `noteUserInput` keeps it while `dialogOnScreen` (the Reader's
reading of the live xterm) still finds a dialog, since a multi-question ask
pages through its questions under one request with no hook between, and
Claude's cell-diff repaints never put a whole dialog in the byte tail. Arrow,
Tab and page keys never retire it.

Every record in the slice is written by the agent's hook, and a fenced agent
can replace it with a FIFO, a link or a huge file. The host reads them all
(`<key>`, `.turn`, `.src`, `.mode`, `.prev`, on the watcher thread and at
spawn) through `home_io::read_record`: no link at the name, `O_NONBLOCK`, a
regular file, at most 64 KiB, else "no record" (threat model gap 29). One
FIFO used to stop turn state for every tab until restart.

For Claude the key is its launch id (`--session-id`); Codex mints its own id so
the key is a separate per-tab uuid and the backend injects
`codex resume <live-id>`. **Codex caveat:** user-level Codex hooks need a
one-time trust (`/hooks` in Codex) before they run; until then
`services::codex_bind` follows Codex's own rollout logs and writes the same
record. Gemini and the other "continue last" agents restore on their CLI's
continue flag, not a captured id.

Vibe 2.25 has `--resume <session-id>`. Tabtivity registers its hooks
(`VIBE_HOOK_TYPES`: `pre_agent`, `post_agent`, `post_tool`, `notification`,
`session_end`, one name each) in the user's `~/.vibe/hooks.toml` and in each
prepared local-model `VIBE_HOME` (rewritten to hold the app's hooks alone); at
each prompt (`pre_agent`, since 2026-11-16; before, only after a completed
turn) it records Vibe's current ID under the tab's `TABTIVITY_TAB_UID`, and the
turn state as in the table above. Vibe 3.1.2's TUI fires all seven of its
types, the "host" ones (`notification`, `session_start`, `session_end`)
included; `session_start` is left out because it fires before a session took
a prompt. Only the tab's own session counts: a subagent sets
`parent_session_id`, and a `vibe -p` run from the tab's bash tool runs its
hooks with `VIBE_SESSION=1` (set by Vibe for its tools' shells, never for its
own hooks) — before this guard such a run took the record over. A local tab
with a recorded, still-present session resumes
that exact ID (including after Vibe's in-app `/resume` or `/branch`). Existing
tabs without a record retain the prior `--continue` fallback. Remote Vibe tabs
also retain `--continue`, since no Tabtivity hook is installed on the host. Vibe's
session logging must be enabled for either flag. Fenced/container tabs receive
a per-project shadow of `hooks.toml`, like Claude/Codex hook config, so they can
record their live ID without editing the host hook registration.

Antigravity (`agy`) mints its conversation ids and resumes one with
`--conversation <id>`; `--continue` is the folder's newest, so two tabs of one
folder used to reopen the same chat. `services::antigravity_session` writes a
hook script to `<state_dir>/hooks/` and registers it under its own name in each
home's `.gemini/config/hooks.json` (format `{"<name>": {"<Event>": [{"type":
"command", "command": …}]}}`; Claude's shape does not parse, and a file that
does not parse runs none of its hooks, so an unparsable file is left alone).
It runs on `PreInvocation`, before every model call, and writes the call's
`conversationId` to `live_sessions/<uid>` — the record the Resume menu writes
too. `SessionStart` is no use: it fires at a new conversation's first prompt
only, not on `--conversation`, `--continue` or a resumed conversation's turns.
Only the tab's own conversation moves the record: `TABTIVITY_TAB_AGENT=agy`
(the resolver sets it); no `ANTIGRAVITY_AGENT`, which Antigravity sets for every
command its tools run, so an `agy -p` from the tab's shell tool (which fires
every hook with its own conversation and the tab's variables) is refused; and
not a subagent's call, which fires every hook with the subagent's id, no
`parentConversationId` and an empty `lastUserInput` (1.5.9; a set parent is
refused too). A subagent id that gets through anyway stands for its parent:
the resolver walks `conversation_summaries.parent_conversation_id` to the
folder's main conversation. The first record also leaves the proof
`agy-hook-ran` in the record directory. Registration is gated on the probed
version (1.5.2 and later, `HOOKS_SINCE`); an older or unknown one has the entry
taken out again. At each spawn where the hook is registered, a host-only launch
note `live_sessions/<uid>.agy` says how that launch began. A restored tab's
`--continue` then resolves by this table (`google_chat::tab_choice`):

| Launch note from an earlier spawn | Record names a main conversation of the folder | Launch |
| --- | --- | --- |
| yes | yes | `--conversation <id>`, whatever began since |
| no | yes | the Resume menu's pick, while the tab began none since |
| yes | no, and the scope has the proof | fresh (the tab never took a prompt) |
| otherwise | no | `--continue` |

The Reader follows the same choice (`google_chat::antigravity_tab`): the
recorded conversation where it is authoritative, nothing for a fresh tab, the
folder's newest otherwise; the Resume menu's This chat mark too. Fenced and
container tabs write into their scope's slice like every other hook. Remote,
local-model and assistant tabs are as before. Probed offline on 1.5.2–1.5.9
(`scripts/verify-cli/antigravity/hooks.py`); not run live.

Since the follow-up run (2026-11-16) the same script also writes the tab's
turn record and gives a new conversation the send hint, on three events
(`hooks.py turns` on 1.5.9, `format` on 1.5.2–1.5.9). Each event's command
names the event as the script's argument: 1.5.2 and 1.5.3 send no
`hookEventName`.

| Event | Fires | Writes |
| --- | --- | --- |
| `PreInvocation` | before every model call, also after each tool | the record, `working` |
| `Stop` | once per turn: `NO_TOOL_CALL`, `ERROR` (a failed model call), … | `done`, only for the recorded conversation |
| `SessionStart` | a new conversation's first prompt | prints the hint as an `injectSteps` system message (project tabs only) |

The same refusals hold for every event (`agy -p`, a subagent's empty
`lastUserInput`, another tab agent); a subagent fires its own `Stop` before
the parent's. Gaps the window covers itself: no event marks an approval wait
(`PreToolUse` fires before the prompt for every tool alike, so the screen
reading stays, as for Codex), and an Esc fires nothing, neither on an
approval nor on a running turn (the window takes the Esc as the interrupt).
Antigravity has no session-end event. The tool events take handlers only in a
`matcher` group (`{"matcher": "*", "hooks": […]}`); the first probes
registered them flat, which is why they seemed never to fire. Registration
replaces an entry an earlier spawn wrote (`PreInvocation` alone) whole.

OpenCode mints its own ids (`ses_…`) and has no session hook, and its old
`--continue` put every OpenCode tab of one folder into the same newest
session. `services::opencode_session` writes a plugin to
`<state_dir>/hooks/` and lists it (`file://`) in each home's
`.config/opencode/opencode.json` `plugin`; its `chat.message` hook records
the session each prompt goes to under the tab's `TABTIVITY_TAB_UID`
(`TABTIVITY_TAB_AGENT=opencode` only, a nested OpenCode claimed out, `task`
child sessions skipped). A restored tab with a recorded, still-present,
top-level session gets `--session <id>`; one noted at an earlier launch
(host-only `live_sessions/<uid>.opencode`) without a record never took a
prompt and starts fresh; a tab from before the plugin keeps `--continue`. The
Reader reads the same record (`opencode_store`), else the folder's newest
since the last fresh launch. Remote OpenCode tabs are as before.

A local-model OpenCode tab (`local_agent`, 2.x `mini`) resumes the same way
against its local-model home's store and record: it mints the key in every
scope, keeps its launch line (`localLaunch`) and restores on that line plus
the resume flag (`tabKinds.resumeArgsOf`), because `--model ollama/<m>` picks
both the provider and `mini`. A tab saved before it had a key mints one at
restore and goes through `--continue` once. Assistant chats stay out of
`resolve`: `assistant::launch_line` decides theirs.

OpenCode 2 uses the same plugin file with a default `{id, server, setup}`
entrypoint: recent V1 calls `server`, V2 registers a prompt hook in `setup`
and asks for the session's parent instead of tracking child creation events.
The config registration respects a native `plugins` list. Local host V2
launches use `--standalone` so the plugin's tab environment is not inherited
from a shared background service. The Reader adapts `session_v2` and
`session_message` on a read-only connection; no vendor data is migrated or
rewritten. This port has fixture coverage but has not been checked live.

The same plugin writes the tab's turn record, `live_sessions/<uid>.turn`
(2026-11-16; probed offline on 2.2.7 and 2.3.0 with
`scripts/verify-cli/opencode/hooks.py`, never live): `working` at each
prompt, `decision` when a permission or a question is asked, `working` when
it is answered, `done` when the run ends. V2 has no `session.idle`: a run
ends with `session.execution.succeeded`, `.failed` (a failed model call)
or `.interrupted` (a rejected permission), and a question is a `form`;
the plugin reads them from `ctx.event.subscribe()`. V1 gets the same words
from its `event` hook (`session.idle`, `session.status` idle,
`session.error`, `permission.*`, `question.*`), read from the 1.19.5
binary's strings and a node test of the plugin, never run. Only the session
the tab's record names moves the turn: a subagent's child session has its
own id, so neither its run nor a permission it asks for marks the tab (the
terminal-output reading still sees a dialog on screen). A turn is written
only after the tab's first prompt, since before it no session is the tab's.

The probe found the claim did not hold on V2: the shell tool's environment
is a per-session copy, not the plugin's `process.env`, so an `opencode run`
the agent started from its shell recorded its own session under the tab
(2.3.0). The plugin now puts the claim into each shell itself
(`ctx.shell.hook("create.before")`, which may edit `input.env`; V1's
`shell.env` hook too, though V1's shell already inherits `process.env`).

### Copilot: the turn from its own hooks

Copilot fires a hook for every edge of a turn, with the tab variables in
its environment and the event's `sessionId` first in every payload
(1.0.112, probed offline with `scripts/verify-cli/copilot/hooks.py`, never
live). `services::copilot_session` writes a script of its own,
`<state_dir>/hooks/<slug>_copilot_turn.sh` (PowerShell twin on Windows), and
lists it in each home's `.copilot/hooks/<slug>-turn.json` — Copilot loads
every file in that folder, so the file is Tabtivity's alone and rewritten
whole, and taken out for a Copilot older than the probed release
(`TURN_HOOKS_SINCE`). It writes `working` on `userPromptSubmitted`,
`postToolUse` and `postToolUseFailure`, `decision` on a `notification` of
type `permission_prompt` or `elicitation_dialog` (the dialog shown; the
earlier `permissionRequest` runs before the permission rules decide, so it
is not registered), `done` on `agentStop` and on an `errorOccurred` from a
model call (a failed call ends the turn without `agentStop`), `idle` on
`sessionEnd`. Gaps the probe showed: Esc on an approval ends the turn with
no hook at all, so the record keeps `decision` until the next prompt (the
window retires it on the keystroke); a model call Copilot retries fires
`errorOccurred` on every attempt, so the tab reads done while it retries.

Only the tab's own conversation moves it: `TAB_AGENT` must be `copilot`;
`COPILOT_AGENT_SESSION_ID`, which Copilot sets for the commands its tools
run, refuses a `copilot -p` the agent started from its shell (the hint's
session record now refuses it too — before, such a run's `sessionStart`
moved the tab onto its one-shot session); and the event's `sessionId` must
be the session the tab is pinned to — its record, which the hint's
`sessionStart` moves on `/new`, else its key. A subagent's prompt and stop
carry the subagent's own id; the session `/new` left behind ends after the
new one at `/exit`, and is refused.

### Muse: a hook that has to find its tab

`services::muse_session` (2026-11-16, plan `docs/done/agent_tab_resume_plan.md`
B; probed offline on 1.3.0 and 1.4.15, never live). Muse's settings take
Claude-shaped hooks from 1.3.0 on, so each home's
`.config/muse/settings.json` lists one script (`muse_session/hook.rs`) on
`UserPromptSubmit`, which writes the prompt's `session_id` to
`live_sessions/<uid>`, the record the Resume menu already wrote (and on the
turn events, below). Why it is built the way it is:

- **The prompt, not the start.** No hook fires before a session's first
  prompt, so a launch that never took one records nothing and is not the
  tab's (decision 5). `/clear` starts a new id, recorded at its first prompt;
  `/fork` leaves the tab in its source session and fires nothing; the
  memory-reminder subagents fire only `Subagent*` events.
- **The tab is read from the parent.** Muse runs hooks with an allow-listed
  environment, so `TABTIVITY_TAB_UID` never reaches the script, and the
  settings have no way to pass it (an `env` field gets the handler skipped).
  The script takes the variables from the nearest ancestor that has them —
  the Muse that fired it — through `/proc/<pid>/environ`, or `ps -E` without
  `/proc` (macOS, unverified). Windows has no unprivileged way, so nothing is
  registered there and its tabs keep folder's latest (decision 9).
- **Only the tab's own Muse.** `TAB_AGENT` must be `muse`; a Muse carrying
  `MUSE_SESSION_ID` was started by a Muse tool (1.4.15 sets it for its tools'
  processes); and since 1.3.0 sets nothing, a Muse with a same-named Muse
  above it among the processes carrying the tab's key is refused too.
- **Never break a launch.** Muse exits on a settings file it cannot read,
  so the merge touches only plain JSON with `schema_version` 1 (a new file
  gets it), leaves a `hooks` of another shape alone, writes atomically, and
  runs only for a Muse the version probe found at 1.3.0 or later.
- **Notes and proof.** Each spawn with the hook registered writes the
  host-only `live_sessions/<uid>.muse`; the script leaves `muse.hook` in its
  record folder. `resolve` follows the plan's table: noted and a record of the
  folder's session → `resume <id>`; noted, no record and the proof → fresh;
  otherwise today's rules. The Reader reads a noted tab's record first, so two
  tabs of one folder no longer show the newer one's chat.
- `resume --last` skips sessions that took no prompt and exits when only
  such are left, so the fallback keeps it only where a prompted session
  exists.

**Turn state and the hint** (follow-up run, 2026-11-16; `turns.py`, 1.3.0
and 1.4.15). One command, every event in `hook::EVENTS`:

| Event | Fires | Writes |
| --- | --- | --- |
| `UserPromptSubmit` | a prompt into the session | the record, `working` |
| `Stop` | the turn's answer is in, before the reminder subagents' "Double checking" (input typed then is queued) | `done` |
| `Interrupt` (1.4.15, `async: true` or Muse refuses the handler; 1.3.0 warns of an unknown event) | an Esc on a running turn | `done` |
| `SessionEnd` | `/exit`, Ctrl+C, and `/clear` too (all `reason: other`) | `idle` |
| `SessionStart` | with a session's first prompt, not at launch (`source` startup / resume / clear) | prints the hint as `additionalContext`, which Muse keeps as a developer context block |

- **Only the main session.** 1.4.15 puts `MUSE_SESSION_ID` in the hook's
  environment; a subagent's events carry the subagent's `session_id`, so an
  event of another session is dropped. `Stop`, `Interrupt` and `SessionEnd`
  move the turn record only for the session recorded. The nested-run checks
  above apply to every event.
- **No Undo-clear records.** `SessionStart(clear)` comes with the new
  session's first prompt, the moment that prompt withdraws the undo, so a
  `.src` written then would offer it only to take it back. The typed `/clear`
  already offers it, and until that prompt the record still names the
  cleared session, so the undo's relaunch resumes it. No `.src`, `.prev` or
  mode is written.
- **Not reached offline** (the echo provider calls no tool and never fails),
  so not registered: `PermissionRequest`, `Notification`, `StopFailure`. A
  `!` shell escape fires `PreToolUse` / `ToolUseStart` (`post_stop: true`
  after a turn) / `PostToolUse` or `PostToolUseFailure` and no `Stop`, so
  the tool events would light a tab at rest; they are left out.
  `/compact` fired nothing with echo.

### The phone send hint

An accepted Claude or Codex `SessionStart` prints a one-line
`tabtivity-send <file>` hint when `TABTIVITY_PROJECT_DIR` is set. The existing
continuity check runs first, so a nested startup cannot print it; `Stop` never
prints it. Both CLIs add SessionStart stdout to context. The PowerShell hook
mirrors it. The hint lives here, not in the project scaffold's `AGENTS.md`:
that file is the user's, committed and never rewritten, so Tabtivity runtime text
in it froze in every project and reached collaborators' agents where the
command doesn't exist.

The other CLIs get the same line from `services::agent_hint`: a SessionStart
hook where the CLI has one that feeds the model (Gemini, Qwen, Auggie,
CodeBuddy, Droid, Cursor, Copilot — one script in `<state_dir>/hooks/`, one
output shape per CLI, silent outside a Tabtivity project tab). Vibe and
OpenCode have no such hook: Vibe gets a marker-delimited block in its
user-level `AGENTS.md`, OpenCode a hint file in its `opencode.json`
`instructions` — not its user-level `AGENTS.md`, which would replace the
`~/.claude/CLAUDE.md` fallback carrying the user's global instructions. All of
it is written into the agent home at each spawn, after the global layer. CLIs with neither (Aider, Goose, Crush, …) get no
hint. See the third-party update checklist.

The CLIs that load user skills from their home also get a `tabtivity-send`
skill (`agent_hint::write_skill_in_home`, 2026-11-08): `SKILL.md` in
`.claude/skills` (Claude, OpenCode), `.codex/skills`, `.copilot/skills` and
`.gemini/config/skills` (Antigravity 1.5.16, run offline 2026-11-24),
rewritten at each spawn after the global layer, never in the assistant's or
the probe's home. It carries the whole contract (piped `-n`, `--clear`,
limits, exit codes) and is a slash command (`/tabtivity-send <file>`). The
shared `.agents/skills` is left out: OpenCode, Codex, Copilot and Antigravity all read it
beside their own and would list the skill twice. The one-line hint stays,
since a skill loads only when the model matches its description.

### Where Codex keeps a session, and why resume died

Codex 0.154 also exclusively locks a conversation while its writer is alive.
The hook-free binder used to freeze its claimed-session set at the beginning
of a poll, then give every fresh tab in the same cwd the same oldest rollout.
On restart one resumed and the others reported "This conversation is open in
another app". Claims now accumulate during the pass, with hook records reserved
before heuristic assignments. Spawn-time reservations also catch old duplicate
records: the first tab resumes the recorded conversation, and another tab with
that target opens `codex resume`'s picker to recover its intended conversation.
Reservations are released on failed spawns and PTY exit, including when hooks
are trusted and the fallback binder is disabled. Codex's locks and history are
never edited. An isolated offline check on 0.154 confirmed that a live writer
blocks resume and SIGKILL releases the lock; stale lock files alone do not.

The resume arg is emitted only when Codex still *has* the recorded
conversation, and that question has two answers in the field:

- the **rollout log** at
  `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, which is what
  older releases wrote and Codex 0.160.1 writes again;
- the **thread store** `~/.codex/state_<n>.sqlite`, where 0.153.4 could keep a
  thread without writing its named rollout. Its archive flag is authoritative:
  a retained rollout cannot make an archived conversation resumable.

Asking only the first is how Codex resume failed silently: the hook kept
recording live thread ids, the walk kept finding no file for any of them, and
every Codex tab relaunched as a **brand-new session** — which is also why the
folder-trust question came back on every Tabtivity restart, since a fresh Codex
start in an untrusted cwd is exactly what asks it. `codex_session_exists` now
takes either answer, and `services::codex_store` reads the store (read-only,
best-effort: a renamed file, table or column yields "no", never an error). The
store lives in the scope's agent home beside the rollout directory (see below).

The *other* half of the repeated question was the folder-trust answer: a fresh
Codex start in an untrusted cwd asks it. Codex now runs in the scope's own agent
home (`<state_dir>/agent-homes/<scope>`, `services::agent_home`), where its
`config.toml` and the `[projects."<path>"] trust_level` Codex records there
persist like any other home file, so the answer sticks; `agent_home` seeds the
trust entry for the tab's folder and never writes the user's own `~/.codex`.

Codex's SQLite files are different from ordinary agent-state entries. SQLite
replaces its `-wal`/`-shm` sidecars, so bind-mounting `state_<n>.sqlite` and its
siblings one file at a time pins old inodes and the thread row can vanish
(Codex 0.154 then fails `codex resume <id>` with `list_turns is not
supported yet`). The agent home avoids that: the fence mounts the whole home
directory, so Codex creates and rotates every database and sidecar normally.
A scope's earlier per-scope `<state_dir>/codex-state/<key>` store is imported
into its home once, at seeding (`agent_home`'s `SEEDED_MARKER`).

## Only the tab's own session may move the record

Every process under the tab inherits `TABTIVITY_TAB_UID`, so a nested CLI fires
the hook too — the tab's Claude running `claude -p …` through its own shell
tool does (verified live: a one-shot headless run overwrote both the id and the
mode record, so the next relaunch would have resumed a dead session in the
wrong mode). The script therefore applies a continuity rule, keyed by a second
env var the resolver sets, `TABTIVITY_TAB_AGENT`:

- **Claude** (`claude`, and the default when the marker is missing): a Claude
  tab's session id *is* its launch key, stays that id until `/clear` or
  `/resume` rolls it, and `Stop` never introduces an id. So a session id that is
  neither the key nor the current record is accepted only from a `SessionStart`
  whose `source` is `clear` or `resume`; a nested `-p` run's `startup` and its
  `Stop` are refused, and the mode is written only alongside an accepted id.
  One `startup` is let through: Claude 2.1.282 relaunches itself to switch
  its renderer (the fullscreen upsell dialog, `/tui`) or to update, and a
  session that has no transcript yet comes back under a fresh id with
  `--session-id` dropped. Before this exception the record stayed on a launch
  id that never wrote a file, so the phone's Reader showed an empty session
  and the tab's turn state never lit (2026-09-25). The tab's own session is
  the one whose transcript is missing beside the new one, so a plain start
  is followed exactly when `<transcript dir>/<current record>.jsonl` does not
  exist; a CLI nested under the tab was started by a session that has been
  prompted, whose file is there.
- **Codex** (`codex`): Codex mints its ids, so its record is free-form — except
  that a Claude fired inside a Codex tab is refused outright (`CLAUDECODE` is
  set by Claude for its children, never by Codex). The rollout binder also
  adopts a hook-written id only when Codex actually has a rollout for it.

Both scripts (POSIX `sh`, PowerShell) implement the same rule; the POSIX one is
run for real by a unit test.

## Where the agent runs on restore

`loadFromLayout` resets an agent tab's cwd to the scope root — a saved cwd is
stale after a project move — except for cwds the scope *derives*: a linked
worktree under the root (`<root>/.tabtivity/worktrees/<name>`) and, for a box
scope, a member project's root (or a worktree under one), which is where the
"+" menu's per-member Claude tab is deliberately started. `restoredAgentCwd`
in `src/lib/agents/agentWorktrees.ts` is the rule; the box restore passes its member
roots as `agentRoots`. (On the current Claude CLI `--resume <id>` finds a
session from any cwd — verified live — so the cwd decides where the agent
*works*, not whether the conversation comes back.)

## Stopped tabs

Plan: `docs/done/agent_tab_stop_plan.md` (decisions at its end). A **stopped**
agent tab keeps its place, label and conversation; its process is ended and it
respawns on its restore args (`resumeArgsOf`) when shown. The same resume a
restart does, per tab. `TabEntry.stopped` is runtime only; `lastUsedAt` is
saved, so a relaunch ranks which tabs come back running.

- **Who decides**: `components/layout/AgentTabStopHost` sweeps every 60 s
  (30 s under memory pressure) with the pure policy in
  `lib/agents/agentTabStop` (guards, LRU ranking, `pickStops`); the three
  triggers are settings (`stop_agent_tabs_cap` 30, `_idle_min` 120,
  `_min_free_mb` 4096; `0` = off). No trigger takes a tab used (shown,
  prompted, a turn) or spawned/woken within 10 min: the cap counts every live
  agent tab, stoppable or not, so without that floor a cap filled by Gemini
  tabs took a tab used a minute ago, and low memory had none at all.
- **Stop** (`stores/agents/agentTabStop.stopAgentTab`): every guard read again,
  `stopped` set (the pane unmounts → `pty_kill`; a sleeping pane's parked PTY
  is killed by `PaneSlot`), then the tab's own minted tmux session ended
  (`local_tmux_kill`, never an attach).
- **Wake**: shown (`PaneSlot`, also popout/console/dock), a due scheduled
  prompt (`AgentScheduleHost`, delivered on a later tick), the phone opening it
  (`wrapAgentTabForPhone`), steering typing into it. The wake waits for the
  stop's tmux kill so `new-session -A` never lands on the dying session.
- **Only CLIs that resume an id.** Claude and Codex, and Antigravity, Vibe,
  OpenCode, Copilot and Muse only while `agent_tab_resume_pinned`
  (`services::agent_resume_pinned`) says a respawn resumes the tab's *own*
  recorded conversation — each arm reads what that CLI's resolver above reads
  and writes nothing. Without a record those fall back to the folder's latest,
  which can be another tab's. `--continue`/`latest` CLIs (Gemini, Cursor,
  Grok, Qwen, Droid), custom agents, local-model, remote, container/VM,
  root/Tabby, Host-session, sign-in and attach tabs are never stopped. For
  Claude the check is strict: a live record with no log yet (a fresh `/clear`)
  would resume the cleared conversation, so it is not pinned.
- **Restore**: with the cap on, `loadFromLayout` brings every statically
  stoppable tab back stopped (the rule is registered by the stop store, so the
  tabs store does not import projects); once the launch's restore settles the
  host wakes those whose tmux session survived a crash
  (`local_tmux_app_sessions`), then the most recently used up to the cap.
- **Not knowable cheaply, approximated**: a phone attached (a `tab_seen` /
  `tab_input` within 15 min blocks); a pending push/release card (not guarded:
  the request lives in the backend and the agent polls it); Codex/other
  subagents (only Claude's transcript counts them).

## Reusing a session id is fatal

`claude --session-id <id>` for an id that already has a transcript exits with
"Session ID … is already in use" (verified live). The resolver only downgrades a
`--resume` to `--session-id <launch>` when it can find no log for the id, so
every place a log can be has to be probed:

- `<state_dir>/agent-homes/<scope>/.claude/projects/*/<id>.jsonl`
  (`claude_projects_roots`; the assistant scope also its `.local` home). Every
  local tab's Claude runs with that home as `$HOME`, so this is the one place
  its transcript lands; a scope's first seeding copied the transcripts it had
  under the user's `~/.claude/projects` (`services::agent_home`). Startup
  wipes the throwaway per-scope stage (`sandbox::clear_stage`) **synchronously,
  before the window can restore anything**, so no fenced spawn races it;
- a **remote** tab's Claude runs on the far host, where no hook is installed
  and the local probe sees nothing. The remote command therefore decides on the
  host (`ssh_exec::host_side_resume`): a transcript named after the id under
  any project dir there means `--resume`, else the fresh `--session-id`. A
  `/clear` on the host is not followed (the launch id is what comes back), no
  mode is re-applied, and a remote Codex tab has no resume path at all beyond
  its surviving tmux session. Its Reader/Focus chat and its card's prompt
  lines and model tag read off the host (`services::remote_transcript`, a
  local copy grown over the pooled SFTP session; `remoteHost` on
  `agent_tab_transcript` and the three tail reads). Which file is not the
  launch id's by assumption: the host's `~/.claude/sessions/<pid>.json` whose
  `/proc/<pid>/environ` carries the tab's `TAB_UID` names the session the CLI
  is on now, so a `/clear`, a self-relaunch under a fresh id and a tab moved
  from here (it runs on its local run's id) are followed. With no running CLI
  to ask, the locally recorded live id's file, then the launch id's. Its
  subagents open too: the session's `subagents/` folder is copied beside the
  local copy — every `.meta.json` with each read (what gives a spawn's card
  its handle), a subagent's own file or a `Workflow` run's journal only when
  it is opened — and emptied when the copied session changes. A host
  tab of any other CLI has no chat.

## Continuing in a new session (same CLI or another)

Code: `agent/agent_cli_handoff.rs` (backend), `CliHandoffDialog.tsx` +
`CliHandoffMenuItem.tsx` + `lib/agents/cliHandoff.ts` (frontend); plan and
history in `docs/done/cli_session_handoff_plan.md` and, for the same-CLI
target and the summary prompt, `docs/session_memory_handoff_plan.md`.

- Why the same CLI: a fresh session starting from the chat text (no tool
  output) carries a far smaller context than the resumed one. The tab menu
  preselects the source's own CLI; a limit notice offers only the others (a
  fresh session of the limited CLI hits the same limit).
- The summary prompt: only while the source's prompt cache has 2+ minutes left
  (`PromptCache` in the preview; asked cold it would re-read the whole
  conversation at full price) and never from a limit notice (a limited session
  cannot answer). It is a chat answer, not a file the agent writes (a write
  outside the project would stall on the CLI's permission prompt). The prompt
  carries `[handoff-summary <nonce>]`; the backend takes the answers after that
  prompt, drops both from the recent conversation (budget then 16 KiB) and heads
  the section as the previous agent's unchecked claims. No answer within 3 min,
  or Continue without it: the chat text alone. Rejected after measuring: a
  memory kept current every turn (+7–20% on every long session), a local-model
  summary (minutes on the iGPU, loses exact detail), an automatic summary before
  the cache expires (1 h lifetime: nearly always wasted).

- The dialog opens from a limit notice (`TerminalLimitHandoff`) or the tab
  menu. Both start a *new* tab on the chosen CLI through `newAgentTabForDraft`,
  so it is resumable (`TAB_UID`, session id) like any "+" menu tab. The source
  tab is never stopped or touched; the menu row is disabled only while an agent
  turn runs.
- The context travels as a file, not as typed text: `HANDOFF.md` in the
  successor's agent home, `~/handoff/cli-<id>/` (the target's CLI shares the
  scope's `agent-homes/<scope>`, so the path is the same fenced mount). The
  first input is a short prompt naming that path.
- The backend reads the transcript (`agent_cli_handoff_prepare` takes the
  Reader's tab identity, never conversation text from the renderer or phone). No
  summarizer runs; the file holds the first request, the newest turns that fit a
  budget, the previous agent's cockpit notes (claims, with times) and
  `git status`, plus the source's own summary when one was asked for.
  Everything agent- or project-written is quoted in a fence.
- Local tabs only: remote-host tabs, remote projects, reserved scopes (the
  assistant) and CLIs whose transcript is not read are refused with the
  `unsupported` code.
- Old files are pruned only by ids the ledger recorded; nothing else in the
  shared `handoff/` folder (byte-sync's `conflicts-*`) is ever deleted.
