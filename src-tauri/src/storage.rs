use std::fs;
use app_core::sync::LockExt;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use crate::paths;

/// Read and deserialize a JSON file.
pub fn read_json<T>(path: &Path) -> Result<T, Box<dyn std::error::Error>>
where
    T: serde::de::DeserializeOwned,
{
    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

/// Serialize and write a JSON file.
pub fn write_json<T>(path: &Path, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
    // A state file is created owner-only; a file in a project folder keeps the
    // umask, so a shared project dir stays readable to its group.
    write_json_file(path, value, path.starts_with(state_dir()))
}

/// [`write_json`] with the privacy decided by the caller.
///
/// A private file goes through [`write_private_atomic`]: owner-only on every
/// write (an existing file too, not just a new one), and replaced whole, so a
/// crash or a reader never sees it half-written. Each write costs an fsync
/// and, on Windows, an `icacls` pair for the staged file; state files are
/// written at human or timer pace, not per message, so that is affordable.
///
/// A shared file (a project folder's) is truncated and rewritten in place,
/// keeping its mode, owner and links: a group-shared project dir stays
/// readable to its group.
fn write_json_file<T>(path: &Path, value: &T, private: bool) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
    let json = serde_json::to_string_pretty(value)?;
    if private {
        write_private_atomic(path, json.as_bytes())?;
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(json.as_bytes())?;
    Ok(())
}

/// Serialize and write a JSON file **atomically**: the bytes land in a temp file
/// beside the target and are then `rename`d over it, so a reader (or a crash)
/// never observes a half-written file.
///
/// [`write_json`] replaces a state file atomically too, but without this
/// function's process-wide lock, and truncates a project-folder file in place.
/// Prefer this for a store written from several places
/// (see `schema::usage_stats`, fed by both the frontend flush and the file
/// watcher). Same rename trick as `services::agent_session::write_live_session_in`.
pub fn write_json_atomic<T>(path: &Path, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
    let _guard = JSON_MUTATION_LOCK
        .lock_ok();
    write_json_atomic_unlocked(path, value)
}

/// Serialize one JSON read-modify-write transaction with every atomic writer in
/// this process. A missing file starts from `default`; an existing file must
/// deserialize successfully or `patch` is never called and its bytes are left
/// untouched.
///
/// Keep `patch` limited to the in-memory mutation. Calling
/// [`write_json_atomic`] from it would try to acquire the same lock again.
pub fn patch_json<T, R>(
    path: &Path,
    default: T,
    patch: impl FnOnce(&mut T) -> Result<R, String>,
) -> Result<R, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let _guard = JSON_MUTATION_LOCK
        .lock_ok();
    // The process-wide lock serialises this process; the file lock serialises
    // a second Tabtivity process patching the same file (#171's lesson applied
    // to every read-modify-write here).
    let _file_lock = FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    // The bytes as read, kept to tell a patch that changed nothing from one
    // that did. A missing file has none, so its first patch always writes.
    let (mut value, on_disk) = if path.exists() {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        (value, Some(content))
    } else {
        (default, None)
    };
    let result = patch(&mut value)?;
    let bytes = atomic_json_bytes(&value).map_err(|e| e.to_string())?;
    // A patch that leaves the file byte-for-byte as it is costs no rewrite and
    // no fsync pair: `get_projects` patches on every read and the layout
    // autosave re-sends unchanged state, both many times a minute. A file in
    // another layout (hand-edited, written by `write_json`) differs in bytes
    // and is still rewritten, exactly as before.
    if on_disk.as_deref().map(str::as_bytes) == Some(bytes.as_slice()) {
        return Ok(result);
    }
    write_bytes_atomic_unlocked(path, &bytes).map_err(|e| e.to_string())?;
    Ok(result)
}

/// One lock covers atomic replacements and the read side of [`patch_json`].
/// JSON state files are small; keeping the boundary process-wide avoids a lock
/// registry whose entries can outlive arbitrary state paths.
static JSON_MUTATION_LOCK: Mutex<()> = Mutex::new(());

fn write_json_atomic_unlocked<T>(path: &Path, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
    write_bytes_atomic_unlocked(path, &atomic_json_bytes(value)?)
}

/// The exact bytes an atomic write puts on disk for `value`: pretty JSON and a
/// trailing newline. [`patch_json`] compares them with what it read.
fn atomic_json_bytes<T>(value: &T) -> Result<Vec<u8>, serde_json::Error>
where
    T: serde::Serialize,
{
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn write_bytes_atomic_unlocked(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    write_atomic(path, bytes, None, Landing::Replace)?;
    Ok(())
}

/// Write `bytes` to `path` **owner-only and atomically**: a reader (or a
/// crash) sees the old contents or the new ones, never a short file, and the
/// file never exists with wider permissions than its owner's, not even for an
/// instant. For keys, tokens and configs that may hold credentials.
///
/// The bytes are staged in a uniquely named sibling — `0600` from creation on
/// Unix; on Windows restricted to its owner (`private_file::restrict_to_owner`)
/// before a byte is written, an ACL the rename keeps — synced, renamed over
/// `path`, and the directory synced after. Concurrent writers never share a
/// staging file; the last rename wins.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_private_atomic_mode(path, bytes, 0o600)
}

