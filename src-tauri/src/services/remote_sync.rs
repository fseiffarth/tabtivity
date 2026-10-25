//! Local mirror + selective bidirectional sync for remote (SSH) projects.
//!
//! SSH-sync Phase 1 (`docs/ssh_sync_plan.md`). Every remote project has a local
//! paired **mirror** — by default a `<name>` subfolder of the top-level
//! `tabtivity/projects-ssh/` root
//! (legacy/fallback: `<state_dir>/remote-projects/<id>/mirror/`), relocatable per
//! project via `extra["mirror"]` (see [`mirror_dir`]) — that starts empty and is
//! populated only by **explicit, user-chosen** sync. This module is
//! the `AppHandle`-free core: the manifest type + its on-disk IO, the lstat-typed
//! recursive host walker (G3 — never follows host symlinks), the per-file pull
//! primitive, and the pure 3-way (base/host/local) state compare. The Tauri
//! commands that orchestrate these (`commands::sync`) own the SFTP session and the
//! progress events.
//!
//! ## Source of truth
//! - The **manifest** (`<state_dir>/remote-projects/<id>/sync.json`) records, per
//!   project-relative path, the host base (size+mtime) captured at the last pull
//!   and the local base after writing it. All divergence is judged base-vs-host
//!   and base-vs-local (never host-mtime directly vs local-mtime — clock skew).
//! - The manifest is a single-writer structure: a Tauri-managed
//!   [`SyncManifestState`] serializes every mutation (G7), and SFTP transfers run
//!   with the lock released.

use crate::brand::SLUG;
use app_core::sync::LockExt;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::services::sftp::{self, SyncKind};

/// Largest single file the sync will transfer (64 MiB). `read_file_on` buffers a
/// whole file in RAM and holds the SFTP channel (G8), so a giant artifact is
/// skipped with an error rather than stalling the connection / OOMing.
pub const MAX_SYNC_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// One manifest record for a project-relative path. The host/local size+mtime are
/// the **bases** captured at the last successful pull/push — the reference the
/// green/amber UI state and the (Phase 2) stale-base conflict check compare a
/// fresh re-stat against.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEntry {
    /// Whether the user has marked this path to track. Selecting a path is the
    /// consent to mirror it; deselecting stops tracking (the mirror bytes stay).
    pub selected: bool,
    /// `true` when this path is a directory (selection marker, no bytes mirrored
    /// for the dir itself).
    #[serde(default)]
    pub is_dir: bool,
    /// Host size (bytes) at the last pull. `0` for a dir / absent.
    #[serde(default)]
    pub host_size: u64,
    /// Host mtime (unix secs) at the last pull, when reported.
    #[serde(default)]
    pub host_mtime: Option<u64>,
    /// Local mirror size (bytes) after the last pull/push.
    #[serde(default)]
    pub local_size: u64,
    /// Local mirror mtime (unix secs) after the last pull/push.
    #[serde(default)]
    pub local_mtime: Option<u64>,
    /// When this path was last pulled host→local (unix secs).
    #[serde(default)]
    pub last_pull_ts: Option<u64>,
    /// When this path was last pushed local→host (unix secs; Phase 2).
    #[serde(default)]
    pub last_push_ts: Option<u64>,
    /// Whether this path auto-syncs (bidirectional, safe-direction-only — the
    /// background reconcile engine keeps it in sync without a click). Implies
    /// `selected`. On a **directory** marker it applies to the whole subtree; the
    /// per-file entries the engine creates on transfer are NOT stamped (auto-ness
    /// is derived from the nearest marker by `is_auto`), so a file synced under a
    /// manually-selected folder stays non-auto. The project root (`""`) carries
    /// this flag as the project-wide "auto-sync all" toggle.
    #[serde(default)]
    pub auto_sync: bool,
    /// Explicit auto-sync EXCLUSION. Set when the user turns auto **off** for a
    /// path that would otherwise inherit it from an ancestor marker (a folder or
    /// the project-wide root). It overrides an ancestor's `auto_sync` for this
    /// path and its subtree — the "local toggles win" override — so a project-wide
    /// auto-sync can carve out individual files/folders. Nearest marker wins
    /// (`is_auto`); a plain off with no ancestor auto is a harmless no-op marker.
    #[serde(default)]
    pub auto_off: bool,
    /// **Excluded from byte-sync entirely** — a stronger statement than `auto_off`,
    /// which only carves a path out of the *background* engine. A folder the user
    /// answered "don't sync this" about (the giant-folder prompt raised when a
    /// project is first paired with a host, `services::big_folders`) must also be
    /// skipped by the one-click whole-project pull/push, or the very click the
    /// prompt exists to make safe would haul it over anyway. Applies to the whole
    /// subtree on a directory marker; an explicit auto-on *inside* it still wins
    /// (nearest marker, as everywhere else here).
    ///
    /// Byte-sync only: a **git-tracked** file in an excluded folder still travels
    /// via lockstep (commits, not bytes) — the two transports split the tree by
    /// git, and this flag lives on the byte side of that line.
    #[serde(default)]
    pub excluded: bool,
}

/// A project's manifest: project-relative path → record.
pub type Manifest = HashMap<String, SyncEntry>;

/// The green/amber/none UI state for a path (see the plan's "UI state").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    /// In the mirror and the manifest base still matches the host.
    Green,
    /// Host moved since the last fetch (detected on an explicit re-stat).
    Amber,
    /// Not synced (no mirror copy / not selected).
    None,
    /// Exists in the local mirror but was never synced (no manifest entry) —
    /// a NEW local file the host doesn't have yet, offered for upload. Emitted
    /// only by `sync_status`'s local-new pass, never by `compute_state`: the
    /// manifest can't compute a state for a file it has no record of.
    #[serde(rename = "localnew")]
    LocalNew,
}

/// Tauri-managed, single-writer cache of per-project manifests (G7). Every mutate
/// path locks this, so a push-on-save / a "sync now" / two tabs saving can never
/// clobber `sync.json`. `tokio::sync::Mutex` because the commands are async.
pub type SyncManifestState = Arc<Mutex<HashMap<String, Manifest>>>;

/// Build a fresh, empty manifest cache for `tauri::Builder::manage`.
pub fn new_manifest_state() -> SyncManifestState {
    Arc::new(Mutex::new(HashMap::new()))
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// The local per-project state dir for a remote project (mirrors
/// `commands::projects::remote_project_state_dir`, kept here to stay
/// command-layer-free).
fn state_dir(project_id: &str) -> PathBuf {
    crate::storage::state_dir()
        .join("remote-projects")
        .join(project_id)
}

/// The DEFAULT local mirror root for a remote project when it carries no explicit
/// override: `<state_dir>/.../<id>/mirror`. This remains the fallback so remote
/// projects created before configurable mirrors keep their existing location.
fn default_mirror_dir(project_id: &str) -> PathBuf {
    default_mirror_dir_in(&crate::storage::state_dir(), project_id)
}

/// [`default_mirror_dir`] under an explicit state dir — for the pure fence
/// planners (`agent_fence`, `mail_attach`), which tests point at a tempdir.
pub fn default_mirror_dir_in(state_dir: &Path, project_id: &str) -> PathBuf {
    state_dir.join("remote-projects").join(project_id).join("mirror")
}

/// A remote project's explicitly-chosen mirror root, read from the always-local
/// `projects.json` entry's flattened `extra["mirror"]` (written at import — where
/// it defaults to a `<name>` subfolder of the top-level `tabtivity/projects-ssh/` root — and rewritten
/// when the user relocates a deleted mirror). `None` when unset. Read from the
/// global list rather than the per-project `project.json` for the same reason as
/// `remote::remote_target_for`: the global list is always on the local disk.
fn mirror_override(project_id: &str) -> Option<PathBuf> {
    let entry = crate::services::remote::project_entry(project_id).ok()?;
    let raw = entry.extra.get("mirror")?.as_str()?.trim();
    (!raw.is_empty()).then(|| PathBuf::from(raw))
}

/// The local mirror root for a remote project. An explicit per-project override
/// (`extra["mirror"]`) wins; otherwise the default under the state dir. Every
/// path-prefix routing helper below (`is_under_mirror`, `mirror_local_path`)
/// resolves through here, so relocating the mirror moves all of them together.
pub fn mirror_dir(project_id: &str) -> PathBuf {
    mirror_override(project_id).unwrap_or_else(|| default_mirror_dir(project_id))
}

/// The manifest file path: `<state_dir>/.../<id>/sync.json`.
pub fn manifest_path(project_id: &str) -> PathBuf {
    state_dir(project_id).join("sync.json")
}

/// [`manifest_path`] under an explicit state dir — see `local_loss::log_path_in`.
pub fn manifest_path_in(state_dir: &Path, project_id: &str) -> PathBuf {
    state_dir
        .join("remote-projects")
        .join(project_id)
        .join("sync.json")
}

/// Whether `abs_path` lies inside the project's local mirror. Used by the file
/// readers (G2 path-prefix routing): a path under the mirror is read/written on
/// the LOCAL fs even though the project is remote, so the local source view and
/// local-on-remote tabs see mirrored bytes instead of round-tripping SFTP.
pub fn is_under_mirror(project_id: &str, abs_path: &str) -> bool {
    let mirror = mirror_dir(project_id);
    // Compare on canonicalized prefixes where possible so a symlinked state dir
    // still matches; fall back to the literal path when it doesn't exist yet.
    let candidate = Path::new(abs_path);
    let mirror_norm = mirror.canonicalize().unwrap_or(mirror);
    let cand_norm = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    cand_norm.starts_with(&mirror_norm)
}

/// Map a project-relative path to its absolute path inside the local mirror.
/// Lexically confined (#863): only plain name components are kept, so a `..`,
/// root or drive-prefix component can never step outside the mirror, whatever
/// the caller holds (a frontend `rel`, a manifest key recorded before the host
/// walk refused traversal names). Writers go through [`confined_mirror_path`],
/// which refuses such a path instead of reinterpreting it.
pub fn mirror_local_path(project_id: &str, rel: &str) -> PathBuf {
    mirror_dir(project_id).join(lexically_confined_rel(rel))
}

/// `rel` with every non-name component (`..`, `.`, root, drive prefix) dropped.
fn lexically_confined_rel(rel: &str) -> PathBuf {
    Path::new(rel)
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect()
}

/// The name components of project-relative `rel`, or why it may not be written:
/// a `..`, root or prefix component, or a NUL. A leading `/` is tolerated (the
/// same "project-relative" reading [`mirror_local_path`] always gave it).
fn rel_components(rel: &str) -> Result<Vec<&std::ffi::OsStr>, String> {
    if rel.contains('\0') {
        return Err(format!("refusing '{rel}': the path holds a NUL byte"));
    }
    let mut parts = Vec::new();
    for c in Path::new(rel.trim_start_matches('/')).components() {
        match c {
            Component::Normal(name) => parts.push(name),
            Component::CurDir => {}
            _ => return Err(format!("refusing '{rel}': it steps outside the local mirror")),
        }
    }
    Ok(parts)
}

/// Refuse when any EXISTING path among `root/parts[0]`, `root/parts[0]/parts[1]`,
/// … is a symlink. Stops at the first missing component: whatever is created
/// below it is a real directory. `root` itself is not checked — a user-chosen
/// mirror root may legitimately be a link.
fn refuse_symlinked_components(root: &Path, parts: &[&std::ffi::OsStr], rel: &str) -> Result<(), String> {
    match first_symlink_component(root, parts) {
        Ok(None) => Ok(()),
        Ok(Some(link)) => Err(format!(
            "refusing '{rel}': '{}' in the local mirror is a symlink",
            link.strip_prefix(root).unwrap_or(&link).display()
        )),
        Err(e) => Err(format!("refusing '{rel}': {e}")),
    }
}

/// The first EXISTING path among `root/parts[0]`, `root/parts[0]/parts[1]`, …
/// that is a symlink, or `None` (a missing component ends the walk).
fn first_symlink_component(root: &Path, parts: &[&std::ffi::OsStr]) -> std::io::Result<Option<PathBuf>> {
    let mut cur = root.to_path_buf();
    for part in parts {
        cur.push(part);
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) if meta.file_type().is_symlink() => return Ok(Some(cur)),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

/// The mirror path a WRITE of project-relative file `rel` may target, or why
/// not (#863). Refuses (never reinterprets) a traversal/absolute/NUL `rel` or an
/// empty one, and refuses when an existing DIRECTORY between `root` and the file
/// is a symlink: a fenced agent can plant `mirror/d -> ~/.config`, and
/// `create_dir_all` / `NamedTempFile::new_in` would follow it out of the mirror.
/// The file itself may be a symlink — [`replace_local_atomic`]'s rename replaces
/// the link, never its target.
pub fn confined_mirror_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = rel_components(rel)?;
    let Some((_, dirs)) = parts.split_last() else {
        return Err(format!("refusing '{rel}': no file name inside the local mirror"));
    };
    refuse_symlinked_components(root, dirs, rel)?;
    Ok(parts.iter().fold(root.to_path_buf(), |p, part| p.join(part)))
}

/// Like [`confined_mirror_path`], for a DIRECTORY that a bulk transfer writes
/// into (rsync's destination): `rel` may be empty (the mirror root), and the
/// directory itself must not be a symlink either, since rsync writes through it.
pub fn confined_mirror_dir(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = rel_components(rel)?;
    refuse_symlinked_components(root, &parts, rel)?;
    Ok(parts.iter().fold(root.to_path_buf(), |p, part| p.join(part)))
}

// ── Manifest IO ───────────────────────────────────────────────────────────

/// Load a project's manifest from disk: an empty one only when the file is
/// positively missing; an unreadable one is an error ([`read_manifest_at`]).
pub fn load_manifest(project_id: &str) -> Result<Manifest, String> {
    read_manifest_at(&manifest_path(project_id))
}

/// Read `sync.json` at `path`. Only a positively missing file is an empty
/// manifest. A file that exists but cannot be read or parsed is an error,
/// never "nothing selected": reading it as empty hid every selection and base,
/// and the next save then replaced the damaged file for good. Its bytes are
/// kept beside it (`sync.json.unreadable-<secs>`), and that version of the file
/// is remembered so no save replaces it ([`save_manifest_at`]) until the user
/// repairs or removes it.
fn read_manifest_at(path: &Path) -> Result<Manifest, String> {
    let content = match std::fs::read(path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Manifest::new()),
        Err(e) => return Err(mark_unreadable(path, None, &e.to_string())),
    };
    serde_json::from_slice(&content).map_err(|e| mark_unreadable(path, Some(&content), &e.to_string()))
}

/// Remember `path`'s current version as unreadable, keep a copy of `content`
/// (once per version), and answer the error every caller reports.
fn mark_unreadable(path: &Path, content: Option<&[u8]>, why: &str) -> String {
    let stamp = stamp_of(path);
    let mut unreadable = unreadable();
    if let Some((seen, msg)) = unreadable.get(path) {
        if *seen == stamp {
            return msg.clone();
        }
    }
    let kept = content.and_then(|bytes| {
        let name = format!("{}.unreadable-{}", path.file_name()?.to_string_lossy(), now_secs());
        let copy = path.with_file_name(name);
        match std::fs::write(&copy, bytes) {
            Ok(()) => Some(copy),
            Err(e) => {
                eprintln!("sync manifest: could not keep a copy of {}: {e}", path.display());
                None
            }
        }
    });
    let msg = match kept {
        Some(copy) => format!(
            "The sync state of this project ({}) could not be read ({why}); nothing was synced. A copy was kept at {}. Repair or remove the file to sync again.",
            path.display(),
            copy.display()
        ),
        None => format!(
            "The sync state of this project ({}) could not be read ({why}); nothing was synced. Repair or remove the file to sync again.",
            path.display()
        ),
    };
    eprintln!("sync manifest: {msg}");
    unreadable.insert(path.to_path_buf(), (stamp, msg.clone()));
    msg
}

/// The error for `path` when the version on disk is one found unreadable;
/// `None` once it was repaired or removed (a new version, or no file).
fn unreadable_now(path: &Path) -> Option<String> {
    let stamp = stamp_of(path);
    let mut unreadable = unreadable();
    match unreadable.get(path) {
        Some((seen, msg)) if *seen == stamp && stamp.is_some() => Some(msg.clone()),
        Some(_) => {
            unreadable.remove(path);
            None
        }
        None => None,
    }
}

/// Fail when the project's `sync.json` exists but cannot be read — the gate
/// every sync command passes before it moves a byte, since the cache
/// ([`ensure_loaded`]) stands in an empty manifest for an unreadable one. A
/// version this process already loaded or wrote is not parsed again.
pub fn check_manifest_readable(project_id: &str) -> Result<(), String> {
    check_manifest_readable_at(&manifest_path(project_id))
}

fn check_manifest_readable_at(path: &Path) -> Result<(), String> {
    if let Some(msg) = unreadable_now(path) {
        return Err(msg);
    }
    let disk = stamp_of(path);
    if disk.is_none() || stamps().get(path) == Some(&disk) {
        return Ok(());
    }
    read_manifest_at(path).map(|_| ())
}

/// Persist a project's manifest to disk (creates the state dir if needed).
///
/// Compare-and-swap across processes (G7 made real, final review B4): the
/// window and its desktop sidecar share one state dir, each with its own
/// [`SyncManifestState`] cache. Under the file's lock, a manifest this process
/// loaded through [`ensure_loaded`] is written only while `sync.json` is still
/// the version it was loaded from; otherwise nothing is written, the cache is
/// marked stale (the next [`ensure_loaded`] re-reads the file) and the caller
/// gets [`CHANGED_ELSEWHERE`] — a lost update becomes a retry.
pub fn save_manifest(project_id: &str, manifest: &Manifest) -> Result<(), String> {
    save_manifest_at(&manifest_path(project_id), manifest)
}

