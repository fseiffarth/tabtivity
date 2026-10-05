# Agent session persistence

Referenced from `AGENTS.md`.

The per-project tab layout (`tab_layout`/`tab_groups`) lives in
`<state_dir>/sessions/<id>/terminals.json` (see "Persistence" in `AGENTS.md`;
the copy inside a project folder is export-only). Shell/files tabs are always
restored on relaunch; agent tabs are normally dropped, **except resumable agent
tabs** — Claude and Codex tabs that carry a `sessionId` are persisted (with
their `sessionId`) and restored, respawning the agent so the prior conversation
comes back (see `isRestorableTab`/`RESUMABLE_AGENTS` in `src/stores/tabs.ts`).

## Mechanism

`services/agent_session.rs`, installed at startup: Tabtivity installs a
`SessionStart` hook — into `~/.claude/settings.json` (JSON) and
`~/.codex/config.toml` (TOML text-append) — that records each tab's live
`session_id` under `~/.local/share/tabtivity/live_sessions/<key>`, keyed by the
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
until then a Codex tab stays on the byte heuristic.

For Claude the key is its launch id (`--session-id`); Codex mints its own id so
the key is a separate per-tab uuid and the backend injects
`codex resume <live-id>`. **Codex caveat:** user-level Codex hooks need a
one-time trust (`/hooks` in Codex) before they run; until then
`services::codex_bind` follows Codex's own rollout logs and writes the same
record. Gemini and the other "continue last" agents restore on their CLI's
continue flag, not a captured id.

Vibe 2.25 has `--resume <session-id>`. Tabtivity registers a `post_agent` hook in
the user's `~/.vibe/hooks.toml` and in each prepared local-model `VIBE_HOME`;
after a completed turn it records Vibe's current ID under the tab's
`TABTIVITY_TAB_UID`. A local tab with a recorded, still-present session resumes
that exact ID (including after Vibe's in-app `/resume` or `/branch`). Existing
tabs without a record retain the prior `--continue` fallback. Remote Vibe tabs
also retain `--continue`, since no Tabtivity hook is installed on the host. Vibe's
session logging must be enabled for either flag. Fenced/container tabs receive
a per-project shadow of `hooks.toml`, like Claude/Codex hook config, so they can
record their live ID without editing the host hook registration.

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
  every release up to 0.153.4 wrote;
- the **thread store** `~/.codex/state_<n>.sqlite`, which is where 0.153.4 puts
  it instead. Rows there still *name* a `rollout_path`, but no such file is
  created any more — `~/.codex/sessions/` does not exist on a fresh install.

Asking only the first is how Codex resume failed silently: the hook kept
recording live thread ids, the walk kept finding no file for any of them, and
every Codex tab relaunched as a **brand-new session** — which is also why the
folder-trust question came back on every Tabtivity restart, since a fresh Codex
start in an untrusted cwd is exactly what asks it. `codex_session_exists` now
takes either answer, and `services::codex_store` reads the store (read-only,
best-effort: a renamed file, table or column yields "no", never an error). The
store needs the SQLite-aware scope mount described below; the rollout directory
continues through the ordinary per-entry rule.

The *other* half of the repeated question is the fence's config shadow.
`~/.codex/config.toml` is staged as a per-project throwaway copy so an agent
cannot repoint the host's SessionStart hook, and re-copying the host original at
every spawn threw away the `[projects."<path>"] trust_level` Codex had just
recorded there. `staged_config_mounts` now carries those tables — and only
those — across a restage, so the answer the user gave inside the fence sticks
while the rest of the file stays the host's, and nothing is ever written back to
the host.

Codex's SQLite files are different from ordinary agent-state entries. SQLite
replaces its `-wal`/`-shm` sidecars, so bind-mounting `state_<n>.sqlite` and its
siblings one file at a time pins old inodes: the rollout JSONL survives through
the mounted `sessions/` directory, but the thread row and paginated turn store
can disappear with the fence's tmpfs home. Codex 0.154 then discovers the
rollout on `codex resume <id>` but fails bootstrap with `list_turns is not
supported yet`. Linux-fenced and containerized tabs now mount a durable,
per-scope Codex state directory over `~/.codex`; safe host directories are
mounted beneath it, while `config.toml` remains shadowed. The state and thread
history databases are seeded once with consistent SQLite snapshots, and Codex
can thereafter create/rotate every database and sidecar normally. The directory
lives under `<state_dir>/codex-state/`, outside the startup-cleared sandbox
stage. macOS Seatbelt and unfenced native tabs continue to use the host store
directly because they do not substitute a tmpfs home.

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

## Reusing a session id is fatal

`claude --session-id <id>` for an id that already has a transcript exits with
"Session ID … is already in use" (verified live). The resolver only downgrades a
`--resume` to `--session-id <launch>` when it can find no log for the id, so
every place a log can be has to be probed:

- `~/.claude/projects/*/<id>.jsonl` — the ordinary case;
- the project's **sandbox stage** (`<state_dir>/sandbox-stage/<project>/
  claude-projects/`), where a fenced or contained agent writes a transcript for
  a cwd that had no host dir yet. It is harvested into `~/.claude/projects`
  when the tab goes away — and, for a crashed run, by
  `sandbox::harvest_and_clear_stage` at startup, which runs **synchronously
  before the window can restore anything** (it used to share the off-thread
  container sweep, racing the restored tabs);
- a **remote** tab's Claude runs on the far host, where no hook is installed
  and the local probe sees nothing. The remote command therefore decides on the
  host (`ssh_exec::host_side_resume`): a transcript named after the id under
  any project dir there means `--resume`, else the fresh `--session-id`. A
  `/clear` on the host is not followed (the launch id is what comes back), no
  mode is re-applied, and a remote Codex tab has no resume path at all beyond
  its surviving tmux session.