/// [`write_private_atomic`] with an explicit Unix mode for the file (its
/// caller's owner-only spelling, e.g. `0o400`). Unused on Windows, where the
/// file is restricted to its owner either way.
pub fn write_private_atomic_mode(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    write_atomic(path, bytes, Some(mode), Landing::Replace)
        .map(|_| ())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// [`write_private_atomic`] that never replaces an existing file: `Ok(false)`
/// when `path` already exists (its contents are untouched and nothing is
/// left behind). Two processes minting the same secret at once then agree on
/// whichever landed first instead of each keeping its own.
pub fn create_private_atomic(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    write_atomic(path, bytes, Some(0o600), Landing::NoClobber)
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// How [`write_atomic`] lands its staged file on the target.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Landing {
    /// Rename over whatever is there.
    Replace,
    /// Rename only when nothing is there; `Ok(false)` otherwise.
    NoClobber,
}

/// The one staged-write path. `private` is the file's Unix mode and asks for
/// the Windows owner-only ACL; `None` keeps the staging file's own mode
/// (`0600` from `tempfile` on Unix) and ACL. `Ok(false)` only for a
/// [`Landing::NoClobber`] write that found `path` taken.
fn write_atomic(path: &Path, bytes: &[u8], private: Option<u32>, landing: Landing) -> std::io::Result<bool> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // The temp file must sit on the same filesystem as the target for `rename`
    // to be atomic, so it goes in the target's own directory rather than /tmp.
    // NamedTempFile also makes the sibling name unique: concurrent writers can
    // never rename or truncate one another's staging file.
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    if let Some(mode) = private {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            staged.as_file().set_permissions(fs::Permissions::from_mode(mode))?;
        }
        #[cfg(windows)]
        {
            let _ = mode;
            crate::services::private_file::restrict_to_owner(staged.path());
        }
        #[cfg(not(any(unix, windows)))]
        let _ = mode;
    }
    staged.as_file_mut().write_all(bytes)?;
    staged.as_file_mut().sync_all()?;
    durability::record(DurabilityStep::FileSynced, staged.path());
    match landing {
        Landing::Replace => {
            staged.persist(path).map_err(|e| e.error)?;
        }
        Landing::NoClobber => match staged.persist_noclobber(path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
            Err(e) => return Err(e.error),
        },
    }
    durability::record(DurabilityStep::Persisted, path);
    // The data is durable, but the directory entry pointing at it is not until
    // the parent directory is flushed too: a crash after the rename can
    // otherwise roll the directory back to the old (or no) file (#172). Best
    // effort — a filesystem that refuses to fsync a directory (some network
    // and FUSE mounts) must not turn every state write into an error after the
    // bytes are already in place.
    sync_parent_dir(parent);
    durability::record(DurabilityStep::DirSynced, parent);
    Ok(true)
}

/// Flush a directory's entries to disk after a rename into it.
#[cfg(unix)]
fn sync_parent_dir(parent: &Path) {
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
}

/// Windows cannot open a directory as a plain file, and NTFS journals the
/// rename itself; nothing to flush from here.
#[cfg(not(unix))]
fn sync_parent_dir(_parent: &Path) {}

/// The steps of one atomic replacement, in the order they must happen: the
/// staged file's bytes, the rename, then the parent directory's entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DurabilityStep {
    FileSynced,
    Persisted,
    DirSynced,
}

/// A seam the tests observe the durability steps through: pulling the power
/// is not a unit test, so the write path records each step it took and a test
/// asserts the order. Compiled away outside tests.
pub(crate) mod durability {
    use super::DurabilityStep;
    use std::path::Path;

    #[cfg(test)]
    static LOG: std::sync::Mutex<Vec<(DurabilityStep, std::path::PathBuf)>> =
        std::sync::Mutex::new(Vec::new());

    #[cfg(test)]
    pub(crate) fn record(step: DurabilityStep, path: &Path) {
        LOG.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((step, path.to_path_buf()));
    }

    #[cfg(not(test))]
    #[inline]
    pub(crate) fn record(_step: DurabilityStep, _path: &Path) {}

    /// The steps recorded for writes under `dir`, in order. Tests run in
    /// parallel, so each one reads only its own temp directory's entries.
    #[cfg(test)]
    pub(crate) fn steps_under(dir: &Path) -> Vec<(DurabilityStep, std::path::PathBuf)> {
        LOG.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|(_, path)| path.starts_with(dir))
            .cloned()
            .collect()
    }
}

/// An advisory, cross-process lock on a sibling `<file>.lock` of a state
/// file, held for the guard's lifetime.
///
/// `JSON_MUTATION_LOCK` serialises this process; a second Tabtivity process (a
/// second window, the Mobile sidecar) needs the file system to do it. The
/// lock file is never removed: deleting one out from under a holder is how
/// two processes end up both holding "the" lock. Best effort — a filesystem
/// without advisory locks still gets the caller's revision check, which
/// closes the window for every practical interleaving.
pub struct FileLock {
    file: fs::File,
}

