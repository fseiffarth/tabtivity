//! Project boxes — meta-project grouping (TODO Group A: #13 + #41).
//!
//! Boxes live in their own sibling file `~/.local/share/tabtivity/boxes.json` so the
//! existing `projects.json` stays byte-compatible for Python rollback. A box owns
//! the authoritative ordered `member_ids` — membership is N:M (a project may sit
//! in several boxes at once) and lives NOWHERE else; the old per-project `box_id`
//! back-reference is retired (the frontend strips stale persisted keys on load).
//! This module never writes `projects.json`.
//!
//! A box folder also carries one **link per member** (a symlink on Unix, a
//! directory junction on Windows) beside the generated agent docs, so agent CLIs
//! launched in the box folder can traverse straight into each member's tree. Tabtivity's own file confinement
//! deliberately does NOT follow these links — the multi-root Files view (and the
//! explicit allowed-roots set in `compute_box_allowed_roots`) is Tabtivity's file
//! surface; the links exist purely for the agents' benefit. Ownership of the
//! links is recorded in `<folder>/.tabtivity-box-links.json` so regeneration only
//! ever removes links Tabtivity itself created (see `write_box_member_links`).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::commands::projects::{sanitize_name, uuid_v4};
use crate::paths;
use crate::schema::boxes::{BoxRelation, BoxesList, ProjectBox};
use crate::storage;

/// Agent md files written into a box folder, paired with the member md file a
/// box file should link to (CLAUDE.md → members' CLAUDE.md, etc.).
const BOX_AGENT_DOCS: &[&str] = &["CLAUDE.md", "GEMINI.md", "AGENTS.md"];

/// Markers delimiting the Tabtivity-managed link block inside a box agent doc. Only
/// the text between (and including) these lines is rewritten on regeneration, so
/// anything a user adds outside the block survives.
const BOX_LINKS_START: &str = crate::brand::BOX_LINKS_START;
const BOX_LINKS_END: &str = crate::brand::BOX_LINKS_END;

fn boxes_path() -> std::path::PathBuf {
    storage::state_dir().join("boxes.json")
}

fn read_boxes() -> Result<BoxesList, String> {
    read_boxes_at(&boxes_path())
}

fn read_boxes_at(path: &Path) -> Result<BoxesList, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    storage::read_json(path).map_err(|e| e.to_string())
}

/// Write the list, stamping each box's revision against what the file holds
/// (headless owner plan, H1): a changed box gets the next revision, an
/// unchanged one keeps its own, a new one starts at 1 — whatever number the
/// caller's copy carried. Every writer in this module goes through here, so
/// the revisions move consistently.
fn write_boxes(boxes: &BoxesList) -> Result<(), String> {
    let path = boxes_path();
    let _lock = storage::FileLock::exclusive(&path).map_err(|e| e.to_string())?;
    let current = read_boxes_at(&path)?;
    write_boxes_stamped(&path, &current, boxes)
}

fn write_boxes_stamped(path: &Path, current: &BoxesList, boxes: &BoxesList) -> Result<(), String> {
    let stamped = stamp_box_revs(current, boxes);
    storage::write_json_atomic(path, &stamped).map_err(|e| e.to_string())
}

fn stamp_box_revs(current: &BoxesList, next: &BoxesList) -> BoxesList {
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
/// re-created; one the caller dropped is deleted.
fn save_boxes_at(path: &Path, boxes: &BoxesList) -> Result<(), String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| e.to_string())?;
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
fn next_box_position(boxes: &BoxesList) -> i64 {
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

/// Read the set of known project ids from `projects.json` (empty if absent).
/// Used only to reconcile boxes in-memory; never mutates `projects.json`.
fn known_project_ids() -> HashSet<String> {
    let path = storage::state_dir().join("projects.json");
    if !path.exists() {
        return HashSet::new();
    }
    let list: crate::schema::projects::ProjectsList = match storage::read_json(&path) {
        Ok(list) => list,
        Err(_) => return HashSet::new(),
    };
    list.into_iter().map(|p| p.id).collect()
}

/// Resolve a box's ordered member ids to `(name, root_directory)` pairs by
/// reading `projects.json`. The root directory mirrors the frontend's
/// `resolveProjectDirectory`: the `directory` field if present, else the parent
/// of a `…/project.json` `local_file`. Members that don't resolve are skipped.
fn member_projects(member_ids: &[String]) -> Vec<(String, PathBuf)> {
    let path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        Vec::new()
    };
    member_ids
        .iter()
        .filter_map(|id| {
            let p = list.iter().find(|p| &p.id == id)?;
            let dir = project_directory(p)?;
            Some((p.name.clone(), dir))
        })
        .collect()
}

