//! The phone → project drop box behind the Focus composer's **+**.
//!
//! A file picked on the phone lands in the project's own `.tabtivity/inbox/` —
//! a directory the desktop already git-ignores, hides from the tree and skips
//! in sync — and the phone gets back a *project-relative* reference
//! (`.tabtivity/inbox/<file>`) to put after an `@` in the message. That relative
//! reference is the one deliberate exception to "paths never cross the browser
//! API": it carries no host component, resolves only from inside the session's
//! own working directory, and is exactly what the agent needs to read the
//! file. The absolute path stays on the desktop.
//!
//! The project tree is attacker-controlled by policy (`AGENTS.md`), so the
//! write is defensive: the file name is rebuilt from a safe alphabet and
//! stamped, the file is created with `create_new` semantics (never
//! overwriting), and the inbox is reached from the project root one held
//! folder at a time — each missing one made with `mkdirat`, each opened with
//! `openat(O_NOFOLLOW)` relative to the one before (`files::ProjectDir`) — so a
//! planted or swapped-in `.tabtivity`/`inbox` link cannot redirect the bytes
//! elsewhere, before the check or after it.
//!
//! The **global inbox** (`<state_dir>/inbox/`) is the same drop box for a file
//! that belongs to no project — the phone's *Send to desktop*. It lives in
//! Tabtivity's own state, never in a project folder, so nothing is filed into a
//! project without the user moving it there; the desktop lists, opens and
//! deletes it by leaf name through the functions below.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use super::files::{FilesError, ProjectDir};
use super::outbox::{self, OutboxError, OutboxFile};

/// Project-relative directory the phone's files land in.
pub const INBOX_DIR: &str = crate::brand::INBOX_DIR;
/// State-dir-relative directory of the global inbox (no project).
pub const GLOBAL_INBOX_DIR: &str = "inbox";
/// One file the phone may send. A phone photo is a few MiB; a short video
/// clip fits; a movie does not belong in an agent prompt.
pub const MAX_INBOX_FILE: usize = 24 * 1024 * 1024;
/// What one inbox may hold in total before uploads are refused — the inbox is
/// never pruned by Tabtivity, so the cap is what keeps a forgotten one bounded.
pub const MAX_INBOX_TOTAL: u64 = 1024 * 1024 * 1024;
/// Characters kept of the phone's file name, stem and extension together.
const MAX_NAME: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    /// The file name as written (stamped, sanitized, made unique).
    pub name: String,
    /// `INBOX_DIR/name` — what the phone puts after the `@`. For the global
    /// inbox it is `GLOBAL_INBOX_DIR/name` and never leaves the desktop.
    pub reference: String,
    pub size: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InboxError {
    /// The body had no bytes.
    Empty,
    /// The body exceeds `MAX_INBOX_FILE`.
    TooLarge,
    /// The inbox already holds `MAX_INBOX_TOTAL`.
    Full,
    /// The project root is gone, or something on the way to the inbox is not
    /// a plain folder (a link, a file).
    Unavailable,
    Io(String),
}

impl InboxError {
    /// The wire code the phone maps to a message.
    pub fn code(&self) -> &'static str {
        match self {
            InboxError::Empty => "empty_file",
            InboxError::TooLarge => "file_too_large",
            InboxError::Full => "inbox_full",
            InboxError::Unavailable => "project_unavailable",
            InboxError::Io(_) => "write_failed",
        }
    }
}

/// A file name rebuilt from the phone's: the last path component only, drawn
/// from letters, digits, `.`, `-` and `_`, never starting with a dot, bounded
/// in length with its extension kept. Empty in, `attachment` out.
pub fn safe_name(raw: &str) -> String {
    let leaf = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    let mut cleaned = String::with_capacity(leaf.len());
    let mut last_was_gap = true;
    for c in leaf.chars() {
        if c.is_alphanumeric() || c == '.' || c == '-' {
            cleaned.push(c);
            last_was_gap = false;
        } else if !last_was_gap {
            cleaned.push('_');
            last_was_gap = true;
        }
    }
    // A gap right before the extension dot is noise, not a separator.
    let cleaned = cleaned.replace("_.", ".");
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == '_' || c == '-');
    if cleaned.is_empty() {
        return "attachment".to_string();
    }
    // Keep a short extension when trimming an overlong stem.
    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty() && !ext.is_empty() && ext.chars().count() <= 12 =>
        {
            (stem, Some(ext))
        }
        _ => (cleaned, None),
    };
    let budget = MAX_NAME.saturating_sub(ext.map_or(0, |e| e.chars().count() + 1)).max(1);
    let stem: String = stem.chars().take(budget).collect();
    match ext {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem,
    }
}

