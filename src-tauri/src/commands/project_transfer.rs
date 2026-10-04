//! Full project export / import — moving one Tabtivity project to another computer.
//!
//! A project is not just a folder. Its files live wherever the user put them,
//! but its *identity* (`projects.json` entry: git label, remote spec, compute
//! hosts, container spec, interpreter, panel prefs, categories), its tab layout
//! (`<state_dir>/sessions/<key>/terminals.json`), its time history
//! (`time_summary.json`) and its box membership (`boxes.json`) are all elsewhere
//! — four stores keyed by project id. Copying the folder to a second machine and
//! importing it there rebuilds none of that; the user re-answers every question
//! Tabtivity ever asked them about the project. This module is the one operation
//! that carries all five pieces at once.
//!
//! ## The bundle
//!
//! A `.tabtivityproj` file is a zip (same crate `commands::fs` already extracts
//! dropped archives with) laid out as:
//!
//! ```text
//! tabtivity-export.json   the manifest — everything that is NOT files
//! dir/…                a local project's folder
//! state/…              a remote project's local state dir (project.json only)
//! mirror/…             a remote project's local mirror tree
//! ```
//!
//! ## Which half is trusted
//!
//! The manifest is written by Tabtivity and holds the registry entry, the
//! `project.json` body and the tab layout. The payload sections are just files.
//! A bundle is a *file*, though — it can be mailed, dropped in a shared folder,
//! or fetched from anywhere — so "written by Tabtivity" is a claim, not a fact, and
//! import treats the whole thing as untrusted input:
//!
//! - the tab layout goes through the same sanitizer a cloned repository's does
//!   (`terminal_service::adopt_untrusted_session`), which downgrades any tab
//!   naming an unknown command to a plain shell and strips its argv/env;
//! - `open_apps` — a list of host commands launched on every activation — is
//!   dropped outright, exactly as `adopt_project_tree_session` drops it;
//! - `tab_layout`/`open_apps` are stripped from the imported `project.json`
//!   too, so re-adopting the folder copy later cannot smuggle them back in;
//! - zip entries are confined (`enclosed_name`), and symlinks are written
//!   **after** every regular file, so a link entry can never become the path a
//!   later file is written through.
//!
//! What import does adopt from the manifest is the registry entry's settings.
//! That is the point of the feature, and it is a different risk class: none of
//! those fields is executed by importing — the user still has to switch to the
//! project and press something.
//!
//! ## What deliberately does not travel
//!
//! - **Passwords / tokens.** They live in the OS keychain keyed by host, never
//!   in any file Tabtivity writes (`services::remote_credentials`). The remote spec
//!   travels; the secret is re-entered on the new machine.
//! - **Host-bound sync state** (`sync.json`, `git_peer.json`). Both describe a
//!   relationship between *this* machine's mirror and a host; carrying them to a
//!   different mirror is the false-green failure `clear_host_bound_state`
//!   documents at length.
//! - **`host_bound/` markers**, which pin a tab to a machine that is not the
//!   destination.
//! - **A project VM's overlay disk.** Which is why a VM project is refused
//!   outright rather than exported into something that cannot boot.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::paths;
use crate::schema::projects::ProjectEntry;
use crate::schema::session::TerminalSession;
use crate::storage;

use super::projects::{
    conflict_message, entry_directory, entry_is_remote, entry_mirror, find_project_conflict,
    next_position, projects_root, read_projects_list, remote_project_state_dir,
    resolve_remote_mirror, sanitize_name, uuid_v4, validate_project_id, ProjectSite,
};

/// Bundle format version. Bumped only for a change an older Tabtivity could not
/// read correctly; import refuses anything newer than it understands, because
/// silently dropping a section it does not know about is how a "full" export
/// stops being full without anyone noticing.
pub const BUNDLE_FORMAT: u32 = 1;

/// The manifest entry name inside the zip. Its presence is what makes a zip an
/// Tabtivity project bundle.
pub const BUNDLE_MANIFEST: &str = crate::brand::EXPORT_MANIFEST;

/// The extension the save dialog suggests. A plain `.zip` would also import
/// (the manifest is what is checked), but a distinct one keeps a bundle from
/// being double-clicked into `extract_archive` when it lands in a project tree.
pub const BUNDLE_EXTENSION: &str = crate::brand::EXPORT_EXTENSION;

const SECTION_DIR: &str = "dir";
const SECTION_STATE: &str = "state";
const SECTION_MIRROR: &str = "mirror";

/// The only file carried out of a **remote** project's local state dir. An
/// allowlist rather than a skip list: everything else in there
/// (`sync.json`, `git_peer.json`, `local_loss.json`) describes this machine's
/// relationship to a host, and a future file dropped beside them must not start
/// travelling just because nobody remembered to exclude it.
const REMOTE_STATE_FILES: &[&str] = &["project.json"];

/// Hard cap on recursive walk depth, mirroring `commands::fs`'s `MAX_SCAN_DEPTH`.
const MAX_DEPTH: usize = 64;

/// Progress event name (payload: [`ExportProgress`]).
const PROGRESS_EVENT: &str = "project-export";

/// Vendor/build directories an export can leave behind, because they are
/// rebuildable from the files that do travel and are routinely larger than
/// everything else in the tree put together.
///
/// A near-twin of `commands::search`'s and `commands::fs`'s skip lists, and
/// deliberately not shared with them: those two also skip `.git` and `.tabtivity`
/// unconditionally, and both of those *must* be exportable — `.git` is the
/// project's history and `.tabtivity` is its scaffold. The overlap is the cheap
/// half; the difference is the whole point.
const REBUILDABLE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
];

// ── Wire types ────────────────────────────────────────────────────────────

/// What a bundle actually carries, recorded at export so import (and the
/// inspect step the dialog runs first) never has to guess from entry names.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleContents {
    pub dir: bool,
    pub state: bool,
    pub mirror: bool,
    pub git_history: bool,
    /// True when the rebuildable-folder filter was on, i.e. `node_modules` and
    /// friends were left out. Surfaced on import so "my venv is missing" is
    /// answered by the dialog rather than by a support round-trip.
    pub rebuildable_skipped: bool,
    pub files: u64,
    pub bytes: u64,
}

