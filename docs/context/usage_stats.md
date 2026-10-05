# Usage stats

Referenced from `AGENTS.md`.

**Usage stats are local-only** (`usage_stats.json`, `schema::usage_stats`): a
rolling hour+day counter store behind the daily recap (which agents/models you
used, prompts asked, shell commands, file churn, tabs). It clones
`schema::net_usage`'s bucket+prune shape but its payload is an **open
string-keyed counter map**, so adding a statistic costs one const in `metric`
(mirrored in `src/lib/usageMetrics.ts`) and one render line — no migration.
Deliberately NOT counted into it: **time** (`time_summary.json`), **network
bytes** (`net_usage.json`) and **git** (re-derived from `git log` on demand) —
the recap reads those at their source so they can never drift. Tab opens are
counted in the frontend's `addTab`, *not* at `pty_spawn`, because the backend
spawn fires again for every resumable agent tab respawned on relaunch. File
churn comes from a recursive `notify` watcher on the **active** project
(`services::usage_stats`); it cannot see an SFTP tree, so a remote project is
counted only via its local mirror. The recap (`components/stats/`) opens on the
first launch of each day (`daily_stats_recap`, default on) and from Settings.

Autocomplete records `autocomplete.accept.<mode>.<model>` or
`autocomplete.dismiss.<mode>.<model>` once per offered candidate. Accepting a
word/line or typing its matching prefix counts as acceptance; later handling of
its remainder does not count again. The recap groups outcomes by mode/model.
These are local counters only: no document text, paths or reference contents.

**Agent tokens are derived, not counted** (`services::token_stats`,
`usage_token_stats`, plan in `docs/token_stats_plan.md`). Claude and Codex
already write per-message usage into each Eldrun agent home, so the recap's
Tokens section reads those records (fresh in, cache write, cache read, output;
a Codex SQLite `total` with no split when a thread has no rollout) as
`tokens.<kind>.<cli>.<model>` counters — the model is everything after the
third `.`. The one stored state is a **rebuildable scan cache**,
`<state_dir>/token_stats.json`: a cursor per source file plus what that file
contributed, version-gated (another version is discarded and rebuilt). Claude
deletes old transcripts, so a vanished file's contribution moves to `retired`
instead of being dropped; a shrunk or replaced file is re-read after its old
share is taken back out. Seeded pre-Eldrun history is not counted once per
home: records older than the home's seed marker are skipped, and the cache
keeps the earliest marker time it saw per home, so a re-stamped marker can't
let old history in later. Homes are agent-writable, so reads go through
`home_io` (no symlinks), long lines are skipped unbuffered, counts and
timestamps are bounded, and each scan has a byte/file budget — past it the
command answers `partial` and the frontend asks again a few times (capped),
never polling. CLIs Eldrun cannot read show as "not reported", never `0`; no
cost figures.
