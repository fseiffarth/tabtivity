# Claude's trace spans as a token source

Status: phase 1 built (experimental, off), never run live. Code:
`src-tauri/src/services/agent/claude_otel.rs` (+ `claude_otel/tests.rs`,
fixtures in `claude_otel_fixtures/`). Probe: `scripts/verify-cli/claude/otel.py`.
Token stats rationale: `docs/context/usage_stats.md`.

Claude Code 2.1.331 put `gen_ai.usage.*`, `gen_ai.response.model` and
`gen_ai.operation.name` on its `claude_code.llm_request` trace spans.
`gen_ai.usage.input_tokens` includes the prompt-cache tokens. The recap's Tokens
section reads transcripts today; the spans are a second, live source.

## What arrives (measured on 2.1.331, offline, stub model)

Run: `python3 scripts/verify-cli/claude/otel.py 2.1.331 <bin> <stub-port> <otlp-port>`.
The stub answered input 100, cache write 5, cache read 7, output 10.

**Turning it on** (the binary's own code, read from the embedded JS, and
confirmed by the probe):

| Variable | Value | Why |
|----------|-------|-----|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` | gates every exporter |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` (or `ENABLE_ENHANCED_TELEMETRY_BETA`) | `1` | traces need it; without it nothing is exported (probe case `nobeta`: zero requests) |
| `OTEL_TRACES_EXPORTER` | `otlp` | |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/json` | `http/protobuf` works too (body is `application/x-protobuf`) but needs a protobuf reader |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://127.0.0.1:<port>/v1/traces` | a per-signal endpoint is used as written, no path is added |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `Authorization=Bearer%20<token>` | values are percent-decoded: the receiver saw `Bearer <token>` |
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` | `none` | the app wants traces only |

`ENABLE_BETA_TRACING_DETAILED` / `BETA_TRACING_ENDPOINT` are Claude's other
tracing mode (not measured here): a user who has them keeps their setup, like
any `OTEL_*` variable. Exporter: `OTel-OTLP-Exporter-JavaScript/0.208.0`, no
compression by default, flushes at exit (the batch interval was not measured). With nothing listening the turn
printed nothing extra and finished ~1.7 s later (shutdown wait).

**Spans of one `-p` turn** (`claude_code.interaction` is the root):
`claude_code.interaction` > `claude_code.llm_request` (one per API request),
`claude_code.tool` > `claude_code.tool.blocked_on_user`,
`claude_code.tool.execution`. A subagent's `llm_request` hangs under the
parent's tool span.

**`claude_code.llm_request` attributes, verbatim** (proto3-JSON: an integer is
`{"intValue": "112"}`, a string `{"stringValue": ...}`):

```
gen_ai.usage.input_tokens            112   (= 100 fresh + 5 cache write + 7 cache read)
gen_ai.usage.output_tokens            10
gen_ai.usage.cache_read.input_tokens   7
gen_ai.usage.cache_write.input_tokens  5
gen_ai.response.model                 claude-stub   (set only when Claude's content-redaction check passes and the name looks like a model id; fall back to the request model)
gen_ai.request.model                  claude-stub
gen_ai.operation.name                 chat          (tool spans: execute_tool; interaction: invoke_agent)
gen_ai.system                         anthropic
gen_ai.provider.name                  anthropic
gen_ai.response.finish_reasons        ["end_turn"]
gen_ai.conversation.id                <session id>  (a subagent: its agent id)
session.id                            <session id>  (a subagent's span: the main session's)
agent_id                              only on a subagent's span
query_source_safe                     sdk | agent.builtin.general-purpose | ...
llm_request.context                   interaction | tool | standalone
input_tokens / cache_read_tokens / cache_creation_tokens / output_tokens
                                      the plain counts (input_tokens = fresh only)
model, speed, effort, attempt, success, stop_reason, ttft_ms, first_content_ms,
duration_ms, span.type, terminal.type, anthropic.provider,
anthropic.custom_base_url, user.id (a hash)
```

Span ids: `traceId`, `spanId`, `parentSpanId`, `startTimeUnixNano`,
`endTimeUnixNano` (strings). Resource: `service.name=claude-code`,
`service.version`, `os.type`, `os.version`, `host.arch`.

## Privacy: what the spans carry beyond counts

Default (nothing opted in; probe case `json`/`app`):

- `claude_code.interaction`: `user_prompt` is the literal `<REDACTED>` and
  `user_prompt_length` (a number) rides beside it.
- `claude_code.tool`: `tool_name`, `gen_ai.tool.name`, `tool_use_id`, and for
  Bash `bash_argv0` (the command's first word, e.g. `echo`) and
  `bash_command_class`. No tool input or output.
- `llm_request`: model, counts, session/agent ids, timings, the hashed
  `user.id`. No prompt, no answer.
- `os.version` / `host.arch` in the resource.

With the user's own `OTEL_LOG_USER_PROMPTS=1` etc. (probe case `content`) the
interaction span's `user_prompt` becomes the prompt text. The `llm_request` span
adds nothing in that case on 2.1.331 (the extra request/response attributes
come from `ENABLE_BETA_TRACING_DETAILED`, which switches this path off), but a
later release may.

**What Tabtivity keeps:** `parse_traces` reads only the `llm_request` span's
four counts, response/request model, session id, `agent_id` presence, span
ids and end time. Every other attribute and every other span is never
looked at, so no text of a prompt, an answer or a tool can enter the ledger
(a test runs the `content` capture through it and searches the ledger for
the prompt). Session ids are kept only if `[A-Za-z0-9_-]{1,80}`; `user.id`,
resource attributes and `bash_argv0` are dropped. The injected variables
never set an `OTEL_LOG_*` opt-in, and a launch where the user has any
telemetry variable of their own gets none of ours.

## Fence: is loopback reachable from a fenced tab?

Yes, by default. `agent_fence` only adds `--unshare-net` for **Cut network**
(`insert_local_lane`, Linux, local-models-only projects), so a normal fenced
tab shares the host's loopback; that is how every MCP lane (`/mcp/web`,
`/mcp/markup`, ...) and the API proxy are reached. bubblewrap keeps the
environment, so variables put in `opts.env` before the wrap reach the CLI.
Not reachable: a Cut-network tab (no `127.0.0.1` of the host; the local lane
carries only Ollama), a project container, a remote host's tab. Those get no
exporter and stay on transcripts. Windows has no fence; macOS (seatbelt)
allows loopback.

## Fixed decisions

1. **A separate source, never added to the transcript rows.** Span counts are
   filed under the leaf `claude_otel` (`tokens.<kind>.claude_otel.<model>`),
   beside `claude`. The recap shows a "Claude (trace spans)" row with its own
   note. No total adds the two; no request is counted twice by construction
   (disjoint keys). Why not "spans win per session": a session's first
   requests (before the flag, before a restart, a `--resume` of an old
   conversation) have no spans, and a session's spans include requests the
   transcript never holds (title, compaction, classifier calls), so neither
   source can stand in for the other without a per-request match. Which one
   should be preferred is a decision for after the user has compared both rows
   on real work.
2. **Redelivery dedupe inside the source.** A span is counted once by
   `<traceId>:<spanId>`, remembered for the last 8192 spans: an exporter that
   retries a batch whose answer it lost adds nothing.
3. **JSON only.** `http/json`; a protobuf POST is answered 415. No protobuf
   dependency. gzip bodies are read (bounded to 4 MiB unzipped).
4. **Per-tab token, scope bound.** The bearer names the scope (project, box,
   root) the span is filed under; a tab cannot file under another's. Held
   only as its sha-256; ended by `on_tab_gone` and at exit. Not secret enough
   for a keyring, secret enough that it never rides a tmux argv: it travels
   under the carrier `<APP>AGENT_SECRET_OTEL_EXPORTER_OTLP_TRACES_HEADERS`
   (added to `agent_exec::targets` and `tmux_local::SECRET_ENV`, slot 8644),
   which `agent_exec` maps to the exporter variable just before the agent
   runs. Windows has no tmux: the variable itself. A tmux older than 3.2
   drops the carrier (`drop_carriers`) and the rest of the exporter's
   variables with it.
5. **One listener, window process only.** `127.0.0.1`, random port, not
   remembered (an agent a tmux session kept alive across a restart then
   exports to a dead port instead of to whoever took the old one). Started by
   the first launch that needs it, stopped by `stop_for_exit` in the
   `RunEvent::Exit` teardown beside the API proxy. The Mobile host's sidecar
   and a hosted server's daemon never start one (`allow_receiver` is called
   by the window's `setup` only; `is_server` short-circuits the launch), so
   one process owns `claude_otel_tokens.json`.
6. **Guards on the receiver.** `Origin` present or a `Host` other than
   `127.0.0.1:<port>` / `localhost:<port>` → 403 before the token is looked
   at; only `POST /v1/traces`; 8 requests in flight; 4 MiB body; 10 s to send
   it.
7. **Whose tabs.** A local, non-container Claude session (no subcommand, not a
   local-model tab, not a locked project) started while the flag is on. Not
   applied when the tab's environment or Tabtivity's own already holds any
   `OTEL_*` or Claude telemetry variable: the user's setup is theirs and is
   never redirected. A session already running keeps the environment it
   started with: the exporter appears at the next start of that tab.
8. **Flag.** `Settings::claude_otel_tokens` (`claude_otel_tokens` in
   `experimental.ts`, Settings → Experimental), off by default; the recap
   merges the row only while it is on. The ledger stays on disk when it is
   switched off.
9. **Ledger.** `<state_dir>/claude_otel_tokens.json` (counted, not
   rebuildable): the same hour/day bucket shape as `usage_stats.json`
   (`UsageStats`, 14 days of hours, 400 of days) plus a per-session total
   (`session.id` → scope, first/last, requests, split; 5000 newest). Written
   every 5 s when changed and at exit.

## Which source wins, and where they can disagree

| Case | Transcript row | Span row |
|------|----------------|----------|
| Session before the flag / after a restart / old `--resume` | counted | nothing |
| Main-thread and subagent requests of a tab started with the flag | counted | counted |
| Side requests (titles, compaction, classifier) | not in the transcript | counted |
| Cut-network, container, remote tabs | counted | nothing |
| A tab whose agent outlives its PTY (tmux) | counted | stops with the PTY (token ended) |
| Transcript cleanup (Claude deletes old files) | `retired` keeps it | the ledger keeps it |

Expect span ≥ transcript for a tab started with the flag. A large gap the other
way is a bug in one of the two.

## Remote, Windows, macOS

- **Remote-host tabs: out of scope.** The agent runs on the far host, whose
  `127.0.0.1` is not this one. A forward (`ssh -R`) could carry it later; the
  transcript copy of `remote_transcript` already covers their counts.
- **Windows:** no fence, no tmux, no carrier: the variable under its own name.
  Loopback is reachable. Untested; the receiver code is plain axum/tokio.
- **macOS:** the seatbelt wrap call site is wired the same way (built here only
  as far as `cfg(target_os = "macos")` code can be); `agent_exec` carrier
  mapping is the same. Untested.

## Steps

Phase 1 (done, uncommitted at the time of writing):

1. Probe + fixtures: `claude/otel.py`, spans captured as `claude_otel_fixtures/`.
2. `claude_otel.rs`: parser, ledger, receiver, launch env, exit teardown.
3. Wiring: `agent_exec::targets`, `tmux_local::SECRET_ENV`, `launch_prep`
   (`inject_api_keys`, `drop_carriers`), `agent_fence` (bubblewrap and
   seatbelt wraps, `on_tab_gone`), `lib.rs` (`allow_receiver`,
   `stop_for_exit`), `commands::usage_stats::usage_token_stats` (folds the
   source in while the flag is on).
4. Frontend: flag, Settings → Experimental switch, the recap row and note,
   `UntestedTag` rows (`settings.claudeOtelTokens`, `stats.tokensSpansRow`).
5. Tests: parser against the real captures, the ledger, redelivery,
   disjointness from the transcript rows, the env, the carrier plumbing, and
   the receiver end to end over a socket (401/403/404/405/413/415/400, gzip,
   revocation, loopback-only, closed after stop).

## Open

- **Not run in the app.** The user's click-through (below) is the first real
  run: tmux carrier path, fence env pass-through, and a real Claude session's
  spans (the probe used a stub model, so `request_id` and the account hash
  are absent there).
- **Per-request match against the transcript.** A span's `gen_ai.response.id`
  / `request_id` should equal the transcript record's `requestId`. If real
  data shows it does, the recap can drop a transcript request when a span of
  the same id exists (and the reverse), and "spans preferred for Claude" becomes
  a measured choice instead of a guess. Needs the transcript cursor to keep
  request ids (it keeps four today).
- **A tab that outlives its PTY** (tmux-held agent after the window closes)
  loses its token with the PTY. The API proxy ties tokens to the tmux
  session instead (`sweep_tmux`); the same could be done here.
- **Connection cap.** The receiver bounds requests in flight but not idle
  sockets; a local process can hold connections open. The API proxy's
  `BoundedListener` is the pattern.
- **Remote hosts** through a reverse forward; **protobuf** if an exporter
  setting ever forces it.
- **Other CLIs.** Codex and OpenCode have OTel too; each needs its own probe
  before any code.
- **Retire or keep** after a week of side-by-side rows: if the span row never
  shows anything the transcript row lacks, delete the module.

## Click-through for the user

1. Settings → Experimental → turn on "Claude token counts from trace spans".
2. Open a new local Claude tab in a project (a tab already running keeps its
   old environment), ask it something small, ask for a title/compaction-heavy
   thing if you like (`/compact`).
3. Open the recap (Settings or the daily one): the Tokens section shows a
   "Claude (trace spans)" row beside "Claude". Per model expands. The span row
   should be equal to or a little above the Claude row for that tab.
4. Quit the app and start it again: the span row is still there (ledger).
5. Turn the switch off: the row disappears; new Claude tabs start without
   exporter variables.
6. Optional, to see the wiring: in the Claude tab, `env | grep -i otel` shows the
   exporter variables (the bearer under its real name); a tab in a
   Cut-network project, a container project or a remote project shows none.
