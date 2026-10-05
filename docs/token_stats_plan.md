# Token stats plan

Per-CLI, per-model, per-project token counts in the usage recap
(`components/stats/StatsRecap.tsx`), so the question "where do my tokens go —
context, cache, or output?" has a measured answer.

## Principle

**Derived from the CLIs' own records, never counted live.** Every agent tab's
`$HOME` is an Eldrun-owned `<state_dir>/agent-homes/<key>`
(`services::agent_home`), and the CLIs already write per-message usage there.
This follows `docs/context/usage_stats.md`'s rule for time/net/git: read at the
source so the numbers cannot drift with crashed tabs, `/clear`, or resumes.

The one piece of stored state is a **rebuildable scan cache** — needed because
Claude deletes transcripts after `cleanupPeriodDays` (default 30), so a month
view would otherwise shrink as files vanish.

## Sources (verified 2026-10-01 against live files)

### Claude — `<home>/.claude/projects/<cwd-slug>/<session>.jsonl`

- Assistant records carry `message.usage`:
  `input_tokens` (fresh, **excludes** cache), `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `output_tokens`
  (`output_tokens_details.thinking_tokens` is a subset of output). Also
  `message.model`, `message.id`, top-level `requestId`, `timestamp` (ISO UTC).
- **The same message is written on several lines** (one per content block)
  with identical `usage` — dedupe on `(message.id, requestId)`, or the counts
  come out 2–5× too high.
- Subagents: `<cwd-slug>/<session>/subagents/agent-<id>.jsonl`, same shape.
  Count them, attributed to the same scope.
- Skip `model == "<synthetic>"` and records with no `usage`.
- **Seeded history** (`agent_home::seed_claude_transcripts`) copies the user's
  pre-Eldrun transcripts into a home. Don't count records whose `timestamp` is
  older than the home's seeded marker (`.eldrun-home`) mtime — otherwise the
  same pre-Eldrun history counts once per seeded home. New turns appended to a
  resumed seeded session are newer than the marker and count normally.

### Codex — `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

- `event_msg` records with `payload.type == "token_count"` carry
  `payload.info.total_token_usage` and `last_token_usage`:
  `input_tokens` (**includes** cached — OpenAI semantics),
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
  `reasoning_output_tokens` (subset of output), plus `timestamp`.
- Codex can repeat a `token_count` without a new turn: take **deltas of
  `total_token_usage`** between consecutive events, not `last_token_usage`.
  A total that goes down (new thread in the same file) restarts the baseline.
- Normalize: fresh input = `input_tokens − cached_input_tokens − cache_write_input_tokens`
  (floor 0); cache read = `cached_input_tokens`; cache write =
  `cache_write_input_tokens`.
- Model: the `turn_context` record's `payload.model` before the event, falling
  back to the session-meta model, then `codex_store::thread_model`.
- **Fallback** for threads with no rollout (Codex 0.153.4 stopped writing them
  for a while; `services::codex_store` explains): `threads.tokens_used` in the
  scope's `state_<n>.sqlite` is a single cumulative total with no split. Count it
  only when there's no rollout for that thread id, as metric kind `total`,
  bucketed at `updated_at_ms`. Read-only, best-effort, like the rest of
  `codex_store`.

### Every other CLI

Not reported in v1. The recap lists them with no token row (never `0` — the
same rule as missing sensor readings). Follow-ups go in `todo/group-s-agents.md`:
OpenCode (per-message `tokens` in its storage), Gemini CLI (`chats/session-*.json`
`tokens`), Copilot/agy/others as their formats allow.

## Data model

Reuse the open counter map from `schema::usage_stats` — no new schema type the
frontend has to learn. Metric keys:

```
tokens.in.<cli>.<model>        fresh input
tokens.cache_w.<cli>.<model>   cache write
tokens.cache_r.<cli>.<model>   cache read
tokens.out.<cli>.<model>       output (incl. thinking/reasoning)
tokens.total.<cli>.<model>     Codex SQLite fallback only (no split)
```

`<cli>` is the agent leaf the recap already uses (`claude`, `codex`), so
`agentLabel` renders it. `<model>` is everything after the third `.` (model
names contain dots: `gpt-6.1-sol`). Add the prefixes to `metric` in
`schema/usage_stats.rs` and to `METRIC` in `src/lib/usageMetrics.ts`.

Buckets are UTC hour `YYYY-MM-DDTHH` and day `YYYY-MM-DD`, keyed by **scope id**
(project id, box id, or the root pseudo-id), exactly like `UsageReport`, so the
recap's existing window/fold code applies unchanged.

## Backend

### `services/token_stats.rs` (new, `AppHandle`-free, unit-tested)

- `scan(state_dir, scopes: &[String]) -> TokenStats`: for each scope id, its
  home is `agent_home::scope_home_in(state_dir, id)`. Homes with no known
  scope (deleted project) fold into the root scope. The Host session home
  (`agent_home::host_home_in`) counts as the root scope.
