//! Persisted per-project network usage (SSH-link bytes), bucketed by UTC hour
//! and UTC day.
//!
//! Companion to the live Network Traffic tab (`commands::network`), which is
//! in-memory only. The background sampler (`services::net_usage`) diffs each
//! connected remote project's ControlMaster byte counters and folds the deltas
//! in here, so a project's cumulative usage survives across tab opens/closes and
//! restarts. The frontend derives "this hour / today / this week / this month /
//! overall" from the two maps, exactly as the time-tracking tab derives its
//! totals from `time_log::activity_for`.
//!
//! Two granularities, because they have different lifetimes. Days are cheap
//! (one key per day) and kept forever, and every multi-day window — week, month,
//! overall — is a sum over them, so no separate week or month bucket is stored.
//! Hours are 24× denser, so they are pruned to [`HOUR_RETENTION`] keys; the day
//! totals they contributed to survive that pruning untouched.
//!
//! Only **SSH-link bytes per remote project** are stored: Tabtivity pools one
//! ControlMaster per active remote project, so those counters are genuinely
//! per-project. Host-wide interface counters are not attributable to a project
//! and are never recorded here, so local projects have no entry.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::storage;

/// File name of the usage store inside `state_dir()`.
pub const USAGE_FILE: &str = "net_usage.json";

/// How many hour buckets to retain — 14 days. Keys are shared across projects
/// (one key per wall-clock hour, holding every project's counts for it), so this
/// is a calendar window, not a per-project quota, and the file stays bounded no
/// matter how many remote projects exist.
pub const HOUR_RETENTION: usize = 24 * 14;

/// Received/transmitted byte totals for one (bucket, project) pair.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteCounts {
    #[serde(default)]
    pub rx: u64,
    #[serde(default)]
    pub tx: u64,
}

/// Downloaded/uploaded FILE-COUNT totals for one (bucket, project) pair — how
/// many discrete files were transferred, as opposed to [`ByteCounts`]' bytes.
/// Recorded once per file at the sync call sites (`services::remote_sync` /
/// `services::sync_auto`), whether the transfer rode the SFTP-native walker or
/// the rsync fast-path — unlike bytes, which are sampled continuously off the
/// ControlMaster link and so cover every channel (terminal, SFTP, sync, git),
/// this counts only files actually copied by the sync engine.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCounts {
    #[serde(default)]
    pub down: u64,
    #[serde(default)]
    pub up: u64,
}

/// Rolling per-project network-usage summary at two granularities: hour
/// ("YYYY-MM-DDTHH") and day ("YYYY-MM-DD"), each mapping to project_id →
/// cumulative {rx, tx} for that bucket. Bounded maps (like `TimeSummary`), so
/// folding a delta is an O(map) read-modify-write and reading one bucket is O(1).
///
/// Serialized shape:
/// ```json
/// {
///   "version": 3,
///   "hours": { "2026-07-03T14": { "<project-id>": { "rx": 12, "tx": 34 } } },
///   "days":  { "2026-07-03":    { "<project-id>": { "rx": 1234, "tx": 5678 } } },
///   "fileHours": { "2026-07-03T14": { "<project-id>": { "down": 3, "up": 1 } } },
///   "fileDays":  { "2026-07-03":    { "<project-id>": { "down": 9, "up": 4 } } }
/// }
/// ```
///
/// A version-1 file has no `hours` and loads with an empty one: history stays,
/// hourly resolution simply starts accruing from the upgrade. A version-2 file
/// has no `fileHours`/`fileDays`; those likewise start empty and accrue from
/// there — bytes history is never touched by the file-count upgrade.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetUsageSummary {
    /// Schema version. 1 = days only; 2 adds `hours`; 3 adds `fileHours`/`fileDays`.
    #[serde(default = "default_version")]
    pub version: u32,
    /// hour ("YYYY-MM-DDTHH") → project_id → cumulative {rx, tx} for that hour.
    /// Pruned to the newest [`HOUR_RETENTION`] keys on every save.
    #[serde(default)]
    pub hours: HashMap<String, HashMap<String, ByteCounts>>,
    /// date ("YYYY-MM-DD") → project_id → cumulative {rx, tx} for that day.
    #[serde(default)]
    pub days: HashMap<String, HashMap<String, ByteCounts>>,
    /// hour ("YYYY-MM-DDTHH") → project_id → cumulative {down, up} FILE counts
    /// for that hour. Same retention/pruning as `hours`.
    #[serde(default)]
    pub file_hours: HashMap<String, HashMap<String, FileCounts>>,
    /// date ("YYYY-MM-DD") → project_id → cumulative {down, up} FILE counts for
    /// that day.
    #[serde(default)]
    pub file_days: HashMap<String, HashMap<String, FileCounts>>,
}