/// What [`save_manifest`] answers when another process wrote the manifest
/// since this one read it.
pub const CHANGED_ELSEWHERE: &str = "The sync state of this project was just changed by another window of this app (or its browser access); nothing was saved — try again.";

fn save_manifest_at(path: &Path, manifest: &Manifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // On a file system without advisory locks the stamp check alone guards.
    let _lock = crate::storage::FileLock::exclusive_or_unlocked(path).map_err(|e| e.to_string())?;
    // Never replace a file that could not be read: the cache stood in an empty
    // manifest for it, so this save would erase what the user selected.
    if let Some(msg) = unreadable_now(path) {
        return Err(msg);
    }
    let mut stamps = stamps();
    if let Some(expected) = stamps.get(path) {
        if *expected != stamp_of(path) {
            stamps.remove(path);
            return Err(CHANGED_ELSEWHERE.to_string());
        }
    }
    crate::storage::write_json_atomic(path, manifest).map_err(|e| e.to_string())?;
    stamps.insert(path.to_path_buf(), stamp_of(path));
    Ok(())
}

/// Read-modify-write a project's manifest straight from the file, under its
/// lock, for a caller outside the [`SyncManifestState`] cache; the cache
/// re-reads the file at its next use.
pub fn update_manifest(project_id: &str, update: impl FnOnce(&mut Manifest)) -> Result<(), String> {
    let path = manifest_path(project_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let _lock = crate::storage::FileLock::exclusive(&path).map_err(|e| e.to_string())?;
    let mut manifest = read_manifest_at(&path)?;
    update(&mut manifest);
    crate::storage::write_json_atomic(&path, &manifest).map_err(|e| e.to_string())?;
    stamps().remove(&path);
    Ok(())
}

/// Persist `manifest` after an operation recorded fresh bases for `recorded`
/// in it (a transfer, a restamp, a content-verified heal) — or, when that save
/// fails, make sure the record that never landed can not pass for the truth
/// (fixed decision #7 of the 2026-10-15 screen; every former `let _ =
/// save_manifest(..)` goes through here).
///
/// On failure: each `recorded` entry's base is forgotten ([`forget_base`]) in
/// `manifest`, the same marking is written to `sync.json` when the file can
/// still be written (compare-and-swap, so another process's newer version is
/// never clobbered), and the cache's stamp is dropped so the next
/// [`ensure_loaded`] re-reads the file — as [`save_manifest`] already does for
/// [`CHANGED_ELSEWHERE`]. A forgotten base reads as moved on both sides: the
/// next status re-derives the row (amber, or green again once its bytes are
/// verified identical), auto-sync leaves it alone, and a push asks instead of
/// writing. The save's error is returned; a user-initiated caller surfaces it,
/// a background one logs it.
pub fn save_manifest_or_mark_stale(
    project_id: &str,
    manifest: &mut Manifest,
    recorded: &[String],
) -> Result<(), String> {
    save_or_mark_stale_at(&manifest_path(project_id), manifest, recorded)
}

fn save_or_mark_stale_at(path: &Path, manifest: &mut Manifest, recorded: &[String]) -> Result<(), String> {
    let err = match save_manifest_at(path, manifest) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    for rel in recorded {
        if let Some(entry) = manifest.get_mut(rel) {
            forget_base(entry);
        }
    }
    if let Err(e) = mark_stale_on_disk(path, recorded) {
        eprintln!("sync manifest: could not mark {} path(s) stale in {}: {e}", recorded.len(), path.display());
    }
    stamps().remove(path);
    Err(err)
}

/// Forget the bases of the `recorded` entries `sync.json` holds, straight in
/// the file: read it, mark, and write it back only if it is still the version
/// read ([`save_manifest_at`]'s compare-and-swap). An entry the file does not
/// hold is left absent — never selected, so it can read as nothing cleaner
/// than "new" either.
fn mark_stale_on_disk(path: &Path, recorded: &[String]) -> Result<(), String> {
    if recorded.is_empty() {
        return Ok(());
    }
    let read_from = stamp_of(path);
    let mut disk = read_manifest_at(path)?;
    let mut marked = false;
    for rel in recorded {
        if let Some(entry) = disk.get_mut(rel) {
            forget_base(entry);
            marked = true;
        }
    }
    if !marked {
        return Ok(());
    }
    stamps().insert(path.to_path_buf(), read_from);
    let written = save_manifest_at(path, &disk);
    // The stamp now names the version just written, which is not what the
    // caller's cache holds: drop it either way so the cache re-reads.
    stamps().remove(path);
    written
}

/// The base size a forgotten base carries: no real file has it, so the host
/// and the mirror both read as moved (`divergence`) and a push asks
/// (`push_decision`) — whatever size, mtime or emptiness the file has.
pub const UNKNOWN_BASE_SIZE: u64 = u64::MAX;

/// Forget one entry's recorded bases, keeping everything the user chose
/// (selection, auto, exclusion) and the transfer timestamps — so a later pull
/// still warns about local edits it would overwrite rather than treating the
/// file as never synced.
pub fn forget_base(entry: &mut SyncEntry) {
    entry.host_size = UNKNOWN_BASE_SIZE;
    entry.host_mtime = None;
    entry.local_size = UNKNOWN_BASE_SIZE;
    entry.local_mtime = None;
}

/// Which version of a `sync.json` a cache holds: `None` = no file. Writes are
/// atomic renames, so a new version is a new inode as well as a new mtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    inode: u64,
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&meta);
    #[cfg(not(unix))]
    let inode = 0;
    Some(Stamp { len: meta.len(), modified: meta.modified().ok(), inode })
}

/// The version of each manifest file this process's cache was loaded from or
/// last wrote, by path.
fn stamps() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Option<Stamp>>> {
    static STAMPS: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, Option<Stamp>>>> = std::sync::OnceLock::new();
    STAMPS
        .get_or_init(Default::default)
        .lock_ok()
}

/// Each unreadable manifest's version and the error that names it, by path.
type Unreadable = HashMap<PathBuf, (Option<Stamp>, String)>;

/// The manifest versions found unreadable ([`read_manifest_at`]).
fn unreadable() -> std::sync::MutexGuard<'static, Unreadable> {
    static UNREADABLE: std::sync::OnceLock<std::sync::Mutex<Unreadable>> = std::sync::OnceLock::new();
    UNREADABLE
        .get_or_init(Default::default)
        .lock_ok()
}

// ── Pure helpers ──────────────────────────────────────────────────────────

use crate::clock::now_secs;

/// The green/amber state for a SELECTED file, judged SYMMETRICALLY against both
/// bases: amber when the host moved from its recorded base (`host` re-stat differs
/// from `entry.host_*`) OR the local mirror moved from its recorded base (`local`
/// re-stat differs from `entry.local_*`); green only when neither side diverged.
/// `host` is `None` when the host wasn't stat'd (cold pool) — then only the local
/// side is judged (no network needed). `local` is `None` when the mirror file is
/// gone; a missing mirror we had previously synced counts as diverged (deleted
/// locally). `excluded` is the path's EFFECTIVE (own-or-inherited, see
/// `is_excluded`) byte-sync exclusion: a path excluded from sync is also
/// excluded from the diverged view — flagging amber on a file sync will never
/// touch again is a dead end, not a warning. Pure, unit-tested.
pub fn compute_state(
    entry: &SyncEntry,
    host: Option<(u64, Option<u64>)>,
    local: Option<(u64, Option<u64>)>,
    excluded: bool,
) -> SyncState {
    if !entry.selected || excluded {
        return SyncState::None;
    }
    let (host_diverged, local_diverged) = divergence(entry, host, local);
    if host_diverged || local_diverged {
        SyncState::Amber
    } else {
        SyncState::Green
    }
}

/// `(host_diverged, local_diverged)` vs the recorded bases — the same rule
/// `compute_state` collapses into green/amber, but kept as two distinct booleans
/// so the auto-sync engine can pick the SAFE direction (pull when only the host
/// moved, push when only the local moved, skip when both = amber/conflict).
/// `host` is `None` when the host wasn't stat'd (cold pool) → host side not
/// flagged. `local` is `None` when the mirror file is gone; a missing mirror we
/// had previously synced counts as diverged (deleted locally). Pure, unit-tested.
pub fn divergence(
    entry: &SyncEntry,
    host: Option<(u64, Option<u64>)>,
    local: Option<(u64, Option<u64>)>,
) -> (bool, bool) {
    let host_diverged = match host {
        Some((size, mtime)) => entry.host_size != size || entry.host_mtime != mtime,
        None => false, // couldn't check the host → don't flag host divergence
    };
    let local_diverged = match local {
        Some((size, mtime)) => entry.local_size != size || entry.local_mtime != mtime,
        // Mirror gone but we had synced it before → deleted locally = diverged.
        None => entry.last_pull_ts.is_some() || entry.last_push_ts.is_some(),
    };
    (host_diverged, local_diverged)
}

/// Whether a tracked FILE entry should be pruned from the manifest during a
/// status pass. Each side is a TRI-STATE stat result — `Ok(Some(..))` present,
/// `Ok(None)` **positively gone** (the SFTP `NoSuchFile` status / io
/// `NotFound`), `Err` could-not-check — and the prune fires only when BOTH
/// sides are positively gone on an entry we HAD synced: nothing left on either
/// side to compare, resolve, or protect. An `Err` never counts as gone — a
/// dropped session mid-refresh stats every entry as `Err`, and reading that as
/// "deleted" would prune the whole manifest in one pass. Never fires for
/// one-side deletions (real conflicts by design) or never-synced markers.
/// Pure, unit-tested.
pub fn should_prune(
    entry: &SyncEntry,
    host: &Result<Option<(u64, Option<u64>)>, String>,
    local: &Result<Option<(u64, Option<u64>)>, String>,
) -> bool {
    let ever_synced = entry.last_pull_ts.is_some() || entry.last_push_ts.is_some();
    !entry.is_dir && ever_synced && matches!(host, Ok(None)) && matches!(local, Ok(None))
}

/// Whether an amber verdict is worth confirming against the actual bytes rather
/// than trusting the size+mtime heuristic. Size+mtime only *approximates*
/// divergence: a re-save with identical bytes (or a bare `touch`) moves the mtime
/// while the content is unchanged, so the file paints amber with nothing to
/// resolve. We read to disprove that only when it could pay off: both sides exist
/// (a present mtime), they are the SAME size (different sizes can't be identical —
/// don't read), and they sit at or below `cutoff`. Large files keep the heuristic —
/// reading them over SFTP on every status refresh is exactly its reason to exist.
/// Pure, unit-tested; the byte read + compare itself lives in `commands::sync`.
pub fn content_verify_worth_it(
    host: (u64, Option<u64>),
    local: (u64, Option<u64>),
    cutoff: u64,
) -> bool {
    let (host_size, host_mtime) = host;
    let (local_size, local_mtime) = local;
    host_mtime.is_some() && local_mtime.is_some() && host_size == local_size && host_size <= cutoff
}

/// Whether `rel` auto-syncs, by **nearest explicit marker wins**. A marker is an
/// entry carrying `auto_sync` (on) or `auto_off` (excluded). We consult, closest
/// first: the path's own entry, then each ancestor **directory** marker, ending at
/// the project root (`""`) — whose marker is the project-wide "auto-sync all"
/// toggle. The first explicit decision found wins, so a per-file/folder toggle
/// overrides an ancestor (including project-wide) in either direction. A folder
/// marker only applies to descendants when it is `is_dir`. Pure.
pub fn is_auto(manifest: &Manifest, rel: &str) -> bool {
    // The path's own entry decides for itself regardless of is_dir.
    if let Some(e) = manifest.get(rel) {
        if e.auto_off || e.excluded {
            return false;
        }
        if e.auto_sync {
            return true;
        }
    }
    // Ancestor directory markers, nearest first, finally the root "" marker (which
    // `rfind('/')` never reaches on its own).
    let mut cur = rel;
    loop {
        cur = match cur.rfind('/') {
            Some(idx) => &cur[..idx],
            None if !cur.is_empty() => "", // consult the project root last
            None => return false,          // consumed the root: no decision
        };
        if let Some(e) = manifest.get(cur) {
            if e.is_dir {
                if e.auto_off || e.excluded {
                    return false;
                }
                if e.auto_sync {
                    return true;
                }
            }
        }
    }
}

/// Whether `rel` is **excluded from byte-sync**, by the same nearest-marker walk
/// as [`is_auto`]: the path's own entry, then each ancestor directory marker up
/// to the project root. An explicit `auto_sync` marker nearer than the exclusion
/// re-includes the path, so a user can keep one folder inside an excluded tree.
///
/// `under` is the path the caller was *asked* to transfer, and the markers on it
/// and above it are deliberately ignored: right-clicking a folder in (or of) an
/// excluded tree and downloading it — say, the one data folder an agent needs —
/// is an explicit override of the answer stored there, whereas a whole-project
/// pull is not. Exclusions nested *below* `under` still hold. Pass `""` for a
/// project-root pull to honour every exclusion.
pub fn is_excluded(manifest: &Manifest, rel: &str, under: &str) -> bool {
    let mut cur = rel;
    loop {
        if cur == under {
            return false;
        }
        if let Some(e) = manifest.get(cur) {
            // A directory marker rules its subtree; a file's own entry rules
            // only itself (`cur == rel` on the first pass).
            if e.is_dir || cur == rel {
                if e.excluded {
                    return true;
                }
                if e.auto_sync {
                    return false;
                }
            }
        }
        cur = match cur.rfind('/') {
            Some(idx) => &cur[..idx],
            None if !cur.is_empty() => "",
            None => return false,
        };
    }
}

/// Which mirror files count as **new local files** for the status view — files
/// the manifest has never seen, i.e. the host doesn't have them and no sync
/// state exists to paint them green or amber. Without this pass they were
/// invisible everywhere: `sync_status` iterates the manifest, so a file created
/// after the last transfer had no row, no tree badge, no diverged-list entry —
/// nothing saying "this exists only locally and can be uploaded" (the SimpleGNN
/// report that motivated the pass).
///
/// `all` is the mirror-side file listing (git-derived or a raw walk — the
/// caller decides); the filter is what's pure and tested here:
/// - anything with a manifest entry already has a row (whatever its state);
/// - with lockstep on, git-TRACKED files belong to lockstep (#28p D1 — they
///   travel as commits, and reporting them "new" would invite a byte-push that
///   lands them untracked on the peer and wedges the fast-forward);
/// - an effectively excluded path (own or inherited marker) is out of byte-sync
///   scope entirely — flagging it "uploadable" would contradict the marker;
/// - the result is sorted (stable UI order) and capped: the fallback raw walk
///   of a mirror with a giant data/ tree can yield tens of thousands of
///   candidates, and the row list is advisory, not an inventory.
pub fn local_new_candidates(
    manifest: &Manifest,
    all: impl IntoIterator<Item = String>,
    tracked: &HashSet<String>,
    lockstep_enabled: bool,
    cap: usize,
) -> Vec<String> {
    let mut out: Vec<String> = all
        .into_iter()
        .filter(|rel| !rel.is_empty())
        .filter(|rel| !manifest.contains_key(rel))
        .filter(|rel| !(lockstep_enabled && tracked.contains(rel)))
        .filter(|rel| !is_excluded(manifest, rel, ""))
        .collect();
    out.sort();
    out.truncate(cap);
    out
}

/// Borrow (loading from disk on first touch) the project's manifest from the
/// single-writer cache. Shared by the command layer and the auto-sync engine.
pub fn ensure_loaded<'a>(
    cache: &'a mut HashMap<String, Manifest>,
    project_id: &str,
) -> &'a mut Manifest {
    ensure_loaded_at(cache, project_id, &manifest_path(project_id))
}

/// [`ensure_loaded`] for the file at `path`. The cached copy is used only
/// while the file is still the version it was read from (or this process last
/// wrote); a write by the other process sharing the state dir makes it read
/// the file again.
fn ensure_loaded_at<'a>(cache: &'a mut HashMap<String, Manifest>, project_id: &str, path: &Path) -> &'a mut Manifest {
    let mut stamps = stamps();
    let disk = stamp_of(path);
    let fresh = cache.contains_key(project_id) && stamps.get(path) == Some(&disk);
    if !fresh {
        // An unreadable file stands in as empty here (every caller holds a
        // `&mut Manifest`), so nothing reads as selected or auto; the commands
        // refuse first (`check_manifest_readable`) and no save replaces it.
        let manifest = read_manifest_at(path).unwrap_or_default();
        cache.insert(project_id.to_string(), manifest);
        stamps.insert(path.to_path_buf(), disk);
    }
    cache.get_mut(project_id).expect("inserted above")
}

/// `(size, mtime)` from a local file's metadata (mtime as unix secs).
pub fn local_meta(m: &std::fs::Metadata) -> (u64, Option<u64>) {
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    (m.len(), mtime)
}

/// `(size, mtime)` of a local file's metadata, defaulting to `(0, None)`.
pub fn local_size_mtime(meta: Option<std::fs::Metadata>) -> (u64, Option<u64>) {
    match meta {
        Some(m) => local_meta(&m),
        None => (0, None),
    }
}

/// Join a remote project root with a project-relative path (mirrors
/// `commands::fs::join_remote_dir`). Pure.
pub fn join_remote(remote_root: &str, rel: &str) -> String {
    let base = remote_root.trim_end_matches('/');
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        if base.is_empty() {
            "/".to_string()
        } else {
            base.to_string()
        }
    } else if base.is_empty() {
        format!("/{rel}")
    } else {
        format!("{base}/{rel}")
    }
}

/// Append a child segment to a project-relative path (`""`+`a` → `a`, `a`+`b` →
/// `a/b`). Pure.
fn join_rel(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), child)
    }
}