impl FileLock {
    /// Take the exclusive lock beside `path`, blocking until it is free.
    pub fn exclusive(path: &Path) -> std::io::Result<Self> {
        let lock_path = lock_path_for(path);
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)?;
        let _ = file.lock();
        Ok(Self { file })
    }
}

impl FileLock {
    /// Take the exclusive lock beside `path` only if nobody holds it, in this
    /// process or another: `Ok(None)` when it is held.
    pub fn try_exclusive(path: &Path) -> std::io::Result<Option<Self>> {
        let file = open_lock_file(path)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self { file })),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(fs::TryLockError::Error(e)) => Err(e),
        }
    }

    /// Take a shared lock beside `path`, blocking while an exclusive holder
    /// has it. Any number of shared holders coexist; an exclusive one waits
    /// for them all.
    pub fn shared(path: &Path) -> std::io::Result<Self> {
        let file = open_lock_file(path)?;
        file.lock_shared()?;
        Ok(Self { file })
    }
}

/// Open (creating) the `<file>.lock` sibling of `path`.
fn open_lock_file(path: &Path) -> std::io::Result<fs::File> {
    let lock_path = lock_path_for(path);
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new().create(true).truncate(false).write(true).open(&lock_path)
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// `calendar.json` → `calendar.json.lock`.
fn lock_path_for(path: &Path) -> std::path::PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".lock");
    path.with_file_name(name)
}

/// Create the state dir if missing and make it owner-only (0700).
///
/// It holds settings, session state, MCP audit logs and the agent-hook
/// scripts, and was created with the umask (typically 0775). That was safe only
/// while `$HOME` itself is 0700, which many distros don't default to. Called
/// once at startup, before anything writes into it; tightening the directory
/// covers the files already in it without touching each one. Best effort: a
/// failure (a state dir someone else owns) must not stop the app.
pub fn ensure_private_state_dir() {
    make_private_dir(&state_dir());
}

fn make_private_dir(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(dir) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
            }
        }
    }
}

/// State directory for Tabtivity's JSON files.
///
/// Linux: `~/.local/share/tabtivity/`
/// Windows: `%APPDATA%\tabtivity\`
/// macOS:   `~/Library/Application Support/tabtivity/`
///
/// An install made before the app was renamed has the folder under the old
/// name until `services::brand_migration` has moved it; until then that
/// folder is the state dir (`resolve_named_dir`).
pub fn state_dir() -> std::path::PathBuf {
    // Test/sandbox override. The state dir is written to by tests (the
    // per-project session state moved here out of the project tree), and a test
    // suite that writes into the developer's real `~/.local/share/tabtivity/` is
    // not a test suite. `start-tabtivity-dev-sandbox.sh` sets it too, paired with
    // `TABTIVITY_HOME` (see `paths::app_home`), so a dev window keeps its state
    // away from the packaged daily-driver instance's. Still not a user-facing
    // knob — whatever sets it for the app already owns the process.
    if let Some(dir) = state_dir_override() {
        return dir;
    }
    crate::services::brand_migration::resolve_named_dir(
        &crate::brand::PAIR,
        crate::brand::Name::STATE_DIR_NAME,
        &state_dir_base(),
        "state-dir",
    )
}

/// `<state_dir>/projects.json`, the project registry.
pub fn projects_path() -> std::path::PathBuf {
    state_dir().join("projects.json")
}

/// `<state_dir>/settings.json`, the app-wide settings.
pub fn settings_path() -> std::path::PathBuf {
    state_dir().join("settings.json")
}

/// The app-wide settings, or `None` when the file is missing or unreadable.
/// A caller that must fail closed on a corrupt file (`commands::copilot`)
/// reads it itself.
pub fn load_settings() -> Option<crate::schema::Settings> {
    read_json(&settings_path()).ok()
}

/// The folder the environment names as the state dir, if it names one.
pub fn state_dir_override() -> Option<std::path::PathBuf> {
    crate::brand::env("STATE_DIR").map(std::path::PathBuf::from)
}

/// The per-OS folder the state dir sits in.
pub fn state_dir_base() -> std::path::PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| paths::home_dir())
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        std::path::PathBuf::from(home).join(".local").join("share")
    }
}

/// `~/.local/share`, the folder [`home_share_dir`] sits in on every OS.
pub fn home_share_base() -> std::path::PathBuf {
    paths::home_dir().join(".local").join("share")
}

/// `~/.local/share/<state dir name>` on every OS, whatever the state-dir
/// override says. The local-model CLI homes and the frozen dev build's files
/// have always lived there — fixed per user, outside a sandboxed state dir —
/// so this is the one place that path is built. On Linux without an override
/// it is [`state_dir`].
pub fn home_share_dir() -> std::path::PathBuf {
    crate::services::brand_migration::resolve_named_dir(
        &crate::brand::PAIR,
        crate::brand::Name::STATE_DIR_NAME,
        &home_share_base(),
        "share-dir",
    )
}

