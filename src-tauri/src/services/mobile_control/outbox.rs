//! Explicit project → phone files, published into `.tabtivity/outbox/`.
//!
//! Only safe leaf names of bounded, non-symlink regular files cross the API.
//! The directory is reached from the project root one held folder at a time
//! (`openat(O_NOFOLLOW)` per name, `files::ProjectDir`), never by path, so a
//! `.tabtivity` or `outbox` swapped for a link mid-request changes nothing; a
//! link anywhere on the way is refused. Types come from bytes:
//! images/PDF, inert UTF-8 text (including HTML/SVG), or attachment downloads.
//! Nothing detects terminal paths or copies files on the agent's behalf.
//!
//! `tabtivity-send` run in an agent tab leaves a marker beside each file,
//! `.<leaf>.tab`, holding the tab's `$TABTIVITY_TAB_UID`: that tab's chat shows
//! the file, every other tab's gallery still lists it. The marker is hidden by
//! the leaf alphabet and never crosses — the listing says only `from_tab`.
//!
//! A second marker, `.<leaf>.src`, holds the project-relative path of the file
//! the leaf is a copy of. It never crosses either: the host turns it into the
//! files drawer's sealed row (`host.rs` `file_row`), so the phone opens — and
//! marks up — the project file itself rather than this copy.

use std::{
    fs,
    io::{Read, Seek},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use super::files::ProjectDir;

/// Project-relative directory an agent puts files for the phone in.
pub const OUTBOX_DIR: &str = crate::brand::OUTBOX_DIR;
/// One file the phone will load. The inbox's ceiling, for the same reason:
/// a screenshot or a plot is a few MiB; a raw camera dump is not a message.
pub const MAX_OUTBOX_FILE: u64 = 24 * 1024 * 1024;
/// How many files the listing returns, newest first — a strip on a phone,
/// not a gallery, and a folder nobody prunes must stay cheap to list.
pub const MAX_LISTED: usize = 40;
/// The longest leaf that crosses.
const MAX_NAME: usize = 120;
/// Enough of a file to tell its format.
pub const SNIFF_BYTES: usize = 4096;
/// The longest tab id a sender marker may hold (a UUID is 36).
const MAX_TAB_ID: u64 = 64;
/// The longest project-relative path an origin marker may hold.
const MAX_SOURCE: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OutboxFile {
    /// The leaf the phone asks for again — the file name, validated.
    pub name: String,
    /// What the phone shows, saves and shares it as: the leaf without the
    /// send stamps in front ([`sent_name`]).
    pub original: String,
    /// Closed media type determined by the bytes, never by the extension.
    pub kind: &'static str,
    pub size: u64,
    /// Unix seconds of the file's mtime — ordering, and "just now" on the phone.
    pub modified: u64,
    /// Sent from the tab the listing was asked through (its sender marker
    /// names that tab): the one chat that shows it. Absent when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub from_tab: bool,
    /// The project-relative path `tabtivity-send` recorded the file was sent
    /// from (`.<leaf>.src`), shape-checked only — `files::entry` proves it
    /// before anything of it reaches the phone, and then only as a sealed
    /// row. Never serialised: the raw path does not cross.
    #[serde(skip)]
    pub source: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OutboxError {
    /// The project root is gone, or something on the way to the outbox is
    /// not a plain folder (a link, a file).
    Unavailable,
    /// No such name, or it names something that is not a servable file.
    NotFound,
    Io(String),
}

impl OutboxError {
    /// The wire code the phone maps to a message.
    pub fn code(&self) -> &'static str {
        match self {
            OutboxError::Unavailable => "project_unavailable",
            OutboxError::NotFound => "file_not_found",
            OutboxError::Io(_) => "read_failed",
        }
    }
}

/// Whether `name` is a leaf the outbox will list or serve: the inbox's safe
/// alphabet (letters, digits, `.`, `-`, `_`), never starting with a dot, no
/// separators, bounded. Anything else in the folder is simply not there.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// The media type the first bytes announce, for the formats every phone
/// browser renders in an `<img>`. `None` is "not an image here" — a text
/// file, a PDF, an SVG, a truncated header.
pub fn sniff(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else if head.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else {
        None
    }
}

/// Active formats such as HTML/SVG/JS are always inert text. A UTF-8
/// sequence cut by the bounded head read is accepted only at that boundary.
pub fn classify(head: &[u8]) -> &'static str {
    if let Some(kind) = sniff(head) { return kind; }
    let utf8 = match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => head.len() == SNIFF_BYTES && e.error_len().is_none(),
    };
    if utf8 && !head.contains(&0) { "text/plain; charset=utf-8" }
    else { "application/octet-stream" }
}

