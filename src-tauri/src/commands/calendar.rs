//! Native calendar — a single global, local store of calendars, events and tasks.
//!
//! Everything lives in `~/.local/share/tabtivity/calendar.json` (like `boxes.json`),
//! read/written through the shared `storage` helpers. Reads go through
//! `schema::calendar::CalendarFile`, so a version-1 file (a bare array of
//! start-time-only events) still loads and is migrated on the way in; writes are
//! always the current shape.
//!
//! The CRUD logic is factored onto a `&Path` so the `#[tauri::command]` wrappers
//! stay thin (they just pass `calendar_path()`) and the tests can drive a tempdir.
//!
//! The backend deliberately stays dumb about calendar *semantics*: it does not
//! expand recurrences, evaluate alarms, or parse ICS. Those are pure functions in
//! the frontend (`src/lib/{recurrence,ics,calendarTime}.ts`) where they are cheap
//! to unit-test. This module is storage plus identity.

use std::path::{Path, PathBuf};

use crate::schema::calendar::{Calendar, CalendarData, CalendarEvent, CalendarTask, TaskColumn};
// The store lives in `services::calendar_store` (S5); every item keeps
// resolving here for the commands and their other callers.
pub(crate) use crate::services::calendar_store::*;

// ── ICS file I/O ────────────────────────────────────────────────────────────
//
// Import/export need to touch a path *outside* any project — wherever the user
// pointed the file dialog. The general-purpose `fs::read_file_text` /
// `write_file_text` commands deliberately refuse that: they confine every path to
// the current project's roots, precisely so a compromised renderer cannot read
// `~/.ssh/id_rsa` or overwrite arbitrary files (Security #1). That confinement is
// worth keeping, so instead of widening it these two commands open a much narrower
// door: an iCalendar file, and nothing else.
//
// The guards are the door's width — an extension allowlist (so the path cannot
// name a key, a config, or a document) and a size cap (so a "calendar" cannot be
// used to slurp a huge file into the renderer). Parsing itself stays in the
// frontend (`src/lib/calendar/ics.ts`), where it is unit-tested; these only move bytes.

/// Extensions an ICS path may carry. Anything else is refused outright.
const ICS_EXTENSIONS: [&str; 3] = ["ics", "ical", "ifb"];

/// Size cap for an imported/exported calendar (8 MiB — a decade of events is a
/// few hundred KiB, so this is generous while still bounding the read).
const MAX_ICS_BYTES: u64 = 8 * 1024 * 1024;

fn check_ics_path(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ICS_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "not a calendar file: expected one of {}, got '{}'",
            ICS_EXTENSIONS.join(", "),
            if ext.is_empty() { "no extension" } else { &ext }
        ));
    }
    Ok(())
}

// Offload a blocking calendar-store body to a worker thread. Every command
// below is a whole-file read (or read-modify-write) of `calendar.json` —
// written on every board drag — plus the user-picked `.ics` reads/writes; run
// synchronously on the main thread that turns into jank as CalDAV calendars
// grow (the freeze class `commands::git`'s off-thread note describes).
// The `*_at` bodies stay sync and directly unit-testable.

/// Read an `.ics` file the user picked, for the frontend parser.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn calendar_read_ics(path: String) -> Result<String, String> {
    app_core::rt::try_blocking("calendar", move || calendar_read_ics_blocking(path)).await
}

