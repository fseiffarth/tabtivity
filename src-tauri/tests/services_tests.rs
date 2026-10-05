//! Tests for the Phase 1 service layer.
//!
//! Tests that require a real filesystem use `tempfile::TempDir`.
//! Tests that require a workspace backend use `app_lib::platform::null::NullBackend`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use app_lib::commands::apps::{
    TrackedWindow, ORIGIN_GLOBAL_APP, ORIGIN_MANUAL_LAUNCH, ORIGIN_MIDDLE_FILE_BROWSER,
    ORIGIN_RESTORED, ORIGIN_SIDE_FILE_TREE,
};
use app_lib::platform::{WorkspaceBackend, WorkspaceInfo};
use app_lib::schema::project::{Project, TabEntry};
use app_lib::services::terminal_service;
use app_lib::services::window_service;
use tempfile::TempDir;

// Suppress unused-import warnings: these are used in the workflow tests below.
#[allow(unused_imports)]
use app_lib::schema::TerminalSession;

// ── Helpers ───────────────────────────────────────────────────────────────

/// Point `storage::state_dir()` at a per-run temp directory, once for the whole
/// test binary.
///
/// Needed since `docs/sandbox_hardening_plan.md` Phase 1: per-project session
/// state (tab layout, `open_apps`, host-bound markers) moved OUT of the project
/// tree and INTO the state dir, so these tests write there now — and a suite that
/// writes into the developer's real `~/.local/share/tabtivity/` would clobber their
/// running workspace. Set once and never changed, so the parallel test threads
/// all agree on the value.
fn isolated_state_dir() -> &'static std::path::Path {
    use std::sync::OnceLock;
    static DIR: OnceLock<TempDir> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        let tmp = TempDir::new().unwrap();
        std::env::set_var(app_lib::app_env!("STATE_DIR"), tmp.path());
        tmp
    });
    // Re-assert on every call: another test in this binary may legitimately have
    // set the variable for its own fixture, and reads are lazy.
    std::env::set_var(app_lib::app_env!("STATE_DIR"), dir.path());
    dir.path()
}

/// A project registered for session tests: writes its `project.json` into `tmp`,
/// isolates the state dir, and returns `(project_id, local_file)`.
fn session_project(tmp: &TempDir, id: &str) -> (String, String) {
    isolated_state_dir();
    let project = Project {
        id: id.to_string(),
        name: id.to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    (id.to_string(), local_file.to_string_lossy().to_string())
}

/// The authoritative session file for a project: `<state_dir>/sessions/<key>/`.
fn state_session_file(project_id: &str) -> PathBuf {
    app_lib::storage::project_session_dir(project_id).join("terminals.json")
}

fn tracked(
    id: &str,
    project_id: Option<&str>,
    origin: &str,
    window_id: Option<u64>,
) -> TrackedWindow {
    TrackedWindow {
        id: id.to_string(),
        exec: "editor".to_string(),
        file: None,
        pid: 42,
        project_id: project_id.map(String::from),
        role: None,
        opened_at: 1.0,
        window_id,
        origin: origin.to_string(),
    }
}

#[derive(Default)]
struct RecordingBackend {
    calls: Mutex<Vec<(String, u64)>>,
}

impl RecordingBackend {
    fn calls(&self) -> Vec<(String, u64)> {
        self.calls.lock().unwrap().clone()
    }
}

impl WorkspaceBackend for RecordingBackend {
    fn name(&self) -> &'static str {
        "recording"
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            label: "test".to_string(),
            current_desktop: None,
            desktop_count: None,
        }
    }

    fn show_window(&self, window_id: u64) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(("show".to_string(), window_id));
        Ok(())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(("hide".to_string(), window_id));
        Ok(())
    }

    fn make_sticky(&self, _app_pid: u32) -> Result<(), String> {
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Ok(())
    }
}

// ── window_service ────────────────────────────────────────────────────────