/// The outbox folder, held open — or `None` when there is no outbox yet,
/// which is the ordinary case and not an error.
fn outbox_dir(root: &Path) -> Result<Option<ProjectDir>, OutboxError> {
    drop_dir(root, OUTBOX_DIR)
}

/// A project drop box (`rel` below `root`: the outbox, or the phone's inbox),
/// held open after a walk from the root that opens each name relative to the
/// folder before it without following a link — `None` when it does not exist
/// yet. Everything after this works on the held folder, never on a path.
pub(super) fn drop_dir(root: &Path, rel: &str) -> Result<Option<ProjectDir>, OutboxError> {
    let mut dir = ProjectDir::open_root(root).map_err(|_| OutboxError::Unavailable)?;
    for name in rel.split('/') {
        match dir.lookup_dir(name) {
            Ok(Some(next)) => dir = next,
            Ok(None) => return Ok(None),
            Err(()) => return Err(OutboxError::Unavailable),
        }
    }
    Ok(Some(dir))
}

/// Reads the first bytes of a regular, non-symlink, bounded file in the
/// outbox and classifies its media type — or `None` for anything the phone must
/// not be handed.
fn probe(dir: &ProjectDir, name: &str) -> Option<(fs::File, fs::Metadata, &'static str)> {
    probe_as(dir, name, valid_name)
}

/// [`probe`] for a drop box whose leaves `valid` admits.
pub(super) fn probe_as(dir: &ProjectDir, name: &str, valid: fn(&str) -> bool) -> Option<(fs::File, fs::Metadata, &'static str)> {
    if !valid(name) {
        return None;
    }
    let (file, meta) = dir.open_file(name)?;
    let (file, meta, kind) = sniff_opened(file, meta)?;
    if meta.len() == 0 || meta.len() > MAX_OUTBOX_FILE {
        return None;
    }
    Some((file, meta, kind))
}

/// Classifies the first bytes of a regular file the caller opened (relative
/// to a held folder, `files::ProjectDir::open_file`) — the one way a
/// phone-facing read types a file, shared with the project file browser. The
/// descriptor comes back positioned after the head; `rewind` before reading
/// the whole of it.
pub fn sniff_opened(mut file: fs::File, meta: fs::Metadata) -> Option<(fs::File, fs::Metadata, &'static str)> {
    let mut head = [0u8; SNIFF_BYTES];
    let mut filled = 0;
    while filled < SNIFF_BYTES {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return None,
        }
    }
    let kind = classify(&head[..filled]);
    Some((file, meta, kind))
}

/// The sender marker of leaf `name`: `.<name>.tab`.
fn marker_name(name: &str) -> String {
    format!(".{name}.tab")
}

/// The tab id `tabtivity-send` recorded for `name`, if a well-formed one is
/// there — the hook's alphabet (`[A-Za-z0-9-]`), bounded.
fn sender(dir: &ProjectDir, name: &str) -> Option<String> {
    let (file, meta) = dir.open_file(&marker_name(name))?;
    if meta.len() == 0 || meta.len() > MAX_TAB_ID {
        return None;
    }
    let mut id = String::new();
    file.take(MAX_TAB_ID).read_to_string(&mut id).ok()?;
    let id = id.trim_end();
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then(|| id.to_string())
}

/// The origin marker of leaf `name`: `.<name>.src`.
fn source_name(name: &str) -> String {
    format!(".{name}.src")
}

/// The project-relative path `tabtivity-send` recorded for `name`: read
/// without following a link, bounded, one non-empty line, never a path into
/// the outbox itself (a copy of a copy has no project file behind it). Only
/// its shape is checked here; whoever uses it proves it against the tree.
fn source(dir: &ProjectDir, name: &str) -> Option<String> {
    let (file, meta) = dir.open_file(&source_name(name))?;
    if meta.len() == 0 || meta.len() > MAX_SOURCE {
        return None;
    }
    let mut rel = String::new();
    file.take(MAX_SOURCE).read_to_string(&mut rel).ok()?;
    let rel = rel.trim();
    let outbox = format!("{OUTBOX_DIR}/");
    (!rel.is_empty() && !rel.contains('\n') && !rel.starts_with('/') && !rel.starts_with(&outbox) && rel != OUTBOX_DIR)
        .then(|| rel.to_string())
}

