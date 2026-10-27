//! The `boxes.json` store and the box tab scope (`box:<id>`): the locked,
//! revision-stamped read/write and compare-and-swap whole-list save, the
//! member reconcile against the project registry, and the roots a box-scoped
//! tab or viewer may live in. Moved down from `commands::boxes` (S5), which
//! keeps the Tauri commands, the folder links and agent docs, and re-exports
//! these names.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::schema::boxes::{BoxesList, ProjectBox};
use crate::storage;

pub(crate) fn boxes_path() -> std::path::PathBuf {
    storage::state_dir().join("boxes.json")
}

pub(crate) fn read_boxes() -> Result<BoxesList, String> {
    read_boxes_at(&boxes_path())
}

pub(crate) fn read_boxes_at(path: &Path) -> Result<BoxesList, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut boxes: BoxesList = storage::read_json(path).map_err(|e| e.to_string())?;
    // A box whose id is a reserved scope's (`storage::is_reserved_scope`) is
    // a hand-edited record that would borrow that scope's state: not read.
    boxes.retain(|b| !storage::is_reserved_scope(&b.id));
    Ok(boxes)
}

/// Write the list, stamping each box's revision against what the file holds
/// (headless owner plan, H1): a changed box gets the next revision, an
/// unchanged one keeps its own, a new one starts at 1 — whatever number the
/// caller's copy carried. Every writer in this module goes through here, so
/// the revisions move consistently.
pub(crate) fn write_boxes(boxes: &BoxesList) -> Result<BoxesList, String> {
    let path = boxes_path();
    let _lock = storage::FileLock::exclusive(&path).map_err(|e| e.to_string())?;
    let current = read_boxes_at(&path)?;
    write_boxes_stamped(&path, &current, boxes)
}

/// [`write_boxes`], answering box `box_id` as the file now holds it — its
/// revision stamped. A command's answer is the copy the window's store keeps
/// and later sends back whole through `save_boxes`; the pre-write copy's
/// revision would get that save refused as stale.
pub(crate) fn write_boxes_answering(boxes: &BoxesList, box_id: &str) -> Result<ProjectBox, String> {
    write_boxes(boxes)?
        .into_iter()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))
}

/// Write `boxes` stamped against `current`, and answer what was written.
pub(crate) fn write_boxes_stamped(path: &Path, current: &BoxesList, boxes: &BoxesList) -> Result<BoxesList, String> {
    if let Some(reserved) = boxes.iter().find(|b| storage::is_reserved_scope(&b.id)) {
        return Err(format!("invalid box id '{}': it names a scope {} keeps for itself", reserved.id, crate::brand::DISPLAY));
    }
    let stamped = stamp_box_revs(current, boxes);
    storage::write_json_atomic(path, &stamped).map_err(|e| e.to_string())?;
    Ok(stamped)
}

pub(crate) fn stamp_box_revs(current: &BoxesList, next: &BoxesList) -> BoxesList {
    next.iter()
        .map(|incoming| {
            let mut stamped = incoming.clone();
            match current.iter().find(|held| held.id == incoming.id) {
                None => stamped.rev = incoming.rev.saturating_add(1),
                Some(held) => {
                    let mut probe = incoming.clone();
                    probe.rev = held.rev;
                    stamped.rev = if probe == *held { held.rev } else { held.rev.saturating_add(1) };
                }
            }
            stamped
        })
        .collect()
}

/// What a whole-list save is told when a box it carries moved on since the
/// caller loaded it.
pub const BOXES_STALE: &str = "boxes changed on disk since they were loaded; reload and apply the edit again";

/// The whole-list save, compare-and-swap per box: refused outright when any
/// box the caller carries has a revision other than the file's, so the edit
/// it did not see is never written over. A box the file no longer holds is
/// re-created; one the caller dropped is deleted. Answers the list as
/// written, so the caller can adopt the revisions it stamped.
pub(crate) fn save_boxes_at(path: &Path, boxes: &BoxesList) -> Result<BoxesList, String> {
    // The per-box revision check below is what a file system without
    // advisory locks falls back on (`FileLock::exclusive_or_unlocked`).
    let _lock = storage::FileLock::exclusive_or_unlocked(path).map_err(|e| e.to_string())?;
    let current = read_boxes_at(path)?;
    for incoming in boxes {
        if let Some(held) = current.iter().find(|held| held.id == incoming.id) {
            if held.rev != incoming.rev {
                return Err(BOXES_STALE.to_string());
            }
        }
    }
    write_boxes_stamped(path, &current, boxes)
}

/// Gap-spaced next position among boxes (mirrors `projects::next_position`).
pub(crate) fn next_box_position(boxes: &BoxesList) -> i64 {
    boxes.iter().map(|b| b.position).max().unwrap_or(0) + 10
}

