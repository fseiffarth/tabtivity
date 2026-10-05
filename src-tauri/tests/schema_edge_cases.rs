//! Edge-case and invariant tests for the Tabtivity schema types.
//!
//! These complement schema_roundtrip.rs (which tests real fixtures) by
//! covering degenerate inputs, default values, and Python-rollback invariants
//! that can be constructed inline without fixture files.

use app_lib::schema::project::TabEntry;
use app_lib::schema::{
    DefaultApps, Project, ProjectEntry, Settings, TerminalSession, TimeLogEntry, WindowSession,
};

// ── helpers ────────────────────────────────────────────────────────────────

fn roundtrip<T: serde::Serialize + serde::de::DeserializeOwned>(value: &T) -> T {
    let s = serde_json::to_string(value).unwrap();
    serde_json::from_str(&s).unwrap()
}

fn parse<T: serde::de::DeserializeOwned>(json: &str) -> T {
    serde_json::from_str(json).expect("parse")
}

// ── Settings ───────────────────────────────────────────────────────────────

#[test]
fn settings_default_color_scheme_is_light_lavender() {
    let s = Settings::default();
    assert_eq!(s.color_scheme(), "light_lavender");
}

#[test]
fn settings_explicit_color_scheme_is_returned() {
    let s = Settings {
        color_scheme: Some("light".to_string()),
        ..Default::default()
    };
    assert_eq!(s.color_scheme(), "light");
}

#[test]
fn settings_debug_defaults_off() {
    let s = Settings::default();
    assert_eq!(s.debug, None);
}

#[test]
fn settings_empty_json_parses_to_defaults() {
    let s: Settings = parse("{}");
    assert!(s.color_scheme.is_none());
    assert!(s.global_apps.is_none());
}

#[test]
fn settings_keyboard_shortcuts_absent_defaults_none() {
    // Group L / #62: existing settings.json without the field must still load.
    let s: Settings = parse(r#"{"color_scheme":"dark"}"#);
    assert!(s.keyboard_shortcuts.is_none());
}

#[test]
fn settings_keyboard_shortcuts_roundtrip() {
    // A custom chord override survives parse → serialize → parse.
    let s: Settings = parse(
        r#"{
        "keyboard_shortcuts": {
            "closeTab": { "key": "q", "ctrl": true },
            "cycleTabs": { "key": "Tab", "shift": true }
        }
    }"#,
    );
    let map = s.keyboard_shortcuts.as_ref().expect("map present");
    assert_eq!(map["closeTab"].key, "q");
    assert!(map["closeTab"].ctrl);
    assert!(!map["closeTab"].shift);
    let back = roundtrip(&s);
    let back_map = back
        .keyboard_shortcuts
        .expect("map present after roundtrip");
    assert_eq!(back_map["cycleTabs"].key, "Tab");
    assert!(back_map["cycleTabs"].shift);
    assert!(!back_map["cycleTabs"].ctrl);
}

#[test]
fn settings_steering_keys_roundtrip() {
    // Steering-mode rebinds: a replaced list and an unbound (empty) one both
    // survive parse → serialize → parse; absent stays absent.
    let none: Settings = parse(r#"{"color_scheme":"dark"}"#);
    assert!(none.steering_keys.is_none());
    let s: Settings = parse(r#"{"steering_keys":{"up":["i","ArrowUp"],"files":[]}}"#);
    let back = roundtrip(&s).steering_keys.expect("map present after roundtrip");
    assert_eq!(back["up"], vec!["i".to_string(), "ArrowUp".to_string()]);
    assert!(back["files"].is_empty());
}

#[test]
fn settings_unknown_fields_preserved_in_extra() {
    let s: Settings = parse(r#"{"color_scheme":"dark","future_field":42}"#);
    assert!(
        s.extra.contains_key("future_field"),
        "unknown field must be preserved"
    );
    assert_eq!(s.extra["future_field"].as_i64(), Some(42));
}

#[test]
fn settings_roundtrip_preserves_all_known_fields() {
    let s: Settings = parse(
        r#"{
        "color_scheme": "light",
        "ollama_host": "http://localhost:11434",
        "ollama_model": "mistral"
    }"#,
    );
    let back = roundtrip(&s);
    assert_eq!(back.color_scheme.as_deref(), Some("light"));
    assert_eq!(back.ollama_host.as_deref(), Some("http://localhost:11434"));
    assert_eq!(back.ollama_model.as_deref(), Some("mistral"));
}

// ── ProjectEntry ───────────────────────────────────────────────────────────

#[test]
fn project_entry_parses_required_fields() {
    let e: ProjectEntry = parse(
        r#"{
        "id": "abc",
        "name": "My Project",
        "status": "inactive",
        "position": 10,
        "local_file": "/home/user/p/project.json"
    }"#,
    );
    assert_eq!(e.id, "abc");
    assert_eq!(e.name, "My Project");
    assert_eq!(e.status, "inactive");
    assert_eq!(e.position, 10);
}

#[test]
fn project_entry_status_values() {
    for status in &["current", "active", "inactive"] {
        let json = format!(
            r#"{{"id":"x","name":"X","status":"{status}","position":0,"local_file":"/x/p.json"}}"#
        );
        let e: ProjectEntry = parse(&json);
        assert_eq!(&e.status, status);
    }
}

#[test]
fn project_entry_extra_fields_survive_roundtrip() {
    let e: ProjectEntry = parse(
        r#"{
        "id":"x","name":"X","status":"active","position":1,"local_file":"/x",
        "directory": "/home/user/x",
        "future_key": "future_value"
    }"#,
    );
    let back = roundtrip(&e);
    assert_eq!(back.extra["directory"].as_str(), Some("/home/user/x"));
    assert_eq!(back.extra["future_key"].as_str(), Some("future_value"));
}