/// `name` without the `YYYYMMDD-HHMMSS-` stamps `tabtivity-send` and the phone
/// inbox put in front of a leaf to keep it unique — a photo the phone sent and
/// an agent sent back carries two. A leaf that is nothing but stamps stays.
pub fn sent_name(name: &str) -> &str {
    let mut rest = name;
    while let Some(tail) = strip_stamp(rest) {
        if tail.is_empty() {
            break;
        }
        rest = tail;
    }
    rest
}

fn strip_stamp(name: &str) -> Option<&str> {
    let bytes = name.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    (bytes.len() >= 16 && digits(0..8) && bytes[8] == b'-' && digits(9..15) && bytes[15] == b'-')
        .then(|| &name[16..])
}

pub fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The files in `root/.tabtivity/outbox/`, newest first, at most `MAX_LISTED`.
/// A project without an outbox lists nothing. Files that are not servable
/// files are left out silently — the folder is the agent's to fill and the
/// listing is what the phone can actually show.
pub fn list(root: &Path) -> Result<Vec<OutboxFile>, OutboxError> {
    list_for(root, None)
}

/// [`list`] as one tab sees it: every file, with `from_tab` set on those the
/// tab whose `TABTIVITY_TAB_UID` is `tab` sent.
pub fn list_for(root: &Path, tab: Option<&str>) -> Result<Vec<OutboxFile>, OutboxError> {
    let Some(dir) = outbox_dir(root)? else {
        return Ok(Vec::new());
    };
    list_in(&dir, tab)
}

/// [`list_for`] of an outbox already held open.
fn list_in(dir: &ProjectDir, tab: Option<&str>) -> Result<Vec<OutboxFile>, OutboxError> {
    // The note the old-named send command leaves here (after a rename).
    crate::services::brand_migration::compat::take_send_alias_marker_with(&crate::brand::PAIR, |marker| {
        // A plain file only: the outbox is the agent's to fill.
        dir.open_file(marker).is_some() && dir.remove_file(marker).is_ok()
    });
    let entries = dir.entries().map_err(|e| match e {
        super::files::FilesError::Io(e) => OutboxError::Io(e),
        _ => OutboxError::Unavailable,
    })?;
    let mut images = Vec::new();
    for (name, is_dir) in entries {
        if is_dir {
            continue;
        }
        let Some((_file, meta, kind)) = probe(dir, &name) else {
            continue;
        };
        let from_tab = tab.is_some_and(|tab| sender(dir, &name).as_deref() == Some(tab));
        images.push(OutboxFile {
            original: sent_name(&name).to_string(),
            source: source(dir, &name),
            name,
            kind,
            size: meta.len(),
            modified: meta.modified().map(unix_secs).unwrap_or(0),
            from_tab,
        });
    }
    images.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
    images.truncate(MAX_LISTED);
    Ok(images)
}

/// One file's bytes and media type, by the leaf the listing handed out.
pub fn read(root: &Path, name: &str) -> Result<(Vec<u8>, &'static str), OutboxError> {
    let Some(dir) = outbox_dir(root)? else {
        return Err(OutboxError::NotFound);
    };
    read_probed(&dir, name, valid_name)
}

/// One leaf's bytes out of a held drop box `dir`, re-proved by `valid`.
pub(super) fn read_probed(dir: &ProjectDir, name: &str, valid: fn(&str) -> bool) -> Result<(Vec<u8>, &'static str), OutboxError> {
    let Some((mut file, meta, _kind)) = probe_as(dir, name, valid) else {
        return Err(OutboxError::NotFound);
    };
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // Keep the already validated descriptor: never reopen a replaceable leaf.
    file.rewind().map_err(|_| OutboxError::NotFound)?;
    file.take(MAX_OUTBOX_FILE + 1).read_to_end(&mut bytes)
        .map_err(|e| OutboxError::Io(e.to_string()))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_OUTBOX_FILE {
        return Err(OutboxError::NotFound);
    }
    let kind = classify(&bytes[..bytes.len().min(SNIFF_BYTES)]);
    Ok((bytes, kind))
}

