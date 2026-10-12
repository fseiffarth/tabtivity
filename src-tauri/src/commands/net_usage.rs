use std::collections::HashMap;

use serde::Serialize;

use crate::schema::net_usage::{self, ByteCounts, FileCounts};

/// Persisted SSH-link byte and FILE-count totals for one project, at both
/// stored granularities. The frontend derives every window from these:
/// this-hour from `hours`/`fileHours`; today, this week, this month and
/// overall from `days`/`fileDays`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetUsageReport {
    /// "YYYY-MM-DDTHH" (UTC) → { rx, tx }, over the retained hour window.
    pub hours: HashMap<String, ByteCounts>,
    /// "YYYY-MM-DD" (UTC) → { rx, tx }, full history.
    pub days: HashMap<String, ByteCounts>,
    /// "YYYY-MM-DDTHH" (UTC) → { down, up } files transferred, over the
    /// retained hour window.
    pub file_hours: HashMap<String, FileCounts>,
    /// "YYYY-MM-DD" (UTC) → { down, up } files transferred, full history.
    pub file_days: HashMap<String, FileCounts>,
}

/// Per-hour and per-date SSH-link byte and file-count totals for `project_id`
/// (or every project when empty). All four maps come from one load, so a flush
/// between them can never leave the views disagreeing. Recording is internal
/// (bytes from the `services::net_usage` sampler, file counts from the sync
/// engine), so there is no companion write command — mirrors
/// `commands::timer::get_project_activity`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_net_usage(project_id: String) -> NetUsageReport {
    let summary = net_usage::load();
    NetUsageReport {
        hours: summary.hourly_for(&project_id),
        days: summary.activity_for(&project_id),
        file_hours: summary.hourly_files_for(&project_id),
        file_days: summary.activity_files_for(&project_id),
    }
}