/// Mirror of the frontend `resolveProjectDirectory` for a single project entry.
fn project_directory(p: &crate::schema::projects::ProjectEntry) -> Option<PathBuf> {
    if let Some(Value::String(dir)) = p.extra.get("directory") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    p.local_file
        .strip_suffix("/project.json")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
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
    let path = storage::state_dir().join("projects.json");
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

/// Build the Tabtivity-managed link block for one box agent doc. Pure (no IO) so it
/// is unit-testable. `agent_file` is the filename of THIS doc (e.g. "CLAUDE.md");
/// each member is linked to its same-named md file plus its root path.
fn box_links_block(agent_file: &str, box_name: &str, members: &[(String, PathBuf)]) -> String {
    let mut out = String::new();
    out.push_str(BOX_LINKS_START);
    out.push('\n');
    out.push_str(concat!("<!-- Managed by ", crate::app_name!(), " — do not edit between these markers. -->\n\n"));
    out.push_str(&format!(
        "## Box \"{box_name}\" — member projects\n\nThis folder is a {app} project box grouping the projects below. Each entry \
links to the project root and its `{agent_file}`:\n\n", app = crate::brand::DISPLAY
    ));
    if members.is_empty() {
        out.push_str("_No member projects yet._\n");
    } else {
        for (name, dir) in members {
            let root = dir.to_string_lossy();
            // Build the doc link with a literal `/` rather than `Path::join`, so the
            // generated markdown is identical on every host OS (on Windows `join`
            // would splice in a `\`, producing a malformed link URL).
            let doc = format!("{}/{agent_file}", root.trim_end_matches(['/', '\\']));
            out.push_str(&format!(
                "- **{name}** — root: `{root}` · [`{agent_file}`]({doc})\n"
            ));
        }
        out.push_str(
            "\nEach member's root is also symlinked beside this file (`./<member>/`, Unix), \
so it is reachable by relative path from this folder.\n",
        );
    }
    out.push('\n');
    out.push_str(BOX_LINKS_END);
    out.push('\n');
    out
}

// ── Member symlink farm (Phase 4) ───────────────────────────────────────────

/// Ownership manifest for the member symlinks in a box folder: link name →
/// the target the link was created for. Only names recorded here (and still
/// symlinks on disk) are ever removed on regeneration — a user file or folder
/// that happens to share a member's name is never touched (the member's link
/// gets a `-1`/`-2` suffixed name instead).
#[cfg(test)]
const BOX_LINKS_MANIFEST: &str = crate::brand::BOX_LINKS_MANIFEST;

type BoxLinksManifest = std::collections::BTreeMap<String, String>;

/// Pure planner: pick a link name per member — `sanitize_name` of the member
/// name, suffixed `-1`/`-2`… past a collision with `taken` (names in the folder
/// that are not ours to use) or with an earlier member in the same plan.
/// Cross-platform (no IO), so it is unit-tested everywhere even though the
/// writer below is Unix-only.
fn plan_member_links(
    members: &[(String, PathBuf)],
    taken: &HashSet<String>,
) -> Vec<(String, PathBuf)> {
    let mut used: HashSet<String> = taken.clone();
    let mut out = Vec::new();
    for (name, dir) in members {
        let base = {
            let s = sanitize_name(name);
            if s.is_empty() {
                "project".to_string()
            } else {
                s
            }
        };
        let mut candidate = base.clone();
        let mut counter = 0u32;
        while used.contains(&candidate) {
            counter += 1;
            candidate = format!("{base}-{counter}");
        }
        used.insert(candidate.clone());
        out.push((candidate, dir.clone()));
    }
    out
}

/// Create/refresh the per-member links in `folder`. The rules:
///
/// - Only manifest-owned entries that are STILL links are ever removed, and
///   only when their member vanished or its target changed — a non-link at
///   an owned name (the user replaced it) is left alone forever.
/// - A user path shadowing a member's natural name costs the member a suffixed
///   link name, never the user their file.
/// - A dangling target is still linked: a member whose folder does not exist
///   yet (or is temporarily unmounted) keeps its place.
///
/// The link is a symlink on Unix and a **directory junction** on Windows (see
/// [`make_member_link`]): a symlink there needs a privilege ordinary accounts
/// do not hold, a junction does not, and both read back through the same
/// `symlink_metadata` / `read_link` calls this planner relies on.
fn write_box_member_links(folder: &Path, members: &[(String, PathBuf)]) -> std::io::Result<()> {
    // The manifest an older build wrote under the app's old name is taken
    // over (renamed); `folder.join(BOX_LINKS_MANIFEST)` while it is unchanged.
    let manifest_path = crate::services::brand_migration::adopt_named_file(
        &crate::brand::PAIR,
        crate::brand::Name::BOX_LINKS_MANIFEST,
        folder,
        "box-links-manifest",
    );
    let manifest: BoxLinksManifest = if manifest_path.exists() {
        crate::storage::read_json(&manifest_path).unwrap_or_default()
    } else {
        BoxLinksManifest::new()
    };

    // Names in the folder that are NOT ours to (re)use: every entry that is not
    // a manifest-owned symlink. The planner routes members around them.
    let mut taken: HashSet<String> = HashSet::new();
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let owned_symlink = manifest.contains_key(&name)
                && entry
                    .path()
                    .symlink_metadata()
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false);
            if !owned_symlink {
                taken.insert(name);
            }
        }
    }

    let plan = plan_member_links(members, &taken);
    let desired: BoxLinksManifest = plan
        .iter()
        .map(|(name, dir)| (name.clone(), dir.to_string_lossy().to_string()))
        .collect();

    // Removal pass: an owned link whose (name, target) pair is no longer in the
    // plan goes — but only while it is still a symlink.
    for name in manifest.keys() {
        if desired.get(name) == manifest.get(name) {
            continue;
        }
        let path = folder.join(name);
        let is_symlink = path
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if is_symlink {
            let _ = remove_member_link(&path);
        }
    }

    // Create pass: make each planned link, replacing an owned link whose
    // target moved (already removed above). An existing link already
    // pointing at the right target is left as-is.
    for (name, dir) in &plan {
        let path = folder.join(name);
        match path.symlink_metadata() {
            Ok(meta) if meta.file_type().is_symlink() => {
                if link_points_at(&path, dir) {
                    continue;
                }
                // An owned link to the old target was removed above; a
                // FOREIGN link can't reach here (its name is in `taken`).
                let _ = remove_member_link(&path);
            }
            Ok(_) => continue, // never replace a non-link user path
            Err(_) => {}
        }
        let _ = make_member_link(dir, &path);
    }

    crate::storage::write_json(&manifest_path, &desired)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(())
}

/// Whether the link at `link` already resolves to `target`. Windows reads a
/// junction's substitute name back with the kernel's `\\?\` prefix, which the
/// planner never wrote, so the comparison strips it on both sides.
fn link_points_at(link: &Path, target: &Path) -> bool {
    fn plain(p: &Path) -> String {
        let s = p.to_string_lossy();
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    }
    fs::read_link(link)
        .map(|got| plain(&got) == plain(target))
        .unwrap_or(false)
}

/// Unix: a plain symlink.
#[cfg(unix)]
fn make_member_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(unix)]
fn remove_member_link(link: &Path) -> std::io::Result<()> {
    fs::remove_file(link)
}

