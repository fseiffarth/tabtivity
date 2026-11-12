//! Result references an agent lists for its own tab (`tab_set_results`,
//! `cockpitMeta.results`): which projects may carry them, what a path may
//! look like, where it stands against the project folder, and the re-check the
//! desktop's explicit open makes. Design: `docs/cockpit_mcp_extensions_plan.md`
//! (step 3, decisions 9-13), as built: `docs/context/cockpit_mcp.md`.
//!
//! A reference is text, never a capability. Publishing stats the path
//! (symlink/canonicalize resolution only) and reads no file content; nothing
//! is previewed, launched or sent anywhere. The user's click asks the host
//! ([`open_in`]) to judge the *stored* reference again, and only then does the
//! existing viewer path (`openPathLink`) open the file.
//!
//! The project root comes from the trusted registry (`projects.json`), never
//! from an in-folder `project.json`, and remoteness from the record's own
//! `remote` spec through `services::remote` - never from the path's shape.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::commands::fs::FileEntry;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::services::cockpit_meta::{self as meta, ResultItem};
use crate::services::{fs_confine, remote, workspace};

/// The project a scope's results are judged against: its folder as the
/// registry spells it, and where that resolves now.
#[derive(Debug, Clone)]
pub struct Root {
    pub dir: PathBuf,
    pub real: PathBuf,
}

/// Where a reference's target stands against the project folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// Exists and resolves inside the folder.
    Inside,
    /// Nothing there (yet); what exists above it is inside the folder.
    Missing,
    /// Resolves, or a link on the way leads, outside the folder.
    Outside,
}

fn has_workers(entry: &ProjectEntry) -> bool {
    entry.extra.get("compute_hosts").and_then(Value::as_array).is_some_and(|hosts| !hosts.is_empty())
}

/// The root for `scope`'s results, or `None` when the scope may not carry
/// any (decision 10): the root scope and other reserved ones, boxes, unknown
/// ids, remote or remote-only projects, projects with worker hosts, VM
/// projects, and a folder that is not an absolute, existing directory.
pub fn project_root_in(list: &ProjectsList, scope: &str) -> Option<Root> {
    if crate::storage::is_reserved_scope(scope) || crate::services::box_store::box_id_of_scope(scope).is_some() {
        return None;
    }
    let entry = list.iter().find(|e| e.id == scope)?;
    if remote::spec_from_entry(entry).is_some() || has_workers(entry) || entry.extra.get("vm").is_some_and(|v| !v.is_null()) {
        return None;
    }
    let dir = PathBuf::from(entry.directory()?);
    if !dir.is_absolute() || dir.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let real = std::fs::canonicalize(&dir).ok().filter(|real| real.is_dir())?;
    Some(Root { dir, real })
}

/// `project_root_in` over the registry file in `state`; an unreadable
/// registry has no root.
pub fn project_root(state: &Path, scope: &str) -> Option<Root> {
    let list: ProjectsList = crate::storage::read_json(&state.join("projects.json")).ok()?;
    project_root_in(&list, scope)
}

/// A path reference, lexically (decision 11): a forward-slash path of plain
/// names relative to the project folder, at most [`meta::RESULT_PATH_MAX_CHARS`]
/// characters, kept exactly as given. Refused: empty; absolute, drive and UNC
/// forms (`/x`, `C:x`, `//host/share`); a `.` or `..` segment, an empty one
/// (`a//b`, a trailing `/`: folders are not linked) or one ending in a dot or
/// space; backslashes; a `:` anywhere (URI schemes, drives, NTFS streams);
/// Windows wildcard characters and device names; the app's own project
/// folder; control and invisible/bidi characters.
pub fn clean_path(raw: &str) -> Option<String> {
    let path = meta::clean_text(raw, meta::RESULT_PATH_MAX_CHARS, false, false)?;
    if path != raw || path.contains(['\\', ':', '<', '>', '"', '|', '?', '*']) {
        return None;
    }
    path.split('/')
        .all(|segment| {
            !segment.is_empty()
                && !segment.ends_with(['.', ' '])
                && !crate::paths::is_windows_device_name(segment)
                && !crate::brand::is_project_dir(segment)
        })
        .then_some(path)
}