// ── Host walk + pull (async; SFTP) ─────────────────────────────────────────

/// One regular file discovered by the host walk: its project-relative path and
/// the host base (size + mtime) captured at walk time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFile {
    pub rel: String,
    pub size: u64,
    pub mtime: Option<u64>,
    /// The host's permission bits (`0o777`), when the server reported them —
    /// what [`pull_file`] gives the mirror copy.
    pub mode: Option<u32>,
}

/// Recursively collect the regular FILES under `rel` on the host, lstat-typed so
/// symlinks and special files are SKIPPED, never followed (G3). `remote_root` is
/// the project's `remote_path`; `rel` is project-relative (`""` walks the root).
/// Directories recurse; symlinks/sockets/etc. are ignored. Bounded by the host
/// tree; a hostile `link -> /etc` is skipped rather than mirrored.
pub async fn walk_host_files(
    sftp: &openssh_sftp_client::Sftp,
    remote_root: &str,
    rel: &str,
) -> Result<Vec<HostFile>, String> {
    let mut out = Vec::new();
    walk_inner(sftp, remote_root, rel, &mut out).await?;
    Ok(out)
}

async fn walk_inner(
    sftp: &openssh_sftp_client::Sftp,
    remote_root: &str,
    rel: &str,
    out: &mut Vec<HostFile>,
) -> Result<(), String> {
    let abs = join_remote(remote_root, rel);
    let entries = sftp::list_dir_raw_on(sftp, &abs).await?;
    // #23 D2: a directory holding a `.git` entry of EITHER kind is somebody else's
    // repo — a nested clone, or a linked worktree, whose `.git` is a *file*. Skipping
    // the entry named `.git` (below) covers the file but not the checkout around it,
    // so a worktree inside the project used to be walked and mirrored as a second full
    // copy of the source tree: doubling every pass, counted in the big-folder census,
    // and landing on the peer as a plain directory with no `.git` at all. The project
    // root itself of course has one, so this is a check on *sub*directories only.
    if !rel.is_empty() && entries.iter().any(|e| e.name == ".git") {
        return Ok(());
    }
    for entry in entries {
        // Skip Tabtivity's internal runtime dir, mirroring the local/remote listers.
        // `.git` is likewise never byte-mirrored: git state is kept in step
        // *semantically* by `services::git_peer` (lockstep), so copying its bytes
        // would fight that layer and risk corrupting a repo mid-write.
        if crate::brand::is_project_dir(&entry.name) || entry.name == ".git" {
            continue;
        }
        let child_rel = join_rel(rel, &entry.name);
        match entry.kind {
            SyncKind::Dir => {
                Box::pin(walk_inner(sftp, remote_root, &child_rel, out)).await?;
            }
            SyncKind::File => out.push(HostFile {
                rel: child_rel,
                size: entry.size,
                mtime: entry.modified_secs,
                mode: entry.mode,
            }),
            // G3: symlinks and special files are never mirrored.
            SyncKind::Symlink | SyncKind::Other => {}
        }
    }
    Ok(())
}

/// Pull one host file into the mirror: read it over SFTP (size-guarded, G8) and
/// write it locally, creating parent dirs. Returns the local (size, mtime) base
/// captured after the write. The host `abs` path must already be confined by the
/// caller; the local destination is project-relative `rel` under `mirror_root`,
/// confined here by [`write_mirror_file`] (#863) — refused before any byte moves.
/// `host_mode` is the host file's permission bits from the stat the caller
/// already holds (see [`replace_local_atomic`] for what the mirror copy gets).
pub async fn pull_file(
    sftp: &openssh_sftp_client::Sftp,
    host_abs: &str,
    host_size: u64,
    host_mode: Option<u32>,
    mirror_root: &Path,
    rel: &str,
) -> Result<(u64, Option<u64>), String> {
    pull_file_with(host_abs, host_size, host_mode, mirror_root, rel, || sftp::read_file_on(sftp, host_abs)).await
}

/// [`pull_file`] with the host read passed in (`read`, called at most once and
/// never for a file over the cap): the SFTP floor's whole per-file rule —
/// confinement, the size cap before and after the read, the atomic write —
/// testable without a host.
async fn pull_file_with<R, F>(
    host_abs: &str,
    host_size: u64,
    host_mode: Option<u32>,
    mirror_root: &Path,
    rel: &str,
    read: R,
) -> Result<(u64, Option<u64>), String>
where
    R: FnOnce() -> F,
    F: std::future::Future<Output = Result<Vec<u8>, String>>,
{
    confined_mirror_path(mirror_root, rel)?;
    if host_size > MAX_SYNC_FILE_BYTES {
        return Err(format!(
            "'{host_abs}' is too large to sync ({host_size} bytes; limit {MAX_SYNC_FILE_BYTES})"
        ));
    }
    let bytes = read().await?;
    if bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
        return Err(format!(
            "'{host_abs}' is too large to sync ({} bytes; limit {MAX_SYNC_FILE_BYTES})",
            bytes.len()
        ));
    }
    let local = write_mirror_file_with_mode(mirror_root, rel, &bytes, host_mode)?;
    let meta = std::fs::metadata(&local).map_err(|e| e.to_string())?;
    let local_size = meta.len();
    let local_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok((local_size, local_mtime))
}

/// Write `bytes` to project-relative `rel` under `mirror_root`, confined to the
/// mirror (#863): [`confined_mirror_path`] before creating the parent dirs and
/// again after, so a directory symlink planted while they were being created is
/// still refused (a narrowed window, not a closed one — no `openat` walk here).
/// Returns the path written. The file gets no host mode (see
/// [`write_mirror_file_with_mode`]).
pub fn write_mirror_file(mirror_root: &Path, rel: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    write_mirror_file_with_mode(mirror_root, rel, bytes, None)
}

/// [`write_mirror_file`] carrying the host file's permission bits, when known
/// (see [`replace_local_atomic`]).
pub fn write_mirror_file_with_mode(
    mirror_root: &Path,
    rel: &str,
    bytes: &[u8],
    host_mode: Option<u32>,
) -> Result<PathBuf, String> {
    let local = confined_mirror_path(mirror_root, rel)?;
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    confined_mirror_path(mirror_root, rel)?;
    replace_local_atomic(&local, bytes, host_mode)?;
    Ok(local)
}

/// Atomically replace one mirror file with fully-read host bytes. The caller
/// confines `local` ([`write_mirror_file`]).
///
/// The mode (Unix): the staged file used to keep `NamedTempFile`'s `0600`, so
/// every SFTP pull dropped a host script's executable bit (rsync's fast path
/// never did). Now: the host's permission bits (`host_mode`, masked to `0o777`
/// — never setuid/setgid/sticky from the host) through the umask — what rsync
/// gives a new file without `-p`, and never a world-writable mirror file
/// because the host had one; with no host mode, the existing mirror file's
/// permission bits exactly; else the umask default for a new file.
fn replace_local_atomic(local: &Path, bytes: &[u8], host_mode: Option<u32>) -> Result<(), String> {
    let parent = local.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Stage beside the destination and atomically replace it. A crash or process
    // kill can now leave either the old complete file or the new complete file,
    // never a mirror file truncated by `fs::write`.
    let mut staged = staged_mirror_file(parent, local, host_mode)?;
    staged.write_all(bytes).map_err(|e| e.to_string())?;
    staged.flush().map_err(|e| e.to_string())?;
    staged.persist(local).map_err(|e| e.error.to_string())?;
    Ok(())
}

/// The temp file [`replace_local_atomic`] stages in, created with the mode the
/// replacement must end up with (Unix; see there).
#[cfg(unix)]
fn staged_mirror_file(
    parent: &Path,
    local: &Path,
    host_mode: Option<u32>,
) -> Result<tempfile::NamedTempFile, String> {
    use std::os::unix::fs::PermissionsExt;
    // The file being replaced, never followed through a symlink: the rename
    // replaces a link itself, so a link's target says nothing about this file.
    // Permission bits only (`0o777`), from either side: the host is
    // attacker-controlled, and `open(2)` would honour a setuid/setgid/sticky bit
    // in the create mode (only a later unprivileged write clears setuid/setgid —
    // never for an empty file or a privileged process). Nor does a local special
    // bit survive a replacement whose bytes are the host's. rsync without `-p`
    // drops them the same way.
    let existing = std::fs::symlink_metadata(local)
        .ok()
        .filter(|m| m.file_type().is_file())
        .map(|m| m.permissions().mode() & 0o777);
    let create_mode = host_mode.map(|m| m & 0o777).or(existing).unwrap_or(0o666);
    let staged = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(create_mode))
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    // `open(2)` applied the umask; a kept local mode is the file's own permission
    // bits, exactly.
    if let (None, Some(mode)) = (host_mode, existing) {
        staged
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    Ok(staged)
}

/// The temp file [`replace_local_atomic`] stages in (no Unix modes here).
#[cfg(not(unix))]
fn staged_mirror_file(
    parent: &Path,
    _local: &Path,
    _host_mode: Option<u32>,
) -> Result<tempfile::NamedTempFile, String> {
    tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())
}

/// Re-stat a host path over SFTP, returning `(size, mtime)` or `(0, None)` when
/// the path is gone/unreadable — the input to [`compute_state`] for the amber
/// refresh.
pub async fn stat_or_zero(sftp: &openssh_sftp_client::Sftp, host_abs: &str) -> (u64, Option<u64>) {
    sftp::metadata_on(sftp, host_abs).await.unwrap_or((0, None))
}

/// Record a freshly-pulled file in the manifest: mark it selected and stamp the
/// host + local bases and the pull timestamp. Mutates `manifest` in place; the
/// caller persists under the single-writer lock.
pub fn record_pull(
    manifest: &mut Manifest,
    rel: &str,
    host_size: u64,
    host_mtime: Option<u64>,
    local_size: u64,
    local_mtime: Option<u64>,
) {
    let entry = manifest.entry(rel.to_string()).or_default();
    entry.selected = true;
    entry.is_dir = false;
    entry.host_size = host_size;
    entry.host_mtime = host_mtime;
    entry.local_size = local_size;
    entry.local_mtime = local_mtime;
    entry.last_pull_ts = Some(now_secs());
}

// ── rsync fast-path (Phase 3) ──────────────────────────────────────────────
//
// rsync gives delta transfer + a single connection for BULK (folder / whole-
// project) PULLS, riding the existing ControlMaster so it never re-authenticates.
// It is a pure-optimisation fast-path over the SFTP-native walker, which remains
// the floor (used whenever rsync is missing on either end or older than 3.0
// there — [`rsync_fast_path`] — and on any rsync failure). Only PULLS use rsync: a push must honour the per-file block-on-stale
// guard (product decision 5 — never clobber), which a bulk rsync would bypass, so
// pushes stay on the guarded SFTP path.

/// SSH keepalive options threaded into rsync's `-e` ssh transport (matches the
/// pooled-session keepalive so a dropped link fails fast rather than hanging).
const RSYNC_SSH_KEEPALIVE: &[&str] = &[
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "BatchMode=yes",
];

/// An rsync's `major.minor`, read from its `rsync --version` output by
/// [`parse_rsync_version`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RsyncVersion {
    pub major: u32,
    pub minor: u32,
}

/// The first rsync release with `--protect-args` (`-s`), which the fast path
/// cannot run without: macOS's `/usr/bin/rsync` (2.6.9, or openrsync on 15+)
/// and any host rsync before it reject the flag.
const RSYNC_PROTECT_ARGS_SINCE: RsyncVersion = RsyncVersion { major: 3, minor: 0 };

/// The version in `rsync --version` output (`rsync  version 3.2.7  protocol
/// version 31`), or `None` when the output is not the samba rsync's — openrsync
/// (`openrsync: protocol version 29`, even with an `rsync version 2.6.9
/// compatible` line after it), an empty answer, or anything else. A login
/// banner the host's shell prints first is skipped: only the line shaped as
/// rsync's own counts.
pub fn parse_rsync_version(output: &str) -> Option<RsyncVersion> {
    if output.lines().any(|line| line.trim_start().starts_with("openrsync")) {
        return None;
    }
    output.lines().find_map(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.first() != Some(&"rsync") || words.get(1) != Some(&"version") || !line.contains("protocol version") {
            return None;
        }
        let version = words.get(2)?.trim_start_matches('v');
        let mut parts = version.split('.');
        let major = parts.next()?.parse().ok()?;
        // `3.4.1`, `3.0.0pre1`: the minor is the leading digits.
        let minor = parts.next()?;
        let minor = minor[..minor.find(|c: char| !c.is_ascii_digit()).unwrap_or(minor.len())].parse().ok()?;
        Some(RsyncVersion { major, minor })
    })
}

/// Proof that the rsync spawned here and the host's rsync both take
/// `--protect-args`; [`rsync_pull_args`] needs one, so no argv is ever built
/// for an rsync that would read the host path through the remote shell. Only
/// [`rsync_fast_path`] makes one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RsyncFastPath(());

/// The fast path for a pull, given what each end's `rsync --version` said
/// (`None`: missing, unparseable, openrsync or the probe failed). `None` back
/// means the SFTP floor. Pure, unit-tested.
pub fn rsync_fast_path(local: Option<RsyncVersion>, host: Option<RsyncVersion>) -> Option<RsyncFastPath> {
    let protects = |v: Option<RsyncVersion>| v.is_some_and(|v| v >= RSYNC_PROTECT_ARGS_SINCE);
    (protects(local) && protects(host)).then_some(RsyncFastPath(()))
}

/// Build the `ssh …` string for rsync's `-e` so the transfer rides the shared
/// `cm-%C` ControlMaster (no second auth) with `ControlMaster=no` (use, don't
/// create). Includes the port and keepalive. Pure (the control dir is a stable
/// per-user path), unit-tested for the ControlPath wiring and its quoting.
pub fn rsync_ssh_transport(port: Option<u16>) -> String {
    rsync_ssh_transport_in(&crate::services::ssh_exec::control_dir(), port)
}

fn rsync_ssh_transport_in(control_dir: &Path, port: Option<u16>) -> String {
    let control_path = control_dir.join("cm-%C");
    let mut parts: Vec<String> = vec![
        "ssh".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        rsync_e_quote(&format!("ControlPath={}", control_path.to_string_lossy())),
    ];
    for a in RSYNC_SSH_KEEPALIVE {
        parts.push((*a).to_string());
    }
    if let Some(p) = port {
        parts.push("-p".to_string());
        parts.push(p.to_string());
    }
    parts.join(" ")
}

/// One word of rsync's `-e` string, in rsync's own syntax: rsync splits the
/// string on spaces outside quotes, reads `\` as a literal, and takes a
/// doubled `'` inside single quotes as one `'`. (A POSIX `'\''` is not that
/// syntax: one `'` in the path left the string unterminated, two made rsync
/// hand ssh a different ControlPath.)
fn rsync_e_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "''"))
}

/// rsync's transfer flags for a PULL, everything but the `-e` transport and the
/// two endpoints. The caller supplies a NUL-delimited `--files-from` list
/// produced by [`walk_host_files`], so this optimisation cannot transfer a path
/// that the preview/manifest walker skipped (nested repos and symlinks in
/// particular). The rest is defence in depth against a host-side tree changing
/// between the walk and rsync (gap 35): rsync must land exactly what the SFTP
/// floor ([`pull_file`]) would — regular files of at most
/// [`MAX_SYNC_FILE_BYTES`], default modes.
/// - `-t -c` (not `-a`): keep timestamps and the checksum compare; no `-p`,
///   `-o`, `-g` (the floor writes default modes) and no `-l`/`-D`, spelled out
///   as `--no-links --no-devices --no-specials`, so a symlink, FIFO, socket or
///   device in the list is skipped by the receiving side.
/// - `--max-size`: a file over the cap is skipped, as the floor refuses it.
/// - No `-r`: `--files-from` implies `--relative` and `--dirs`, which still
///   create each listed file's parent directories, but a listed path that has
///   become a directory is not descended into, so unlisted files never land.
pub fn rsync_pull_flags(files_from: &Path) -> Vec<String> {
    vec![
        "-t".to_string(),
        "-c".to_string(),
        "--no-links".to_string(),
        "--no-devices".to_string(),
        "--no-specials".to_string(),
        format!("--max-size={MAX_SYNC_FILE_BYTES}"),
        "--exclude=/.git".to_string(),
        format!("--exclude={}", crate::brand::PROJECT_DIR),
        "--exclude=.git".to_string(),
        "--from0".to_string(),
        format!("--files-from={}", files_from.to_string_lossy()),
        // The host path (and the list's paths) reach the remote rsync as-is,
        // never through the remote shell's word splitting and expansion.
        "--protect-args".to_string(),
    ]
}

/// Build the full rsync argv for a host→local PULL: [`rsync_pull_flags`], then
/// the ControlMaster transport and the two endpoints. Pure, unit-tested (it
/// never touches the network). `_fast` is the proof both ends take
/// `--protect-args`.
pub fn rsync_pull_args(
    _fast: RsyncFastPath,
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    host_src: &str,
    local_dest: &str,
    files_from: &Path,
) -> Vec<String> {
    let host_src = rsync_literal_host_path(host_src);
    let target = match user {
        Some(u) => format!("{u}@{host}:{host_src}"),
        None => format!("{host}:{host_src}"),
    };
    let mut args = rsync_pull_flags(files_from);
    args.extend([
        "-e".to_string(),
        rsync_ssh_transport(port),
        target,
        local_dest.to_string(),
    ]);
    args
}

