//! Thin Tauri dispatch layer for project-runtime switching.
//! Business logic lives in `services::project_runtime`.

use tauri::{AppHandle, State};

use crate::commands::apps::WindowRegistryState;
use crate::commands::workspace::WorkspaceStateArc;
use crate::schema::projects::ProjectsList;
use crate::services::project_runtime::PreviousProjectSnapshot;
use crate::storage;

/// Switch the active project runtime.
///
/// Saves the previous project snapshot, hides its windows, restores the next
/// project's apps and windows, and emits `project-runtime-switched`.
///
/// The actual switch does blocking work — JSON I/O plus platform window
/// hide/show, whose X11 retry loops and KDE DBus round-trips can take hundreds
/// of milliseconds. It runs on a dedicated OS thread so the main/UI thread is
/// never stalled. The resulting layout reaches the frontend through the
/// `project-runtime-switched` event (emitted by `switch`), not this call's
/// return value, which resolves immediately.
#[tauri::command]
pub fn switch_project_runtime(
    app: AppHandle,
    workspace: State<'_, WorkspaceStateArc>,
    win_registry: State<'_, WindowRegistryState>,
    project_id: Option<String>,
    previous_project_id: Option<String>,
    previous_snapshot: PreviousProjectSnapshot,
) -> Result<(), String> {
    // Clone the shared state handles so the worker thread owns them; State
    // references can't outlive the command call.
    let workspace = workspace.inner().clone();
    let win_registry = win_registry.inner().clone();

    std::thread::spawn(move || {
        // A project an older build worked in keeps the app's folder and refs
        // under the old name until it is next opened — here. Returns at once
        // while the name is unchanged.
        if let Some(id) = project_id.as_deref() {
            crate::services::brand_migration::project::on_project_open(id);
        }
        // Look up local_file paths from the global project list.
        let list_path = storage::state_dir().join("projects.json");
        let projects: ProjectsList = if list_path.exists() {
            storage::read_json(&list_path).unwrap_or_default()
        } else {
            vec![]
        };

        let find_local_file = |id: &str| {
            projects
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.local_file.clone())
        };

        let previous_local_file = previous_project_id.as_deref().and_then(find_local_file);
        let next_local_file = project_id.as_deref().and_then(find_local_file);

        if let Err(e) = crate::services::project_runtime::switch(
            &app,
            &workspace,
            &win_registry,
            project_id.as_deref(),
            previous_project_id.as_deref(),
            previous_local_file.as_deref(),
            next_local_file.as_deref(),
            &previous_snapshot,
        ) {
            eprintln!("switch_project_runtime: {e}");
        }
    });

    Ok(())
}

/// Load the saved side-panel subfolder for a project (restored at startup).
#[tauri::command]
pub fn load_side_panel_folder(local_file: String) -> Option<String> {
    crate::services::project_runtime::load_side_panel_folder(&local_file)
}

/// Persist the side-panel subfolder for a project as the user navigates it.
#[tauri::command]
pub fn save_side_panel_folder(local_file: String, folder: Option<String>) -> Result<(), String> {
    crate::services::project_runtime::save_side_panel_folder(&local_file, folder)
}
