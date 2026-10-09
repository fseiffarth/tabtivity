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
    let list_path = crate::storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = crate::storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
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
    let mut cur = root.to_path_buf();
    for part in parts {
        cur.push(part);
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "refusing '{rel}': '{}' in the local mirror is a symlink",
                    cur.strip_prefix(root).unwrap_or(&cur).display()
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("refusing '{rel}': {e}")),
        }
    }
    Ok(())
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

/// Load a project's manifest from disk, or an empty one if absent/unparseable.
pub fn load_manifest(project_id: &str) -> Manifest {
    let path = manifest_path(project_id);
    if !path.exists() {
        return Manifest::new();
    }
    crate::storage::read_json(&path).unwrap_or_default()
}

/// Persist a project's manifest to disk (creates the state dir if needed).
pub fn save_manifest(project_id: &str, manifest: &Manifest) -> Result<(), String> {
    let path = manifest_path(project_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::storage::write_json(&path, manifest).map_err(|e| e.to_string())
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/// Current wall-clock time as whole seconds since the Unix epoch.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

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
/// `under` is the path the caller was *asked* to transfer, and its own marker is
/// deliberately ignored: right-clicking an excluded folder and syncing it is an
/// explicit override of the very answer stored there, whereas a whole-project
/// pull is not. Pass `""` for a project-root pull to honour every exclusion.
pub fn is_excluded(manifest: &Manifest, rel: &str, under: &str) -> bool {
    let mut cur = rel;
    loop {
        if cur != under {
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
    cache
        .entry(project_id.to_string())
        .or_insert_with(|| load_manifest(project_id))
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
pub async fn pull_file(
    sftp: &openssh_sftp_client::Sftp,
    host_abs: &str,
    host_size: u64,
    mirror_root: &Path,
    rel: &str,
) -> Result<(u64, Option<u64>), String> {
    pull_file_with(host_abs, host_size, mirror_root, rel, || sftp::read_file_on(sftp, host_abs)).await
}

/// [`pull_file`] with the host read passed in (`read`, called at most once and
/// never for a file over the cap): the SFTP floor's whole per-file rule —
/// confinement, the size cap before and after the read, the atomic write —
/// testable without a host.
async fn pull_file_with<R, F>(
    host_abs: &str,
    host_size: u64,
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
    let local = write_mirror_file(mirror_root, rel, &bytes)?;
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
/// Returns the path written.
pub fn write_mirror_file(mirror_root: &Path, rel: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let local = confined_mirror_path(mirror_root, rel)?;
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    confined_mirror_path(mirror_root, rel)?;
    replace_local_atomic(&local, bytes)?;
    Ok(local)
}

/// Atomically replace one mirror file with fully-read host bytes. The caller
/// confines `local` ([`write_mirror_file`]).
fn replace_local_atomic(local: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = local.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Stage beside the destination and atomically replace it. A crash or process
    // kill can now leave either the old complete file or the new complete file,
    // never a mirror file truncated by `fs::write`.
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    staged.write_all(bytes).map_err(|e| e.to_string())?;
    staged.flush().map_err(|e| e.to_string())?;
    staged.persist(local).map_err(|e| e.error.to_string())?;
    Ok(())
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
// the floor (used whenever rsync is missing on either end, and on any rsync
// failure). Only PULLS use rsync: a push must honour the per-file block-on-stale
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

/// Whether the bulk rsync fast-path applies: rsync present on BOTH ends and the
/// transfer is a directory (single files just use SFTP). Pure, unit-tested.
pub fn should_use_rsync(rsync_local: bool, rsync_host: bool, is_dir: bool) -> bool {
    rsync_local && rsync_host && is_dir
}

/// Build the `ssh …` string for rsync's `-e` so the transfer rides the shared
/// `cm-%C` ControlMaster (no second auth) with `ControlMaster=no` (use, don't
/// create). Includes the port and keepalive. Pure (the control dir is a stable
/// per-user path), unit-tested for the ControlPath wiring.
pub fn rsync_ssh_transport(port: Option<u16>) -> String {
    let control_path = crate::services::ssh_exec::control_dir().join("cm-%C");
    let mut parts: Vec<String> = vec![
        "ssh".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.to_string_lossy()),
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
    ]
}

/// Build the full rsync argv for a host→local PULL: [`rsync_pull_flags`], then
/// the ControlMaster transport and the two endpoints. Pure, unit-tested (it
/// never touches the network).
pub fn rsync_pull_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    host_src: &str,
    local_dest: &str,
    files_from: &Path,
) -> Vec<String> {
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

/// Whether `rsync` is present on the HOST (`command -v rsync` over SSH, riding the
/// master). Best-effort: any ssh/probe failure → `false` (fall back to SFTP).
/// Blocking; call from `spawn_blocking`.
pub fn rsync_available_host(spec: &crate::schema::project::RemoteSpec) -> bool {
    match crate::services::ssh_exec::run_remote_shell(
        spec,
        concat!("command -v rsync >/dev/null 2>&1 && echo ", crate::app_slug!(), "-rsync-yes"),
    ) {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains(concat!(crate::app_slug!(), "-rsync-yes")),
        Err(_) => false,
    }
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
    let args = rsync_pull_args(user, host, port, &src, &dest, files_from.path());
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

/// Push one local mirror file to the host atomically: write the bytes to a temp
/// path beside the target, then `rename_on` over it (so a reader never sees a
/// half-written file). The caller has already decided this is `Safe`. Returns the
/// host (size, mtime) base captured after the write. Size-guarded (G8).
pub async fn push_file_atomic(
    sftp: &openssh_sftp_client::Sftp,
    local: &Path,
    host_abs: &str,
) -> Result<(u64, Option<u64>), String> {
    let meta = std::fs::metadata(local).map_err(|e| e.to_string())?;
    if meta.len() > MAX_SYNC_FILE_BYTES {
        return Err(format!(
            "'{}' is too large to sync ({} bytes; limit {MAX_SYNC_FILE_BYTES})",
            local.display(),
            meta.len()
        ));
    }
    let bytes = std::fs::read(local).map_err(|e| e.to_string())?;
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
    match sftp::metadata_on(sftp, host_abs).await {
        Ok(hm) => Ok(hm),
        Err(_) => match sftp::metadata_on(sftp, host_abs).await {
            Ok(hm) => Ok(hm),
            Err(e) => Err(format!(
                "pushed '{host_abs}' but could not re-stat it to record the new base: {e}"
            )),
        },
    }
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

    #[test]
    fn should_use_rsync_requires_both_ends_and_a_dir() {
        assert!(should_use_rsync(true, true, true));
        assert!(!should_use_rsync(true, true, false)); // single file → SFTP
        assert!(!should_use_rsync(false, true, true)); // missing locally
        assert!(!should_use_rsync(true, false, true)); // missing on host
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

    #[test]
    fn rsync_pull_args_omit_user_when_absent() {
        let args = rsync_pull_args(
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
        if !rsync_available_local() {
            eprintln!("rsync not on PATH; skipping the local transfer check");
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
            HostFile { rel: "a.txt".into(), size: 1, mtime: None },
            HostFile { rel: "d/big.bin".into(), size: MAX_SYNC_FILE_BYTES + 1, mtime: None },
            HostFile { rel: "d/b.txt".into(), size: 2, mtime: None },
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
        if !rsync_available_local() {
            eprintln!("rsync not on PATH; skipping the local transfer check");
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
            let landed = pull_file_with(&host_abs.to_string_lossy(), file.size, mirror.path(), &file.rel, || {
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
        outcome.tally(&HostFile { rel: "gone.txt".into(), size: 5, mtime: None }, false);
        assert_eq!(outcome, PullOutcome::default());
    }

    #[test]
    fn rsync_subtree_files_are_exactly_walker_paths_below_scope() {
        let files = vec![
            HostFile {
                rel: "data/one.txt".into(),
                size: 1,
                mtime: None,
            },
            HostFile {
                rel: "data/nested/two.txt".into(),
                size: 2,
                mtime: None,
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
        replace_local_atomic(&target, b"new complete bytes").unwrap();
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
}