/// `path` as the remote rsync reads it literally. The sending rsync expands
/// wildcards in its source argument itself (with `--protect-args` too), so
/// a project dir `/srv/a[1]` would pull `/srv/a1` instead. It globs one
/// `/`-separated segment at a time: a segment holding one of `*?[` is
/// matched with `\` escapes honoured, any other is taken byte for byte — so
/// only those segments are escaped (an escaped `x\]y` or `a\\b` elsewhere
/// would name a dir that does not exist).
fn rsync_literal_host_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            if !segment.contains(['*', '?', '[']) {
                return segment.to_string();
            }
            let mut out = String::with_capacity(segment.len() + 8);
            for c in segment.chars() {
                if matches!(c, '*' | '?' | '[' | ']' | '\\') {
                    out.push('\\');
                }
                out.push(c);
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether a host file of `host_size` bytes may ride the rsync fast path at
/// all: the same cap the SFTP floor applies. The caller leaves larger files out
/// of the `--files-from` list (`--max-size` is the second line).
pub fn rsync_may_transfer(host_size: u64) -> bool {
    host_size <= MAX_SYNC_FILE_BYTES
}

/// The files of a pull that may ride the rsync fast path: those within the
/// cap ([`rsync_may_transfer`]), in walk order.
pub fn rsync_transfer_list(files: &[HostFile]) -> Vec<HostFile> {
    files.iter().filter(|file| rsync_may_transfer(file.size)).cloned().collect()
}

/// A host file a pull left on the host because it is over
/// [`MAX_SYNC_FILE_BYTES`] (gap 35): project-relative path and host size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub rel: String,
    pub size: u64,
}

/// What a `sync_pull` / `sync_whole_project` did. The files over the cap used
/// to be skipped with a stderr line only, and the pull still read as done;
/// they are reported here, on the rsync and the SFTP path alike, for the UI
/// to name. `skippedTooLarge` defaults to empty, so an older payload without
/// it still reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    /// Files that landed in the mirror and were recorded.
    pub pulled: usize,
    /// Files over the cap left on the host, in walk order.
    #[serde(default)]
    pub skipped_too_large: Vec<SkippedFile>,
}

impl PullOutcome {
    /// Count one file of the pull after its transport (`landed`: recorded in
    /// the manifest). A file that did not land because the host walk listed it
    /// over the cap is reported; one that failed for another reason (gone,
    /// unreadable, not a regular file any more) stays a stderr line.
    pub fn tally(&mut self, file: &HostFile, landed: bool) {
        if landed {
            self.pulled += 1;
        } else if !rsync_may_transfer(file.size) {
            self.skipped_too_large.push(SkippedFile { rel: file.rel.clone(), size: file.size });
        }
    }
}

/// The manifest base for a file rsync just wrote at `local`, or `None` to
/// leave it unrecorded: only a regular file (lstat, so a symlink is not
/// followed) within the cap counts, and only when the host walk listed it
/// within the cap too. A FIFO, socket, device, directory or link a changing
/// host tree slipped past the walk is never recorded as synced (gap 35).
pub fn rsync_pulled_base(local: &Path, host_size: u64) -> Option<(u64, Option<u64>)> {
    if !rsync_may_transfer(host_size) {
        return None;
    }
    let meta = std::fs::symlink_metadata(local).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_SYNC_FILE_BYTES {
        return None;
    }
    Some(local_meta(&meta))
}

/// Convert the project-relative files returned by [`walk_host_files`] into paths
/// relative to the requested rsync subtree. A mismatch means the caller must use
/// the SFTP floor rather than risk widening the transfer.
pub fn rsync_subtree_files(files: &[HostFile], rel: &str) -> Option<Vec<String>> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Some(files.iter().map(|file| file.rel.clone()).collect());
    }
    let prefix = format!("{rel}/");
    files
        .iter()
        .map(|file| file.rel.strip_prefix(&prefix).map(str::to_string))
        .collect()
}

/// Write rsync's local allowlist with NUL separators so newlines and other valid
/// filename bytes cannot turn one walker entry into multiple transfer entries.
fn rsync_files_from(paths: &[String]) -> Result<tempfile::NamedTempFile, String> {
    let mut file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    for path in paths {
        file.write_all(path.as_bytes()).map_err(|e| e.to_string())?;
        file.write_all(&[0]).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(file)
}

/// Whether `rsync` is on the LOCAL `PATH`.
pub fn rsync_available_local() -> bool {
    which_on_path("rsync")
}

/// How long the local `rsync --version` may take.
const RSYNC_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The version of the rsync a pull spawns — [`crate::paths::command_no_window`]'s,
/// so the root-owned system copy where there is one (macOS: `/usr/bin/rsync`,
/// even with a newer one on `PATH`), not whichever `which` finds. Asked once per
/// process; `None` (missing, openrsync, unparseable) keeps every pull on SFTP.
/// Blocking on the first call.
pub fn rsync_version_local() -> Option<RsyncVersion> {
    static LOCAL: std::sync::OnceLock<Option<RsyncVersion>> = std::sync::OnceLock::new();
    *LOCAL.get_or_init(|| {
        let mut cmd = crate::paths::command_no_window("rsync");
        cmd.arg("--version").stdin(std::process::Stdio::null());
        let out = crate::paths::output_within(cmd, RSYNC_PROBE_TIMEOUT).ok()?;
        parse_rsync_version(&String::from_utf8_lossy(&out.stdout))
    })
}

/// How long the host's `rsync --version` may take, ssh's own connect included
/// (`ConnectTimeout=10`); riding the master it answers at once.
const RSYNC_HOST_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The host probe's stdout kept: far over `rsync --version` and a login
/// banner, a bound on a host that writes forever.
const RSYNC_HOST_PROBE_CAP: u64 = 64 * 1024;

/// The command the host probe runs, fixed: nothing of the host's or the
/// project's is in it. stderr is ssh's own pipe, so no redirect is needed
/// (a `2>/dev/null` is a syntax error under a csh login shell).
const RSYNC_HOST_PROBE: &str = "rsync --version";

/// The host's rsync version, cached per `user@host:port` for the process: the
/// pull's rsync runs `rsync --server` through the same non-interactive remote
/// shell, so this asks the same binary. An answer (a version, or none: missing,
/// openrsync, too old) is kept; an ssh failure or a probe past its deadline is
/// not, so the next pull asks again. A host upgraded later is seen after a
/// restart; one downgraded makes its pulls fail and fall back to SFTP, as
/// before (the argv always carries `--protect-args`). Blocking; call from
/// `spawn_blocking`.
pub fn rsync_version_host(spec: &crate::schema::project::RemoteSpec) -> Option<RsyncVersion> {
    type HostKey = (Option<String>, String, Option<u16>);
    static HOSTS: std::sync::OnceLock<std::sync::Mutex<HashMap<HostKey, Option<RsyncVersion>>>> =
        std::sync::OnceLock::new();
    let hosts = HOSTS.get_or_init(Default::default);
    let key = (spec.user.clone(), spec.host.clone(), spec.port);
    if let Some(known) = hosts.lock_ok().get(&key) {
        return *known;
    }
    let cmd = crate::services::ssh_exec::remote_shell_command(spec, RSYNC_HOST_PROBE).ok()?;
    let version = probe_rsync_version(cmd, RSYNC_HOST_PROBE_TIMEOUT).ok()?;
    hosts.lock_ok().insert(key, version);
    version
}

/// Run a host probe `cmd` bounded (`timeout`, [`RSYNC_HOST_PROBE_CAP`]; the
/// subtree is killed at either) and read its answer. `Err`: no answer to keep
/// — the probe did not finish, or ssh itself failed (255, or killed).
fn probe_rsync_version(mut cmd: std::process::Command, timeout: std::time::Duration) -> Result<Option<RsyncVersion>, ()> {
    let opts = crate::services::git_bounded::Opts {
        stdout_cap: Some(RSYNC_HOST_PROBE_CAP),
        timeout: Some(timeout),
        no_precheck: true,
        ..Default::default()
    };
    let ran = crate::services::git_bounded::run(&mut cmd, opts).map_err(|_| ())?;
    // A host that writes past the cap has answered; what it wrote first is read.
    // 255 is ssh's own failure (no master, link down), not the host's answer.
    if !ran.cut && matches!(ran.output.status.code(), Some(255) | None) {
        return Err(());
    }
    Ok(parse_rsync_version(&String::from_utf8_lossy(&ran.output.stdout)))
}

/// Cross-platform `command -v` check for a binary on `PATH`.
fn which_on_path(bin: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    crate::paths::command_no_window(probe)
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run a bulk rsync host→local PULL of `host_src_dir` (absolute host dir) into
/// `local_dest_dir`. Both get a trailing slash so the source's CONTENTS land in
/// dest. Best-effort fast-path: returns `Err` on any failure so the caller falls
/// back to the SFTP walker. Blocking shell-out, so call from `spawn_blocking`.
pub fn rsync_pull_dir(
    fast: RsyncFastPath,
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    host_src_dir: &str,
    local_dest_dir: &std::path::Path,
    files: &[String],
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(local_dest_dir).map_err(|e| e.to_string())?;
    let src = format!("{}/", host_src_dir.trim_end_matches('/'));
    let dest = format!(
        "{}/",
        local_dest_dir
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
    );
    let files_from = rsync_files_from(files)?;
    let args = rsync_pull_args(fast, user, host, port, &src, &dest, files_from.path());
    let out = crate::paths::command_no_window("rsync")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to launch rsync: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ── Push (local→remote), block-on-stale (Phase 2) ──────────────────────────

/// The decision for pushing one local file to the host, judged by re-stat'ing the
/// host and comparing to the manifest base (NEVER host-mtime vs local-mtime).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushDecision {
    /// The host still matches the base we recorded (or this path was created
    /// locally and never existed on the host) — safe to write.
    Safe,
    /// The host moved since the last sync, or a never-synced host file already
    /// exists — block and let the user resolve (keep local / take host / skip).
    Stale,
}

/// Decide whether pushing `entry`'s local file is safe given a fresh host re-stat
/// (`None` = the host path is gone). Conservative: anything that isn't provably
/// unchanged-since-base is `Stale`, so a push never silently clobbers a host
/// change. Pure, unit-tested.
///
/// (A content-hash tie-break to distinguish a real host edit from a bare `touch`
/// — the plan's optional `sha256sum` refinement — would need a base hash captured
/// at pull time; it is deferred. The conservative rule here never clobbers, it
/// only over-reports the touch case as a conflict the user clears with "keep
/// local".)
pub fn push_decision(entry: &SyncEntry, host: Option<(u64, Option<u64>)>) -> PushDecision {
    let ever_synced = entry.last_pull_ts.is_some() || entry.last_push_ts.is_some();
    match host {
        // Host gone: a change (deletion) if we'd synced it before; a plain create
        // otherwise.
        None => {
            if ever_synced {
                PushDecision::Stale
            } else {
                PushDecision::Safe
            }
        }
        Some((size, mtime)) => {
            if !ever_synced {
                // Never synced, yet the host already has this path → don't clobber.
                PushDecision::Stale
            } else if size == entry.host_size && mtime == entry.host_mtime {
                PushDecision::Safe
            } else {
                PushDecision::Stale
            }
        }
    }
}

/// Why a mirror file was left alone instead of being read for a push: the
/// mirror is writable by a fenced agent, so a path that was a regular file can
/// turn into a link to a host file the agent cannot see, a FIFO, or a giant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MirrorSkipKind {
    /// A link at the file or at a folder on the way to it.
    Link,
    /// A FIFO, socket, device or directory where a regular file was expected.
    Special,
    /// Over [`MAX_SYNC_FILE_BYTES`].
    TooLarge,
}

/// One mirror file left out of a push, as the per-project notice names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MirrorSkip {
    pub rel: String,
    pub kind: MirrorSkipKind,
    /// The size, for [`MirrorSkipKind::TooLarge`].
    pub size: Option<u64>,
}

impl std::fmt::Display for MirrorSkip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.kind {
            MirrorSkipKind::Link => write!(f, "'{}' is a symlink (or sits behind one) in the local mirror; not pushed", self.rel),
            MirrorSkipKind::Special => write!(f, "'{}' is not a regular file in the local mirror; not pushed", self.rel),
            MirrorSkipKind::TooLarge => write!(
                f,
                "'{}' is too large to sync ({} bytes; limit {MAX_SYNC_FILE_BYTES})",
                self.rel,
                self.size.unwrap_or(0)
            ),
        }
    }
}

/// The lstat of a mirror file, for the divergence judgement.
#[derive(Debug)]
pub enum MirrorStat {
    Missing,
    File(std::fs::Metadata),
    Skip(MirrorSkipKind),
}

/// `lstat` of project-relative `rel` under `root`, never through a link: a link
/// at the file or at any folder above it is [`MirrorStat::Skip`], never the
/// target's metadata. A judgement only — the bytes are read through
/// [`read_mirror_file`].
pub fn mirror_lstat(root: &Path, rel: &str) -> Result<MirrorStat, String> {
    let parts = rel_components(rel)?;
    if parts.is_empty() {
        return Err(format!("refusing '{rel}': no file name inside the local mirror"));
    }
    if first_symlink_component(root, &parts).map_err(|e| e.to_string())?.is_some() {
        return Ok(MirrorStat::Skip(MirrorSkipKind::Link));
    }
    let path = parts.iter().fold(root.to_path_buf(), |p, part| p.join(part));
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_file() => Ok(MirrorStat::File(m)),
        Ok(m) if m.file_type().is_symlink() => Ok(MirrorStat::Skip(MirrorSkipKind::Link)),
        Ok(_) => Ok(MirrorStat::Skip(MirrorSkipKind::Special)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(MirrorStat::Missing),
        Err(e) => Err(e.to_string()),
    }
}

/// What [`read_mirror_file`] found.
#[derive(Debug)]
pub enum MirrorRead {
    Missing,
    Skip(MirrorSkipKind, Option<u64>),
    /// The bytes and the `(size, mtime)` of the opened handle they came from.
    File { bytes: Vec<u8>, meta: (u64, Option<u64>) },
}

/// Read mirror file `rel` for a push through ONE held handle: the folders are
/// opened by handle without following a link (`home_io::HomeFile`), the file
/// with `O_NOFOLLOW | O_NONBLOCK`, and "regular" and the
/// [`MAX_SYNC_FILE_BYTES`] cap are judged on the opened inode — so a swap after
/// the walk (leaf or folder turned into a link, a FIFO) reads nothing. Blocking:
/// call from `spawn_blocking`.
pub fn read_mirror_file(root: &Path, rel: &str) -> Result<MirrorRead, String> {
    use std::io::Read;
    use crate::services::home_io::HomeFile;
    let parts = rel_components(rel)?;
    let Some((_, dirs)) = parts.split_last() else {
        return Err(format!("refusing '{rel}': no file name inside the local mirror"));
    };
    #[cfg(unix)]
    if rel.contains('\\') {
        return Err(format!("'{rel}' has a backslash in its name; not pushed"));
    }
    let joined = parts.iter().filter_map(|p| p.to_str()).collect::<Vec<_>>().join("/");
    let Some(handle) = HomeFile::open_existing(root, &joined) else {
        return Ok(match first_symlink_component(root, dirs) {
            Ok(Some(_)) => MirrorRead::Skip(MirrorSkipKind::Link, None),
            _ => MirrorRead::Missing,
        });
    };
    let kind_now = |h: &HomeFile| match h.lstat() {
        Ok(m) if m.is_symlink => Ok(Some(MirrorSkipKind::Link)),
        Ok(m) if m.is_file => Ok(None),
        Ok(_) => Ok(Some(MirrorSkipKind::Special)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(None),
        Err(e) => Err(Some(e.to_string())),
    };
    match kind_now(&handle) {
        Ok(Some(kind)) => return Ok(MirrorRead::Skip(kind, None)),
        Ok(None) => {}
        Err(None) => return Ok(MirrorRead::Missing),
        Err(Some(e)) => return Err(e),
    }
    let Some(file) = handle.open_read() else {
        return match kind_now(&handle) {
            Ok(Some(kind)) => Ok(MirrorRead::Skip(kind, None)),
            Ok(None) => Err(format!("could not open '{rel}' in the local mirror")),
            Err(None) => Ok(MirrorRead::Missing),
            Err(Some(e)) => Err(e),
        };
    };
    let fmeta = file.metadata().map_err(|e| e.to_string())?;
    if fmeta.len() > MAX_SYNC_FILE_BYTES {
        return Ok(MirrorRead::Skip(MirrorSkipKind::TooLarge, Some(fmeta.len())));
    }
    let mut bytes = Vec::with_capacity(fmeta.len() as usize);
    file.take(MAX_SYNC_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
        return Ok(MirrorRead::Skip(MirrorSkipKind::TooLarge, Some(bytes.len() as u64)));
    }
    Ok(MirrorRead::File { bytes, meta: local_meta(&fmeta) })
}

/// Why a push of one file did not happen.
#[derive(Debug)]
pub enum PushError {
    /// The mirror file is a link, special or too large: noted per project.
    Skipped(MirrorSkip),
    Failed(String),
}

impl From<String> for PushError {
    fn from(e: String) -> Self {
        PushError::Failed(e)
    }
}

impl std::fmt::Display for PushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PushError::Skipped(skip) => skip.fmt(f),
            PushError::Failed(e) => f.write_str(e),
        }
    }
}

/// The bases a push leaves: the host's after the write, the mirror's from the
/// handle the bytes were read from.
#[derive(Debug, Clone, Copy)]
pub struct PushedFile {
    pub host: (u64, Option<u64>),
    pub local: (u64, Option<u64>),
}

/// The files left out of pushes for one project, as the UI shows them: the
/// newest [`MIRROR_SKIPS_SHOWN`] and the real count.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct MirrorSkips {
    pub total: usize,
    pub items: Vec<MirrorSkip>,
}

const MIRROR_SKIPS_SHOWN: usize = 20;
const MIRROR_SKIPS_KEPT: usize = 1000;

type MirrorSkipMap = HashMap<String, std::collections::BTreeMap<String, MirrorSkip>>;