/// The absolute spelling of a cleaned reference below `root`.
pub fn target_of(root: &Root, rel: &str) -> PathBuf {
    rel.split('/').fold(root.dir.clone(), |path, segment| path.join(segment))
}

/// Where the cleaned reference stands now: resolution only (stat and
/// canonicalize, with `fs_confine`'s rule that a link is judged by where it
/// leads and a dangling one by where it points), never a content read.
pub fn reach(root: &Root, rel: &str) -> Reach {
    let target = target_of(root, rel);
    match crate::paths::canonical_or_new(&target) {
        Ok(resolved) if resolved.starts_with(&root.real) => {
            if std::fs::metadata(&target).is_ok() { Reach::Inside } else { Reach::Missing }
        }
        _ => Reach::Outside,
    }
}

/// An agent's `results` argument, cleaned: at most
/// [`meta::RESULTS_MAX_ITEMS`] objects with exactly `label` and
/// `relativePath` strings. `None` for anything else, containment aside.
pub fn clean_items(raw: &[Value]) -> Option<Vec<ResultItem>> {
    if raw.len() > meta::RESULTS_MAX_ITEMS {
        return None;
    }
    raw.iter()
        .map(|item| {
            let item = item.as_object().filter(|o| o.len() == 2)?;
            Some(ResultItem {
                label: meta::clean_result_label(item.get("label")?.as_str()?)?,
                relative_path: clean_path(item.get("relativePath")?.as_str()?)?,
            })
        })
        .collect()
}

/// What a click on result `index` is told.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ResultTarget {
    /// Open this file in a viewer tab of the tab's own scope. `projectDir` is
    /// the registry's folder, for the viewer's cwd.
    Open {
        entry: FileEntry,
        #[serde(rename = "projectDir")]
        project_dir: String,
    },
    /// Not there (anymore): the saved list, project or file is gone, or it is
    /// a folder. Nothing is opened.
    Unavailable,
    /// It now resolves outside the project folder, or its stored text no
    /// longer passes the checks. Nothing is opened.
    Refused,
    /// The agent's list changed since the window drew it. Nothing is opened.
    Stale,
}

/// The explicit open (decision 12): judge the stored reference again on the
/// host - the renderer names only the scope, the saved tab, the item's index
/// and the revision it drew, never a path. `state` is the state directory.
pub fn open_in(state: &Path, scope: &str, tab_id: &str, index: usize, revision: u64) -> ResultTarget {
    let path = crate::services::mobile_control::headless::session_file(state, scope);
    let Ok(tab) = workspace::read_tab_in(&path, tab_id, || Ok(())) else { return ResultTarget::Unavailable };
    let Ok(stored) = meta::read(&tab) else { return ResultTarget::Unavailable };
    if stored.revision != revision {
        return ResultTarget::Stale;
    }
    let Some(item) = stored.results.as_ref().and_then(|r| r.items.get(index)) else { return ResultTarget::Unavailable };
    let Some(root) = project_root(state, scope) else { return ResultTarget::Unavailable };
    if fs_confine::is_planted_root(&root.dir) {
        return ResultTarget::Refused;
    }
    let Some(rel) = clean_path(&item.relative_path) else { return ResultTarget::Refused };
    match reach(&root, &rel) {
        Reach::Outside => ResultTarget::Refused,
        Reach::Missing => ResultTarget::Unavailable,
        Reach::Inside => {
            let dir = crate::paths::display_path(&root.dir);
            // The viewers' own lookup: canonical containment again, no project
            // folder of the app's, metadata only. A file that vanished or was
            // swapped since the check above reads as unavailable.
            match crate::commands::fs::resolve_text_paths_blocking(vec![dir.clone()], vec![rel]).pop().flatten() {
                Some(entry) if !entry.is_dir => ResultTarget::Open { entry, project_dir: dir },
                _ => ResultTarget::Unavailable,
            }
        }
    }
}

#[cfg(test)]
mod tests;
