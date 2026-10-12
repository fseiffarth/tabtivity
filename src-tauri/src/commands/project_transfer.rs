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
//! agents/home|local/…  the project's agent conversations (opt-in, format 2)
//! ```
//!
//! Nothing is left out silently: every entry the walk cannot carry is named in
//! the export report and counted in the manifest.
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
//! - **Agent configuration** (hooks, MCP servers, skills, settings, logins) —
//!   only the conversation stores `services::agent_history` lists travel, and
//!   only on request.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::agent_history;

use crate::paths;
use crate::schema::projects::ProjectEntry;
use crate::schema::session::TerminalSession;
use crate::storage;
use crate::tauri_host::Ctx;

use crate::schema::project::RemoteSpec;
use crate::services::ssh_exec::shell_quote;

use super::projects::{
    conflict_message, entry_directory, entry_is_remote, entry_mirror, entry_remote_spec,
    find_project_conflict,
    next_position, projects_root, read_projects_list, remote_project_state_dir,
    resolve_remote_mirror, sanitize_name, uuid_v4, validate_project_id, ProjectSite,
};

/// Bundle format version. Bumped only for a change an older Tabtivity could not
/// read correctly; import refuses anything newer than it understands, because
/// silently dropping a section it does not know about is how a "full" export
/// stops being full without anyone noticing.
///
/// The newest format this build reads. A bundle is written in the oldest
/// format that holds what it carries ([`format_for`]): format 2 added the
/// agent-conversation section, so only a bundle carrying it is refused by a
/// build that would drop it.
pub const BUNDLE_FORMAT: u32 = 2;

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
/// The project's agent conversations: `agents/home/…` from the scope's agent
/// home, `agents/local/…` from its local-model home.
const SECTION_AGENTS: &str = "agents";
const AGENTS_HOME: &str = "home";
const AGENTS_LOCAL: &str = "local";

/// How many skipped paths an export report names; the count covers them all.
const SKIP_LIST_CAP: usize = 200;

/// How many rebuildable folders the preview lists for the dialog.
const REBUILDABLE_LIST_CAP: usize = 100;

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
///
/// A name alone proves little for most of them: a paper's `build/`, a
/// release's `dist/` or a data `target/` is the user's own work, and the
/// "skip" switch is on by default. So each name counts only with its
/// [`Proof`] — the manifest of the tool that writes the folder beside it, or
/// the marker that tool leaves inside. Whatever matched is listed in the
/// dialog, where any one folder can be carried anyway.
const REBUILDABLE_DIRS: &[(&str, Proof)] = &[
    ("node_modules", Proof::Name),
    ("__pycache__", Proof::Name),
    (".tox", Proof::Name),
    (".pytest_cache", Proof::Name),
    (".mypy_cache", Proof::Name),
    (".next", Proof::Beside(&["package.json"])),
    (".cache", Proof::Beside(&["package.json"])),
    ("target", Proof::Beside(&["Cargo.toml", "pom.xml"])),
    (
        "dist",
        Proof::Beside(&["package.json", "pyproject.toml", "setup.py", "Cargo.toml"]),
    ),
    (
        "build",
        Proof::Beside(&[
            "package.json",
            "pyproject.toml",
            "setup.py",
            "CMakeLists.txt",
            "build.gradle",
            "build.gradle.kts",
        ]),
    ),
    (".venv", Proof::Inside("pyvenv.cfg")),
    ("venv", Proof::Inside("pyvenv.cfg")),
];

/// What makes a folder from [`REBUILDABLE_DIRS`] a tool's output.
enum Proof {
    /// The name alone: nobody keeps their own work in `node_modules`.
    Name,
    /// One of these files beside it.
    Beside(&'static [&'static str]),
    /// This file inside it (`pyvenv.cfg` in a virtualenv).
    Inside(&'static str),
}

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
    /// The project's agent conversations travel (`agents/`, format 2).
    #[serde(default)]
    pub agent_history: bool,
    /// `mirror/` holds the host's own tree, streamed at export, rather than
    /// the exporting machine's mirror. Informational: import treats both alike.
    #[serde(default)]
    pub mirror_from_host: bool,
    pub files: u64,
    pub bytes: u64,
    /// Files the export could not carry (unreadable, a FIFO, too deep), so
    /// the import side can say the bundle is short rather than look whole.
    #[serde(default)]
    pub skipped: u64,
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
    /// The scope's agent home and local-model home at export time — prefixes
    /// import rewrites inside the conversations, like `directory`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_local_home: Option<String>,
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
    /// The folders behind `rebuildable_*`, biggest first (at most
    /// [`REBUILDABLE_LIST_CAP`]), so the dialog can carry one anyway.
    pub rebuildable_dirs: Vec<RebuildableDir>,
    /// Entries the walk cannot carry whatever the toggles say.
    pub skipped: u64,
    /// The project's agent conversations (`services::agent_history`).
    pub agent_history_files: u64,
    pub agent_history_bytes: u64,
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
    /// Remote projects only: carry the project's tree as `mirror/`.
    #[serde(default = "yes")]
    pub include_mirror: bool,
    /// Remote projects only: which copy of the tree `mirror/` is packed from.
    #[serde(default)]
    pub mirror_source: MirrorSource,
    #[serde(default = "yes")]
    pub skip_rebuildable: bool,
    /// Rebuildable folders (root-relative, `/`-separated, as the preview
    /// listed them) carried even though `skip_rebuildable` is on.
    #[serde(default)]
    pub keep_rebuildable: Vec<String>,
    /// Carry the agent conversations. Off unless asked: a transcript holds
    /// whatever the agents read or printed, secrets included.
    #[serde(default)]
    pub include_agent_history: bool,
}

/// A remote project's two copies of its tree: which one a bundle carries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MirrorSource {
    /// This machine's mirror — what has been synced down, as it stands.
    #[default]
    Local,
    /// The host's own tree, streamed over SSH (`tar -cf -`): the project as
    /// it is, when the mirror holds only part of it or is behind.
    Host,
}

/// The host's tree measured for the export dialog
/// ([`preview_host_export`]), shaped like the preview's counts: `files` and
/// `bytes` leave out `.git` and the folders that are always rebuildable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTally {
    pub files: u64,
    pub bytes: u64,
    pub git_files: u64,
    pub git_bytes: u64,
    pub rebuildable_files: u64,
    pub rebuildable_bytes: u64,
}

/// One rebuildable folder in the preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildableDir {
    pub path: String,
    pub files: u64,
    pub bytes: u64,
}

/// Why an entry did not make it into a bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Skip {
    /// A permission, an I/O error, or a file that vanished mid-walk.
    Unreadable,
    /// A FIFO, socket or device — reading one could block the export forever.
    Special,
    /// Deeper than [`MAX_DEPTH`].
    TooDeep,
    /// A link inside an agent home: never carried out of one.
    Link,
}

/// One entry an export left out.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub path: String,
    pub reason: Skip,
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
    /// What was left out, named (at most [`SKIP_LIST_CAP`]) …
    pub skipped: Vec<SkippedEntry>,
    /// … and counted.
    pub skipped_count: u64,
    /// Agent-conversation files carried.
    pub agent_files: u64,
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
    #[serde(default = "yes")]
    pub restore_agent_history: bool,
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
    /// Agent-conversation files restored into this project's agent homes.
    pub agent_files: u64,
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