- **Incremental**: cache in `<state_dir>/token_stats.json`, holding
  - per source file (key: path relative to the homes root + inode/file id):
    byte offset reached, file length at that offset, the last dedupe key /
    Codex running total seen (so a message split across scan boundaries isn't
    counted twice), and that file's contribution to the hour/day buckets;
  - a `retired` bucket set: when a source file disappears, move its
    contribution there instead of dropping it. That's how history outlives
    Claude's cleanup.
  - A file that got **shorter** or changed inode is re-read from 0 after its old
    contribution is subtracted.
  - A `version` field; an unknown version means discard and rebuild.
- Prune hour/day buckets with the same retention as `schema::usage_stats`
  (reuse `prune_to` / the constants, don't copy them).
- Write the cache atomically, the way the other `state_dir` stores do.

### Hostile input (homes are agent-writable)

- Open every file through `services::home_io` (`HomeDir`/`HomeFile`:
  no-follow, `openat` walk). Never follow a symlink out of the home.
- Stream with `BufRead::read_until`, and discard any line longer than 1 MiB
  without buffering it (Claude tool-result lines run to megabytes and carry no
  usage). Cheap substring prefilter before `serde_json`: `"usage"` (Claude),
  `"token_count"` (Codex).
- Clamp every count to `u64`. Ignore negative, absurd (> 10⁹ per message) or
  non-numeric values, and timestamps more than a day in the future.
- Cap the files per scan and the bytes per scan (e.g. 512 MiB). Past the
  budget, return what's done with `partial: true` — the next call continues
  from the cursors.
- Store only counts plus model names, CLI and scope ids — no text, no paths in
  the bucket data (the cache keeps relative file keys for its cursors only).

### Command — `commands/usage_stats.rs`

`usage_token_stats(project_id: String) -> TokenReport` on the blocking pool,
mirroring `usage_summary`: runs an incremental scan, then returns
`{ hours, days, partial, sources: ["claude","codex"] }` folded to one scope
(or summed when empty). Register it in `lib.rs` next to the other `usage_*`.
`sources` tells the frontend which CLIs *can* report, so it can tell
"not reported" apart from "none used".

### Tests

Fixture-driven, in the service module:

- Claude duplicate lines → counted once.
- Subagent file counted.
- `<synthetic>` skipped.
- Records before the seed marker skipped.
- Codex total deltas: a repeated event adds nothing, and a reset total
  restarts the baseline.
- Codex input normalization.
- Incremental: append → only the new lines counted. Truncate or inode change →
  recount without doubling. Deleted file → contribution kept in `retired`.
- Oversized line skipped without allocating.
- Symlinked transcript not followed.
- Model with dots → key round-trip.
- Byte budget → `partial`, and the next scan completes to the same totals as a
  single unbounded scan.

## Frontend

`StatsRecap.tsx` gets a **Tokens** section under Agents, using the period and
project filter the dialog already has:

- One row per CLI: fresh in · cache write · cache read · output, and **output
  share** = out / (in + cache_w + cache_r + out). Expandable per model.
  Compact numbers (`1.2M`).
- Codex `total`-only rows show the total and "no split reported".
- CLIs that were used in the period (from `agent.tab.*` / `agent.prompt.*`) but
  aren't in `sources` show "not reported" — never `0`.
- `partial` → a small "still counting…" note; refetch once on the next open.
- Fetched when the section is visible, like the other recap reads. No polling.
- No dollar figures (subscriptions make them misleading).
- All strings via `useT()`. English holds every key.
- `UntestedTag` on the section title, with a row in `src/lib/untested.ts`
  (id = the title's i18n key).
- Vitest: folding token keys by CLI/model, model-with-dots parsing, output
  share, "not reported" vs zero.

## Docs

- `docs/context/usage_stats.md`: a paragraph on token stats (derived, scan
  cache, retired buckets, seed-marker rule, hostile-input bounds).
- One row each in `docs/filemap_backend.md` (service, cache) and
  `docs/filemap_frontend.md` (recap section). Grep for the neighbouring rows;
  don't read the maps whole.
- `docs/third_party_update_checklist.md`: on a Claude/Codex update, re-check the
  usage fields and the dedupe keys listed above.
- `todo/group-s-agents.md`: the follow-up CLIs, plus a 🖐️ manual box
  "Token stats in the recap match `/usage` / `/status`", with the platform
  ✅/❌ child pairs.

## Phases

1. **Backend**: service, cache, command, metric constants, tests. Gates; then
   `npm run backend:stale`.
2. **Frontend + docs**: recap section, i18n, untested row, vitest, docs, todo.
   Gates.

Out of scope: the phone, live per-tab token meters, cost estimates, non-local
(SSH/container) homes beyond what sits under `agent-homes/`.