#[test]
fn project_window_ids_returns_only_project_owned() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("a", Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(10)),
        tracked("b", Some("p1"), ORIGIN_MIDDLE_FILE_BROWSER, Some(11)),
        tracked("c", Some("p1"), ORIGIN_RESTORED, Some(12)),
        tracked("d", Some("p1"), ORIGIN_GLOBAL_APP, Some(13)),
        tracked("e", Some("p1"), ORIGIN_MANUAL_LAUNCH, Some(14)),
        tracked("f", Some("p2"), ORIGIN_SIDE_FILE_TREE, Some(20)),
        tracked("g", None, ORIGIN_SIDE_FILE_TREE, Some(30)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let mut ids = window_service::project_window_ids(&windows, Some("p1"));
    ids.sort();
    assert_eq!(ids, vec![10, 11, 12]);
}

#[test]
fn project_tracked_ids_returns_registry_keys() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("a", Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(10)),
        tracked("b", Some("p1"), ORIGIN_RESTORED, Some(11)),
        tracked("c", Some("p1"), ORIGIN_MANUAL_LAUNCH, Some(12)),
        tracked("d", Some("p2"), ORIGIN_SIDE_FILE_TREE, Some(20)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let mut ids = window_service::project_tracked_ids(&windows, Some("p1"));
    ids.sort();
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn root_scope_windows_are_none_project_id() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("root-w", None, ORIGIN_SIDE_FILE_TREE, Some(99)),
        tracked("p1-w", Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(10)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let ids = window_service::project_window_ids(&windows, None);
    assert_eq!(ids, vec![99]);
}

#[test]
fn global_and_manual_windows_are_never_project_owned() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("g", None, ORIGIN_GLOBAL_APP, Some(1)),
        tracked("m", None, ORIGIN_MANUAL_LAUNCH, Some(2)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    assert!(window_service::project_window_ids(&windows, None).is_empty());
    assert!(window_service::project_tracked_ids(&windows, None).is_empty());
}

// ── terminal_service ──────────────────────────────────────────────────────

fn write_project_json(dir: &std::path::Path, project: &Project) -> PathBuf {
    // Every fixture that writes a project.json is a session-state test one way or
    // another; isolate the state dir here so no individual test can forget to.
    isolated_state_dir();
    let path = dir.join("project.json");
    let json = serde_json::to_string_pretty(project).unwrap();
    std::fs::write(&path, json).unwrap();
    path
}

#[test]
fn save_and_load_side_panel_folder_roundtrip() {
    use app_lib::services::project_runtime;
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "test-id".to_string(),
        name: "Test".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let local_file_str = local_file.to_string_lossy().to_string();

    // No session file yet -> nothing saved.
    assert_eq!(
        project_runtime::load_side_panel_folder(&local_file_str),
        None
    );

    project_runtime::save_side_panel_folder(&local_file_str, Some("src/components".to_string()))
        .unwrap();
    assert_eq!(
        project_runtime::load_side_panel_folder(&local_file_str),
        Some("src/components".to_string())
    );

    // Overwrite with a different folder (simulates navigating elsewhere).
    project_runtime::save_side_panel_folder(&local_file_str, Some("docs".to_string())).unwrap();
    assert_eq!(
        project_runtime::load_side_panel_folder(&local_file_str),
        Some("docs".to_string())
    );
}

#[test]
fn save_and_load_tab_layout_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let (id, local_file_str) = session_project(&tmp, "roundtrip");

    let tabs = vec![
        TabEntry {
            key: "shell-1".to_string(),
            label: "Terminal".to_string(),
            cmd: "bash".to_string(),
            cwd: "/home/user".to_string(),
            session_id: None,
            extra: Default::default(),
        },
        TabEntry {
            key: "agent-2".to_string(),
            label: "Claude".to_string(),
            cmd: "claude".to_string(),
            cwd: "/home/user/project".to_string(),
            session_id: None,
            extra: Default::default(),
        },
    ];

    terminal_service::save_tab_layout(Some(&id), &local_file_str, &tabs, None, None, true).unwrap();
    let loaded = terminal_service::load_terminal_session(&id).tab_layout;

    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].key, "shell-1");
    assert_eq!(loaded[1].cmd, "claude");
}

