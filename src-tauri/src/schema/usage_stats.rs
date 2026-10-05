//! `usage_stats.json` — the rolling counter store behind the daily recap.
//!
//! Structurally this is [`crate::schema::net_usage`] with a wider payload: the
//! same hour + day bucket maps keyed by project, the same saturating folds, the
//! same prune-on-save. Where net_usage stores a fixed `{rx, tx}`, this stores an
//! open **metric key → count** map, so a new statistic costs one constant in
//! [`metric`] and one render line in the recap — no schema version, no migration.
//!
//! What is deliberately NOT here:
//!
//! - **Time** (`time_summary.json`) and **network bytes** (`net_usage.json`)
//!   already exist as per-project daily rollups; the recap reads them through
//!   their own commands.
//! - **Git** commits/lines are re-derived from `git log` on demand
//!   (`commands::usage_stats::usage_git_stats`).
//!
//! Both stay at their source so a counter here can never drift from the truth.
//!
//! Counts are `u64`. Durations are counts of **seconds** (`agent.worked_s`) —
//! the one unit convention in this file.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::storage;

/// File name of the counter store inside `state_dir()`.
pub const STATS_FILE: &str = "usage_stats.json";

/// How many hour buckets to retain — 14 days, matching `net_usage`. Keys are
/// shared across projects (one per wall-clock hour), so this is a calendar
/// window, not a per-project quota.
pub const HOUR_RETENTION: usize = 24 * 14;

/// How many day buckets to retain — ~13 months, so a "this month" view always
/// has a full month behind it and a year-over-year glance still works.
///
/// `net_usage` keeps its days forever, which is affordable for two `u64`s per
/// project per day. A counter map is far wider (one entry per distinct metric,
/// and the agent/model keys are open-ended), so days are pruned here too.
pub const DAY_RETENTION: usize = 400;

/// Metric key → count for one (bucket, project) pair.
pub type Counters = HashMap<String, u64>;

/// The metric keys. Namespaced with `.`; the `<…>` segments are interpolated
/// (agent command, local model name) and so are open-ended by design.
///
/// Mirrored in `src/lib/usageMetrics.ts` — keep the two in step.
pub mod metric {
    /// One outcome per autocomplete suggestion, suffixed with `<mode>.<model>`.
    pub const AUTOCOMPLETE_ACCEPT: &str = "autocomplete.accept";
    pub const AUTOCOMPLETE_DISMISS: &str = "autocomplete.dismiss";
    /// `agent.tab.<cmd>` — an agent tab was opened (not counting restore-respawns).
    pub const AGENT_TAB: &str = "agent.tab";
    /// `agent.tab.local.<model>` — a local (Ollama-backed) agent tab was opened.
    pub const AGENT_TAB_LOCAL: &str = "agent.tab.local";
    /// `agent.active.<cmd>` — distinct agent tabs that received ≥1 prompt that day.
    pub const AGENT_ACTIVE: &str = "agent.active";
    /// `agent.prompt.<cmd>` — prompts submitted to an agent.
    pub const AGENT_PROMPT: &str = "agent.prompt";
    /// Seconds agent tabs spent actually working.
    pub const AGENT_WORKED_S: &str = "agent.worked_s";
    /// Times an agent stopped to ask the user a decision.
    pub const AGENT_DECISION: &str = "agent.decision";
    /// Times an agent finished a turn.
    pub const AGENT_DONE: &str = "agent.done";
    /// Commands run in a shell tab.
    pub const SHELL_COMMAND: &str = "shell.command";
    /// Files created / modified / deleted, as seen by the watcher.
    pub const FILE_CREATED: &str = "file.created";
    pub const FILE_MODIFIED: &str = "file.modified";
    pub const FILE_DELETED: &str = "file.deleted";
    /// Tabs opened / closed (every kind, not just agents).
    pub const TAB_OPENED: &str = "tab.opened";
    pub const TAB_CLOSED: &str = "tab.closed";
    /// External apps launched.
    pub const APP_LAUNCHED: &str = "app.launched";