/// `YYYYMMDD-HHMMSS` in UTC — ordering and uniqueness, not a display clock.
fn stamp(now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// The bytes of the regular files in the held inbox `dir` (links and folders
/// are not followed or counted).
fn inbox_total(dir: &ProjectDir) -> Result<u64, InboxError> {
    let entries = dir.entries().map_err(|e| match e {
        FilesError::Io(e) => InboxError::Io(e),
        _ => InboxError::Unavailable,
    })?;
    Ok(entries
        .into_iter()
        .filter(|(_, is_dir)| !is_dir)
        .filter_map(|(name, _)| dir.open_file(&name))
        .fold(0u64, |total, (_, meta)| total.saturating_add(meta.len())))
}

/// `rel` below `root`, held open: each missing folder made relative to the
/// one before (`mkdirat`), each opened without following a link. A link, a
/// file or a folder that vanished on the way is `Unavailable`.
fn make_drop_dir(root: &Path, rel: &str) -> Result<ProjectDir, InboxError> {
    let mut dir = ProjectDir::open_root(root).map_err(|_| InboxError::Unavailable)?;
    for name in rel.split('/') {
        dir.create_dir(name).map_err(|e| InboxError::Io(e.to_string()))?;
        dir = match dir.lookup_dir(name) {
            Ok(Some(next)) => next,
            Ok(None) | Err(()) => return Err(InboxError::Unavailable),
        };
    }
    Ok(dir)
}

/// Writes `bytes` into `root/.tabtivity/inbox/` under a stamped, sanitized,
/// unique name. `root` must be the project's canonical directory.
pub fn store(root: &Path, raw_name: &str, bytes: &[u8]) -> Result<Stored, InboxError> {
    store_at(root, INBOX_DIR, raw_name, bytes, SystemTime::now())
}

/// Writes `bytes` into the global inbox, `state_dir/inbox/`, exactly as
/// `store` writes a project's.
pub fn store_global(state_dir: &Path, raw_name: &str, bytes: &[u8]) -> Result<Stored, InboxError> {
    store_at(state_dir, GLOBAL_INBOX_DIR, raw_name, bytes, SystemTime::now())
}

fn store_at(
    root: &Path,
    rel_dir: &str,
    raw_name: &str,
    bytes: &[u8],
    now: SystemTime,
) -> Result<Stored, InboxError> {
    if bytes.is_empty() {
        return Err(InboxError::Empty);
    }
    if bytes.len() > MAX_INBOX_FILE {
        return Err(InboxError::TooLarge);
    }
    if !root.is_dir() {
        return Err(InboxError::Unavailable);
    }
    // A `.tabtivity` or `inbox` link planted in the tree — or swapped in
    // after this walk — must not carry the bytes out of the project: every
    // step below works on the folder this holds.
    let dir = make_drop_dir(root, rel_dir)?;
    if inbox_total(&dir)?.saturating_add(bytes.len() as u64) > MAX_INBOX_TOTAL {
        return Err(InboxError::Full);
    }
    let base = format!("{}-{}", stamp(now), safe_name(raw_name));
    let (mut stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (base.clone(), String::new()),
    };
    // `safe_name` bounds characters; one file name holds 255 bytes (Linux,
    // `files::plain_segment`). Cut the stem at a character so the stamp, the
    // extension and a `-1000` suffix still fit.
    let room = 255 - "-1000".len() - ext.len();
    while stem.len() > room {
        stem.pop();
    }
    let base = format!("{stem}{ext}");
    for attempt in 0u32..1_000 {
        let name = if attempt == 0 {
            base.clone()
        } else {
            format!("{stem}-{}{ext}", attempt + 1)
        };
        match dir.create_file(&name) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|()| file.flush()) {
                    drop(file);
                    let _ = dir.remove_file(&name);
                    return Err(InboxError::Io(error.to_string()));
                }
                return Ok(Stored {
                    reference: format!("{rel_dir}/{name}"),
                    name,
                    size: bytes.len() as u64,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(InboxError::Io(error.to_string())),
        }
    }
    Err(InboxError::Io("no free name in the inbox".into()))
}

/// The longest project-inbox leaf the read side admits: a stamp, an
/// `MAX_NAME`-character name of up to four UTF-8 bytes each, a `-N` suffix.
const MAX_STORED_NAME: usize = 16 + MAX_NAME * 4 + 8;
/// How many leaves one [`describe`] call looks at — a chat's worth.
pub const MAX_DESCRIBED: usize = 64;

/// Whether `name` is a leaf [`store`] could have written: [`safe_name`]'s
/// alphabet (letters of any script, digits, `.`, `-`, `_`), never a dot first,
/// no separator, bounded. Nothing else in the inbox is read back to the phone.
pub fn valid_stored_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_STORED_NAME
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// The project-inbox files among `names` (leaves the phone read out of its own
/// `@` references), described as the outbox describes its own — kind by the
/// bytes, size, mtime, the name it was sent as — in the order asked. A leaf
/// that is not a servable file is left out: the phone then shows it gone.
pub fn describe(root: &Path, names: &[&str]) -> Result<Vec<OutboxFile>, OutboxError> {
    let Some(dir) = outbox::drop_dir(root, INBOX_DIR)? else {
        return Ok(Vec::new());
    };
    Ok(names
        .iter()
        .take(MAX_DESCRIBED)
        .filter_map(|name| {
            let (_file, meta, kind) = outbox::probe_as(&dir, name, valid_stored_name)?;
            Some(OutboxFile {
                name: (*name).to_string(),
                original: outbox::sent_name(name).to_string(),
                kind,
                size: meta.len(),
                modified: meta.modified().map(outbox::unix_secs).unwrap_or(0),
                from_tab: false,
                source: None,
            })
        })
        .collect())
}

/// One project-inbox file's bytes and media type, by its leaf — the phone's
/// preview of what it sent. Read exactly as the outbox serves its own.
pub fn read(root: &Path, name: &str) -> Result<(Vec<u8>, &'static str), OutboxError> {
    let Some(dir) = outbox::drop_dir(root, INBOX_DIR)? else {
        return Err(OutboxError::NotFound);
    };
    outbox::read_probed(&dir, name, valid_stored_name)
}

/// The media type of one project-inbox file by its leaf, as [`read`] would
/// type it, without reading the rest — `None` for a leaf it would not serve.
pub fn kind(root: &Path, name: &str) -> Option<&'static str> {
    let dir = outbox::drop_dir(root, INBOX_DIR).ok()??;
    outbox::probe_as(&dir, name, valid_stored_name).map(|(_, _, kind)| kind)
}

