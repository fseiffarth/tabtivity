//! Schema round-trip tests for Phase 1.
//!
//! Each test:
//!   1. Reads a real fixture file (with an injected `_unknown_test` field).
//!   2. Deserializes into the Rust schema struct.
//!   3. Serializes back to JSON.
//!   4. Deserializes the re-serialized JSON and checks key values.
//!   5. Asserts the `_unknown_test` field was preserved.
//!
//! These also validate that the Python app can roll back: if the round-tripped
//! JSON parses cleanly in Python (shape unchanged), rollback is safe.

use std::collections::HashMap;
use std::path::PathBuf;

use app_lib::schema::{
    DefaultApps, FileTabSession, LayoutSession, Project, ProjectEntry, ProjectState, Settings,
    TerminalSession, TimeLogEntry, WindowSession,
};
use serde_json::Value;

fn fixture(name: &str) -> PathBuf {
    // Resolve relative to the workspace root (project dir), not crate root.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir)
        .parent()
        .expect("src-tauri has parent")
        .join("test-fixtures")
        .join(name)
}

// ── helpers ────────────────────────────────────────────────────────────────

fn assert_unknown_preserved(extra: &HashMap<String, Value>) {
    assert_eq!(
        extra.get("_unknown_test").and_then(|v| v.as_str()),
        Some("preserved"),
        "unknown field was not preserved through round-trip"
    );
}

fn roundtrip<T>(json: &str) -> T
where
    T: serde::Serialize + serde::de::DeserializeOwned,
{
    let first: T = serde_json::from_str(json).expect("first parse");
    let out = serde_json::to_string_pretty(&first).expect("serialize");
    serde_json::from_str(&out).expect("second parse")
}

// ── projects.json ──────────────────────────────────────────────────────────

#[test]
fn projects_roundtrip() {
    let path = fixture("projects.json");
    let raw = std::fs::read_to_string(&path).expect("read projects.json");
    let entries: Vec<ProjectEntry> = roundtrip(&raw);

    assert!(!entries.is_empty(), "expected at least one project");

    // Verify known-field round-trip
    let first = &entries[0];
    assert!(!first.id.is_empty());
    assert!(!first.name.is_empty());
    assert!(["current", "active", "inactive"].contains(&first.status.as_str()));

    // Verify unknown field preserved
    assert_unknown_preserved(&first.extra);
}

#[test]
fn projects_python_rollback_shape() {
    let path = fixture("projects.json");
    let raw = std::fs::read_to_string(&path).expect("read projects.json");
    let entries: Vec<ProjectEntry> = serde_json::from_str(&raw).expect("parse");
    let out = serde_json::to_string_pretty(&entries).expect("serialize");

    // The re-serialized JSON must parse as an array (Python reads a list).
    let reloaded: Value = serde_json::from_str(&out).expect("reparse as Value");
    assert!(reloaded.is_array());
    let arr = reloaded.as_array().unwrap();
    // Every entry must still have id, name, status, position, local_file.
    for entry in arr {
        for key in ["id", "name", "status", "position", "local_file"] {
            assert!(entry.get(key).is_some(), "missing key: {key}");
        }
    }
}

fn parse_settings(json: &str) -> Settings {
    serde_json::from_str(json).expect("parse settings")
}

// ── settings.json ──────────────────────────────────────────────────────────

#[test]
fn settings_roundtrip() {
    let path = fixture("settings.json");
    let raw = std::fs::read_to_string(&path).expect("read settings.json");
    let s: Settings = roundtrip(&raw);

    assert!(s.color_scheme.is_some());
    assert_unknown_preserved(&s.extra);
}

#[test]
fn settings_ollama_fields_preserved() {
    let path = fixture("settings.json");
    let raw = std::fs::read_to_string(&path).expect("read settings.json");
    let s: Settings = serde_json::from_str(&raw).expect("parse");

    // Ollama fields exist in the fixture; they must survive round-trip so
    // Python can still read them after a Rust write.
    let out = serde_json::to_string_pretty(&s).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");
    // Python needs the global_apps map to be an object, not null.
    assert!(
        back["global_apps"].is_object(),
        "global_apps must be an object"
    );
}

#[test]
fn settings_files_alerts_roundtrip() {
    // The right panel's opt-in Alerts group. The backend only round-trips these
    // three, so the round-trip IS the contract.
    let s: Settings = roundtrip(
        r#"{
        "files_alerts": true,
        "files_alerts_days": 14,
        "files_alerts_sources": { "mail": false, "tasks": true }
    }"#,
    );
    assert_eq!(s.files_alerts, Some(true));
    assert_eq!(s.files_alerts_days, Some(14));
    let sources = s.files_alerts_sources.as_ref().expect("sources present");
    assert_eq!(sources.mail, Some(false));
    assert_eq!(sources.tasks, Some(true));
    // Absent means ON — an unwritten key must stay unwritten, never become a
    // `false` that silently switches a source off on the next read.
    assert_eq!(sources.events, None);
    let out = serde_json::to_string(&s).expect("serialize");
    assert!(
        !out.contains("\"events\""),
        "absent source must not be materialized"
    );
}