/// A file written before `hours` existed is implicitly version 1.
fn default_version() -> u32 {
    1
}

impl Default for NetUsageSummary {
    fn default() -> Self {
        NetUsageSummary {
            version: 3,
            hours: HashMap::new(),
            days: HashMap::new(),
            file_hours: HashMap::new(),
            file_days: HashMap::new(),
        }
    }
}

impl NetUsageSummary {
    /// Cumulative {rx, tx} recorded for `project_id` on `date` ("YYYY-MM-DD").
    pub fn usage_on(&self, project_id: &str, date: &str) -> ByteCounts {
        lookup(&self.days, project_id, date)
    }

    /// Cumulative {rx, tx} recorded for `project_id` in `hour`
    /// ("YYYY-MM-DDTHH").
    pub fn usage_in_hour(&self, project_id: &str, hour: &str) -> ByteCounts {
        lookup(&self.hours, project_id, hour)
    }

    /// Add `rx`/`tx` bytes to `project_id`'s totals for the UTC hour `hour`
    /// ("YYYY-MM-DDTHH"), and to the day that hour falls in. Both buckets come
    /// from the one stamp — the day is its `YYYY-MM-DD` prefix — so they can
    /// never disagree about when the bytes moved.
    ///
    /// A zero delta is a no-op so idle projects never create empty buckets. A
    /// malformed stamp is ignored rather than panicking. Saturating so a
    /// pathological counter can never overflow.
    pub fn add(&mut self, project_id: &str, hour: &str, rx: u64, tx: u64) {
        if rx == 0 && tx == 0 {
            return;
        }
        let Some(date) = hour.get(..10) else { return };
        accrue(&mut self.hours, project_id, hour, rx, tx);
        accrue(&mut self.days, project_id, date, rx, tx);
    }

    /// Per-date totals for `project_id` (or every project when empty), matching
    /// the shape `commands::net_usage::get_net_usage` returns.
    pub fn activity_for(&self, project_id: &str) -> HashMap<String, ByteCounts> {
        fold(&self.days, project_id)
    }

    /// Per-hour totals for `project_id` (or every project when empty), over the
    /// retained window.
    pub fn hourly_for(&self, project_id: &str) -> HashMap<String, ByteCounts> {
        fold(&self.hours, project_id)
    }

    /// Cumulative {down, up} FILE counts recorded for `project_id` on `date`
    /// ("YYYY-MM-DD").
    pub fn files_on(&self, project_id: &str, date: &str) -> FileCounts {
        lookup(&self.file_days, project_id, date)
    }

    /// Cumulative {down, up} FILE counts recorded for `project_id` in `hour`
    /// ("YYYY-MM-DDTHH").
    pub fn files_in_hour(&self, project_id: &str, hour: &str) -> FileCounts {
        lookup(&self.file_hours, project_id, hour)
    }

    /// Add `down`/`up` FILE counts to `project_id`'s totals for the UTC hour
    /// `hour`, and to the day it falls in — same shape as [`Self::add`], one
    /// call per file transferred rather than per byte delta.
    pub fn add_files(&mut self, project_id: &str, hour: &str, down: u64, up: u64) {
        if down == 0 && up == 0 {
            return;
        }
        let Some(date) = hour.get(..10) else { return };
        accrue(&mut self.file_hours, project_id, hour, down, up);
        accrue(&mut self.file_days, project_id, date, down, up);
    }

    /// Per-date FILE-count totals for `project_id` (or every project when
    /// empty), matching the shape `commands::net_usage::get_net_usage` returns.
    pub fn activity_files_for(&self, project_id: &str) -> HashMap<String, FileCounts> {
        fold(&self.file_days, project_id)
    }