    /// Agent tokens, suffixed with `<cli>.<model>`. These are **not** counted
    /// into this store: `services::token_stats` derives them from the CLIs'
    /// own usage records and keeps them in `token_stats.json`, so a crashed
    /// tab or a resume can never make them drift. They share this namespace
    /// so the recap folds them with the same code. `<model>` is everything
    /// after the third `.` — model names contain dots (`gpt-6.1-sol`).
    ///
    /// Fresh input, not counting cache reads or writes.
    pub const TOKENS_IN: &str = "tokens.in";
    /// Input written to the prompt cache.
    pub const TOKENS_CACHE_W: &str = "tokens.cache_w";
    /// Input read back from the prompt cache.
    pub const TOKENS_CACHE_R: &str = "tokens.cache_r";
    /// Output, thinking/reasoning included.
    pub const TOKENS_OUT: &str = "tokens.out";
    /// A total with no split — only Codex's SQLite fallback reports one.
    pub const TOKENS_TOTAL: &str = "tokens.total";

    /// Compose a dotted key from a prefix and an open-ended segment, e.g.
    /// `sub(AGENT_PROMPT, "claude")` → `"agent.prompt.claude"`.
    pub fn sub(prefix: &str, leaf: &str) -> String {
        format!("{prefix}.{leaf}")
    }
}

/// Rolling per-project usage counters at two granularities: hour
/// ("YYYY-MM-DDTHH") and day ("YYYY-MM-DD"), each mapping project_id → counters.
///
/// Serialized shape:
/// ```json
/// {
///   "version": 1,
///   "hours": { "2026-07-13T14": { "<project-id>": { "agent.prompt.claude": 3 } } },
///   "days":  { "2026-07-13":    { "<project-id>": { "agent.prompt.claude": 37 } } }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageStats {
    /// Schema version, for forward compatibility.
    #[serde(default = "default_version")]
    pub version: u32,
    /// hour ("YYYY-MM-DDTHH") → project_id → counters. Pruned to the newest
    /// [`HOUR_RETENTION`] keys on every save.
    #[serde(default)]
    pub hours: HashMap<String, HashMap<String, Counters>>,
    /// date ("YYYY-MM-DD") → project_id → counters. Pruned to the newest
    /// [`DAY_RETENTION`] keys on every save.
    #[serde(default)]
    pub days: HashMap<String, HashMap<String, Counters>>,
}

fn default_version() -> u32 {
    1
}

impl Default for UsageStats {
    fn default() -> Self {
        UsageStats {
            version: 1,
            hours: HashMap::new(),
            days: HashMap::new(),
        }
    }
}

impl UsageStats {
    /// Counters recorded for `project_id` on `date` ("YYYY-MM-DD").
    pub fn counters_on(&self, project_id: &str, date: &str) -> Counters {
        lookup(&self.days, project_id, date)
    }

    /// Counters recorded for `project_id` in `hour` ("YYYY-MM-DDTHH").
    pub fn counters_in_hour(&self, project_id: &str, hour: &str) -> Counters {
        lookup(&self.hours, project_id, hour)
    }

    /// Add `n` to `project_id`'s `key` counter for the UTC hour `hour`
    /// ("YYYY-MM-DDTHH"), and to the day that hour falls in. Both buckets come
    /// from the one stamp — the day is its `YYYY-MM-DD` prefix — so they can
    /// never disagree about when something happened.
    ///
    /// A zero delta is a no-op so an idle project never creates empty buckets. A
    /// malformed stamp is ignored rather than panicking. Saturating, so a
    /// pathological counter can never overflow.
    pub fn add(&mut self, project_id: &str, hour: &str, key: &str, n: u64) {
        if n == 0 || key.is_empty() {
            return;
        }
        let Some(date) = hour.get(..10) else { return };
        accrue(&mut self.hours, project_id, hour, key, n);
        accrue(&mut self.days, project_id, date, key, n);
    }

    /// Fold a whole batch of counters in one pass — what the frontend's periodic
    /// flush sends.
    pub fn add_many(&mut self, project_id: &str, hour: &str, counters: &Counters) {
        for (key, n) in counters {
            self.add(project_id, hour, key, *n);
        }
    }

    /// Per-date counters for `project_id` (or summed across every project when
    /// empty) — the shape `commands::usage_stats::usage_summary` returns.
    pub fn daily_for(&self, project_id: &str) -> HashMap<String, Counters> {
        fold(&self.days, project_id)
    }

    /// Per-hour counters for `project_id` (or every project when empty), over the
    /// retained window.
    pub fn hourly_for(&self, project_id: &str) -> HashMap<String, Counters> {
        fold(&self.hours, project_id)
    }