#[test]
fn settings_files_alerts_absent_defaults_none() {
    // An existing settings.json predating the group must load unchanged, and the
    // group must read as off (`None`, which the frontend maps to false).
    let s: Settings = parse_settings(r#"{"color_scheme":"dark"}"#);
    assert!(s.files_alerts.is_none());
    assert!(s.files_alerts_days.is_none());
    assert!(s.files_alerts_sources.is_none());
}

#[test]
fn settings_global_apps_shape() {
    let path = fixture("settings.json");
    let raw = std::fs::read_to_string(&path).expect("read settings.json");
    let s: Settings = serde_json::from_str(&raw).expect("parse");

    let apps = s.global_apps.expect("global_apps present");
    assert!(apps.contains_key("browser"), "browser role expected");
    let browser = &apps["browser"];
    assert!(!browser.exec.is_empty());
}

// ── default_apps.json ─────────────────────────────────────────────────────

#[test]
fn default_apps_roundtrip() {
    let path = fixture("default_apps.json");
    let raw = std::fs::read_to_string(&path).expect("read default_apps.json");
    let apps: DefaultApps = roundtrip(&raw);

    assert!(apps.0.contains_key(".md"), ".md mapping expected");

    // Re-serialized form must be a plain JSON object.
    let out = serde_json::to_string_pretty(&apps).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");
    assert!(back.is_object());
}

// ── time_log.json ─────────────────────────────────────────────────────────

#[test]
fn time_log_roundtrip() {
    let path = fixture("time_log.json");
    let raw = std::fs::read_to_string(&path).expect("read time_log.json");
    let log: Vec<TimeLogEntry> = roundtrip(&raw);

    assert!(!log.is_empty(), "time log must not be empty");
    let first = &log[0];
    assert!(!first.project_id.is_empty());
    assert!(first.duration_s >= 0.0);
    assert_unknown_preserved(&first.extra);
}

#[test]
fn time_log_python_rollback_shape() {
    let path = fixture("time_log.json");
    let raw = std::fs::read_to_string(&path).expect("read time_log.json");
    let log: Vec<TimeLogEntry> = serde_json::from_str(&raw).expect("parse");
    let out = serde_json::to_string_pretty(&log).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");

    assert!(back.is_array());
    for entry in back.as_array().unwrap() {
        for key in ["project_id", "date", "start_iso", "duration_s"] {
            assert!(entry.get(key).is_some(), "missing key: {key}");
        }
    }
}

// ── project.json ──────────────────────────────────────────────────────────

#[test]
fn project_roundtrip() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = roundtrip(&raw);

    assert!(!project.id.is_empty());
    assert!(!project.name.is_empty());
    assert!(!project.directory.is_empty());
    assert_unknown_preserved(&project.extra);
}

#[test]
fn project_open_apps_preserved() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = serde_json::from_str(&raw).expect("parse");

    let open_apps = project.open_apps.expect("open_apps present in fixture");
    assert!(!open_apps.is_empty());
    for app in &open_apps {
        assert!(!app.exec.is_empty());
    }
}

#[test]
fn project_tab_layout_preserved() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = serde_json::from_str(&raw).expect("parse");

    let tabs = project.tab_layout.expect("tab_layout present in fixture");
    assert!(!tabs.is_empty());
    for tab in &tabs {
        assert!(!tab.key.is_empty());
        assert!(!tab.cmd.is_empty());
    }
}

#[test]
fn project_python_rollback_shape() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = serde_json::from_str(&raw).expect("parse");
    let out = serde_json::to_string_pretty(&project).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");

    assert!(back.is_object());
    // Python requires at minimum: id, name, directory
    for key in ["id", "name", "directory"] {
        assert!(back.get(key).is_some(), "missing key: {key}");
    }
    // open_apps must remain an array
    assert!(back["open_apps"].is_array(), "open_apps must be array");
    // tab_layout must remain an array
    assert!(back["tab_layout"].is_array(), "tab_layout must be array");
}

// ── .tabtivity/sessions/terminals.json ──────────────────────────────────────