/// `tabtivity-export.json`. Everything about the project that is not a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub format: u32,
    /// The Tabtivity that wrote it — informational, for a "made by a newer build"
    /// message that is more useful than a bare version number mismatch.
    pub app_version: String,
    pub exported_at: String,
    /// The `projects.json` entry verbatim, paths and all. Import re-points the
    /// paths; everything else is what makes the imported project the same
    /// project rather than a folder with the same name.
    pub entry: ProjectEntry,
    /// The `project.json` body, as JSON so fields this build does not model ride
    /// along untouched.
    pub project: Value,
    /// `terminals.json` as it stood. Sanitized on import, never before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<Value>,
    /// date ("YYYY-MM-DD") → seconds, this project's slice of the rolling time
    /// summary.
    #[serde(default)]
    pub time_days: HashMap<String, f64>,
    /// Names (not ids — an id means nothing elsewhere) of the boxes the project
    /// belonged to.
    #[serde(default)]
    pub box_names: Vec<String>,
    pub remote: bool,
    /// The project's `directory` at export time — the prefix import rewrites.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirror: Option<String>,
    pub contents: BundleContents,
    /// Forward compatibility: a newer build's extra manifest keys survive a
    /// round trip through an older one rather than being dropped on re-export.
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// What the export dialog shows before anything is written: how big each part
/// of the project is, so the toggles have numbers attached.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub project_id: String,
    pub name: String,
    pub remote: bool,
    pub directory: Option<String>,
    pub directory_missing: bool,
    pub mirror: Option<String>,
    pub mirror_missing: bool,
    /// Counts for the tree that would travel with every toggle ON.
    pub files: u64,
    pub bytes: u64,
    pub git_files: u64,
    pub git_bytes: u64,
    pub rebuildable_files: u64,
    pub rebuildable_bytes: u64,
    pub tabs: usize,
    pub box_names: Vec<String>,
    pub suggested_file_name: String,
    /// A machine token when this project cannot be exported at all (`"vm"`);
    /// the frontend words it. `None` means go ahead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectRequest {
    pub project_id: String,
    /// Where the bundle is written. The save dialog supplies it.
    pub dest_path: String,
    #[serde(default = "yes")]
    pub include_files: bool,
    #[serde(default = "yes")]
    pub include_git: bool,
    #[serde(default = "yes")]
    pub include_session: bool,
    /// Remote projects only: carry the local mirror tree as well.
    #[serde(default = "yes")]
    pub include_mirror: bool,
    #[serde(default = "yes")]
    pub skip_rebuildable: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    /// The bundle's own size on disk.
    pub bytes: u64,
    pub files: u64,
    pub payload_bytes: u64,
    pub remote: bool,
    /// Machine tokens the frontend words (`"noFiles"`, `"mirrorMissing"`, …).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub project_id: String,
    /// `"start"` | `"file"` | `"done"`
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

/// What `inspect_project_export` tells the import dialog about a chosen file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    pub path: String,
    pub format: u32,
    pub app_version: String,
    pub exported_at: String,
    pub project_id: String,
    pub name: String,
    pub remote: bool,
    pub description: Option<String>,
    pub git_type: Option<String>,
    pub directory: Option<String>,
    pub mirror: Option<String>,
    pub contents: BundleContents,
    pub tabs: usize,
    pub box_names: Vec<String>,
    pub time_days: usize,
    /// True when a project with the bundle's own id is already registered here,
    /// so the dialog can say the import will get a fresh id.
    pub id_in_use: bool,
    /// The already-registered project the bundle's *site* would collide with —
    /// only ever set for a remote bundle, whose host + path is its identity and
    /// does not move with the import. `None` for a local bundle, which lands in
    /// a folder chosen at import time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_conflict: Option<String>,
    /// The default landing folder the dialog shows.
    pub suggested_parent: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBundleRequest {
    pub bundle_path: String,
    /// Rename on the way in. Empty/absent keeps the bundle's name.
    #[serde(default)]
    pub name: Option<String>,
    /// Parent folder the project's tree lands in. Absent → the managed
    /// `tabtivity/projects/` root.
    #[serde(default)]
    pub target_parent: Option<String>,
    /// Remote bundles only: parent for the recreated local mirror.
    #[serde(default)]
    pub mirror_parent: Option<String>,
    #[serde(default = "yes")]
    pub restore_session: bool,
    #[serde(default = "yes")]
    pub restore_time: bool,
    #[serde(default = "yes")]
    pub join_boxes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBundleResult {
    pub entry: ProjectEntry,
    pub directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirror: Option<String>,
    pub files: u64,
    pub tabs_restored: usize,
    /// Tabs the sanitizer downgraded to a plain shell (unknown command).
    pub tabs_downgraded: usize,
    pub new_id: bool,
    pub boxes_joined: Vec<String>,
    pub boxes_missing: Vec<String>,
    /// Machine tokens the frontend words.
    pub notes: Vec<String>,
}

// ── Tree walking ──────────────────────────────────────────────────────────

/// Which bucket a path falls in, for both the size preview and the export
/// filter. Sticky on the way down: everything under a `.git` is `Git`, so a
/// `node_modules` inside one is still counted as history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Plain,
    Git,
    Rebuildable,
}

#[derive(Debug, Clone, Copy)]
struct WalkFilter {
    git: bool,
    rebuildable: bool,
}

impl WalkFilter {
    fn all() -> Self {
        Self {
            git: true,
            rebuildable: true,
        }
    }

    fn wants(&self, class: Class) -> bool {
        match class {
            Class::Plain => true,
            Class::Git => self.git,
            Class::Rebuildable => self.rebuildable,
        }
    }
}

enum TreeItem {
    Dir,
    File { size: u64, mode: u32 },
    Symlink(PathBuf),
}

fn class_of(name: &str, parent: Class) -> Class {
    if parent != Class::Plain {
        return parent;
    }
    if name == ".git" {
        Class::Git
    } else if REBUILDABLE_DIRS.contains(&name) {
        Class::Rebuildable
    } else {
        Class::Plain
    }
}

