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

/// One edit of the boxes file: read it, let `edit` change the list, and write
/// the result, all under the file's lock. Every command that changes a box
/// goes through here (or holds the lock the same way, as `create_box_at` and
/// `patch_box_at` do), because a read taken *before* the lock is a lost update
/// waiting to happen: box commands run concurrently (the blocking pool for a
/// browser client, the Mobile sidecar's own process, an async import), and a
/// writer that read first wrote its stale list back over whatever landed in
/// between — a box created meanwhile, a member just added.
///
/// Answers the list as the file now holds it (revisions stamped) and whatever
/// `edit` returned. An `edit` that fails, or changes nothing, writes nothing.
pub(crate) fn update_boxes<R>(
    edit: impl FnOnce(&mut BoxesList) -> Result<R, String>,
) -> Result<(BoxesList, R), String> {
    update_boxes_at(&boxes_path(), edit)
}

pub(crate) fn update_boxes_at<R>(
    path: &Path,
    edit: impl FnOnce(&mut BoxesList) -> Result<R, String>,
) -> Result<(BoxesList, R), String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| e.to_string())?;
    let current = read_boxes_at(path)?;
    let mut next = current.clone();
    let out = edit(&mut next)?;
    let written = if next == current { current } else { write_boxes_stamped(path, &current, &next)? };
    Ok((written, out))
}

/// [`update_boxes`] for an edit of box `box_id`, answering that box as the
/// file now holds it — its revision stamped. A command's answer is the copy
/// the window's store keeps; the pre-write copy's revision would be stale.
pub(crate) fn update_box(
    box_id: &str,
    edit: impl FnOnce(&mut ProjectBox) -> Result<(), String>,
) -> Result<ProjectBox, String> {
    let missing = || format!("box '{box_id}' not found");
    let (written, ()) = update_boxes(|boxes| edit(boxes.iter_mut().find(|b| b.id == box_id).ok_or_else(missing)?))?;
    written.into_iter().find(|b| b.id == box_id).ok_or_else(missing)
}

/// Whether a project id would be read as a box's: `box:<x>` is a box scope to
/// every [`box_id_of_scope`] caller, and an id whose state key
/// (`storage::project_key`) starts `box_` shares `sessions/box_<x>` and
/// `agent-homes/box_<x>` with box `<x>`. No id the app mints looks like either
/// (they are UUIDs); an imported bundle names its own.
pub(crate) fn id_imitates_box_scope(id: &str) -> bool {
    id.starts_with(BOX_SCOPE_PREFIX) || storage::project_key(id).starts_with("box_")
}

/// A box's folder as a root that tabs and viewers may live in: `None` for a
/// record that names no usable place — empty (every path "starts with" the
/// empty path), relative, or climbing through `..`. The folder is only ever
/// written by `ensure_box_folder`; this is what the root builders make of a
/// record that came from anywhere else (a hand edit, an older file).
pub(crate) fn box_folder_root(b: &ProjectBox) -> Option<PathBuf> {
    let folder = b.folder.as_deref()?.trim();
    let path = Path::new(folder);
    let climbs = path.components().any(|c| matches!(c, std::path::Component::ParentDir));
    (!folder.is_empty() && path.has_root() && !climbs).then(|| path.to_path_buf())
}

/// Write `boxes` stamped against `current`, and answer what was written.
/// Stamping (headless owner plan, H1): a changed box gets the next revision,
/// an unchanged one keeps its own, a new one starts at 1 — whatever number the
/// caller's copy carried.
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
///
/// A box's `folder` is never the caller's to set: it is a root the box's tabs
/// and viewers may live in (`compute_box_allowed_roots`), resolved only by
/// `ensure_box_folder`. Each saved box keeps the folder the file holds for it
/// (none for a new box), whatever the caller's copy says.
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
    let mut boxes = boxes.clone();
    for incoming in &mut boxes {
        incoming.folder = current.iter().find(|held| held.id == incoming.id).and_then(|held| held.folder.clone());
    }
    write_boxes_stamped(path, &current, &boxes)
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