    /// Drop all but the newest [`HOUR_RETENTION`] hour buckets and
    /// [`DAY_RETENTION`] day buckets. Keys sort lexicographically in
    /// chronological order (fixed-width, zero-padded), so this needs no date
    /// arithmetic and no clock read — which also means a backdated or
    /// clock-skewed key can never evict live ones out of order.
    pub fn prune(&mut self) {
        prune_to(&mut self.hours, HOUR_RETENTION);
        prune_to(&mut self.days, DAY_RETENTION);
    }
}

/// `bucket → project → counters` lookup, defaulting to empty.
fn lookup(
    buckets: &HashMap<String, HashMap<String, Counters>>,
    project_id: &str,
    key: &str,
) -> Counters {
    buckets
        .get(key)
        .and_then(|by_project| by_project.get(project_id))
        .cloned()
        .unwrap_or_default()
}

/// Fold `n` into `buckets[bucket][project_id][key]`, creating buckets as needed.
fn accrue(
    buckets: &mut HashMap<String, HashMap<String, Counters>>,
    project_id: &str,
    bucket: &str,
    key: &str,
    n: u64,
) {
    let entry = buckets
        .entry(bucket.to_string())
        .or_default()
        .entry(project_id.to_string())
        .or_default()
        .entry(key.to_string())
        .or_insert(0);
    *entry = entry.saturating_add(n);
}

/// Collapse `bucket → project → counters` to `bucket → counters` for one project
/// (or summed across all projects when `project_id` is empty).
fn fold(
    buckets: &HashMap<String, HashMap<String, Counters>>,
    project_id: &str,
) -> HashMap<String, Counters> {
    let mut out: HashMap<String, Counters> = HashMap::new();
    for (bucket, by_project) in buckets {
        for (pid, counters) in by_project {
            if project_id.is_empty() || pid == project_id {
                let acc = out.entry(bucket.clone()).or_default();
                for (key, n) in counters {
                    let slot = acc.entry(key.clone()).or_insert(0);
                    *slot = slot.saturating_add(*n);
                }
            }
        }
    }
    out
}

/// Retain only the newest `keep` keys of a bucket map.
fn prune_to(buckets: &mut HashMap<String, HashMap<String, Counters>>, keep: usize) {
    if buckets.len() <= keep {
        return;
    }
    let mut keys: Vec<&str> = buckets.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let cutoff = keys[keys.len() - keep].to_string();
    buckets.retain(|bucket, _| *bucket >= cutoff);
}

// ── On-disk helpers ────────────────────────────────────────────────────────

fn stats_path() -> std::path::PathBuf {
    storage::state_dir().join(STATS_FILE)
}

static USAGE_STATS_LOCK: Mutex<()> = Mutex::new(());

/// Load the counter store, defaulting to empty when the file is absent or
/// unparseable (a brand-new install, or a partial write) rather than erroring.
pub fn load() -> UsageStats {
    let path = stats_path();
    if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        UsageStats::default()
    }
}

fn load_strict() -> Result<UsageStats, String> {
    let path = stats_path();
    if path.exists() {
        storage::read_json(&path).map_err(|e| e.to_string())
    } else {
        Ok(UsageStats::default())
    }
}

/// Persist the counter store, pruning stale buckets first. Pruning lives here
/// rather than in `add` so it is impossible for a writer to skip it, and so it
/// costs one sort per flush rather than one per counter.
///
/// Written atomically: unlike the other stores this one has two writers (the
/// frontend's batched flush and the file watcher), so a torn read is a real
/// possibility rather than a theoretical one.
pub fn save(stats: &mut UsageStats) -> Result<(), String> {
    stats.version = 1;
    stats.prune();
    storage::write_json_atomic(&stats_path(), stats).map_err(|e| e.to_string())
}

/// Fold a batch of counters for `project_id` into the current UTC hour (and
/// thereby the current UTC day). O(map) read-modify-write of a bounded file. An
/// empty batch is skipped without touching disk.
pub fn record(project_id: &str, counters: &Counters) -> Result<(), String> {
    if project_id.is_empty() || counters.is_empty() {
        return Ok(());
    }
    let _guard = USAGE_STATS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut stats = load_strict()?;
    stats.add_many(project_id, &storage::hour_utc(), counters);
    save(&mut stats)
}