#[derive(Debug, Clone, Default)]
struct WalkFilter {
    git: bool,
    rebuildable: bool,
    /// Rebuildable folders (root-relative) carried anyway: they and what is
    /// under them walk as `Plain`.
    keep: HashSet<String>,
}

impl WalkFilter {
    fn all() -> Self {
        Self {
            git: true,
            rebuildable: true,
            keep: Default::default(),
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
    File { size: u64, mode: u32, path: PathBuf },
    Symlink(PathBuf),
    /// Left out, and why. Visited so the export can name it.
    Skipped(Skip),
}

/// The class of `name` under a `parent` of class `parent`. `has_file` asks
/// whether a regular file of that name sits beside it; `path` is the entry
/// itself, for a [`Proof::Inside`] marker.
fn class_of(name: &str, parent: Class, path: &Path, has_file: impl Fn(&str) -> bool) -> Class {
    if parent != Class::Plain {
        return parent;
    }
    if name == ".git" {
        return Class::Git;
    }
    let proven = REBUILDABLE_DIRS
        .iter()
        .find(|(dir, _)| *dir == name)
        .is_some_and(|(_, proof)| match proof {
            Proof::Name => true,
            Proof::Beside(files) => files.iter().any(|f| has_file(f)),
            Proof::Inside(marker) => path.join(marker).is_file(),
        });
    if proven {
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
///
/// Nothing is dropped without a trace: an entry that cannot be listed, read
/// or carried is visited as [`TreeItem::Skipped`]. Only an unreadable `root`
/// fails the walk.
fn walk_tree(
    root: &Path,
    filter: &WalkFilter,
    exclude: Option<&Path>,
    visit: &mut impl FnMut(&str, Class, TreeItem) -> Result<(), String>,
) -> Result<(), String> {
    walk_in(root, "", Class::Plain, filter, exclude, 0, visit)
}

fn walk_in(
    dir: &Path,
    rel_prefix: &str,
    class: Class,
    filter: &WalkFilter,
    exclude: Option<&Path>,
    depth: usize,
    visit: &mut impl FnMut(&str, Class, TreeItem) -> Result<(), String>,
) -> Result<(), String> {
    let listing = fs::read_dir(dir).and_then(|entries| {
        entries
            .map(|entry| entry.map(|e| (e.file_name(), e.file_type())))
            .collect::<std::io::Result<Vec<_>>>()
    });
    let mut names = match listing {
        Ok(names) => names,
        Err(e) if depth == 0 => return Err(format!("read {}: {e}", dir.display())),
        Err(e) => {
            eprintln!("project_transfer: skipping {}: {e}", dir.display());
            return visit(rel_prefix, class, TreeItem::Skipped(Skip::Unreadable));
        }
    };
    names.sort_by(|a, b| a.0.cmp(&b.0));
    let has_file = |wanted: &str| {
        names
            .iter()
            .any(|(n, t)| n == wanted && t.as_ref().is_ok_and(fs::FileType::is_file))
    };

    for (os_name, file_type) in &names {
        let name = os_name.to_string_lossy().to_string();
        let path = dir.join(os_name);
        if exclude.is_some_and(|ex| ex == path) {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        let file_type = match file_type {
            Ok(t) => t,
            Err(e) => {
                eprintln!("project_transfer: skipping {}: {e}", path.display());
                visit(&rel, class, TreeItem::Skipped(Skip::Unreadable))?;
                continue;
            }
        };
        let mut child_class = if file_type.is_dir() {
            class_of(&name, class, &path, has_file)
        } else {
            class
        };
        if child_class == Class::Rebuildable && class == Class::Plain && filter.keep.contains(&rel) {
            child_class = Class::Plain;
        }
        if !filter.wants(child_class) {
            continue;
        }
        if file_type.is_symlink() {
            match fs::read_link(&path) {
                Ok(target) => visit(&rel, child_class, TreeItem::Symlink(target))?,
                Err(e) => {
                    eprintln!("project_transfer: skipping symlink {}: {e}", path.display());
                    visit(&rel, child_class, TreeItem::Skipped(Skip::Unreadable))?;
                }
            }
        } else if file_type.is_dir() {
            if depth + 1 > MAX_DEPTH {
                visit(&rel, child_class, TreeItem::Skipped(Skip::TooDeep))?;
                continue;
            }
            visit(&rel, child_class, TreeItem::Dir)?;
            walk_in(&path, &rel, child_class, filter, exclude, depth + 1, visit)?;
        } else if file_type.is_file() {
            match fs::symlink_metadata(&path) {
                Ok(meta) => visit(
                    &rel,
                    child_class,
                    TreeItem::File {
                        size: meta.len(),
                        mode: mode_of(&meta),
                        path,
                    },
                )?,
                Err(e) => {
                    eprintln!("project_transfer: skipping {}: {e}", path.display());
                    visit(&rel, child_class, TreeItem::Skipped(Skip::Unreadable))?;
                }
            }
        } else {
            // A FIFO, socket or device node: `read` on a FIFO blocks until a
            // writer appears, which would hang the export for good.
            visit(&rel, child_class, TreeItem::Skipped(Skip::Special))?;
        }
    }
    Ok(())
}

/// One file in an agent home, opened through a directory handle.
enum HistoryItem {
    File {
        file: crate::services::home_io::HomeFile,
        size: u64,
        mode: u32,
    },
    Skipped(Skip),
}

/// Walk the conversation stores (`services::agent_history::ROOTS`) of one
/// agent home, visiting home-relative paths.
///
/// A home is written by the scope's agents while this runs, so everything goes
/// through `services::home_io` handles: a folder or file an agent swaps for a
/// link to the user's real home is refused, never followed into the bundle.
/// Links are never carried out of a home at all.
fn walk_agent_history(
    home: &Path,
    visit: &mut impl FnMut(&str, HistoryItem) -> Result<(), String>,
) -> Result<(), String> {
    use crate::services::agent_history::{self, Found};
    use crate::services::home_io::{HomeDir, HomeFile};
    fn file_item(rel: &str, file: HomeFile) -> Option<HistoryItem> {
        if !agent_history::allowed(rel) {
            return None;
        }
        Some(match file.metadata() {
            Some(meta) => HistoryItem::File {
                file,
                size: meta.len,
                mode: meta.mode,
            },
            None => HistoryItem::Skipped(Skip::Unreadable),
        })
    }
    fn walk(
        dir: &HomeDir,
        rel: &str,
        depth: usize,
        visit: &mut impl FnMut(&str, HistoryItem) -> Result<(), String>,
    ) -> Result<(), String> {
        for name in dir.names() {
            let rel = format!("{rel}/{name}");
            let Some(file) = dir.file(&name) else { continue };
            let Some(meta) = file.metadata() else {
                visit(&rel, HistoryItem::Skipped(Skip::Unreadable))?;
                continue;
            };
            if meta.is_symlink {
                visit(&rel, HistoryItem::Skipped(Skip::Link))?;
            } else if meta.is_dir {
                if depth + 1 > MAX_DEPTH {
                    visit(&rel, HistoryItem::Skipped(Skip::TooDeep))?;
                    continue;
                }
                match dir.open_subdir(&name) {
                    Some(sub) => walk(&sub, &rel, depth + 1, visit)?,
                    None => visit(&rel, HistoryItem::Skipped(Skip::Unreadable))?,
                }
            } else if meta.is_file {
                // A SQLite sidecar is folded into its database's snapshot; a
                // root's configuration file stays behind.
                if let Some(item) = file_item(&rel, file) {
                    visit(&rel, item)?;
                }
            } else {
                visit(&rel, HistoryItem::Skipped(Skip::Special))?;
            }
        }
        Ok(())
    }
    agent_history::for_each_root(home, &mut |rel, found| match found {
        Found::Dir(dir) => walk(&dir, rel, 0, visit),
        Found::File(file) => match file_item(rel, file) {
            Some(item) => visit(rel, item),
            None => Ok(()),
        },
        Found::Link => visit(rel, HistoryItem::Skipped(Skip::Link)),
        Found::Special => visit(rel, HistoryItem::Skipped(Skip::Special)),
    })
}

/// The scope's agent home and its local-model home, keyed like the bundle's
/// `agents/` subsections.
fn agent_homes(project_id: &str) -> [(&'static str, PathBuf); 2] {
    use crate::services::agent_home;
    [
        (AGENTS_HOME, agent_home::scope_home(Some(project_id))),
        (
            AGENTS_LOCAL,
            agent_home::local_model_home_in(&storage::state_dir(), project_id),
        ),
    ]
}

/// Files and bytes of a project's agent conversations, for the preview.
fn tally_agent_history(project_id: &str) -> Result<(u64, u64), String> {
    let (mut files, mut bytes) = (0u64, 0u64);
    for (_, home) in agent_homes(project_id) {
        walk_agent_history(&home, &mut |_rel, item| {
            if let HistoryItem::File { size, .. } = item {
                files += 1;
                bytes += size;
            }
            Ok(())
        })?;
    }
    Ok((files, bytes))
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
    rebuildable_dirs: Vec<RebuildableDir>,
    skipped: u64,
}

fn tally(root: &Path) -> Result<SizeTally, String> {
    let mut out = SizeTally::default();
    if !root.is_dir() {
        return Ok(out);
    }
    walk_tree(root, &WalkFilter::all(), None, &mut |rel, class, item| {
        match item {
            // The walk is depth-first, so the folder a rebuildable file is
            // under is always the last one opened. Only the outermost of a
            // nest is listed: the class is sticky below it.
            TreeItem::Dir if class == Class::Rebuildable => {
                let nested = out
                    .rebuildable_dirs
                    .last()
                    .is_some_and(|top| rel.starts_with(&format!("{}/", top.path)));
                if !nested {
                    out.rebuildable_dirs.push(RebuildableDir {
                        path: rel.to_string(),
                        files: 0,
                        bytes: 0,
                    });
                }
            }
            TreeItem::File { size, .. } => match class {
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
                    if let Some(top) = out.rebuildable_dirs.last_mut() {
                        top.files += 1;
                        top.bytes += size;
                    }
                }
            },
            TreeItem::Skipped(_) => out.skipped += 1,
            _ => {}
        }
        Ok(())
    })?;
    out.rebuildable_dirs
        .sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    out.rebuildable_dirs.truncate(REBUILDABLE_LIST_CAP);
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
// `app_core::rt::try_blocking`). No `State`/`AppHandle`, so nothing binds it
// to that thread.
#[cfg_attr(feature = "desktop", tauri::command(async))]
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
    let (agent_history_files, agent_history_bytes) = if blocked.is_none() {
        tally_agent_history(&project_id)?
    } else {
        (0, 0)
    };

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
        rebuildable_dirs: counts.rebuildable_dirs,
        skipped: counts.skipped,
        agent_history_files,
        agent_history_bytes,
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

// ── The host's copy ───────────────────────────────────────────────────────

/// Rebuildable folders a name alone proves ([`Proof::Name`]): the only ones
/// the host's copy can leave out. The others need a look beside or inside the
/// folder, and a streamed archive arrives in no order that could give one —
/// so on the host they travel, which errs toward carrying too much.
fn name_proof_dirs() -> impl Iterator<Item = &'static str> {
    REBUILDABLE_DIRS
        .iter()
        .filter(|(_, proof)| matches!(proof, Proof::Name))
        .map(|(name, _)| *name)
}

/// The shell program that measures the host's tree, run in the project's
/// remote directory. Built only from constants ([`name_proof_dirs`]), as
/// `run_remote_script` requires. Sizes are apparent bytes where `du -b`
/// exists (GNU), 1 KiB blocks elsewhere (BSD, macOS).
fn host_probe_script() -> String {
    let names = name_proof_dirs()
        .map(|name| format!("-name {}", shell_quote(name)))
        .collect::<Vec<_>>()
        .join(" -o ");
    let pick = format!(r"find . -path ./.git -prune -o \( {names} \) -type d -prune");
    format!(
        r#"if du -sb /dev/null >/dev/null 2>&1; then DU='du -sb'; M=1; else DU='du -sk'; M=1024; fi
total() {{ awk -v m="$M" '{{s+=$1}} END {{printf "%.0f\n", s*m}}'; }}
echo "files $(find . -type f 2>/dev/null | wc -l)"
echo "bytes $($DU . 2>/dev/null | total)"
if [ -d .git ]; then
  echo "gitFiles $(find ./.git -type f 2>/dev/null | wc -l)"
  echo "gitBytes $($DU .git 2>/dev/null | total)"
fi
echo "rebuildableFiles $({pick} -exec find {{}} -type f \; 2>/dev/null | wc -l)"
echo "rebuildableBytes $({pick} -exec $DU {{}} + 2>/dev/null | total)"
"#
    )
}

/// [`host_probe_script`]'s output as the preview's counts: the whole tree's
/// figures less `.git` and the rebuildable folders, which are given apart.
fn parse_host_probe(out: &str) -> HostTally {
    let mut values: HashMap<&str, u64> = HashMap::new();
    for line in out.lines() {
        if let Some((key, value)) = line.trim().split_once(' ') {
            if let Ok(n) = value.trim().parse() {
                values.insert(key, n);
            }
        }
    }
    let get = |key: &str| values.get(key).copied().unwrap_or(0);
    let (git_files, git_bytes) = (get("gitFiles"), get("gitBytes"));
    let (rebuildable_files, rebuildable_bytes) = (get("rebuildableFiles"), get("rebuildableBytes"));
    HostTally {
        files: get("files").saturating_sub(git_files + rebuildable_files),
        bytes: get("bytes").saturating_sub(git_bytes + rebuildable_bytes),
        git_files,
        git_bytes,
        rebuildable_files,
        rebuildable_bytes,
    }
}

/// The primary host of a remote project.
fn host_spec(entry: &ProjectEntry) -> Result<RemoteSpec, String> {
    if !entry_is_remote(entry) {
        return Err("This project has no host.".to_string());
    }
    entry_remote_spec(entry).ok_or_else(|| "This project's host is not set.".to_string())
}

/// The last few lines of what a host printed on failure, for an error message.
fn stderr_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(3)..].join(" ")
}

fn host_tally(spec: &RemoteSpec) -> Result<HostTally, String> {
    let out = crate::services::ssh_exec::run_remote_script(spec, &host_probe_script())?;
    if !out.status.success() {
        let tail = stderr_tail(&String::from_utf8_lossy(&out.stderr));
        return Err(if tail.is_empty() {
            "the host did not answer".to_string()
        } else {
            tail
        });
    }
    Ok(parse_host_probe(&String::from_utf8_lossy(&out.stdout)))
}

/// The host's tree measured, for the export dialog's "the host's copy". Its
/// own command so the ordinary preview never dials: the dialog asks only once
/// that copy is picked, and only while the project is connected.
#[cfg_attr(feature = "desktop", tauri::command(async))]
pub fn preview_host_export(project_id: String) -> Result<HostTally, String> {
    validate_project_id(&project_id)?;
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let spec = host_spec(entry)?;
    // Always a gesture: only the dialog calls this, when the user picks the
    // host's copy.
    let _dial = crate::services::ssh_common::user_dial(&spec.user, &spec.host, spec.port);
    host_tally(&spec)
}

/// A host path from an archive as a bundle-relative one: `./` and a trailing
/// `/` dropped; `None` for the root itself and for anything that could step
/// outside it.
fn host_rel(path: &str) -> Option<String> {
    let mut rel = path;
    while let Some(rest) = rel.strip_prefix("./") {
        rel = rest;
    }
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() || rel == "." || rel.starts_with('/') {
        return None;
    }
    if rel.split('/').any(|c| c.is_empty() || c == "." || c == "..") {
        return None;
    }
    Some(rel.to_string())
}

/// Whether the filter leaves `rel` out of the host's copy: under (or being)
/// a `.git` folder or an always-rebuildable one.
fn host_excluded(rel: &str, is_dir: bool, filter: &WalkFilter) -> bool {
    let comps: Vec<&str> = rel.split('/').collect();
    let dirs = if is_dir { &comps[..] } else { &comps[..comps.len() - 1] };
    dirs.iter().any(|c| {
        (!filter.git && *c == ".git") || (!filter.rebuildable && name_proof_dirs().any(|n| n == *c))
    })
}

/// What a host's `tar` said it could not carry, from its stderr (GNU and
/// bsdtar both write `tar: <path>: <why>`).
fn tar_complaints(stderr: &str) -> Vec<(String, Skip)> {
    const UNREADABLE: &[&str] = &[
        "Cannot open",
        "Couldn't open",
        "Cannot read",
        "Couldn't read",
        "Cannot stat",
        "Couldn't stat",
        "Cannot savedir",
        "Permission denied",
    ];
    stderr
        .lines()
        .filter_map(|line| {
            let (path, why) = line.strip_prefix("tar: ")?.split_once(": ")?;
            let reason = if why.contains("socket ignored") {
                Skip::Special
            } else if UNREADABLE.iter().any(|m| why.contains(m)) {
                Skip::Unreadable
            } else {
                return None;
            };
            Some((host_rel(path)?, reason))
        })
        .collect()
}

/// What streaming the host's tree into a bundle carried and left out.
#[derive(Debug, Default)]
struct HostPack {
    files: u64,
    bytes: u64,
    skipped: Vec<(String, Skip)>,
}

/// A child process killed and reaped when the export stops reading it.
struct Reaped(std::process::Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Stream the host's tree into the bundle as `mirror/`: one `tar -cf -` over
/// SSH, read as it arrives, nothing landing on this machine's disk but the
/// bundle. `.git` and the always-rebuildable folders are left out on the host
/// when the filter says so (and again here, for a nested one). A connection
/// that breaks mid-archive fails the export; a file the host's `tar` could not
/// read is named in the report like any other.
fn pack_host_tree(
    zip: &mut zip::ZipWriter<&mut fs::File>,
    spec: &RemoteSpec,
    filter: &WalkFilter,
    progress: &mut dyn FnMut(u64),
) -> Result<HostPack, String> {
    use std::io::Read;
    use std::process::Stdio;

    crate::services::ssh_common::validate_arg("remote path", &spec.remote_path)?;
    let mut command = format!("cd {} && tar -cf -", shell_quote(&spec.remote_path));
    if !filter.git {
        command.push_str(" --exclude=./.git");
    }
    if !filter.rebuildable {
        for name in name_proof_dirs() {
            command.push_str(&format!(" --exclude={}", shell_quote(name)));
        }
    }
    command.push_str(" .");
    let mut args = crate::services::ssh_common::ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(command);
    let mut child = Reaped(
        crate::paths::command_no_window("ssh")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to run ssh: {e}"))?,
    );
    let mut stderr = child.0.stderr.take().ok_or("ssh has no stderr")?;
    // Read apart from stdout, so a host printing many warnings never blocks
    // the archive behind a full pipe; kept to its first 256 KiB.
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = (&mut stderr).take(256 * 1024).read_to_string(&mut text);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        text
    });
    let stdout = child.0.stdout.take().ok_or("ssh has no stdout")?;
    let (mut pack, failure) = pack_tar(
        zip,
        std::io::BufReader::with_capacity(256 * 1024, stdout),
        filter,
        progress,
    )?;
    let status = child.0.wait().map_err(|e| format!("ssh: {e}"))?;
    let errors = errors.join().unwrap_or_default();
    let fail = |why: &str| {
        let tail = stderr_tail(&errors);
        if tail.is_empty() {
            format!("Could not pack the host's copy: {why}")
        } else {
            format!("Could not pack the host's copy: {why} ({tail})")
        }
    };
    if let Some(why) = failure {
        return Err(fail(&why));
    }
    // 255 is ssh's own failure; anything else is `tar` finishing with
    // warnings, which are read below.
    if status.code() == Some(255) {
        return Err(fail("the connection failed"));
    }
    for (path, reason) in tar_complaints(&errors) {
        if !pack.skipped.iter().any(|(p, _)| *p == path) {
            pack.skipped.push((path, reason));
        }
    }
    Ok(pack)
}

/// Read one archive into the bundle as `mirror/` — [`pack_host_tree`]'s
/// half that knows nothing of SSH. `Err` for a failing bundle; a broken
/// archive is the second value, so the caller can say why with the host's
/// own words beside it.
fn pack_tar(
    zip: &mut zip::ZipWriter<&mut fs::File>,
    archive: impl std::io::Read,
    filter: &WalkFilter,
    progress: &mut dyn FnMut(u64),
) -> Result<(HostPack, Option<String>), String> {
    use crate::services::tar_stream::{Kind, TarReader};
    let mut tar = TarReader::new(archive);
    let mut pack = HostPack::default();
    let mut links: Vec<(String, String)> = Vec::new();
    let mut carried: HashSet<String> = HashSet::new();
    let mut pruned: Vec<String> = Vec::new();
    let mut failure: Option<String> = None;
    loop {
        let header = match tar.next_header() {
            Ok(Some(header)) => header,
            Ok(None) => break,
            Err(e) => {
                failure = Some(e.to_string());
                break;
            }
        };
        let Some(rel) = host_rel(&header.path) else {
            continue;
        };
        if pruned.iter().any(|p| rel.starts_with(p.as_str())) {
            continue;
        }
        let is_dir = header.kind == Kind::Dir;
        if host_excluded(&rel, is_dir, filter) {
            if is_dir {
                pruned.push(format!("{rel}/"));
            }
            continue;
        }
        if rel.matches('/').count() + usize::from(is_dir) > MAX_DEPTH {
            if is_dir {
                pruned.push(format!("{rel}/"));
            }
            pack.skipped.push((rel, Skip::TooDeep));
            continue;
        }
        let name = format!("{SECTION_MIRROR}/{rel}");
        match header.kind {
            Kind::Dir => zip
                .add_directory(format!("{name}/"), dir_options())
                .map_err(|e| format!("zip {name}: {e}"))?,
            Kind::File => {
                let copied = zip_copy(zip, &name, tar.content(header.size), header.size, header.mode)?;
                if copied != Some(header.size) {
                    failure = Some(format!("{rel} ended early"));
                    break;
                }
                carried.insert(rel);
                pack.files += 1;
                pack.bytes += header.size;
                if pack.files.is_multiple_of(64) {
                    progress(pack.files);
                }
            }
            Kind::Symlink(target) => links.push((name, target)),
            // The earlier member's bytes are already in the bundle: copied
            // from there, not sent twice.
            Kind::HardLink(target) => match host_rel(&target).filter(|t| carried.contains(t)) {
                Some(target) => match zip.deep_copy_file(&format!("{SECTION_MIRROR}/{target}"), &name) {
                    Ok(()) => {
                        carried.insert(rel);
                        pack.files += 1;
                    }
                    Err(e) => {
                        eprintln!("project_transfer: hard link {rel}: {e}");
                        pack.skipped.push((rel, Skip::Unreadable));
                    }
                },
                None => pack.skipped.push((rel, Skip::Unreadable)),
            },
            Kind::Special => pack.skipped.push((rel, Skip::Special)),
        }
    }
    // Links last, as in a local walk: a link entry ahead of a file whose path
    // runs through it would have the extractor follow it.
    for (name, target) in links {
        zip.add_symlink(&name, &target, link_options())
            .map_err(|e| format!("zip symlink {name}: {e}"))?;
    }
    progress(pack.files);
    Ok((pack, failure))
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
        keep: req.keep_rebuildable.iter().cloned().collect(),
    };

    // ── Sections to write ───────────────────────────────────────────────
    // A local project: its folder. A remote project: the allowlisted state dir
    // plus (optionally) the local mirror.
    let mut sections: Vec<(&str, PathBuf)> = Vec::new();
    // The host's copy, when that is the tree asked for: streamed, not walked.
    let mut host_mirror: Option<RemoteSpec> = None;
    if remote {
        if let Some(dir) = &directory {
            sections.push((SECTION_STATE, PathBuf::from(dir)));
        }
        if req.include_mirror {
            match (req.mirror_source, mirror.as_deref()) {
                (MirrorSource::Host, _) => host_mirror = Some(host_spec(&entry)?),
                (MirrorSource::Local, Some(m)) if Path::new(m).is_dir() => {
                    sections.push((SECTION_MIRROR, PathBuf::from(m)))
                }
                (MirrorSource::Local, Some(_)) => notes.push("mirrorMissing".to_string()),
                (MirrorSource::Local, None) => {}
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
    let homes = agent_homes(&req.project_id);
    // A gesture: the user pressed Export with the host's copy picked.
    let _dial = host_mirror
        .as_ref()
        .map(|spec| crate::services::ssh_common::user_dial(&spec.user, &spec.host, spec.port));

    // ── Count first, so progress has a denominator ──────────────────────
    let mut total: u64 = 0;
    if let Some(spec) = &host_mirror {
        // Also the check that the host answers, before a byte is written.
        let tally = host_tally(spec).map_err(|e| format!("Could not reach the host: {e}"))?;
        total += tally.files
            + if req.include_git { tally.git_files } else { 0 }
            + if req.skip_rebuildable { 0 } else { tally.rebuildable_files };
    }
    for (section, root) in &sections {
        if *section == SECTION_STATE {
            total += REMOTE_STATE_FILES
                .iter()
                .filter(|f| root.join(f).is_file())
                .count() as u64;
            continue;
        }
        walk_tree(root, &filter, Some(&dest_abs), &mut |_rel, _class, item| {
            if matches!(item, TreeItem::File { .. }) {
                total += 1;
            }
            Ok(())
        })?;
    }
    if req.include_agent_history {
        for (_, home) in &homes {
            walk_agent_history(home, &mut |_rel, item| {
                if matches!(item, HistoryItem::File { .. }) {
                    total += 1;
                }
                Ok(())
            })?;
        }
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

    let home_path = |key: &str| {
        req.include_agent_history
            .then(|| homes.iter().find(|(k, _)| *k == key))
            .flatten()
            .map(|(_, home)| home.to_string_lossy().to_string())
    };
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
        agent_home: home_path(AGENTS_HOME),
        agent_local_home: home_path(AGENTS_LOCAL),
        contents: BundleContents {
            dir: sections.iter().any(|(s, _)| *s == SECTION_DIR),
            state: sections.iter().any(|(s, _)| *s == SECTION_STATE),
            mirror: sections.iter().any(|(s, _)| *s == SECTION_MIRROR) || host_mirror.is_some(),
            mirror_from_host: host_mirror.is_some(),
            git_history: req.include_git,
            rebuildable_skipped: req.skip_rebuildable,
            agent_history: false,
            files: 0,
            bytes: 0,
            skipped: 0,
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
    let mut agent_files: u64 = 0;
    let mut skipped: Vec<SkippedEntry> = Vec::new();
    let mut skipped_count: u64 = 0;
    let mut skip = |path: &str, reason: Skip| {
        skipped_count += 1;
        if skipped.len() < SKIP_LIST_CAP {
            skipped.push(SkippedEntry {
                path: path.to_string(),
                reason,
            });
        }
    };
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
            walk_tree(root, &filter, Some(&dest_abs), &mut |rel, _class, item| {
                let name = format!("{section}/{rel}");
                match item {
                    TreeItem::Dir => zip
                        .add_directory(format!("{name}/"), dir_options())
                        .map_err(|e| format!("zip {name}: {e}"))?,
                    TreeItem::Symlink(target) => links.push((name, target)),
                    TreeItem::Skipped(reason) => skip(rel, reason),
                    TreeItem::File { mode, path, .. } => {
                        // `open_regular`: never through a link swapped in since
                        // the walk saw a file, never blocking on a FIFO. An
                        // agent can rewrite the tree while this runs.
                        match crate::services::home_io::open_regular(&path) {
                            Some(file) => match zip_stream(&mut zip, &name, file, mode)? {
                                Some(size) => {
                                    written_files += 1;
                                    written_bytes += size;
                                    if written_files.is_multiple_of(64) {
                                        progress(written_files, total);
                                    }
                                }
                                None => skip(rel, Skip::Unreadable),
                            },
                            // One unreadable file (a permission, a file deleted
                            // mid-walk) must not throw away the whole export —
                            // but it is named in the report, not just logged.
                            None => {
                                eprintln!("project_transfer: skipping {}", path.display());
                                skip(rel, Skip::Unreadable);
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

        if let Some(spec) = &host_mirror {
            let base = written_files;
            let pack = pack_host_tree(&mut zip, spec, &filter, &mut |n| progress(base + n, total))?;
            written_files += pack.files;
            written_bytes += pack.bytes;
            for (path, reason) in pack.skipped {
                skip(&path, reason);
            }
        }

        if req.include_agent_history {
            for (key, home) in &homes {
                walk_agent_history(home, &mut |rel, item| {
                    match item {
                        HistoryItem::Skipped(reason) => skip(rel, reason),
                        HistoryItem::File { file, mode, .. } => {
                            let name = format!("{SECTION_AGENTS}/{key}/{rel}");
                            // A database goes in as a consistent, stripped
                            // snapshot, held until its bytes are written.
                            let (source, _snapshot) = match agent_history_source(&file, rel) {
                                Some((read, snap)) => (Some(read), snap),
                                None => (None, None),
                            };
                            match source {
                                Some(read) => match zip_stream(&mut zip, &name, read, mode)? {
                                    Some(size) => {
                                        written_files += 1;
                                        written_bytes += size;
                                        agent_files += 1;
                                        if written_files.is_multiple_of(64) {
                                            progress(written_files, total);
                                        }
                                    }
                                    None => skip(rel, Skip::Unreadable),
                                },
                                None => skip(rel, Skip::Unreadable),
                            }
                        }
                    }
                    Ok(())
                })?;
            }
            manifest.contents.agent_history = true;
        }

        manifest.contents.files = written_files;
        manifest.contents.bytes = written_bytes;
        manifest.contents.skipped = skipped_count;
        manifest.format = format_for(&manifest.contents);
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
        skipped,
        skipped_count,
        agent_files,
    })
}

/// What an agent-history file is read from: the file itself, or — for a
/// database — a snapshot ([`agent_history::snapshot_for_export`]) kept alive
/// beside it. `None` when it cannot be read.
fn agent_history_source(
    file: &crate::services::home_io::HomeFile,
    rel: &str,
) -> Option<(fs::File, Option<agent_history::Snapshot>)> {
    if !agent_history::is_database(rel) {
        return file.open_read().map(|read| (read, None));
    }
    match agent_history::snapshot_for_export(file, rel) {
        Ok(snap) => snap.open().ok().map(|read| (read, Some(snap))),
        // A `.db` that is not SQLite at all is an ordinary file.
        Err(_) if !agent_history::looks_like_sqlite(file) => file.open_read().map(|read| (read, None)),
        Err(e) => {
            eprintln!("project_transfer: snapshot of {rel}: {e}");
            None
        }
    }
}

/// The oldest bundle format that holds `contents` — so a bundle without the
/// sections a format added stays readable by the builds before it.
fn format_for(contents: &BundleContents) -> u32 {
    if contents.agent_history {
        2
    } else {
        1
    }
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

/// Copy an opened file into the bundle as `name` without holding it in
/// memory — a multi-gigabyte data file must not need that much RAM.
/// `Ok(Some(bytes))` when written; `Ok(None)` when reading the source failed
/// partway, in which case the half-written entry is taken back out and the
/// caller reports the file as skipped. `Err` only for a failing bundle.
fn zip_stream(
    zip: &mut zip::ZipWriter<&mut fs::File>,
    name: &str,
    source: fs::File,
    mode: u32,
) -> Result<Option<u64>, String> {
    // The opened handle's size, not the walk's: the file may have changed.
    let size = source.metadata().map(|m| m.len()).unwrap_or(0);
    zip_copy(zip, name, source, size, mode)
}

/// [`zip_stream`] from any reader; `size` only decides whether the entry
/// needs zip64.
fn zip_copy(
    zip: &mut zip::ZipWriter<&mut fs::File>,
    name: &str,
    mut source: impl std::io::Read,
    size: u64,
    mode: u32,
) -> Result<Option<u64>, String> {
    let options = zip::write::FileOptions::<()>::default()
        .unix_permissions(if mode == 0 { 0o644 } else { mode })
        .large_file(size >= u32::MAX as u64);
    zip.start_file(name, options)
        .map_err(|e| format!("zip {name}: {e}"))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut copied: u64 = 0;
    loop {
        let n = match std::io::Read::read(&mut source, &mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                eprintln!("project_transfer: reading {name}: {e}");
                zip.abort_file().map_err(|e| format!("zip {name}: {e}"))?;
                return Ok(None);
            }
        };
        zip.write_all(&buf[..n])
            .map_err(|e| format!("zip {name}: {e}"))?;
        copied += n as u64;
    }
    Ok(Some(copied))
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn export_project(
    ctx: Ctx,
    req: ExportProjectRequest,
) -> Result<ExportReport, String> {
    let project_id = req.project_id.clone();
    app_core::rt::try_blocking("export", move || {
        let emit = |phase: &str, done: u64, total: u64| {
            ctx.emit(
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
#[cfg_attr(feature = "desktop", tauri::command(async))]
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

/// Windows: a directory link or a file link by what the target is, judged
/// against the link's own folder (a relative target is relative to it). An
/// account without the symlink privilege (os error 1314,
/// `ERROR_PRIVILEGE_NOT_HELD`) still gets a directory link, as a junction
/// to the resolved target; a file link stays a reported gap. A target the
/// archive spelled with `/` is written with `\`, which is what a relative
/// Windows link needs to resolve.
#[cfg(windows)]
fn make_symlink(target: &str, at: &Path) -> std::io::Result<()> {
    let target = windows_link_target(target);
    let resolved = at.parent().map(|dir| dir.join(&target)).unwrap_or_else(|| PathBuf::from(&target));
    if !resolved.is_dir() {
        return std::os::windows::fs::symlink_file(&target, at);
    }
    match std::os::windows::fs::symlink_dir(&target, at) {
        Err(e) if e.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) => {
            let absolute = resolved.canonicalize().unwrap_or(resolved);
            crate::services::win_links::make_junction(&absolute, at)
        }
        other => other,
    }
}

#[cfg(windows)]
const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;

/// A link target from the archive in Windows spelling.
#[cfg(any(windows, test))]
fn windows_link_target(target: &str) -> String {
    target.replace('/', "\\")
}

#[cfg(not(any(unix, windows)))]
fn make_symlink(_target: &str, _at: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("no links on this platform"))
}

/// Restore a bundle's agent conversations (`agents/…`) into project `id`'s
/// agent homes, with every path the old machine wrote re-pointed: inside each
/// file and database, and in the name of each folder a CLI files a project's
/// sessions under ([`agent_history::repoint_rel`]).
///
/// Only regular files `agent_history::allowed` names are written — never a
/// link, never anything a CLI would run — through `home_io` handles, and a
/// file already in the home is kept rather than overwritten. A database is
/// stripped to its conversation tables again on the way in.
fn import_agent_history(
    zip: &mut Bundle,
    id: &str,
    rewrites: &[(String, String)],
) -> Result<u64, String> {
    use crate::services::home_io::HomeDir;
    let homes = agent_homes(id);
    crate::services::agent_home::create_private_dir(&crate::services::agent_home::homes_root())
        .map_err(|e| e.to_string())?;
    let mut files: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() || entry.is_symlink() || entry.enclosed_name().is_none() {
            continue;
        }
        let name = entry.name().to_string();
        let Some((key, rel)) = name
            .strip_prefix(&format!("{SECTION_AGENTS}/"))
            .and_then(|rest| rest.split_once('/'))
        else {
            continue;
        };
        let Some((_, home)) = homes.iter().find(|(k, _)| *k == key) else {
            continue;
        };
        if !agent_history::allowed(rel) {
            continue;
        }
        let database = agent_history::is_database(rel);
        let target_rel = agent_history::repoint_rel(rel, rewrites);
        let Some((parent, leaf)) = target_rel.rsplit_once('/') else {
            continue;
        };
        let Some(target) = HomeDir::open(home, parent).and_then(|dir| dir.file(leaf)) else {
            continue;
        };
        if target.exists() {
            continue;
        }
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(entry, agent_history::MAX_FILE + 1),
            &mut bytes,
        )
        .map_err(|e| format!("read {name}: {e}"))?;
        if bytes.len() as u64 > agent_history::MAX_FILE {
            eprintln!("project_transfer: {name} is over the size cap; not restored");
            continue;
        }
        let snapshot = if database {
            match agent_history::prepare_for_import(&bytes[..], rel, rewrites) {
                Ok(snapshot) => snapshot,
                Err(e) => {
                    eprintln!("project_transfer: {name}: {e}; not restored");
                    continue;
                }
            }
        } else {
            None
        };
        let bytes = match snapshot {
            Some(snap) => fs::read(&snap.path).map_err(|e| format!("read {name}: {e}"))?,
            None => agent_history::rewrite_file(rel, bytes, rewrites),
        };
        target
            .write(&bytes)
            .map_err(|e| format!("write {}: {e}", target.path().display()))?;
        files += 1;
    }
    Ok(files)
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

    let mut agent_files: u64 = 0;
    if req.restore_agent_history && manifest.contents.agent_history {
        let homes = agent_homes(&id);
        let home_of = |key: &str| {
            homes
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, home)| home.to_string_lossy().to_string())
        };
        let rewrites: Vec<(String, String)> = [
            (manifest.directory.clone(), Some(new_dir.clone())),
            (manifest.mirror.clone(), mirror.clone()),
            (manifest.agent_home.clone(), home_of(AGENTS_HOME)),
            (manifest.agent_local_home.clone(), home_of(AGENTS_LOCAL)),
        ]
        .into_iter()
        .filter_map(|(old, new)| Some((old?, new?)))
        .filter(|(old, new)| !old.is_empty() && old != new)
        .collect();
        // The project is registered by now: a conversation that fails to land
        // is a reported gap, not a failed import of everything else.
        match import_agent_history(&mut zip, &id, &rewrites) {
            Ok(n) => agent_files = n,
            Err(e) => {
                eprintln!("project_transfer: agent conversations: {e}");
                notes.push("agentHistoryFailed".to_string());
            }
        }
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
        agent_files,
        notes,
    })
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn import_project_export(
    req: ImportBundleRequest,
) -> Result<ImportBundleResult, String> {
    app_core::rt::try_blocking("import", move || import_project_export_blocking(req)).await
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
        let nowhere = Path::new("/nonexistent-dir");
        let none = |_: &str| false;
        assert_eq!(class_of(".git", Class::Plain, nowhere, none), Class::Git);
        assert_eq!(class_of("node_modules", Class::Plain, nowhere, none), Class::Rebuildable);
        assert_eq!(class_of("src", Class::Plain, nowhere, none), Class::Plain);
        // A vendor dir inside history stays history: the filter that keeps
        // `.git` must keep all of it, or the repo it restores is broken.
        assert_eq!(class_of("node_modules", Class::Git, nowhere, none), Class::Git);
        assert_eq!(class_of("src", Class::Rebuildable, nowhere, none), Class::Rebuildable);
    }

    #[test]
    fn an_ambiguous_build_folder_is_rebuildable_only_with_its_tool_beside_it() {
        let nowhere = Path::new("/nonexistent-dir");
        let none = |_: &str| false;
        // A paper's `build/`, a release's `dist/`, a data `target/`: the user's.
        for name in ["build", "dist", "target", ".cache", "venv", ".venv"] {
            assert_eq!(class_of(name, Class::Plain, nowhere, none), Class::Plain, "{name}");
        }
        let npm = |f: &str| f == "package.json";
        assert_eq!(class_of("dist", Class::Plain, nowhere, npm), Class::Rebuildable);
        assert_eq!(class_of("build", Class::Plain, nowhere, npm), Class::Rebuildable);
        assert_eq!(class_of("target", Class::Plain, nowhere, npm), Class::Plain);
        let cargo = |f: &str| f == "Cargo.toml";
        assert_eq!(class_of("target", Class::Plain, nowhere, cargo), Class::Rebuildable);

        let tmp = tempfile::tempdir().unwrap();
        let venv = tmp.path().join("venv");
        fs::create_dir_all(&venv).unwrap();
        assert_eq!(class_of("venv", Class::Plain, &venv, none), Class::Plain);
        fs::write(venv.join("pyvenv.cfg"), b"home = /usr/bin").unwrap();
        assert_eq!(class_of("venv", Class::Plain, &venv, none), Class::Rebuildable);
    }

    #[test]
    fn a_kept_rebuildable_folder_travels_and_the_preview_lists_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("package.json"), b"{}").unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/app.js"), b"12345").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg/node_modules")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), b"1234567890").unwrap();
        fs::write(root.join("node_modules/pkg/node_modules/x.js"), b"1").unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build/paper.pdf"), b"pdf").unwrap();

        let counts = tally(root).unwrap();
        // Only the outermost of a nest is listed, biggest first.
        let listed: Vec<(&str, u64)> = counts
            .rebuildable_dirs
            .iter()
            .map(|d| (d.path.as_str(), d.bytes))
            .collect();
        assert_eq!(listed, vec![("node_modules", 11), ("dist", 5), ("build", 3)]);

        let filter = WalkFilter {
            git: true,
            rebuildable: false,
            keep: ["dist".to_string()].into_iter().collect(),
        };
        let mut files: Vec<String> = Vec::new();
        walk_tree(root, &filter, None, &mut |rel, _c, item| {
            if matches!(item, TreeItem::File { .. }) {
                files.push(rel.to_string());
            }
            Ok(())
        })
        .unwrap();
        // `build/` is a tool's here (package.json beside it) and stays out;
        // `dist/` was asked for by name.
        assert_eq!(files, vec!["dist/app.js".to_string(), "package.json".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_or_an_over_deep_folder_is_reported_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let fifo = std::ffi::CString::new(root.join("pipe").to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a valid C string.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let mut deep = root.to_path_buf();
        for _ in 0..=MAX_DEPTH {
            deep.push("d");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("lost.txt"), b"x").unwrap();

        let mut skipped: Vec<(String, Skip)> = Vec::new();
        walk_tree(root, &WalkFilter::all(), None, &mut |rel, _c, item| {
            if let TreeItem::Skipped(reason) = item {
                skipped.push((rel.to_string(), reason));
            }
            Ok(())
        })
        .unwrap();
        assert!(skipped.contains(&("pipe".to_string(), Skip::Special)));
        assert!(skipped.iter().any(|(_, r)| *r == Skip::TooDeep));
    }

    #[test]
    fn a_host_path_is_kept_inside_the_tree() {
        assert_eq!(host_rel("./src/main.rs").as_deref(), Some("src/main.rs"));
        assert_eq!(host_rel("././a/").as_deref(), Some("a"));
        for bad in ["./", ".", "/etc/passwd", "./a/../../x", "a//b", ""] {
            assert_eq!(host_rel(bad), None, "{bad}");
        }
        let skip_all = WalkFilter {
            git: false,
            rebuildable: false,
            keep: Default::default(),
        };
        assert!(host_excluded("sub/.git", true, &skip_all));
        assert!(host_excluded("sub/.git/HEAD", false, &skip_all));
        assert!(!host_excluded("sub/.git", false, &skip_all), "a submodule's .git file travels");
        assert!(host_excluded("web/node_modules/x.js", false, &skip_all));
        assert!(!host_excluded("build/out", false, &skip_all), "a name alone does not prove build/");
        assert!(!host_excluded("sub/.git/HEAD", false, &WalkFilter::all()));
    }

    #[test]
    fn what_the_hosts_tar_could_not_read_is_named() {
        let stderr = "tar: ./secret.key: Cannot open: Permission denied\n\
                      tar: ./run/app.sock: socket ignored\n\
                      tar: locked: Couldn't open locked: Permission denied\n\
                      tar: ./log.txt: file changed as we read it\n\
                      tar: Exiting with failure status due to previous errors\n";
        assert_eq!(
            tar_complaints(stderr),
            vec![
                ("secret.key".to_string(), Skip::Unreadable),
                ("run/app.sock".to_string(), Skip::Special),
                ("locked".to_string(), Skip::Unreadable),
            ]
        );
        assert_eq!(stderr_tail(stderr).matches("tar:").count(), 3);
    }

    #[test]
    fn the_host_probe_output_reads_like_the_preview() {
        let tally = parse_host_probe(
            "files 120\nbytes 9000\ngitFiles 40\ngitBytes 3000\nrebuildableFiles 50\nrebuildableBytes 4000\n",
        );
        assert_eq!(
            tally,
            HostTally {
                files: 30,
                bytes: 2000,
                git_files: 40,
                git_bytes: 3000,
                rebuildable_files: 50,
                rebuildable_bytes: 4000,
            }
        );
        // BSD `wc -l` pads its count.
        assert_eq!(parse_host_probe("files       7\n").files, 7);
    }

    /// The tree both host tests below run on: plain files, a `.git`, an
    /// always-rebuildable folder, a `build/` without its tool, a link and a
    /// hard link.
    #[cfg(unix)]
    fn host_like_tree(root: &Path) {
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("main.rs"), b"fn main() {}\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("HEAD"), b"ref: refs/heads/main\n").unwrap();
        fs::create_dir_all(root.join("web").join("node_modules")).unwrap();
        fs::write(root.join("web").join("node_modules").join("x.js"), b"x();\n").unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build").join("paper.pdf"), b"%PDF").unwrap();
        std::os::unix::fs::symlink("src/main.rs", root.join("link")).unwrap();
        fs::hard_link(root.join("src").join("main.rs"), root.join("again.rs")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_host_probe_script_measures_a_real_tree() {
        let tmp = tempfile::tempdir().unwrap();
        host_like_tree(tmp.path());
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(host_probe_script())
            .current_dir(tmp.path())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let tally = parse_host_probe(&String::from_utf8_lossy(&out.stdout));
        assert_eq!(tally.git_files, 1);
        assert_eq!(tally.rebuildable_files, 1);
        // main.rs, again.rs, build/paper.pdf (`find -type f` skips the link).
        assert_eq!(tally.files, 3);
        assert!(tally.git_bytes >= 21 && tally.rebuildable_bytes >= 5);
    }

    #[cfg(unix)]
    #[test]
    fn a_hosts_archive_is_packed_like_a_walked_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let tree = tmp.path().join("tree");
        host_like_tree(&tree);
        let archive = match std::process::Command::new("tar")
            .args(["-cf", "-", "."])
            .current_dir(&tree)
            .output()
        {
            Ok(out) if out.status.success() => out.stdout,
            _ => {
                eprintln!("no usable tar here; skipped");
                return;
            }
        };
        let bundle = tmp.path().join("b.zip");
        // Read-write, like the staged bundle: a hard link is copied back out of it.
        let mut file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&bundle).unwrap();
        let filter = WalkFilter {
            git: false,
            rebuildable: false,
            keep: Default::default(),
        };
        let mut seen = 0;
        {
            let mut zip = zip::ZipWriter::new(&mut file);
            let (pack, failure) = pack_tar(&mut zip, &archive[..], &filter, &mut |n| seen = n).unwrap();
            assert_eq!(failure, None);
            assert!(pack.skipped.is_empty(), "{:?}", pack.skipped);
            assert_eq!(pack.files, 3);
            zip.finish().unwrap();
        }
        assert_eq!(seen, 3);
        let mut zip = zip::ZipArchive::new(fs::File::open(&bundle).unwrap()).unwrap();
        let names: Vec<String> = zip.file_names().map(str::to_string).collect();
        for want in ["mirror/src/main.rs", "mirror/again.rs", "mirror/build/paper.pdf", "mirror/link"] {
            assert!(names.iter().any(|n| n == want), "{want} missing from {names:?}");
        }
        assert!(!names.iter().any(|n| n.contains(".git") || n.contains("node_modules")), "{names:?}");
        let mut body = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("mirror/again.rs").unwrap(), &mut body).unwrap();
        assert_eq!(body, "fn main() {}\n", "a hard link carries the content");

        // An archive cut short fails rather than packing a shorter tree.
        // Read-write, like the staged bundle: a hard link is copied back out of it.
        let mut file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&bundle).unwrap();
        let mut zip = zip::ZipWriter::new(&mut file);
        let cut = &archive[..archive.len() / 2];
        let (_, failure) = pack_tar(&mut zip, cut, &WalkFilter::all(), &mut |_| {}).unwrap();
        assert!(failure.is_some());
    }

    #[test]
    fn only_a_bundle_carrying_conversations_needs_the_new_format() {
        let mut contents = BundleContents::default();
        assert_eq!(format_for(&contents), 1);
        contents.agent_history = true;
        assert_eq!(format_for(&contents), 2);
        assert!(format_for(&contents) <= BUNDLE_FORMAT);
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
            walk_tree(root, &filter, None, &mut |rel, _c, item| {
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
                rebuildable: false,
                keep: Default::default(),
            }),
            vec!["src/main.rs".to_string()]
        );
    }

    #[test]
    fn an_archived_link_target_is_written_in_windows_spelling() {
        assert_eq!(windows_link_target("../shared/data"), r"..\shared\data");
        assert_eq!(windows_link_target(r"C:\abs\x"), r"C:\abs\x");
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_carried_as_a_link_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::os::unix::fs::symlink("nowhere", root.join("link")).unwrap();
        let mut links = 0;
        let mut files = 0;
        walk_tree(root, &WalkFilter::all(), None, &mut |_rel, _c, item| {
            match item {
                TreeItem::Symlink(_) => links += 1,
                TreeItem::File { .. } => files += 1,
                TreeItem::Dir | TreeItem::Skipped(_) => {}
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
