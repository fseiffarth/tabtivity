//! The phone's **Upload here** (`docs/done/phone_upload_plan.md`): files picked on
//! the phone land in the project folder the read-only browser (`files.rs`)
//! stands in — the one write into a visible project folder, and the folder the
//! user chose is the consent.
//!
//! Add-only. A new file is created under the phone's own name
//! ([`inbox::safe_name`], no stamp; a clash becomes `stem-2.ext`), never over
//! an existing one, never in a folder whose path has a segment starting with
//! `.` (`.github/workflows`, `.cargo`, `.vscode` … — a new file there can
//! change what tools run), and no folder is made. The walk is the browser's
//! [`ProjectDir`] walk from the root: no link followed anywhere. The host-wide
//! switch (`tabtivity_mobile_host.project_uploads`, default off) is read per
//! request and counts only while `project_files` is on too.
//!
//! Each landed file appends one JSON line to the upload log
//! (`<state_dir>/mobile-control/phone-uploads.jsonl`). The sidecar is its only
//! writer; the desktop reads it to list and undo recent uploads. The log is
//! advisory and the **disk is the truth**: a record counts only while the file
//! at its path is still a regular file reached without links, with the same
//! size and SHA-256. An undo deletes only such a file — one this feature wrote
//! and nobody changed since — and never touches the log.

use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};

use app_core::sync::LockExt;
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::files::{self, FilesError, ProjectDir};
use super::inbox::{self, MAX_INBOX_FILE};

/// The upload log's leaf, inside the sidecar's private state folder.
pub const LOG_FILE: &str = "phone-uploads.jsonl";
/// The sidecar's private state folder (`config::MobileConfig::control_dir`).
const CONTROL_DIR: &str = "mobile-control";
/// What this feature may write into one project within [`CAP_WINDOW`].
pub const MAX_UPLOADS_PER_DAY: u64 = 1024 * 1024 * 1024;
/// The rolling window of the cap, in seconds.
const CAP_WINDOW: u64 = 24 * 60 * 60;
/// How long a log line is kept; older ones are dropped when the log is
/// rewritten.
const KEEP_LOG: u64 = 7 * 24 * 60 * 60;
/// Characters kept of the phone's device label.
const MAX_PHONE: usize = 64;

/// Serializes the sidecar's log writes (cap check, file creation, append,
/// compaction): two uploads at once must not both pass the cap.
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Whether the phone may upload: the browser switch (`files::files_open`)
/// **and** `project_uploads`, both read from `settings.json` per call, so
/// turning either off closes the route at once.
pub fn uploads_open(state_dir: &Path) -> bool {
    files::files_open(state_dir)
        && fs::read(state_dir.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|settings| {
                settings
                    .get(crate::brand::MOBILE_HOST_KEY)?
                    .get("project_uploads")?
                    .as_bool()
            })
            .unwrap_or(false)
}

/// Whether the folder `rel_dir` (a path `files::unseal` answered; `""` is the
/// project root) takes uploads: no segment starts with a dot.
pub fn accepts(rel_dir: &str) -> bool {
    rel_dir.is_empty() || rel_dir.split('/').all(|segment| !segment.starts_with('.'))
}

/// One landed file, as the log keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// 16 random bytes, base64url — what the desktop undoes a row by.
    pub id: String,
    /// The project's raw id (the log never leaves the desktop).
    pub project: String,
    /// Project-relative path of the file, `/`-joined.
    pub rel: String,
    pub size: u64,
    /// Lowercase hex SHA-256 of the bytes written.
    pub sha256: String,
    /// Unix seconds it landed.
    pub at: u64,
    /// The phone's device label, when the auth layer had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

/// What the route answers for a landed file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Landed {
    /// The log record's id.
    pub id: String,
    /// The leaf as written (sanitized, made unique).
    pub name: String,
    /// Project-relative path of the new file.
    pub rel: String,
    pub size: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UploadError {
    /// The switch (or the browser's) is off — the route's check.
    Off,
    /// The folder takes no uploads: a dot segment, a link or a file on the
    /// way, or a folder that is gone.
    Refused,
    /// The body had no bytes.
    Empty,
    /// The body exceeds `inbox::MAX_INBOX_FILE`.
    TooLarge,
    /// The project already took [`MAX_UPLOADS_PER_DAY`] in the last 24 h.
    Full,
    /// The project root is gone.
    Unavailable,
    /// No logged, unchanged upload at that path (undo).
    NotFound,
    Io(String),
}