fn mirror_skip_map() -> std::sync::MutexGuard<'static, MirrorSkipMap> {
    static SKIPS: std::sync::OnceLock<std::sync::Mutex<MirrorSkipMap>> = std::sync::OnceLock::new();
    SKIPS.get_or_init(Default::default).lock_ok()
}

/// Record a skipped mirror file for `project_id`; `true` when that changed what
/// the notice says.
pub fn note_mirror_skip(project_id: &str, skip: MirrorSkip) -> bool {
    let mut map = mirror_skip_map();
    let files = map.entry(project_id.to_string()).or_default();
    if files.get(&skip.rel) == Some(&skip) {
        return false;
    }
    if files.len() >= MIRROR_SKIPS_KEPT && !files.contains_key(&skip.rel) {
        return false;
    }
    files.insert(skip.rel.clone(), skip);
    true
}

/// Forget `rel` once it is an ordinary file again (or gone); `true` when it was
/// noted.
pub fn clear_mirror_skip(project_id: &str, rel: &str) -> bool {
    let mut map = mirror_skip_map();
    let Some(files) = map.get_mut(project_id) else { return false };
    let had = files.remove(rel).is_some();
    if files.is_empty() {
        map.remove(project_id);
    }
    had
}

/// The project's current notice.
pub fn mirror_skips(project_id: &str) -> MirrorSkips {
    let map = mirror_skip_map();
    let Some(files) = map.get(project_id) else { return MirrorSkips::default() };
    MirrorSkips { total: files.len(), items: files.values().take(MIRROR_SKIPS_SHOWN).cloned().collect() }
}

/// Push one local mirror file to the host atomically: write the bytes to a temp
/// path beside the target, then `rename_on` over it (so a reader never sees a
/// half-written file). The caller has already decided this is `Safe`. The bytes
/// come from [`read_mirror_file`] (one held handle, no link on the way, capped,
/// off the runtime thread); a link, special file or giant is
/// [`PushError::Skipped`]. Returns the host (size, mtime) base captured after
/// the write and the mirror's from the read handle.
pub async fn push_file_atomic(
    sftp: &openssh_sftp_client::Sftp,
    mirror_root: &Path,
    rel: &str,
    host_abs: &str,
) -> Result<PushedFile, PushError> {
    let (root, rel_owned) = (mirror_root.to_path_buf(), rel.to_string());
    let read = app_core::rt::spawn_blocking(move || read_mirror_file(&root, &rel_owned))
        .await
        .map_err(|e| PushError::Failed(e.to_string()))??;
    let (bytes, local) = match read {
        MirrorRead::File { bytes, meta } => (bytes, meta),
        MirrorRead::Missing => return Err(PushError::Failed(format!("'{rel}' is gone from the local mirror"))),
        MirrorRead::Skip(kind, size) => {
            return Err(PushError::Skipped(MirrorSkip { rel: rel.to_string(), kind, size }));
        }
    };
    // Temp path beside the target (same dir → same filesystem → atomic rename).
    // The suffix must be UNIQUE per in-flight write: the manifest lock is held only
    // per file (not for a whole push), so a manual `sync_push` and a background
    // `reconcile_pass` — or two manual pushes — can be writing the same file at
    // once, and a fixed temp name lets one push rename the tmp out from under the
    // other (the loser's rename then fails on a vanished source). A process-wide
    // counter plus the pid keeps every concurrent write on its own tmp.
    let seq = {
        use std::sync::atomic::{AtomicU64, Ordering};
        static PUSH_TMP_SEQ: AtomicU64 = AtomicU64::new(0);
        PUSH_TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    };
    let tmp = format!("{host_abs}.{SLUG}-sync-tmp.{}.{seq}", std::process::id());
    sftp::write_file_on(sftp, &tmp, &bytes).await?;
    sftp::rename_on(sftp, &tmp, host_abs).await?;
    // Re-stat the host to capture the new base (mtime is the host's, post-write).
    // The bytes DID land by this point — this error exists because recording a
    // made-up base of (len, None) guarantees a false amber on the next status
    // pass, while an unrecorded base only degrades to a conflict prompt (the
    // safe direction). One retry covers a transient hiccup on the pooled session.
    let host = match sftp::metadata_on(sftp, host_abs).await {
        Ok(hm) => hm,
        Err(_) => sftp::metadata_on(sftp, host_abs).await.map_err(|e| {
            PushError::Failed(format!("pushed '{host_abs}' but could not re-stat it to record the new base: {e}"))
        })?,
    };
    Ok(PushedFile { host, local })
}

/// Record a freshly-pushed file in the manifest: keep it selected and stamp the
/// new host + local bases and the push timestamp.
pub fn record_push(
    manifest: &mut Manifest,
    rel: &str,
    host_size: u64,
    host_mtime: Option<u64>,
    local_size: u64,
    local_mtime: Option<u64>,
) {
    let entry = manifest.entry(rel.to_string()).or_default();
    entry.selected = true;
    entry.is_dir = false;
    entry.host_size = host_size;
    entry.host_mtime = host_mtime;
    entry.local_size = local_size;
    entry.local_mtime = local_mtime;
    entry.last_push_ts = Some(now_secs());
}

/// Recursively collect the project-relative paths of regular FILES in the local
/// mirror under `rel` (lstat-typed; symlinks skipped, mirroring the host walker's
/// G3 stance). `rel` "" walks the whole mirror. Returns paths relative to the
/// mirror root with forward slashes.
pub fn walk_mirror_files(project_id: &str, rel: &str) -> Result<Vec<String>, String> {
    let root = mirror_dir(project_id);
    let start = mirror_local_path(project_id, rel);
    let mut out = Vec::new();
    // A single file selected directly.
    let lmeta = std::fs::symlink_metadata(&start);
    match lmeta {
        Ok(m) if m.file_type().is_file() => {
            if let Some(r) = rel_under(&root, &start) {
                out.push(r);
            }
            Ok(out)
        }
        Ok(m) if m.file_type().is_dir() => {
            walk_mirror_inner(&root, &start, &mut out)?;
            Ok(out)
        }
        // Missing / symlink / special → nothing to push.
        _ => Ok(out),
    }
}

fn walk_mirror_inner(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    // #23 D2, the mirror side of the same boundary: a subdirectory holding a `.git`
    // entry of either kind (a nested repo's directory, a linked worktree's *file*) is
    // not this project's bytes to push. `symlink_metadata` so a `.git` symlink counts
    // as present without being followed.
    if dir != root && std::fs::symlink_metadata(dir.join(".git")).is_ok() {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue; // G3: never follow symlinks out of the mirror
        }
        // `.git`/`.tabtivity` are never byte-mirrored (git is kept in step semantically
        // by `services::git_peer`; `.tabtivity` is Tabtivity's own runtime dir).
        if entry.file_name() == *".git" || entry.file_name().to_str().is_some_and(crate::brand::is_project_dir) {
            continue;
        }
        if ft.is_dir() {
            walk_mirror_inner(root, &path, out)?;
        } else if ft.is_file() {
            if let Some(r) = rel_under(root, &path) {
                out.push(r);
            }
        }
    }
    Ok(())
}

