use std::collections::HashMap;

use crate::schema::time_log;

pub const APP_TIMER_ID: &str = crate::brand::APP_TIMER_ID;

/// Flush elapsed app (Tabtivity itself) usage seconds into the time log.
#[tauri::command]
pub fn timer_flush_app(secs: f64) -> Result<(), String> {
    if secs <= 0.0 {
        return Ok(());
    }
    time_log::record_secs(APP_TIMER_ID, secs)
}

/// Flush elapsed project session seconds into the time log.
#[tauri::command]
pub fn timer_flush_project(project_id: String, secs: f64) -> Result<(), String> {
    if secs <= 0.0 || project_id.is_empty() {
        return Ok(());
    }
    time_log::record_secs(&project_id, secs)
}

/// Returns total seconds per date for the given project_id (or global if empty).
/// Result: { "YYYY-MM-DD" -> total_seconds }
#[tauri::command]
pub fn get_project_activity(project_id: String) -> Result<HashMap<String, f64>, String> {
    Ok(time_log::load_summary_migrating()?.activity_for(&project_id))
}

/// The whole time summary, unfolded: `{ "YYYY-MM-DD" -> { project_id -> secs } }`.
///
/// The usage recap needs *every* project's time for a period ("work spent per
/// project"), which through [`get_project_activity`] would mean one call — and one
/// full read of the summary file — per project. This hands back the map the store
/// already holds, in a single read.
#[tauri::command]
pub fn get_time_activity_all() -> Result<HashMap<String, HashMap<String, f64>>, String> {
    Ok(time_log::load_summary_migrating()?.days)
}