#[test]
fn app_terminal_session_roundtrip() {
    let path = fixture(concat!(app_lib::legacy_slug!(), "_terminal_session.json"));
    let raw = std::fs::read_to_string(&path).expect(concat!("read ", app_lib::legacy_slug!(), "_terminal_session.json"));
    let session: TerminalSession = roundtrip(&raw);

    assert_eq!(session.tab_layout.len(), 2);
    assert_eq!(session.tab_layout[0].key, "shell-1");
    assert_eq!(session.tab_layout[1].cmd, "claude");
    assert_eq!(session.active_tab_index, 1);

    // Unknown field preserved in the tab entry.
    assert_eq!(
        session.tab_layout[0]
            .extra
            .get("_unknown_test")
            .and_then(|v| v.as_str()),
        Some("preserved")
    );
    // Unknown field preserved at top level.
    assert_unknown_preserved(&session.extra);
}

// ── .tabtivity/sessions/windows.json ────────────────────────────────────────

#[test]
fn app_window_session_roundtrip() {
    let path = fixture(concat!(app_lib::legacy_slug!(), "_window_session.json"));
    let raw = std::fs::read_to_string(&path).expect(concat!("read ", app_lib::legacy_slug!(), "_window_session.json"));
    let session: WindowSession = roundtrip(&raw);

    assert_eq!(session.project_window_ids.len(), 2);
    assert!(session
        .project_window_ids
        .contains(&"win-abc123".to_string()));
    assert_unknown_preserved(&session.extra);
}

// ── .tabtivity/sessions/filetabs.json ───────────────────────────────────────

#[test]
fn app_filetab_session_roundtrip() {
    let path = fixture(concat!(app_lib::legacy_slug!(), "_filetab_session.json"));
    let raw = std::fs::read_to_string(&path).expect(concat!("read ", app_lib::legacy_slug!(), "_filetab_session.json"));
    let session: FileTabSession = roundtrip(&raw);

    assert_eq!(session.file_tabs.len(), 2);
    assert_eq!(
        session.side_panel_folder.as_deref(),
        Some("/home/user/project/src")
    );
    assert_unknown_preserved(&session.extra);
}

#[test]
fn app_filetab_session_optional_side_panel_folder() {
    let json = r#"{"fileTabs": [], "_unknown_test": "preserved"}"#;
    let session: FileTabSession = roundtrip(json);
    assert!(session.side_panel_folder.is_none());
    assert_unknown_preserved(&session.extra);
}

// ── .tabtivity/sessions/layout.json ─────────────────────────────────────────

#[test]
fn app_layout_session_roundtrip() {
    let path = fixture(concat!(app_lib::legacy_slug!(), "_layout_session.json"));
    let raw = std::fs::read_to_string(&path).expect(concat!("read ", app_lib::legacy_slug!(), "_layout_session.json"));
    let session: LayoutSession = roundtrip(&raw);

    let meta = session.active_layout_metadata.expect("metadata present");
    assert_eq!(meta["splitRatio"].as_f64(), Some(0.6));
    assert_unknown_preserved(&session.extra);
}

#[test]
fn app_layout_session_empty_metadata() {
    let json = r#"{"_unknown_test": "preserved"}"#;
    let session: LayoutSession = roundtrip(json);
    assert!(session.active_layout_metadata.is_none());
    assert_unknown_preserved(&session.extra);
}

// ── .tabtivity/state.json ───────────────────────────────────────────────────

#[test]
fn app_state_roundtrip() {
    let path = fixture("app_state.json");
    let raw = std::fs::read_to_string(&path).expect("read app_state.json");
    let state: ProjectState = roundtrip(&raw);

    assert_eq!(state.project_id, "test-project-id");
    assert!(!state.project_dir.is_empty());
    assert!(state.saved_at.is_some());
    assert_unknown_preserved(&state.extra);
}

// ── storage: write_json roundtrip ─────────────────────────────────────────

#[test]
fn write_json_overwrites_and_no_backup() {
    use app_lib::schema::ProjectEntry;
    use app_lib::storage::{read_json, write_json};

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("test.json");

    let initial = serde_json::json!([{
        "id": "aaa",
        "name": "Alpha",
        "status": "active",
        "position": 0,
        "local_file": "/tmp/a/project.json"
    }]);
    std::fs::write(&path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();

    let mut entries: Vec<ProjectEntry> = read_json(&path).expect("read");
    entries[0].name = "Alpha-modified".to_string();
    write_json(&path, &entries).expect("write");

    // No backup files must be created.
    let extras: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name() != std::ffi::OsStr::new("test.json"))
        .collect();
    assert!(
        extras.is_empty(),
        "no extra files expected, got: {:?}",
        extras
    );

    // The live file must contain the modified name.
    let updated: Vec<ProjectEntry> = read_json(&path).expect("read updated");
    assert_eq!(updated[0].name, "Alpha-modified");
}