#[test]
fn save_tab_layout_round_trips_agent_session_id() {
    let tmp = TempDir::new().unwrap();
    let (id, path_str) = session_project(&tmp, "resume-id");

    let session_id = "22222222-2222-4222-8222-222222222222".to_string();
    let tabs = vec![
        TabEntry {
            key: "shell-1".to_string(),
            label: "Terminal".to_string(),
            cmd: "bash".to_string(),
            cwd: "/home/user".to_string(),
            session_id: None,
            extra: Default::default(),
        },
        TabEntry {
            key: "agent-2".to_string(),
            label: "Claude".to_string(),
            cmd: "claude".to_string(),
            cwd: "/home/user/project".to_string(),
            session_id: Some(session_id.clone()),
            extra: Default::default(),
        },
    ];

    terminal_service::save_tab_layout(Some(&id), &path_str, &tabs, None, None, true).unwrap();
    let loaded = terminal_service::load_terminal_session(&id).tab_layout;

    assert_eq!(loaded.len(), 2);
    // Shell tab carries no session id.
    assert_eq!(loaded[0].session_id, None);
    // The agent tab's session id survives the round-trip.
    assert_eq!(loaded[1].cmd, "claude");
    assert_eq!(loaded[1].session_id, Some(session_id));

    // The on-disk JSON uses the camelCase `sessionId` key.
    let raw: serde_json::Value = app_lib::storage::read_json(&state_session_file(&id)).unwrap();
    assert_eq!(
        raw["tabLayout"][1]["sessionId"],
        serde_json::json!("22222222-2222-4222-8222-222222222222")
    );
    assert!(
        raw["tabLayout"][0].get("sessionId").is_none(),
        "shell tab must omit sessionId when None"
    );
}

/// Phase 1 of `docs/sandbox_hardening_plan.md`: the layout is keyed by project id
/// and lives in the state dir, and `project.json` is left completely alone.
#[test]
fn save_tab_layout_never_writes_the_layout_into_project_json() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "preserve-me".to_string(),
        name: "MyProject".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        status: Some("active".to_string()),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let tabs = vec![TabEntry {
        key: "s-1".to_string(),
        label: "Shell".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        extra: Default::default(),
    }];
    terminal_service::save_tab_layout(Some("preserve-me"), &path_str, &tabs, None, None, true)
        .unwrap();

    let reloaded: Project = app_lib::storage::read_json(&local_file).unwrap();
    assert_eq!(reloaded.id, "preserve-me");
    assert_eq!(reloaded.name, "MyProject");
    assert_eq!(reloaded.status.as_deref(), Some("active"));
    assert!(
        reloaded.tab_layout.is_none(),
        "project.json is inside the container's writable mount — the layout must not be there"
    );
}

/// The root scope has no project to key by, and its tabs were never restored from
/// disk. Persisting anything for it would only create a file nothing reads.
#[test]
fn a_scope_with_no_project_id_persists_nothing() {
    let tmp = TempDir::new().unwrap();
    let (_, path_str) = session_project(&tmp, "unused");
    let tabs = vec![TabEntry {
        key: "s-1".to_string(),
        label: "Shell".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        extra: Default::default(),
    }];
    terminal_service::save_tab_layout(None, &path_str, &tabs, None, None, true).unwrap();
    assert!(!tmp.path().join(concat!(".", app_lib::app_slug!(), "/sessions/terminals.json")).exists());
}