fn calendar_read_ics_blocking(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    check_ics_path(&p)?;

    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_ICS_BYTES {
        return Err(format!(
            "calendar file too large ({} bytes; limit {MAX_ICS_BYTES})",
            meta.len()
        ));
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Write an `.ics` file to the path the user picked.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn calendar_write_ics(path: String, content: String) -> Result<(), String> {
    app_core::rt::try_blocking("calendar", move || calendar_write_ics_blocking(path, content)).await
}

fn calendar_write_ics_blocking(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    check_ics_path(&p)?;
    if content.len() as u64 > MAX_ICS_BYTES {
        return Err("calendar export too large".to_string());
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

/// Fetch an `.ics` subscription feed (e.g. TimeTree's calendar-export URL) for
/// the frontend parser. This is the one command in this file that reaches the
/// network, and it does so only on an explicit "Refresh from URL" click —
/// never on a timer — through the same SSRF-guarded fetch the in-app browser's
/// reader mode uses (`services::browser_engine::fetch_ics`).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn calendar_fetch_ics(url: String) -> Result<String, String> {
    crate::services::browser_engine::fetch_ics(&url).await
}

/// Claim reminders as fired before showing them (headless owner plan, H2):
/// answers the keys nobody had claimed yet — another window, or the Mobile
/// sidecar with no window open, may have shown one already — and records
/// them all (`services::calendar_alarms`).
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn calendar_alarms_claim(keys: Vec<String>) -> Result<Vec<String>, String> {
    crate::services::calendar_alarms::claim(&keys)
}

/// Replace `calendar_id`'s events/tasks with a freshly parsed set, in one
/// atomic write.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn calendar_replace_events(
    calendar_id: String,
    events: Vec<CalendarEvent>,
    tasks: Vec<CalendarTask>,
) -> Result<CalendarData, String> {
    // A shared calendar lives in the server's calendar service: a bulk
    // write would put its records into `calendar.json` beside it.
    if crate::services::server::shared_calendar::is_shared_id(&calendar_id) {
        return Err("A shared calendar cannot be replaced in bulk; import into a calendar of your own".to_string());
    }
    app_core::rt::try_blocking("calendar", move || replace_calendar_events_at(&calendar_path(), &calendar_id, events, tasks))
        .await
}

// ── Commands ────────────────────────────────────────────────────────────────

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn calendar_load() -> Result<CalendarData, String> {
    app_core::rt::try_blocking("calendar", move || {
        let mut data = read_data(&calendar_path())?;
        // A hosted server: the calendars other users opened to this one, and
        // this user's own shared ones (plan §6.7).
        if let Some(shared) = crate::services::server::shared_calendar::global() {
            shared.merge_into(&mut data);
        }
        Ok(data)
    })
    .await
}

/// Replace the whole store. Used by ICS import, which rewrites in bulk.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn calendar_save(mut data: CalendarData) -> Result<(), String> {
    // Shared calendars live in the server's calendar service, never here.
    crate::services::server::shared_calendar::strip_shared(&mut data);
    app_core::rt::try_blocking("calendar", move || save_document_at(&calendar_path(), data)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_event(event: CalendarEvent) -> Result<CalendarEvent, String> {
    app_core::rt::try_blocking("calendar", move || {
        if let Some(routed) = shared().and_then(|s| s.put_event(&event, false)) {
            return routed;
        }
        create_event_at(&calendar_path(), event)
    })
    .await
}

/// The server's shared calendars, when this is a server daemon.
fn shared() -> Option<&'static crate::services::server::shared_calendar::Shared> {
    crate::services::server::shared_calendar::global()
}

/// Is there a record `id` in `calendar.json` (a shared calendar's edit must
/// not take a private record along)?
fn exists_locally(id: &str, events: bool) -> bool {
    !id.is_empty()
        && read_data(&calendar_path()).is_ok_and(|d| if events { d.events.iter().any(|e| e.id == id) } else { d.tasks.iter().any(|t| t.id == id) })
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_event(event: CalendarEvent) -> Result<CalendarEvent, String> {
    app_core::rt::try_blocking("calendar", move || {
        if let Some(routed) = shared().and_then(|s| s.put_event(&event, exists_locally(&event.id, true))) {
            return routed;
        }
        update_event_at(&calendar_path(), event)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_event(id: String) -> Result<(), String> {
    app_core::rt::try_blocking("calendar", move || {
        if let Some(routed) = shared().and_then(|s| s.delete_event(&id)) {
            return routed;
        }
        delete_event_at(&calendar_path(), &id)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_task(task: CalendarTask) -> Result<CalendarTask, String> {
    app_core::rt::try_blocking("calendar", move || {
        if let Some(routed) = shared().and_then(|s| s.put_task(&task, false)) {
            return routed;
        }
        create_task_at(&calendar_path(), task)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_task(task: CalendarTask) -> Result<CalendarTask, String> {
    app_core::rt::try_blocking("calendar", move || {
        if let Some(routed) = shared().and_then(|s| s.put_task(&task, exists_locally(&task.id, false))) {
            return routed;
        }
        update_task_at(&calendar_path(), task)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_task(id: String) -> Result<(), String> {
    app_core::rt::try_blocking("calendar", move || {
        if let Some(routed) = shared().and_then(|s| s.delete_task(&id)) {
            return routed;
        }
        delete_task_at(&calendar_path(), &id)
    })
    .await
}

/// Apply a board drag. See [`move_tasks_at`].
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn todo_move_tasks(moves: Vec<TaskPlacement>) -> Result<Vec<CalendarTask>, String> {
    app_core::rt::try_blocking("calendar", move || {
        // A shared to-do list's card moves to its new column through the
        // calendar service (its place within the column is not shared in
        // v1); every other card as before.
        let Some(shared) = shared() else { return move_tasks_at(&calendar_path(), moves) };
        let (remote, local): (Vec<TaskPlacement>, Vec<TaskPlacement>) = moves.into_iter().partition(|m| shared.holds_task(&m.id));
        let mut out = Vec::new();
        for placement in remote {
            let Some(mut task) = shared.task(&placement.id) else { continue };
            task.column = placement.column;
            if let Some(routed) = shared.put_task(&task, false) {
                out.push(routed?);
            }
        }
        if !local.is_empty() {
            out.extend(move_tasks_at(&calendar_path(), local)?);
        }
        Ok(out)
    })
    .await
}

/// Replace the board's columns. See [`columns_set_at`].
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn todo_columns_set(
    columns: Vec<TaskColumn>,
    fallback_column: Option<String>,
) -> Result<CalendarData, String> {
    app_core::rt::try_blocking("calendar", move || columns_set_at(&calendar_path(), columns, fallback_column)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_calendar(calendar: Calendar) -> Result<Calendar, String> {
    app_core::rt::try_blocking("calendar", move || create_calendar_at(&calendar_path(), calendar)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_calendar(calendar: Calendar) -> Result<Calendar, String> {
    app_core::rt::try_blocking("calendar", move || {
        // A shared calendar's only setting here is this user's own checkbox.
        if let (Some(shared), true) = (shared(), crate::services::server::shared_calendar::is_shared_id(&calendar.id)) {
            shared.set_visible(&calendar.id, calendar.visible)?;
            return Ok(calendar);
        }
        update_calendar_at(&calendar_path(), calendar)
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_calendar(id: String) -> Result<(), String> {
    if crate::services::server::shared_calendar::is_shared_id(&id) {
        return Err("A shared calendar is deleted by stopping sharing it (Server settings), or by its owner".to_string());
    }
    app_core::rt::try_blocking("calendar", move || delete_calendar_at(&calendar_path(), &id)).await
}

/// Undo of [`delete_calendar`]. See [`restore_calendar_at`].
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn restore_calendar(
    calendar: Calendar,
    events: Vec<CalendarEvent>,
    tasks: Vec<CalendarTask>,
) -> Result<CalendarData, String> {
    app_core::rt::try_blocking("calendar", move || restore_calendar_at(&calendar_path(), calendar, events, tasks)).await
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