/// The scope id of the root terminal — the one scope that is not a project and
/// is always there. It is what the frontend's `tabsByScope`/usage keys call it
/// (`stores/tabs`' `ROOT_SCOPE`), what `load_tab_session`/`save_tab_layout`
/// receive as a `project_id`, and — `project_key` being the identity on an
/// all-alphanumeric string — the name of its directory under the state dir.
///
/// Declared here, beside [`root_work_dir`] and [`project_key`], because the
/// backend's whole knowledge of the root scope is "this id maps to that folder,
/// and it is in no project list".
pub const ROOT_SCOPE: &str = "root";

/// The scope id of the chat assistant's tabs (`docs/assistant_plan.md`): a
/// scope of its own, neither root nor a project. Its session state is
/// `<state_dir>/sessions/assistant/` and its agent home `agent-homes/assistant`
/// (`project_key` is the identity on it). Unlike root its backend
/// `project_id` is `Some("assistant")`, not `None`: every place that reads a
/// `Some` id as a project has to meet this one first (`is_reserved_scope`).
pub const ASSISTANT_SCOPE: &str = "assistant";

/// Whether `id` names a scope the app owns — [`ROOT_SCOPE`] or
/// [`ASSISTANT_SCOPE`] — and so can never be a project or box id. Compared
/// through [`project_key`] and case-insensitively, because the id names a
/// directory under the state dir and a case-folding filesystem or the key
/// reduction would otherwise let `Assistant` or `assistant ` share the
/// reserved scope's state. The one funnel the project/box registries, the
/// layout sanitiser and the phone's discovery ask.
pub fn is_reserved_scope(id: &str) -> bool {
    let key = project_key(id.trim());
    [ROOT_SCOPE, ASSISTANT_SCOPE].iter().any(|scope| key.eq_ignore_ascii_case(scope))
}

/// Working directory for terminals that are not attached to a project.
pub fn root_work_dir() -> std::path::PathBuf {
    paths::root_work_dir()
}

/// Reduce a project id to a single path-safe component, so it can name a
/// directory under the state dir without any part of it being read as a path.
///
/// The **one** copy of this reduction. It used to exist three times over
/// (`services::sandbox::sanitize_key`, `services::agent_session::
/// sanitize_project_key`, and now the per-project session dir), and three copies
/// of a path-safety rule is two too many: a project id that one of them mapped
/// differently would put two subsystems' state in different places for the same
/// project, silently.
pub fn project_key(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "x".to_string()
    } else {
        safe
    }
}

/// `<state_dir>/sessions/` — the root of the per-project session state that used
/// to live inside each project tree.
pub fn sessions_root() -> std::path::PathBuf {
    state_dir().join("sessions")
}

/// `<state_dir>/sessions/<project key>/` — where a project's tab layout,
/// `open_apps` and host-bound markers live.
///
/// **The reason this directory exists at all**: everything under it is read back
/// by the host as *executable intent* (a tab's `cmd`/`env`/`cwd`, an app to
/// launch, a decision to skip the container), and its previous home was inside
/// the project tree — i.e. inside the project container's writable rw mount, and
/// inside any repository that gets cloned or imported as a project. A boundary
/// whose writable area contains the control plane of the thing enforcing it is
/// not a boundary. Nothing here is mounted into any container.
pub fn project_session_dir(project_id: &str) -> std::path::PathBuf {
    sessions_root().join(project_key(project_id))
}

/// Re-point every string in `value` that names `old` or a path under it at the
/// same place under `new`, in place. Returns whether anything changed.
///
/// Used after a project folder is renamed, so the registry entry, its
/// `project.json` and its saved tab layout (cwds, open files, a pinned venv
/// interpreter) follow the folder without each field being listed here. A match
/// is a whole path component: `/p/foo` rewrites `/p/foo` and `/p/foo/x`, never
/// `/p/foobar`.
pub fn rewrite_path_prefix(value: &mut serde_json::Value, old: &str, new: &str) -> bool {
    use serde_json::Value;
    if old.is_empty() {
        return false;
    }
    match value {
        Value::String(s) => {
            let rest = if s.as_str() == old {
                Some("")
            } else {
                s.strip_prefix(old)
                    .filter(|rest| rest.starts_with('/') || rest.starts_with('\\'))
            };
            match rest {
                Some(rest) => {
                    *s = format!("{new}{rest}");
                    true
                }
                None => false,
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| rewrite_path_prefix(item, old, new) | changed),
        Value::Object(map) => map
            .values_mut()
            .fold(false, |changed, item| rewrite_path_prefix(item, old, new) | changed),
        _ => false,
    }
}

use crate::clock::now_secs;

/// Current date in UTC as "YYYY-MM-DD".
pub fn today_utc() -> String {
    let (y, m, d, ..) = epoch_to_utc(now_secs());
    format!("{y:04}-{m:02}-{d:02}")
}

/// Current UTC hour as "YYYY-MM-DDTHH" — a sortable stamp whose first ten
/// characters are exactly [`today_utc`], so an hour bucket always folds into the
/// right day bucket.
pub fn hour_utc() -> String {
    let (y, m, d, h, ..) = epoch_to_utc(now_secs());
    format!("{y:04}-{m:02}-{d:02}T{h:02}")
}

/// Current timestamp as ISO-8601 UTC string (seconds precision).
pub fn iso_now() -> String {
    let (y, mo, d, h, mi, s) = epoch_to_utc(now_secs());
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}+00:00")
}

