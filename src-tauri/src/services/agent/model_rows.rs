//! The rows each agent CLI's own model picker last drew, per installed build.
//!
//! A session's `/model` sheet (the Reader's model chip, steering's prompt box,
//! the markup model chip, the phone's model sheet) lists the picker the session
//! draws, and had nothing to list until it drew. The rows the last picker of
//! the same CLI build drew are kept here, so the sheet lists them at once; a
//! Tabby chat's list (`assistant_model_probe`) is kept the same way, so its
//! probe runs once per Claude build instead of once per app start.
//!
//! A preview only: the live picker replaces the rows as soon as it is drawn,
//! and a row tapped before that is answered in it by its label — a row the
//! live picker no longer has is never answered at all.
//!
//! Keyed by registry id and by the executable's identity
//! (`agent_versions::VersionSource`): updating the CLI drops its rows. Cache,
//! not truth — deleting the file costs one slower sheet.
//!
//! **Per scope.** The picker's rows are screen text, and the screen is the
//! agent's own output: a fenced agent can draw a fake picker. Rows are kept
//! under the scope of the tab that drew them (a project id, `box:<id>`,
//! `root`) and listed only in a sheet of that scope, so a fake picker reaches
//! its own scope's sheet and no other. The rows an older build kept unscoped
//! (a `rows` key) are never read and go with the next write. Tabby's `screens`
//! come from its own probe and stay apart.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::services::agent_versions::VersionSource;

/// The most rows, screens and characters one entry keeps. The pickers list a
/// dozen or two models; anything past these is not a model list.
const MAX_ROWS: usize = 64;
const MAX_LABEL: usize = 200;
const MAX_DESCRIPTION: usize = 400;
const MAX_SCREENS: usize = 24;
const MAX_SCREEN_ROWS: usize = 80;
const MAX_SCREEN_LINE: usize = 400;
/// The most scopes one entry keeps rows for (the oldest write goes first), and
/// the longest scope id taken (a longer one is refused, not cut: a cut id could
/// name another scope).
const MAX_SCOPES: usize = 32;
const MAX_SCOPE_ID: usize = 256;

/// One picker row, as the session drew it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The number the picker printed beside the row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
}

/// A picker's rows and the heading it drew above them (OpenCode's sheet groups
/// its rows only under its own heading).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rows {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub rows: Vec<Row>,
}

/// The rows one scope's session drew.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct ScopeRows {
    scope: String,
    rows: Rows,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// The executable the rows belong to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<VersionSource>,
    /// The rows each scope's sessions drew (the renderer's read), the most
    /// recently written last. The unscoped `rows` an older build wrote are not
    /// read: nothing says which scope's screen drew them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    scopes: Vec<ScopeRows>,
    /// The screens Tabby's probe captured (`assistant_model_probe`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    screens: Vec<Vec<String>>,
}

type Store = HashMap<String, Entry>;

/// `<state_dir>/model_rows.json`.
pub fn store_path() -> PathBuf {
    store_path_in(&crate::storage::state_dir())
}