/// Windows: a **directory junction** (`mklink /J`), not a symlink. Creating a
/// symlink needs `SeCreateSymbolicLinkPrivilege` (or Developer Mode), which an
/// ordinary account does not hold; a junction is a reparse point any user may
/// create, and std treats it as a symlink for `is_symlink`, `read_link` and
/// `remove_dir`. Agent CLIs launched in the box folder traverse it like any
/// directory. The target is passed absolute and a missing one is accepted
/// (a dangling junction, mirroring the Unix rule). Spawned through `cmd` because
/// `mklink` is a shell builtin; the two paths are quoted verbatim and a Windows
/// path can never contain `"`.
#[cfg(windows)]
fn make_member_link(target: &Path, link: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let out = crate::paths::command_no_window("cmd")
        .raw_arg(format!(
            "/C mklink /J \"{}\" \"{}\"",
            link.display(),
            target.display()
        ))
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

/// Windows: a junction is removed as an (empty) directory — that unlinks the
/// reparse point and never touches the member folder it pointed at. A file
/// symlink (the user made one by hand) removes as a file.
#[cfg(windows)]
fn remove_member_link(link: &Path) -> std::io::Result<()> {
    fs::remove_dir(link).or_else(|_| fs::remove_file(link))
}

/// Splice a freshly-built link block into existing file content, replacing any
/// previous managed block (between the markers) and leaving the rest untouched.
/// When no file exists, `existing` is empty and a titled doc is created.
fn merge_box_doc(agent_file: &str, existing: &str, block: &str) -> String {
    merge_box_doc_for(&crate::brand::PAIR, agent_file, existing, block)
}

/// [`merge_box_doc`] for a brand pair. A block an older build wrote sits
/// between markers that carry the app's old name: it is found there (counted
/// as a legacy hit) and replaced in place by `block`, which carries the
/// current markers — never left beside a second block.
fn merge_box_doc_for(pair: &crate::brand::Pair, agent_file: &str, existing: &str, block: &str) -> String {
    use crate::brand::Name;
    let current = (pair.cur(Name::BOX_LINKS_START), pair.cur(Name::BOX_LINKS_END));
    let old = pair.legacy(Name::BOX_LINKS_START).zip(pair.legacy(Name::BOX_LINKS_END));
    let found = |(start_marker, end_marker): &(String, String)| {
        let (start, end) = (existing.find(start_marker.as_str())?, existing.find(end_marker.as_str())?);
        (end > start).then(|| (start, end + end_marker.len()))
    };
    let span = found(&current).or_else(|| {
        let span = found(old.as_ref()?)?;
        crate::brand::legacy_hit("box-links-marker");
        Some(span)
    });
    if let Some((start, end)) = span {
        // Drop a trailing newline right after the old end marker so we don't
        // accumulate blank lines on each regeneration.
        let tail = existing[end..]
            .strip_prefix('\n')
            .unwrap_or(&existing[end..]);
        return format!("{}{}\n{}", &existing[..start], block.trim_end(), tail);
    }
    if existing.trim().is_empty() {
        let title = agent_file.strip_suffix(".md").unwrap_or(agent_file);
        return format!("# {title} — {app} box context\n\n{block}", app = crate::brand::DISPLAY);
    }
    // Existing content without a managed block: append the block at the end.
    format!("{}\n\n{block}", existing.trim_end())
}

/// Write/refresh the box agent docs (CLAUDE/GEMINI/AGENTS) in `folder`, each with
/// a managed link block pointing at the member project roots + their md files.
fn write_box_agent_docs(
    folder: &Path,
    box_name: &str,
    members: &[(String, PathBuf)],
) -> std::io::Result<()> {
    for agent_file in BOX_AGENT_DOCS {
        let path = folder.join(agent_file);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let block = box_links_block(agent_file, box_name, members);
        let merged = merge_box_doc(agent_file, &existing, &block);
        fs::write(&path, merged)?;
    }
    Ok(())
}

// ── Box CRUD (Phase 1) ──────────────────────────────────────────────────────

#[tauri::command]
pub fn get_boxes() -> Result<BoxesList, String> {
    // Reconcile against the current project ids in-memory so a deleted project
    // never leaves a dangling member id in what the frontend sees. No surprise
    // write: the corrected list is persisted on the next mutating box action.
    let boxes = read_boxes()?;
    Ok(reconcile_member_ids(boxes, &known_project_ids()))
}

#[tauri::command]
pub fn save_boxes(boxes: BoxesList) -> Result<(), String> {
    save_boxes_at(&boxes_path(), &boxes)
}

#[tauri::command]
pub fn create_box(name: String) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    // Guard against time-based `uuid_v4` collisions for back-to-back creation.
    let existing: HashSet<String> = boxes.iter().map(|b| b.id.clone()).collect();
    let mut id = uuid_v4();
    while existing.contains(&id) {
        id = uuid_v4();
    }
    let position = next_box_position(&boxes);
    let new_box = ProjectBox {
        rev: 0,
        id,
        name,
        member_ids: vec![],
        position,
        folder: None,
        relations: vec![],
        app_mobile_access: false,
        app_mobile_devices: None,
        extra: Default::default(),
    };
    boxes.push(new_box.clone());
    write_boxes(&boxes)?;
    Ok(new_box)
}

#[tauri::command]
pub fn rename_box(box_id: String, name: String) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter_mut()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    // Rename updates only the box record. Once a `folder` is resolved (on first
    // open) it stays authoritative; a later rename does not move it (documented
    // limitation — "rename + move folder" is a Phase 4 nicety).
    target.name = name;
    let updated = target.clone();
    write_boxes(&boxes)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_box(box_id: String) -> Result<(), String> {
    let mut boxes = read_boxes()?;
    let before = boxes.len();
    boxes.retain(|b| b.id != box_id);
    if boxes.len() == before {
        return Err(format!("box '{box_id}' not found"));
    }
    // The box folder (if any) is intentionally NOT deleted — it may hold user
    // data placed there. Clearing each former member's `box_id` is done
    // frontend-side via `save_projects` (a required step of `deleteBox`).
    write_boxes(&boxes)
}

