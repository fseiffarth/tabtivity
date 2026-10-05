use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::project::{OpenApp, TabEntry};

/// A project's terminal tab layout snapshot.
///
/// Lives at `<state_dir>/sessions/<project key>/terminals.json` — see
/// [`crate::storage::project_session_dir`] for why it is **not** in the project
/// tree. A copy is still written to `<project>/.tabtivity/sessions/terminals.json`
/// so the layout keeps travelling with a folder that gets synced or copied, but
/// that copy is **export-only**: nothing reads it without an explicit user
/// action (`commands::projects::adopt_folder_tab_layout`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub tab_layout: Vec<TabEntry>,
    #[serde(default)]
    pub active_tab_index: usize,
    /// Opaque split/group layout tree (frontend-owned). Absent for legacy
    /// sessions, where the frontend rebuilds a single root group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_groups: Option<Value>,
    /// Opaque list of open agent-session UUIDs (frontend-owned).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_tab_sessions: Option<Value>,
    /// Standalone apps to relaunch on project activation. Moved here out of
    /// `project.json`, whose home is the container's writable mount: this list
    /// is a host-side `spawn_reaped` on every activation, so it is exactly the
    /// kind of state that must not be writable from inside the boundary it
    /// escapes. Still filtered by `services::restore_service`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_apps: Option<Vec<OpenApp>>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.tabtivity/sessions/windows.json` — project-owned window registry IDs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowSession {
    pub project_window_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.tabtivity/sessions/filetabs.json` — file browser tab state and side panel.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileTabSession {
    pub file_tabs: Vec<Value>,
    /// The folder the side panel was browsing. Serialized as `sidePanelFolder`;
    /// the alias reads back the `rightPanelFolder` every build before the panel
    /// was renamed wrote, so an existing `filetabs.json` keeps its folder. Only
    /// the new spelling is ever written — and an older Tabtivity reading a new file
    /// merely opens the panel at the project root, which is what it does for a
    /// project that never had one.
    #[serde(alias = "rightPanelFolder", skip_serializing_if = "Option::is_none")]
    pub side_panel_folder: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.tabtivity/sessions/layout.json` — active layout metadata.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSession {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_layout_metadata: Option<Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.tabtivity/state.json` — top-level project runtime state.
///
/// Written whenever a project is switched away from so that the next restore
/// can quickly identify the last-known runtime state without reading all
/// session sub-files.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub project_id: String,
    pub project_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json<T: serde::Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("serialize")
    }

    /// The panel was renamed: `rightPanelFolder` from an older `filetabs.json`
    /// still reads, only `sidePanelFolder` is ever written, and the old key
    /// does not linger in `extra` beside the new one.
    #[test]
    fn file_tab_session_reads_the_legacy_right_panel_key_and_writes_the_new_one() {
        let legacy: FileTabSession =
            serde_json::from_str(r#"{"fileTabs":[],"rightPanelFolder":"src/lib"}"#).unwrap();
        assert_eq!(legacy.side_panel_folder.as_deref(), Some("src/lib"));
        assert!(legacy.extra.is_empty(), "alias must not also land in extra");
        let out = json(&legacy);
        assert_eq!(out["sidePanelFolder"], "src/lib");
        assert!(out.get("rightPanelFolder").is_none());

        let current: FileTabSession =
            serde_json::from_str(r#"{"fileTabs":[{"path":"a.rs"}],"sidePanelFolder":"docs"}"#)
                .unwrap();
        assert_eq!(current.side_panel_folder.as_deref(), Some("docs"));
        assert_eq!(current.file_tabs.len(), 1);
        let none = FileTabSession::default();
        assert!(json(&none).get("sidePanelFolder").is_none(), "absent, not null");
    }

    /// A `terminals.json` written before `activeTabIndex`, `tabGroups` or
    /// `openApps` existed loads with defaults, and writing back adds no null
    /// keys — the file stays readable by an older build.
    #[test]
    fn terminal_session_defaults_for_a_legacy_file_and_omits_absent_optionals() {
        let legacy: TerminalSession = serde_json::from_str(r#"{"tabLayout":[]}"#).unwrap();
        assert_eq!(legacy.active_tab_index, 0);
        assert!(legacy.tab_groups.is_none());
        assert!(legacy.open_apps.is_none());
        let out = json(&legacy);
        assert_eq!(out["activeTabIndex"], 0);
        for key in ["tabGroups", "openTabSessions", "openApps"] {
            assert!(out.get(key).is_none(), "{key} should be absent: {out}");
        }
        assert!(out.get("tab_layout").is_none(), "wire keys are camelCase");
    }

    /// `openApps` and the opaque trees round-trip in full, and unknown keys
    /// ride through `extra`.
    #[test]
    fn terminal_session_round_trips_open_apps_and_unknown_keys() {
        let raw = r#"{
            "tabLayout":[{"key":"t","label":"sh","cmd":"bash","cwd":"/p","location":"local"}],
            "activeTabIndex":1,
            "tabGroups":{"kind":"group","tabs":["t"]},
            "openTabSessions":["u1"],
            "openApps":[{"exec":"code","mode":"standalone","pid":42}],
            "futureKey":{"x":1}
        }"#;
        let s: TerminalSession = serde_json::from_str(raw).unwrap();
        assert_eq!(s.active_tab_index, 1);
        assert_eq!(s.tab_layout[0].extra["location"], "local");
        let apps = s.open_apps.as_ref().unwrap();
        assert_eq!(apps[0].pid, Some(42));
        assert_eq!(s.extra["futureKey"]["x"], 1);
        let back: TerminalSession = serde_json::from_value(json(&s)).unwrap();
        assert_eq!(back.open_apps.unwrap()[0].mode.as_deref(), Some("standalone"));
        assert_eq!(back.tab_groups.unwrap()["tabs"][0], "t");
        assert_eq!(back.extra["futureKey"]["x"], 1);
    }

    /// `.tabtivity/state.json` is camelCase and omits `savedAt` when unknown.
    #[test]
    fn project_state_is_camel_case_and_omits_an_absent_timestamp() {
        let state = ProjectState {
            project_id: "p1".into(),
            project_dir: "/tmp/p1".into(),
            saved_at: None,
            extra: HashMap::new(),
        };
        let out = json(&state);
        assert_eq!(out["projectId"], "p1");
        assert_eq!(out["projectDir"], "/tmp/p1");
        assert!(out.get("savedAt").is_none());
        assert!(out.get("project_id").is_none());
        let back: ProjectState =
            serde_json::from_str(r#"{"projectId":"p","projectDir":"/d","savedAt":"2026-01-01T00:00:00+00:00"}"#)
                .unwrap();
        assert_eq!(back.saved_at.as_deref(), Some("2026-01-01T00:00:00+00:00"));
    }

    /// The window and layout sessions default to empty and keep foreign keys.
    #[test]
    fn window_and_layout_sessions_default_empty_and_keep_foreign_keys() {
        let w: WindowSession =
            serde_json::from_str(r#"{"projectWindowIds":["0x1"],"legacyIds":[1]}"#).unwrap();
        assert_eq!(w.project_window_ids, vec!["0x1"]);
        assert_eq!(w.extra["legacyIds"][0], 1);
        assert_eq!(json(&WindowSession::default())["projectWindowIds"], serde_json::json!([]));

        let l: LayoutSession = serde_json::from_str("{}").unwrap();
        assert!(l.active_layout_metadata.is_none());
        assert_eq!(json(&l), serde_json::json!({}));
    }
}
