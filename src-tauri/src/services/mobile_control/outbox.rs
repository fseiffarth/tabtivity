//! Explicit project → phone files, published into `.tabtivity/outbox/`.
//!
//! Only safe leaf names of bounded, non-symlink regular files cross the API.
//! The directory must resolve below its project root. Types come from bytes:
//! images/PDF, inert UTF-8 text (including HTML/SVG), or attachment downloads.
//! Nothing detects terminal paths or copies files on the agent's behalf.
//!
//! `tabtivity-send` run in an agent tab leaves a marker beside each file,
//! `.<leaf>.tab`, holding the tab's `$TABTIVITY_TAB_UID`: that tab's chat shows
//! the file, every other tab's gallery still lists it. The marker is hidden by
//! the leaf alphabet and never crosses — the listing says only `from_tab`.

use std::{
    fs,
    io::{Read, Seek},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

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
}

#[derive(Debug, PartialEq, Eq)]
pub enum OutboxError {
    /// The project root is gone, or the outbox does not resolve below it.
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

/// The outbox directory, proven to sit below the project root — or `None`
/// when there is no outbox yet, which is the ordinary case and not an error.
fn outbox_dir(root: &Path) -> Result<Option<std::path::PathBuf>, OutboxError> {
    if !root.is_dir() {
        return Err(OutboxError::Unavailable);
    }
    let dir = root.join(OUTBOX_DIR);
    if fs::symlink_metadata(&dir).is_err() {
        return Ok(None);
    }
    let canonical_root = root.canonicalize().map_err(|_| OutboxError::Unavailable)?;
    let canonical_dir = dir.canonicalize().map_err(|_| OutboxError::Unavailable)?;
    if canonical_dir == canonical_root || !canonical_dir.starts_with(&canonical_root) || !canonical_dir.is_dir() {
        return Err(OutboxError::Unavailable);
    }
    Ok(Some(canonical_dir))
}

/// Reads the first bytes of a regular, non-symlink, bounded file under the
/// outbox and classifies its media type — or `None` for anything the phone must
/// not be handed.
fn probe(dir: &Path, name: &str) -> Option<(fs::File, fs::Metadata, &'static str)> {
    if !valid_name(name) {
        return None;
    }
    let (file, meta, kind) = open_sniffed(&dir.join(name))?;
    if meta.len() == 0 || meta.len() > MAX_OUTBOX_FILE {
        return None;
    }
    Some((file, meta, kind))
}

/// Opens a regular file without following a link at its leaf, and classifies
/// its first bytes — the one way a phone-facing read opens a file, shared with
/// the project file browser (`files.rs`). The descriptor comes back positioned
/// after the head; `rewind` before reading the whole of it.
pub fn open_sniffed(path: &Path) -> Option<(fs::File, fs::Metadata, &'static str)> {
    let (file, meta) = open_regular(path)?;
    sniff_opened(file, meta)
}

/// [`open_sniffed`] for a regular file the caller already opened (the file
/// browser opens its own, relative to a folder descriptor).
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

/// Opens a regular file without following a link at its leaf (nor blocking
/// on a FIFO swapped in after the check).
pub(super) fn open_regular(path: &Path) -> Option<(fs::File, fs::Metadata)> {
    // `symlink_metadata` does not follow: a link is refused as such, wherever
    // it points.
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    Some((file, meta))
}

/// The sender marker of leaf `name`: `.<name>.tab`.
fn marker_name(name: &str) -> String {
    format!(".{name}.tab")
}

/// The tab id `tabtivity-send` recorded for `name`, if a well-formed one is
/// there — the hook's alphabet (`[A-Za-z0-9-]`), bounded.
fn sender(dir: &Path, name: &str) -> Option<String> {
    let (file, meta) = open_regular(&dir.join(marker_name(name)))?;
    if meta.len() == 0 || meta.len() > MAX_TAB_ID {
        return None;
    }
    let mut id = String::new();
    file.take(MAX_TAB_ID).read_to_string(&mut id).ok()?;
    let id = id.trim_end();
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then(|| id.to_string())
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
    // The note the old-named send command leaves here (after a rename).
    crate::services::brand_migration::compat::take_send_alias_marker(&crate::brand::PAIR, &dir);
    let mut images = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| OutboxError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| OutboxError::Io(e.to_string()))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some((_file, meta, kind)) = probe(&dir, &name) else {
            continue;
        };
        let from_tab = tab.is_some_and(|tab| sender(&dir, &name).as_deref() == Some(tab));
        images.push(OutboxFile {
            original: sent_name(&name).to_string(),
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
    let Some((mut file, meta, _kind)) = probe(&dir, name) else {
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
/// the leaf, the bounds and the regular, non-symlink file under the *proven*
/// outbox directory, so a name the phone could not see is `NotFound` rather
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
    // `dir` is canonical and `name` is a validated leaf, so this is the file
    // `probe` just held open; `remove_file` never follows a link.
    fs::remove_file(dir.join(name)).map_err(|e| OutboxError::Io(e.to_string()))?;
    // Its sender marker goes with it, or a later file of the same leaf would
    // inherit it.
    let _ = fs::remove_file(dir.join(marker_name(name)));
    Ok(())
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