/// Whether [`read`] would serve the leaf `name`, without reading it.
pub fn exists(root: &Path, name: &str) -> bool {
    outbox_dir(root).ok().flatten().is_some_and(|dir| probe(&dir, name).is_some())
}

/// Delete one listed file, by the leaf the listing handed out.
///
/// Exactly what [`read`] would serve is what this removes: `probe` re-proves
/// the leaf, the bounds and the regular, non-symlink file in the *held*
/// outbox folder, so a name the phone could not see is `NotFound` rather
/// than a deletion somewhere else. A symlink inside the outbox is refused as
/// such here too — the difference between dropping a file the agent published
/// and unlinking whatever it pointed at.
///
/// The folder is the one place in a project Tabtivity publishes *for* the phone,
/// and nothing pruned it: a picture the reader is done with could only be
/// cleared from a shell on the desktop.
pub fn remove(root: &Path, name: &str) -> Result<(), OutboxError> {
    let Some(dir) = outbox_dir(root)? else {
        return Err(OutboxError::NotFound);
    };
    let Some((_file, _meta, _kind)) = probe(&dir, name) else {
        return Err(OutboxError::NotFound);
    };
    // Unlinked relative to the same held folder `probe` opened it in; an
    // unlink never follows a link.
    dir.remove_file(name).map_err(|e| OutboxError::Io(e.to_string()))?;
    // Its sender and origin markers go with it, or a later file of the same
    // leaf would inherit them.
    let _ = dir.remove_file(&marker_name(name));
    let _ = dir.remove_file(&source_name(name));
    Ok(())
}

/// What [`remove_all`] cleared: how many files and how many bytes they held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cleared {
    pub files: usize,
    pub bytes: u64,
}