#[test]
fn save_tab_layout_persists_open_session_uuids() {
    let tmp = TempDir::new().unwrap();
    let (id, path_str) = session_project(&tmp, "sessions");

    let sessions = serde_json::json!([
        { "sessionId": "11111111-1111-4111-8111-111111111111", "cmd": "claude", "label": "Claude" }
    ]);
    terminal_service::save_tab_layout(
        Some(&id),
        &path_str,
        &[],
        None,
        Some(sessions.clone()),
        true,
    )
    .unwrap();
    assert_eq!(
        terminal_service::load_terminal_session(&id).open_tab_sessions,
        Some(sessions)
    );

    // A subsequent layout save with `None` (the project-switch path) must leave
    // the stored UUIDs untouched, while `Some([])` clears them.
    terminal_service::save_terminal_session(Some(&id), &path_str, &[], 0, None, None).unwrap();
    assert!(terminal_service::load_terminal_session(&id)
        .open_tab_sessions
        .is_some());

    // The switch save went through the workspace service, so the scope is
    // versioned now and the whole-snapshot save is refused (headless owner
    // plan, H1); a client clears the list through a sync.
    let refused = terminal_service::save_tab_layout(
        Some(&id),
        &path_str,
        &[],
        None,
        Some(serde_json::json!([])),
        true,
    );
    assert_eq!(refused.unwrap_err(), app_lib::services::workspace::OWNED_ERROR);
    let version = app_lib::services::workspace::snapshot(&id).unwrap().version;
    app_lib::services::workspace::sync(
        &id,
        &path_str,
        app_lib::services::workspace::ClientSync {
            base_version: version,
            tabs: vec![],
            groups: None,
            sessions: Some(serde_json::json!([])),
            active_tab_index: None,
            allow_clear: false,
        },
    )
    .unwrap();
    assert_eq!(
        terminal_service::load_terminal_session(&id).open_tab_sessions,
        None
    );
}

#[test]
fn load_terminal_session_returns_empty_for_an_unknown_project() {
    let loaded = terminal_service::load_terminal_session("no-such-project-at-all");
    assert!(loaded.tab_layout.is_empty());
}

#[test]
fn load_open_apps_returns_empty_when_none_saved() {
    let tmp = TempDir::new().unwrap();
    let (id, _) = session_project(&tmp, "no-apps");
    assert!(terminal_service::load_open_apps(&id).is_empty());
}

/// A project holding one saved tab, for the two empty-save tests below.
fn project_with_one_saved_tab(tmp: &TempDir, id: &str) -> String {
    let (_, path_str) = session_project(tmp, id);
    let tabs = vec![TabEntry {
        key: "old".to_string(),
        label: "Old".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        session_id: Some("11111111-1111-4111-8111-111111111111".to_string()),
        extra: Default::default(),
    }];
    terminal_service::save_tab_layout(Some(id), &path_str, &tabs, None, None, true).unwrap();
    path_str
}

#[test]
fn save_empty_tabs_clears_layout_field_when_clearing_is_allowed() {
    let tmp = TempDir::new().unwrap();
    let path_str = project_with_one_saved_tab(&tmp, "clear-ok");

    // The user really did close every tab.
    terminal_service::save_tab_layout(Some("clear-ok"), &path_str, &[], None, None, true).unwrap();

    assert!(terminal_service::load_terminal_session("clear-ok")
        .tab_layout
        .is_empty());
}

/// The DemoProj regression: an empty layout arriving from a caller that cannot
/// vouch for it must NOT erase the saved one.
///
/// Detach swaps a project's `local_file` (remote state dir → promoted mirror) while
/// the tab store's scope has not caught up; the debounced autosave then persists the
/// wrong scope's tabs into that file, the per-scope filter drops every one of them as
/// foreign, and what arrives is `[]` — indistinguishable from a close-all, and fatal.
/// It took the layout and the `sessionId`s that were the only handle on three live
/// Claude conversations. Empty now clears only when the caller says it means one.
#[test]
fn save_empty_tabs_preserves_layout_when_clearing_is_not_allowed() {
    let tmp = TempDir::new().unwrap();
    let path_str = project_with_one_saved_tab(&tmp, "clear-refused");

    terminal_service::save_tab_layout(Some("clear-refused"), &path_str, &[], None, None, false)
        .unwrap();

    let loaded = terminal_service::load_terminal_session("clear-refused").tab_layout;
    assert_eq!(
        loaded.len(),
        1,
        "an unvouched empty save must not erase tabs"
    );
    assert_eq!(loaded[0].key, "old");
    assert_eq!(
        loaded[0].session_id.as_deref(),
        Some("11111111-1111-4111-8111-111111111111"),
        "the agent's session id is the handle on its conversation"
    );
}

