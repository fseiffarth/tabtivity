use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage;

// ── Legacy append-only model ───────────────────────────────────────────────

/// One session record in the legacy `~/.local/share/tabtivity/time_log.json`.
///
/// Kept for backward-compatible migration: older installs (and, until it is
/// migrated too, `commands::timer`) write an unbounded `Vec` of these. The
/// rolling daily-summary model below supersedes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeLogEntry {
    pub project_id: String,
    /// "YYYY-MM-DD"
    pub date: String,
    /// ISO-8601 timestamp with timezone (e.g. "2026-05-25T21:23:53.674831+00:00")
    pub start_iso: String,
    pub duration_s: f64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Full legacy `time_log.json` — append-only list of completed sessions.
pub type TimeLog = Vec<TimeLogEntry>;

// ── Rolling daily-summary model (Efficiency #2/#12) ────────────────────────

/// File name of the rolling daily-summary store inside `state_dir()`.
pub const SUMMARY_FILE: &str = "time_summary.json";
/// File name of the legacy append-only log inside `state_dir()`.
pub const LEGACY_LOG_FILE: &str = "time_log.json";

/// Rolling daily time summary: a bounded map keyed by date → project_id →
/// total seconds. This replaces the unbounded append-only `Vec<TimeLogEntry>`
/// so that flushing a session is an O(#dates × #projects) read-modify-write of
/// a small map (rather than growing every flush), and reading "today's" total
/// for a project is an O(1) map lookup (rather than a full deserialize +
/// linear scan that grew with installation age).
///
/// Serialized shape:
/// ```json
/// {
///   "version": 1,
///   "migrated": true,
///   "days": { "2026-06-22": { "<project-id>": 1234.0, "__tabtivity__": 999.0 } }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeSummary {
    /// Schema version for forward compatibility.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Whether the legacy `time_log.json` has already been folded in (so we do
    /// not double-count it on subsequent loads).
    #[serde(default)]
    pub migrated: bool,
    /// date ("YYYY-MM-DD") → project_id → total seconds for that day.
    #[serde(default)]
    pub days: HashMap<String, HashMap<String, f64>>,
}

fn default_version() -> u32 {
    1
}

impl Default for TimeSummary {
    fn default() -> Self {
        TimeSummary {
            version: 1,
            migrated: false,
            days: HashMap::new(),
        }
    }
}

impl TimeSummary {
    /// Total seconds recorded for `project_id` on `date`.
    pub fn seconds_on(&self, project_id: &str, date: &str) -> f64 {
        self.days
            .get(date)
            .and_then(|by_project| by_project.get(project_id))
            .copied()
            .unwrap_or(0.0)
    }

    /// Add `secs` to `project_id`'s total for `date` (creating buckets as
    /// needed). Negative or non-finite values are ignored.
    pub fn add(&mut self, project_id: &str, date: &str, secs: f64) {
        if !secs.is_finite() || secs <= 0.0 {
            return;
        }
        let by_project = self.days.entry(date.to_string()).or_default();
        *by_project.entry(project_id.to_string()).or_insert(0.0) += secs;
    }

    /// Collapse a list of legacy entries into this summary.
    pub fn fold_legacy(&mut self, entries: &[TimeLogEntry]) {
        for entry in entries {
            self.add(&entry.project_id, &entry.date, entry.duration_s);
        }
    }

    /// Per-date totals for `project_id` (or every project when empty), matching
    /// the shape `commands::timer::get_project_activity` returns.
    pub fn activity_for(&self, project_id: &str) -> HashMap<String, f64> {
        let mut out: HashMap<String, f64> = HashMap::new();
        for (date, by_project) in &self.days {
            for (pid, secs) in by_project {
                if project_id.is_empty() || pid == project_id {
                    *out.entry(date.clone()).or_insert(0.0) += *secs;
                }
            }
        }
        out
    }
}

// ── On-disk helpers ────────────────────────────────────────────────────────

fn summary_path() -> std::path::PathBuf {
    storage::state_dir().join(SUMMARY_FILE)
}

fn legacy_log_path() -> std::path::PathBuf {
    storage::state_dir().join(LEGACY_LOG_FILE)
}

static TIME_SUMMARY_LOCK: Mutex<()> = Mutex::new(());

fn lock_summary() -> std::sync::MutexGuard<'static, ()> {
    TIME_SUMMARY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Load the rolling summary, migrating the legacy `time_log.json` in once if it
/// has not been folded in yet. The migration is recorded (`migrated = true`)
/// and persisted so subsequent loads are a single small-file read.
///
/// Backward compatibility: an install that only ever wrote the legacy log will
/// have its history preserved on first load here; the legacy file is left in
/// place untouched (so a rollback to an older Tabtivity still sees its data).
fn load_summary_migrating_unlocked() -> Result<TimeSummary, String> {
    let path = summary_path();
    let mut summary: TimeSummary = if path.exists() {
        storage::read_json(&path).map_err(|e| e.to_string())?
    } else {
        TimeSummary::default()
    };

    if !summary.migrated {
        let legacy = legacy_log_path();
        if legacy.exists() {
            let entries = storage::read_json::<TimeLog>(&legacy).map_err(|e| e.to_string())?;
            summary.fold_legacy(&entries);
        }
        summary.migrated = true;
        storage::write_json_atomic(&path, &summary).map_err(|e| e.to_string())?;
    }

    Ok(summary)
}