impl UploadError {
    /// The wire code the phone (and the desktop's undo) maps to a message.
    pub fn code(&self) -> &'static str {
        match self {
            UploadError::Off => "uploads_off",
            UploadError::Refused => "upload_refused",
            UploadError::Empty => "empty_file",
            UploadError::TooLarge => "file_too_large",
            UploadError::Full => "uploads_full",
            UploadError::Unavailable => "project_unavailable",
            UploadError::NotFound => "file_not_found",
            UploadError::Io(_) => "write_failed",
        }
    }
}

fn log_path(state_dir: &Path) -> PathBuf {
    state_dir.join(CONTROL_DIR).join(LOG_FILE)
}

/// The log's records in file order (oldest first), and whether a line was
/// unparseable. A missing log is empty; an unreadable one reads as empty too
/// (see [`try_read_log`] for a caller that must tell the two apart).
fn read_log(state_dir: &Path) -> (Vec<Record>, bool) {
    try_read_log(state_dir).unwrap_or_default()
}

/// [`read_log`], but a log that exists and cannot be read is an error rather
/// than "nothing logged". Read as bytes, line by line: a line torn
/// mid-character (a short append on a full disk) is one garbage line, not a
/// log that no longer reads as text at all.
fn try_read_log(state_dir: &Path) -> std::io::Result<(Vec<Record>, bool)> {
    let bytes = match fs::read(log_path(state_dir)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(error) => return Err(error),
    };
    let mut garbage = false;
    let records = bytes
        .split(|&byte| byte == b'\n')
        .filter(|line| !line.trim_ascii().is_empty())
        .filter_map(|line| {
            let record = serde_json::from_slice::<Record>(line).ok();
            garbage |= record.is_none();
            record
        })
        .collect();
    Ok((records, garbage))
}

/// Appends one record as a single write on an append handle, so a reader
/// (the desktop) sees whole lines; first rewriting the log without lines
/// older than [`KEEP_LOG`] (and unparseable ones) when its first line is
/// that old or a line is garbage. `(records, garbage)` is the log as
/// [`read_log`] just read it. Caller holds [`LOG_LOCK`].
fn append(state_dir: &Path, (records, garbage): (Vec<Record>, bool), record: &Record, now: u64) -> Result<(), String> {
    let dir = state_dir.join(CONTROL_DIR);
    super::store::ensure_private_dir(&dir)?;
    let path = log_path(state_dir);
    let stale = |record: &Record| record.at.saturating_add(KEEP_LOG) < now;
    if garbage || records.first().is_some_and(stale) {
        let mut kept = Vec::new();
        for record in records.iter().filter(|record| !stale(record)) {
            kept.extend(serde_json::to_vec(record).map_err(|e| e.to_string())?);
            kept.push(b'\n');
        }
        super::store::write_bytes_atomic(&path, &kept, 0o600)?;
    }
    let mut line = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(&line).map_err(|e| format!("append {}: {e}", path.display()))
}

/// Writes `bytes` as a new file into the project folder `rel_dir` (a path
/// `files::unseal` answered; `""` is the root) under the phone's name, and
/// logs it. `root` is the project's directory, `raw_id` its raw id, `phone`
/// the device label if one is known. The switch is the caller's check.
pub fn store(
    state_dir: &Path,
    root: &Path,
    raw_id: &str,
    rel_dir: &str,
    raw_name: &str,
    bytes: &[u8],
    phone: Option<&str>,
) -> Result<Landed, UploadError> {
    store_at(state_dir, root, raw_id, rel_dir, raw_name, bytes, phone, crate::clock::now_secs())
}

#[allow(clippy::too_many_arguments)]
fn store_at(
    state_dir: &Path,
    root: &Path,
    raw_id: &str,
    rel_dir: &str,
    raw_name: &str,
    bytes: &[u8],
    phone: Option<&str>,
    now: u64,
) -> Result<Landed, UploadError> {
    if bytes.is_empty() {
        return Err(UploadError::Empty);
    }
    if bytes.len() > MAX_INBOX_FILE {
        return Err(UploadError::TooLarge);
    }
    if !accepts(rel_dir) {
        return Err(UploadError::Refused);
    }
    // Held from here on: a folder swapped for a link after the walk does not
    // move the write.
    let dir = ProjectDir::open(root, rel_dir).map_err(|error| match error {
        FilesError::Unavailable => UploadError::Unavailable,
        _ => UploadError::Refused,
    })?;
    let _guard = LOG_LOCK.lock_ok();
    let log = read_log(state_dir);
    // The log alone, not the disk: an undone upload still counts.
    let written: u64 = log
        .0
        .iter()
        .filter(|record| record.project == raw_id && record.at.saturating_add(CAP_WINDOW) > now)
        .fold(0u64, |total, record| total.saturating_add(record.size));
    if written.saturating_add(bytes.len() as u64) > MAX_UPLOADS_PER_DAY {
        return Err(UploadError::Full);
    }
    let id = super::auth::random_bytes::<16>()
        .map(|bytes| Base64UrlUnpadded::encode_string(&bytes))
        .map_err(UploadError::Io)?;
    let name = inbox::create_unique(&dir, &inbox::safe_name(raw_name), bytes)
        .map_err(|error| UploadError::Io(error.to_string()))?;
    let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
    let record = Record {
        id: id.clone(),
        project: raw_id.to_string(),
        rel: rel.clone(),
        size: bytes.len() as u64,
        sha256: crate::digest::sha256_hex(bytes),
        at: now,
        phone: phone.map(|phone| phone.chars().take(MAX_PHONE).collect()),
    };
    if let Err(error) = append(state_dir, log, &record, now) {
        // Unlogged, the file could be neither listed nor undone, nor would it
        // count against the cap: take it back.
        let _ = dir.remove_file(&name);
        return Err(UploadError::Io(error));
    }
    Ok(Landed { id, name, rel, size: record.size })
}