// ── terminal_service: the project tree is written, never read ─────────────

#[test]
fn save_writes_the_state_dir_copy_and_the_project_tree_export() {
    let tmp = TempDir::new().unwrap();
    let (id, path_str) = session_project(&tmp, "p-sess");

    let tabs = vec![TabEntry {
        key: "s1".to_string(),
        label: "Shell".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        extra: Default::default(),
    }];
    terminal_service::save_terminal_session(Some(&id), &path_str, &tabs, 0, None, None).unwrap();

    // The authoritative copy: state dir, keyed by project id.
    let session: app_lib::schema::TerminalSession =
        app_lib::storage::read_json(&state_session_file(&id)).unwrap();
    assert_eq!(session.tab_layout.len(), 1);
    assert_eq!(session.tab_layout[0].key, "s1");

    // The export copy: still written, so the layout travels with a folder that is
    // byte-synced or copied. Never read without an explicit adopt.
    let export = tmp.path().join(concat!(".", app_lib::app_slug!(), "/sessions/terminals.json"));
    assert!(export.exists(), "the export copy must still be written");
    let exported: app_lib::schema::TerminalSession =
        app_lib::storage::read_json(&export).unwrap();
    assert_eq!(exported.tab_layout[0].key, "s1");
}

/// The Phase 1 property, stated as a test: a layout planted in the project tree —
/// by a cloned repository, or by an agent writing inside the container's rw mount —
/// is **not** read. Both plantable locations are covered, because Tabtivity used to
/// read `.tabtivity/sessions/terminals.json` first and `project.json` as a fallback.
#[test]
fn a_layout_planted_in_the_project_tree_is_never_loaded() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "p-planted".to_string(),
        name: "Planted".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        tab_layout: Some(vec![TabEntry {
            key: "planted-via-project-json".to_string(),
            label: "Old".to_string(),
            cmd: "bash".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            extra: Default::default(),
        }]),
        ..Default::default()
    };
    write_project_json(tmp.path(), &project);

    let sessions_dir = tmp.path().join(concat!(".", app_lib::app_slug!(), "/sessions"));
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let planted = app_lib::schema::TerminalSession {
        tab_layout: vec![TabEntry {
            key: concat!("planted-via-", app_lib::app_slug!(), "-mirror").to_string(),
            label: "Pwn".to_string(),
            cmd: "claude".to_string(),
            cwd: "/home/user".to_string(),
            session_id: None,
            extra: Default::default(),
        }],
        ..Default::default()
    };
    app_lib::storage::write_json(&sessions_dir.join("terminals.json"), &planted).unwrap();

    assert!(
        terminal_service::load_terminal_session("p-planted")
            .tab_layout
            .is_empty(),
        "nothing in the project tree may reach the restore path on its own"
    );
}

/// …and the explicit escape hatch that replaces the old automatic fallback.
#[test]
fn adopting_a_folder_layout_is_explicit_and_sanitized() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "p-adopt".to_string(),
        name: "Adopt".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let sessions_dir = tmp.path().join(concat!(".", app_lib::app_slug!(), "/sessions"));
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let mut hostile = TabEntry {
        key: "t".to_string(),
        label: "Shell".to_string(),
        cmd: "/tmp/pwn.sh".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        extra: Default::default(),
    };
    hostile.extra.insert(
        "env".to_string(),
        serde_json::json!({ "LD_PRELOAD": "/tmp/x.so" }),
    );
    let saved = app_lib::schema::TerminalSession {
        tab_layout: vec![
            hostile,
            TabEntry {
                key: "ok".to_string(),
                label: "Shell".to_string(),
                cmd: "bash".to_string(),
                cwd: "/tmp".to_string(),
                session_id: None,
                extra: Default::default(),
            },
        ],
        open_apps: Some(vec![app_lib::schema::project::OpenApp {
            exec: "/tmp/pwn.sh".to_string(),
            file: None,
            mode: None,
            opened_at: None,
            pid: None,
            extra: Default::default(),
        }]),
        ..Default::default()
    };
    app_lib::storage::write_json(&sessions_dir.join("terminals.json"), &saved).unwrap();

    let adopted = terminal_service::adopt_project_tree_session("p-adopt", &path_str).unwrap();
    assert_eq!(adopted.tab_layout.len(), 2, "an adopt keeps every pane");
    assert_eq!(
        adopted.tab_layout[0].cmd, "",
        "an unknown command is neutralized"
    );
    assert!(!adopted.tab_layout[0].extra.contains_key("env"));
    assert_eq!(adopted.tab_layout[1].cmd, "bash");
    assert!(
        adopted.open_apps.is_none(),
        "a folder-supplied list of host commands to launch is never adopted"
    );

    // …and what it adopted is what the ordinary load now returns.
    assert_eq!(
        terminal_service::load_terminal_session("p-adopt")
            .tab_layout
            .len(),
        2
    );
}