/// Add `project_id` to every box whose **name** matches one of `names`, and
/// report which names had no box. Used by the project-import path: a bundle
/// carries the box names its project belonged to, not box ids, because a box id
/// is meaningless on another installation.
///
/// Deliberately never *creates* a box. A box is a meta-project with its own
/// folder and agent docs; conjuring one because an imported file named it would
/// let a bundle add entries to the strip the user never asked for. Matching an
/// existing name is the whole contract — the unmatched names are returned so the
/// dialog can say so.
pub(crate) fn join_boxes_by_name(
    project_id: &str,
    names: &[String],
) -> Result<(Vec<String>, Vec<String>), String> {
    if names.is_empty() {
        return Ok((vec![], vec![]));
    }
    let mut boxes = read_boxes()?;
    let mut joined = Vec::new();
    let mut missing = Vec::new();
    for name in names {
        match boxes.iter_mut().find(|b| b.name == *name) {
            Some(target) => {
                if !target.member_ids.iter().any(|id| id == project_id) {
                    target.member_ids.push(project_id.to_string());
                }
                joined.push(name.clone());
            }
            None => missing.push(name.clone()),
        }
    }
    if !joined.is_empty() {
        write_boxes(&boxes)?;
    }
    Ok((joined, missing))
}

/// The names of the boxes `project_id` is a member of, in box order — what a
/// project export records so the membership can be re-established elsewhere.
pub(crate) fn box_names_for(project_id: &str) -> Vec<String> {
    let mut boxes = read_boxes().unwrap_or_default();
    boxes.sort_by_key(|b| b.position);
    boxes
        .into_iter()
        .filter(|b| b.member_ids.iter().any(|id| id == project_id))
        .map(|b| b.name)
        .collect()
}

#[tauri::command]
pub fn set_box_members(box_id: String, member_ids: Vec<String>) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter_mut()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    target.member_ids = member_ids;
    let updated = target.clone();
    write_boxes(&boxes)?;
    Ok(updated)
}

/// Switch a box's Tabtivity Mobile reach (#31aa) — the box-scope twin of
/// `set_project_mobile_access`. The machine-wide preconditions are the same
/// (persistent local sessions, tmux), because a box tab reaches the phone the
/// way a project tab does: through the tmux session the tab already runs in.
/// The trust tiers need no check here — a `box:<id>` scope's tabs always run
/// locally, and the sidecar takes only those whose cwd is the box folder or a
/// local member root. Enabling also resolves the box folder: the sidecar lists
/// a box by that folder, and a box never opened on the desktop has none yet.
/// `devices` narrows it to some paired phones, as for a project; omitted,
/// every phone. Turning it off drops the list with the switch.
#[tauri::command]
pub fn set_box_mobile_access(
    box_id: String,
    enabled: bool,
    devices: Option<Vec<String>>,
) -> Result<ProjectBox, String> {
    let devices = if enabled {
        crate::commands::projects::mobile_scope_devices(devices)?
    } else {
        None
    };
    if enabled {
        let settings: crate::schema::Settings =
            storage::read_json(&storage::state_dir().join("settings.json")).unwrap_or_default();
        if !settings.persist_local_sessions() {
            return Err("Enable persistent local terminal sessions before Mobile access".into());
        }
        if !crate::services::tmux_local::tmux_available() {
            return Err("Mobile access requires tmux on this machine".into());
        }
        ensure_box_folder(box_id.clone())?;
    }
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter_mut()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    target.app_mobile_access = enabled;
    target.app_mobile_devices = devices;
    let updated = target.clone();
    write_boxes(&boxes)?;
    Ok(updated)
}

// ── Box folder + relations (Phase 2 groundwork) ─────────────────────────────