/// Pure reconcile: drop any `member_ids` that no longer reference a known
/// project id. The set of valid project ids is supplied by the caller (read from
/// `projects.json`); this function never reads or writes either state file, so it
/// is freely unit-testable. It is the *only* reconcile the cargo tests target —
/// the `box_id` inverse recompute is frontend-side (no write-on-load).
pub(crate) fn reconcile_member_ids(boxes: BoxesList, project_ids: &HashSet<String>) -> BoxesList {
    boxes
        .into_iter()
        .map(|mut b| {
            b.member_ids.retain(|id| project_ids.contains(id));
            b
        })
        .collect()
}

/// Read the set of known project ids from `projects.json` (empty if absent,
/// an error if unreadable). Used only to reconcile boxes in-memory; never
/// mutates `projects.json`.
pub(crate) fn known_project_ids() -> Result<HashSet<String>, String> {
    crate::services::remote::projects().map(|list| list.iter().map(|p| p.id.clone()).collect())
}

/// The boxes as [`get_boxes`] shows them: reconciled against the registry's
/// ids, or as stored when the registry cannot be read. An unreadable registry
/// is not "no projects": that reconcile would empty every box, and the next
/// mutating box action would persist it.
pub(crate) fn boxes_as_seen(boxes: BoxesList, project_ids: Result<HashSet<String>, String>) -> BoxesList {
    match project_ids {
        Ok(ids) => reconcile_member_ids(boxes, &ids),
        Err(_) => boxes,
    }
}

/// Resolve a box's ordered member ids to `(name, root_directory)` pairs by
/// reading `projects.json`. The root directory mirrors the frontend's
/// `resolveProjectDirectory`: the `directory` field if present, else the parent
/// of a `…/project.json` `local_file`. Members that don't resolve are skipped.
/// An unreadable registry is an error, never "no members" (that would strip
/// every member's link and doc block).
pub(crate) fn member_projects(member_ids: &[String]) -> Result<Vec<(String, PathBuf)>, String> {
    let list = crate::services::remote::projects()?;
    Ok(member_ids
        .iter()
        .filter_map(|id| {
            let p = list.iter().find(|p| &p.id == id)?;
            let dir = project_directory(p)?;
            Some((p.name.clone(), dir))
        })
        .collect())
}

/// Mirror of the frontend `resolveProjectDirectory` for a single project entry.
pub(crate) fn project_directory(p: &crate::schema::projects::ProjectEntry) -> Option<PathBuf> {
    p.directory().map(PathBuf::from)
}

// ── Box tab scope (`box:<id>`) ──────────────────────────────────────────────

/// Scope-id prefix for box-rooted tabs, disjoint from project ids and "root".
/// Mirrors `BOX_SCOPE_PREFIX` in `src/stores/boxes.ts`.
pub(crate) const BOX_SCOPE_PREFIX: &str = "box:";

/// The box id inside a `box:<id>` scope id, or `None` for any other id.
pub(crate) fn box_id_of_scope(scope: &str) -> Option<&str> {
    scope
        .strip_prefix(BOX_SCOPE_PREFIX)
        .filter(|id| !id.is_empty())
}

/// Pure core of [`box_allowed_roots`]: the directories a `box:<id>`-scoped tab
/// or viewer may live in — the box folder (once resolved), every member
/// project's root, and each member's explicit local-mirror override
/// (`extra["mirror"]`, the browsable tree of a remote member). `None` for an
/// unknown box id so callers fail closed, mirroring `compute_allowed_roots`.
pub(crate) fn compute_box_allowed_roots(
    boxes: &BoxesList,
    projects: &crate::schema::projects::ProjectsList,
    box_id: &str,
) -> Option<Vec<PathBuf>> {
    let b = boxes.iter().find(|b| b.id == box_id)?;
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(folder) = &b.folder {
        roots.push(PathBuf::from(folder));
    }
    for id in &b.member_ids {
        let Some(p) = projects.iter().find(|p| &p.id == id) else {
            continue;
        };
        if let Some(dir) = project_directory(p) {
            roots.push(dir);
        }
        if let Some(Value::String(mirror)) = p.extra.get("mirror") {
            if !mirror.trim().is_empty() {
                roots.push(PathBuf::from(mirror.trim()));
            }
        }
    }
    Some(roots)
}

/// State-dir-backed wrapper around [`compute_box_allowed_roots`], adding each
/// remote member's default local-mirror root (`remote_sync::mirror_dir`) — the
/// tree a local tab of a remote member actually runs in. `None` = unknown box.
pub(crate) fn box_allowed_roots(box_id: &str) -> Option<Vec<PathBuf>> {
    let boxes = read_boxes().ok()?;
    let path = storage::projects_path();
    let projects: crate::schema::projects::ProjectsList = if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut roots = compute_box_allowed_roots(&boxes, &projects, box_id)?;
    if let Some(b) = boxes.iter().find(|b| b.id == box_id) {
        for id in &b.member_ids {
            let is_remote = projects
                .iter()
                .any(|p| &p.id == id && p.extra.contains_key("remote"));
            if is_remote {
                roots.push(crate::services::remote_sync::mirror_dir(id));
            }
        }
    }
    Some(roots)
}