/// Delete every file the outbox would serve — the phone's "Delete all", to
/// free the space a folder nobody prunes keeps taking. Not bounded by
/// `MAX_LISTED`: the files past the listing's strip take space too. Each leaf
/// goes exactly as [`remove`] takes one (re-proved by `probe` in the held
/// folder, markers with it); anything the phone could not see — a link, a
/// folder, an oversized file — stays. A file that cannot be unlinked is
/// skipped; the error is only an error when nothing at all went.
pub fn remove_all(root: &Path) -> Result<Cleared, OutboxError> {
    let Some(dir) = outbox_dir(root)? else {
        return Ok(Cleared::default());
    };
    let entries = dir.entries().map_err(|e| match e {
        super::files::FilesError::Io(e) => OutboxError::Io(e),
        _ => OutboxError::Unavailable,
    })?;
    let mut cleared = Cleared::default();
    let mut failed = None;
    for (name, is_dir) in entries {
        if is_dir {
            continue;
        }
        let Some((_file, meta, _kind)) = probe(&dir, &name) else {
            continue;
        };
        match dir.remove_file(&name) {
            Ok(()) => {
                let _ = dir.remove_file(&marker_name(&name));
                let _ = dir.remove_file(&source_name(&name));
                cleared.files += 1;
                cleared.bytes += meta.len();
            }
            Err(e) => failed = Some(e.to_string()),
        }
    }
    match failed {
        Some(error) if cleared.files == 0 => Err(OutboxError::Io(error)),
        _ => Ok(cleared),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0\0\x10JFIF-body";

    fn outbox(root: &Path) -> std::path::PathBuf {
        let dir = root.join(OUTBOX_DIR);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, name: &str, bytes: &[u8], age: Duration) {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn the_bytes_decide_the_kind_not_the_name() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(JPEG), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a\x01\x00"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(classify(b"%PDF-1.7"), "application/pdf");
        assert_eq!(classify(b"<svg onload='alert(1)'/>"), "text/plain; charset=utf-8");
        assert_eq!(classify(b"<html><script>alert(1)</script>"), "text/plain; charset=utf-8");
        assert_eq!(classify(b"PK\0\x01"), "application/octet-stream");
        assert_eq!(classify(b"\xff"), "application/octet-stream");
        let mut head = vec![b'a'; SNIFF_BYTES];
        head[SNIFF_BYTES - 1] = 0xc3;
        assert_eq!(classify(&head), "text/plain; charset=utf-8");
        assert_eq!(classify(b"a\xc3"), "application/octet-stream");
        assert_eq!(sniff(b"\x89PN"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn only_a_safe_leaf_is_a_name() {
        assert!(valid_name("plot.png"));
        assert!(valid_name("20260905-120000-shot_1.jpeg"));
        assert!(!valid_name(""));
        assert!(!valid_name(".hidden.png"));
        assert!(!valid_name("../escape.png"));
        assert!(!valid_name("sub/dir.png"));
        assert!(!valid_name("back\\slash.png"));
        assert!(!valid_name("sp ace.png"));
        assert!(!valid_name("Größe.png"));
        assert!(!valid_name(&"x".repeat(MAX_NAME + 1)));
    }

    #[test]
    fn the_sent_name_drops_every_send_stamp() {
        assert_eq!(sent_name("20260930-101530-plot.png"), "plot.png");
        // Phone → inbox → `tabtivity-send` back: two stamps.
        assert_eq!(sent_name("20260930-101530-20260930-101010-IMG_4711.jpg"), "IMG_4711.jpg");
        assert_eq!(sent_name("plot.png"), "plot.png");
        assert_eq!(sent_name("2026-09-30-notes.md"), "2026-09-30-notes.md");
        assert_eq!(sent_name("20260930-1015-plot.png"), "20260930-1015-plot.png");
        // Nothing but a stamp: the leaf stays whole rather than going empty.
        assert_eq!(sent_name("20260930-101530-"), "20260930-101530-");
        assert_eq!(sent_name("20260930-101530-20260930-101010-"), "20260930-101010-");
        let dir = tempfile::tempdir().unwrap();
        touch(&outbox(dir.path()), "20260930-101530-IMG_1.jpg", JPEG, Duration::from_secs(1));
        assert_eq!(list(dir.path()).unwrap()[0].original, "IMG_1.jpg");
    }

    #[test]
    fn a_project_without_an_outbox_lists_nothing_and_a_missing_root_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(list(dir.path()), Ok(Vec::new()));
        assert_eq!(read(dir.path(), "plot.png"), Err(OutboxError::NotFound));
        assert_eq!(list(&dir.path().join("missing")), Err(OutboxError::Unavailable));
    }

    #[test]
    fn files_list_newest_first_by_safe_name() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        touch(&box_dir, "old.png", PNG, Duration::from_secs(3_600));
        touch(&box_dir, "new.jpg", JPEG, Duration::from_secs(60));
        // The extension says image; the bytes say inert text.
        touch(&box_dir, "fake.png", b"hello, not a picture", Duration::from_secs(10));
        // Script can hide in an SVG; it is not an image here.
        touch(&box_dir, "vector.svg", b"<svg onload=\"alert(1)\"/>", Duration::from_secs(10));
        touch(&box_dir, "empty.png", b"", Duration::from_secs(10));
        touch(&box_dir, ".hidden.png", PNG, Duration::from_secs(10));
        touch(&box_dir, "with space.png", PNG, Duration::from_secs(10));
        fs::create_dir_all(box_dir.join("folder.png")).unwrap();

        let listed = list(dir.path()).unwrap();
        let names: Vec<&str> = listed.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["vector.svg", "fake.png", "new.jpg", "old.png"]);
        assert_eq!(listed[2].kind, "image/jpeg");
        assert_eq!(listed[2].size, JPEG.len() as u64);
        assert!(listed[2].modified > listed[3].modified);

        let (bytes, kind) = read(dir.path(), "old.png").unwrap();
        assert_eq!(bytes, PNG);
        assert_eq!(kind, "image/png");
        for refused in ["empty.png", ".hidden.png", "with space.png", "folder.png", "../old.png", "gone.png"] {
            assert_eq!(read(dir.path(), refused), Err(OutboxError::NotFound), "{refused}");
        }
    }

    #[test]
    fn the_listing_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        for i in 0..(MAX_LISTED + 5) {
            touch(&box_dir, &format!("p{i:03}.png"), PNG, Duration::from_secs(i as u64));
        }
        let listed = list(dir.path()).unwrap();
        assert_eq!(listed.len(), MAX_LISTED);
        assert_eq!(listed[0].name, "p000.png");
    }

    #[test]
    fn an_oversized_file_is_not_served() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        let path = box_dir.join("huge.png");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_OUTBOX_FILE + 1).unwrap();
        drop(file);
        // A sparse file: the header is zeros, so it would fail the sniff too —
        // make it a real PNG header to prove the size alone refuses it.
        let mut file = fs::File::options().write(true).open(&path).unwrap();
        std::io::Write::write_all(&mut file, PNG).unwrap();
        drop(file);
        assert_eq!(list(dir.path()).unwrap(), Vec::new());
        assert_eq!(read(dir.path(), "huge.png"), Err(OutboxError::NotFound));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed_in_or_out_of_the_outbox() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("private.png");
        fs::write(&secret, PNG).unwrap();

        // A link *inside* the outbox pointing at a picture elsewhere.
        let root = dir.path().join("linked-file");
        let box_dir = outbox(&root);
        std::os::unix::fs::symlink(&secret, box_dir.join("leak.png")).unwrap();
        touch(&box_dir, "own.png", PNG, Duration::from_secs(1));
        let names: Vec<String> = list(&root).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["own.png"]);
        assert_eq!(read(&root, "leak.png"), Err(OutboxError::NotFound));

        // Resolving to the root itself is not below it: it must not turn
        // the outbox route into a listing of every file in the project.
        let root = dir.path().join("root-alias");
        fs::create_dir_all(root.join(concat!(".", crate::app_slug!()))).unwrap();
        std::os::unix::fs::symlink(&root, root.join(OUTBOX_DIR)).unwrap();
        assert_eq!(list(&root), Err(OutboxError::Unavailable));

        // The outbox itself as a link out of the project.
        let root = dir.path().join("linked-dir");
        fs::create_dir_all(root.join(concat!(".", crate::app_slug!()))).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join(OUTBOX_DIR)).unwrap();
        assert_eq!(list(&root), Err(OutboxError::Unavailable));
        assert_eq!(read(&root, "private.png"), Err(OutboxError::Unavailable));
    }

    /// Gap 12: the walk to the outbox opens every folder without following a
    /// link, so a `.tabtivity` or `outbox` link — out of the project or into
    /// it — is refused for listing, reading, probing and deleting alike.
    #[cfg(unix)]
    #[test]
    fn a_linked_project_dir_or_outbox_is_refused_for_every_door() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let foreign = outbox(outside.path());
        touch(&foreign, "private.png", PNG, Duration::from_secs(1));
        let project_dir = concat!(".", crate::app_slug!());

        // `.tabtivity` itself a link to a folder holding an `outbox/`.
        let linked_top = dir.path().join("linked-top");
        fs::create_dir_all(&linked_top).unwrap();
        std::os::unix::fs::symlink(outside.path().join(project_dir), linked_top.join(project_dir)).unwrap();
        // `outbox` a link to another folder of the same project.
        let linked_inside = dir.path().join("linked-inside");
        fs::create_dir_all(linked_inside.join(project_dir)).unwrap();
        fs::create_dir_all(linked_inside.join("docs")).unwrap();
        touch(&linked_inside.join("docs"), "private.png", PNG, Duration::from_secs(1));
        std::os::unix::fs::symlink(linked_inside.join("docs"), linked_inside.join(OUTBOX_DIR)).unwrap();
        // `.tabtivity` a plain file.
        let file_top = dir.path().join("file-top");
        fs::create_dir_all(&file_top).unwrap();
        fs::write(file_top.join(project_dir), b"not a folder").unwrap();

        for root in [&linked_top, &linked_inside, &file_top] {
            assert_eq!(list(root), Err(OutboxError::Unavailable), "{root:?}");
            assert_eq!(read(root, "private.png"), Err(OutboxError::Unavailable), "{root:?}");
            assert_eq!(remove(root, "private.png"), Err(OutboxError::Unavailable), "{root:?}");
            assert!(!exists(root, "private.png"), "{root:?}");
        }
        assert!(foreign.join("private.png").is_file());
        assert!(linked_inside.join("docs/private.png").is_file());
    }

    /// Gap 12, the race: once the walk holds the outbox, swapping
    /// `.tabtivity` for a link changes nothing about the rest of the request —
    /// listing, reading and deleting go on in the folder it holds.
    #[cfg(unix)]
    #[test]
    fn a_project_dir_swapped_for_a_link_mid_request_never_reaches_the_links_target() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project_dir = concat!(".", crate::app_slug!());
        let foreign = outbox(outside.path());
        touch(&foreign, "leak.png", PNG, Duration::from_secs(1));
        touch(&foreign, "own.png", JPEG, Duration::from_secs(1));
        touch(&outbox(dir.path()), "own.png", PNG, Duration::from_secs(1));

        let held = drop_dir(dir.path(), OUTBOX_DIR).unwrap().unwrap();
        fs::rename(dir.path().join(project_dir), dir.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path().join(project_dir), dir.path().join(project_dir)).unwrap();

        let names: Vec<String> = list_in(&held, None).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["own.png"]);
        assert_eq!(read_probed(&held, "own.png", valid_name).unwrap(), (PNG.to_vec(), "image/png"));
        assert_eq!(read_probed(&held, "leak.png", valid_name), Err(OutboxError::NotFound));
        assert!(held.remove_file("own.png").is_ok());
        assert!(!dir.path().join("moved/outbox/own.png").exists());
        assert!(foreign.join("own.png").is_file() && foreign.join("leak.png").is_file());
        // And a fresh request stops at the link.
        assert_eq!(list(dir.path()), Err(OutboxError::Unavailable));
    }

    #[test]
    fn a_listed_file_is_deletable_and_nothing_else_is() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        touch(&box_dir, "plot.png", PNG, Duration::from_secs(1));
        touch(&box_dir, "keep.png", JPEG, Duration::from_secs(2));

        assert_eq!(remove(dir.path(), "plot.png"), Ok(()));
        let names: Vec<String> = list(dir.path()).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["keep.png"]);
        assert!(!box_dir.join("plot.png").exists());

        // Gone, a name the listing never handed out, and a leaf the alphabet
        // refuses: all the same answer, and none of them touch a file.
        assert_eq!(remove(dir.path(), "plot.png"), Err(OutboxError::NotFound));
        assert_eq!(remove(dir.path(), "absent.png"), Err(OutboxError::NotFound));
        assert_eq!(remove(dir.path(), "../keep.png"), Err(OutboxError::NotFound));
        assert!(box_dir.join("keep.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn delete_all_clears_every_servable_file_past_the_listing_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("private.png");
        fs::write(&secret, PNG).unwrap();
        let box_dir = outbox(dir.path());
        for i in 0..(MAX_LISTED + 3) {
            touch(&box_dir, &format!("p{i}.png"), PNG, Duration::from_secs(i as u64));
        }
        fs::write(box_dir.join(".p0.png.tab"), "aaaa-1").unwrap();
        fs::write(box_dir.join(".p0.png.src"), "docs/p.png").unwrap();
        std::os::unix::fs::symlink(&secret, box_dir.join("leak.png")).unwrap();
        fs::create_dir(box_dir.join("folder")).unwrap();

        let cleared = remove_all(dir.path()).unwrap();
        assert_eq!(cleared.files, MAX_LISTED + 3);
        assert_eq!(cleared.bytes, (PNG.len() * (MAX_LISTED + 3)) as u64);
        assert!(list(dir.path()).unwrap().is_empty());
        assert!(!box_dir.join(".p0.png.tab").exists() && !box_dir.join(".p0.png.src").exists());
        // The link and the folder were never the phone's to clear.
        assert!(box_dir.join("leak.png").symlink_metadata().is_ok() && secret.exists());
        assert!(box_dir.join("folder").is_dir());

        // Again, and with no outbox at all: nothing to clear, not an error.
        assert_eq!(remove_all(dir.path()), Ok(Cleared::default()));
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(remove_all(empty.path()), Ok(Cleared::default()));
        assert_eq!(remove_all(&empty.path().join("missing")), Err(OutboxError::Unavailable));
    }

    #[test]
    fn only_the_sending_tab_sees_a_file_as_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        touch(&box_dir, "mine.png", PNG, Duration::from_secs(3));
        fs::write(box_dir.join(".mine.png.tab"), "aaaa-1").unwrap();
        touch(&box_dir, "theirs.png", PNG, Duration::from_secs(2));
        fs::write(box_dir.join(".theirs.png.tab"), "bbbb-2\n").unwrap();
        touch(&box_dir, "unmarked.png", PNG, Duration::from_secs(1));
        touch(&box_dir, "bogus.png", PNG, Duration::from_secs(0));
        fs::write(box_dir.join(".bogus.png.tab"), "aaaa-1/../x").unwrap();

        let own = |tab: Option<&str>| -> Vec<String> {
            list_for(dir.path(), tab).unwrap().into_iter().filter(|f| f.from_tab).map(|f| f.name).collect()
        };
        // Every tab lists all four; each chat claims only its own.
        assert_eq!(list_for(dir.path(), Some("aaaa-1")).unwrap().len(), 4);
        assert_eq!(own(Some("aaaa-1")), ["mine.png"]);
        assert_eq!(own(Some("bbbb-2")), ["theirs.png"]);
        assert!(own(Some("cccc-3")).is_empty());
        assert!(own(None).is_empty());
        // The marker never crosses, and a listing without a tab says nothing.
        let json = serde_json::to_string(&list(dir.path()).unwrap()).unwrap();
        assert!(!json.contains("from_tab") && !json.contains("aaaa"), "{json}");

        // Deleting the file drops its marker, so a later leaf can't inherit it.
        assert_eq!(remove(dir.path(), "mine.png"), Ok(()));
        assert!(!box_dir.join(".mine.png.tab").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_marker_claims_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("id"), "aaaa-1").unwrap();
        let box_dir = outbox(dir.path());
        touch(&box_dir, "plot.png", PNG, Duration::from_secs(1));
        std::os::unix::fs::symlink(outside.path().join("id"), box_dir.join(".plot.png.tab")).unwrap();
        assert!(!list_for(dir.path(), Some("aaaa-1")).unwrap()[0].from_tab);
    }

    #[test]
    fn the_origin_marker_names_the_project_file_and_never_crosses() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        touch(&box_dir, "20261004-120000-paper.pdf", b"%PDF-1.7\n", Duration::from_secs(4));
        fs::write(box_dir.join(".20261004-120000-paper.pdf.src"), "docs/paper/paper.pdf\n").unwrap();
        touch(&box_dir, "plain.png", PNG, Duration::from_secs(3));
        // A copy of a copy, a path from the root, a second line: no origin.
        touch(&box_dir, "again.png", PNG, Duration::from_secs(2));
        fs::write(box_dir.join(".again.png.src"), format!("{OUTBOX_DIR}/plain.png")).unwrap();
        touch(&box_dir, "rooted.png", PNG, Duration::from_secs(1));
        fs::write(box_dir.join(".rooted.png.src"), "/etc/passwd").unwrap();
        touch(&box_dir, "lines.png", PNG, Duration::from_secs(0));
        fs::write(box_dir.join(".lines.png.src"), "a.png\nb.png").unwrap();

        let listed = list(dir.path()).unwrap();
        let source = |name: &str| listed.iter().find(|f| f.name == name).unwrap().source.clone();
        assert_eq!(source("20261004-120000-paper.pdf").as_deref(), Some("docs/paper/paper.pdf"));
        for none in ["plain.png", "again.png", "rooted.png", "lines.png"] {
            assert_eq!(source(none), None, "{none}");
        }
        let json = serde_json::to_string(&listed).unwrap();
        assert!(!json.contains("docs/paper") && !json.contains("source"), "{json}");

        // Deleting the file drops its origin marker too.
        assert_eq!(remove(dir.path(), "20261004-120000-paper.pdf"), Ok(()));
        assert!(!box_dir.join(".20261004-120000-paper.pdf.src").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_origin_marker_names_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("rel"), "docs/paper.pdf").unwrap();
        let box_dir = outbox(dir.path());
        touch(&box_dir, "paper.pdf", b"%PDF-1.7\n", Duration::from_secs(1));
        std::os::unix::fs::symlink(outside.path().join("rel"), box_dir.join(".paper.pdf.src")).unwrap();
        assert_eq!(list(dir.path()).unwrap()[0].source, None);
    }

    #[test]
    fn a_project_without_an_outbox_deletes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(remove(dir.path(), "plot.png"), Err(OutboxError::NotFound));
        assert_eq!(
            remove(&dir.path().join("missing"), "plot.png"),
            Err(OutboxError::Unavailable)
        );
    }

    /// The deletion path must not become the one door that follows a link out
    /// of the project: a link inside the outbox is not a file the phone saw.
    #[cfg(unix)]
    #[test]
    fn a_link_inside_the_outbox_is_refused_rather_than_unlinked() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("private.png");
        fs::write(&secret, PNG).unwrap();
        let root = dir.path().join("linked-file");
        let box_dir = outbox(&root);
        std::os::unix::fs::symlink(&secret, box_dir.join("leak.png")).unwrap();

        assert_eq!(remove(&root, "leak.png"), Err(OutboxError::NotFound));
        assert!(box_dir.join("leak.png").symlink_metadata().is_ok());
        assert!(secret.exists());
    }
}