/// Resolve a unique on-disk folder name for `box_id` (named after `name`),
/// avoiding both folders already reserved by OTHER boxes in `boxes.json` and
/// directories that already exist on disk for an unrelated box. The chosen
/// absolute path is the return value; callers persist it into the box's `folder`.
fn resolve_box_folder(boxes: &BoxesList, box_id: &str, name: &str) -> std::path::PathBuf {
    let root = paths::boxes_root();
    // Folders already claimed by other boxes (reserved-but-maybe-not-created).
    let reserved: HashSet<String> = boxes
        .iter()
        .filter(|b| b.id != box_id)
        .filter_map(|b| b.folder.clone())
        .collect();

    let base = {
        let s = sanitize_name(name);
        if s.is_empty() {
            "box".to_string()
        } else {
            s
        }
    };

    // Try the bare name first, then suffix with a counter until the candidate is
    // neither reserved by another box nor an existing unrelated directory.
    let mut counter = 0u32;
    loop {
        let candidate_name = if counter == 0 {
            base.clone()
        } else {
            format!("{base}-{counter}")
        };
        let candidate = root.join(&candidate_name);
        let candidate_str = candidate.to_string_lossy().to_string();
        if !reserved.contains(&candidate_str) && !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

#[tauri::command]
pub fn ensure_box_folder(box_id: String) -> Result<String, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    let name = target.name.clone();
    let member_ids = target.member_ids.clone();

    // If the box already has a resolved folder, that path is authoritative —
    // just (idempotently) ensure the directory exists. Otherwise (first open)
    // resolve a unique folder, create it, and persist the chosen path.
    let folder = if let Some(folder) = target.folder.clone() {
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        folder
    } else {
        let path = resolve_box_folder(&boxes, &box_id, &name);
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        let folder = path.to_string_lossy().to_string();
        if let Some(t) = boxes.iter_mut().find(|b| b.id == box_id) {
            t.folder = Some(folder.clone());
        }
        write_boxes(&boxes)?;
        folder
    };

    // Refresh the box agent docs + member symlinks (best effort — a write
    // failure here must not block opening the box).
    let members = member_projects(&member_ids);
    let _ = write_box_agent_docs(Path::new(&folder), &name, &members);
    let _ = write_box_member_links(Path::new(&folder), &members);
    Ok(folder)
}

/// Regenerate the box agent docs (CLAUDE/GEMINI/AGENTS link blocks) for a box
/// that already has a folder. No-op when the box has never been opened (no
/// `folder` yet) — we never create a folder here, only refresh existing docs.
#[tauri::command]
pub fn refresh_box_agent_docs(box_id: String) -> Result<(), String> {
    let boxes = read_boxes()?;
    let Some(b) = boxes.iter().find(|b| b.id == box_id) else {
        return Ok(());
    };
    let Some(folder) = b.folder.clone() else {
        return Ok(());
    };
    let folder = Path::new(&folder);
    if !folder.is_dir() {
        return Ok(());
    }
    let members = member_projects(&b.member_ids);
    // Symlinks first, best-effort (the docs-write pattern): a failed link farm
    // must not block the doc refresh, and vice versa.
    let _ = write_box_member_links(folder, &members);
    write_box_agent_docs(folder, &b.name, &members).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_box_relations(
    box_id: String,
    relations: Vec<BoxRelation>,
) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter_mut()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    target.relations = relations;
    let updated = target.clone();
    write_boxes(&boxes)?;
    Ok(updated)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_box(id: &str, members: &[&str]) -> ProjectBox {
        ProjectBox {
            id: id.to_string(),
            name: id.to_string(),
            member_ids: members.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn ids(values: &[&str]) -> HashSet<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    /// Headless owner plan, H1: the whole-list save is compare-and-swap per
    /// box — a stale copy is refused, and revisions move only for the boxes
    /// that changed.
    #[test]
    fn save_boxes_is_refused_for_a_box_that_moved_on_and_stamps_what_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boxes.json");
        save_boxes_at(&path, &vec![mk_box("a", &["p"]), mk_box("b", &[])]).unwrap();
        let loaded = read_boxes_at(&path).unwrap();
        assert_eq!(loaded.iter().map(|b| b.rev).collect::<Vec<_>>(), [1, 1]);

        // Window 1 renames A and saves.
        let mut one = loaded.clone();
        one[0].name = "A1".into();
        save_boxes_at(&path, &one).unwrap();
        let after_one = read_boxes_at(&path).unwrap();
        assert_eq!((after_one[0].rev, after_one[1].rev), (2, 1), "only A moved");

        // Window 2, still holding the first load, adds P to B: refused, and
        // A1 survives.
        let mut two = loaded.clone();
        two[1].member_ids.push("p".into());
        assert_eq!(save_boxes_at(&path, &two).unwrap_err(), BOXES_STALE);
        let untouched = read_boxes_at(&path).unwrap();
        assert_eq!(untouched[0].name, "A1");
        assert!(untouched[1].member_ids.is_empty());

        // Reloaded and re-applied, it lands; the caller's own numbers are
        // never trusted over the file's.
        let mut fresh = read_boxes_at(&path).unwrap();
        fresh[1].member_ids.push("p".into());
        fresh[1].rev = 99;
        assert_eq!(save_boxes_at(&path, &fresh).unwrap_err(), BOXES_STALE, "a made-up revision is stale");
        fresh[1].rev = 1;
        save_boxes_at(&path, &fresh).unwrap();
        let done = read_boxes_at(&path).unwrap();
        assert_eq!((done[0].rev, done[1].rev), (2, 2));

        // A file written before revisions loads at 0 and takes the first
        // stamped write like any other.
        std::fs::write(&path, r#"[{"id":"z","name":"Z","member_ids":[],"position":10}]"#).unwrap();
        let legacy = read_boxes_at(&path).unwrap();
        assert_eq!(legacy[0].rev, 0);
        save_boxes_at(&path, &legacy).unwrap();
        assert_eq!(read_boxes_at(&path).unwrap()[0].rev, 0, "an unchanged legacy box stays unversioned");
        let mut renamed = legacy.clone();
        renamed[0].name = "Z2".into();
        save_boxes_at(&path, &renamed).unwrap();
        assert_eq!(read_boxes_at(&path).unwrap()[0].rev, 1);
    }

    #[test]
    fn reconcile_drops_unknown_member_ids() {
        let boxes = vec![mk_box("box1", &["p1", "ghost", "p2"])];
        let project_ids = ids(&["p1", "p2"]);
        let out = reconcile_member_ids(boxes, &project_ids);
        assert_eq!(out[0].member_ids, vec!["p1".to_string(), "p2".to_string()]);
    }

    #[test]
    fn reconcile_recomputes_box_id_inverse() {
        // The pure id-map derivation that the frontend `load()` mirrors: each
        // member id maps to its box; a project absent from every box has no box.
        let boxes = vec![mk_box("boxA", &["p1", "p2"]), mk_box("boxB", &["p3"])];
        let project_ids = ids(&["p1", "p2", "p3", "p4"]);
        let reconciled = reconcile_member_ids(boxes, &project_ids);

        let mut inverse: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for b in &reconciled {
            for m in &b.member_ids {
                inverse.insert(m.clone(), b.id.clone());
            }
        }
        assert_eq!(inverse.get("p1"), Some(&"boxA".to_string()));
        assert_eq!(inverse.get("p2"), Some(&"boxA".to_string()));
        assert_eq!(inverse.get("p3"), Some(&"boxB".to_string()));
        // p4 is in no box → ungrouped (a stale box_id on p4 would lose here).
        assert_eq!(inverse.get("p4"), None);
    }

    #[test]
    fn reconcile_drops_member_when_project_deleted() {
        // boxB's only member p3 is deleted → boxB ends up empty (renders inline).
        let boxes = vec![mk_box("boxB", &["p3"])];
        let project_ids = ids(&["p1", "p2"]);
        let out = reconcile_member_ids(boxes, &project_ids);
        assert!(out[0].member_ids.is_empty());
    }

    #[test]
    fn create_box_assigns_gap_spaced_position() {
        // Exercise the position helper directly (the command path writes to the
        // real state dir, which tests must not touch).
        let mut boxes: BoxesList = vec![];
        let p1 = next_box_position(&boxes);
        boxes.push(ProjectBox {
            id: "a".into(),
            name: "a".into(),
            position: p1,
            ..Default::default()
        });
        let p2 = next_box_position(&boxes);
        assert_eq!((p1, p2), (10, 20));
    }

    #[test]
    fn box_json_roundtrips_with_defaults() {
        // A {id,name}-only box deserializes (member_ids/relations default) and
        // re-serializes with `member_ids: []` present (no skip) but `folder` and
        // `relations` absent (serde skip on None / empty Vec).
        let json = r#"{"id":"b1","name":"Paper"}"#;
        let parsed: ProjectBox = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.member_ids, Vec::<String>::new());
        assert!(parsed.folder.is_none());
        assert!(parsed.relations.is_empty());

        let back = serde_json::to_string(&parsed).unwrap();
        assert!(back.contains("\"member_ids\":[]"), "got: {back}");
        assert!(!back.contains("folder"), "folder should be skipped: {back}");
        assert!(
            !back.contains("relations"),
            "relations should be skipped: {back}"
        );
        assert!(
            !back.contains(concat!(crate::app_slug!(), "_mobile_access")),
            "an off Mobile bit should be skipped: {back}"
        );

        // Full round-trip equality.
        let reparsed: ProjectBox = serde_json::from_str(&back).unwrap();
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn resolve_box_folder_suffixes_on_collision() {
        // Two boxes named "Paper". The first claims `.../paper`; the second must
        // get a suffixed path even though neither dir exists on disk yet, because
        // the first box's `folder` is reserved in boxes.json.
        let root = paths::boxes_root();
        let first = root.join("paper").to_string_lossy().to_string();
        let boxes = vec![ProjectBox {
            id: "b1".into(),
            name: "Paper".into(),
            folder: Some(first.clone()),
            ..Default::default()
        }];
        let resolved = resolve_box_folder(&boxes, "b2", "Paper");
        assert_ne!(resolved.to_string_lossy().to_string(), first);
        assert_eq!(
            resolved,
            root.join("paper-1"),
            "second same-named box should get a -1 suffix"
        );
    }

    #[test]
    fn box_links_block_lists_members_with_matching_md() {
        let members = vec![
            (
                "Alpha".to_string(),
                PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/projects/alpha")),
            ),
            (
                "Beta".to_string(),
                PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/projects/beta")),
            ),
        ];
        let block = box_links_block("CLAUDE.md", "My Box", &members);
        assert!(block.starts_with(BOX_LINKS_START));
        assert!(block.trim_end().ends_with(BOX_LINKS_END));
        assert!(block.contains("My Box"));
        // Each member: root path + a link to its same-named (CLAUDE.md) doc.
        assert!(block.contains(concat!("root: `/home/u/", crate::app_slug!(), "/projects/alpha`")));
        assert!(block.contains(concat!("[`CLAUDE.md`](/home/u/", crate::app_slug!(), "/projects/alpha/CLAUDE.md)")));
        assert!(block.contains(concat!("[`CLAUDE.md`](/home/u/", crate::app_slug!(), "/projects/beta/CLAUDE.md)")));
        // The agent file name flows through, so GEMINI links point at GEMINI.md.
        let gem = box_links_block("GEMINI.md", "My Box", &members);
        assert!(gem.contains(concat!("[`GEMINI.md`](/home/u/", crate::app_slug!(), "/projects/alpha/GEMINI.md)")));
    }

    #[test]
    fn box_links_block_handles_no_members() {
        let block = box_links_block("AGENTS.md", "Empty", &[]);
        assert!(block.contains("_No member projects yet._"));
    }

    #[test]
    fn merge_box_doc_creates_titled_doc_when_empty() {
        let block = box_links_block("CLAUDE.md", "B", &[]);
        let merged = merge_box_doc("CLAUDE.md", "", &block);
        assert!(merged.starts_with(concat!("# CLAUDE — ", crate::app_name!(), " box context")));
        assert!(merged.contains(BOX_LINKS_START));
    }

    #[test]
    fn merge_box_doc_replaces_only_managed_block() {
        let first = box_links_block(
            "CLAUDE.md",
            "B",
            &[("Old".to_string(), PathBuf::from("/p/old"))],
        );
        let doc = merge_box_doc("CLAUDE.md", "", &first);
        // User edits the file outside the managed block.
        let edited = format!("{doc}\n\n## My notes\nkeep me\n");
        let second = box_links_block(
            "CLAUDE.md",
            "B",
            &[("New".to_string(), PathBuf::from("/p/new"))],
        );
        let merged = merge_box_doc("CLAUDE.md", &edited, &second);
        assert!(merged.contains("## My notes"));
        assert!(merged.contains("keep me"));
        assert!(merged.contains("/p/new"));
        assert!(!merged.contains("/p/old"), "old member should be gone");
        // Exactly one managed block survives.
        assert_eq!(merged.matches(BOX_LINKS_START).count(), 1);
        assert_eq!(merged.matches(BOX_LINKS_END).count(), 1);
    }

    /// A block an older build wrote (old markers) is replaced in place by the
    /// current one — one block afterwards, the user's notes kept — and the
    /// old manifest is taken over under its current name.
    #[test]
    fn a_block_and_manifest_under_the_old_name_are_taken_over() {
        use crate::brand::{Name, LEGACY};
        use crate::services::brand_migration::{adopt_named_file, hits, testing::RENAMED};
        let old_block = format!(
            "{}\n- /p/old\n{}\n",
            LEGACY.name(Name::BOX_LINKS_START),
            LEGACY.name(Name::BOX_LINKS_END)
        );
        let existing = format!("# CLAUDE\n\n{old_block}\n## My notes\nkeep me\n");
        let new_block = format!(
            "{}\n- /p/new\n{}\n",
            RENAMED.cur(Name::BOX_LINKS_START),
            RENAMED.cur(Name::BOX_LINKS_END)
        );
        let _ = hits::taken();
        let merged = merge_box_doc_for(&RENAMED, "CLAUDE.md", &existing, &new_block);
        assert_eq!(hits::taken(), ["box-links-marker"]);
        assert!(merged.contains("/p/new") && !merged.contains("/p/old"));
        assert!(merged.contains("## My notes\nkeep me"));
        assert!(!merged.contains(&LEGACY.name(Name::BOX_LINKS_START)));
        assert_eq!(merged.matches(&RENAMED.cur(Name::BOX_LINKS_START)).count(), 1);
        // The next refresh finds the current block: no second one, no hit.
        let again = merge_box_doc_for(&RENAMED, "CLAUDE.md", &merged, &new_block);
        assert_eq!(again.matches(&RENAMED.cur(Name::BOX_LINKS_START)).count(), 1);
        assert!(hits::taken().is_empty());

        let folder = tempfile::tempdir().unwrap();
        let old_manifest = folder.path().join(LEGACY.name(Name::BOX_LINKS_MANIFEST));
        std::fs::write(&old_manifest, "{\"alpha\":\"/p/alpha\"}").unwrap();
        let path = adopt_named_file(&RENAMED, Name::BOX_LINKS_MANIFEST, folder.path(), "box-links-manifest");
        assert_eq!(path, folder.path().join(RENAMED.cur(Name::BOX_LINKS_MANIFEST)));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"alpha\":\"/p/alpha\"}");
        assert!(!old_manifest.exists());
        assert_eq!(hits::taken(), ["box-links-manifest"]);
        // The production pair: the constant's path, nothing looked up.
        assert_eq!(
            adopt_named_file(&crate::brand::PAIR, Name::BOX_LINKS_MANIFEST, folder.path(), "x"),
            folder.path().join(BOX_LINKS_MANIFEST)
        );
    }

    fn project_entry(id: &str, dir: &str) -> crate::schema::projects::ProjectEntry {
        let mut extra = std::collections::HashMap::new();
        extra.insert("directory".to_string(), Value::String(dir.to_string()));
        crate::schema::projects::ProjectEntry {
            id: id.to_string(),
            name: id.to_string(),
            status: "active".to_string(),
            position: 0,
            local_file: format!("{dir}/project.json"),
            extra,
        }
    }

    #[test]
    fn box_id_of_scope_accepts_only_box_prefixed_ids() {
        assert_eq!(box_id_of_scope("box:abc"), Some("abc"));
        assert_eq!(box_id_of_scope("box:"), None);
        assert_eq!(box_id_of_scope("abc"), None);
        assert_eq!(box_id_of_scope("root"), None);
    }

    #[test]
    fn box_allowed_roots_covers_folder_members_and_mirror() {
        let mut b = mk_box("b1", &["p1", "p2"]);
        b.folder = Some(concat!("/home/u/", crate::app_slug!(), "/boxes/b1").to_string());
        let mut p2 = project_entry("p2", "/home/u/code/p2");
        p2.extra.insert(
            "mirror".to_string(),
            Value::String(concat!("/home/u/", crate::app_slug!(), "/projects-ssh/p2").to_string()),
        );
        let projects = vec![project_entry("p1", "/home/u/code/p1"), p2];
        let roots = compute_box_allowed_roots(&vec![b], &projects, "b1").unwrap();
        assert!(roots.contains(&PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/boxes/b1"))));
        assert!(roots.contains(&PathBuf::from("/home/u/code/p1")));
        assert!(roots.contains(&PathBuf::from("/home/u/code/p2")));
        assert!(roots.contains(&PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/projects-ssh/p2"))));
    }

    #[test]
    fn box_allowed_roots_unknown_box_fails_closed() {
        let boxes = vec![mk_box("b1", &["p1"])];
        let projects = vec![project_entry("p1", "/home/u/code/p1")];
        assert!(compute_box_allowed_roots(&boxes, &projects, "ghost").is_none());
    }

    #[test]
    fn box_allowed_roots_without_folder_still_lists_member_roots() {
        // A box that was never opened (no folder yet) still legalizes member
        // roots — the pill's hover actions can spawn a member-rooted tab first.
        let boxes = vec![mk_box("b1", &["p1"])];
        let projects = vec![project_entry("p1", "/home/u/code/p1")];
        let roots = compute_box_allowed_roots(&boxes, &projects, "b1").unwrap();
        assert_eq!(roots, vec![PathBuf::from("/home/u/code/p1")]);
    }

    #[test]
    fn box_allowed_roots_skips_vanished_members() {
        let boxes = vec![mk_box("b1", &["p1", "ghost"])];
        let projects = vec![project_entry("p1", "/home/u/code/p1")];
        let roots = compute_box_allowed_roots(&boxes, &projects, "b1").unwrap();
        assert_eq!(roots, vec![PathBuf::from("/home/u/code/p1")]);
    }

    #[test]
    fn plan_member_links_sanitizes_and_suffixes_collisions() {
        let members = vec![
            ("My Paper".to_string(), PathBuf::from("/p/paper-a")),
            ("My Paper".to_string(), PathBuf::from("/p/paper-b")),
            ("data".to_string(), PathBuf::from("/p/data")),
        ];
        // "my-paper" is a user file in the folder → the first member is bumped
        // straight to a suffix, the twin one further.
        let taken: HashSet<String> = ["my-paper".to_string()].into_iter().collect();
        let plan = plan_member_links(&members, &taken);
        assert_eq!(
            plan,
            vec![
                ("my-paper-1".to_string(), PathBuf::from("/p/paper-a")),
                ("my-paper-2".to_string(), PathBuf::from("/p/paper-b")),
                ("data".to_string(), PathBuf::from("/p/data")),
            ]
        );
    }

    #[test]
    fn plan_member_links_empty_name_falls_back() {
        let members = vec![("···".to_string(), PathBuf::from("/p/x"))];
        let plan = plan_member_links(&members, &HashSet::new());
        assert_eq!(plan[0].0, "project");
    }

    /// Windows: the same planner over junctions. Runs on the CI Windows job,
    /// which is the one place a junction can actually be created and read back.
    #[cfg(windows)]
    mod link_farm_windows {
        use super::*;

        #[test]
        fn creates_junctions_reads_them_back_and_removes_only_its_own() {
            let tmp = tempfile::tempdir().unwrap();
            let t1 = tmp.path().join("m1");
            let t2 = tmp.path().join("m2");
            fs::create_dir(&t1).unwrap();
            fs::create_dir(&t2).unwrap();
            let folder = tmp.path().join("box");
            fs::create_dir(&folder).unwrap();

            write_box_member_links(
                &folder,
                &[("One".to_string(), t1.clone()), ("Two".to_string(), t2)],
            )
            .unwrap();
            let one = folder.join("one");
            assert!(one.symlink_metadata().unwrap().file_type().is_symlink());
            assert!(link_points_at(&one, &t1));
            // A junction traverses like a directory.
            fs::write(t1.join("inside.txt"), b"x").unwrap();
            assert!(one.join("inside.txt").is_file());

            // Idempotent, then member two vanishes: only its junction goes, and
            // removing it leaves the member folder intact.
            write_box_member_links(&folder, &[("One".to_string(), t1.clone())]).unwrap();
            assert!(one.symlink_metadata().is_ok());
            assert!(folder.join("two").symlink_metadata().is_err());
            assert!(tmp.path().join("m2").is_dir(), "the member folder itself survives");
        }
    }

    #[cfg(unix)]
    mod link_farm {
        use super::*;

        fn read_manifest(folder: &Path) -> BoxLinksManifest {
            crate::storage::read_json(&folder.join(BOX_LINKS_MANIFEST)).unwrap_or_default()
        }

        #[test]
        fn creates_links_and_is_idempotent() {
            let tmp = tempfile::tempdir().unwrap();
            let target = tmp.path().join("member");
            fs::create_dir(&target).unwrap();
            let folder = tmp.path().join("box");
            fs::create_dir(&folder).unwrap();
            let members = vec![("Alpha".to_string(), target.clone())];

            write_box_member_links(&folder, &members).unwrap();
            let link = folder.join("alpha");
            assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
            assert_eq!(fs::read_link(&link).unwrap(), target);
            assert_eq!(
                read_manifest(&folder).get("alpha").map(String::as_str),
                Some(target.to_str().unwrap())
            );

            // Second run: same plan, nothing recreated, nothing lost.
            write_box_member_links(&folder, &members).unwrap();
            assert_eq!(fs::read_link(&link).unwrap(), target);
        }

        #[test]
        fn removes_only_own_links_of_vanished_members() {
            let tmp = tempfile::tempdir().unwrap();
            let folder = tmp.path().join("box");
            fs::create_dir(&folder).unwrap();
            let t1 = tmp.path().join("m1");
            let t2 = tmp.path().join("m2");
            fs::create_dir(&t1).unwrap();
            fs::create_dir(&t2).unwrap();

            write_box_member_links(
                &folder,
                &[("one".to_string(), t1.clone()), ("two".to_string(), t2)],
            )
            .unwrap();
            // A FOREIGN symlink Tabtivity never made stays, member or not.
            std::os::unix::fs::symlink(&t1, folder.join("foreign")).unwrap();

            write_box_member_links(&folder, &[("one".to_string(), t1)]).unwrap();
            assert!(folder.join("one").symlink_metadata().is_ok());
            assert!(folder.join("two").symlink_metadata().is_err(), "own link removed");
            assert!(folder.join("foreign").symlink_metadata().is_ok(), "foreign link kept");
        }

        #[test]
        fn never_clobbers_a_user_file_shadowing_a_member_name() {
            let tmp = tempfile::tempdir().unwrap();
            let folder = tmp.path().join("box");
            fs::create_dir(&folder).unwrap();
            let target = tmp.path().join("member");
            fs::create_dir(&target).unwrap();
            // The user parked a real file at the member's natural link name.
            fs::write(folder.join("alpha"), b"mine").unwrap();

            write_box_member_links(&folder, &[("Alpha".to_string(), target.clone())]).unwrap();

            // The user file is intact; the member got a suffixed link instead.
            assert_eq!(fs::read(folder.join("alpha")).unwrap(), b"mine");
            let link = folder.join("alpha-1");
            assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
            assert_eq!(fs::read_link(&link).unwrap(), target);
        }

        #[test]
        fn user_replacing_an_owned_link_is_respected() {
            let tmp = tempfile::tempdir().unwrap();
            let folder = tmp.path().join("box");
            fs::create_dir(&folder).unwrap();
            let target = tmp.path().join("member");
            fs::create_dir(&target).unwrap();

            write_box_member_links(&folder, &[("Alpha".to_string(), target.clone())]).unwrap();
            // The user replaces the owned symlink with a real directory.
            fs::remove_file(folder.join("alpha")).unwrap();
            fs::create_dir(folder.join("alpha")).unwrap();

            write_box_member_links(&folder, &[("Alpha".to_string(), target.clone())]).unwrap();
            // The directory survives; the member re-links under a suffix.
            assert!(folder.join("alpha").metadata().unwrap().is_dir());
            assert_eq!(fs::read_link(folder.join("alpha-1")).unwrap(), target);
        }

        #[test]
        fn rename_relinks_under_the_new_name() {
            let tmp = tempfile::tempdir().unwrap();
            let folder = tmp.path().join("box");
            fs::create_dir(&folder).unwrap();
            let target = tmp.path().join("member");
            fs::create_dir(&target).unwrap();

            write_box_member_links(&folder, &[("Alpha".to_string(), target.clone())]).unwrap();
            write_box_member_links(&folder, &[("Beta".to_string(), target.clone())]).unwrap();

            assert!(folder.join("alpha").symlink_metadata().is_err(), "old name removed");
            assert_eq!(fs::read_link(folder.join("beta")).unwrap(), target);
        }

        #[test]
        fn dangling_target_is_still_linked() {
            let tmp = tempfile::tempdir().unwrap();
            let folder = tmp.path().join("box");
            fs::create_dir(&folder).unwrap();
            let missing = tmp.path().join("not-there-yet");

            write_box_member_links(&folder, &[("Ghost".to_string(), missing.clone())]).unwrap();
            let link = folder.join("ghost");
            assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
            assert_eq!(fs::read_link(&link).unwrap(), missing);
        }
    }

    #[test]
    fn box_links_block_notes_symlink_reachability() {
        let members = vec![("Alpha".to_string(), PathBuf::from("/p/alpha"))];
        let block = box_links_block("CLAUDE.md", "B", &members);
        assert!(block.contains("symlinked beside this file"));
        // No members → no symlink note either.
        let empty = box_links_block("CLAUDE.md", "B", &[]);
        assert!(!empty.contains("symlinked"));
    }

    #[test]
    fn resolve_box_folder_uses_bare_name_when_free() {
        let root = paths::boxes_root();
        let boxes: BoxesList = vec![];
        // Use a name unlikely to exist on disk under the real boxes root.
        let resolved = resolve_box_folder(&boxes, "b1", "Zzq-Boxname-Unlikely-To-Exist-9281");
        assert_eq!(
            resolved,
            root.join("zzq-boxname-unlikely-to-exist-9281"),
            "a free, non-existent name resolves to the bare sanitized path"
        );
    }
}