pub fn load_summary_migrating() -> Result<TimeSummary, String> {
    let _guard = lock_summary();
    load_summary_migrating_unlocked()
}

/// Persist the rolling summary.
pub fn save_summary(summary: &TimeSummary) -> Result<(), String> {
    let _guard = lock_summary();
    storage::write_json_atomic(&summary_path(), summary).map_err(|e| e.to_string())
}

/// Mutate the rolling summary under the same lock used by timer flushes and
/// migration. Existing-file parse failures abort without replacing the file.
pub fn patch_summary(
    patch: impl FnOnce(&mut TimeSummary) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = lock_summary();
    let mut summary = load_summary_migrating_unlocked()?;
    patch(&mut summary)?;
    storage::write_json_atomic(&summary_path(), &summary).map_err(|e| e.to_string())
}

/// Record `secs` of activity for `project_id` on the current UTC day in the
/// rolling summary. O(map) read-modify-write of a bounded file rather than an
/// append to an unbounded log.
pub fn record_secs(project_id: &str, secs: f64) -> Result<(), String> {
    if !secs.is_finite() || secs <= 0.0 {
        return Ok(());
    }
    let date = storage::today_utc();
    patch_summary(|summary| {
        summary.add(project_id, &date, secs);
        Ok(())
    })
}

/// Total seconds recorded for `project_id` on the current UTC day.
pub fn today_secs(project_id: &str) -> Result<f64, String> {
    Ok(load_summary_migrating()?.seconds_on(project_id, &storage::today_utc()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: &str, date: &str, secs: f64) -> TimeLogEntry {
        TimeLogEntry {
            project_id: pid.to_string(),
            date: date.to_string(),
            start_iso: format!("{date}T00:00:00+00:00"),
            duration_s: secs,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn add_and_lookup_accumulates() {
        let mut s = TimeSummary::default();
        s.add("p1", "2026-06-22", 100.0);
        s.add("p1", "2026-06-22", 50.0);
        s.add("p2", "2026-06-22", 7.0);
        s.add("p1", "2026-06-21", 9.0);
        assert_eq!(s.seconds_on("p1", "2026-06-22"), 150.0);
        assert_eq!(s.seconds_on("p2", "2026-06-22"), 7.0);
        assert_eq!(s.seconds_on("p1", "2026-06-21"), 9.0);
        assert_eq!(s.seconds_on("missing", "2026-06-22"), 0.0);
        assert_eq!(s.seconds_on("p1", "1999-01-01"), 0.0);
    }

    #[test]
    fn add_ignores_nonpositive_and_nonfinite() {
        let mut s = TimeSummary::default();
        s.add("p1", "2026-06-22", 0.0);
        s.add("p1", "2026-06-22", -5.0);
        s.add("p1", "2026-06-22", f64::NAN);
        s.add("p1", "2026-06-22", f64::INFINITY);
        assert_eq!(s.seconds_on("p1", "2026-06-22"), 0.0);
        assert!(s.days.is_empty());
    }

    #[test]
    fn fold_legacy_matches_manual_sum() {
        let entries = vec![
            entry("p1", "2026-06-22", 100.0),
            entry("p1", "2026-06-22", 25.0),
            entry("p2", "2026-06-20", 60.0),
        ];
        let mut s = TimeSummary::default();
        s.fold_legacy(&entries);
        assert_eq!(s.seconds_on("p1", "2026-06-22"), 125.0);
        assert_eq!(s.seconds_on("p2", "2026-06-20"), 60.0);
    }

    #[test]
    fn activity_for_aggregates_per_date() {
        let mut s = TimeSummary::default();
        s.add("p1", "2026-06-22", 100.0);
        s.add("p2", "2026-06-22", 5.0);
        s.add("p1", "2026-06-21", 9.0);

        let p1 = s.activity_for("p1");
        assert_eq!(p1.get("2026-06-22"), Some(&100.0));
        assert_eq!(p1.get("2026-06-21"), Some(&9.0));
        assert_eq!(p1.get("2026-06-20"), None);

        let all = s.activity_for("");
        assert_eq!(all.get("2026-06-22"), Some(&105.0));
        assert_eq!(all.get("2026-06-21"), Some(&9.0));
    }

    #[test]
    fn summary_roundtrips_through_json() {
        let mut s = TimeSummary::default();
        s.add("p1", "2026-06-22", 42.0);
        let json = serde_json::to_string(&s).unwrap();
        let back: TimeSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(back.seconds_on("p1", "2026-06-22"), 42.0);
        assert_eq!(back.version, 1);
    }

    #[test]
    fn deserializes_legacy_shaped_missing_fields() {
        // A summary written by a future/older build missing optional fields
        // still loads with sane defaults.
        let back: TimeSummary = serde_json::from_str("{}").unwrap();
        assert_eq!(back.version, 1);
        assert!(!back.migrated);
        assert!(back.days.is_empty());
    }
}