// ── Project ────────────────────────────────────────────────────────────────

#[test]
fn project_default_is_all_none() {
    let p = Project::default();
    assert!(p.git_type.is_none());
    assert!(p.tab_layout.is_none());
    assert!(p.open_apps.is_none());
    assert!(p.status.is_none());
}

#[test]
fn project_empty_json_uses_defaults() {
    let p: Project = parse(r#"{"id":"","name":"","directory":""}"#);
    assert!(p.tab_layout.is_none());
    assert!(p.open_apps.is_none());
}

#[test]
fn project_tab_layout_round_trips() {
    let p: Project = parse(
        r#"{
        "id":"p","name":"P","directory":"/p",
        "tab_layout": [
            {"key":"t1","label":"T1","cmd":"bash","cwd":"/tmp"}
        ]
    }"#,
    );
    let tabs = p.tab_layout.as_ref().unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].key, "t1");

    let back = roundtrip(&p);
    assert_eq!(back.tab_layout.as_ref().unwrap()[0].cmd, "bash");
}

#[test]
fn project_open_apps_embedded_flag_preserved() {
    let p: Project = parse(
        r#"{
        "id":"p","name":"P","directory":"/p",
        "open_apps": [{"exec":"code","mode":"embedded"},{"exec":"firefox"}]
    }"#,
    );
    let apps = p.open_apps.as_ref().unwrap();
    assert_eq!(apps[0].mode.as_deref(), Some("embedded"));
    assert!(apps[1].mode.is_none());
}

#[test]
fn project_unknown_fields_preserved() {
    let p: Project = parse(r#"{"id":"p","name":"P","directory":"/p","custom_field":"val"}"#);
    assert_eq!(p.extra["custom_field"].as_str(), Some("val"));
    let back = roundtrip(&p);
    assert_eq!(back.extra["custom_field"].as_str(), Some("val"));
}

// ── TimeLogEntry ───────────────────────────────────────────────────────────

#[test]
fn time_log_entry_parses_all_fields() {
    let e: TimeLogEntry = parse(
        r#"{
        "project_id": "proj-1",
        "date": "2026-06-03",
        "start_iso": "2026-06-03T10:00:00+00:00",
        "duration_s": 300.5
    }"#,
    );
    assert_eq!(e.project_id, "proj-1");
    assert_eq!(e.date, "2026-06-03");
    assert_eq!(e.duration_s, 300.5);
}

#[test]
fn time_log_entry_duration_zero_is_valid() {
    let e: TimeLogEntry = parse(
        r#"{
        "project_id":"p","date":"2026-01-01","start_iso":"2026-01-01T00:00:00Z","duration_s":0.0
    }"#,
    );
    assert_eq!(e.duration_s, 0.0);
}

#[test]
fn time_log_entry_unknown_fields_preserved() {
    let e: TimeLogEntry = parse(
        r#"{
        "project_id":"p","date":"2026-01-01","start_iso":"2026-01-01T00:00:00Z",
        "duration_s":1.0,"end_iso":"2026-01-01T00:00:01Z"
    }"#,
    );
    assert_eq!(e.extra["end_iso"].as_str(), Some("2026-01-01T00:00:01Z"));
}

