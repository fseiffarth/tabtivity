# Agent CLI prompt caching — plan

Status 2026-11-19: research done (below); phases 1a–1e and 2–5 implemented, not live-verified.

## What the research found

Three read-only investigations (Claude + Codex, Gemini + Antigravity,
OpenCode + Copilot) measured the transcripts in this machine's agent homes and
read each CLI's docs. Numbers are aggregates from those homes only.

**Tabtivity does not break any CLI's cache prefix.** Everything it injects is
constant across spawns and tabs: the SessionStart hint (`agent_hint.rs`), the
cockpit name hint, MCP lane `instructions`, the `--mcp-config` /
`-c mcp_servers.*` / `--additional-mcp-config` argv (built by `serde_json`,
stable order), OpenCode's inline config (`{env:VAR}` tokens, no per-spawn
values). Keep it that way: no tab id, label, date or path in any injected text.

| CLI | Share of input read from cache | Where the misses are |
|---|---|---|
| Claude Code | 97.8 % main, 97.9 % subagents | resume after >1 h idle = 29 % of main cache writes; session start 15 %; subagents are always 5 min TTL (53 M tokens rewritten after >5 min gaps) |
| Codex | 97.2 % | mostly new content; gaps >30 min only 3.6 % of uncached |
| OpenCode (Anthropic) | 97.1 % | 29 % of cache writes after gaps >5 min (default 5 min TTL) |
| Antigravity | ~96 % (field mapping inferred) | ~15k cold tokens per new conversation |
| Gemini CLI | no data | OAuth login gets **no caching**; only API key / Vertex do |
| Copilot CLI | 3 requests | a hit made a turn ~11× cheaper; `cacheExpiresAt` ≈ +30 min |

Facts worth keeping:
- Claude: 1 h TTL is the default only for the main conversation on a
  subscription; API-key billing, subagents, compaction get 5 min.
  `subagentPromptCacheTtl` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` change the
  latter. Claude Code puts the session id in its `environment` attachment, so
  two sessions never share a prefix past the static system prompt.
- Codex: OpenAI TTL 30 min default for gpt-5.6+; 12 h opt-in not exposed in
  Codex config (strings exist in the 0.170 binary only).
- OpenCode 2.x: `settings.cache.ttl` (`5m`/`1h`, OpenAI `24h`), top-level
  `warming` (off by default: real keep-alive calls at ~90 % of TTL for up to
  30 min after the last request, stops on a miss, skips subagents).
  `options.setCacheKey` for OpenAI-style providers — default unverified.
- Gemini CLI: implicit caching ≥ 2,048 (2.5) / 4,096 (3.x/4) tokens; session
  JSONL records `tokens.{input,cached,output,thoughts,tool,total}`.
- Copilot CLI: `~/.copilot/session-store.db` `assistant_usage_events`;
  `events.jsonl` `session.shutdown` carries `cacheExpiresAt` and `tokenDetails`.
- The warm-up cron (`agent_warmup`) opens a usage window from the probe home;
  it warms no cache and never should be sold as doing so.

## Phases

1. **Cache numbers in the usage recap** (`services::token_stats`,
   `lib/tokenStats.ts`, `StatsRecap.tsx`).
   - 1a. Cache-hit share on every CLI/model line: cache read ÷ (fresh + cache
     write + cache read). Frontend only.
   - 1b. OpenCode as a source: `opencode.db` in each home, v2
     `session_message` (type `assistant`) and v1 `message` (role
     `assistant`), `tokens.{input, output+reasoning, cache.read, cache.write}`,
     model `model.id` / `modelID`. Counted once `time.completed` is set.
     Incremental cursor per table: high-water `(time_created, id)` + a bounded
     set of ids still in progress. Opened through `agent_sqlite`.
   - 1c. Gemini CLI as a source: session JSONL `tokens.cached` (input includes
     cached — subtract, like Codex).
   - 1d. Copilot CLI as a source: `session-store.db` `assistant_usage_events`.
   - 1e. Claude splits: main vs subagent, 5 min vs 1 h writes
     (`usage.cache_creation.ephemeral_{5m,1h}_input_tokens`).
   - Antigravity later: undocumented protobuf in `gen_metadata`; tie to a
     version and fail soft.
2. **OpenCode warming opt-in** (done): a switch on the OpenCode card in
   Manage CLIs writes top-level `warming: true` into the Tabtivity-wide
   layer's `.config/opencode/opencode.json`, now a merged file, so it is the
   user's own config in every home. Not the inline config: that is built on
   several paths (API keys, MCP lanes, local models). Schema read from the
   2.3.2 binary: `warming: boolean | { prompt?, interval?: "auto" | duration,
   duration? }`, defaults 90 % of `cache.ttl` (4 min without one) and 30 min;
   a model's `settings.cache.warming` overrides it. `cache.ttl` stays the
   user's. Local models are warmed too (every 4 min).
3. **Cold-cache chip** (done): Claude resumes already had one, from Claude's
   own `SessionStart` figures (`agentResumeCost`, 2026-10-21). Extended to an
   open Claude tab idle past its cache and to Codex: the transcript read
   (`agent_transcript::PromptCache` in `usage.cache`) gives the newest
   answer's time and tokens and the lifetime — Claude's from the newest write's
   `cache_creation` (1 h / 5 min), Codex 30 min — and the Reader's facts row
   shows "Cache cold · N tokens to re-cache" past it, hint naming `/clear` /
   `/new`. No restart button (the user's choice). Copilot later: its expiry
   (`cacheExpiresAt`) is only written when a session ends.
4. **Gemini auth note** (done): a static note on the Gemini card's Options
   (`GeminiCachingNotice`) and in the `gemini-cli` help page — Google sign-in
   → no caching (Gemini CLI's `docs/cli/token-caching.md`: "the Code Assist
   API does not support cached content creation"; its quota counts requests),
   API key → implicit caching; points at Accounts & keys → API keys and
   Gemini's `/auth`. The user flips it, never Tabtivity.
5. **Ollama keep-alive** (done): `settings.ollama_keep_alive` (`30m` / `1h` /
   `-1`, unset = Ollama's 5 min), the "Keep a model loaded after its last
   use" card on the Local models page. A server Tabtivity spawns gets
   `OLLAMA_KEEP_ALIVE` at start (Restart applies it; the user's env wins); a
   systemd service gets a one-click `sudo` drop-in
   (`<slug>-keep-alive.conf`, removed again for the default), its current
   value read from `systemctl show -p Environment`. Agents reach Ollama through
   `/v1`, which cannot send `keep_alive`. Inferred, not verified: each such
   request also resets a model pinned with Load (`keep_alive: -1`) to the
   server default — a longer default softens that too.
6. **Claude subagent 1 h TTL**: measure before offering; estimate is
   break-even to negative.

## Not doing

- Rewriting request bodies in the API proxy (cache markers, keys, TTL): risky,
  small gain, and subscription traffic bypasses the proxy.
- Explicit Gemini `cachedContents`: blocked by the proxy allowlist, not
  supported on Gemini 4, storage fees.
- Keep-alive pings from the warm-up cron for Claude/Antigravity: a `-p` call's
  prefix differs from the interactive session's, so it misses.
- Cross-tab prefix sharing for Claude: the session id in the prefix is Claude
  Code's own.