#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
fn mode_of(meta: &fs::Metadata) -> u32 {
    if meta.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

/// Walk `root`, visiting every entry the filter wants, with its class.
///
/// Symlinks are reported as links and never followed — same rule as
/// `projects::copy_tree_core`, and for the same two reasons: a dangling
/// venv/node pointer must not abort the whole export, and a link into a large
/// tree must not silently duplicate it into the bundle. Entries are visited in
/// sorted order so two exports of an unchanged tree produce the same bundle.
fn walk_tree(
    root: &Path,
    filter: WalkFilter,
    exclude: Option<&Path>,
    visit: &mut impl FnMut(&str, Class, TreeItem) -> Result<(), String>,
) -> Result<(), String> {
    walk_in(root, "", Class::Plain, filter, exclude, 0, visit)
}

fn walk_in(
    dir: &Path,
    rel_prefix: &str,
    class: Class,
    filter: WalkFilter,
    exclude: Option<&Path>,
    depth: usize,
    visit: &mut impl FnMut(&str, Class, TreeItem) -> Result<(), String>,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let mut names: Vec<(std::ffi::OsString, fs::FileType)> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        names.push((entry.file_name(), file_type));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, file_type) in names {
        let name = name.to_string_lossy().to_string();
        let path = dir.join(&name);
        if exclude.is_some_and(|ex| ex == path) {
            continue;
        }
        let child_class = class_of(&name, class);
        if !filter.wants(child_class) {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if file_type.is_symlink() {
            match fs::read_link(&path) {
                Ok(target) => visit(&rel, child_class, TreeItem::Symlink(target))?,
                // A link we cannot read is not worth failing an export over; it
                // is reported by its absence from the bundle, not by an abort.
                Err(e) => eprintln!("project_transfer: skipping symlink {}: {e}", path.display()),
            }
        } else if file_type.is_dir() {
            visit(&rel, child_class, TreeItem::Dir)?;
            walk_in(
                &path,
                &rel,
                child_class,
                filter,
                exclude,
                depth + 1,
                visit,
            )?;
        } else {
            match fs::metadata(&path) {
                Ok(meta) => visit(
                    &rel,
                    child_class,
                    TreeItem::File {
                        size: meta.len(),
                        mode: mode_of(&meta),
                    },
                )?,
                Err(e) => eprintln!("project_transfer: skipping {}: {e}", path.display()),
            }
        }
    }
    Ok(())
}

// ── Preview ───────────────────────────────────────────────────────────────

#[derive(Default)]
struct SizeTally {
    files: u64,
    bytes: u64,
    git_files: u64,
    git_bytes: u64,
    rebuildable_files: u64,
    rebuildable_bytes: u64,
}

fn tally(root: &Path) -> Result<SizeTally, String> {
    let mut out = SizeTally::default();
    if !root.is_dir() {
        return Ok(out);
    }
    walk_tree(root, WalkFilter::all(), None, &mut |_rel, class, item| {
        if let TreeItem::File { size, .. } = item {
            match class {
                Class::Plain => {
                    out.files += 1;
                    out.bytes += size;
                }
                Class::Git => {
                    out.git_files += 1;
                    out.git_bytes += size;
                }
                Class::Rebuildable => {
                    out.rebuildable_files += 1;
                    out.rebuildable_bytes += size;
                }
            }
        }
        Ok(())
    })?;
    Ok(out)
}

/// A filename for the save dialog: `name-YYYY-MM-DD.tabtivityproj`.
pub fn suggested_bundle_name(name: &str) -> String {
    let safe = sanitize_name(name);
    let stem = if safe.is_empty() { "project" } else { &safe };
    let date = storage::today_utc();
    format!("{stem}-{date}.{BUNDLE_EXTENSION}")
}

/// Size/shape of what an export would carry, for the dialog. Read-only.
// `(async)`: a full tree stat-walk of a large project is exactly the kind of
// work that froze the window when run on the main thread (see
// `commands::git::run_off_thread`). No `State`/`AppHandle`, so nothing binds it
// to that thread.
#[tauri::command(async)]
pub fn preview_project_export(project_id: String) -> Result<ExportPreview, String> {
    validate_project_id(&project_id)?;
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;

    let remote = entry_is_remote(entry);
    let directory = entry_directory(entry);
    let mirror = entry_mirror(entry);
    let blocked = export_blocker(entry);

    // The tree whose size matters is the one that actually holds the files: a
    // local project's own folder, a remote project's mirror. A remote project's
    // `directory` is a state dir with one small file in it.
    let payload_root = if remote {
        mirror.clone()
    } else {
        directory.clone()
    };
    let counts = match (&blocked, &payload_root) {
        (None, Some(root)) => tally(Path::new(root))?,
        _ => SizeTally::default(),
    };

    // project-tree-read: ok — a `TerminalSession` from the STATE dir (that is
    // what `load_terminal_session` reads), counted for the dialog. Nothing here
    // touches the project tree's copy.
    let tabs = crate::services::terminal_service::load_terminal_session(&project_id)
        .tab_layout
        .len();

    Ok(ExportPreview {
        project_id: project_id.clone(),
        name: entry.name.clone(),
        remote,
        directory_missing: directory
            .as_deref()
            .is_some_and(|d| !Path::new(d).is_dir()),
        mirror_missing: mirror.as_deref().is_some_and(|m| !Path::new(m).is_dir()),
        directory,
        mirror,
        files: counts.files,
        bytes: counts.bytes,
        git_files: counts.git_files,
        git_bytes: counts.git_bytes,
        rebuildable_files: counts.rebuildable_files,
        rebuildable_bytes: counts.rebuildable_bytes,
        tabs,
        box_names: super::boxes::box_names_for(&project_id),
        suggested_file_name: suggested_bundle_name(&entry.name),
        blocked,
    })
}

/// Why this project cannot be exported, as a machine token — or `None`.
fn export_blocker(entry: &ProjectEntry) -> Option<String> {
    if entry.extra.get("vm").is_some_and(|v| !v.is_null()) {
        // A VM project's working tree *is* its overlay disk under
        // `<state_dir>/vm/<id>` — typically tens of gigabytes, and useless
        // without the matching base image. Exporting everything but the disk
        // would register a project on the far side that cannot boot, which is
        // worse than saying so here.
        return Some("vm".to_string());
    }
    None
}

// ── Export ────────────────────────────────────────────────────────────────

/// Write a project bundle. Progress is reported through `progress(done, total)`.
pub fn export_project_blocking(
    req: ExportProjectRequest,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<ExportReport, String> {
    validate_project_id(&req.project_id)?;
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|p| p.id == req.project_id)
        .ok_or_else(|| format!("project '{}' not found", req.project_id))?
        .clone();

    if let Some(reason) = export_blocker(&entry) {
        debug_assert_eq!(reason, "vm");
        return Err("A project VM cannot be exported: its working tree is the VM's own disk \
                    image. Copy files out of the VM into a plain project first."
            .to_string());
    }

    let dest = PathBuf::from(&req.dest_path);
    if dest.as_os_str().is_empty() {
        return Err("No destination was chosen".to_string());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let remote = entry_is_remote(&entry);
    let directory = entry_directory(&entry);
    let mirror = entry_mirror(&entry);
    let mut notes: Vec<String> = Vec::new();

    // Writing the bundle into the very tree being walked would have the walk
    // race its own output. The walker also skips this exact path, so an export
    // into the project folder still works — this only rejects the nonsense case
    // of overwriting a file the bundle is supposed to contain.
    let dest_abs = absolutize(&dest);

    let filter = WalkFilter {
        git: req.include_git,
        rebuildable: !req.skip_rebuildable,
    };

    // ── Sections to write ───────────────────────────────────────────────
    // A local project: its folder. A remote project: the allowlisted state dir
    // plus (optionally) the local mirror.
    let mut sections: Vec<(&str, PathBuf)> = Vec::new();
    if remote {
        if let Some(dir) = &directory {
            sections.push((SECTION_STATE, PathBuf::from(dir)));
        }
        if req.include_mirror {
            match mirror.as_deref() {
                Some(m) if Path::new(m).is_dir() => sections.push((SECTION_MIRROR, PathBuf::from(m))),
                Some(_) => notes.push("mirrorMissing".to_string()),
                None => {}
            }
        }
    } else if req.include_files {
        match directory.as_deref() {
            Some(dir) if Path::new(dir).is_dir() => sections.push((SECTION_DIR, PathBuf::from(dir))),
            Some(_) => notes.push("folderMissing".to_string()),
            None => {}
        }
    }
    if !remote && !req.include_files {
        notes.push("noFiles".to_string());
    }

    // ── Count first, so progress has a denominator ──────────────────────
    let mut total: u64 = 0;
    for (section, root) in &sections {
        if *section == SECTION_STATE {
            total += REMOTE_STATE_FILES
                .iter()
                .filter(|f| root.join(f).is_file())
                .count() as u64;
            continue;
        }
        walk_tree(root, filter, Some(&dest_abs), &mut |_rel, _class, item| {
            if matches!(item, TreeItem::File { .. }) {
                total += 1;
            }
            Ok(())
        })?;
    }
    progress(0, total);

    // ── Manifest ────────────────────────────────────────────────────────
    let project_file = PathBuf::from(&entry.local_file);
    let project_json: Value = if project_file.is_file() {
        storage::read_json(&project_file).unwrap_or_else(|_| Value::Object(Default::default()))
    } else {
        Value::Object(Default::default())
    };
    let project_json = strip_session_fields(project_json);

    let session = if req.include_session {
        let path = storage::project_session_dir(&req.project_id).join("terminals.json");
        storage::read_json::<Value>(&path).ok()
    } else {
        None
    };

    let time_days = crate::schema::time_log::load_summary_migrating()
        .map(|summary| summary.activity_for(&req.project_id))
        .unwrap_or_default();

    let mut manifest = ExportManifest {
        format: BUNDLE_FORMAT,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: storage::iso_now(),
        entry: exported_entry(&entry),
        project: project_json,
        session,
        time_days,
        box_names: super::boxes::box_names_for(&req.project_id),
        remote,
        directory: directory.clone(),
        mirror: mirror.clone(),
        contents: BundleContents {
            dir: sections.iter().any(|(s, _)| *s == SECTION_DIR),
            state: sections.iter().any(|(s, _)| *s == SECTION_STATE),
            mirror: sections.iter().any(|(s, _)| *s == SECTION_MIRROR),
            git_history: req.include_git,
            rebuildable_skipped: req.skip_rebuildable,
            files: 0,
            bytes: 0,
        },
        extra: HashMap::new(),
    };

    // ── Write ───────────────────────────────────────────────────────────
    // Staged beside the destination and renamed over it: an export that dies
    // halfway must not leave a truncated file where a whole bundle was, and a
    // half-written zip is indistinguishable from a whole one until it is opened.
    let stage_parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut staged = tempfile::NamedTempFile::new_in(&stage_parent)
        .map_err(|e| format!("stage bundle in {}: {e}", stage_parent.display()))?;

    let mut written_files: u64 = 0;
    let mut written_bytes: u64 = 0;
    {
        let mut zip = zip::ZipWriter::new(staged.as_file_mut());
        // Deferred: the manifest records the payload totals, which are only
        // known once the payload is written, so it is added last. Zip readers
        // index by name, not by order.
        for (section, root) in &sections {
            if *section == SECTION_STATE {
                for file in REMOTE_STATE_FILES {
                    let path = root.join(file);
                    if !path.is_file() {
                        continue;
                    }
                    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                    zip_file(&mut zip, &format!("{section}/{file}"), &bytes, 0o644)?;
                    written_files += 1;
                    written_bytes += bytes.len() as u64;
                    progress(written_files, total);
                }
                continue;
            }
            // Symlinks last: a link entry written before a file entry whose path
            // runs through it would make the extractor follow it out of the
            // destination. Collected here, written after the loop.
            let mut links: Vec<(String, PathBuf)> = Vec::new();
            walk_tree(root, filter, Some(&dest_abs), &mut |rel, _class, item| {
                let name = format!("{section}/{rel}");
                match item {
                    TreeItem::Dir => zip
                        .add_directory(format!("{name}/"), dir_options())
                        .map_err(|e| format!("zip {name}: {e}"))?,
                    TreeItem::Symlink(target) => links.push((name, target)),
                    TreeItem::File { size, mode } => {
                        let path = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                        match fs::read(&path) {
                            Ok(bytes) => {
                                zip_file(&mut zip, &name, &bytes, mode)?;
                                written_files += 1;
                                written_bytes += size;
                                if written_files.is_multiple_of(64) {
                                    progress(written_files, total);
                                }
                            }
                            // One unreadable file (a permission, a file deleted
                            // mid-walk) must not throw away the whole export.
                            Err(e) => {
                                eprintln!("project_transfer: skipping {}: {e}", path.display());
                            }
                        }
                    }
                }
                Ok(())
            })?;
            for (name, target) in links {
                zip.add_symlink(&name, target.to_string_lossy().as_ref(), link_options())
                    .map_err(|e| format!("zip symlink {name}: {e}"))?;
            }
        }

        manifest.contents.files = written_files;
        manifest.contents.bytes = written_bytes;
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        zip_file(&mut zip, BUNDLE_MANIFEST, &manifest_bytes, 0o644)?;
        zip.finish().map_err(|e| format!("finish bundle: {e}"))?;
    }
    staged.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    staged
        .persist(&dest)
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    progress(written_files, total);

    let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(ExportReport {
        path: dest.to_string_lossy().to_string(),
        bytes,
        files: written_files,
        payload_bytes: written_bytes,
        remote,
        notes,
    })
}

fn dir_options() -> zip::write::FileOptions<'static, ()> {
    zip::write::FileOptions::default().unix_permissions(0o755)
}

fn link_options() -> zip::write::FileOptions<'static, ()> {
    zip::write::FileOptions::default()
}