/// One file waiting in the global inbox, as the desktop lists it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GlobalInboxFile {
    pub name: String,
    pub size: u64,
    /// Unix seconds the file landed (its mtime).
    pub modified: u64,
}

/// Whether `name` is a leaf `store` could have written: `safe_name`'s
/// alphabet behind the stamp, no separator, no leading dot, bounded. Anything
/// else in the folder is not the inbox's and is neither listed nor touched.
pub fn valid_global_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME + 32
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// The global inbox's regular files, newest first. A missing inbox is empty.
pub fn list_global(state_dir: &Path) -> Vec<GlobalInboxFile> {
    let Ok(entries) = fs::read_dir(state_dir.join(GLOBAL_INBOX_DIR)) else {
        return Vec::new();
    };
    let mut files: Vec<GlobalInboxFile> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !valid_global_name(&name) {
                return None;
            }
            // `DirEntry::metadata` does not follow a symlink: only files the
            // inbox itself wrote are listed.
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            Some(GlobalInboxFile { name, size: meta.len(), modified })
        })
        .collect();
    files.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
    files
}

/// The absolute path of one listed file — `None` for a name the listing would
/// not show, a symlink, or a file that is gone.
pub fn global_file(state_dir: &Path, name: &str) -> Option<PathBuf> {
    if !valid_global_name(name) {
        return None;
    }
    let path = state_dir.join(GLOBAL_INBOX_DIR).join(name);
    let meta = fs::symlink_metadata(&path).ok()?;
    meta.is_file().then_some(path)
}