/// `rel`'s folder, held, and its leaf — `None` for a path the walk refuses.
fn held_parent<'a>(root: &Path, rel: &'a str) -> Option<(ProjectDir, &'a str)> {
    let (parent, leaf) = rel.rsplit_once('/').unwrap_or(("", rel));
    let dir = ProjectDir::open(root, parent).ok()?;
    Some((dir, leaf))
}

/// The SHA-256 of an open file's first `limit` bytes, as hex.
fn hash_file(file: fs::File, limit: u64) -> Option<String> {
    let mut hasher = Sha256::new();
    let mut reader = file.take(limit);
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hasher.update(&buffer[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    Some(crate::digest::hex(&hasher.finalize()))
}

/// Whether `leaf` in the held `dir` is a regular file (no link) with `size`
/// bytes and the SHA-256 `sha`, hashed through the handle that proved it.
fn unchanged(dir: &ProjectDir, leaf: &str, size: u64, sha: &str) -> bool {
    let Some((file, meta)) = dir.open_file(leaf) else {
        return false;
    };
    // One byte past `size`, so a file that grew since `meta` hashes differently.
    meta.len() == size && hash_file(file, size.saturating_add(1)).is_some_and(|hash| hash == sha)
}

/// The logged record with this id, if any — the desktop's undo looks its
/// project and path up by it.
pub fn find(state_dir: &Path, id: &str) -> Option<Record> {
    read_log(state_dir).0.into_iter().rev().find(|record| record.id == id)
}

/// Deletes the uploaded file at `rel` of the project `raw_id` (root `root`)
/// — only while a log record names it and the file is unchanged since
/// (re-hashed now); anything else is `NotFound`. The log is not touched.
pub fn undo(state_dir: &Path, root: &Path, raw_id: &str, rel: &str) -> Result<(), UploadError> {
    let (records, _) = read_log(state_dir);
    let Some((dir, leaf)) = held_parent(root, rel) else {
        return Err(UploadError::NotFound);
    };
    // Newest first: a name freed by an undo and taken by a later upload.
    let logged = records
        .iter()
        .rev()
        .filter(|record| record.project == raw_id && record.rel == rel)
        .any(|record| unchanged(&dir, leaf, record.size, &record.sha256));
    if !logged {
        return Err(UploadError::NotFound);
    }
    dir.remove_file(leaf).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => UploadError::NotFound,
        _ => UploadError::Io(error.to_string()),
    })
}

/// What `recent` last saw of a record's file, keyed by record id and root:
/// its size and mtime then, and whether it was unchanged.
type Seen = HashMap<(String, PathBuf), (u64, Option<SystemTime>, bool)>;
static SEEN: Mutex<Option<Seen>> = Mutex::new(None);

/// The records that landed within `within`, newest first, whose file is still
/// intact. `root_of` maps a raw project id to its directory (`None` drops the
/// project's records: unknown, or remote now). The desktop polls this, so a
/// file is re-hashed only when its size or mtime changed since the last call.
/// A log that exists but cannot be read is an error, never an empty list: the
/// desktop prunes its **Keep** marks to what a good read lists.
pub fn recent(
    state_dir: &Path,
    within: Duration,
    root_of: impl Fn(&str) -> Option<PathBuf>,
) -> std::io::Result<Vec<Record>> {
    recent_at(state_dir, within, root_of, crate::clock::now_secs())
}