pub fn store_path_in(state_dir: &Path) -> PathBuf {
    state_dir.join("model_rows.json")
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// `rows` held to the bounds, blank labels dropped.
fn bounded(rows: Rows) -> Rows {
    let title = rows.title.filter(|t| !t.trim().is_empty()).map(|t| clip(&t, MAX_LABEL));
    let rows = rows
        .rows
        .into_iter()
        .filter(|row| !row.label.trim().is_empty())
        .take(MAX_ROWS)
        .map(|row| Row {
            number: row.number,
            label: clip(&row.label, MAX_LABEL),
            description: row
                .description
                .filter(|d| !d.trim().is_empty())
                .map(|d| clip(&d, MAX_DESCRIPTION)),
        })
        .collect();
    Rows { title, rows }
}

/// The entry for `agent` when it belongs to the executable `source` names.
/// Nothing is ever answered without a source: an executable that cannot be
/// identified has no build to match.
fn entry_in(path: &Path, agent: &str, source: Option<&VersionSource>) -> Option<Entry> {
    let source = source?;
    let mut store: Store = crate::storage::read_json(path).ok()?;
    store.remove(agent).filter(|entry| entry.source.as_ref() == Some(source))
}

/// Write `fill` into `agent`'s entry for `source`; an entry of another build
/// is replaced, so its rows and screens go together.
fn patch_in(path: &Path, agent: &str, source: Option<&VersionSource>, fill: impl FnOnce(&mut Entry)) -> Result<(), String> {
    let source = source.ok_or("the CLI's executable cannot be identified")?;
    crate::storage::patch_json(path, Store::new(), |store| {
        let entry = store.entry(agent.to_string()).or_default();
        if entry.source.as_ref() != Some(source) {
            *entry = Entry { source: Some(source.clone()), ..Entry::default() };
        }
        fill(entry);
        Ok(())
    })
}

/// A scope id a row can be kept under: not blank, not absurdly long.
fn scope_id(scope: &str) -> Option<&str> {
    let scope = scope.trim();
    (!scope.is_empty() && scope.chars().count() <= MAX_SCOPE_ID).then_some(scope)
}

/// The rows `scope`'s sessions drew for `agent`'s build; nothing another
/// scope drew.
pub fn rows_in(path: &Path, agent: &str, scope: &str, source: Option<&VersionSource>) -> Option<Rows> {
    let scope = scope_id(scope)?;
    let entry = entry_in(path, agent, source)?;
    entry.scopes.into_iter().find(|kept| kept.scope == scope).map(|kept| kept.rows).filter(|rows| !rows.rows.is_empty())
}

pub fn remember_rows_in(path: &Path, agent: &str, scope: &str, source: Option<&VersionSource>, rows: Rows) -> Result<(), String> {
    let scope = scope_id(scope).ok_or("the rows need the scope of the session that drew them")?.to_string();
    let rows = bounded(rows);
    if rows.rows.is_empty() {
        return Ok(());
    }
    patch_in(path, agent, source, |entry| {
        entry.scopes.retain(|kept| kept.scope != scope);
        entry.scopes.push(ScopeRows { scope, rows });
        let over = entry.scopes.len().saturating_sub(MAX_SCOPES);
        entry.scopes.drain(..over);
    })
}

pub fn screens_in(path: &Path, agent: &str, source: Option<&VersionSource>) -> Option<Vec<Vec<String>>> {
    entry_in(path, agent, source).map(|entry| entry.screens).filter(|screens| !screens.is_empty())
}

pub fn remember_screens_in(path: &Path, agent: &str, source: Option<&VersionSource>, screens: &[Vec<String>]) -> Result<(), String> {
    let screens: Vec<Vec<String>> = screens
        .iter()
        .take(MAX_SCREENS)
        .map(|screen| screen.iter().take(MAX_SCREEN_ROWS).map(|line| clip(line, MAX_SCREEN_LINE)).collect())
        .collect();
    if screens.is_empty() {
        return Ok(());
    }
    patch_in(path, agent, source, |entry| entry.screens = screens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent_versions::version_source;

    fn row(label: &str) -> Row {
        Row { label: label.to_string(), description: None, number: None }
    }

    fn list(labels: &[&str]) -> Rows {
        Rows { title: None, rows: labels.iter().map(|label| row(label)).collect() }
    }

    /// Two executables, so two builds: a file's identity is its path, size and
    /// modification time.
    fn builds(dir: &Path) -> (VersionSource, VersionSource) {
        let old = dir.join("old");
        let new = dir.join("new");
        std::fs::write(&old, "1").unwrap();
        std::fs::write(&new, "22").unwrap();
        (version_source(&old).unwrap(), version_source(&new).unwrap())
    }

    #[test]
    fn rows_come_back_only_for_the_build_that_drew_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("model_rows.json");
        let (old, new) = builds(dir.path());
        remember_rows_in(&store, "claude", "p1", Some(&old), list(&["Opus", "Sonnet"])).unwrap();
        assert_eq!(rows_in(&store, "claude", "p1", Some(&old)), Some(list(&["Opus", "Sonnet"])));
        assert_eq!(rows_in(&store, "claude", "p1", Some(&new)), None);
        assert_eq!(rows_in(&store, "codex", "p1", Some(&old)), None);
        assert_eq!(rows_in(&store, "claude", "p1", None), None);
    }

    #[test]
    fn a_new_build_replaces_the_rows_and_the_screens_together() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("model_rows.json");
        let (old, new) = builds(dir.path());
        remember_screens_in(&store, "claude", Some(&old), &[vec!["❯ 1. Opus".to_string()]]).unwrap();
        remember_rows_in(&store, "claude", "p1", Some(&old), list(&["Opus"])).unwrap();
        // Same build: the rows join the screens.
        assert!(screens_in(&store, "claude", Some(&old)).is_some());
        remember_rows_in(&store, "claude", "p1", Some(&new), list(&["Fable"])).unwrap();
        assert_eq!(rows_in(&store, "claude", "p1", Some(&new)), Some(list(&["Fable"])));
        assert_eq!(screens_in(&store, "claude", Some(&new)), None);
        assert_eq!(rows_in(&store, "claude", "p1", Some(&old)), None);
    }

    #[test]
    fn rows_are_held_to_the_bounds_and_an_empty_list_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("model_rows.json");
        let (old, _) = builds(dir.path());
        remember_rows_in(&store, "claude", "p1", Some(&old), list(&["  "])).unwrap();
        assert!(!store.exists());
        let many: Vec<Row> = (0..100)
            .map(|n| Row { label: format!("{n}{}", "x".repeat(500)), description: Some(" ".to_string()), number: Some(n) })
            .collect();
        remember_rows_in(&store, "claude", "p1", Some(&old), Rows { title: Some(" ".to_string()), rows: many }).unwrap();
        let Rows { title, rows } = rows_in(&store, "claude", "p1", Some(&old)).unwrap();
        assert_eq!(title, None);
        assert_eq!(rows.len(), MAX_ROWS);
        assert!(rows.iter().all(|row| row.label.chars().count() == MAX_LABEL && row.description.is_none()));
    }

    #[test]
    fn nothing_is_written_for_an_executable_that_cannot_be_identified() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("model_rows.json");
        assert!(remember_rows_in(&store, "claude", "p1", None, list(&["Opus"])).is_err());
        assert!(!store.exists());
    }

    /// Gap 95: a fenced agent's fake picker, read off its own tab's screen, is
    /// listed in that scope's sheets and in no other scope's.
    #[test]
    fn rows_are_listed_only_in_the_scope_that_drew_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("model_rows.json");
        let (old, _) = builds(dir.path());
        remember_rows_in(&store, "claude", "p1", Some(&old), list(&["Opus"])).unwrap();
        remember_rows_in(&store, "claude", "p2", Some(&old), list(&["Planted", "Sonnet"])).unwrap();
        assert_eq!(rows_in(&store, "claude", "p1", Some(&old)), Some(list(&["Opus"])));
        assert_eq!(rows_in(&store, "claude", "p2", Some(&old)), Some(list(&["Planted", "Sonnet"])));
        assert_eq!(rows_in(&store, "claude", "p3", Some(&old)), None);
        assert_eq!(rows_in(&store, "claude", "box:p1", Some(&old)), None);
        assert_eq!(rows_in(&store, "claude", "", Some(&old)), None);
        // A later list of the same scope replaces its own, not the others'.
        remember_rows_in(&store, "claude", "p1", Some(&old), list(&["Fable"])).unwrap();
        assert_eq!(rows_in(&store, "claude", "p1", Some(&old)), Some(list(&["Fable"])));
        assert_eq!(rows_in(&store, "claude", "p2", Some(&old)), Some(list(&["Planted", "Sonnet"])));
    }

    /// The unscoped `rows` an older build wrote are never listed (a fake picker
    /// could have planted them), the file still reads, and Tabby's screens in
    /// the same entry survive the next write.
    #[test]
    fn an_older_builds_unscoped_rows_are_never_shown() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("model_rows.json");
        let (old, _) = builds(dir.path());
        remember_screens_in(&store, "claude", Some(&old), &[vec!["❯ 1. Opus".to_string()]]).unwrap();
        let mut file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&store).unwrap()).unwrap();
        file["claude"]["rows"] = serde_json::json!({ "rows": [{ "label": "Planted" }] });
        std::fs::write(&store, file.to_string()).unwrap();
        assert_eq!(rows_in(&store, "claude", "p1", Some(&old)), None);
        assert_eq!(rows_in(&store, "claude", "root", Some(&old)), None);
        remember_rows_in(&store, "claude", "p1", Some(&old), list(&["Opus"])).unwrap();
        assert_eq!(rows_in(&store, "claude", "p1", Some(&old)), Some(list(&["Opus"])));
        assert!(screens_in(&store, "claude", Some(&old)).is_some(), "Tabby's screens stay apart");
        assert!(!std::fs::read_to_string(&store).unwrap().contains("Planted"));
    }

    #[test]
    fn the_scope_count_is_capped_and_the_oldest_goes_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("model_rows.json");
        let (old, _) = builds(dir.path());
        for n in 0..MAX_SCOPES + 3 {
            remember_rows_in(&store, "claude", &format!("p{n}"), Some(&old), list(&["Opus"])).unwrap();
        }
        assert_eq!(rows_in(&store, "claude", "p0", Some(&old)), None);
        assert_eq!(rows_in(&store, "claude", "p2", Some(&old)), None);
        assert!(rows_in(&store, "claude", "p3", Some(&old)).is_some());
        assert!(rows_in(&store, "claude", &format!("p{}", MAX_SCOPES + 2), Some(&old)).is_some());
        let long = "x".repeat(MAX_SCOPE_ID + 1);
        assert!(remember_rows_in(&store, "claude", &long, Some(&old), list(&["Opus"])).is_err());
        assert!(remember_rows_in(&store, "claude", "  ", Some(&old), list(&["Opus"])).is_err());
    }
}