// ── window_service: session save/load ─────────────────────────────────────

#[test]
fn save_and_load_window_session_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "p-win".to_string(),
        name: "Win".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let ids = vec!["win-1".to_string(), "win-2".to_string()];
    app_lib::services::window_service::save_window_session(&path_str, &ids);

    let loaded = app_lib::services::window_service::load_window_session(&path_str);
    let mut loaded_ids = loaded.project_window_ids;
    loaded_ids.sort();
    assert_eq!(loaded_ids, vec!["win-1", "win-2"]);
}

#[test]
fn load_window_session_returns_empty_when_missing() {
    let loaded =
        app_lib::services::window_service::load_window_session("/nonexistent/project.json");
    assert!(loaded.project_window_ids.is_empty());
}

// ── project switch workflow ────────────────────────────────────────────────
//
// Tests that verify the individual steps of the switch workflow compose
// correctly.  The full `switch()` requires an `AppHandle` (a live Tauri
// context) and cannot be instantiated in unit tests.  These tests therefore
// exercise each step independently and then verify the observable file-system
// side effects match the plan spec.

#[test]
fn switch_saves_tab_layout_into_the_state_dir() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "prev".to_string(),
        name: "Prev".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let tabs = vec![TabEntry {
        key: "t1".to_string(),
        label: "T1".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        extra: Default::default(),
    }];
    terminal_service::save_terminal_session(Some("prev"), &path_str, &tabs, 0, None, None).unwrap();

    // The state-dir copy is the one the next activation reads back.
    let saved = terminal_service::load_terminal_session("prev").tab_layout;
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].key, "t1");
    // …and project.json is untouched by it.
    let reloaded: Project = app_lib::storage::read_json(&local_file).unwrap();
    assert!(reloaded.tab_layout.is_none());
}