// ── TerminalSession ────────────────────────────────────────────────────────
// Note: TerminalSession uses #[serde(rename_all = "camelCase")].

#[test]
fn terminal_session_default_active_tab_is_zero() {
    let s: TerminalSession = parse(r#"{"tabLayout":[]}"#);
    assert_eq!(s.active_tab_index, 0);
}

#[test]
fn terminal_session_with_tabs_roundtrip() {
    let s: TerminalSession = parse(
        r#"{
        "tabLayout": [
            {"key":"s1","label":"Shell","cmd":"bash","cwd":"/home"},
            {"key":"a1","label":"Agent","cmd":"claude","cwd":"/home/proj"}
        ],
        "activeTabIndex": 1
    }"#,
    );
    assert_eq!(s.tab_layout.len(), 2);
    assert_eq!(s.active_tab_index, 1);
    let back = roundtrip(&s);
    assert_eq!(back.tab_layout[1].cmd, "claude");
    assert_eq!(back.active_tab_index, 1);
}

#[test]
fn terminal_session_empty_tabs_valid() {
    let s: TerminalSession = parse(r#"{"tabLayout":[],"activeTabIndex":0}"#);
    assert!(s.tab_layout.is_empty());
}

// ── WindowSession ─────────────────────────────────────────────────────────
// Note: WindowSession uses #[serde(rename_all = "camelCase")].

#[test]
fn window_session_empty_ids_valid() {
    let s: WindowSession = parse(r#"{"projectWindowIds":[]}"#);
    assert!(s.project_window_ids.is_empty());
}

#[test]
fn window_session_ids_roundtrip() {
    let s: WindowSession = parse(r#"{"projectWindowIds":["a","b","c"]}"#);
    let back = roundtrip(&s);
    let mut ids = back.project_window_ids.clone();
    ids.sort();
    assert_eq!(ids, vec!["a", "b", "c"]);
}

#[test]
fn window_session_unknown_fields_preserved() {
    let s: WindowSession = parse(r#"{"projectWindowIds":["w1"],"extra_meta":99}"#);
    assert_eq!(s.extra["extra_meta"].as_i64(), Some(99));
}

// ── DefaultApps ────────────────────────────────────────────────────────────

#[test]
fn default_apps_empty_map_valid() {
    let d: DefaultApps = parse("{}");
    assert!(d.0.is_empty());
}

#[test]
fn default_apps_extension_mapping() {
    let d: DefaultApps = parse(r#"{".rs":"code",".md":"obsidian"}"#);
    assert_eq!(d.0[".rs"], "code");
    assert_eq!(d.0[".md"], "obsidian");
}

#[test]
fn default_apps_get_method() {
    let d: DefaultApps = parse(r#"{".pdf":"evince"}"#);
    assert_eq!(d.get(".pdf"), Some("evince"));
    assert_eq!(d.get(".xyz"), None);
}

#[test]
fn default_apps_roundtrip_preserves_extensions() {
    let d: DefaultApps = parse(r#"{".pdf":"evince",".png":"eog"}"#);
    let back = roundtrip(&d);
    assert!(back.0.contains_key(".pdf"));
    assert!(back.0.contains_key(".png"));
}

// ── TabEntry ───────────────────────────────────────────────────────────────

#[test]
fn tab_entry_unknown_fields_preserved() {
    // Use ## delimiters so the JSON value "#ff0" doesn't end the raw string.
    let t: TabEntry = parse(r##"{"key":"k","label":"L","cmd":"bash","cwd":"/","color":"#ff0"}"##);
    assert_eq!(t.extra["color"].as_str(), Some("#ff0"));
    let back = roundtrip(&t);
    assert_eq!(back.extra["color"].as_str(), Some("#ff0"));
}

#[test]
fn tab_entry_all_fields_roundtrip() {
    let t: TabEntry = parse(r#"{"key":"s-1","label":"Shell","cmd":"bash","cwd":"/home/user"}"#);
    let back = roundtrip(&t);
    assert_eq!(back.key, "s-1");
    assert_eq!(back.label, "Shell");
    assert_eq!(back.cmd, "bash");
    assert_eq!(back.cwd, "/home/user");
}
