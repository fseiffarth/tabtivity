use crate::brand::SLUG;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::apps::WindowRegistryState;
use crate::commands::workspace::WorkspaceStateArc;
use crate::schema::project::TabEntry;
use crate::schema::session::{FileTabSession, LayoutSession, ProjectState};
use crate::services::terminal_service::app_sessions_dir;
use crate::services::{restore_service, terminal_service, window_service};
use crate::storage;

// ── Public snapshot types ─────────────────────────────────────────────────

/// Runtime snapshot the frontend sends when leaving a project.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousProjectSnapshot {
    #[serde(default)]
    pub tab_layout: Vec<TabEntry>,
    #[serde(default)]
    pub active_tab_index: usize,
    /// Opaque split/group layout tree to persist alongside `tab_layout`.
    #[serde(default)]
    pub tab_groups: Option<serde_json::Value>,
    #[serde(default)]
    pub file_tabs: Vec<serde_json::Value>,
    pub side_panel_folder: Option<String>,
    #[serde(default)]
    pub active_layout_metadata: Option<serde_json::Value>,
    /// Elapsed project seconds to flush atomically with the switch.
    #[serde(default)]
    pub flush_secs: f64,
    /// The workspace version the frontend last saw for the outgoing scope
    /// (headless owner plan, H1); absent from a client that never received
    /// one, whose snapshot then reads as the whole set.
    #[serde(default)]
    pub workspace_version: Option<u64>,
}

/// Payload emitted as `project-runtime-switched` and returned to the caller.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuntimeSwitchedPayload {
    pub project_id: Option<String>,
    pub tab_layout: Vec<TabEntry>,
    pub active_tab_index: usize,
    /// Opaque split/group layout tree for the next project (None → legacy).
    pub tab_groups: Option<serde_json::Value>,
    pub file_tabs: Vec<serde_json::Value>,
    pub side_panel_folder: Option<String>,
    /// Registry IDs of all project-owned tracked windows after the switch.
    pub opened_window_ids: Vec<String>,
}

// ── Switch coordinator ────────────────────────────────────────────────────