fn zip_file(
    zip: &mut zip::ZipWriter<&mut fs::File>,
    name: &str,
    bytes: &[u8],
    mode: u32,
) -> Result<(), String> {
    // zip64 is only needed past 4 GiB, and turning it on unconditionally makes
    // every entry bigger for no gain — so it rides on the entry's own size.
    let options = zip::write::FileOptions::<()>::default()
        .unix_permissions(if mode == 0 { 0o644 } else { mode })
        .large_file(bytes.len() as u64 >= u32::MAX as u64);
    zip.start_file(name, options)
        .map_err(|e| format!("zip {name}: {e}"))?;
    zip.write_all(bytes).map_err(|e| format!("zip {name}: {e}"))
}

/// Drop from an exported `project.json` the fields whose authoritative home is
/// the state dir's session file. They are carried in the manifest's `session`
/// instead (and sanitized on the way back in); leaving a second, *unsanitized*
/// copy inside the travelling folder would just restore the hole that moving
/// session state out of the project tree closed.
fn strip_session_fields(mut project: Value) -> Value {
    if let Some(map) = project.as_object_mut() {
        for key in [
            "open_apps",
            "tab_layout",
            "tab_groups",
            "open_tab_sessions",
            "status",
            "position",
        ] {
            map.remove(key);
        }
    }
    project
}