#[test]
fn switch_hides_previous_project_windows_using_null_backend() {
    use app_lib::platform::null::NullBackend;

    let windows: HashMap<String, TrackedWindow> = [
        tracked("a", Some("prev"), ORIGIN_SIDE_FILE_TREE, Some(10)),
        tracked("b", Some("prev"), ORIGIN_RESTORED, Some(11)),
        tracked("c", Some("next"), ORIGIN_SIDE_FILE_TREE, Some(20)),
        tracked("d", None, ORIGIN_GLOBAL_APP, Some(99)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let prev_ids = window_service::project_window_ids(&windows, Some("prev"));
    assert_eq!(
        prev_ids.len(),
        2,
        "must collect exactly the two prev-owned windows"
    );

    // NullBackend::hide_window must not error.
    let backend = NullBackend;
    window_service::hide_windows(&backend, &prev_ids);
    // If we get here without panic the test passes.
}

#[test]
fn switch_uses_hide_show_as_workspace_backend_boundary() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("prev-file", Some("prev"), ORIGIN_SIDE_FILE_TREE, Some(10)),
        tracked("prev-restored", Some("prev"), ORIGIN_RESTORED, Some(11)),
        tracked("prev-global", Some("prev"), ORIGIN_GLOBAL_APP, Some(12)),
        tracked("prev-manual", Some("prev"), ORIGIN_MANUAL_LAUNCH, Some(13)),
        tracked(
            "next-file",
            Some("next"),
            ORIGIN_MIDDLE_FILE_BROWSER,
            Some(20),
        ),
        tracked("next-restored", Some("next"), ORIGIN_RESTORED, Some(21)),
        tracked("root-file", None, ORIGIN_SIDE_FILE_TREE, Some(30)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let mut previous_ids = window_service::project_window_ids(&windows, Some("prev"));
    previous_ids.sort();
    let mut current_ids = window_service::project_window_ids(&windows, Some("next"));
    current_ids.sort();

    let backend = RecordingBackend::default();
    window_service::hide_windows(&backend, &previous_ids);
    window_service::show_windows(&backend, &current_ids);

    assert_eq!(
        backend.calls(),
        vec![
            ("hide".to_string(), 10),
            ("hide".to_string(), 11),
            ("show".to_string(), 20),
            ("show".to_string(), 21),
        ],
        "project switching must be wired through hide_window/show_window only"
    );
}

#[test]
fn default_switch_to_project_delegates_to_hide_show() {
    let backend = RecordingBackend::default();

    backend
        .switch_to_project(Some("next"), Some("prev"), &[10, 11], &[20, 21])
        .unwrap();

    assert_eq!(
        backend.calls(),
        vec![
            ("hide".to_string(), 10),
            ("hide".to_string(), 11),
            ("show".to_string(), 20),
            ("show".to_string(), 21),
        ],
        "legacy switch_to_project must remain a thin hide/show helper"
    );
}

#[test]
fn switch_ignores_global_app_and_manual_windows_when_hiding() {
    use app_lib::platform::null::NullBackend;

    let windows: HashMap<String, TrackedWindow> = [
        tracked("g", Some("prev"), ORIGIN_GLOBAL_APP, Some(1)),
        tracked("m", Some("prev"), ORIGIN_MANUAL_LAUNCH, Some(2)),
        tracked("p", Some("prev"), ORIGIN_SIDE_FILE_TREE, Some(3)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let ids = window_service::project_window_ids(&windows, Some("prev"));
    assert_eq!(
        ids,
        vec![3],
        "only the project-owned window must be selected"
    );

    let backend = NullBackend;
    window_service::hide_windows(&backend, &ids);
}

#[test]
fn switch_restored_apps_are_project_owned() {
    let windows: HashMap<String, TrackedWindow> =
        [tracked("r", Some("p1"), ORIGIN_RESTORED, Some(10))]
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();

    let owned = window_service::project_tracked_ids(&windows, Some("p1"));
    assert_eq!(
        owned,
        vec!["r"],
        "restored apps must be treated as project-owned"
    );
}

#[test]
fn switch_root_runtime_uses_none_project_id() {
    use app_lib::platform::null::NullBackend;

    let windows: HashMap<String, TrackedWindow> = [
        tracked("root-w", None, ORIGIN_SIDE_FILE_TREE, Some(99)),
        tracked("proj-w", Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(10)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let root_ids = window_service::project_window_ids(&windows, None);
    assert_eq!(root_ids, vec![99], "root scope must use None project_id");

    let backend = NullBackend;
    window_service::hide_windows(&backend, &root_ids);
    window_service::show_windows(&backend, &root_ids);
}

#[test]
fn switch_next_project_tab_layout_loaded_after_save() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "next".to_string(),
        name: "Next".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let tabs = vec![
        TabEntry {
            key: "n1".to_string(),
            label: "N1".to_string(),
            cmd: "bash".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            extra: Default::default(),
        },
        TabEntry {
            key: "n2".to_string(),
            label: "Claude".to_string(),
            cmd: "claude".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            extra: Default::default(),
        },
    ];
    terminal_service::save_terminal_session(Some("next"), &path_str, &tabs, 1, None, None).unwrap();

    let session = terminal_service::load_terminal_session("next");
    assert_eq!(session.tab_layout.len(), 2);
    assert_eq!(session.active_tab_index, 1);
    assert_eq!(session.tab_layout[1].cmd, "claude");
}