fn recent_at(
    state_dir: &Path,
    within: Duration,
    root_of: impl Fn(&str) -> Option<PathBuf>,
    now: u64,
) -> std::io::Result<Vec<Record>> {
    let (records, _) = try_read_log(state_dir)?;
    let since = now.saturating_sub(within.as_secs());
    let mut roots: HashMap<String, Option<PathBuf>> = HashMap::new();
    let mut seen = SEEN.lock_ok();
    let previous = seen.take().unwrap_or_default();
    let mut next = HashMap::new();
    let mut out = Vec::new();
    // One row per file: the same bytes uploaded again under a name an undo
    // freed leave two records for it, and the newest speaks for both.
    let mut listed = std::collections::HashSet::new();
    for record in records.into_iter().rev() {
        if record.at < since || listed.contains(&(record.project.clone(), record.rel.clone())) {
            continue;
        }
        let root = roots
            .entry(record.project.clone())
            .or_insert_with(|| root_of(&record.project))
            .clone();
        let Some(root) = root else { continue };
        let Some((dir, leaf)) = held_parent(&root, &record.rel) else { continue };
        let Some((_, meta)) = dir.open_file(leaf) else { continue };
        let stamp = (meta.len(), meta.modified().ok());
        let key = (record.id.clone(), root);
        let ok = match previous.get(&key) {
            Some(&(size, modified, ok)) if (size, modified) == stamp => ok,
            _ => unchanged(&dir, leaf, record.size, &record.sha256),
        };
        next.insert(key, (stamp.0, stamp.1, ok));
        if ok {
            listed.insert((record.project.clone(), record.rel.clone()));
            out.push(record);
        }
    }
    // Only what this call saw: the cache never outgrows the log's window.
    *seen = Some(next);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_788_177_600; // 2026-08-31 12:00:00 UTC
    const HOUR: u64 = 60 * 60;

    struct Fixture {
        _dir: tempfile::TempDir,
        state: PathBuf,
        root: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let root = dir.path().join("project");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        Fixture { state, root, _dir: dir }
    }

    fn put(f: &Fixture, rel_dir: &str, name: &str, bytes: &[u8]) -> Result<Landed, UploadError> {
        store_at(&f.state, &f.root, "p1", rel_dir, name, bytes, Some("Pixel"), NOW)
    }

    fn log_lines(f: &Fixture) -> Vec<String> {
        fs::read_to_string(log_path(&f.state)).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    fn write_log(f: &Fixture, records: &[Record]) {
        fs::create_dir_all(f.state.join(CONTROL_DIR)).unwrap();
        let text: String = records.iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect();
        fs::write(log_path(&f.state), text).unwrap();
    }

    fn record(project: &str, rel: &str, size: u64, at: u64) -> Record {
        Record {
            id: format!("id-{project}-{rel}-{at}"),
            project: project.into(),
            rel: rel.into(),
            size,
            sha256: "0".repeat(64),
            at,
            phone: None,
        }
    }

    fn root_of(f: &Fixture) -> impl Fn(&str) -> Option<PathBuf> + '_ {
        move |id: &str| (id == "p1").then(|| f.root.clone())
    }

    fn rels(records: &[Record]) -> Vec<&str> {
        records.iter().map(|r| r.rel.as_str()).collect()
    }

    #[test]
    fn the_switch_needs_the_browser_switch_too() {
        let f = fixture();
        let write = |value: Value| fs::write(f.state.join("settings.json"), value.to_string()).unwrap();
        assert!(!uploads_open(&f.state));
        let key = concat!(crate::app_slug!(), "_mobile_host");
        write(serde_json::json!({ key: { "project_uploads": true } }));
        assert!(!uploads_open(&f.state), "project_files is off");
        write(serde_json::json!({ key: { "project_files": true } }));
        assert!(!uploads_open(&f.state), "project_uploads defaults to off");
        write(serde_json::json!({ key: { "project_files": true, "project_uploads": true } }));
        assert!(uploads_open(&f.state));
    }

    #[test]
    fn a_dot_segment_anywhere_refuses_the_folder() {
        assert!(accepts(""));
        assert!(accepts("docs"));
        assert!(accepts("docs/sub.dir/x"));
        for refused in [".github", ".github/workflows", "docs/.hidden", ".cargo", "a/b/.vscode"] {
            assert!(!accepts(refused), "{refused}");
        }
    }

    #[test]
    fn a_file_lands_under_its_own_name_and_is_logged() {
        let f = fixture();
        let landed = put(&f, "docs", "Report 2026.pdf", b"%PDF-1.7").unwrap();
        assert_eq!((landed.name.as_str(), landed.rel.as_str(), landed.size), ("Report_2026.pdf", "docs/Report_2026.pdf", 8));
        assert_eq!(fs::read(f.root.join("docs").join("Report_2026.pdf")).unwrap(), b"%PDF-1.7");
        let at_root = put(&f, "", "notes.txt", b"x").unwrap();
        assert_eq!(at_root.rel, "notes.txt");
        assert!(f.root.join("notes.txt").is_file());

        let lines = log_lines(&f);
        assert_eq!(lines.len(), 2);
        let logged: Record = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(logged.id, landed.id);
        assert_eq!(Base64UrlUnpadded::decode_vec(&logged.id).unwrap().len(), 16);
        assert_eq!((logged.project.as_str(), logged.rel.as_str(), logged.size, logged.at), ("p1", "docs/Report_2026.pdf", 8, NOW));
        assert_eq!(logged.sha256, crate::digest::sha256_hex(b"%PDF-1.7"));
        assert_eq!(logged.phone.as_deref(), Some("Pixel"));
        assert_eq!(find(&f.state, &landed.id), Some(logged));
        assert_eq!(find(&f.state, "nope"), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_log_is_private_and_the_new_file_has_no_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        put(&f, "docs", "run.sh", b"#!/bin/sh\n").unwrap();
        assert_eq!(fs::metadata(log_path(&f.state)).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(f.state.join(CONTROL_DIR)).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(f.root.join("docs").join("run.sh")).unwrap().permissions().mode() & 0o111, 0);
    }

    #[test]
    fn a_clash_gets_a_suffix_and_nothing_is_overwritten() {
        let f = fixture();
        fs::write(f.root.join("docs").join("a.txt"), b"mine").unwrap();
        assert_eq!(put(&f, "docs", "a.txt", b"one").unwrap().name, "a-2.txt");
        assert_eq!(put(&f, "docs", "a.txt", b"two").unwrap().name, "a-3.txt");
        assert_eq!(fs::read(f.root.join("docs").join("a.txt")).unwrap(), b"mine");
    }

    #[test]
    fn dangerous_names_are_sanitized() {
        let f = fixture();
        assert_eq!(put(&f, "docs", ".envrc", b"x").unwrap().name, "envrc");
        assert_eq!(put(&f, "docs", "../../escape.txt", b"x").unwrap().rel, "docs/escape.txt");
        assert_eq!(put(&f, "docs", "CON.txt", b"x").unwrap().name, "CON_.txt");
        assert!(!f.root.join("escape.txt").exists());
    }

    #[test]
    fn dot_folders_bad_folders_and_bad_bodies_are_refused() {
        let f = fixture();
        fs::create_dir_all(f.root.join(".github").join("workflows")).unwrap();
        fs::create_dir_all(f.root.join("docs").join(".hidden")).unwrap();
        fs::write(f.root.join("file.txt"), b"x").unwrap();
        for folder in [".github", ".github/workflows", "docs/.hidden"] {
            assert_eq!(put(&f, folder, "ci.yml", b"x"), Err(UploadError::Refused), "{folder}");
        }
        assert_eq!(put(&f, "missing", "a.txt", b"x"), Err(UploadError::Refused));
        assert_eq!(put(&f, "file.txt", "a.txt", b"x"), Err(UploadError::Refused));
        assert_eq!(put(&f, "docs/../..", "a.txt", b"x"), Err(UploadError::Refused));
        assert_eq!(put(&f, "docs", "a.txt", b""), Err(UploadError::Empty));
        assert_eq!(put(&f, "docs", "a.bin", &vec![0u8; MAX_INBOX_FILE + 1]), Err(UploadError::TooLarge));
        assert_eq!(
            store_at(&f.state, &f.root.join("gone"), "p1", "", "a.txt", b"x", None, NOW),
            Err(UploadError::Unavailable)
        );
        assert!(fs::read_dir(f.root.join(".github").join("workflows")).unwrap().next().is_none());
        assert!(log_lines(&f).is_empty());
        assert_eq!(UploadError::Full.code(), "uploads_full");
        assert_eq!(UploadError::Refused.code(), "upload_refused");
    }

    #[test]
    fn the_rolling_cap_counts_this_projects_last_day_from_the_log() {
        let f = fixture();
        let near = MAX_UPLOADS_PER_DAY - 2;
        write_log(&f, &[
            record("p1", "docs/old.bin", MAX_UPLOADS_PER_DAY, NOW - CAP_WINDOW - 1),
            record("p1", "docs/big.bin", near, NOW - HOUR),
            record("p2", "big.bin", MAX_UPLOADS_PER_DAY, NOW - HOUR),
        ]);
        assert!(put(&f, "docs", "a.txt", b"ab").is_ok(), "exactly at the cap");
        assert_eq!(put(&f, "docs", "b.txt", b"c"), Err(UploadError::Full));
        assert!(!f.root.join("docs").join("b.txt").exists());
        // Another project's uploads are its own.
        let other = f.root.parent().unwrap().join("other");
        fs::create_dir_all(&other).unwrap();
        assert!(store_at(&f.state, &other, "p3", "", "c.txt", b"x", None, NOW).is_ok());
        // An undone upload still counts.
        undo(&f.state, &f.root, "p1", "docs/a.txt").unwrap();
        assert_eq!(put(&f, "docs", "b.txt", b"c"), Err(UploadError::Full));
    }

    #[test]
    fn undo_deletes_only_a_logged_unchanged_file_of_that_project() {
        let f = fixture();
        let landed = put(&f, "docs", "a.txt", b"one").unwrap();
        let path = f.root.join("docs").join("a.txt");
        assert_eq!(undo(&f.state, &f.root, "p2", &landed.rel), Err(UploadError::NotFound), "another project");
        assert_eq!(undo(&f.state, &f.root, "p1", &landed.rel), Ok(()));
        assert!(!path.exists());
        assert_eq!(undo(&f.state, &f.root, "p1", &landed.rel), Err(UploadError::NotFound), "already gone");

        // Edited after it landed (same size, other bytes): kept.
        let edited = put(&f, "docs", "b.txt", b"two").unwrap();
        fs::write(f.root.join("docs").join("b.txt"), b"TWO").unwrap();
        assert_eq!(undo(&f.state, &f.root, "p1", &edited.rel), Err(UploadError::NotFound));
        assert!(f.root.join("docs").join("b.txt").is_file());

        // Never uploaded: kept.
        fs::write(f.root.join("docs").join("mine.txt"), b"one").unwrap();
        assert_eq!(undo(&f.state, &f.root, "p1", "docs/mine.txt"), Err(UploadError::NotFound));
        assert!(f.root.join("docs").join("mine.txt").is_file());
        assert_eq!(undo(&f.state, &f.root, "p1", "docs/../x"), Err(UploadError::NotFound));

        // A name freed by an undo and taken again: the newer record matches.
        let again = put(&f, "docs", "a.txt", b"three").unwrap();
        assert_eq!(again.rel, "docs/a.txt");
        assert_eq!(undo(&f.state, &f.root, "p1", &again.rel), Ok(()));
        assert!(!path.exists());
    }

    #[test]
    fn recent_lists_intact_files_newest_first_within_the_window() {
        let f = fixture();
        let day = Duration::from_secs(CAP_WINDOW);
        let old = store_at(&f.state, &f.root, "p1", "docs", "old.txt", b"old", None, NOW - CAP_WINDOW - 1).unwrap();
        put(&f, "docs", "a.txt", b"a").unwrap();
        let moved = put(&f, "docs", "moved.txt", b"m").unwrap();
        let edited = put(&f, "", "edited.txt", b"e").unwrap();
        put(&f, "docs", "c.txt", b"c").unwrap();
        assert!(f.root.join("docs").join("old.txt").is_file());
        assert_eq!(old.rel, "docs/old.txt");
        let listed = recent_at(&f.state, day, root_of(&f), NOW).unwrap();
        assert_eq!(rels(&listed), ["docs/c.txt", "edited.txt", "docs/moved.txt", "docs/a.txt"]);
        assert_eq!(listed[0].phone.as_deref(), Some("Pixel"));

        fs::rename(f.root.join("docs").join("moved.txt"), f.root.join("docs").join("elsewhere.txt")).unwrap();
        fs::write(f.root.join("edited.txt"), b"changed").unwrap();
        let listed = recent_at(&f.state, day, root_of(&f), NOW).unwrap();
        assert_eq!(rels(&listed), ["docs/c.txt", "docs/a.txt"], "{moved:?} {edited:?}");
        // An unknown (or now remote) project drops out.
        assert!(recent_at(&f.state, day, |_| None, NOW).unwrap().is_empty());
    }

    /// The cache re-hashes on a size or mtime change only, and an edit that
    /// keeps the size still changes the mtime.
    #[test]
    fn recent_rehashes_a_file_whose_mtime_changed() {
        let f = fixture();
        let day = Duration::from_secs(CAP_WINDOW);
        put(&f, "docs", "same.txt", b"abc").unwrap();
        assert_eq!(rels(&recent_at(&f.state, day, root_of(&f), NOW).unwrap()), ["docs/same.txt"]);
        let path = f.root.join("docs").join("same.txt");
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        (&file).write_all(b"xyz").unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(60)).unwrap();
        drop(file);
        assert!(recent_at(&f.state, day, root_of(&f), NOW).unwrap().is_empty());
    }

    #[test]
    fn stale_and_garbage_lines_are_dropped_when_the_log_is_rewritten() {
        let f = fixture();
        write_log(&f, &[record("p1", "docs/stale.txt", 1, NOW - KEEP_LOG - 1), record("p1", "docs/kept.txt", 1, NOW - HOUR)]);
        let landed = put(&f, "docs", "new.txt", b"x").unwrap();
        let logged: Vec<String> = log_lines(&f).iter().map(|l| serde_json::from_str::<Record>(l).unwrap().rel).collect();
        assert_eq!(logged, ["docs/kept.txt", landed.rel.as_str()]);

        // A garbage line is skipped by every reader, and dropped at the next write.
        let mut text = fs::read_to_string(log_path(&f.state)).unwrap();
        text.insert_str(0, "{ not json\n");
        fs::write(log_path(&f.state), text).unwrap();
        assert_eq!(find(&f.state, &landed.id).map(|r| r.rel), Some(landed.rel.clone()));
        assert_eq!(rels(&recent_at(&f.state, Duration::from_secs(CAP_WINDOW), root_of(&f), NOW).unwrap()), [landed.rel.as_str()]);
        put(&f, "docs", "next.txt", b"y").unwrap();
        let lines = log_lines(&f);
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|l| serde_json::from_str::<Record>(l).is_ok()));
    }

    /// The desktop prunes its Keep marks to what `recent` lists, so a log it
    /// cannot read must not answer "nothing uploaded": every kept row would be
    /// un-kept and show again on the next good read. No log yet is empty.
    #[test]
    fn recent_fails_on_an_unreadable_log_but_not_on_a_missing_one() {
        let f = fixture();
        let day = Duration::from_secs(CAP_WINDOW);
        assert!(recent_at(&f.state, day, root_of(&f), NOW).unwrap().is_empty());
        // A directory where the log should be: reading it fails on every OS.
        fs::create_dir_all(log_path(&f.state)).unwrap();
        assert!(recent_at(&f.state, day, root_of(&f), NOW).is_err());
    }

    /// A short append on a full disk can cut a line inside a multi-byte
    /// character. That line alone is garbage: the rest of the log still counts
    /// against the cap, lists and undoes, and the next write drops the line.
    #[test]
    fn a_line_torn_mid_character_does_not_blind_the_log() {
        let f = fixture();
        write_log(&f, &[record("p1", "docs/big.bin", MAX_UPLOADS_PER_DAY - 1, NOW - HOUR)]);
        let landed = put(&f, "docs", "a.txt", b"a").unwrap();
        let mut bytes = fs::read(log_path(&f.state)).unwrap();
        let torn = serde_json::to_vec(&Record { phone: Some("Bärbel".into()), ..record("p1", "docs/t.txt", 1, NOW) }).unwrap();
        let cut = torn.iter().position(|&b| b == 0xC3).unwrap() + 1;
        bytes.extend_from_slice(&torn[..cut]);
        fs::write(log_path(&f.state), &bytes).unwrap();

        assert_eq!(find(&f.state, &landed.id).map(|r| r.rel), Some(landed.rel.clone()));
        assert_eq!(rels(&recent_at(&f.state, Duration::from_secs(CAP_WINDOW), root_of(&f), NOW).unwrap()), [landed.rel.as_str()]);
        assert_eq!(put(&f, "docs", "b.txt", b"b"), Err(UploadError::Full), "the cap still sees the log");
        undo(&f.state, &f.root, "p1", &landed.rel).unwrap();
        put(&f, "", "c.txt", b"c").unwrap_err();
        // The next landed write rewrites the log without the torn line.
        store_at(&f.state, &f.root, "p2", "", "d.txt", b"d", None, NOW).unwrap();
        let text = String::from_utf8(fs::read(log_path(&f.state)).unwrap()).unwrap();
        assert!(text.lines().all(|l| serde_json::from_str::<Record>(l).is_ok()), "{text}");
    }

    /// The same bytes uploaded again under the name an undo freed leave two
    /// records for one file: it is listed once, by the newer record.
    #[test]
    fn recent_lists_one_row_per_file() {
        let f = fixture();
        let first = put(&f, "docs", "a.txt", b"same").unwrap();
        undo(&f.state, &f.root, "p1", &first.rel).unwrap();
        let again = put(&f, "docs", "a.txt", b"same").unwrap();
        assert_eq!(again.rel, first.rel);
        let listed = recent_at(&f.state, Duration::from_secs(CAP_WINDOW), root_of(&f), NOW).unwrap();
        assert_eq!(listed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), [again.id.as_str()]);
    }

    #[test]
    fn a_long_phone_label_is_bounded() {
        let f = fixture();
        let label = "📱".repeat(100);
        store_at(&f.state, &f.root, "p1", "docs", "a.txt", b"x", Some(&label), NOW).unwrap();
        let logged: Record = serde_json::from_str(&log_lines(&f)[0]).unwrap();
        assert_eq!(logged.phone.unwrap().chars().count(), MAX_PHONE);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_takes_no_upload_and_a_linked_leaf_is_not_undone() {
        let f = fixture();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), f.root.join("away")).unwrap();
        assert_eq!(put(&f, "away", "a.txt", b"x"), Err(UploadError::Refused));
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());

        // A landed file swapped for a link to an identical file elsewhere: the
        // undo neither follows it nor deletes the link.
        let landed = put(&f, "docs", "a.txt", b"same").unwrap();
        let path = f.root.join("docs").join("a.txt");
        fs::write(outside.path().join("a.txt"), b"same").unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(outside.path().join("a.txt"), &path).unwrap();
        assert_eq!(undo(&f.state, &f.root, "p1", &landed.rel), Err(UploadError::NotFound));
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        assert!(outside.path().join("a.txt").is_file());
        assert!(recent_at(&f.state, Duration::from_secs(CAP_WINDOW), root_of(&f), NOW).unwrap().is_empty());

        // Its folder swapped for a link to a copy: the same.
        let landed = put(&f, "", "b.txt", b"b").unwrap();
        assert_eq!(landed.rel, "b.txt");
        let moved = put(&f, "docs", "c.txt", b"c").unwrap();
        fs::write(outside.path().join("c.txt"), b"c").unwrap();
        fs::rename(f.root.join("docs"), f.root.join("docs-real")).unwrap();
        std::os::unix::fs::symlink(outside.path(), f.root.join("docs")).unwrap();
        assert_eq!(undo(&f.state, &f.root, "p1", &moved.rel), Err(UploadError::NotFound));
        assert!(outside.path().join("c.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_link_after_the_walk_keeps_the_write_inside() {
        let f = fixture();
        let outside = tempfile::tempdir().unwrap();
        let held = ProjectDir::open(&f.root, "docs").unwrap();
        fs::rename(f.root.join("docs"), f.root.join("docs-real")).unwrap();
        std::os::unix::fs::symlink(outside.path(), f.root.join("docs")).unwrap();
        assert_eq!(inbox::create_unique(&held, "a.txt", b"x").unwrap(), "a.txt");
        assert!(f.root.join("docs-real").join("a.txt").is_file());
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    // Junctions need neither Administrator rights nor Developer Mode (as in
    // `files.rs`'s tests); these must fail if the fixture cannot be made.
    #[cfg(windows)]
    fn junction(target: &Path, link: &Path) {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd")
            .raw_arg(format!("/D /C mklink /J \"{}\" \"{}\"", link.display(), target.display()))
            .output()
            .unwrap();
        assert!(output.status.success(), "mklink: {}", String::from_utf8_lossy(&output.stderr));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_folder_takes_no_upload() {
        let f = fixture();
        let outside = tempfile::tempdir().unwrap();
        junction(outside.path(), &f.root.join("away"));
        junction(&f.root.join("docs"), &f.root.join("alias"));
        assert_eq!(put(&f, "away", "a.txt", b"x"), Err(UploadError::Refused));
        assert_eq!(put(&f, "alias", "a.txt", b"x"), Err(UploadError::Refused));
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
        assert!(fs::read_dir(f.root.join("docs")).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn an_upload_whose_folder_became_a_junction_is_not_undone() {
        let f = fixture();
        let outside = tempfile::tempdir().unwrap();
        let landed = put(&f, "docs", "c.txt", b"c").unwrap();
        fs::write(outside.path().join("c.txt"), b"c").unwrap();
        fs::rename(f.root.join("docs"), f.root.join("docs-real")).unwrap();
        junction(outside.path(), &f.root.join("docs"));
        assert_eq!(undo(&f.state, &f.root, "p1", &landed.rel), Err(UploadError::NotFound));
        assert!(outside.path().join("c.txt").is_file());
        assert!(recent_at(&f.state, Duration::from_secs(CAP_WINDOW), root_of(&f), NOW).unwrap().is_empty());
    }

    /// Windows creates names case-insensitively: a case-only clash is taken
    /// and gets a suffix rather than replacing the file.
    #[cfg(windows)]
    #[test]
    fn a_case_only_clash_gets_a_suffix_on_windows() {
        let f = fixture();
        fs::write(f.root.join("docs").join("README.txt"), b"mine").unwrap();
        assert_eq!(put(&f, "docs", "readme.txt", b"x").unwrap().name, "readme-2.txt");
        assert_eq!(fs::read(f.root.join("docs").join("README.txt")).unwrap(), b"mine");
    }
}