/// Fold a single counter — the convenience path for backend-side one-shot events
/// (a tab spawn).
pub fn record_one(project_id: &str, key: &str, n: u64) -> Result<(), String> {
    let mut counters = Counters::new();
    counters.insert(key.to_string(), n);
    record(project_id, &counters)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counters(pairs: &[(&str, u64)]) -> Counters {
        pairs.iter().map(|(k, n)| (k.to_string(), *n)).collect()
    }

    // ── add / lookup ───────────────────────────────────────────────────────

    #[test]
    fn add_lands_in_both_hour_and_day() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::SHELL_COMMAND, 3);
        assert_eq!(
            s.counters_in_hour("p1", "2026-07-13T14")[metric::SHELL_COMMAND],
            3
        );
        // The day bucket is the hour stamp's first ten chars — the two can never
        // disagree about when something happened.
        assert_eq!(s.counters_on("p1", "2026-07-13")[metric::SHELL_COMMAND], 3);
    }

    #[test]
    fn add_accumulates_across_calls() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::AGENT_DECISION, 2);
        s.add("p1", "2026-07-13T15", metric::AGENT_DECISION, 5);
        // Different hours, same day.
        assert_eq!(s.counters_on("p1", "2026-07-13")[metric::AGENT_DECISION], 7);
        assert_eq!(
            s.counters_in_hour("p1", "2026-07-13T14")[metric::AGENT_DECISION],
            2
        );
    }

    #[test]
    fn add_keeps_projects_separate() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::TAB_OPENED, 1);
        s.add("p2", "2026-07-13T14", metric::TAB_OPENED, 9);
        assert_eq!(s.counters_on("p1", "2026-07-13")[metric::TAB_OPENED], 1);
        assert_eq!(s.counters_on("p2", "2026-07-13")[metric::TAB_OPENED], 9);
    }

    #[test]
    fn add_zero_is_a_no_op() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::TAB_OPENED, 0);
        // An idle project must not create empty buckets.
        assert!(s.days.is_empty());
        assert!(s.hours.is_empty());
    }

    #[test]
    fn add_empty_key_is_a_no_op() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", "", 5);
        assert!(s.days.is_empty());
    }

    #[test]
    fn add_with_malformed_stamp_is_ignored_not_panicking() {
        let mut s = UsageStats::default();
        s.add("p1", "short", metric::TAB_OPENED, 1);
        assert!(s.days.is_empty());
        assert!(s.hours.is_empty());
    }

    #[test]
    fn add_saturates_rather_than_overflowing() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::AGENT_WORKED_S, u64::MAX);
        s.add("p1", "2026-07-13T14", metric::AGENT_WORKED_S, 10);
        assert_eq!(
            s.counters_on("p1", "2026-07-13")[metric::AGENT_WORKED_S],
            u64::MAX
        );
    }

    #[test]
    fn lookup_of_absent_bucket_is_empty_not_panicking() {
        let s = UsageStats::default();
        assert!(s.counters_on("nobody", "1999-01-01").is_empty());
        assert!(s.counters_in_hour("nobody", "1999-01-01T00").is_empty());
    }

    // ── add_many ───────────────────────────────────────────────────────────

    #[test]
    fn add_many_folds_a_whole_batch() {
        let mut s = UsageStats::default();
        s.add_many(
            "p1",
            "2026-07-13T14",
            &counters(&[("agent.prompt.claude", 4), ("shell.command", 2)]),
        );
        let day = s.counters_on("p1", "2026-07-13");
        assert_eq!(day["agent.prompt.claude"], 4);
        assert_eq!(day["shell.command"], 2);
    }

    // ── open-ended metric keys ─────────────────────────────────────────────

    #[test]
    fn sub_composes_a_dotted_key() {
        assert_eq!(
            metric::sub(metric::AGENT_PROMPT, "claude"),
            "agent.prompt.claude"
        );
        assert_eq!(
            metric::sub(metric::AGENT_TAB_LOCAL, "qwen3:8b"),
            "agent.tab.local.qwen3:8b"
        );
    }

    #[test]
    fn per_agent_keys_do_not_collide() {
        let mut s = UsageStats::default();
        s.add(
            "p1",
            "2026-07-13T14",
            &metric::sub(metric::AGENT_PROMPT, "claude"),
            10,
        );
        s.add(
            "p1",
            "2026-07-13T14",
            &metric::sub(metric::AGENT_PROMPT, "codex"),
            3,
        );
        let day = s.counters_on("p1", "2026-07-13");
        assert_eq!(day["agent.prompt.claude"], 10);
        assert_eq!(day["agent.prompt.codex"], 3);
    }

    // ── fold (daily_for / hourly_for) ──────────────────────────────────────

    #[test]
    fn daily_for_one_project_excludes_the_others() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::TAB_OPENED, 1);
        s.add("p2", "2026-07-13T14", metric::TAB_OPENED, 9);
        let folded = s.daily_for("p1");
        assert_eq!(folded["2026-07-13"][metric::TAB_OPENED], 1);
    }

    #[test]
    fn daily_for_empty_project_sums_across_all_projects() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::TAB_OPENED, 1);
        s.add("p2", "2026-07-13T14", metric::TAB_OPENED, 9);
        let folded = s.daily_for("");
        assert_eq!(folded["2026-07-13"][metric::TAB_OPENED], 10);
    }

    #[test]
    fn hourly_for_folds_per_hour_not_per_day() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::SHELL_COMMAND, 2);
        s.add("p1", "2026-07-13T15", metric::SHELL_COMMAND, 5);
        let folded = s.hourly_for("p1");
        assert_eq!(folded["2026-07-13T14"][metric::SHELL_COMMAND], 2);
        assert_eq!(folded["2026-07-13T15"][metric::SHELL_COMMAND], 5);
    }

    // ── prune ──────────────────────────────────────────────────────────────

    #[test]
    fn prune_keeps_the_newest_hours_and_drops_the_oldest() {
        let mut s = UsageStats::default();
        // One more hour than the retention window, all on distinct days so the
        // day map is not what is being tested here.
        for i in 0..(HOUR_RETENTION + 1) {
            let hour = format!("2020-01-01T00-{i:05}"); // sortable, ascending
            s.hours
                .entry(hour)
                .or_default()
                .entry("p1".into())
                .or_default()
                .insert(metric::TAB_OPENED.into(), 1);
        }
        s.prune();
        assert_eq!(s.hours.len(), HOUR_RETENTION);
        assert!(
            !s.hours.contains_key("2020-01-01T00-00000"),
            "oldest dropped"
        );
        assert!(
            s.hours
                .contains_key(&format!("2020-01-01T00-{:05}", HOUR_RETENTION)),
            "newest kept"
        );
    }

    #[test]
    fn prune_keeps_the_newest_days_and_drops_the_oldest() {
        let mut s = UsageStats::default();
        for i in 0..(DAY_RETENTION + 1) {
            let day = format!("2020-{i:05}"); // sortable, ascending
            s.days
                .entry(day)
                .or_default()
                .entry("p1".into())
                .or_default()
                .insert(metric::TAB_OPENED.into(), 1);
        }
        s.prune();
        assert_eq!(s.days.len(), DAY_RETENTION);
        assert!(!s.days.contains_key("2020-00000"), "oldest dropped");
        assert!(
            s.days.contains_key(&format!("2020-{:05}", DAY_RETENTION)),
            "newest kept"
        );
    }

    #[test]
    fn prune_under_the_limit_changes_nothing() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", metric::TAB_OPENED, 1);
        s.prune();
        assert_eq!(s.days.len(), 1);
        assert_eq!(s.hours.len(), 1);
    }

    // ── serde ──────────────────────────────────────────────────────────────

    #[test]
    fn roundtrips_through_json() {
        let mut s = UsageStats::default();
        s.add("p1", "2026-07-13T14", "agent.prompt.claude", 37);
        let json = serde_json::to_string(&s).unwrap();
        let back: UsageStats = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.counters_on("p1", "2026-07-13")["agent.prompt.claude"],
            37
        );
        assert_eq!(back.version, 1);
    }

    #[test]
    fn empty_json_object_loads_as_default() {
        // Every field is #[serde(default)], so a truncated or future-written file
        // degrades to "no history" instead of failing the whole load.
        let back: UsageStats = serde_json::from_str("{}").unwrap();
        assert_eq!(back.version, 1);
        assert!(back.days.is_empty());
        assert!(back.hours.is_empty());
    }

    #[test]
    fn unknown_metric_keys_survive_a_roundtrip() {
        // The key space is open by design: a file written by a NEWER Tabtivity that
        // knows metrics this build does not must not lose them on rewrite.
        let json = r#"{"version":1,"days":{"2026-07-13":{"p1":{"future.metric":5}}}}"#;
        let back: UsageStats = serde_json::from_str(json).unwrap();
        assert_eq!(back.counters_on("p1", "2026-07-13")["future.metric"], 5);
    }
}