/// Execute a full project-runtime switch.
///
/// `previous_local_file` and `next_local_file` are the paths to the respective
/// `project.json` files.
pub fn switch(
    app: &AppHandle,
    workspace: &WorkspaceStateArc,
    win_registry: &WindowRegistryState,
    project_id: Option<&str>,
    previous_project_id: Option<&str>,
    previous_local_file: Option<&str>,
    next_local_file: Option<&str>,
    snapshot: &PreviousProjectSnapshot,
) -> Result<ProjectRuntimeSwitchedPayload, String> {
    // 1. Flush elapsed time for the previous project.
    if snapshot.flush_secs > 0.0 {
        if let Some(prev_id) = previous_project_id {
            flush_project_secs(prev_id, snapshot.flush_secs);
        }
    }

    // 2. Save previous project's tab layout to <state_dir>/sessions/<id>/ (and
    //    its export copy in the project tree).
    if let Some(local_file) = previous_local_file {
        // The switch snapshot is a picture of what was in memory; like the
        // debounced save it never clears (an empty one far more often means
        // "never loaded" than "closed everything") and it carries no session
        // list. It goes through the workspace service like every other
        // writer, so a tab another client opened meanwhile survives it.
        if let Err(e) = terminal_service::save_terminal_session(
            previous_project_id,
            local_file,
            // project-tree-read: ok — `snapshot` is the frontend's live in-memory
            // switch payload (`PreviousProjectSnapshot`), not a file read.
            &snapshot.tab_layout,
            snapshot.active_tab_index,
            snapshot.tab_groups.clone(),
            snapshot.workspace_version,
        ) {
            eprintln!("ProjectRuntime: save tab layout: {e}");
        }
        save_previous_sessions(local_file, previous_project_id, snapshot);
    }

    // 2b. Remote projects are SSH/SFTP-native (no mount): the pooled connection
    //     is opened by the frontend on activation (`remote_connect`), and file
    //     browse / I-O / git dispatch over SFTP/SSH. Nothing to mount here.

    // 3. Load the next project's session data (terminal, apps, file tabs).
    //    This is the only part the frontend waits on, so it runs before the
    //    slow window hide/show below.
    //    Both are keyed by project id now, not by the path to its project.json:
    //    the state they read is executable intent, and its home is the state dir.
    let next_terminal_session = project_id
        .map(terminal_service::load_terminal_session)
        .unwrap_or_default();
    let next_open_apps = project_id
        .map(terminal_service::load_open_apps)
        .unwrap_or_default();
    let (next_file_tabs, next_side_panel_folder) = next_local_file
        .map(load_file_tab_session)
        .unwrap_or_default();

    // 4. Emit the layout payload now so the frontend restores tabs immediately,
    //    without waiting on window management. `opened_window_ids` is filled in
    //    on the returned payload below; the frontend doesn't use it, so the
    //    early event leaves it empty.
    let payload = ProjectRuntimeSwitchedPayload {
        project_id: project_id.map(String::from),
        // project-tree-read: ok — the state-dir `TerminalSession` loaded above by
        // project id, forwarded to the frontend.
        tab_layout: next_terminal_session.tab_layout,
        active_tab_index: next_terminal_session.active_tab_index,
        tab_groups: next_terminal_session.tab_groups,
        file_tabs: next_file_tabs,
        side_panel_folder: next_side_panel_folder,
        opened_window_ids: vec![],
    };
    let _ = app.emit("project-runtime-switched", payload.clone());

    // 5. Hide previous project-owned windows.
    //    Acquire WindowRegistry before WorkspaceState (lock order).
    {
        let prev_wids = {
            // `mut` is only exercised on Windows/macOS (the cfg'd re-resolve
            // below); other targets bind it immutably.
            #[cfg_attr(
                not(any(target_os = "windows", target_os = "macos")),
                allow(unused_mut)
            )]
            let mut wins = win_registry.lock().unwrap();
            // Windows/macOS: re-resolve any project-owned window whose id was never
            // captured at launch time (the visible top-level often belongs to a
            // CHILD of the spawned pid). Runs while holding ONLY the registry lock,
            // before the WorkspaceState lock below — lock order preserved. The
            // back-populated ids make this hide AND the switch-back show (step 8)
            // work through the existing id-based primitives. No-op on Linux,
            // where launch-time `_NET_WM_PID` resolution already fills the id.
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            window_service::resolve_missing_window_ids(
                &mut wins.windows,
                previous_project_id,
                crate::commands::apps::resolve_window_id_for_pid,
            );
            window_service::project_window_ids(&wins.windows, previous_project_id)
        };
        let ws = workspace.lock().unwrap();
        window_service::hide_windows(&*ws.backend, &prev_wids);
    }

    // 5b. (#42) Popout visibility is NOT decided here. The frontend's
    //     `setScope` → `sync_detached_scope` is its one authority, for every
    //     kind of scope change; this worker thread used to run the same sync
    //     unordered against it, and a stale run could park the active scope's
    //     popout (or, on Wayland, un-park another scope's over it).

    // 6. Save previous window session IDs to .tabtivity/sessions/windows.json.
    if let Some(local_file) = previous_local_file {
        let prev_reg_ids = {
            let wins = win_registry.lock().unwrap();
            window_service::project_tracked_ids(&wins.windows, previous_project_id)
        };
        window_service::save_window_session(local_file, &prev_reg_ids);
    }

    // 7. Restore standalone project apps.
    if let Some(next_id) = project_id {
        restore_service::restore_project_apps(win_registry, &next_open_apps, next_id);
    }

    // 8. Show next project-owned windows (including freshly restored ones).
    {
        let next_wids = {
            let wins = win_registry.lock().unwrap();
            window_service::project_window_ids(&wins.windows, project_id)
        };
        let ws = workspace.lock().unwrap();
        window_service::show_windows(&*ws.backend, &next_wids);
    }

    // 9. Collect opened window IDs and return the completed payload.
    let opened_window_ids = {
        let wins = win_registry.lock().unwrap();
        window_service::project_tracked_ids(&wins.windows, project_id)
    };

    // 10. Project containers (#38): tear down the container of the project
    //     being left — unless tabs are still live inside it (a background
    //     agent keeps its container until they finish or the app exits) — and
    //     warm up the next project's. On its own thread, not merely off the
    //     UI thread: `up()` can build an image (minutes) and must never delay
    //     the switch; the spawn-path `up()` stays the fallback for tabs
    //     opened before the warm-up completes, and sandbox's lifecycle lock
    //     serializes rapid switches. Best-effort by design.
    {
        use tauri::Manager;
        let registry = app
            .state::<crate::commands::terminal::RegistryState>()
            .inner()
            .clone();
        let prev = previous_project_id.map(String::from);
        let next = project_id.map(String::from);
        std::thread::spawn(move || {
            if let Some(prev) = prev {
                let live = registry.lock().unwrap().any_live_for_scope(&prev);
                if !live {
                    crate::services::sandbox::down_for_project(&prev);
                    // The container rule, verbatim, for the VM tier
                    // (`docs/vm_projects_plan.md`): a deactivated VM project
                    // with no live tabs powers its VM down; live tabs keep it
                    // up until they close. No-op for every other project.
                    if crate::services::vm::is_running(&prev) {
                        crate::services::vm::shutdown(&prev);
                    }
                }
            }
            if let Some(next) = next {
                if let Err(e) = crate::services::sandbox::up_for_project(&next) {
                    eprintln!("sandbox: container for '{next}': {e}");
                }
            }
        });
    }

    Ok(ProjectRuntimeSwitchedPayload {
        opened_window_ids,
        ..payload
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Persist file-tab, layout, and state snapshots for the project being left.
fn save_previous_sessions(
    local_file: &str,
    project_id: Option<&str>,
    snapshot: &PreviousProjectSnapshot,
) {
    let Some(sessions_dir) = app_sessions_dir(local_file) else {
        return;
    };

    let file_tab_session = FileTabSession {
        file_tabs: snapshot.file_tabs.clone(),
        side_panel_folder: snapshot.side_panel_folder.clone(),
        extra: Default::default(),
    };
    if let Err(e) = storage::write_json(&sessions_dir.join("filetabs.json"), &file_tab_session) {
        eprintln!("ProjectRuntime: write filetabs session: {e}");
    }

    let layout_session = LayoutSession {
        active_layout_metadata: snapshot.active_layout_metadata.clone(),
        extra: Default::default(),
    };
    if let Err(e) = storage::write_json(&sessions_dir.join("layout.json"), &layout_session) {
        eprintln!("ProjectRuntime: write layout session: {e}");
    }

    // Write .tabtivity/state.json one level up from sessions/.
    if let Some(app_dir) = sessions_dir.parent() {
        if let Some(project_dir) = std::path::Path::new(local_file).parent() {
            let state = ProjectState {
                project_id: project_id.unwrap_or("").to_string(),
                project_dir: project_dir.to_string_lossy().into_owned(),
                saved_at: Some(storage::iso_now()),
                extra: Default::default(),
            };
            if let Err(e) = storage::write_json(&app_dir.join("state.json"), &state) {
                eprintln!("ProjectRuntime: write .{SLUG}/state.json: {e}");
            }
        }
    }
}

/// Load just the side-panel subfolder for a project from its session file.
/// Used to restore the panel view at startup, before any project switch occurs.
pub fn load_side_panel_folder(local_file: &str) -> Option<String> {
    load_file_tab_session(local_file).1
}

/// Persist the side-panel subfolder for a project, preserving any other
/// fields already stored in `.tabtivity/sessions/filetabs.json`. Lets the active
/// project's panel view survive a restart even without a project switch.
pub fn save_side_panel_folder(local_file: &str, folder: Option<String>) -> Result<(), String> {
    let Some(sessions_dir) = app_sessions_dir(local_file) else {
        return Err("cannot resolve project sessions directory".into());
    };
    let path = sessions_dir.join("filetabs.json");
    let mut session: FileTabSession = if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        FileTabSession::default()
    };
    session.side_panel_folder = folder;
    storage::write_json(&path, &session).map_err(|e| e.to_string())
}

/// Load file tabs and side-panel folder from `.tabtivity/sessions/filetabs.json`.
/// Returns (file_tabs, side_panel_folder).
fn load_file_tab_session(local_file: &str) -> (Vec<serde_json::Value>, Option<String>) {
    if let Some(sessions_dir) = app_sessions_dir(local_file) {
        let path = sessions_dir.join("filetabs.json");
        if path.exists() {
            if let Ok(session) = storage::read_json::<FileTabSession>(&path) {
                return (session.file_tabs, session.side_panel_folder);
            }
        }
    }
    (vec![], None)
}

fn flush_project_secs(project_id: &str, secs: f64) {
    // Efficiency #12: record into the rolling daily-summary file (a small,
    // bounded map) instead of appending to the unbounded `time_log.json` and
    // rewriting the whole growing file on every switch / 60s tick.
    if let Err(error) = crate::schema::time_log::record_secs(project_id, secs) {
        eprintln!("project_runtime: record time for '{project_id}': {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project dir with a `project.json` in it, the shape every helper here
    /// is keyed by.
    fn project_file(dir: &tempfile::TempDir) -> String {
        dir.path().join("project.json").to_string_lossy().into_owned()
    }

    fn filetabs_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join(concat!(".", crate::app_slug!())).join("sessions").join("filetabs.json")
    }

    /// The frontend's switch payload can be as small as `{}` — every field has
    /// a default — and its keys are camelCase.
    #[test]
    fn a_previous_snapshot_deserializes_from_an_empty_object_and_camel_case_keys() {
        let empty: PreviousProjectSnapshot = serde_json::from_str("{}").unwrap();
        // project-tree-read: ok — the frontend's switch snapshot, not project.json.
        assert!(empty.tab_layout.is_empty());
        assert_eq!(empty.active_tab_index, 0);
        assert!(empty.tab_groups.is_none() && empty.side_panel_folder.is_none());
        assert_eq!(empty.flush_secs, 0.0);

        let full: PreviousProjectSnapshot = serde_json::from_str(
            r#"{"activeTabIndex":2,"flushSecs":12.5,"sidePanelFolder":"src","fileTabs":[{"p":1}],
                "activeLayoutMetadata":{"name":"x"}}"#,
        )
        .unwrap();
        assert_eq!(full.active_tab_index, 2);
        assert_eq!(full.flush_secs, 12.5);
        assert_eq!(full.side_panel_folder.as_deref(), Some("src"));
        assert_eq!(full.file_tabs.len(), 1);
        assert_eq!(full.active_layout_metadata.unwrap()["name"], "x");
    }

    /// No session file yet: the panel folder is simply unknown, and saving one
    /// creates `.tabtivity/sessions/filetabs.json` beside the project file.
    #[test]
    fn the_side_panel_folder_round_trips_through_filetabs_json() {
        let dir = tempfile::tempdir().unwrap();
        let local = project_file(&dir);
        assert_eq!(load_side_panel_folder(&local), None);
        assert!(!filetabs_path(&dir).exists());

        save_side_panel_folder(&local, Some("src/components".into())).unwrap();
        assert!(filetabs_path(&dir).exists());
        assert_eq!(load_side_panel_folder(&local).as_deref(), Some("src/components"));

        save_side_panel_folder(&local, None).unwrap();
        assert_eq!(load_side_panel_folder(&local), None);
        let raw = std::fs::read_to_string(filetabs_path(&dir)).unwrap();
        assert!(!raw.contains("sidePanelFolder"), "cleared means absent: {raw}");
    }

    /// Saving the folder is a merge: the file tabs already stored, and any key
    /// a newer build wrote, stay exactly as they were.
    #[test]
    fn saving_the_side_panel_folder_preserves_the_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let local = project_file(&dir);
        std::fs::create_dir_all(filetabs_path(&dir).parent().unwrap()).unwrap();
        std::fs::write(
            filetabs_path(&dir),
            r#"{"fileTabs":[{"path":"README.md"}],"sidePanelFolder":"docs","futureKey":true}"#,
        )
        .unwrap();

        save_side_panel_folder(&local, Some("src".into())).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(filetabs_path(&dir)).unwrap()).unwrap();
        assert_eq!(raw["sidePanelFolder"], "src");
        assert_eq!(raw["fileTabs"][0]["path"], "README.md");
        assert_eq!(raw["futureKey"], true);
        let (tabs, folder) = load_file_tab_session(&local);
        assert_eq!(tabs.len(), 1);
        assert_eq!(folder.as_deref(), Some("src"));
    }

    /// A file from before the panel was renamed still yields its folder, and
    /// the first save rewrites it under the new key only.
    #[test]
    fn a_legacy_right_panel_key_is_read_once_and_rewritten_as_side_panel() {
        let dir = tempfile::tempdir().unwrap();
        let local = project_file(&dir);
        std::fs::create_dir_all(filetabs_path(&dir).parent().unwrap()).unwrap();
        std::fs::write(filetabs_path(&dir), r#"{"fileTabs":[],"rightPanelFolder":"old"}"#).unwrap();
        assert_eq!(load_side_panel_folder(&local).as_deref(), Some("old"));

        save_side_panel_folder(&local, Some("new".into())).unwrap();
        let raw = std::fs::read_to_string(filetabs_path(&dir)).unwrap();
        assert!(raw.contains("\"sidePanelFolder\": \"new\""), "{raw}");
        assert!(!raw.contains("rightPanelFolder"), "{raw}");
    }

    /// A corrupt session file reads as "no tabs, no folder" rather than
    /// failing the switch, and a project file with no parent cannot be saved.
    #[test]
    fn a_corrupt_session_file_reads_as_empty_and_a_rootless_path_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let local = project_file(&dir);
        std::fs::create_dir_all(filetabs_path(&dir).parent().unwrap()).unwrap();
        std::fs::write(filetabs_path(&dir), "{not json").unwrap();
        assert_eq!(load_file_tab_session(&local), (vec![], None));
        assert!(save_side_panel_folder("", Some("x".into())).is_err());
    }

    /// Leaving a project writes three files: the file tabs and layout under
    /// `.tabtivity/sessions/`, and `.tabtivity/state.json` one level up naming the
    /// project id and its directory.
    #[test]
    fn leaving_a_project_writes_filetabs_layout_and_state() {
        let dir = tempfile::tempdir().unwrap();
        let local = project_file(&dir);
        let snapshot = PreviousProjectSnapshot {
            tab_layout: vec![],
            active_tab_index: 0,
            tab_groups: None,
            file_tabs: vec![serde_json::json!({"path":"a.rs"})],
            side_panel_folder: Some("src".into()),
            active_layout_metadata: Some(serde_json::json!({"name":"wide"})),
            flush_secs: 0.0,
            workspace_version: None,
        };
        save_previous_sessions(&local, Some("p-42"), &snapshot);

        let sessions = dir.path().join(concat!(".", crate::app_slug!())).join("sessions");
        let tabs: FileTabSession = storage::read_json(&sessions.join("filetabs.json")).unwrap();
        assert_eq!(tabs.file_tabs[0]["path"], "a.rs");
        assert_eq!(tabs.side_panel_folder.as_deref(), Some("src"));
        let layout: LayoutSession = storage::read_json(&sessions.join("layout.json")).unwrap();
        assert_eq!(layout.active_layout_metadata.unwrap()["name"], "wide");
        let state: ProjectState =
            storage::read_json(&dir.path().join(concat!(".", crate::app_slug!())).join("state.json")).unwrap();
        assert_eq!(state.project_id, "p-42");
        assert_eq!(std::path::Path::new(&state.project_dir), dir.path());
        assert!(state.saved_at.is_some());
    }
}