    /// Per-hour FILE-count totals for `project_id` (or every project when
    /// empty), over the retained window.
    pub fn hourly_files_for(&self, project_id: &str) -> HashMap<String, FileCounts> {
        fold(&self.file_hours, project_id)
    }

    /// Drop all but the newest [`HOUR_RETENTION`] hour buckets, for both the
    /// byte and file-count hour maps independently. Keys sort lexicographically
    /// in chronological order (fixed-width, zero-padded), so this needs no date
    /// arithmetic and no clock read — which also means a backdated or
    /// clock-skewed key can never evict live ones out of order. Day buckets are
    /// untouched: the pruned hours' totals already live there.
    pub fn prune_hours(&mut self) {
        prune_hour_map(&mut self.hours);
        prune_hour_map(&mut self.file_hours);
    }
}

/// Shared pruning body for an hour-keyed bucket map, generic over the payload
/// type so it serves both `hours` (bytes) and `file_hours` (file counts).
fn prune_hour_map<T>(hours: &mut HashMap<String, HashMap<String, T>>) {
    if hours.len() <= HOUR_RETENTION {
        return;
    }
    let mut keys: Vec<&str> = hours.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let cutoff = keys[keys.len() - HOUR_RETENTION].to_string();
    hours.retain(|hour, _| *hour >= cutoff);
}

/// A per-bucket payload holding two independent `u64` counters (`ByteCounts`'
/// rx/tx, `FileCounts`' down/up), so `lookup`/`accrue`/`fold` below serve both
/// maps in `NetUsageSummary` instead of being duplicated per payload type.
trait PairCounts: Copy + Default {
    fn from_pair(a: u64, b: u64) -> Self;
    fn merge(&mut self, other: Self);
}

impl PairCounts for ByteCounts {
    fn from_pair(rx: u64, tx: u64) -> Self {
        ByteCounts { rx, tx }
    }
    fn merge(&mut self, other: Self) {
        self.rx = self.rx.saturating_add(other.rx);
        self.tx = self.tx.saturating_add(other.tx);
    }
}

impl PairCounts for FileCounts {
    fn from_pair(down: u64, up: u64) -> Self {
        FileCounts { down, up }
    }
    fn merge(&mut self, other: Self) {
        self.down = self.down.saturating_add(other.down);
        self.up = self.up.saturating_add(other.up);
    }
}

/// `bucket → project → counts` lookup, defaulting to zero.
fn lookup<T: Copy + Default>(
    buckets: &HashMap<String, HashMap<String, T>>,
    project_id: &str,
    key: &str,
) -> T {
    buckets
        .get(key)
        .and_then(|by_project| by_project.get(project_id))
        .copied()
        .unwrap_or_default()
}

/// Fold `a`/`b` into `buckets[key][project_id]`, creating buckets as needed.
fn accrue<T: PairCounts>(
    buckets: &mut HashMap<String, HashMap<String, T>>,
    project_id: &str,
    key: &str,
    a: u64,
    b: u64,
) {
    let entry = buckets
        .entry(key.to_string())
        .or_default()
        .entry(project_id.to_string())
        .or_default();
    entry.merge(T::from_pair(a, b));
}

/// Collapse `bucket → project → counts` to `bucket → counts` for one project
/// (or summed across all projects when `project_id` is empty).
fn fold<T: PairCounts>(
    buckets: &HashMap<String, HashMap<String, T>>,
    project_id: &str,
) -> HashMap<String, T> {
    let mut out: HashMap<String, T> = HashMap::new();
    for (key, by_project) in buckets {
        for (pid, counts) in by_project {
            if project_id.is_empty() || pid == project_id {
                out.entry(key.clone()).or_default().merge(*counts);
            }
        }
    }
    out
}

// ── On-disk helpers ────────────────────────────────────────────────────────

fn usage_path() -> std::path::PathBuf {
    storage::state_dir().join(USAGE_FILE)
}

/// Load the usage summary, defaulting to empty when the file is absent or
/// unparseable (a brand-new install, or a partial write) rather than erroring.
pub fn load() -> NetUsageSummary {
    let path = usage_path();
    if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        NetUsageSummary::default()
    }
}