/// The forward-slash path of `path` relative to `root`, or `None` if not inside.
fn rel_under(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// G7 across processes: a manifest the other process (window or desktop
    /// sidecar) rewrote since this one cached it is never overwritten from the
    /// stale copy, and the cache reads the new version next.
    #[test]
    fn a_manifest_changed_by_another_process_is_not_clobbered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p").join("sync.json");
        let mut cache = HashMap::new();
        ensure_loaded_at(&mut cache, "p", &path).insert("a".into(), SyncEntry::default());
        save_manifest_at(&path, &cache["p"]).expect("ours to write");
        ensure_loaded_at(&mut cache, "p", &path).insert("b".into(), SyncEntry::default());
        save_manifest_at(&path, &cache["p"]).expect("still ours: we wrote the last version");
        // The other process writes its own version.
        let theirs: Manifest = [("theirs-is-longer".to_string(), SyncEntry::default())].into_iter().collect();
        std::fs::write(&path, serde_json::to_string_pretty(&theirs).unwrap()).unwrap();
        cache.get_mut("p").unwrap().insert("c".into(), SyncEntry::default());
        assert_eq!(save_manifest_at(&path, &cache["p"]).unwrap_err(), CHANGED_ELSEWHERE);
        let on_disk: Manifest = crate::storage::read_json(&path).unwrap();
        assert!(on_disk.contains_key("theirs-is-longer") && !on_disk.contains_key("c"));
        let fresh = ensure_loaded_at(&mut cache, "p", &path);
        assert!(fresh.contains_key("theirs-is-longer") && !fresh.contains_key("a"), "re-read, not the stale copy");
        fresh.insert("d".into(), SyncEntry::default());
        save_manifest_at(&path, &cache["p"]).expect("current again");
    }

    /// An unparseable `sync.json` is never read as "nothing selected" and then
    /// replaced: the cache stands in an empty manifest, every save refuses, the
    /// bytes are kept beside it, and a repaired (here: removed) file syncs again.
    #[test]
    fn an_unreadable_manifest_is_kept_and_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p").join("sync.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let damaged = b"{\"notes.md\": {\"selected\": tr";
        std::fs::write(&path, damaged).unwrap();

        let err = check_manifest_readable_at(&path).unwrap_err();
        assert!(err.contains("could not be read"), "{err}");
        let mut cache = HashMap::new();
        let m = ensure_loaded_at(&mut cache, "p", &path);
        assert!(m.is_empty(), "stands in as empty for the callers holding a &mut");
        m.insert("other".into(), SyncEntry::default());
        assert!(save_manifest_at(&path, &cache["p"]).is_err(), "never replaces the damaged file");
        assert!(save_or_mark_stale_at(&path, cache.get_mut("p").unwrap(), &["other".to_string()]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), damaged);
        let kept: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("sync.json.unreadable-"))
            .collect();
        assert_eq!(kept.len(), 1, "one copy per damaged version");
        assert_eq!(std::fs::read(&kept[0]).unwrap(), damaged);
        assert!(check_manifest_readable_at(&path).is_err(), "still refused");

        std::fs::remove_file(&path).unwrap();
        check_manifest_readable_at(&path).expect("a positively missing file starts empty");
        let m = ensure_loaded_at(&mut cache, "p", &path);
        m.insert("fresh".into(), SyncEntry::default());
        save_manifest_at(&path, &cache["p"]).expect("writable again once removed");
    }

    /// Fixed decision #7: a pull or push whose record fails to save must never
    /// leave a base that reads clean or lets a push through unasked. Here the
    /// other process wrote `sync.json` meanwhile (the CAS refusal): the save
    /// fails, the record is forgotten in the cache AND on disk, and the re-read
    /// entry is amber against the post-transfer stats with a push that asks.
    #[test]
    fn a_failed_manifest_save_after_a_transfer_never_reads_clean() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p").join("sync.json");
        let old_base = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        let mut cache = HashMap::new();
        ensure_loaded_at(&mut cache, "p", &path).insert("f".into(), old_base.clone());
        save_manifest_at(&path, &cache["p"]).unwrap();
        // The other process writes its own version (same old base for `f`).
        let theirs: Manifest = [("f".to_string(), old_base.clone()), ("theirs".to_string(), SyncEntry::default())]
            .into_iter()
            .collect();
        std::fs::write(&path, serde_json::to_string_pretty(&theirs).unwrap()).unwrap();
        // A pull landed new bytes: host (20, 200), mirror (20, 201).
        let host_now = Some((20, Some(200)));
        let local_now = Some((20, Some(201)));
        let m = cache.get_mut("p").unwrap();
        record_pull(m, "f", 20, Some(200), 20, Some(201));
        let err = save_or_mark_stale_at(&path, m, &["f".to_string()]).unwrap_err();
        assert_eq!(err, CHANGED_ELSEWHERE);
        // The caller's copy no longer vouches for the record.
        assert_eq!(compute_state(&m["f"], host_now, local_now, false), SyncState::Amber);
        assert_eq!(push_decision(&m["f"], host_now), PushDecision::Stale);
        // Nor does the file, re-read through the cache; the other process's
        // entries survive.
        let fresh = ensure_loaded_at(&mut cache, "p", &path);
        assert!(fresh.contains_key("theirs"), "their version was kept, not clobbered");
        let f = &fresh["f"];
        assert!(f.selected && f.last_pull_ts.is_some(), "the user's choices and history stay");
        assert_eq!(compute_state(f, host_now, local_now, false), SyncState::Amber);
        assert_eq!(push_decision(f, host_now), PushDecision::Stale);
        // Even the pre-transfer stats do not match a forgotten base (the old
        // base would have read green against them).
        assert_eq!(compute_state(f, Some((10, Some(100))), Some((10, Some(100))), false), SyncState::Amber);
        // A later successful save goes through as usual.
        record_pull(fresh, "f", 20, Some(200), 20, Some(201));
        save_or_mark_stale_at(&path, fresh, &["f".to_string()]).expect("current again");
        assert_eq!(compute_state(&cache["p"]["f"], host_now, local_now, false), SyncState::Green);
    }

    /// The same when the file cannot be written at all: the in-memory record is
    /// forgotten and the cache re-derives from disk instead of trusting it.
    #[test]
    fn an_unwritable_manifest_forgets_the_unsaved_record() {
        let dir = tempfile::tempdir().unwrap();
        // The state dir is a FILE, so neither the save nor the marking can write.
        let blocker = dir.path().join("p");
        std::fs::write(&blocker, b"not a dir").unwrap();
        let path = blocker.join("sync.json");
        let mut cache = HashMap::new();
        let m = ensure_loaded_at(&mut cache, "p", &path);
        record_push(m, "f", 20, Some(200), 20, Some(201));
        assert!(save_or_mark_stale_at(&path, m, &["f".to_string()]).is_err());
        let host_now = Some((20, Some(200)));
        assert_eq!(compute_state(&m["f"], host_now, Some((20, Some(201))), false), SyncState::Amber);
        assert_eq!(push_decision(&m["f"], host_now), PushDecision::Stale);
        assert!(!stamps().contains_key(&path), "the cache re-reads the file next time");
    }

    /// The SFTP pull used to leave every mirror file at the staging temp file's
    /// 0600: a host `0755` script lost its executable bit (rsync's path kept it).
    #[cfg(unix)]
    #[tokio::test]
    async fn an_sftp_pull_keeps_the_host_files_mode() {
        use std::os::unix::fs::PermissionsExt;
        let mirror = tempfile::tempdir().unwrap();
        let mode_of = |rel: &str| std::fs::metadata(mirror.path().join(rel)).unwrap().permissions().mode() & 0o7777;
        let umask = process_umask();
        let pull = |rel: &'static str, mode: Option<u32>| {
            pull_file_with(rel, 3, mode, mirror.path(), rel, || async { Ok(b"#!x".to_vec()) })
        };
        pull("run.sh", Some(0o755)).await.unwrap();
        assert_eq!(mode_of("run.sh"), 0o755 & !umask);
        assert_eq!(mode_of("run.sh") & 0o100, 0o100, "the owner can still execute it");
        pull("data.txt", Some(0o644)).await.unwrap();
        assert_eq!(mode_of("data.txt"), 0o644 & !umask);
        // A re-pull with the host's new mode applies it to the existing copy.
        pull("data.txt", Some(0o755)).await.unwrap();
        assert_eq!(mode_of("data.txt"), 0o755 & !umask);
        // No host mode: the existing mirror file's own mode is kept exactly …
        std::fs::set_permissions(mirror.path().join("data.txt"), std::fs::Permissions::from_mode(0o750)).unwrap();
        pull("data.txt", None).await.unwrap();
        assert_eq!(mode_of("data.txt"), 0o750);
        // … and a new file gets the umask default, not 0600.
        pull("new.txt", None).await.unwrap();
        assert_eq!(mode_of("new.txt"), 0o666 & !umask);
        assert_eq!(std::fs::read(mirror.path().join("run.sh")).unwrap(), b"#!x");
    }

    /// M4b review: the host is attacker-controlled, so its setuid/setgid/sticky
    /// bits never reach the mirror (rsync without `-p` drops them too). `open(2)`
    /// honours them in the create mode; only a later write by an unprivileged
    /// process clears setuid/setgid — an empty file (no write) or a privileged
    /// process kept a planted `06755`. Nor does a local special bit survive a
    /// replacement whose bytes are the host's.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_sftp_pull_never_applies_the_hosts_special_mode_bits() {
        use std::os::unix::fs::PermissionsExt;
        let mirror = tempfile::tempdir().unwrap();
        let mode_of = |rel: &str| std::fs::metadata(mirror.path().join(rel)).unwrap().permissions().mode() & 0o7777;
        let umask = process_umask();
        let empty = |rel: &'static str, mode: Option<u32>| {
            pull_file_with(rel, 0, mode, mirror.path(), rel, || async { Ok(Vec::new()) })
        };
        empty("planted", Some(0o6755)).await.unwrap();
        assert_eq!(mode_of("planted") & 0o7000, 0, "no setuid/setgid/sticky from the host");
        assert_eq!(mode_of("planted"), 0o755 & !umask);
        pull_file_with("sticky", 3, Some(0o1777), mirror.path(), "sticky", || async { Ok(b"abc".to_vec()) })
            .await
            .unwrap();
        assert_eq!(mode_of("sticky") & 0o7000, 0);
        // A kept local mode carries its permission bits, not a special bit.
        std::fs::set_permissions(mirror.path().join("planted"), std::fs::Permissions::from_mode(0o4750)).unwrap();
        empty("planted", None).await.unwrap();
        assert_eq!(mode_of("planted"), 0o750);
    }

    /// This process's umask, read without changing it (Linux `/proc`; the usual
    /// `022` elsewhere).
    #[cfg(unix)]
    fn process_umask() -> u32 {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find_map(|l| l.strip_prefix("Umask:"))
                    .and_then(|v| u32::from_str_radix(v.trim(), 8).ok())
            })
            .unwrap_or(0o022)
    }

    /// #23 D2. Both walkers skipped the entry *named* `.git`, which correctly skips a
    /// linked worktree's `.git` FILE — but the checkout around it is not named `.git`
    /// and was walked like ordinary content. A worktree inside the project was
    /// therefore mirrored as a full second copy of the source tree: every pass
    /// doubled, the copy counted in the big-folder census, and it landed on the peer
    /// as a plain directory with no `.git` at all, which then drifted.
    #[test]
    fn the_mirror_walk_stops_at_a_nested_repo_or_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("src.rs"), b"x").unwrap();

        // A linked worktree: `.git` is a FILE holding `gitdir: …`.
        let wt = root.join("wt-feature");
        std::fs::create_dir_all(wt.join("deep")).unwrap();
        std::fs::write(
            wt.join(".git"),
            b"gitdir: /elsewhere/.git/worktrees/feature",
        )
        .unwrap();
        std::fs::write(wt.join("deep/copy.rs"), b"x").unwrap();

        // A nested clone: `.git` is a DIRECTORY.
        let nested = root.join("vendor/lib");
        std::fs::create_dir_all(nested.join(".git")).unwrap();
        std::fs::write(nested.join("lib.rs"), b"x").unwrap();

        let mut out = Vec::new();
        walk_mirror_inner(root, root, &mut out).unwrap();
        out.sort();
        assert_eq!(
            out,
            vec!["src.rs".to_string()],
            "only the project's own files; the walk stops at any .git boundary"
        );
    }

    #[test]
    fn the_mirror_walk_does_not_stop_at_the_project_root_itself() {
        // The root of course holds a `.git` — the boundary is a check on
        // SUBdirectories, or every project would sync nothing at all.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("a.txt"), b"x").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/b.txt"), b"x").unwrap();

        let mut out = Vec::new();
        walk_mirror_inner(root, root, &mut out).unwrap();
        out.sort();
        assert_eq!(out, vec!["a.txt".to_string(), "sub/b.txt".to_string()]);
    }

    fn excluded_dir() -> SyncEntry {
        SyncEntry {
            is_dir: true,
            excluded: true,
            auto_off: true,
            ..Default::default()
        }
    }

    #[test]
    fn exclusion_covers_the_subtree_of_a_whole_project_transfer() {
        let mut m = Manifest::new();
        m.insert(
            "".into(),
            SyncEntry {
                is_dir: true,
                auto_sync: true,
                ..Default::default()
            },
        );
        m.insert("data".into(), excluded_dir());
        assert!(is_excluded(&m, "data/raw/big.bin", ""));
        assert!(!is_excluded(&m, "src/main.rs", ""));
        // …and the background engine agrees, so the two transports can't disagree.
        assert!(!is_auto(&m, "data/raw/big.bin"));
        assert!(is_auto(&m, "src/main.rs"));
    }

    #[test]
    fn explicitly_transferring_the_excluded_folder_overrides_its_own_marker() {
        let mut m = Manifest::new();
        m.insert("data".into(), excluded_dir());
        // Whole-project pull: skipped. Right-clicking `data` itself: honoured.
        assert!(is_excluded(&m, "data/big.bin", ""));
        assert!(!is_excluded(&m, "data/big.bin", "data"));
        // A nested exclusion inside it is still honoured — only the requested
        // path's own marker is waived.
        m.insert("data/raw".into(), excluded_dir());
        assert!(is_excluded(&m, "data/raw/big.bin", "data"));
    }

    #[test]
    fn explicitly_transferring_a_folder_inside_an_excluded_tree_overrides_its_ancestors() {
        let mut m = Manifest::new();
        m.insert("data".into(), excluded_dir());
        m.insert("data/raw/cache".into(), excluded_dir());
        // Downloading `data/raw` for an agent: the inherited exclusion is waived…
        assert!(!is_excluded(&m, "data/raw/big.bin", "data/raw"));
        assert!(!is_excluded(&m, "data/raw/big.bin", "data/raw/big.bin"));
        // …one nested below it is not, and a sibling outside it stays excluded.
        assert!(is_excluded(&m, "data/raw/cache/x.bin", "data/raw"));
        assert!(is_excluded(&m, "data/other/x.bin", "data/raw"));
        // A prefix that is not a path segment is not "inside".
        assert!(is_excluded(&m, "data/rawer/x.bin", "data/raw"));
    }

    #[test]
    fn a_nearer_auto_marker_re_includes_a_folder_inside_an_excluded_tree() {
        let mut m = Manifest::new();
        m.insert("data".into(), excluded_dir());
        m.insert(
            "data/small".into(),
            SyncEntry {
                is_dir: true,
                auto_sync: true,
                selected: true,
                ..Default::default()
            },
        );
        assert!(!is_excluded(&m, "data/small/notes.md", ""));
        assert!(is_excluded(&m, "data/raw/big.bin", ""));
    }

    #[test]
    fn push_decision_safe_when_host_matches_base() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        assert_eq!(push_decision(&e, Some((10, Some(100)))), PushDecision::Safe);
    }

    #[test]
    fn push_decision_stale_when_host_moved() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        assert_eq!(
            push_decision(&e, Some((11, Some(100)))),
            PushDecision::Stale
        );
        assert_eq!(
            push_decision(&e, Some((10, Some(200)))),
            PushDecision::Stale
        );
    }

    #[test]
    fn push_decision_create_safe_when_never_synced_and_host_absent() {
        let e = SyncEntry {
            selected: true,
            ..Default::default()
        };
        assert_eq!(push_decision(&e, None), PushDecision::Safe);
    }

    #[test]
    fn push_decision_stale_when_never_synced_but_host_exists() {
        // A local file the user wants to push, but the host already has an
        // unsynced file there — don't clobber blindly.
        let e = SyncEntry {
            selected: true,
            ..Default::default()
        };
        assert_eq!(push_decision(&e, Some((5, Some(3)))), PushDecision::Stale);
    }

    #[test]
    fn push_decision_stale_when_host_deleted_after_sync() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        assert_eq!(push_decision(&e, None), PushDecision::Stale);
    }

    fn v(major: u32, minor: u32) -> Option<RsyncVersion> {
        Some(RsyncVersion { major, minor })
    }

    /// A fast-path proof, as the probes give one for two 3.x rsyncs.
    fn fast() -> RsyncFastPath {
        rsync_fast_path(v(3, 2), v(3, 4)).unwrap()
    }

    #[test]
    fn rsync_version_parses_samba_rsync() {
        assert_eq!(parse_rsync_version("rsync  version 3.2.7  protocol version 31\nCopyright (C) 1996-2022\n"), v(3, 2));
        assert_eq!(parse_rsync_version("rsync  version v3.4.1  protocol version 32\n"), v(3, 4));
        assert_eq!(parse_rsync_version("rsync  version 3.0.0pre1  protocol version 30\n"), v(3, 0));
        assert_eq!(parse_rsync_version("rsync  version 2.6.9  protocol version 29\n"), v(2, 6));
        // A login banner the host's shell prints first is skipped.
        assert_eq!(parse_rsync_version("Welcome to the cluster\nrsync  version 3.1.3  protocol version 31\n"), v(3, 1));
    }

    #[test]
    fn rsync_version_refuses_openrsync_and_garbage() {
        assert_eq!(parse_rsync_version("openrsync: protocol version 29\n"), None);
        // macOS 15's /usr/bin/rsync: openrsync, whatever it claims to match.
        assert_eq!(parse_rsync_version("openrsync: protocol version 29\nrsync version 2.6.9 compatible\n"), None);
        assert_eq!(parse_rsync_version("openrsync: protocol version 29\nrsync  version 3.0.0  protocol version 30\n"), None);
        for garbage in [
            "",
            "\n",
            "sh: rsync: command not found\n",
            "rsync version 2.6.9 compatible\n",
            "rsync  version   protocol version 31\n",
            "rsync  version x.y  protocol version 31\n",
            "rsync  version 3  protocol version 31\n",
            "my rsync  version 3.2.7  protocol version 31\n",
        ] {
            assert_eq!(parse_rsync_version(garbage), None, "{garbage:?}");
        }
    }

    /// The fast path needs `--protect-args` on BOTH ends; either side older
    /// than 3.0, openrsync, missing or unprobed keeps the pull on SFTP.
    #[cfg(unix)]
    fn sh_probe(script: &str) -> std::process::Command {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", script]);
        cmd
    }

    /// The host probe is bounded: a host that writes forever is cut at the cap
    /// and a hung one stopped at the deadline, neither cached; ssh's own 255 is
    /// no answer, a host without rsync (127) is one.
    #[cfg(unix)]
    #[test]
    fn rsync_host_probe_is_bounded_and_keeps_only_answers() {
        use std::time::Duration;
        let answer = sh_probe("echo 'rsync  version 3.2.7  protocol version 31'");
        assert_eq!(probe_rsync_version(answer, Duration::from_secs(10)), Ok(v(3, 2)));
        assert_eq!(probe_rsync_version(sh_probe("echo nope >&2; exit 127"), Duration::from_secs(10)), Ok(None));
        assert_eq!(probe_rsync_version(sh_probe("exit 255"), Duration::from_secs(10)), Err(()));

        let started = std::time::Instant::now();
        assert_eq!(probe_rsync_version(sh_probe("while :; do echo rsync; done"), Duration::from_secs(30)), Ok(None));
        assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());

        let started = std::time::Instant::now();
        assert_eq!(probe_rsync_version(sh_probe("sleep 30"), Duration::from_millis(300)), Err(()));
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    }

    /// The host probe runs one fixed command, with no redirect a csh login
    /// shell would reject.
    #[test]
    fn rsync_host_probe_is_a_fixed_command() {
        assert_eq!(RSYNC_HOST_PROBE, "rsync --version");
    }

    /// CRLF output (a Windows-side or odd host shell) and a `v` prefix parse.
    #[test]
    fn rsync_version_parses_crlf_output() {
        assert_eq!(parse_rsync_version("rsync  version v3.2.7  protocol version 31\r\nCopyright\r\n"), v(3, 2));
    }

    #[test]
    fn rsync_fast_path_needs_protect_args_on_both_ends() {
        assert!(rsync_fast_path(v(3, 0), v(3, 0)).is_some());
        assert!(rsync_fast_path(v(3, 4), v(4, 0)).is_some());
        let openrsync = parse_rsync_version("openrsync: protocol version 29\n");
        let old = parse_rsync_version("rsync  version 2.6.9  protocol version 29\n");
        for (local, host) in [(old, v(3, 2)), (v(3, 2), old), (openrsync, v(3, 2)), (v(3, 2), openrsync), (None, v(3, 2)), (v(3, 2), None), (None, None)] {
            assert_eq!(rsync_fast_path(local, host), None, "{local:?} / {host:?}");
        }
    }

    #[test]
    fn rsync_transport_rides_controlmaster() {
        let e = rsync_ssh_transport(None);
        assert!(e.starts_with("ssh "));
        assert!(e.contains("ControlMaster=no"));
        assert!(e.contains("ControlPath="));
        assert!(e.contains("cm-%C"));
        // Port absent → no -p.
        assert!(!e.contains(" -p "));
    }

    #[test]
    fn rsync_transport_includes_port() {
        let e = rsync_ssh_transport(Some(2222));
        assert!(e.contains(" -p 2222"));
    }

    #[test]
    fn rsync_pull_args_build_target_and_flags() {
        let files_from = Path::new(concat!("/tmp/", crate::app_slug!(), "-rsync-files"));
        let args = rsync_pull_args(
            fast(),
            &Some("alice".to_string()),
            "host.example",
            None,
            "/srv/p/",
            "/local/mirror/",
            files_from,
        );
        assert_eq!(args[0], "-t");
        assert_eq!(args[1], "-c");
        // Gap 35: nothing beyond what the SFTP floor lands — no archive mode
        // (links, perms, owner, group, devices, specials), no recursion past
        // the list, and the floor's size cap.
        for banned in ["-a", "--archive", "-r", "--recursive", "-l", "--links", "-D", "-p", "-o", "-g"] {
            assert!(!args.iter().any(|arg| arg == banned), "{banned} in {args:?}");
        }
        assert!(!args.iter().any(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg.len() > 2),
            "no bundled short flags may smuggle in archive or recursion: {args:?}");
        assert!(args.iter().any(|arg| arg == "--no-links"));
        assert!(args.iter().any(|arg| arg == "--no-devices"));
        assert!(args.iter().any(|arg| arg == "--no-specials"));
        assert!(args.iter().any(|arg| *arg == format!("--max-size={MAX_SYNC_FILE_BYTES}")));
        assert!(args.iter().any(|arg| arg == "--exclude=/.git"));
        assert!(args.iter().any(|arg| arg == "--exclude=.git"));
        assert!(args.iter().any(|arg| arg == concat!("--exclude=.", crate::app_slug!())));
        assert!(args.iter().any(|arg| arg == "--from0"));
        assert!(args
            .iter()
            .any(|arg| arg == concat!("--files-from=/tmp/", crate::app_slug!(), "-rsync-files")));
        let transport = args.iter().position(|arg| arg == "-e").unwrap();
        assert!(args[transport + 1].contains("ControlPath="));
        assert_eq!(args[transport + 2], "alice@host.example:/srv/p/");
        assert_eq!(args[transport + 3], "/local/mirror/");
    }

    /// The PATH's `rsync` is the samba one at 3.0 or later (`--protect-args`):
    /// macOS's 2.6.9 and openrsync lack it, so the fast path never runs there.
    #[cfg(unix)]
    fn samba_rsync_3() -> bool {
        let Ok(out) = std::process::Command::new("rsync").arg("--version").output() else { return false };
        parse_rsync_version(&String::from_utf8_lossy(&out.stdout)).is_some_and(|v| v >= RSYNC_PROTECT_ARGS_SINCE)
    }

    /// rsync splits `-e` on spaces outside quotes and doubles a `'` inside
    /// them: a ControlPath under a dir with a space or apostrophes reaches ssh
    /// as one word, unchanged. Checked through the real rsync, with a stand-in
    /// `ssh` that records its argv.
    #[cfg(unix)]
    #[test]
    fn rsync_transport_hands_ssh_the_control_path_whole() {
        if !samba_rsync_3() {
            eprintln!("no rsync >= 3 on PATH; skipping the -e parsing check");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let ssh = root.path().join("fake-ssh");
        let seen = root.path().join("argv");
        std::fs::write(&ssh, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexit 1\n", seen.display())).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        for dir in ["/run/user/1000/my dir", "/home/o'neil/ssh", "/home/a'b'c/ssh"] {
            let _ = std::fs::remove_file(&seen);
            let e = rsync_ssh_transport_in(Path::new(dir), Some(2222));
            let fake = e.replacen("ssh", &ssh.display().to_string(), 1);
            let dest = root.path().join("dest");
            let _ = std::process::Command::new("rsync").arg("-e").arg(&fake).arg("h:/x/").arg(&dest).output().unwrap();
            let argv = std::fs::read_to_string(&seen).unwrap_or_else(|_| panic!("rsync never ran ssh for {dir}: {e}"));
            let words: Vec<&str> = argv.lines().collect();
            assert!(words.contains(&format!("ControlPath={}", Path::new(dir).join("cm-%C").display()).as_str()), "{dir}: {words:?}");
            assert!(words.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"), "{words:?}");
        }
    }

    /// The host path is sent without the remote shell parsing it, so a
    /// space or `$` in a project dir is one path, not two words or an expansion.
    #[test]
    fn rsync_pull_args_protect_the_host_path() {
        let args = rsync_pull_args(fast(), &None, "host.example", None, "/srv/my $proj/", "/m/", Path::new("/tmp/list"));
        assert!(args.iter().any(|arg| arg == "--protect-args"), "{args:?}");
        assert!(args.iter().any(|arg| arg == "host.example:/srv/my $proj/"));
    }

    /// The remote rsync globs its source argument: a host dir whose name holds
    /// a wildcard must pull that dir, not a sibling the pattern also matches.
    /// Run against the real rsync, through a stand-in `ssh` that runs the
    /// remote command locally the way a login shell would.
    #[cfg(unix)]
    #[test]
    fn rsync_pull_reads_a_wildcard_host_dir_literally() {
        if !samba_rsync_3() {
            eprintln!("no rsync >= 3 on PATH; skipping the local transfer check");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        // A wildcard segment below a plain one holding `]` or `\`: only the
        // wildcard segment is escaped.
        for (dir, body) in [
            ("a[1]", "right"),
            ("a1", "wrong"),
            ("q?", "right"),
            ("qz", "wrong"),
            ("b\\x[2]", "right"),
            ("bx2", "wrong"),
            ("x]y/c[1]", "right"),
            ("x]y/c1", "wrong"),
            ("p\\q/d[1]", "right"),
            ("p\\q/d1", "wrong"),
        ] {
            std::fs::create_dir_all(r.join(dir)).unwrap();
            std::fs::write(r.join(dir).join("f.txt"), body).unwrap();
        }
        let ssh = r.join("fake-ssh");
        std::fs::write(&ssh, "#!/bin/sh\nshift\neval \"$*\"\n").unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let list = rsync_files_from(&["f.txt".into()]).unwrap();
        for dir in ["a[1]", "q?", "b\\x[2]", "x]y/c[1]", "p\\q/d[1]"] {
            let dest = tempfile::tempdir().unwrap();
            let src = format!("{}/", r.join(dir).display());
            let mut args = rsync_pull_args(fast(), &None, "h", None, &src, &format!("{}/", dest.path().display()), list.path());
            let e = args.iter().position(|a| a == "-e").unwrap();
            args[e + 1] = ssh.display().to_string();
            let out = std::process::Command::new("rsync").args(&args).output().unwrap();
            assert!(out.status.success(), "{dir}: {}", String::from_utf8_lossy(&out.stderr));
            assert_eq!(std::fs::read_to_string(dest.path().join("f.txt")).unwrap(), "right", "{dir}");
        }
        // No wildcard: the path goes as it is.
        assert_eq!(rsync_literal_host_path("/srv/my $proj\\x/"), "/srv/my $proj\\x/");
    }

    #[test]
    fn rsync_pull_args_omit_user_when_absent() {
        let args = rsync_pull_args(
            fast(),
            &None,
            "host.example",
            None,
            "/srv/p/",
            "/m/",
            Path::new("/tmp/list"),
        );
        assert!(args.iter().any(|arg| arg == "host.example:/srv/p/"));
        assert!(!args.iter().any(|arg| arg == "-a" || arg == "-r" || arg == "--recursive"));
    }

    #[test]
    fn rsync_size_gate_matches_the_floor() {
        assert!(rsync_may_transfer(0));
        assert!(rsync_may_transfer(MAX_SYNC_FILE_BYTES));
        assert!(!rsync_may_transfer(MAX_SYNC_FILE_BYTES + 1));
    }

    #[test]
    fn rsync_pulled_base_records_only_regular_files_within_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let regular = dir.path().join("a.txt");
        std::fs::write(&regular, b"hello").unwrap();
        assert_eq!(rsync_pulled_base(&regular, 5).map(|(size, _)| size), Some(5));
        // Listed over the cap by the host walk: never recorded, whatever is on disk.
        assert_eq!(rsync_pulled_base(&regular, MAX_SYNC_FILE_BYTES + 1), None);
        // Missing, a directory, an oversized local file.
        assert_eq!(rsync_pulled_base(&dir.path().join("gone"), 1), None);
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        assert_eq!(rsync_pulled_base(&sub, 1), None);
        let big = dir.path().join("big.bin");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_SYNC_FILE_BYTES + 1)
            .unwrap();
        assert_eq!(rsync_pulled_base(&big, 1), None);
        #[cfg(unix)]
        {
            // A symlink to a regular file is not followed; a FIFO is not a file.
            let link = dir.path().join("link.txt");
            std::os::unix::fs::symlink(&regular, &link).unwrap();
            assert_eq!(rsync_pulled_base(&link, 5), None);
            let fifo = dir.path().join("pipe");
            let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            assert_eq!(rsync_pulled_base(&fifo, 0), None);
        }
    }

    /// Run the real pull flags local→local when rsync is installed (the
    /// transport is the only part left out): a listed path that is a FIFO, a
    /// symlink, a directory full of unlisted files, or a file over the cap
    /// never lands; the listed regular file does, with its mtime.
    #[cfg(unix)]
    #[test]
    fn rsync_pull_flags_land_only_listed_regular_files_within_the_cap() {
        if !samba_rsync_3() {
            eprintln!("no rsync >= 3 on PATH; skipping the local transfer check");
            return;
        }
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let s = src.path();
        std::fs::create_dir_all(s.join("d")).unwrap();
        std::fs::write(s.join("d/ok.txt"), b"ok").unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        std::fs::File::options()
            .write(true)
            .open(s.join("d/ok.txt"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        // The walker listed `swapped/inner.txt` and `was_file`; the host then
        // turned `swapped` into a FIFO and `was_file` into a directory.
        let fifo = s.join("swapped");
        let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let fifo_leaf = s.join("pipe");
        let c = std::ffi::CString::new(fifo_leaf.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        std::fs::create_dir_all(s.join("was_file/deep")).unwrap();
        std::fs::write(s.join("was_file/unlisted.txt"), b"x").unwrap();
        std::fs::write(s.join("was_file/deep/unlisted.txt"), b"x").unwrap();
        std::os::unix::fs::symlink("/etc/hostname", s.join("link.txt")).unwrap();
        std::fs::File::create(s.join("big.bin"))
            .unwrap()
            .set_len(MAX_SYNC_FILE_BYTES + 1)
            .unwrap();
        let list = rsync_files_from(&[
            "d/ok.txt".into(),
            "swapped/inner.txt".into(),
            "pipe".into(),
            "was_file".into(),
            "link.txt".into(),
            "big.bin".into(),
        ])
        .unwrap();
        let mut args = rsync_pull_flags(list.path());
        args.push(format!("{}/", s.display()));
        args.push(format!("{}/", dest.path().display()));
        let out = std::process::Command::new("rsync").args(&args).output().unwrap();
        // rsync exits 23 for the listed path it could not find; the transfer of
        // everything else still happens.
        assert!(
            matches!(out.status.code(), Some(0 | 23)),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let d = dest.path();
        assert_eq!(std::fs::read(d.join("d/ok.txt")).unwrap(), b"ok");
        assert_eq!(
            std::fs::metadata(d.join("d/ok.txt")).unwrap().modified().unwrap(),
            old
        );
        assert!(std::fs::symlink_metadata(d.join("swapped")).is_err());
        assert!(std::fs::symlink_metadata(d.join("pipe")).is_err());
        assert!(std::fs::symlink_metadata(d.join("link.txt")).is_err());
        assert!(std::fs::symlink_metadata(d.join("big.bin")).is_err());
        assert!(!d.join("was_file/unlisted.txt").exists());
        assert!(!d.join("was_file/deep").exists());
    }

    /// The host tree both pull-path tests walk: two small files and one over
    /// the cap, in walk order.
    fn host_tree_with_a_big_file(host: &Path) -> Vec<HostFile> {
        std::fs::create_dir_all(host.join("d")).unwrap();
        std::fs::write(host.join("a.txt"), b"a").unwrap();
        std::fs::write(host.join("d/b.txt"), b"bb").unwrap();
        std::fs::File::create(host.join("d/big.bin"))
            .unwrap()
            .set_len(MAX_SYNC_FILE_BYTES + 1)
            .unwrap();
        vec![
            HostFile { rel: "a.txt".into(), size: 1, mtime: None, mode: None },
            HostFile { rel: "d/big.bin".into(), size: MAX_SYNC_FILE_BYTES + 1, mtime: None, mode: None },
            HostFile { rel: "d/b.txt".into(), size: 2, mtime: None, mode: None },
        ]
    }

    fn big_file_skipped() -> Vec<SkippedFile> {
        vec![SkippedFile { rel: "d/big.bin".into(), size: MAX_SYNC_FILE_BYTES + 1 }]
    }

    /// Gap 35 follow-up: the rsync fast path pulls the files within the cap
    /// and the outcome names the one it left on the host.
    #[cfg(unix)]
    #[test]
    fn a_pull_reports_files_over_the_cap_on_the_rsync_path() {
        if !samba_rsync_3() {
            eprintln!("no rsync >= 3 on PATH; skipping the local transfer check");
            return;
        }
        let host = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let files = host_tree_with_a_big_file(host.path());
        let list = rsync_transfer_list(&files);
        assert_eq!(list.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), ["a.txt", "d/b.txt"]);
        let from = rsync_files_from(&rsync_subtree_files(&list, "").unwrap()).unwrap();
        let mut args = rsync_pull_flags(from.path());
        args.push(format!("{}/", host.path().display()));
        args.push(format!("{}/", mirror.path().display()));
        let out = std::process::Command::new("rsync").args(&args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let mut outcome = PullOutcome::default();
        for file in &files {
            let landed = rsync_pulled_base(&mirror.path().join(&file.rel), file.size).is_some();
            outcome.tally(file, landed);
        }
        assert_eq!(outcome.pulled, 2);
        assert_eq!(outcome.skipped_too_large, big_file_skipped());
        assert_eq!(std::fs::read(mirror.path().join("a.txt")).unwrap(), b"a");
        assert_eq!(std::fs::read(mirror.path().join("d/b.txt")).unwrap(), b"bb");
        assert!(!mirror.path().join("d/big.bin").exists());
    }

    /// Gap 35 follow-up: the SFTP floor's per-file rule (`pull_file` minus
    /// the wire) never reads a file over the cap, pulls the rest, and the
    /// outcome names the skipped one.
    #[tokio::test]
    async fn a_pull_reports_files_over_the_cap_on_the_sftp_path() {
        let host = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let files = host_tree_with_a_big_file(host.path());
        let reads = std::cell::RefCell::new(Vec::new());
        let mut outcome = PullOutcome::default();
        for file in &files {
            let host_abs = host.path().join(&file.rel);
            let landed = pull_file_with(&host_abs.to_string_lossy(), file.size, file.mode, mirror.path(), &file.rel, || {
                reads.borrow_mut().push(file.rel.clone());
                let path = host_abs.clone();
                async move { std::fs::read(path).map_err(|e| e.to_string()) }
            })
            .await
            .is_ok();
            outcome.tally(file, landed);
        }
        assert_eq!(*reads.borrow(), ["a.txt", "d/b.txt"], "a file over the cap is never read");
        assert_eq!(outcome.pulled, 2);
        assert_eq!(outcome.skipped_too_large, big_file_skipped());
        assert_eq!(std::fs::read(mirror.path().join("a.txt")).unwrap(), b"a");
        assert_eq!(std::fs::read(mirror.path().join("d/b.txt")).unwrap(), b"bb");
        assert!(!mirror.path().join("d/big.bin").exists());
    }

    /// The pull result crosses to the frontend in camelCase, and a payload
    /// without the new field still reads (empty list).
    #[test]
    fn a_pull_outcome_is_camel_case_and_defaults_to_nothing_skipped() {
        let outcome = PullOutcome { pulled: 2, skipped_too_large: big_file_skipped() };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["pulled"], 2);
        assert_eq!(json["skippedTooLarge"][0]["rel"], "d/big.bin");
        assert_eq!(json["skippedTooLarge"][0]["size"], MAX_SYNC_FILE_BYTES + 1);
        let old: PullOutcome = serde_json::from_str(r#"{"pulled":3}"#).unwrap();
        assert_eq!(old, PullOutcome { pulled: 3, skipped_too_large: Vec::new() });
        // A file that failed for another reason is not reported as too large.
        let mut outcome = PullOutcome::default();
        outcome.tally(&HostFile { rel: "gone.txt".into(), size: 5, mtime: None, mode: None }, false);
        assert_eq!(outcome, PullOutcome::default());
    }

    #[test]
    fn rsync_subtree_files_are_exactly_walker_paths_below_scope() {
        let files = vec![
            HostFile {
                rel: "data/one.txt".into(),
                size: 1,
                mtime: None,
                mode: None,
            },
            HostFile {
                rel: "data/nested/two.txt".into(),
                size: 2,
                mtime: None,
                mode: None,
            },
        ];
        assert_eq!(
            rsync_subtree_files(&files, "data"),
            Some(vec!["one.txt".into(), "nested/two.txt".into()])
        );
        assert_eq!(
            rsync_subtree_files(&files, ""),
            Some(vec!["data/one.txt".into(), "data/nested/two.txt".into()])
        );
        assert_eq!(rsync_subtree_files(&files, "other"), None);
    }

    #[test]
    fn rsync_file_list_is_nul_delimited() {
        let list = rsync_files_from(&["plain.txt".into(), "line\nbreak.txt".into()]).unwrap();
        assert_eq!(
            std::fs::read(list.path()).unwrap(),
            b"plain.txt\0line\nbreak.txt\0"
        );
    }

    #[test]
    fn local_pull_replacement_is_complete_and_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested/file.txt");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"old complete bytes").unwrap();
        replace_local_atomic(&target, b"new complete bytes", None).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new complete bytes");
    }

    #[test]
    fn mirror_writes_refuse_traversal_names() {
        // #863: a hostile host answers its walk with `../` "names".
        let dir = tempfile::tempdir().unwrap();
        let mirror = dir.path().join("mirror");
        std::fs::create_dir_all(&mirror).unwrap();
        for bad in [
            "../escape.txt",
            "../../.config/autostart/x.desktop",
            "a/../../escape.txt",
            "a/..",
            "",
            "/",
            "nul\0byte",
        ] {
            assert!(confined_mirror_path(&mirror, bad).is_err(), "{bad:?} must be refused");
            assert!(write_mirror_file(&mirror, bad, b"x").is_err(), "{bad:?} must not be written");
        }
        assert!(!dir.path().join("escape.txt").exists());
        // Ordinary project-relative paths (a leading `/` read as relative, `./`
        // tolerated) land inside the mirror.
        assert_eq!(confined_mirror_path(&mirror, "a/b.txt").unwrap(), mirror.join("a/b.txt"));
        assert_eq!(confined_mirror_path(&mirror, "/a/./b.txt").unwrap(), mirror.join("a/b.txt"));
        let written = write_mirror_file(&mirror, "new/dir/f.txt", b"ok").unwrap();
        assert_eq!(written, mirror.join("new/dir/f.txt"));
        assert_eq!(std::fs::read(&written).unwrap(), b"ok");
        // The rsync destination may be the mirror root itself; traversal is refused.
        assert_eq!(confined_mirror_dir(&mirror, "").unwrap(), mirror);
        assert!(confined_mirror_dir(&mirror, "../x").is_err());
    }

    #[test]
    fn mirror_local_path_never_steps_outside_the_mirror() {
        let p = mirror_local_path("pid", "../../../.config/autostart/x.desktop");
        let mirror = mirror_dir("pid");
        assert!(p.starts_with(&mirror), "{} escaped {}", p.display(), mirror.display());
        assert!(!p.components().any(|c| c == Component::ParentDir));
        assert_eq!(mirror_local_path("pid", "a/b.txt"), mirror.join("a/b.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn mirror_writes_refuse_a_symlinked_parent_directory() {
        // #863: a fenced agent plants `mirror/d -> <outside>`; a pull of `d/x`
        // must not follow it out of the mirror.
        let dir = tempfile::tempdir().unwrap();
        let mirror = dir.path().join("mirror");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(mirror.join("real")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, mirror.join("d")).unwrap();
        std::os::unix::fs::symlink(&outside, mirror.join("real/deep")).unwrap();
        for bad in ["d/x.desktop", "d/new/x.desktop", "real/deep/x.desktop"] {
            assert!(confined_mirror_path(&mirror, bad).is_err(), "{bad:?} must be refused");
            assert!(write_mirror_file(&mirror, bad, b"x").is_err(), "{bad:?} must not be written");
        }
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0, "nothing landed outside");
        // rsync writes through its destination: a symlinked one is refused too.
        assert!(confined_mirror_dir(&mirror, "d").is_err());
        assert!(confined_mirror_dir(&mirror, "real/deep/sub").is_err());
        assert!(confined_mirror_dir(&mirror, "real").is_ok());
        // A symlink AS the file is replaced by the atomic rename, never written through.
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, b"precious").unwrap();
        std::os::unix::fs::symlink(&victim, mirror.join("real/link.txt")).unwrap();
        write_mirror_file(&mirror, "real/link.txt", b"host bytes").unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        assert!(!std::fs::symlink_metadata(mirror.join("real/link.txt"))
            .unwrap()
            .file_type()
            .is_symlink());
        // A symlinked mirror ROOT is the user's choice and stays usable.
        let linked_root = dir.path().join("linked-mirror");
        std::os::unix::fs::symlink(mirror.join("real"), &linked_root).unwrap();
        assert!(write_mirror_file(&linked_root, "ok.txt", b"x").is_ok());
    }

    #[test]
    fn join_remote_handles_root_and_rel() {
        assert_eq!(join_remote("/srv/p", ""), "/srv/p");
        assert_eq!(join_remote("/srv/p/", "a/b"), "/srv/p/a/b");
        assert_eq!(join_remote("/srv/p", "/a"), "/srv/p/a");
        assert_eq!(join_remote("", "a"), "/a");
        assert_eq!(join_remote("", ""), "/");
    }

    #[test]
    fn join_rel_appends_segments() {
        assert_eq!(join_rel("", "a"), "a");
        assert_eq!(join_rel("a", "b"), "a/b");
        assert_eq!(join_rel("a/b/", "c"), "a/b/c");
    }

    #[test]
    fn local_new_candidates_filters_manifest_tracked_and_excluded() {
        let mut m = Manifest::new();
        m.insert(
            "synced.txt".into(),
            SyncEntry {
                selected: true,
                ..Default::default()
            },
        );
        m.insert("data".into(), excluded_dir());
        let all = vec![
            "synced.txt".to_string(),          // manifest'd → has a row already
            "src/lib.rs".to_string(),          // tracked → lockstep's when enabled
            "data/cache.bin".to_string(),      // under an excluded folder marker
            "configs/new_v10.yml".to_string(), // genuinely new
            "".to_string(),                    // defensive: never a file
        ];
        let tracked: HashSet<String> = ["src/lib.rs".to_string()].into_iter().collect();

        // Lockstep on: the tracked file belongs to lockstep (#28p D1), not here.
        let with_lockstep = local_new_candidates(&m, all.clone(), &tracked, true, 100);
        assert_eq!(with_lockstep, vec!["configs/new_v10.yml".to_string()]);

        // Lockstep off: byte-sync owns the tracked tree too, so a tracked file
        // the manifest never saw IS new and reportable.
        let without = local_new_candidates(&m, all, &tracked, false, 100);
        assert_eq!(
            without,
            vec!["configs/new_v10.yml".to_string(), "src/lib.rs".to_string()],
        );
    }

    #[test]
    fn local_new_candidates_sorts_and_caps() {
        let m = Manifest::new();
        let all = vec!["b".to_string(), "c".to_string(), "a".to_string()];
        let none = HashSet::new();
        // Sorted for a stable UI order, then capped — the row list is advisory,
        // not an inventory, so the cap keeps a raw-walk fallback's tens of
        // thousands of candidates from flooding the IPC payload.
        assert_eq!(
            local_new_candidates(&m, all, &none, true, 2),
            vec!["a".to_string(), "b".to_string()],
        );
    }

    #[test]
    fn compute_state_green_when_base_matches() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            ..Default::default()
        };
        // Both host and local match their recorded bases → green.
        assert_eq!(
            compute_state(&e, Some((10, Some(100))), Some((10, Some(50))), false),
            SyncState::Green,
        );
    }

    #[test]
    fn compute_state_amber_when_host_moved() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            ..Default::default()
        };
        // Host size changed (local unchanged).
        assert_eq!(
            compute_state(&e, Some((12, Some(100))), Some((10, Some(50))), false),
            SyncState::Amber,
        );
        // Host mtime changed (local unchanged).
        assert_eq!(
            compute_state(&e, Some((10, Some(200))), Some((10, Some(50))), false),
            SyncState::Amber,
        );
        // Same divergence, but the path is excluded from sync → None, not Amber.
        assert_eq!(
            compute_state(&e, Some((12, Some(100))), Some((10, Some(50))), true),
            SyncState::None,
        );
    }

    #[test]
    fn compute_state_amber_when_local_moved() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        // Host still matches its base, but the local mirror mtime moved → amber.
        assert_eq!(
            compute_state(&e, Some((10, Some(100))), Some((10, Some(80))), false),
            SyncState::Amber,
        );
        // Also amber offline (host not stat'd) when the local size moved.
        assert_eq!(
            compute_state(&e, None, Some((12, Some(50))), false),
            SyncState::Amber
        );
        // Mirror deleted after a prior sync → diverged.
        assert_eq!(
            compute_state(&e, Some((10, Some(100))), None, false),
            SyncState::Amber
        );
    }

    #[test]
    fn compute_state_none_when_unselected() {
        let e = SyncEntry {
            selected: false,
            ..Default::default()
        };
        assert_eq!(
            compute_state(&e, Some((0, None)), None, false),
            SyncState::None
        );
    }

    #[test]
    fn record_pull_marks_selected_and_stamps_bases() {
        let mut m = Manifest::new();
        record_pull(&mut m, "src/main.rs", 42, Some(7), 42, Some(9));
        let e = m.get("src/main.rs").unwrap();
        assert!(e.selected);
        assert_eq!(e.host_size, 42);
        assert_eq!(e.host_mtime, Some(7));
        assert_eq!(e.local_size, 42);
        assert_eq!(e.local_mtime, Some(9));
        assert!(e.last_pull_ts.is_some());
    }

    #[test]
    fn mirror_path_joins_under_mirror() {
        let p = mirror_local_path("pid", "a/b.txt");
        assert!(p.ends_with("remote-projects/pid/mirror/a/b.txt"));
    }

    #[test]
    fn divergence_splits_the_two_sides() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        // Neither side moved → (false, false).
        assert_eq!(
            divergence(&e, Some((10, Some(100))), Some((10, Some(50)))),
            (false, false)
        );
        // Host moved only → (true, false): the auto engine pulls.
        assert_eq!(
            divergence(&e, Some((12, Some(100))), Some((10, Some(50)))),
            (true, false)
        );
        // Local moved only → (false, true): the auto engine pushes.
        assert_eq!(
            divergence(&e, Some((10, Some(100))), Some((10, Some(80)))),
            (false, true)
        );
        // Both moved → (true, true): amber, skipped by the auto engine.
        assert_eq!(
            divergence(&e, Some((12, Some(100))), Some((10, Some(80)))),
            (true, true)
        );
        // Host not stat'd (cold) → host side never flagged.
        assert_eq!(divergence(&e, None, Some((10, Some(50)))), (false, false));
    }

    #[test]
    fn both_gone_after_sync_is_pruned() {
        let synced = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        let gone: Result<Option<(u64, Option<u64>)>, String> = Ok(None);
        let present: Result<Option<(u64, Option<u64>)>, String> = Ok(Some((10, Some(100))));
        let err: Result<Option<(u64, Option<u64>)>, String> = Err("session dropped".into());
        // Positively gone on BOTH sides after a sync → nothing left to compare
        // → prune.
        assert!(should_prune(&synced, &gone, &gone));
        // Host still present → a real one-side deletion, never pruned.
        assert!(!should_prune(&synced, &present, &gone));
        // Local still present → same, the conflict machinery owns it.
        assert!(!should_prune(&synced, &gone, &present));
        // Never synced → a bare marker, nothing to forget.
        let never = SyncEntry {
            selected: true,
            ..Default::default()
        };
        assert!(!should_prune(&never, &gone, &gone));
        // A stat ERROR is "could not check", NEVER "gone": a dropped session
        // mid-refresh must not read as every file deleted (mass-prune hazard).
        assert!(!should_prune(&synced, &err, &gone));
        assert!(!should_prune(&synced, &gone, &err));
        assert!(!should_prune(&synced, &err, &err));
    }

    #[test]
    fn content_verify_gate() {
        let cutoff = 1024;
        // Same size, both present, within cutoff → worth reading to disprove amber.
        assert!(content_verify_worth_it(
            (10, Some(100)),
            (10, Some(50)),
            cutoff
        ));
        // Different sizes can't be byte-identical → never read.
        assert!(!content_verify_worth_it(
            (10, Some(100)),
            (12, Some(50)),
            cutoff
        ));
        // A missing side (no mtime) is a real divergence → don't downgrade, don't read.
        assert!(!content_verify_worth_it((10, None), (10, Some(50)), cutoff));
        assert!(!content_verify_worth_it(
            (10, Some(100)),
            (10, None),
            cutoff
        ));
        // Above the cutoff → large files keep the pure metadata heuristic.
        assert!(!content_verify_worth_it(
            (2048, Some(100)),
            (2048, Some(50)),
            cutoff
        ));
        // Exactly at the cutoff is still verified (boundary is inclusive).
        assert!(content_verify_worth_it(
            (1024, Some(100)),
            (1024, Some(50)),
            cutoff
        ));
        // Two empty files (size 0, both present) → trivially worth it (and equal).
        assert!(content_verify_worth_it(
            (0, Some(100)),
            (0, Some(50)),
            cutoff
        ));
    }

    #[test]
    fn is_auto_follows_own_entry_and_ancestor_folder_markers() {
        let mut m = Manifest::new();
        // A file with its own auto flag.
        m.insert(
            "solo.txt".to_string(),
            SyncEntry {
                selected: true,
                auto_sync: true,
                ..Default::default()
            },
        );
        // An auto folder marker; its descendants inherit auto even with no entry.
        m.insert(
            "src".to_string(),
            SyncEntry {
                selected: true,
                is_dir: true,
                auto_sync: true,
                ..Default::default()
            },
        );
        // A NON-auto folder marker; its descendants are not auto.
        m.insert(
            "vendor".to_string(),
            SyncEntry {
                selected: true,
                is_dir: true,
                ..Default::default()
            },
        );

        assert!(is_auto(&m, "solo.txt"));
        assert!(is_auto(&m, "src/main.rs")); // inherits from src/
        assert!(is_auto(&m, "src/a/b/deep.rs")); // any depth under an auto folder
        assert!(!is_auto(&m, "vendor/lib.rs")); // ancestor folder not auto
        assert!(!is_auto(&m, "other.txt")); // no entry, no auto ancestor

        // A plain FILE entry named like a dir must not act as a folder marker.
        m.insert(
            "notadir".to_string(),
            SyncEntry {
                selected: true,
                auto_sync: true,
                is_dir: false,
                ..Default::default()
            },
        );
        assert!(!is_auto(&m, "notadir/child.rs"));
    }

    #[test]
    fn is_auto_project_wide_root_marker_and_exclusions() {
        let mut m = Manifest::new();
        // Project-wide "auto-sync all": the root "" directory marker.
        m.insert(
            "".to_string(),
            SyncEntry {
                selected: true,
                is_dir: true,
                auto_sync: true,
                ..Default::default()
            },
        );
        // Everything is auto under the project-wide marker, at any depth and for
        // top-level files (which `rfind('/')` never resolves to the root).
        assert!(is_auto(&m, "README.md"));
        assert!(is_auto(&m, "src/main.rs"));
        assert!(is_auto(&m, "a/b/c/deep.rs"));

        // A local OFF override carves a subtree out of the project-wide auto.
        m.insert(
            "vendor".to_string(),
            SyncEntry {
                selected: true,
                is_dir: true,
                auto_off: true,
                ..Default::default()
            },
        );
        assert!(!is_auto(&m, "vendor/lib.rs"));
        assert!(!is_auto(&m, "vendor")); // the folder itself
        assert!(is_auto(&m, "src/main.rs")); // siblings unaffected

        // A single excluded file under an otherwise-auto tree.
        m.insert(
            "src/secret.rs".to_string(),
            SyncEntry {
                selected: true,
                auto_off: true,
                ..Default::default()
            },
        );
        assert!(!is_auto(&m, "src/secret.rs"));
        assert!(is_auto(&m, "src/other.rs"));

        // A local ON override wins over an ancestor exclusion (nearest marker).
        m.insert(
            "vendor/keep".to_string(),
            SyncEntry {
                selected: true,
                is_dir: true,
                auto_sync: true,
                ..Default::default()
            },
        );
        assert!(is_auto(&m, "vendor/keep/x.rs"));
        assert!(!is_auto(&m, "vendor/other/y.rs")); // still excluded

        // Project-wide OFF (root auto_off): nothing auto except explicit ON paths.
        m.insert(
            "".to_string(),
            SyncEntry {
                selected: true,
                is_dir: true,
                auto_off: true,
                ..Default::default()
            },
        );
        assert!(!is_auto(&m, "README.md"));
        assert!(is_auto(&m, "vendor/keep/x.rs")); // explicit ON still wins
    }

    /// Why `commands::projects::clear_host_bound_state` must exist.
    ///
    /// A manifest entry is a claim about **one specific host**. Point the project at a
    /// different one — detach, then extend to a corrected path, which is the normal way to
    /// fix a wrong `remote_path` — and every base in it becomes a lie. The state dir is
    /// keyed by project *id*, which detach preserves, so without an explicit purge the new
    /// pairing inherits the old host's manifest wholesale.
    ///
    /// The two pure functions below then disagree about the same file in the worst
    /// possible way, and this test pins both halves so the purge can never be quietly
    /// dropped:
    ///   * `push_decision` sees `ever_synced` + a missing host file and calls it `Stale` —
    ///     a deletion to be resolved, not a file to send. So it **refuses to push**.
    ///   * `divergence` maps the same failed host stat to "couldn't check → don't flag",
    ///     so with the mirror untouched the file reads `(false, false)` — **green**.
    ///
    /// A file the tree reports as fully in sync, on a host that has never had it, which
    /// byte-sync will never send. It would look like the sync simply worked.
    #[test]
    fn a_stale_manifest_against_a_fresh_host_is_a_false_green() {
        // Synced against the OLD host, and untouched locally since.
        let stale = SyncEntry {
            selected: true,
            auto_sync: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        let local_unchanged = Some((10u64, Some(100u64)));

        // The new host has never heard of this file.
        assert_eq!(
            push_decision(&stale, None),
            PushDecision::Stale,
            "refuses to push: it reads the absence as a host-side DELETION, not a new host"
        );
        assert_eq!(
            divergence(&stale, None, local_unchanged),
            (false, false),
            "…and paints it green while doing so"
        );

        // Cleared (as a fresh pairing must be), the very same file behaves correctly: it
        // is simply a local file the host lacks, so it gets created there.
        let fresh = SyncEntry {
            selected: true,
            auto_sync: true,
            ..Default::default()
        };
        assert_eq!(push_decision(&fresh, None), PushDecision::Safe);
        assert_eq!(
            divergence(&fresh, None, local_unchanged),
            (false, true),
            "local-only change → push, which is exactly the seed a new host needs"
        );
    }
    #[cfg(unix)]
    mod mirror_reads {
        use super::*;
        use crate::services::home_io::{mkfifo, within_deadline};

        fn mirror() -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join("d")).unwrap();
            std::fs::write(dir.path().join("d").join("f.txt"), b"hello").unwrap();
            dir
        }

        fn read(root: &Path, rel: &str) -> MirrorRead {
            let (root, rel) = (root.to_path_buf(), rel.to_string());
            within_deadline(move || read_mirror_file(&root, &rel)).expect("a read, not an error")
        }

        fn skip_kind(r: MirrorRead) -> MirrorSkipKind {
            match r {
                MirrorRead::Skip(kind, _) => kind,
                other => panic!("expected a skip, got {other:?}"),
            }
        }

        #[test]
        fn a_regular_file_is_read_with_the_handles_bases() {
            let dir = mirror();
            match read(dir.path(), "d/f.txt") {
                MirrorRead::File { bytes, meta } => {
                    assert_eq!(bytes, b"hello");
                    assert_eq!(meta.0, 5);
                }
                other => panic!("{other:?}"),
            }
            assert!(matches!(read(dir.path(), "d/none.txt"), MirrorRead::Missing));
            assert!(matches!(read(dir.path(), "nodir/none.txt"), MirrorRead::Missing));
        }

        #[test]
        fn a_link_at_the_file_is_never_read() {
            let dir = mirror();
            let secret = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(secret.path(), b"ssh key").unwrap();
            std::os::unix::fs::symlink(secret.path(), dir.path().join("d").join("l.txt")).unwrap();
            assert_eq!(skip_kind(read(dir.path(), "d/l.txt")), MirrorSkipKind::Link);
            assert!(matches!(mirror_lstat(dir.path(), "d/l.txt"), Ok(MirrorStat::Skip(MirrorSkipKind::Link))));
        }

        #[test]
        fn a_linked_folder_on_the_way_is_never_read_through() {
            let dir = mirror();
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("f.txt"), b"outside").unwrap();
            std::os::unix::fs::symlink(outside.path(), dir.path().join("lnk")).unwrap();
            assert_eq!(skip_kind(read(dir.path(), "lnk/f.txt")), MirrorSkipKind::Link);
            assert!(matches!(mirror_lstat(dir.path(), "lnk/f.txt"), Ok(MirrorStat::Skip(MirrorSkipKind::Link))));
            // A dangling link is still a link, never "gone".
            std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("dangling")).unwrap();
            assert_eq!(skip_kind(read(dir.path(), "dangling")), MirrorSkipKind::Link);
            assert!(matches!(mirror_lstat(dir.path(), "dangling"), Ok(MirrorStat::Skip(MirrorSkipKind::Link))));
        }

        #[test]
        fn a_fifo_is_skipped_without_blocking() {
            let dir = mirror();
            mkfifo(&dir.path().join("d").join("pipe"));
            assert_eq!(skip_kind(read(dir.path(), "d/pipe")), MirrorSkipKind::Special);
            assert!(matches!(mirror_lstat(dir.path(), "d/pipe"), Ok(MirrorStat::Skip(MirrorSkipKind::Special))));
        }

        #[test]
        fn a_file_over_the_cap_is_skipped_from_the_handle() {
            let dir = mirror();
            let big = std::fs::File::create(dir.path().join("big.bin")).unwrap();
            big.set_len(MAX_SYNC_FILE_BYTES + 1).unwrap();
            match read(dir.path(), "big.bin") {
                MirrorRead::Skip(MirrorSkipKind::TooLarge, Some(size)) => assert_eq!(size, MAX_SYNC_FILE_BYTES + 1),
                other => panic!("{other:?}"),
            }
        }

        #[test]
        fn a_swap_between_the_walk_and_the_read_reads_nothing() {
            let root = mirror();
            let secret = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(secret.path(), b"host login").unwrap();
            // The walk's view: a regular file in a regular folder.
            let mut listed = Vec::new();
            walk_mirror_inner(root.path(), root.path(), &mut listed).unwrap();
            assert_eq!(listed, vec!["d/f.txt".to_string()]);
            // The leaf is swapped for a link to a file the agent cannot see.
            std::fs::remove_file(root.path().join("d").join("f.txt")).unwrap();
            std::os::unix::fs::symlink(secret.path(), root.path().join("d").join("f.txt")).unwrap();
            assert_eq!(skip_kind(read(root.path(), &listed[0])), MirrorSkipKind::Link);
            // Then the folder is swapped for a link to a folder holding the same name.
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("f.txt"), b"host login").unwrap();
            std::fs::remove_file(root.path().join("d").join("f.txt")).unwrap();
            std::fs::remove_dir(root.path().join("d")).unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("d")).unwrap();
            assert_eq!(skip_kind(read(root.path(), &listed[0])), MirrorSkipKind::Link);
            // And the leaf becomes a FIFO.
            std::fs::remove_file(root.path().join("d")).unwrap();
            std::fs::create_dir(root.path().join("d")).unwrap();
            mkfifo(&root.path().join("d").join("f.txt"));
            assert_eq!(skip_kind(read(root.path(), &listed[0])), MirrorSkipKind::Special);
        }

        #[test]
        fn skips_are_kept_per_project_and_cleared_when_the_file_is_ordinary_again() {
            let id = format!("skip-notice-{}", std::process::id());
            let skip = |rel: &str| MirrorSkip { rel: rel.into(), kind: MirrorSkipKind::Link, size: None };
            assert!(note_mirror_skip(&id, skip("a")));
            assert!(!note_mirror_skip(&id, skip("a")), "the same notice is not a change");
            assert!(note_mirror_skip(&id, skip("b")));
            assert_eq!(mirror_skips(&id).total, 2);
            assert!(clear_mirror_skip(&id, "a"));
            assert!(!clear_mirror_skip(&id, "a"));
            assert_eq!(mirror_skips(&id).items, vec![skip("b")]);
            assert!(clear_mirror_skip(&id, "b"));
            assert_eq!(mirror_skips(&id), MirrorSkips::default());
        }
    }
}
