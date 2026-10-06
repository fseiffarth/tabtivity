//! Runs the state-file commands off the GTK main thread without giving up the
//! order they arrive in (performance plan §7.1).
//!
//! As plain sync commands they ran on the main thread: every tab-layout,
//! project-list and settings save held the window still for a temp-file fsync
//! and a directory fsync, queued behind any background atomic write. Tauri's
//! own `#[tauri::command(async)]` would move them to its thread pool, but the
//! window does not serialise all of these calls itself — `updateSettings`
//! fires `patch_settings` without waiting for the previous one — and on a pool
//! two saves sent back to back may land in either order, leaving the older
//! value on disk. So the handler below hands exactly these commands to one
//! ordered worker (`services::ordered_lane`): the invoke is queued on the
//! thread it arrived on, in arrival order, and the unchanged sync command body
//! runs and answers from the worker.

use std::sync::Arc;
use std::time::Duration;

use crate::services::ordered_lane::OrderedLane;

static LANE: OrderedLane = OrderedLane::new("persist-lane");

/// The commands that read or write `settings.json`, `projects.json` and the
/// per-scope session files. Reads are on the lane too, so a read sent after a
/// write still sees it. None of them takes a window or touches GTK; the one
/// `AppHandle` use (`workspace_sync`'s emit) is thread-safe.
const ORDERED: &[&str] = &[
    "get_settings",
    "save_settings",
    "patch_settings",
    "save_window_state",
    "get_projects",
    "save_projects",
    "load_tab_session",
    "workspace_snapshot",
    "workspace_sync",
    "save_tab_layout",
];

pub fn is_ordered(command: &str) -> bool {
    ORDERED.contains(&command)
}

/// Wrap the generated invoke handler: [`ORDERED`] commands go through the
/// lane, everything else is dispatched exactly as before.
pub fn ordered<R, F>(handler: F) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
where
    R: tauri::Runtime,
    F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    move |invoke| {
        if !is_ordered(invoke.message.command()) {
            return handler(invoke);
        }
        let handler = handler.clone();
        LANE.run(move || {
            handler(invoke);
        });
        true
    }
}

/// Let saves the window already sent reach disk before the process exits.
/// Bounded: a hung filesystem must not keep a quit from finishing.
pub fn drain_at_exit() {
    if !LANE.drain(Duration::from_secs(5)) {
        eprintln!("persist lane still busy at exit; a queued save may be lost");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_state_file_commands_take_the_lane() {
        for command in ["patch_settings", "workspace_sync", "get_projects", "save_window_state"] {
            assert!(is_ordered(command), "{command}");
        }
        for command in ["terminal_write", "quit_app", "get_settings_extra", ""] {
            assert!(!is_ordered(command), "{command}");
        }
    }
}