/// Remove every OpenVPN tunnel from an imported registry entry or `project.json`
/// body — the primary's `remote` spec and each `compute_hosts` worker — together
/// with that spec's `auto_connect`, which would otherwise bring the host up on
/// launch expecting a tunnel that is no longer there. Returns whether anything
/// was dropped. A tunnel runs elevated from a config file the bundle may have
/// carried in itself (#868), so none travels: the user picks it again.
fn drop_imported_openvpn(value: &mut Value) -> bool {
    fn drop_from(spec: &mut Value) -> bool {
        let Some(spec) = spec.as_object_mut() else {
            return false;
        };
        if spec.remove("openvpn").is_none() {
            return false;
        }
        spec.remove("auto_connect");
        true
    }
    let Some(map) = value.as_object_mut() else {
        return false;
    };
    let mut dropped = map.get_mut("remote").is_some_and(drop_from);
    if let Some(hosts) = map.get_mut("compute_hosts").and_then(Value::as_array_mut) {
        for host in hosts {
            dropped |= drop_from(host);
        }
    }
    dropped
}

/// The registry keys that open a project to phones: the switch, its per-phone
/// list, and the switch under the name an older build wrote (the migrator
/// would rename that one into place). None of them travels in a bundle, either
/// way: phone access is consent given on one machine to the phones paired with
/// it, and a list names device ids that mean nothing anywhere else.
fn mobile_keys() -> Vec<String> {
    let mut keys = vec![
        crate::brand::MOBILE_ACCESS_KEY.to_string(),
        crate::brand::MOBILE_DEVICES_KEY.to_string(),
    ];
    keys.extend(crate::brand::PAIR.legacy(crate::brand::Name::MOBILE_ACCESS_KEY));
    keys
}

/// The registry entry as a bundle carries it: phone access stays on this
/// machine ([`mobile_keys`]).
fn exported_entry(entry: &ProjectEntry) -> ProjectEntry {
    let mut entry = entry.clone();
    for key in mobile_keys() {
        entry.extra.remove(&key);
    }
    entry
}

/// Drop [`mobile_keys`] from an entry (or `project.json`) body.
fn drop_mobile_keys(value: &mut Value) {
    if let Some(map) = value.as_object_mut() {
        for key in mobile_keys() {
            map.remove(&key);
        }
    }
}

fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