/// A box's members as its folder presents them to the agents started there.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct BoxMembers {
    /// `(name, root)` of each member a box tab can work in, in member order:
    /// these get a link and a doc line.
    pub reachable: Vec<(String, PathBuf)>,
    /// Names of the members a box tab cannot enter. Named in the docs, never
    /// linked.
    pub unreachable: Vec<String>,
}

/// Resolve a box's ordered member ids by reading `projects.json`. An
/// unreadable registry is an error, never "no members" (that would strip
/// every member's link and doc block).
pub(crate) fn member_projects(member_ids: &[String]) -> Result<BoxMembers, String> {
    let list = crate::services::remote::projects()?;
    Ok(member_projects_in(&list, member_ids, &storage::state_dir()))
}

/// Pure core of [`member_projects`], over the same rules as the box's roots
/// ([`compute_box_allowed_roots`], [`member_local_copies`]) so the folder
/// never links or lists a place a box tab is refused in:
///
/// - a local member: its folder (the frontend's `resolveProjectDirectory`);
/// - a remote member with a local copy: **that copy** (`remote::local_copy_in`:
///   its mirror). Its `directory` is only its state dir, which a fenced agent
///   cannot read, so a link there led nowhere;
/// - a member with no local tree (remote-only, a VM) or set to Local models
///   only: unreachable — a box tab would be a cloud agent in it, or has no
///   tree to stand in.
///
/// A member id no project has is skipped.
pub(crate) fn member_projects_in(
    projects: &[crate::schema::projects::ProjectEntry],
    member_ids: &[String],
    state_dir: &Path,
) -> BoxMembers {
    let mut out = BoxMembers::default();
    for id in member_ids {
        let Some(p) = projects.iter().find(|p| &p.id == id) else {
            continue;
        };
        if crate::services::remote::entry_is_remote_only(p) || crate::services::agent_privacy::is_locked(p) {
            out.unreachable.push(p.name.clone());
        } else if let Some(dir) = crate::services::remote::local_copy_in(p, state_dir).or_else(|| project_directory(p)) {
            out.reachable.push((p.name.clone(), dir));
        }
    }
    out
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
/// or viewer may live in — the box folder (once resolved), every local
/// member's root, and each member's explicit local-mirror override
/// (`extra["mirror"]`, the local copy of a remote member;
/// [`box_allowed_roots`] adds the default copy of one without). A remote member's `directory` is never a root: it is its state
/// folder (sync bookkeeping, no project file an agent should touch) or, in a
/// legacy entry, typically the user's home, and every box tab is handed each
/// root (the fence binds it, Claude gets `--add-dir` for it). A remote-only
/// member adds no root at all: it has no local tree, and a stale
/// `extra["mirror"]` is not a copy it keeps. `None` for an unknown box id so
/// callers fail closed, mirroring `compute_allowed_roots`.
pub(crate) fn compute_box_allowed_roots(
    boxes: &BoxesList,
    projects: &crate::schema::projects::ProjectsList,
    box_id: &str,
) -> Option<Vec<PathBuf>> {
    let b = boxes.iter().find(|b| b.id == box_id)?;
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(box_folder_root(b));
    for id in &b.member_ids {
        let Some(p) = projects.iter().find(|p| &p.id == id) else {
            continue;
        };
        if crate::services::remote::entry_is_remote_only(p) {
            continue;
        }
        // A local-models-only project's folder is never a box root: a box tab
        // would be a cloud agent in it, and its own tabs take no box root
        // (`services::agent_privacy`).
        if crate::services::agent_privacy::is_locked(p) {
            continue;
        }
        let remote = p.extra.get("remote").is_some_and(|v| !v.is_null());
        if !remote {
            roots.extend(project_directory(p));
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
/// remote member's local copy (`remote::local_copy_in`: its explicit mirror,
/// else the default one) — the tree a local tab of a remote member actually
/// runs in; a remote-only member has none. `None` = unknown box.
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
        roots.extend(member_local_copies(b, &projects, &storage::state_dir()));
    }
    Some(roots)
}

/// The local copies [`box_allowed_roots`] adds for box `b`'s remote members,
/// in member order: `remote::local_copy_in` per member, so a remote-only
/// member contributes none. Pure over the lists and an explicit state dir.
fn member_local_copies(
    b: &ProjectBox,
    projects: &crate::schema::projects::ProjectsList,
    state_dir: &Path,
) -> Vec<PathBuf> {
    b.member_ids
        .iter()
        .filter_map(|id| projects.iter().find(|p| &p.id == id))
        .filter(|p| !crate::services::agent_privacy::is_locked(p))
        .filter_map(|p| crate::services::remote::local_copy_in(p, state_dir))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A box tab may work in each remote member's local copy, but a
    /// remote-only member (a VM included) has none: neither its stale
    /// `mirror` nor its default path is added. A local member adds nothing
    /// here (its folder comes from `compute_box_allowed_roots`).
    #[test]
    fn a_remote_only_member_adds_no_local_copy() {
        let projects: crate::schema::projects::ProjectsList = serde_json::from_value(serde_json::json!([
            { "id": "loc", "name": "L", "status": "active", "position": 0, "local_file": "", "directory": "/w/loc" },
            { "id": "pl", "name": "P", "status": "active", "position": 1, "local_file": "",
              "remote": { "host": "h", "remote_path": "/srv/pl" }, "mirror": "/w/pl-mirror" },
            { "id": "df", "name": "D", "status": "active", "position": 2, "local_file": "",
              "remote": { "host": "h", "remote_path": "/srv/df" } },
            { "id": "ro", "name": "R", "status": "active", "position": 3, "local_file": "",
              "remote": { "host": "h", "remote_path": "/srv/ro", "remote_only": true }, "mirror": "/w/stale" },
            { "id": "vm", "name": "V", "status": "active", "position": 4, "local_file": "",
              "remote": { "host": "127.0.0.1", "remote_path": "/home/u/vm", "vm": true } },
        ]))
        .unwrap();
        let b = ProjectBox {
            id: "b".into(),
            name: "B".into(),
            member_ids: ["loc", "pl", "df", "ro", "vm"].map(String::from).to_vec(),
            ..ProjectBox::default()
        };
        let state = Path::new("state");
        assert_eq!(
            member_local_copies(&b, &projects, state),
            vec![PathBuf::from("/w/pl-mirror"), crate::services::remote_sync::default_mirror_dir_in(state, "df")]
        );
    }

    /// A remote member's `directory` is never a box root: in a legacy entry it
    /// names the user's home, which every box tab would then be handed (fence
    /// bind, Claude `--add-dir`); in a current one its state folder. Its local
    /// copy is its only root; a local member keeps its folder.
    #[test]
    fn a_remote_members_directory_is_no_box_root() {
        let projects: crate::schema::projects::ProjectsList = serde_json::from_value(serde_json::json!([
            { "id": "loc", "name": "L", "status": "active", "position": 0, "local_file": "", "directory": "/w/loc" },
            { "id": "legacy", "name": "G", "status": "active", "position": 1, "local_file": "", "directory": "/home/u",
              "remote": { "host": "h", "remote_path": "/srv/g" }, "mirror": "/w/g-copy" },
            { "id": "cur", "name": "C", "status": "active", "position": 2, "local_file": "/state/remote-projects/cur/project.json",
              "remote": { "host": "h", "remote_path": "/srv/c" } },
        ]))
        .unwrap();
        let b = ProjectBox {
            id: "b".into(),
            name: "B".into(),
            member_ids: ["loc", "legacy", "cur"].map(String::from).to_vec(),
            folder: Some("/boxes/b".into()),
            ..ProjectBox::default()
        };
        let roots = compute_box_allowed_roots(&vec![b], &projects, "b").unwrap();
        assert_eq!(roots, ["/boxes/b", "/w/loc", "/w/g-copy"].map(PathBuf::from).to_vec());
    }
}