/// Persist the usage summary, pruning stale hour buckets first. Pruning lives
/// here rather than in `add` so it is impossible for a writer to skip it, and so
/// it costs one sort per flush rather than one per project.
pub fn save(summary: &mut NetUsageSummary) -> Result<(), String> {
    summary.version = 3;
    summary.prune_hours();
    storage::write_json(&usage_path(), summary).map_err(|e| e.to_string())
}

/// Fold `rx`/`tx` bytes for `project_id` into the current UTC hour (and thereby
/// the current UTC day). O(map) read-modify-write of a bounded file. A zero
/// delta is skipped without touching disk.
pub fn record(project_id: &str, rx: u64, tx: u64) {
    if project_id.is_empty() || (rx == 0 && tx == 0) {
        return;
    }
    let mut summary = load();
    summary.add(project_id, &storage::hour_utc(), rx, tx);
    let _ = save(&mut summary);
}

/// Fold a downloaded/uploaded FILE count for `project_id` into the current UTC
/// hour (and thereby the current UTC day). Called once per file actually
/// transferred by the sync engine (`services::remote_sync::pull_file` /
/// `push_file_atomic`, and the rsync fast-path's per-file manifest loop) — unlike
/// [`record`] above, which is driven by the continuous link-byte sampler. A zero
/// delta is skipped without touching disk.
pub fn record_files(project_id: &str, down: u64, up: u64) {
    if project_id.is_empty() || (down == 0 && up == 0) {
        return;
    }
    let mut summary = load();
    summary.add_files(project_id, &storage::hour_utc(), down, up);
    let _ = save(&mut summary);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_lookup_accumulates() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 100, 40);
        s.add("p1", "2026-07-03T14", 50, 10);
        s.add("p2", "2026-07-03T09", 7, 3);
        s.add("p1", "2026-07-02T23", 9, 1);
        assert_eq!(
            s.usage_on("p1", "2026-07-03"),
            ByteCounts { rx: 150, tx: 50 }
        );
        assert_eq!(s.usage_on("p2", "2026-07-03"), ByteCounts { rx: 7, tx: 3 });
        assert_eq!(s.usage_on("p1", "2026-07-02"), ByteCounts { rx: 9, tx: 1 });
        assert_eq!(s.usage_on("missing", "2026-07-03"), ByteCounts::default());
        assert_eq!(s.usage_on("p1", "1999-01-01"), ByteCounts::default());
    }

    #[test]
    fn add_splits_the_day_into_hours() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 100, 40);
        s.add("p1", "2026-07-03T09", 5, 2);
        s.add("p1", "2026-07-03T14", 50, 10);
        assert_eq!(
            s.usage_in_hour("p1", "2026-07-03T09"),
            ByteCounts { rx: 105, tx: 42 }
        );
        assert_eq!(
            s.usage_in_hour("p1", "2026-07-03T14"),
            ByteCounts { rx: 50, tx: 10 }
        );
        assert_eq!(
            s.usage_in_hour("p1", "2026-07-03T10"),
            ByteCounts::default()
        );
        // The day is the sum of its hours, from the same stamps.
        assert_eq!(
            s.usage_on("p1", "2026-07-03"),
            ByteCounts { rx: 155, tx: 52 }
        );
    }

    #[test]
    fn add_ignores_zero_delta() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 0, 0);
        assert!(s.days.is_empty());
        assert!(s.hours.is_empty());
        // A one-sided delta still records.
        s.add("p1", "2026-07-03T09", 0, 5);
        assert_eq!(s.usage_on("p1", "2026-07-03"), ByteCounts { rx: 0, tx: 5 });
        assert_eq!(
            s.usage_in_hour("p1", "2026-07-03T09"),
            ByteCounts { rx: 0, tx: 5 }
        );
    }

    #[test]
    fn add_ignores_malformed_stamp() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07", 100, 40);
        s.add("p1", "", 100, 40);
        assert!(s.days.is_empty());
        assert!(s.hours.is_empty());
    }

    #[test]
    fn add_saturates_instead_of_overflowing() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", u64::MAX, u64::MAX);
        s.add("p1", "2026-07-03T10", 10, 10);
        assert_eq!(
            s.usage_on("p1", "2026-07-03"),
            ByteCounts {
                rx: u64::MAX,
                tx: u64::MAX
            }
        );
    }

    #[test]
    fn activity_for_aggregates_per_date() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 100, 20);
        s.add("p2", "2026-07-03T09", 5, 1);
        s.add("p1", "2026-07-02T09", 9, 3);

        let p1 = s.activity_for("p1");
        assert_eq!(p1.get("2026-07-03"), Some(&ByteCounts { rx: 100, tx: 20 }));
        assert_eq!(p1.get("2026-07-02"), Some(&ByteCounts { rx: 9, tx: 3 }));
        assert_eq!(p1.get("2026-07-01"), None);

        let all = s.activity_for("");
        assert_eq!(all.get("2026-07-03"), Some(&ByteCounts { rx: 105, tx: 21 }));
        assert_eq!(all.get("2026-07-02"), Some(&ByteCounts { rx: 9, tx: 3 }));
    }

    #[test]
    fn hourly_for_aggregates_per_hour() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 100, 20);
        s.add("p2", "2026-07-03T09", 5, 1);
        s.add("p1", "2026-07-03T10", 9, 3);

        let p1 = s.hourly_for("p1");
        assert_eq!(
            p1.get("2026-07-03T09"),
            Some(&ByteCounts { rx: 100, tx: 20 })
        );
        assert_eq!(p1.get("2026-07-03T10"), Some(&ByteCounts { rx: 9, tx: 3 }));
        assert_eq!(p1.get("2026-07-03T11"), None);

        let all = s.hourly_for("");
        assert_eq!(
            all.get("2026-07-03T09"),
            Some(&ByteCounts { rx: 105, tx: 21 })
        );
    }

    #[test]
    fn day_rollover_keys_separately() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T23", 100, 0);
        s.add("p1", "2026-07-04T00", 200, 0);
        assert_eq!(s.usage_on("p1", "2026-07-03").rx, 100);
        assert_eq!(s.usage_on("p1", "2026-07-04").rx, 200);
        assert_eq!(s.days.len(), 2);
        assert_eq!(s.hours.len(), 2);
    }

    #[test]
    fn prune_hours_keeps_the_newest_window_and_all_days() {
        let mut s = NetUsageSummary::default();
        // 20 days × 24 h, oldest first.
        for day in 1..=20u32 {
            for hour in 0..24u32 {
                s.add("p1", &format!("2026-06-{day:02}T{hour:02}"), 10, 1);
            }
        }
        assert_eq!(s.hours.len(), 20 * 24);
        s.prune_hours();

        assert_eq!(s.hours.len(), HOUR_RETENTION);
        // Days 7..=20 are the newest 14; day 6 and earlier are gone.
        assert_eq!(
            s.usage_in_hour("p1", "2026-06-20T23"),
            ByteCounts { rx: 10, tx: 1 }
        );
        assert_eq!(
            s.usage_in_hour("p1", "2026-06-07T00"),
            ByteCounts { rx: 10, tx: 1 }
        );
        assert_eq!(
            s.usage_in_hour("p1", "2026-06-06T23"),
            ByteCounts::default()
        );
        assert_eq!(
            s.usage_in_hour("p1", "2026-06-01T00"),
            ByteCounts::default()
        );
        // Pruning hours never touches the day totals they fed.
        assert_eq!(s.days.len(), 20);
        assert_eq!(
            s.usage_on("p1", "2026-06-01"),
            ByteCounts { rx: 240, tx: 24 }
        );
    }

    #[test]
    fn prune_hours_is_a_noop_under_the_cap() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 1, 1);
        s.prune_hours();
        assert_eq!(s.hours.len(), 1);
    }

    #[test]
    fn summary_roundtrips_through_json() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 42, 7);
        let json = serde_json::to_string(&s).unwrap();
        let back: NetUsageSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.usage_on("p1", "2026-07-03"),
            ByteCounts { rx: 42, tx: 7 }
        );
        assert_eq!(
            back.usage_in_hour("p1", "2026-07-03T09"),
            ByteCounts { rx: 42, tx: 7 }
        );
        assert_eq!(back.version, 3);
    }

    #[test]
    fn deserializes_empty_object_with_defaults() {
        let back: NetUsageSummary = serde_json::from_str("{}").unwrap();
        assert_eq!(back.version, 1);
        assert!(back.days.is_empty());
        assert!(back.hours.is_empty());
        assert!(back.file_days.is_empty());
        assert!(back.file_hours.is_empty());
    }

    #[test]
    fn version_1_file_loads_with_days_intact_and_empty_hours() {
        let json = r#"{
            "version": 1,
            "days": { "2026-07-03": { "p1": { "rx": 500, "tx": 100 } } }
        }"#;
        let mut back: NetUsageSummary = serde_json::from_str(json).unwrap();
        assert_eq!(
            back.usage_on("p1", "2026-07-03"),
            ByteCounts { rx: 500, tx: 100 }
        );
        assert!(back.hours.is_empty());
        // Hourly resolution starts accruing from here; the old day total stands.
        back.add("p1", "2026-07-03T09", 1, 1);
        assert_eq!(
            back.usage_on("p1", "2026-07-03"),
            ByteCounts { rx: 501, tx: 101 }
        );
        assert_eq!(
            back.usage_in_hour("p1", "2026-07-03T09"),
            ByteCounts { rx: 1, tx: 1 }
        );
    }

    #[test]
    fn add_files_accumulates_independently_of_bytes() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03T09", 100, 40); // bytes
        s.add_files("p1", "2026-07-03T09", 3, 0); // 3 files downloaded
        s.add_files("p1", "2026-07-03T09", 0, 1); // 1 file uploaded
        s.add_files("p1", "2026-07-02T23", 5, 2);

        assert_eq!(
            s.files_on("p1", "2026-07-03"),
            FileCounts { down: 3, up: 1 }
        );
        assert_eq!(
            s.files_in_hour("p1", "2026-07-03T09"),
            FileCounts { down: 3, up: 1 }
        );
        assert_eq!(
            s.files_on("p1", "2026-07-02"),
            FileCounts { down: 5, up: 2 }
        );
        // Byte totals are untouched by file-count recording.
        assert_eq!(
            s.usage_on("p1", "2026-07-03"),
            ByteCounts { rx: 100, tx: 40 }
        );
    }

    #[test]
    fn add_files_ignores_zero_delta_and_malformed_stamp() {
        let mut s = NetUsageSummary::default();
        s.add_files("p1", "2026-07-03T09", 0, 0);
        s.add_files("p1", "2026-07", 1, 0);
        assert!(s.file_days.is_empty());
        assert!(s.file_hours.is_empty());
    }

    #[test]
    fn activity_files_for_and_hourly_files_for_aggregate_across_projects() {
        let mut s = NetUsageSummary::default();
        s.add_files("p1", "2026-07-03T09", 2, 0);
        s.add_files("p2", "2026-07-03T09", 1, 1);
        s.add_files("p1", "2026-07-03T10", 0, 4);

        let p1_days = s.activity_files_for("p1");
        assert_eq!(
            p1_days.get("2026-07-03"),
            Some(&FileCounts { down: 2, up: 4 })
        );

        let all_hours = s.hourly_files_for("");
        assert_eq!(
            all_hours.get("2026-07-03T09"),
            Some(&FileCounts { down: 3, up: 1 })
        );
    }

    #[test]
    fn prune_hours_prunes_file_hours_independently_of_byte_hours() {
        let mut s = NetUsageSummary::default();
        for day in 1..=20u32 {
            for hour in 0..24u32 {
                s.add_files("p1", &format!("2026-06-{day:02}T{hour:02}"), 1, 0);
            }
        }
        assert_eq!(s.file_hours.len(), 20 * 24);
        s.prune_hours();
        assert_eq!(s.file_hours.len(), HOUR_RETENTION);
        assert_eq!(s.file_days.len(), 20); // day totals survive hour pruning
        assert_eq!(
            s.files_on("p1", "2026-06-01"),
            FileCounts { down: 24, up: 0 }
        );
    }

    #[test]
    fn file_counts_roundtrip_through_json() {
        let mut s = NetUsageSummary::default();
        s.add_files("p1", "2026-07-03T09", 6, 2);
        let json = serde_json::to_string(&s).unwrap();
        let back: NetUsageSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.files_on("p1", "2026-07-03"),
            FileCounts { down: 6, up: 2 }
        );
        assert_eq!(
            back.files_in_hour("p1", "2026-07-03T09"),
            FileCounts { down: 6, up: 2 }
        );
    }
}