/// Deletes one listed file. `Ok(false)` when there was nothing to delete.
pub fn remove_global(state_dir: &Path, name: &str) -> Result<bool, InboxError> {
    let Some(path) = global_file(state_dir, name) else {
        return Ok(false);
    };
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(InboxError::Io(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const T0: u64 = 1_788_177_600; // 2026-08-31 12:00:00 UTC

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn the_stamp_is_a_civil_utc_date() {
        assert_eq!(stamp(at(T0)), "20260831-120000");
        assert_eq!(stamp(at(0)), "19700101-000000");
        assert_eq!(stamp(at(951_782_400)), "20000229-000000"); // leap day
    }

    #[test]
    fn a_file_name_is_rebuilt_from_a_safe_alphabet() {
        assert_eq!(safe_name("IMG_1234.jpg"), "IMG_1234.jpg");
        assert_eq!(safe_name("Screenshot 2026-08-31 at 12.00.png"), "Screenshot_2026-08-31_at_12.00.png");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Users\\me\\notes.txt"), "notes.txt");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name("..."), "attachment");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_name("Größe.pdf"), "Größe.pdf");
        assert_eq!(safe_name("a\0b\n.txt"), "a_b.txt");
    }

    #[test]
    fn an_overlong_name_keeps_its_extension() {
        let long = format!("{}.jpeg", "x".repeat(200));
        let name = safe_name(&long);
        assert!(name.ends_with(".jpeg"));
        assert_eq!(name.chars().count(), MAX_NAME);
    }

    /// 80 characters of a non-Latin script are more bytes than one file name
    /// holds once stamped (255 on Linux, `files::plain_segment`'s bound): the
    /// stem is cut at a character so the upload still lands, read back by leaf.
    #[test]
    fn a_long_name_in_a_wide_script_still_lands() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for raw in ["写".repeat(80), format!("{}.pdf", "写".repeat(90)), "😀".repeat(80)] {
            let stored = store_at(root, INBOX_DIR, &raw, b"x", at(T0)).unwrap();
            assert!(stored.name.len() <= 255 - "-1000".len(), "{}", stored.name);
            assert!(stored.name.starts_with("20260831-120000-"));
            assert_eq!(raw.ends_with(".pdf"), stored.name.ends_with(".pdf"));
            assert_eq!(fs::read(root.join(&stored.reference)).unwrap(), b"x");
            assert!(valid_stored_name(&stored.name));
        }
    }

    #[test]
    fn a_file_lands_stamped_in_the_inbox_and_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let first = store_at(root, INBOX_DIR, "IMG_1.jpg", b"one", at(T0)).unwrap();
        assert_eq!(first.name, "20260831-120000-IMG_1.jpg");
        assert_eq!(first.reference, concat!(".", crate::app_slug!(), "/inbox/20260831-120000-IMG_1.jpg"));
        assert_eq!(first.size, 3);
        assert_eq!(fs::read(root.join(&first.reference)).unwrap(), b"one");

        let second = store_at(root, INBOX_DIR, "IMG_1.jpg", b"two", at(T0)).unwrap();
        assert_eq!(second.name, "20260831-120000-IMG_1-2.jpg");
        assert_eq!(fs::read(root.join(&first.reference)).unwrap(), b"one");
        assert_eq!(fs::read(root.join(&second.reference)).unwrap(), b"two");
    }

    #[test]
    fn a_traversing_name_stays_inside_the_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let stored = store_at(dir.path(), INBOX_DIR, "../../escape.txt", b"x", at(T0)).unwrap();
        assert_eq!(stored.name, "20260831-120000-escape.txt");
        assert!(dir.path().join(INBOX_DIR).join(&stored.name).is_file());
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn empty_oversized_and_rootless_uploads_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(store_at(dir.path(), INBOX_DIR, "a.txt", b"", at(T0)), Err(InboxError::Empty));
        let big = vec![0u8; MAX_INBOX_FILE + 1];
        assert_eq!(store_at(dir.path(), INBOX_DIR, "a.bin", &big, at(T0)), Err(InboxError::TooLarge));
        assert_eq!(
            store_at(&dir.path().join("missing"), INBOX_DIR, "a.txt", b"x", at(T0)),
            Err(InboxError::Unavailable)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_cannot_redirect_the_bytes_out_of_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(root.join(concat!(".", crate::app_slug!()))).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join(concat!(".", crate::app_slug!())).join("inbox")).unwrap();
        assert_eq!(
            store_at(&root, INBOX_DIR, "leak.txt", b"x", at(T0)),
            Err(InboxError::Unavailable)
        );
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    /// Gap 12: a `.tabtivity` link (or file) is refused for the write and
    /// for the read-back, and nothing lands where it points.
    #[cfg(unix)]
    #[test]
    fn a_linked_project_dir_is_refused_for_writes_and_reads() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project_dir = concat!(".", crate::app_slug!());
        let foreign = outside.path().join(INBOX_DIR);
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("20260831-120000-secret.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outside.path().join(project_dir), root.join(project_dir)).unwrap();

        assert_eq!(store_at(&root, INBOX_DIR, "leak.txt", b"x", at(T0)), Err(InboxError::Unavailable));
        assert_eq!(fs::read_dir(&foreign).unwrap().count(), 1);
        assert_eq!(describe(&root, &["20260831-120000-secret.png"]), Err(OutboxError::Unavailable));
        assert_eq!(read(&root, "20260831-120000-secret.png"), Err(OutboxError::Unavailable));
        assert_eq!(kind(&root, "20260831-120000-secret.png"), None);

        let plain = dir.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join(project_dir), b"not a folder").unwrap();
        assert_eq!(store_at(&plain, INBOX_DIR, "a.txt", b"x", at(T0)), Err(InboxError::Unavailable));
    }

    /// Gap 12: an `inbox` link is refused for the read-back too, even one
    /// pointing at another folder of the same project.
    #[cfg(unix)]
    #[test]
    fn a_linked_inbox_is_not_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/20260831-120000-a.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        fs::create_dir_all(root.join(concat!(".", crate::app_slug!()))).unwrap();
        std::os::unix::fs::symlink(root.join("docs"), root.join(INBOX_DIR)).unwrap();
        assert_eq!(describe(root, &["20260831-120000-a.png"]), Err(OutboxError::Unavailable));
        assert_eq!(read(root, "20260831-120000-a.png"), Err(OutboxError::Unavailable));
        assert_eq!(store_at(root, INBOX_DIR, "b.txt", b"x", at(T0)), Err(InboxError::Unavailable));
        assert_eq!(fs::read_dir(root.join("docs")).unwrap().count(), 1);
    }

    /// Gap 12, the race: once the write holds the inbox, a `.tabtivity`
    /// swapped for a link does not move the new file out of the project.
    #[cfg(unix)]
    #[test]
    fn a_project_dir_swapped_for_a_link_after_the_walk_keeps_the_write_inside() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project_dir = concat!(".", crate::app_slug!());
        fs::create_dir_all(outside.path().join(INBOX_DIR)).unwrap();
        let held = make_drop_dir(dir.path(), INBOX_DIR).unwrap();
        fs::rename(dir.path().join(project_dir), dir.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path().join(project_dir), dir.path().join(project_dir)).unwrap();

        held.create_file("note.txt").unwrap().write_all(b"x").unwrap();
        assert_eq!(fs::read(dir.path().join("moved/inbox/note.txt")).unwrap(), b"x");
        assert!(fs::read_dir(outside.path().join(INBOX_DIR)).unwrap().next().is_none());
        // `create_new`: never an existing name, and never a link's target.
        assert_eq!(held.create_file("note.txt").unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        std::os::unix::fs::symlink(outside.path().join("planted"), dir.path().join("moved/inbox/link.txt")).unwrap();
        assert!(held.create_file("link.txt").is_err());
        assert!(!outside.path().join("planted").exists());
        // A fresh upload stops at the link.
        assert_eq!(store_at(dir.path(), INBOX_DIR, "a.txt", b"x", at(T0)), Err(InboxError::Unavailable));
    }

    #[test]
    fn the_global_inbox_lists_opens_and_removes_only_its_own_files() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path();
        assert!(list_global(state).is_empty());
        let old = store_at(state, GLOBAL_INBOX_DIR, "boarding pass.pdf", b"pdf", at(T0)).unwrap();
        assert_eq!(old.reference, "inbox/20260831-120000-boarding_pass.pdf");
        let new = store_at(state, GLOBAL_INBOX_DIR, "photo.jpg", b"jpeg!", at(T0 + 60)).unwrap();
        let inbox = state.join(GLOBAL_INBOX_DIR);
        fs::write(inbox.join(".hidden"), b"x").unwrap();
        fs::create_dir(inbox.join("sub")).unwrap();
        let names: Vec<_> = list_global(state).into_iter().map(|f| f.name).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&old.name) && names.contains(&new.name));
        assert_eq!(global_file(state, &new.name), Some(inbox.join(&new.name)));
        assert_eq!(global_file(state, "../settings.json"), None);
        assert_eq!(global_file(state, ".hidden"), None);
        assert_eq!(global_file(state, "sub"), None);
        assert_eq!(remove_global(state, &old.name), Ok(true));
        assert_eq!(remove_global(state, &old.name), Ok(false));
        assert_eq!(remove_global(state, "../settings.json"), Ok(false));
        assert_eq!(list_global(state).len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_global_inbox_is_neither_listed_nor_removed_through() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("keep.txt");
        fs::write(&target, b"keep").unwrap();
        let inbox = dir.path().join(GLOBAL_INBOX_DIR);
        fs::create_dir_all(&inbox).unwrap();
        std::os::unix::fs::symlink(&target, inbox.join("link.txt")).unwrap();
        assert!(list_global(dir.path()).is_empty());
        assert_eq!(global_file(dir.path(), "link.txt"), None);
        assert_eq!(remove_global(dir.path(), "link.txt"), Ok(false));
        assert!(target.is_file());
    }

    #[test]
    fn a_stored_file_reads_back_by_its_leaf_and_nothing_else_does() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let png = b"\x89PNG\r\n\x1a\nrest";
        let photo = store_at(root, INBOX_DIR, "Größe Foto.png", png, at(T0)).unwrap();
        let note = store_at(root, INBOX_DIR, "note.txt", b"hello", at(T0 + 1)).unwrap();
        fs::write(root.join(INBOX_DIR).join(".hidden.png"), png).unwrap();
        let files = describe(root, &[&note.name, "missing.png", ".hidden.png", "../x", &photo.name]).unwrap();
        let named: Vec<_> = files.iter().map(|f| (f.name.as_str(), f.kind, f.original.as_str())).collect();
        assert_eq!(named, vec![
            (note.name.as_str(), "text/plain; charset=utf-8", "note.txt"),
            (photo.name.as_str(), "image/png", "Größe_Foto.png"),
        ]);
        assert_eq!(read(root, &photo.name).unwrap(), (png.to_vec(), "image/png"));
        assert_eq!(read(root, ".hidden.png"), Err(OutboxError::NotFound));
        assert_eq!(read(root, "../note.txt"), Err(OutboxError::NotFound));
    }

    #[test]
    fn a_project_without_an_inbox_describes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(describe(dir.path(), &["a.png"]), Ok(Vec::new()));
        assert_eq!(read(dir.path(), "a.png"), Err(OutboxError::NotFound));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_inbox_is_not_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
        let inbox = dir.path().join(INBOX_DIR);
        fs::create_dir_all(&inbox).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), inbox.join("link.txt")).unwrap();
        assert_eq!(describe(dir.path(), &["link.txt"]), Ok(Vec::new()));
        assert_eq!(read(dir.path(), "link.txt"), Err(OutboxError::NotFound));
    }
}