/// Convert a Unix timestamp to UTC calendar fields:
/// (year, month, day, hour, minute, second).
pub(crate) fn epoch_to_utc(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let mut days = secs / 86400;
    let mut year = 1970u64;
    loop {
        let dy = if is_leap_year(year) { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let month_lens: [u64; 12] = [
        31,
        if is_leap_year(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for &ml in &month_lens {
        if days < ml {
            break;
        }
        days -= ml;
        month += 1;
    }
    (year, month, days + 1, h, m, s)
}

pub(crate) fn is_leap_year(y: u64) -> bool {
    (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── rewrite_path_prefix ────────────────────────────────────────────────

    #[test]
    fn rewrite_path_prefix_follows_whole_components_only() {
        let mut v = serde_json::json!({
            "directory": "/p/foo",
            "tabs": [{ "cwd": "/p/foo/sub", "embedPath": "/p/foobar/x.md" }],
            "python": "/p/foo\\venv\\python.exe",
            "n": 3,
        });
        assert!(rewrite_path_prefix(&mut v, "/p/foo", "/p/bar"));
        assert_eq!(v["directory"], "/p/bar");
        assert_eq!(v["tabs"][0]["cwd"], "/p/bar/sub");
        assert_eq!(v["tabs"][0]["embedPath"], "/p/foobar/x.md");
        assert_eq!(v["python"], "/p/bar\\venv\\python.exe");
        assert_eq!(v["n"], 3);
        assert!(!rewrite_path_prefix(&mut v, "/p/foo", "/p/bar"));
        assert!(!rewrite_path_prefix(&mut v, "", "/x"));
    }

    // ── today_utc ──────────────────────────────────────────────────────────

    #[test]
    fn today_utc_has_date_format() {
        let s = today_utc();
        assert_eq!(s.len(), 10, "expected YYYY-MM-DD");
        let parts: Vec<&str> = s.split('-').collect();
        assert_eq!(parts.len(), 3);
        let y: u32 = parts[0].parse().expect("year numeric");
        let m: u32 = parts[1].parse().expect("month numeric");
        let d: u32 = parts[2].parse().expect("day numeric");
        assert!(y >= 2024, "year sanity");
        assert!((1..=12).contains(&m), "month range");
        assert!((1..=31).contains(&d), "day range");
    }

    #[test]
    fn today_utc_is_deterministic_within_same_day() {
        assert_eq!(today_utc(), today_utc());
    }

    // ── hour_utc ───────────────────────────────────────────────────────────

    #[test]
    fn hour_utc_has_hour_stamp_format() {
        let s = hour_utc();
        assert_eq!(s.len(), 13, "expected YYYY-MM-DDTHH, got {s}");
        let (date, hour) = s.split_once('T').expect("T separator");
        assert_eq!(date.len(), 10);
        let h: u32 = hour.parse().expect("hour numeric");
        assert!(h <= 23, "hour range: {h}");
    }

    #[test]
    fn hour_utc_is_prefixed_by_today_utc() {
        // net_usage derives the day bucket from the hour stamp's first ten
        // chars, so a divergence here would silently misfile every byte.
        let hour = hour_utc();
        let today = today_utc();
        assert_eq!(
            &hour[..10],
            today,
            "hour_utc must carry today_utc's date: hour={hour} today={today}"
        );
    }

    // ── iso_now ────────────────────────────────────────────────────────────

    #[test]
    fn iso_now_has_utc_offset() {
        let s = iso_now();
        assert!(s.ends_with("+00:00"), "must end with +00:00, got: {s}");
    }

    #[test]
    fn iso_now_contains_t_separator() {
        let s = iso_now();
        assert!(s.contains('T'), "ISO 8601 requires T separator: {s}");
    }

    #[test]
    fn iso_now_year_matches_today() {
        let today = today_utc();
        let now = iso_now();
        let year = &today[..4];
        assert!(
            now.starts_with(year),
            "iso_now year must match today: now={now} today={today}"
        );
    }

    // ── is_leap_year ───────────────────────────────────────────────────────

    #[test]
    fn year_divisible_by_4_is_leap() {
        assert!(is_leap_year(2024));
        assert!(is_leap_year(2000));
        assert!(is_leap_year(1600));
    }

    #[test]
    fn year_divisible_by_100_but_not_400_is_not_leap() {
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(1800));
        assert!(!is_leap_year(2100));
    }

    #[test]
    fn year_not_divisible_by_4_is_not_leap() {
        assert!(!is_leap_year(2023));
        assert!(!is_leap_year(2025));
        assert!(!is_leap_year(1999));
    }

    // ── epoch_to_utc ───────────────────────────────────────────────────────

    #[test]
    fn epoch_zero_is_unix_epoch() {
        let (y, mo, d, h, m, s) = epoch_to_utc(0);
        assert_eq!((y, mo, d, h, m, s), (1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_midnight_jan_2_1970() {
        let (y, mo, d, h, m, s) = epoch_to_utc(86400);
        assert_eq!((y, mo, d, h, m, s), (1970, 1, 2, 0, 0, 0));
    }

    #[test]
    fn epoch_end_of_1970() {
        // Dec 31 1970 23:59:59 = 86400*365 - 1 = 31535999
        let (y, mo, d, ..) = epoch_to_utc(31535999);
        assert_eq!((y, mo, d), (1970, 12, 31));
    }

    #[test]
    fn epoch_jan_1_2000() {
        // 2000-01-01T00:00:00Z = 946684800
        let (y, mo, d, h, m, s) = epoch_to_utc(946684800);
        assert_eq!((y, mo, d, h, m, s), (2000, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_feb_29_leap_year() {
        // 2000-02-29T00:00:00Z = 951782400
        let (y, mo, d, ..) = epoch_to_utc(951782400);
        assert_eq!((y, mo, d), (2000, 2, 29));
    }

    #[test]
    fn epoch_time_components_are_correct() {
        // 1717414496 = 2024-06-03T11:34:56Z (verified: 1717372800 + 41696)
        let (y, mo, d, h, m, s) = epoch_to_utc(1717414496);
        assert_eq!((y, mo, d), (2024, 6, 3));
        assert_eq!((h, m, s), (11, 34, 56));
    }

    #[test]
    fn epoch_seconds_wrap_at_60() {
        let (_, _, _, _, _, s) = epoch_to_utc(59);
        assert_eq!(s, 59);
        let (_, _, _, _, _, s2) = epoch_to_utc(60);
        assert_eq!(s2, 0);
    }

    #[test]
    fn epoch_minutes_wrap_at_60() {
        let (_, _, _, _, m, _) = epoch_to_utc(3599); // 59m59s
        assert_eq!(m, 59);
        let (_, _, _, _, m2, _) = epoch_to_utc(3600); // 1h0m0s
        assert_eq!(m2, 0);
    }

    #[test]
    fn today_and_iso_now_agree_on_the_date() {
        let today = today_utc();
        let now = iso_now();
        assert!(
            now.starts_with(&today),
            "iso_now must share today_utc's date: now={now} today={today}"
        );
    }

    // ── state_dir ─────────────────────────────────────────────────────────

    #[test]
    fn state_dir_ends_with_app() {
        let dir = state_dir();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // The current name — or the old one on a machine whose state dir has
        // not been moved yet (a developer's, whose installed build predates
        // the rename): the lookup falls back to it rather than start empty.
        let base = state_dir_base();
        let expected = if state_dir_override().is_none()
            && !base.join(crate::brand::STATE_DIR_NAME).exists()
            && base.join(crate::brand::LEGACY_STATE_DIR_NAME).exists()
        {
            crate::brand::LEGACY_STATE_DIR_NAME
        } else {
            crate::brand::STATE_DIR_NAME
        };
        assert_eq!(last, expected, "state_dir must end in '{expected}': {dir:?}");
    }

    // ── private state files ───────────────────────────────────────────────

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn make_private_dir_creates_and_tightens_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let fresh = tmp.path().join("a").join(crate::app_slug!());
        make_private_dir(&fresh);
        assert_eq!(mode_of(&fresh), 0o700);

        let loose = tmp.path().join("loose");
        fs::create_dir(&loose).unwrap();
        fs::set_permissions(&loose, fs::Permissions::from_mode(0o775)).unwrap();
        make_private_dir(&loose);
        assert_eq!(mode_of(&loose), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn write_json_file_creates_private_files_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let private = tmp.path().join("settings.json");
        write_json_file(&private, &serde_json::json!({"a": 1}), true).unwrap();
        assert_eq!(mode_of(&private), 0o600);
        let back: serde_json::Value = read_json(&private).unwrap();
        assert_eq!(back["a"], 1);

        // A project-folder file keeps the umask, like any plain `fs::write`.
        let shared = tmp.path().join("project.json");
        write_json_file(&shared, &serde_json::json!({}), false).unwrap();
        let plain = tmp.path().join("plain");
        fs::write(&plain, "").unwrap();
        assert_eq!(mode_of(&shared), mode_of(&plain));

        // Rewriting a shared file truncates it in place and leaves its mode
        // alone.
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o640)).unwrap();
        write_json_file(&shared, &serde_json::json!({"b": 2}), false).unwrap();
        assert_eq!(mode_of(&shared), 0o640);
        let back: serde_json::Value = read_json(&shared).unwrap();
        assert_eq!(back, serde_json::json!({"b": 2}));

        // Rewriting a private file replaces it whole, owner-only, even one an
        // older build left wider; no staging file is left beside it.
        fs::set_permissions(&private, fs::Permissions::from_mode(0o644)).unwrap();
        write_json_file(&private, &serde_json::json!({"c": 3}), true).unwrap();
        assert_eq!(mode_of(&private), 0o600);
        let back: serde_json::Value = read_json(&private).unwrap();
        assert_eq!(back, serde_json::json!({"c": 3}));
        let mut left: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["plain", "project.json", "settings.json"]);
    }

    // ── reserved scopes ───────────────────────────────────────────────────

    #[test]
    fn reserved_scopes_are_root_and_assistant_under_any_spelling() {
        for id in ["root", "assistant", "Assistant", "ROOT", " assistant ", "assistant\n"] {
            assert!(is_reserved_scope(id), "{id:?}");
        }
        for id in ["", "assistants", "my-assistant", "root2", "p1", "assistant/x", "box:assistant"] {
            assert!(!is_reserved_scope(id), "{id:?}");
        }
        assert_eq!(project_key(ASSISTANT_SCOPE), ASSISTANT_SCOPE, "the id names its own directory");
    }

    // ── root_work_dir ─────────────────────────────────────────────────────

    #[test]
    fn root_work_dir_ends_with_root() {
        let dir = root_work_dir();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(last, "root", "root_work_dir must end in 'root': {:?}", dir);
    }

    #[test]
    fn root_work_dir_parent_is_app() {
        let dir = root_work_dir();
        let parent = dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        // The home tree: the current name, or the old one where an install
        // made before the rename keeps it.
        assert!(
            parent == crate::brand::HOME_DIR_NAME || parent == crate::brand::LEGACY_HOME_DIR_NAME,
            "{dir:?}"
        );
    }

    // ── write_json / read_json ─────────────────────────────────────────────

    #[test]
    fn write_json_creates_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("deep/nested/dir/data.json");
        write_json(&path, &vec![1u32, 2, 3]).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn write_read_json_roundtrip_vec() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("list.json");
        let data = vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()];
        write_json(&path, &data).unwrap();
        let back: Vec<String> = read_json(&path).unwrap();
        assert_eq!(back, data);
    }

    #[test]
    fn write_read_json_roundtrip_map() {
        use std::collections::HashMap;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("map.json");
        let mut m = HashMap::new();
        m.insert("key".to_string(), 42u32);
        write_json(&path, &m).unwrap();
        let back: HashMap<String, u32> = read_json(&path).unwrap();
        assert_eq!(back["key"], 42);
    }

    #[test]
    fn read_json_error_on_missing_file() {
        let result: Result<Vec<String>, _> =
            read_json(std::path::Path::new("/nonexistent/file.json"));
        assert!(result.is_err());
    }

    #[test]
    fn read_json_error_on_invalid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad.json");
        std::fs::write(&path, b"not valid json{{{").unwrap();
        let result: Result<Vec<String>, _> = read_json(&path);
        assert!(result.is_err());
    }

    #[test]
    fn write_json_overwrites_existing_content() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("overwrite.json");
        write_json(&path, &vec!["first"]).unwrap();
        write_json(&path, &vec!["second", "third"]).unwrap();
        let back: Vec<String> = read_json(&path).unwrap();
        assert_eq!(back, vec!["second", "third"]);
    }

    // ── write_json_atomic ─────────────────────────────────────────────────

    #[test]
    fn write_json_atomic_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("atomic.json");
        write_json_atomic(&path, &vec![7u32, 8, 9]).unwrap();
        let back: Vec<u32> = read_json(&path).unwrap();
        assert_eq!(back, vec![7, 8, 9]);
    }

    #[test]
    fn write_json_atomic_creates_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("deep/nested/atomic.json");
        write_json_atomic(&path, &vec![1u32]).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn write_json_atomic_overwrites_and_leaves_no_temp_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("data.json");
        write_json_atomic(&path, &vec!["first"]).unwrap();
        write_json_atomic(&path, &vec!["second"]).unwrap();
        let back: Vec<String> = read_json(&path).unwrap();
        assert_eq!(back, vec!["second"]);
        // The rename must have consumed the temp file; a leftover would
        // accumulate one stale sibling per write.
        let strays: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "temp files left behind: {strays:?}");
    }

    /// #172: the staged bytes are flushed, then renamed into place, then the
    /// parent directory's entries are flushed — and all of it before the write
    /// returns. Observed through the `durability` seam rather than a crash rig.
    #[test]
    fn write_json_atomic_syncs_file_then_persists_then_syncs_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        let path = dir.join("durable.json");
        write_json_atomic(&path, &vec![1u32]).unwrap();

        let steps = durability::steps_under(&dir);
        let kinds: Vec<DurabilityStep> = steps.iter().map(|(step, _)| *step).collect();
        assert_eq!(
            kinds,
            vec![
                DurabilityStep::FileSynced,
                DurabilityStep::Persisted,
                DurabilityStep::DirSynced
            ],
            "steps recorded: {steps:?}"
        );
        // The file sync is of the *staged* sibling, not the target; the
        // directory sync is of the target's parent.
        let (_, staged) = &steps[0];
        assert_eq!(staged.parent(), Some(dir.as_path()));
        assert_ne!(staged, &path);
        assert_eq!(steps[1].1, path);
        assert_eq!(steps[2].1, dir);
    }

    #[test]
    fn patch_json_refuses_to_replace_corrupt_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("data.json");
        std::fs::write(&path, b"{broken").unwrap();

        let result = patch_json(&path, Vec::<u32>::new(), |values| {
            values.push(7);
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
    }

    /// What identifies one written file: a rewrite goes through a fresh temp
    /// file, so the inode moves even when the clock is too coarse to move mtime.
    #[cfg(unix)]
    fn file_identity(path: &Path) -> (u64, std::time::SystemTime) {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(path).unwrap();
        (meta.ino(), meta.modified().unwrap())
    }

    #[cfg(unix)]
    #[test]
    fn patch_json_skips_the_write_when_nothing_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("list.json");
        // A missing file is created even by a patch that changes nothing.
        patch_json(&path, vec![1_u32, 2], |_| Ok(())).unwrap();
        assert_eq!(read_json::<Vec<u32>>(&path).unwrap(), vec![1, 2]);
        let before = file_identity(&path);
        let steps = durability::steps_under(dir.path()).len();

        let seen = patch_json(&path, Vec::<u32>::new(), |values| Ok(values.len())).unwrap();
        assert_eq!(seen, 2, "the patch still runs and answers");
        assert_eq!(file_identity(&path), before, "a no-op patch rewrote the file");
        assert_eq!(durability::steps_under(dir.path()).len(), steps, "a no-op patch fsynced");

        patch_json(&path, Vec::<u32>::new(), |values| {
            values.push(3);
            Ok(())
        })
        .unwrap();
        assert_ne!(file_identity(&path).0, before.0, "a real patch must replace the file");
        assert_eq!(read_json::<Vec<u32>>(&path).unwrap(), vec![1, 2, 3]);
        assert_eq!(
            durability::steps_under(dir.path()).len(),
            steps + 3,
            "a real patch keeps the synced → persisted → dir-synced order",
        );
    }

    #[cfg(unix)]
    #[test]
    fn patch_json_rewrites_a_file_in_another_layout() {
        // Same value, different bytes (compact, no trailing newline — what a
        // hand edit or `write_json` leaves): normalised as it always was.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("map.json");
        fs::write(&path, r#"{"b":1,"a":[2]}"#).unwrap();
        let before = file_identity(&path);
        patch_json(&path, serde_json::Value::Null, |_| Ok(())).unwrap();
        assert_ne!(file_identity(&path).0, before.0);
        let value: serde_json::Value = read_json(&path).unwrap();
        assert_eq!(value, serde_json::json!({ "b": 1, "a": [2] }));
        // …and from then on an unchanged patch leaves it alone.
        let settled = file_identity(&path);
        patch_json(&path, serde_json::Value::Null, |_| Ok(())).unwrap();
        assert_eq!(file_identity(&path), settled);
    }

    #[test]
    fn patch_json_serializes_concurrent_read_modify_write() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("counter.json");
        write_json_atomic(&path, &0_u32).unwrap();
        let path = std::sync::Arc::new(path);
        let mut threads = Vec::new();
        for _ in 0..8 {
            let path = path.clone();
            threads.push(std::thread::spawn(move || {
                for _ in 0..25 {
                    patch_json(path.as_ref(), 0_u32, |counter| {
                        *counter += 1;
                        Ok(())
                    })
                    .unwrap();
                }
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(read_json::<u32>(path.as_ref()).unwrap(), 200);
    }

    /// The owner-only writer: the bytes land whole, the file is `0600` on
    /// Unix even when it replaces a world-readable one (a new inode, never a
    /// chmod after the fact), and no staging sibling is left behind.
    #[test]
    fn write_private_atomic_lands_owner_only_and_leaves_no_staging_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("token");
        write_private_atomic(&path, b"first").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_private_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "a replaced shared file comes back owner-only");
        }
        let names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["token".to_string()]);
    }

    /// A replacement goes through a sibling: the target keeps its old bytes
    /// until the rename, which comes after the staged bytes are synced.
    #[test]
    fn write_private_atomic_replaces_through_a_synced_sibling() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        let path = dir.join("key");
        fs::write(&path, b"old").unwrap();
        write_private_atomic(&path, b"new").unwrap();
        let steps = durability::steps_under(&dir);
        let kinds: Vec<DurabilityStep> = steps.iter().map(|(step, _)| *step).collect();
        assert_eq!(
            kinds,
            vec![DurabilityStep::FileSynced, DurabilityStep::Persisted, DurabilityStep::DirSynced],
            "steps recorded: {steps:?}"
        );
        assert_ne!(steps[0].1, path, "the bytes are synced in a sibling, not the target");
        assert_eq!(steps[0].1.parent(), Some(dir.as_path()));
        assert_eq!(steps[1].1, path);
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn write_private_atomic_mode_applies_the_requested_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("read-only.key");
        write_private_atomic_mode(&path, b"k", 0o400).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o400);
        assert_eq!(fs::read(&path).unwrap(), b"k");
    }

    /// The no-clobber form lands once; a second writer finds the file taken,
    /// leaves its bytes alone and leaves nothing behind.
    #[test]
    fn create_private_atomic_never_replaces_an_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("web.token");
        assert!(create_private_atomic(&path, b"winner").unwrap());
        assert!(!create_private_atomic(&path, b"loser").unwrap());
        assert_eq!(fs::read(&path).unwrap(), b"winner");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1, "no staging file left");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