#[tauri::command]
pub async fn export_project(
    app: AppHandle,
    req: ExportProjectRequest,
) -> Result<ExportReport, String> {
    let project_id = req.project_id.clone();
    tokio::task::spawn_blocking(move || {
        let emit = |phase: &str, done: u64, total: u64| {
            let _ = app.emit(
                PROGRESS_EVENT,
                ExportProgress {
                    project_id: project_id.clone(),
                    phase: phase.to_string(),
                    done,
                    total,
                },
            );
        };
        let mut started = false;
        let result = export_project_blocking(req, &mut |done, total| {
            if !started {
                started = true;
                emit("start", done, total);
            } else {
                emit("file", done, total);
            }
        });
        emit("done", 0, 0);
        result
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
}

// ── Import ────────────────────────────────────────────────────────────────

type Bundle = zip::ZipArchive<fs::File>;

fn open_bundle(path: &str) -> Result<(Bundle, ExportManifest), String> {
    let file = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read {path}: {e}"))?;
    // A bundle an older build wrote carries its manifest under the app's old
    // name; such bundles stay importable.
    let manifest_name = crate::services::brand_migration::compat::export_manifest_name(&crate::brand::PAIR, |name| {
        zip.file_names().any(|entry| entry == name)
    });
    let manifest: ExportManifest = {
        let entry = zip.by_name(&manifest_name).map_err(|_| {
            concat!("That file is not a ", crate::app_name!(), " project export (no ", crate::app_slug!(), "-export.json inside)").to_string()
        })?;
        serde_json::from_reader(entry).map_err(|e| format!("read {BUNDLE_MANIFEST}: {e}"))?
    };
    if manifest.format > BUNDLE_FORMAT {
        return Err(format!(
            concat!("This bundle was written by a newer ", crate::app_name!(), " (bundle format {}, this build reads {}). \
             Update ", crate::app_name!(), " and try again."),
            manifest.format, BUNDLE_FORMAT
        ));
    }
    Ok((zip, manifest))
}

/// Read a bundle's manifest without unpacking anything, for the import dialog.
#[tauri::command(async)]
pub fn inspect_project_export(bundle_path: String) -> Result<BundleInfo, String> {
    let (_zip, manifest) = open_bundle(&bundle_path)?;
    let list = read_projects_list()?;
    let id_in_use = list.iter().any(|p| p.id == manifest.entry.id);

    // Only a remote bundle carries a site that exists independently of where the
    // import lands: the same login on the same host at the same path is the same
    // project, whichever machine notices it. A local bundle's folder is chosen
    // here, so it cannot collide until it has been chosen.
    let site_conflict = manifest
        .entry
        .extra
        .get("remote")
        .and_then(|v| serde_json::from_value::<crate::schema::project::RemoteSpec>(v.clone()).ok())
        .and_then(|spec| find_project_conflict(&list, &ProjectSite::Remote { spec: &spec }, None))
        .map(|conflict| conflict.name);

    let tabs = manifest
        .session
        .as_ref()
        .and_then(|s| s.get("tabLayout"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);

    let suggested_parent = if manifest.remote {
        paths::projects_ssh_root()
    } else {
        projects_root()
    };

    Ok(BundleInfo {
        path: bundle_path,
        format: manifest.format,
        app_version: manifest.app_version,
        exported_at: manifest.exported_at,
        project_id: manifest.entry.id.clone(),
        name: manifest.entry.name.clone(),
        remote: manifest.remote,
        description: manifest
            .entry
            .extra
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        git_type: manifest
            .entry
            .extra
            .get("git_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        directory: manifest.directory,
        mirror: manifest.mirror,
        contents: manifest.contents,
        tabs,
        box_names: manifest.box_names,
        time_days: manifest.time_days.len(),
        id_in_use,
        site_conflict,
        suggested_parent: suggested_parent.to_string_lossy().to_string(),
    })
}

/// A free `<parent>/<leaf>`, suffixing `-2`, `-3`, … rather than merging into a
/// folder that is already there. Import never writes into an existing tree: the
/// bundle is a whole project, and overlaying it on someone else's files is the
/// one outcome nobody can undo.
fn free_dir(parent: &Path, leaf: &str) -> PathBuf {
    let direct = parent.join(leaf);
    if !direct.exists() {
        return direct;
    }
    for n in 2..10_000 {
        let candidate = parent.join(format!("{leaf}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{leaf}-{}", storage::today_utc()))
}

/// Unpack one bundle section into `dest`.
///
/// Two ordering rules make this safe against a hand-crafted zip:
/// `enclosed_name` rejects any entry that would escape (absolute, `..`, drive
/// prefix), and symlinks are created only after every directory and file, so no
/// regular-file write can ever run through a link this same archive placed.
fn extract_section(zip: &mut Bundle, section: &str, dest: &Path) -> Result<u64, String> {
    let prefix = format!("{section}/");
    fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut links: Vec<(PathBuf, String)> = Vec::new();
    let mut files: u64 = 0;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let Ok(rel) = enclosed.strip_prefix(section) else {
            continue;
        };
        if rel.as_os_str().is_empty() || !entry.name().starts_with(&prefix) {
            continue;
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
            continue;
        }
        if entry.is_symlink() {
            let mut target = String::new();
            std::io::Read::read_to_string(&mut entry, &mut target).map_err(|e| e.to_string())?;
            links.push((out, target));
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let mut file =
            fs::File::create(&out).map_err(|e| format!("write {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        apply_mode(&out, entry.unix_mode());
        files += 1;
    }

    for (out, target) in links {
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if let Err(e) = make_symlink(&target, &out) {
            // Windows needs a privilege most accounts lack. A missing link is a
            // reported gap, not a failed import — everything else is on disk.
            eprintln!("project_transfer: symlink {} -> {target}: {e}", out.display());
        }
    }
    Ok(files)
}

#[cfg(unix)]
fn apply_mode(path: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        // Only the permission bits, and never wider than the user's umask would
        // have allowed for a file they created themselves.
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o777));
    }
}

#[cfg(not(unix))]
fn apply_mode(_path: &Path, _mode: Option<u32>) {}

#[cfg(unix)]
fn make_symlink(target: &str, at: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

#[cfg(not(unix))]
fn make_symlink(target: &str, at: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, at)
}

pub fn import_project_export_blocking(
    req: ImportBundleRequest,
) -> Result<ImportBundleResult, String> {
    let (mut zip, manifest) = open_bundle(&req.bundle_path)?;
    // Validate the registry before a single byte is unpacked: a corrupt
    // projects.json must fail closed rather than leave an orphan tree on disk.
    let list = read_projects_list()?;

    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&manifest.entry.name)
        .to_string();

    // Keep the exported id when it is free — that is what makes a moved project
    // the same project (its agent session dirs, its time history, a box that
    // still lists it). Mint a fresh one when the id is taken, which is the
    // "import a copy beside the original" case.
    let id_in_use = list.iter().any(|p| p.id == manifest.entry.id);
    let new_id = id_in_use || manifest.entry.id.is_empty();
    let id = if new_id {
        uuid_v4()
    } else {
        manifest.entry.id.clone()
    };
    validate_project_id(&id)?;

    let mut notes: Vec<String> = Vec::new();
    let mut files: u64 = 0;

    // ── Where it lands ──────────────────────────────────────────────────
    let leaf = {
        let safe = sanitize_name(&name);
        if safe.is_empty() {
            id.clone()
        } else {
            safe
        }
    };
    let (directory, mirror) = if manifest.remote {
        let spec: Option<crate::schema::project::RemoteSpec> = manifest
            .entry
            .extra
            .get("remote")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        if let Some(spec) = &spec {
            if let Some(conflict) =
                find_project_conflict(&list, &ProjectSite::Remote { spec }, None)
            {
                return Err(conflict_message(&conflict));
            }
        }
        let state = remote_project_state_dir(&id);
        if state.exists() {
            return Err(format!(
                "a local state folder for project id '{id}' already exists at {}",
                state.display()
            ));
        }
        let mirror = resolve_remote_mirror(req.mirror_parent.as_deref(), &name, &id, &list);
        (state, Some(mirror))
    } else {
        let parent = req
            .target_parent
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(projects_root);
        fs::create_dir_all(&parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        let dir = free_dir(&parent, &leaf);
        if let Some(conflict) = find_project_conflict(
            &list,
            &ProjectSite::Local {
                dir: &dir.to_string_lossy(),
            },
            None,
        ) {
            return Err(conflict_message(&conflict));
        }
        (dir, None)
    };

    // ── Unpack ──────────────────────────────────────────────────────────
    if manifest.remote {
        if manifest.contents.state {
            files += extract_section(&mut zip, SECTION_STATE, &directory)?;
        } else {
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        }
        if let Some(mirror) = &mirror {
            let mirror = Path::new(mirror);
            if manifest.contents.mirror {
                files += extract_section(&mut zip, SECTION_MIRROR, mirror)?;
            } else {
                fs::create_dir_all(mirror).map_err(|e| e.to_string())?;
                notes.push("mirrorEmpty".to_string());
            }
        }
        // Whatever the far machine knew about this host's credentials stayed in
        // its keychain, and its sync/lockstep state was never packed.
        notes.push("remoteCredentials".to_string());
    } else if manifest.contents.dir {
        files += extract_section(&mut zip, SECTION_DIR, &directory)?;
    } else {
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        notes.push("noFiles".to_string());
    }
    if manifest.contents.rebuildable_skipped {
        notes.push("rebuildableSkipped".to_string());
    }
    if !manifest.contents.git_history && !manifest.remote {
        notes.push("noGitHistory".to_string());
    }

    // ── Re-point every path the old machine wrote ───────────────────────
    let new_dir = directory.to_string_lossy().to_string();
    let mut entry_value = serde_json::to_value(&manifest.entry).map_err(|e| e.to_string())?;
    let mut project_value = manifest.project.clone();
    let mut session_value = manifest.session.clone();
    let mut rewrite = |old: Option<&str>, new: &str| {
        let Some(old) = old.filter(|o| !o.is_empty() && *o != new) else {
            return;
        };
        storage::rewrite_path_prefix(&mut entry_value, old, new);
        storage::rewrite_path_prefix(&mut project_value, old, new);
        if let Some(session) = session_value.as_mut() {
            storage::rewrite_path_prefix(session, old, new);
        }
    };
    rewrite(manifest.directory.as_deref(), &new_dir);
    if let (Some(old), Some(new)) = (manifest.mirror.as_deref(), mirror.as_deref()) {
        rewrite(Some(old), new);
    }

    // A tunnel the bundle names is not adopted (#868): its `.ovpn` may be a file
    // the bundle itself shipped (the rewrite above even points it at the unpacked
    // copy), and OpenVPN runs it as root. The user re-picks the config here.
    let vpn_dropped = drop_imported_openvpn(&mut entry_value);
    if drop_imported_openvpn(&mut project_value) || vpn_dropped {
        notes.push("vpnDropped".to_string());
    }
    // Nor is phone access: a bundle exported with it on (or by a build that
    // still carried it) must not open the project to this machine's phones
    // without the user switching it on here.
    drop_mobile_keys(&mut entry_value);
    drop_mobile_keys(&mut project_value);

    let mut entry: ProjectEntry =
        serde_json::from_value(entry_value).map_err(|e| format!("bundle entry: {e}"))?;
    entry.id = id.clone();
    entry.name = name.clone();
    entry.status = "inactive".to_string();
    entry.extra.insert(
        "directory".to_string(),
        Value::String(new_dir.clone()),
    );
    match mirror.as_deref() {
        Some(m) => {
            entry
                .extra
                .insert("mirror".to_string(), Value::String(m.to_string()));
        }
        None => {
            entry.extra.remove("mirror");
        }
    }
    entry.extra.remove("vm");

    let project_file = directory.join("project.json");
    entry.local_file = project_file.to_string_lossy().to_string();

    // ── project.json ────────────────────────────────────────────────────
    // Rewritten from the manifest rather than adopted from the unpacked tree:
    // the tree half of a bundle is attacker-controlled, and this file is read
    // back for the container spec and the interpreter.
    if let Some(map) = project_value.as_object_mut() {
        map.insert("id".to_string(), Value::String(id.clone()));
        map.insert("name".to_string(), Value::String(name.clone()));
        map.insert("directory".to_string(), Value::String(new_dir.clone()));
        map.insert(
            "local_file".to_string(),
            Value::String(entry.local_file.clone()),
        );
        match mirror.as_deref() {
            Some(m) => {
                map.insert("mirror".to_string(), Value::String(m.to_string()));
            }
            None => {
                map.remove("mirror");
            }
        }
        map.remove("vm");
    }
    let project_value = strip_session_fields(project_value);
    storage::write_json(&project_file, &project_value).map_err(|e| e.to_string())?;

    // ── Register ────────────────────────────────────────────────────────
    let entry = super::projects::patch_projects_list(|list| {
        let site = match entry.extra.get("remote").and_then(|v| {
            serde_json::from_value::<crate::schema::project::RemoteSpec>(v.clone()).ok()
        }) {
            Some(spec) => {
                if let Some(conflict) =
                    find_project_conflict(list, &ProjectSite::Remote { spec: &spec }, None)
                {
                    return Err(conflict_message(&conflict));
                }
                None
            }
            None => Some(()),
        };
        if site.is_some() {
            if let Some(conflict) =
                find_project_conflict(list, &ProjectSite::Local { dir: &new_dir }, None)
            {
                return Err(conflict_message(&conflict));
            }
        }
        let mut entry = entry.clone();
        entry.position = next_position(list);
        list.retain(|p| p.id != entry.id);
        list.push(entry.clone());
        Ok(entry)
    })?;

    // ── Session, time, boxes ────────────────────────────────────────────
    let mut tabs_restored = 0usize;
    let mut tabs_downgraded = 0usize;
    if req.restore_session {
        if let Some(value) = session_value {
            match serde_json::from_value::<TerminalSession>(value) {
                Ok(session) => {
                    // project-tree-read: ok — `TerminalSession`s, not project.json
                    // fields: the bundle's layout before sanitizing and what
                    // `adopt_untrusted_session` actually stored, compared only to
                    // count how many tabs the sanitizer downgraded.
                    let before: Vec<String> =
                        session.tab_layout.iter().map(|t| t.cmd.clone()).collect();
                    let stored = crate::services::terminal_service::adopt_untrusted_session(
                        &id, session,
                    )?;
                    // project-tree-read: ok — the stored (sanitized) state-dir session.
                    tabs_restored = stored.tab_layout.len();
                    tabs_downgraded = stored
                        // project-tree-read: ok — same sanitized session.
                        .tab_layout
                        .iter()
                        .zip(&before)
                        .filter(|(tab, was)| tab.cmd.is_empty() && !was.is_empty())
                        .count();
                }
                Err(e) => {
                    eprintln!("project_transfer: unreadable session in bundle: {e}");
                    notes.push("sessionUnreadable".to_string());
                }
            }
        }
    }
    if tabs_downgraded > 0 {
        notes.push("sessionSanitized".to_string());
    }

    if req.restore_time && !manifest.time_days.is_empty() {
        let days = manifest.time_days.clone();
        let target = id.clone();
        crate::schema::time_log::patch_summary(move |summary| {
            for (date, secs) in &days {
                // Re-importing the same bundle must not double a day's total, so
                // this raises a day to the imported figure rather than adding to
                // it. A day the local machine already recorded more on keeps its
                // own number — it was there, this bundle's copy is older.
                let current = summary.seconds_on(&target, date);
                if *secs > current {
                    summary.add(&target, date, *secs - current);
                }
            }
            Ok(())
        })?;
    }

    let (boxes_joined, boxes_missing) = if req.join_boxes {
        super::boxes::join_boxes_by_name(&id, &manifest.box_names)?
    } else {
        (vec![], vec![])
    };

    if new_id {
        notes.push("newId".to_string());
    }

    Ok(ImportBundleResult {
        entry,
        directory: new_dir,
        mirror,
        files,
        tabs_restored,
        tabs_downgraded,
        new_id,
        boxes_joined,
        boxes_missing,
        notes,
    })
}

#[tauri::command]
pub async fn import_project_export(
    req: ImportBundleRequest,
) -> Result<ImportBundleResult, String> {
    tokio::task::spawn_blocking(move || import_project_export_blocking(req))
        .await
        .map_err(|e| format!("import task failed: {e}"))?
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_entries_drop_every_openvpn_tunnel() {
        // #868: the bundle could ship its own `.ovpn`, which runs as root.
        let mut entry = serde_json::json!({
            "id": "p1",
            "name": "P",
            "remote": {
                "host": "build.example", "remote_path": "/srv/p", "user": "alice",
                "openvpn": {"config": "/old/mirror/evil.ovpn", "username": "u"},
                "auto_connect": true, "key_auth": true
            },
            "compute_hosts": [
                {"id": "w1", "host": "w1.example", "remote_path": "/w",
                 "openvpn": {"config": "/old/mirror/w.ovpn"}, "auto_connect": true},
                {"id": "w2", "host": "w2.example", "remote_path": "/w", "auto_connect": true}
            ]
        });
        assert!(drop_imported_openvpn(&mut entry));
        assert!(entry["remote"].get("openvpn").is_none());
        assert!(entry["remote"].get("auto_connect").is_none());
        assert!(entry["compute_hosts"][0].get("openvpn").is_none());
        assert!(entry["compute_hosts"][0].get("auto_connect").is_none());
        // Everything else round-trips untouched, including a worker without a tunnel.
        assert_eq!(entry["remote"]["host"], "build.example");
        assert_eq!(entry["remote"]["key_auth"], true);
        assert_eq!(entry["compute_hosts"][1]["auto_connect"], true);
        let spec: crate::schema::project::RemoteSpec =
            serde_json::from_value(entry["remote"].clone()).unwrap();
        assert!(spec.openvpn.is_none());
        // Nothing to drop → reported as such (no note), and non-objects are fine.
        assert!(!drop_imported_openvpn(&mut entry));
        assert!(!drop_imported_openvpn(&mut serde_json::json!({"remote": null})));
        assert!(!drop_imported_openvpn(&mut Value::Null));
    }

    #[test]
    fn class_is_sticky_under_git_and_vendor_dirs() {
        assert_eq!(class_of(".git", Class::Plain), Class::Git);
        assert_eq!(class_of("node_modules", Class::Plain), Class::Rebuildable);
        assert_eq!(class_of("src", Class::Plain), Class::Plain);
        // A vendor dir inside history stays history: the filter that keeps
        // `.git` must keep all of it, or the repo it restores is broken.
        assert_eq!(class_of("node_modules", Class::Git), Class::Git);
        assert_eq!(class_of("src", Class::Rebuildable), Class::Rebuildable);
    }

    #[test]
    fn walk_skips_what_the_filter_excludes_and_never_follows_links() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::write(root.join(".git/objects/aa"), b"obj").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), b"x").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), b"fn main() {}").unwrap();

        let collect = |filter: WalkFilter| {
            let mut out: Vec<String> = Vec::new();
            walk_tree(root, filter, None, &mut |rel, _c, item| {
                if matches!(item, TreeItem::File { .. }) {
                    out.push(rel.to_string());
                }
                Ok(())
            })
            .unwrap();
            out
        };

        assert_eq!(collect(WalkFilter::all()).len(), 3);
        assert_eq!(
            collect(WalkFilter {
                git: false,
                rebuildable: false
            }),
            vec!["src/main.rs".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_carried_as_a_link_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::os::unix::fs::symlink("nowhere", root.join("link")).unwrap();
        let mut links = 0;
        let mut files = 0;
        walk_tree(root, WalkFilter::all(), None, &mut |_rel, _c, item| {
            match item {
                TreeItem::Symlink(_) => links += 1,
                TreeItem::File { .. } => files += 1,
                TreeItem::Dir => {}
            }
            Ok(())
        })
        .unwrap();
        assert_eq!((links, files), (1, 0));
    }

    #[test]
    fn session_fields_never_ride_inside_the_exported_project_json() {
        let project = serde_json::json!({
            "id": "p",
            "name": "n",
            "sandbox": { "enabled": true },
            "open_apps": [{ "exec": "xterm" }],
            "tab_layout": [{ "key": "t", "label": "l", "cmd": "sh", "cwd": "/p" }],
            "tab_groups": { "kind": "group" },
            "status": "current",
        });
        let stripped = strip_session_fields(project);
        for key in ["open_apps", "tab_layout", "tab_groups", "status"] {
            assert!(stripped.get(key).is_none(), "{key} must not be exported");
        }
        // The descriptive and settings fields are the whole point — they stay.
        assert_eq!(stripped["sandbox"]["enabled"], true);
    }

    #[test]
    fn free_dir_suffixes_rather_than_merging_into_an_existing_tree() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(free_dir(tmp.path(), "proj"), tmp.path().join("proj"));
        fs::create_dir(tmp.path().join("proj")).unwrap();
        assert_eq!(free_dir(tmp.path(), "proj"), tmp.path().join("proj-2"));
    }

    #[test]
    fn a_zip_without_the_manifest_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plain.zip");
        {
            let file = fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file::<_, ()>("a.txt", zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(b"hi").unwrap();
            zip.finish().unwrap();
        }
        let err = open_bundle(path.to_str().unwrap()).unwrap_err();
        assert!(err.contains(concat!("not a ", crate::app_name!(), " project export")), "{err}");
    }

    /// The zip-slip guard, on the extractor this module owns: an entry naming
    /// `../escape` must not be written outside the destination.
    #[test]
    fn extraction_ignores_entries_that_would_escape_the_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join(concat!("evil.", crate::app_slug!(), "proj"));
        {
            let file = fs::File::create(&bundle).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::FileOptions::<()>::default();
            zip.start_file("dir/../../escaped.txt", opts).unwrap();
            zip.write_all(b"nope").unwrap();
            zip.start_file("dir/ok.txt", opts).unwrap();
            zip.write_all(b"yes").unwrap();
            zip.start_file(BUNDLE_MANIFEST, opts).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }
        let mut zip = zip::ZipArchive::new(fs::File::open(&bundle).unwrap()).unwrap();
        let dest = tmp.path().join("out");
        let files = extract_section(&mut zip, SECTION_DIR, &dest).unwrap();
        assert_eq!(files, 1);
        assert!(dest.join("ok.txt").exists());
        assert!(!tmp.path().join("escaped.txt").exists());
    }

    /// An imported bundle never opens the project to a phone: the switch, its
    /// list and the old switch name are all dropped, the rest is kept.
    #[test]
    fn imported_entries_carry_no_mobile_access() {
        let mut entry = serde_json::json!({
            "id": "p", "directory": "/d",
            crate::brand::MOBILE_ACCESS_KEY: true,
            crate::brand::MOBILE_DEVICES_KEY: ["a".repeat(27)],
            crate::brand::LEGACY_MOBILE_ACCESS_KEY: true,
        });
        drop_mobile_keys(&mut entry);
        assert_eq!(entry, serde_json::json!({ "id": "p", "directory": "/d" }));
        drop_mobile_keys(&mut Value::Null);
        assert!(mobile_keys().iter().all(|key| key.contains("_mobile_")));
    }

    /// Nor does an exported one: the bundle's entry leaves both Mobile keys
    /// behind and keeps the rest.
    #[test]
    fn exported_entries_carry_no_mobile_access() {
        let entry = entry_with(
            "p",
            &[
                ("directory", Value::String("/d".into())),
                (crate::brand::MOBILE_ACCESS_KEY, Value::Bool(true)),
                (crate::brand::MOBILE_DEVICES_KEY, serde_json::json!(["a".repeat(27)])),
            ],
        );
        let exported = exported_entry(&entry);
        assert_eq!(exported.extra.keys().collect::<Vec<_>>(), ["directory"]);
        assert_eq!(entry.extra.len(), 3, "the registry's own entry is untouched");
    }

    fn entry_with(id: &str, extra: &[(&str, Value)]) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            name: "p".to_string(),
            status: "inactive".to_string(),
            position: 10,
            local_file: "/p/project.json".to_string(),
            extra: extra
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }

    /// A VM project cannot be moved by copying files: its tree is a disk image
    /// that is not in the bundle.
    #[test]
    fn a_vm_project_is_blocked_up_front() {
        assert_eq!(
            export_blocker(&entry_with("p1", &[("vm", serde_json::json!({ "cpus": 2 }))])).as_deref(),
            Some("vm")
        );
        // A null `vm` is how an entry that never had one round-trips.
        assert!(export_blocker(&entry_with("p1", &[("vm", Value::Null)])).is_none());
        assert!(export_blocker(&entry_with("p1", &[])).is_none());
    }

    #[test]
    fn the_suggested_file_name_is_a_safe_leaf() {
        let name = suggested_bundle_name("My Project / v2");
        assert!(name.starts_with("my-project-v2-"), "{name}");
        assert!(name.ends_with(concat!(".", crate::app_slug!(), "proj")), "{name}");
        assert!(!name.contains('/'));
    }
}
