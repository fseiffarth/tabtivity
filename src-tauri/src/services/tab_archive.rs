//! The per-scope tab archive: tabs the user put away on purpose, kept beside the
//! saved layout in `<state_dir>/sessions/<id>/archived_tabs.json` and shown only
//! when asked for (the + menu's archive list, the side panel's Archive section,
//! the phone's project view).
//!
//! An archived tab is the persisted tab shape the layout uses (`toSavedTabEntry`
//! in the window), so a restore builds it the way a restart does
//! (`restoreSavedTab`): a resumable agent comes back on its resume args, a shell
//! respawns in its folder, a viewer reopens its file. The process ended when the
//! tab was archived; nothing runs while it sits here.
//!
//! The file lives in the state dir, never in the project folder, and every read
//! still passes through the layout's own sanitizer
//! (`terminal_service::sanitize_loaded_layout`): what comes back from here is
//! handed to `pty_spawn` like a restored layout, so it gets the same second
//! layer. The chat assistant's scope has no archive (its chats are their own
//! list). Writes are patches (`storage::patch_json`): add, take one, delete —
//! never a whole-document save, so a browser client can use the same verbs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::project::TabEntry;
use crate::storage;

/// The archive's file in a scope's session dir.
pub const ARCHIVE_FILE: &str = "archived_tabs.json";

/// How many tabs one scope keeps. Past it the oldest go: the archive is a
/// shelf, not a history, and a list this long is only searched.
pub const MAX_ARCHIVED_TABS: usize = 500;

/// The event every window receives when a scope's archive changed: `{ scope }`.
pub const TAB_ARCHIVE_CHANGED_EVENT: &str = "tab-archive:changed";

/// `archived_tabs.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArchiveFile {
    /// Newest first.
    #[serde(default)]
    pub entries: Vec<ArchivedTab>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One archived tab.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedTab {
    /// Opaque, minted at archive time: what the window and the phone name the
    /// entry by. Never the tab's session id.
    pub id: String,
    /// Unix milliseconds.
    pub archived_at: u64,
    pub tab: TabEntry,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// The shape an archive id must have — what [`mint_id`] makes, checked on
/// every id that comes in from a window or the phone.
pub fn archive_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn mint_id() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    crate::digest::hex(&bytes)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn refuse_scope(project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() {
        return Err("no scope".to_string());
    }
    if storage::is_assistant_scope(project_id) {
        return Err("the assistant's chats are not archived".to_string());
    }
    Ok(())
}

/// The archive file of `project_id` under `state_dir`'s sessions root.
pub fn archive_path_in(state_dir: &Path, project_id: &str) -> PathBuf {
    state_dir.join("sessions").join(storage::project_key(project_id)).join(ARCHIVE_FILE)
}

/// The archive file of `project_id` in this installation's state dir.
pub fn archive_path(project_id: &str) -> PathBuf {
    storage::project_session_dir(project_id).join(ARCHIVE_FILE)
}

/// Read an archive file verbatim; a missing or unreadable one is empty.
fn read_file(path: &Path) -> ArchiveFile {
    if !path.exists() {
        return ArchiveFile::default();
    }
    storage::read_json::<ArchiveFile>(path).unwrap_or_default()
}

/// The archive's entries as they may reach a spawn: through the layout's
/// sanitizer, as a restored layout is.
fn sanitized(mut entries: Vec<ArchivedTab>) -> Vec<ArchivedTab> {
    let mut tabs: Vec<TabEntry> = entries.iter().map(|e| e.tab.clone()).collect();
    crate::services::terminal_service::sanitize_loaded_layout(&mut tabs);
    for (entry, tab) in entries.iter_mut().zip(tabs) {
        entry.tab = tab;
    }
    entries
}

/// A scope's archived tabs, newest first, sanitized.
pub fn list(project_id: &str) -> Result<Vec<ArchivedTab>, String> {
    refuse_scope(project_id)?;
    Ok(sanitized(read_file(&archive_path(project_id)).entries))
}

/// [`list`] at an explicit path, unsanitized — the phone's rows, which carry
/// only labels and kinds.
pub fn list_at(path: &Path) -> Vec<ArchivedTab> {
    read_file(path).entries
}

/// Put `tabs` into the scope's archive, newest first, each under a fresh id;
/// past [`MAX_ARCHIVED_TABS`] the oldest drop out. Answers the new entries.
pub fn add(project_id: &str, tabs: Vec<TabEntry>) -> Result<Vec<ArchivedTab>, String> {
    refuse_scope(project_id)?;
    add_at(&archive_path(project_id), tabs, now_ms())
}

fn add_at(path: &Path, tabs: Vec<TabEntry>, at: u64) -> Result<Vec<ArchivedTab>, String> {
    if tabs.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create session dir: {e}"))?;
    }
    let added: Vec<ArchivedTab> = tabs
        .into_iter()
        .map(|tab| ArchivedTab { id: mint_id(), archived_at: at, tab, extra: HashMap::new() })
        .collect();
    let fresh = added.clone();
    storage::patch_json(path, ArchiveFile::default(), move |file| {
        // The first tab of a batch archived together sits on top, as it sat
        // first in the strip.
        let mut entries = fresh;
        entries.append(&mut file.entries);
        entries.truncate(MAX_ARCHIVED_TABS);
        file.entries = entries;
        Ok(())
    })?;
    Ok(sanitized(added))
}

/// Remove and answer the entry `id` names — what a restore brings back.
/// `None` when it is gone (restored elsewhere, deleted).
pub fn take(project_id: &str, id: &str) -> Result<Option<ArchivedTab>, String> {
    refuse_scope(project_id)?;
    if !archive_id_ok(id) {
        return Err("invalid archive id".to_string());
    }
    take_at(&archive_path(project_id), id).map(|taken| taken.map(|entry| sanitized(vec![entry]).remove(0)))
}

