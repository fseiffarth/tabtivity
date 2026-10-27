//! The project registry (`projects.json`) write side: the serialized
//! read-modify-write every create/import/clone/VM/transfer/share path goes
//! through, and the per-entry patch helpers. Moved down from
//! `commands::projects` (S5); it re-exports these names. The cached read
//! itself is [`crate::services::remote::projects`].

use std::path::PathBuf;

use crate::paths;
use crate::schema::project::Project;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::storage;

/// The registry as an owned list (reserved ids dropped): a copy of the cached
/// read, [`crate::services::remote::projects`], for a caller that edits it.
pub(crate) fn read_projects_list() -> Result<ProjectsList, String> {
    crate::services::remote::projects().map(|list| ProjectsList::clone(&list))
}

/// Apply one serialized read-modify-write to the project registry. Existing
/// corrupt JSON is an error, never an empty registry, and every successful
/// mutation lands through an atomic replacement.
pub(crate) fn patch_projects_list<R>(
    patch: impl FnOnce(&mut ProjectsList) -> Result<R, String>,
) -> Result<R, String> {
    patch_projects_list_at(&storage::projects_path(), patch)
}

/// [`patch_projects_list`] on `path`. A record whose id is a reserved scope's
/// ([`storage::is_reserved_scope`]) is dropped on the way in, and a patch that
/// leaves one in is refused whole, so no write path — create, import, clone,
/// VM, transfer, share — can register a project that borrows `root`'s or the
/// chat assistant's state.
pub(crate) fn patch_projects_list_at<R>(
    path: &std::path::Path,
    patch: impl FnOnce(&mut ProjectsList) -> Result<R, String>,
) -> Result<R, String> {
    storage::patch_json(path, ProjectsList::new(), |list| {
        // The built-in Trash workspace was removed; every registry read or
        // write drops its leftover entry (its folder stays on disk).
        drop_legacy_trash_project(list);
        drop_reserved_projects(list);
        let result = patch(list)?;
        match list.iter().find(|p| storage::is_reserved_scope(&p.id)) {
            Some(p) => Err(reserved_id_message(&p.id)),
            None => Ok(result),
        }
    })
}

/// Why a project id that names a reserved scope is refused.
pub(crate) fn reserved_id_message(id: &str) -> String {
    format!("invalid project id '{id}': it names a scope {} keeps for itself", crate::brand::DISPLAY)
}

/// Drop the registry records that borrow a reserved scope's id (a hand-edited
/// or imported `projects.json`): they would otherwise hand their folder out as
/// the scope's, or its state as theirs. Whether anything was dropped.
pub(crate) fn drop_reserved_projects(list: &mut ProjectsList) -> bool {
    let before = list.len();
    list.retain(|p| !storage::is_reserved_scope(&p.id));
    list.len() != before
}

/// Patch one registry entry without open-coding another whole-list
/// read-modify-write. The closure's return value can carry the entry's
/// `local_file` into the best-effort `project.json` mirror update.
pub(crate) fn patch_project_entry<R>(
    project_id: &str,
    patch: impl FnOnce(&mut ProjectEntry) -> Result<R, String>,
) -> Result<R, String> {
    patch_projects_list(|list| {
        let entry = list
            .iter_mut()
            .find(|entry| entry.id == project_id)
            .ok_or_else(|| format!("project '{project_id}' not found"))?;
        patch(entry)
    })
}

/// [`patch_project_entry`] plus the mirror write every per-field setter used to
/// open-code: after the registry patch lands, apply `patch_project` to the
/// entry's own `project.json` and write it back atomically. The mirror closure
/// receives the registry patch's result, so a value computed under the registry
/// lock (e.g. the merged host list) can be mirrored without a second read. A
/// missing `project.json` is fine — the registry is the source of truth and the
/// file is display/export data (a remote project's copy may simply not exist
/// locally). An *existing* file that fails to parse is an error, not a silent
/// skip: the registry write has already landed by then, so skipping quietly is
/// exactly how the two copies diverge with no signal.
pub(crate) fn patch_project_entry_mirrored<R>(
    project_id: &str,
    patch_entry: impl FnOnce(&mut ProjectEntry) -> Result<R, String>,
    patch_project: impl FnOnce(&mut Project, &R),
) -> Result<R, String> {
    let (result, local_file) = patch_project_entry(project_id, |entry| {
        let result = patch_entry(entry)?;
        Ok((result, entry.local_file.clone()))
    })?;
    let proj_path = PathBuf::from(&local_file);
    // Never followed at the name or waited on (a FIFO): the file is the tree's.
    let read = storage::read_tree_json::<Project>(&proj_path).map_err(|e| {
        format!(
            "the registry was updated, but the project's own project.json \
             could not be read to mirror the change (it is now stale): {e}"
        )
    })?;
    if let Some(mut project) = read {
        patch_project(&mut project, &result);
        storage::write_json_atomic(&proj_path, &project).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

/// Remove the entry of the retired built-in Trash workspace (`tabtivity-trash`),
/// which older Tabtivity versions created and kept pinned. Its `~/tabtivity/trash`
/// folder is left untouched.
pub(crate) fn drop_legacy_trash_project(list: &mut ProjectsList) {
    list.retain(|p| p.id != paths::LEGACY_TRASH_PROJECT_ID);
}
