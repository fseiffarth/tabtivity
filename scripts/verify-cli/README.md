# verify-cli — run a wrapped CLI outside the app

Tools for re-verifying a new version of an agent CLI (or any TUI the app
wraps) against what the app assumes of it. What to check per CLI is
`docs/third_party_update_checklist.md`; this folder is *how* to run the
binary for those checks without a window: a private tmux server
(`tmux -L`), a scratch HOME, the tab-identity variables unset, stub model
servers on loopback. The user's own install, config and live tabs are never
touched. Linux only.

Outputs and baselines go to `tmp/verify-cli/<cli>/<label>/` (gitignored;
`VERIFY_OUT` overrides). `<label>` is the version under test. Run the old
and the new version through the same probe, then compare the two labels.

## Generic: any CLI

| Tool | What it gives |
|------|---------------|
| `flags.sh <cli> <label> <bin> [sub ...]` | `--version`, `--help`, each subcommand's `--help` → `flags/`; `diff -ru` two labels' `flags/` to see flags that moved. |
| `tui.py <cli> <label> <name> [--step …] -- <bin> [args]` | Drives the TUI with steps (`sleep:`, `wait:TEXT[:SECS]`, `cap:`, `key:`, `type:`, `enter:`, `size:COLSxROWS`) and saves frames as `<name>/<frame>@<cols>x<rows>.esc`. `--home DIR` reuses a home (resume tests); `--env K=V`; `--stub openai\|gemini --port N` starts a stub. Default steps: one frame each at 120, 60 and 42 columns. |
| `stub_openai.py <port> <log>` | OpenAI-compatible streaming model at `http://127.0.0.1:<port>/v1` (chat completions and `/v1/responses`) plus MCP at `/mcp/web` and `/mcp/help`. A prompt `STUB:CALL <tool> <json>` makes it call that tool, `STUB:SEQ a {…} ;; b {…}` several. It logs every request (offered tools, tool results), so you can force calls no real model would make. |
| `stub_gemini.py <port> <log>` | Gemini streaming endpoint (`GOOGLE_GEMINI_BASE_URL`), answers `stub answer done`. |
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
  plus `/usage` and dumps every hook payload. `prompt.py <label> <bin>`
  holds the permission prompt at four widths. `cmp.py <old> <new>` compares
  hook events and keys. `sedcheck.py <label>…` runs the session hook's own
  `sed` extractions, read live from `agent_session.rs`, against each
  payload. `meta.py <label>…` lists the transcript record types and
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
  and make small paid haiku turns.
  Binaries come from the agent install's `.local/share/claude/versions/<v>`.
- **OpenCode** (`opencode/`): `turns.py <label> <bin> <port> full|mini [ask|allow|deny]`
  forces tool calls through the stub in a tab-like home. The session plugin
  is rebuilt from `opencode_session.rs` on every run. `tabby.py` checks the
  assistant's tool pin, read from `assistant.rs`. `resume.py` covers
  `--session`, `--continue` and the warm-up `run`. `db.py` reads the session
  database. Get a binary without installing it:
  `npm pack @opencode/cli-linux-x64@<v>`, unpack, `package/bin/opencode`.
- **Antigravity** (`antigravity/`): `main.py <label> <bin> <port> [cols]`
  covers first run, `/model`, `/effort`, turns, a second `--continue`,
  resume flags and `agy models`. `second.py` checks two windows on one
  conversation. `signin.py <label> <bin> <cols> <rows>` reaches the sign-in
  link at a width. Copy `<bin>` into a directory you made read-only first:
  agy updates itself in place. `store.py <label> [<label>…]` reads `main.py`'s
  home the way the phone Chat does (`google_chat`'s queries and protobuf
  fields) and prints the schema statements that differ between labels.
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
  install's `.codex/packages/standalone/releases/<v>-<triple>/`. A
  Codex approval could now come from the stub's `/v1/responses` through a
  custom provider, but no round has tried it yet. Give the
  work folder its own `git init`, or the trust question offers to trust
  the enclosing repo.

- **Muse**: no script yet. Fetch a binary from the public channel manifest
  (checklist §1.5, Meta Muse Code). Run the binary, not the launcher, and drive
  it with `tui.py … -- <bin> --provider echo`, which answers offline. Don't
  use its `meta` provider from a probe: with `--base-url` at the stub, one
  turn was still answered by something that wasn't the stub.

## Traps

- Never run a probe in an app tab or against the user's HOME config. The
  Claude probes are the one exception: they use the real login, read-only.
- Never `pkill -f` a pattern that appears in your own command line, because
  it kills the shell running it. Each probe closes its own tmux server.
- Pick a fresh port per concurrent run. Ports stay bound until the stub exits.
- Release assets from GitHub download slowly from here. npm tarballs are
  faster, but npm can ship a different layout (Codex's npm package lacks
  `codex-exec-server`).