fn take_at(path: &Path, id: &str) -> Result<Option<ArchivedTab>, String> {
    if !path.exists() {
        return Ok(None);
    }
    storage::patch_json(path, ArchiveFile::default(), |file| {
        let at = file.entries.iter().position(|e| e.id == id);
        Ok(at.map(|at| file.entries.remove(at)))
    })
}

/// Drop the entries `ids` name for good. Answers how many went.
pub fn delete(project_id: &str, ids: &[String]) -> Result<usize, String> {
    refuse_scope(project_id)?;
    if ids.iter().any(|id| !archive_id_ok(id)) {
        return Err("invalid archive id".to_string());
    }
    delete_at(&archive_path(project_id), ids)
}

fn delete_at(path: &Path, ids: &[String]) -> Result<usize, String> {
    if ids.is_empty() || !path.exists() {
        return Ok(0);
    }
    storage::patch_json(path, ArchiveFile::default(), |file| {
        let before = file.entries.len();
        file.entries.retain(|e| !ids.contains(&e.id));
        Ok(before - file.entries.len())
    })
}

/// Re-point the archived tabs' paths after the project folder moved from `old`
/// to `new`, as [`terminal_service::rewrite_session_paths`] does for the
/// layout. Read and written as plain JSON so fields this build does not model
/// survive. Answers whether the file changed.
///
/// [`terminal_service::rewrite_session_paths`]: crate::services::terminal_service::rewrite_session_paths
pub fn rewrite_paths(project_id: &str, old: &str, new: &str) -> Result<bool, String> {
    let path = archive_path(project_id);
    if !path.exists() {
        return Ok(false);
    }
    storage::patch_json(&path, Value::Null, |file| Ok(storage::rewrite_path_prefix(file, old, new)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(label: &str) -> TabEntry {
        serde_json::from_value(serde_json::json!({
            "key": "k", "label": label, "cmd": "", "cwd": "/p", "kind": "shell",
        }))
        .unwrap()
    }

    fn path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("sessions").join("p").join(ARCHIVE_FILE)
    }

    #[test]
    fn add_puts_a_batch_on_top_in_strip_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = path(&dir);
        add_at(&path, vec![tab("old")], 1).unwrap();
        let added = add_at(&path, vec![tab("a"), tab("b")], 2).unwrap();
        assert_eq!(added.len(), 2);
        let labels: Vec<String> = list_at(&path).into_iter().map(|e| e.tab.label).collect();
        assert_eq!(labels, ["a", "b", "old"]);
        assert!(list_at(&path).iter().all(|e| archive_id_ok(&e.id)));
    }

    #[test]
    fn the_oldest_drop_out_past_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = path(&dir);
        add_at(&path, (0..MAX_ARCHIVED_TABS).map(|i| tab(&format!("t{i}"))).collect(), 1).unwrap();
        add_at(&path, vec![tab("newest")], 2).unwrap();
        let entries = list_at(&path);
        assert_eq!(entries.len(), MAX_ARCHIVED_TABS);
        assert_eq!(entries[0].tab.label, "newest");
        assert!(entries.iter().all(|e| e.tab.label != format!("t{}", MAX_ARCHIVED_TABS - 1)));
    }

    #[test]
    fn take_removes_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = path(&dir);
        let added = add_at(&path, vec![tab("a"), tab("b")], 1).unwrap();
        let taken = take_at(&path, &added[1].id).unwrap().expect("taken");
        assert_eq!(taken.tab.label, "b");
        assert!(take_at(&path, &added[1].id).unwrap().is_none());
        assert_eq!(list_at(&path).len(), 1);
    }

    #[test]
    fn delete_drops_named_entries_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = path(&dir);
        let added = add_at(&path, vec![tab("a"), tab("b"), tab("c")], 1).unwrap();
        let gone = delete_at(&path, &[added[0].id.clone(), added[2].id.clone(), "nope".to_string()]).unwrap();
        assert_eq!(gone, 2);
        let labels: Vec<String> = list_at(&path).into_iter().map(|e| e.tab.label).collect();
        assert_eq!(labels, ["b"]);
    }

    #[test]
    fn a_missing_file_is_an_empty_archive() {
        let dir = tempfile::tempdir().unwrap();
        let path = path(&dir);
        assert!(list_at(&path).is_empty());
        assert!(take_at(&path, "abc").unwrap().is_none());
        assert_eq!(delete_at(&path, &["abc".to_string()]).unwrap(), 0);
    }

    #[test]
    fn unknown_fields_survive_a_patch() {
        let dir = tempfile::tempdir().unwrap();
        let path = path(&dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({
                "future": 1,
                "entries": [{ "id": "x1", "archivedAt": 5, "note": "kept",
                  "tab": { "key": "k", "label": "a", "cmd": "", "cwd": "/p", "viewerState": { "page": 3 } } }]
            })
            .to_string(),
        )
        .unwrap();
        add_at(&path, vec![tab("b")], 6).unwrap();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["future"], 1);
        assert_eq!(raw["entries"][1]["note"], "kept");
        assert_eq!(raw["entries"][1]["tab"]["viewerState"]["page"], 3);
    }

    #[test]
    fn ids_of_the_wrong_shape_are_refused() {
        assert!(!archive_id_ok(""));
        assert!(!archive_id_ok("../x"));
        assert!(!archive_id_ok(&"a".repeat(65)));
        assert!(archive_id_ok("0b8f6c1e"));
    }

    #[test]
    fn the_assistant_scope_has_no_archive() {
        assert!(refuse_scope("assistant").is_err());
        assert!(refuse_scope(" ").is_err());
        assert!(refuse_scope("root").is_ok());
    }
}
