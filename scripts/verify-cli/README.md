# verify-cli — run a wrapped CLI outside the app

Tools for re-verifying a new version of an agent CLI (or any TUI the app
wraps) against what the app assumes of it. What to check per CLI is
`docs/third_party_update_checklist.md`; this folder is *how* to run the
binary for those checks without a window: a private tmux server
(`tmux -L`), a scratch HOME, the tab-identity variables unset, stub model
servers on loopback. The user's own install, config and live tabs are never
touched. Linux, apart from the headless tools below, which also run on
Windows under Git Bash (no tmux there): `flags.sh`, `claude/hooks.sh`,
`cmp.py`, `meta.py`, `sedcheck.py`, `pscheck.py` and `turn_hooks.py`'s
cases without `tui_` (set `PYTHONUTF8=1`).

Outputs and baselines go to `tmp/verify-cli/<cli>/<label>/` (gitignored;
`VERIFY_OUT` overrides). `<label>` is the version under test. Run the old
and the new version through the same probe, then compare the two labels.

## Generic: any CLI

| Tool | What it gives |
|------|---------------|
| `flags.sh <cli> <label> <bin> [sub ...]` | `--version`, `--help`, each subcommand's `--help` → `flags/`; `diff -ru` two labels' `flags/` to see flags that moved. |
| `tui.py <cli> <label> <name> [--step …] -- <bin> [args]` | Drives the TUI with steps (`sleep:`, `wait:TEXT[:SECS]`, `cap:`, `key:`, `type:`, `enter:`, `size:COLSxROWS`) and saves frames as `<name>/<frame>@<cols>x<rows>.esc`. `--home DIR` reuses a home (resume tests); `--env K=V`; `--stub openai\|gemini --port N` starts a stub. Default steps: one frame each at 120, 60 and 42 columns. |
| `stub_openai.py <port> <log>` | OpenAI-compatible streaming model at `http://127.0.0.1:<port>/v1` (chat completions and `/v1/responses`) plus MCP at `/mcp/web` and `/mcp/help`. A prompt `STUB:CALL <tool> <json>` makes it call that tool, `STUB:SEQ a {…} ;; b {…}` several, `STUB:FAIL <status>` answers that HTTP status (400 is not retried, 500 is); a Responses tool inside a namespace is `<namespace>.<tool>` (Codex's `multi_agent_v1.spawn_agent`; the GPT-6 family's `functions` namespace is plain names). It logs every request (offered tools, tool results; a chat completion also its `model` and every `STUBMARK-<WORD>` it carries), so you can force calls no real model would make. |
| `hookdump.py <log> <event>` | A hook command that appends its event, pid, environment names (and the tab, Copilot and hook-depth values) and stdin payload to a JSONL log. Register it for every event to see which fire, with what. |
| `stub_anthropic.py <port> <log>` | Anthropic Messages API (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`), streaming or not. `STUB:CALL`/`STUB:SEQ` as above (only in a request that offers tools), `STUB:ERR <status> <type>` answers that API error. Lets Claude run with no login and no paid turn. |
| `stub_gemini.py <port> <log>` | Gemini streaming endpoint (`GOOGLE_GEMINI_BASE_URL`), answers `stub answer done`. A prompt `STUB:CALL <tool> <json>` anywhere in the current user turn (agy's `-p`
adds a system message after the prompt) makes it call that tool once first, `STUB:FAIL` answers HTTP 500, `STUB:SLOW <secs>` waits first. Each request's log line lists the tools offered and every `STUBMARK-<WORD>` the request carries (what a hook injected). |
| `parsers/frames.probe.ts` | Replays every frame of two labels through the app's own readers (Reader live view, model pickers, decision lamp, cold-resume dialog, Antigravity picker/effort, phone sign-in) and lists the frames and fields that read differently. See below. |

Replay two labels:

```sh
VERIFY_CLI=<cli> VERIFY_OLD=<old> VERIFY_NEW=<new> [VERIFY_AGENT=<label the readers get>] \
  node_modules/.bin/vitest run --config scripts/verify-cli/parsers/vitest.config.mts
```

Run it from the repo root. It writes `tmp/verify-cli/<cli>/parsers-<old>-vs-<new>.json`
and prints `frame: fields`. A frame that differs only in `live.screen` (the
raw text) or `live.context` changed its wording, not what a reader decides.
A difference in `question`, `decisionLamp`, a picker or `signIn` needs a
look at both frames. jsdom's "HTMLCanvasElement's getContext()" line is noise.
The `*.probe.ts` name keeps it out of `npm test`.

## Per CLI: deeper probes

The CLIs coupled most deeply have their own scripts. Each one's docstring
gives its usage.

- **Claude** (`claude/`): `hooks.sh <label> <bin>` makes four `-p` turns
  plus `/usage` and dumps every hook payload. `prompt.py <label> <bin> [cols…]`
  holds the permission prompt at four widths, and at each extra `cols` for
  where a long option wraps. `cmp.py <old> <new>` compares
  hook events and keys. `sedcheck.py <label>…` runs the session hook's own
  `sed` extractions, read live from `agent_session.rs`, against each
  payload; on Windows its `transcript_path` reads differ by design, and
  `pscheck.py <label>…` checks the hook that runs there instead (the
  PowerShell twin's `[regex]::Match` reads). `meta.py <label>…` lists the transcript record types and
  permission modes. `esc_early.py <label> <bin> [queued|alone|pull]` holds a
  turn unanswered with a sleeping hook and presses Esc (or ↑) on it, for
  where the prompt goes. `send_now.py <label> <bin>
  early|tool|typed|stream esc|chord|chord1` lands Esc or Claude's Ctrl+X
  Ctrl+S on a held, tool-running, typed or streaming turn, for whether the
  queue goes at once and what the turn keeps (Send now).
  `chat_send.py <label> <bin> [case…]` types prompts
  with the Chat's and the phone's exact writes (`agentInputWrites` and its
  pacing) — fresh, idle, two-line, long, while busy — and reads
  `UserPromptSubmit` for whether each Enter submitted. `model.py <label> <bin>
  [expand]` walks the `/model` picker at 120×40 and 80×24 with arrows and
  Esc only (no turn); `expand` opens the folded `More models` row first. These need the login
  and make small paid haiku turns. `login.sh <label> <bin>` needs none: it
  draws `claude auth login`'s sign-in link in a scratch HOME at 120, 80 and 42
  columns for the frame replay's `signIn` (2.1.330 shortened the link).
  Binaries come from the agent install's `.local/share/claude/versions/<v>`.
  `turn_hooks.py <label> <bin> <port> [case…]` needs no login: a scratch
  HOME, `stub_anthropic.py`, a dumping hook on every turn-relevant event. It
  answers which event ends or opens a turn — an API error (`StopFailure`, no
  `Stop`), a failed tool (`PostToolUseFailure`), an Esc on a running tool, a
  permission dialog declined, an MCP elicitation (a stdio server inside the
  script), a subagent, `/compact`, a `cd`, auto mode's classifier, an
  `AskUserQuestion` answered page by page or declined (`tui_ask`,
  `tui_ask_esc`: payloads plus `timing.json`, i.e. hook vs transcript vs
  screen). Its
  scratch work dir sits under the repo, so the TUI cases answer the repo
  `CLAUDE.md`'s external-imports question with its default.
- **OpenCode** (`opencode/`): `round.sh <label> <bin> <port>` runs the whole
  set below except `db.py` for one binary into `probe-<label>.log` (eight
  ports from `<port>`); run old and new at once, ports 100 apart, and diff the
  logs. `turns.py <label> <bin> <port> full|mini [ask|allow|deny]`
  forces tool calls through the stub in a tab-like home. The session plugin
  is rebuilt from `opencode_session.rs` on every run. `hooks.py
  events|turn <label> <bin> <port>` lists a dumping plugin beside it (every
  bus event, the V1 hooks, V2's `session`/`tool`/`shell` hooks) and walks a
  prompt, an approval allowed and rejected, a failing tool, a failed model
  call, a question, a subagent and an `opencode run` from the shell tool;
  `turn` checks the word the plugin leaves in `<uid>.turn` after each and
  that the nested run moves neither record. A label `1.*` is run as 1.x
  (`plugin` entry file, `bash`, `task`). `tabby.py` checks the
  assistant's tool pin, read from `assistant.rs`. `resume.py` covers
  `--session`, `--continue` and the warm-up `run`. `db.py` reads the session
  database. `remote_store.py <label> <bin> <port> [turns]` runs one tab-like
  OpenCode with no plugin, as on a remote host, and prints what the host-side
  reader (`remote_transcript/opencode.rs`) relies on: the processes carrying the
  launch id and the one holding the db, its start on the host clock against the
  session's `time_created`, the WAL's restarts and valid frames per turn (its
  file size is not its length), and db+WAL snapshots taken mid-turn. While it runs,
  `VERIFY_OPENCODE_HOME=<its home> cargo test -p tabtivity --lib
  verify_cli_follows_a_live_store -- --ignored --nocapture` follows it with the
  app's snapshot code. The app's own store reader runs over a run's database with
  `VERIFY_OPENCODE_DB=<home>/.local/share/opencode/opencode.db
  VERIFY_OPENCODE_DIR=<home>/work VERIFY_OPENCODE_SESSION=<live record>
  cargo test -p tabtivity --no-default-features --lib verify_cli_reads_a_captured_store -- --ignored --nocapture`
  (entries, the subagent through its handle, completed changes). Get a binary without installing it:
  `npm pack @opencode/cli-linux-x64@<v>`, unpack, `package/bin/opencode`.
- **Antigravity** (`antigravity/`): `main.py <label> <bin> <port> [cols]`
  covers first run, `/model`, `/effort`, turns, a second `--continue`,
  resume flags and `agy models`. `second.py` checks two windows on one
  conversation. `signin.py <label> <bin> <cols> <rows>` reaches the sign-in
  link at a width. Copy `<bin>` into a directory you made read-only first:
  agy updates itself in place. On Windows a read-only flag does not stop
  it: run every probe with `AGY_CLI_DISABLE_AUTO_UPDATE=1` and check the
  copy's sha512 after. `store.py <label> [<label>…]` reads `main.py`'s
  home the way the phone Chat does (`google_chat`'s queries and protobuf
  fields) and prints the schema statements that differ between labels.
  `hooks.py events|turns|tabs|format <label> <bin> <port>` registers the
  app's conversation hook (rebuilt from `antigravity_session/hook.sh`, its
  hint a stub mark) beside a dumping hook of every event, with made-up tab
  variables, and prints the session and turn records it writes: `events`
  walks a turn, an `agy -p` from the shell tool, a subagent, `/clear` and
  relaunches; `turns` (permission prompts on) a turn, an approval answered
  and one refused, a failed and a cancelled turn, and which hook injections
  reached the model; `tabs` two tabs in one folder, each back on its own
  conversation; `format` whether a release runs the hook and sets
  `ANTIGRAVITY_AGENT` for tool commands (run it on every baseline).
  `stub_gemini.py` forces the tool calls (`STUB:CALL <tool> <json>`).
  `queued.py <label> <bin> <port> <cols> [rows]` holds a turn, queues two
  prompts behind it and opens `/model` over them (`busy`, `queued`,
  `queued_model`), for the phone's footer read beside `Press up to edit queued
  messages`; run it at 44 and 56 columns.
  `remote.py <label> <bin> <port>` reads one tab's and a second tab's store
  the way the remote-host Chat can (over SFTP: `/proc`, never a command): the
  processes carrying the tab's launch id, the `presence/<id>.lock` they hold,
  the database and WAL across turns, a copy taken while a turn writes, the WAL
  salts across a checkpoint, a subagent and `/clear`.
  A pinned build: the updater manifest (`agent_latest::Source::Manifest`)
  names the tarball and its sha512.
- **Codex** (`codex/`): `writer_lock.py <label> <bin> [model]` opens a
  thread on the local Ollama, resumes it in a second window (it must show the
  lock screen), SIGKILLs the first and resumes again (it must open). Beyond
  that, `screens.sh <label> <bin> [model]` walks the trust question, idle,
  both `/model` steps and Shift+Tab's `Plan mode` (100 and 60 columns) for
  `frames.probe.ts`. Then use
  `C2_PROBE_CODEX=<bin> cargo test -p tabtivity --lib codex_parses_the_local_catalog -- --ignored`
  (checklist §1.2) plus `flags.sh` and `tui.py`. Binaries come from the agent
  install's `.codex/packages/standalone/releases/<v>-<triple>/`.
  `turn_hooks.py <label> <bin> <port> [phase…]` runs Codex offline against
  the stub's `/v1/responses` (launch provider, `approval_policy =
  "on-request"`, the call asks `require_escalated`, which forces the approval
  dialog) with dumping hooks: `trusted` (today's events, trusted with
  `codex_hook_hash`'s formula), `added` (a new event appended: the "Hooks
  need review" screen, the new hook inert), `approve` (`PermissionRequest`
  at the dialog, after accept and Esc), `extras` (`spawn_agent`, `/compact`;
  `--dangerously-bypass-hook-trust`), `apierr` (a closed port), `usage`
  (`STUB:FAIL 429 usage_limit_reached`), `interrupt` (Esc on a `sleep 30`
  call); the last three also write the rollout's events
  (`rollout-events.txt`). Give the
  work folder its own `git init`, or the trust question offers to trust
  the enclosing repo.
  `rollout_fd.py <label> <bin> <port> [variant…]` checks what the remote-host
  Chat leans on: which process holds a thread's rollout open (`/proc/<pid>/fd`)
  and whose launch id its environment carries — two tabs on one `CODEX_HOME`,
  in-process (`--no-daemon`, `-c features.daemon_auto_start=false`) and under
  the shared app-server daemon, through a turn and `/new`.
  `async_question.py <label> <bin> <port> [model]` (same home, model
  `gpt-6.1-sol` by default: the GPT-6 family's tools, `request_user_input_async`
  and `clock.sleep` among them, ride as an `additional_tools` input item, which
  the stub reads) asks an async question while the turn works on, opens it
  (shift+←) and answers it; then one skipped (^]) and one left waiting as the
  turn ends. Frames, the rollout and the hook dumps land in `async_question/`.

- **Copilot** (`copilot/`): `screens.sh <label> <bin> [port]` walks the folder
  trust question, idle, a stub-forced `create` approval at 110 and 60 columns
  and the Esc after it, BYOK against `stub_openai.py`, for `frames.probe.ts`.
  `chat_send.py <label> <bin> [port] [case…]` sends prompts with the Chat's and
  the phone's exact writes (one bracketed paste, Enter 200 ms later) — fresh,
  idle, two-line, long, while a shell call runs — and reads the stub's request
  and `user.message` for whether each arrived word for word.
  `hooks.py events|turn <label> <bin> [port]` registers `hookdump.py` on
  every hook event and walks a session pinned with `--session-id`: a prompt,
  an approval answered and one Esc'd, a failing tool, failed model calls
  (400, and 500 for the retries), an `ask_user` form, a subagent, a
  `copilot -p` from the shell tool, `/compact`, `/new`, `/exit`. `turn` also
  registers the app's hooks (the ignored test
  `writes_the_copilot_hooks_for_a_probe`) and checks the tab's turn record
  after each step and that the nested run moves neither record. It sets
  made-up tab variables, which the hooks write only into the scratch home.
  The session store is `scripts/copilot-events-probe.py` (`COPILOT_BIN=<bin>`).
  `remote_store.py <label> <bin> [port] [case…]` is what a Copilot tab leaves
  on a remote host for the desktop Chat (`remote_transcript/copilot.rs`): the
  session folder and its `inuse.<pid>.lock`, `open-sessions-state.json`, the
  log only growing through `/compact` and `/new`, a nested `copilot -p`'s
  marker, the store with `COPILOT_HOME` unset and with `XDG_*` set, and a
  second launch on the same `--session-id` (cases `pinned`, `unpinned`,
  `homeonly`, `nested`, `resume`).
  Get a binary without installing it: `npm pack @github/copilot-linux-x64@<v>`,
  unpack, `package/copilot`.

- **Vibe** (`vibe/`): `turn_hooks.py <label> <bin> <port> [apierr]` gives
  a scratch `VIBE_HOME` a provider at `stub_openai.py` and a dumping hook of
  each of Vibe's hook types (seven; 3.1.3 adds `pre_llm` and `post_llm`, registered
  only for a binary that names 3.1.3 or later), with the hook's `VIBE*` environment, then
  plays a prompt, an approval accepted and one declined, `/clear`, a `vibe -p`
  from the bash tool and `/exit`. `apierr` points the provider at a closed
  port. The binary is the agent install's `.local/bin/vibe`.
  `resume.py <label> <bin> <port>` runs the app's own session hook (written
  by the ignored test `writes_the_vibe_hook_for_a_probe`, into a folder with
  a space in its name) with made-up tab keys: each tab's record, the unified
  store's `CURRENT`, `--resume <id>`, a nested `vibe -p`, `/clear`, the turn
  record, `VIBE_ACTIVE_MODEL` and the user-level `.vibe/AGENTS.md`.

- **Muse** (`muse/`): `resume.py <label> <bin>` writes the app's session
  hook (through the ignored test `writes_the_hook_for_a_probe`) into a scratch
  home and plays two tabs of one folder: each must record its own session and
  come back in it on `resume <id>`; a `muse exec` from a tab's `!` escape,
  another CLI's tab and a launch with no prompt must record nothing, and a
  `/clear` moves the record at its first prompt; it also checks the turn
  record and that the project tab's session log holds the send hint. It sets
  made-up tab keys, which the hook writes only into that home. `turns.py
  events <label> <bin>` registers a dumping hook on every event the binary
  names and prints, per step, which fired with which fields: a turn, a `!`
  shell escape, a `muse exec` from it, `/compact`, `/clear`, `/exit`, a
  `resume` with an Esc, Ctrl+C and a `!` under `--approval-mode untrusted`.
  `remote.py <label> <bin>` runs two tabs of one folder and prints what the
  remote-host Chat can read over SFTP (`/proc`, never a command): the
  processes carrying each tab's launch id, the `session.jsonl` they hold
  open (and across `/clear` and `resume <id>`), the log's `route_facts` pid,
  and the log's growth while a turn writes.
  `turns.py shared` checks one command on all the app's events. Fetch a binary from the public
  channel manifest (checklist §1.5, Meta Muse Code). Run the binary, not the
  launcher, and drive other checks with `tui.py … -- <bin> --provider echo`,
  which answers offline. Don't use its `meta` provider from a probe: with
  `--base-url` at the stub, one turn was still answered by something that
  wasn't the stub.

## Traps

- Never run a probe in an app tab or against the user's HOME config. The
  Claude probes are the one exception: they use the real login, read-only.
- Never `pkill -f` a pattern that appears in your own command line, because
  it kills the shell running it. Each probe closes its own tmux server.
- Pick a fresh port per concurrent run. Ports stay bound until the stub exits.
- Release assets from GitHub download slowly from here. npm tarballs are
  faster, but npm can ship a different layout (Codex's npm package lacks
  `codex-exec-server`).
