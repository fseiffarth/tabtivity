//! The phone's **Annotate**: remarks and highlights written into a project
//! PDF itself, the desktop viewer's own remarks (`src/components/embed/pdf/notes.ts`)
//! — a `/Highlight` over words with its remark as `/Contents`, and a `/Text`
//! sticky note — so the desktop's Remarks pane, and every other reader, shows
//! them as comments.
//!
//! The one in-place write into an existing project file the phone has, so it
//! is narrow:
//!
//! - **Switched**: the host-wide `tabtivity_mobile_host.project_remarks`
//!   (default off), read per request and in effect only while the read-only
//!   browser (`project_files`) is on too ([`remarks_open`]).
//! - **Append-only**: the remarks go in as an incremental update
//!   (`markup_pdf::bake_remarks`), so the file's bytes before it stay as they
//!   were and cutting the file back to its old length undoes it.
//! - **Unchanged since read**: the phone names the size and mtime it read;
//!   anything else is [`RemarksError::Changed`], and the end of the file is
//!   checked again on the open descriptor right before the append.
//! - **No links**: the file is reached by the browser's [`ProjectDir`] walk
//!   and opened with its refusals, never through a link, and a failed append
//!   is cut back to the old length.
//!
//! Only boxes (highlights) and typed notes are remarks; pens, stamps and
//! anything else are refused.

use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use serde::Deserialize;
use serde_json::Value;

use super::files::{self, FilesError, ProjectDir, WriteRefusal};
use super::inbox;
use super::markup::{self, Mark, MarkupPage, MarkupRequest, MarkupSource, Mode, Origin};
use super::markup_pdf;
use super::outbox::MAX_OUTBOX_FILE;

/// The phone's save: the file as it read it, and the remarks per page in the
/// page's displayed units (the markup view's own).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemarksRequest {
    /// Bytes of the file when the phone read it.
    pub size: u64,
    /// Unix seconds of its mtime then (`files::Entry::modified`).
    pub modified: u64,
    pub pages: Vec<RemarksPage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemarksPage {
    pub n: u32,
    pub size: [f64; 2],
    pub marks: Vec<Mark>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RemarksError {
    /// The switch (or the browser) is off.
    Off,
    /// The marks are not remarks, or out of bounds.
    Invalid,
    /// Not a PDF, or one the writer cannot update (encrypted, unreadable).
    Unsupported,
    /// The file changed since the phone read it.
    Changed,
    /// Gone, or a link or not a plain file on the way.
    NotFound,
    TooLarge,
    /// A page the remarks are on is not in the file.
    PageMissing,
    Io(String),
}

impl RemarksError {
    pub fn code(&self) -> &'static str {
        match self {
            RemarksError::Off => "remarks_off",
            RemarksError::Invalid => "invalid_remarks",
            RemarksError::Unsupported => "unsupported_source",
            RemarksError::Changed => "file_changed",
            RemarksError::NotFound => "file_not_found",
            RemarksError::TooLarge => "file_too_large",
            RemarksError::PageMissing => "page_missing",
            RemarksError::Io(_) => "remarks_failed",
        }
    }
}

/// Whether the phone may write remarks: the browser switch
/// (`files::files_open`) **and** `project_remarks`, both read from
/// `settings.json` per call, so turning either off closes the route at once.
pub fn remarks_open(state_dir: &Path) -> bool {
    files::files_open(state_dir)
        && std::fs::read(state_dir.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|settings| settings.get(crate::brand::MOBILE_HOST_KEY)?.get("project_remarks")?.as_bool())
            .unwrap_or(false)
}

/// The marks as the shared markup bounds take them — and only remarks.
fn checked_pages(request: RemarksRequest) -> Result<Vec<MarkupPage>, RemarksError> {
    let placeholder = format!("{}/layer.png", inbox::INBOX_DIR);
    let pages: Vec<MarkupPage> = request
        .pages
        .into_iter()
        .map(|page| MarkupPage { n: page.n, size: page.size, marks: page.marks, layer: placeholder.clone(), composed: false, anchors: Vec::new() })
        .collect();
    if pages.iter().flat_map(|page| &page.marks).any(|mark| !matches!(mark, Mark::Box { .. } | Mark::Text { .. })) {
        return Err(RemarksError::Invalid);
    }
    let shaped = MarkupRequest {
        source: MarkupSource::Files(String::new()),
        pages,
        picture: None,
        instruction: None,
        ask: None,
        round: None,
        mode: Mode::List,
        origin: Origin::Viewer,
    };
    markup::validate_body(&shaped).map_err(|_| RemarksError::Invalid)?;
    Ok(shaped.pages)
}

/// The mtime as the listing gives it (`files::Entry::modified`).
fn mtime_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified().ok().map(crate::clock::unix_secs)
}

/// Writes the remarks into the project file `rel` (a path `files::unseal`
/// answered) under `root`. Blocking: reads up to `MAX_OUTBOX_FILE` bytes and
/// bakes them.
pub fn save(root: &Path, rel: &str, request: RemarksRequest) -> Result<(), RemarksError> {
    let (expect_size, expect_modified) = (request.size, request.modified);
    let pages = checked_pages(request)?;
    if rel.is_empty() || rel.split('/').any(files::hidden) {
        return Err(RemarksError::NotFound);
    }
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let dir = ProjectDir::open(root, parent).map_err(|error| match error {
        FilesError::Unavailable | FilesError::NotFound => RemarksError::NotFound,
        other => RemarksError::Io(other.code().to_string()),
    })?;
    let mut file = match dir.open_existing_for_update(name) {
        Ok(Some(file)) => file,
        Ok(None) | Err(WriteRefusal::Link) | Err(WriteRefusal::NotFile) => return Err(RemarksError::NotFound),
        Err(WriteRefusal::Io(error)) => return Err(RemarksError::Io(error.to_string())),
    };
    let meta = file.metadata().map_err(|error| RemarksError::Io(error.to_string()))?;
    if meta.len() > MAX_OUTBOX_FILE {
        return Err(RemarksError::TooLarge);
    }
    if meta.len() != expect_size || mtime_secs(&meta) != Some(expect_modified) {
        return Err(RemarksError::Changed);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    (&mut file).take(MAX_OUTBOX_FILE + 1).read_to_end(&mut bytes).map_err(|error| RemarksError::Io(error.to_string()))?;
    if bytes.len() as u64 != expect_size {
        return Err(RemarksError::Changed);
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(RemarksError::Unsupported);
    }
    // The reader is bounded and returns errors; a panic in it must still
    // end in a refusal, never a half-written file.
    let baked = std::panic::catch_unwind(|| markup_pdf::bake_remarks(&bytes, &pages)).unwrap_or(Err(markup_pdf::BakeError::Unreadable));
    let copy = match baked {
        Ok(copy) => copy,
        Err(markup_pdf::BakeError::PageMissing) => return Err(RemarksError::PageMissing),
        Err(_) => return Err(RemarksError::Unsupported),
    };
    // The update starts where the file ended: the copy is the file verbatim,
    // then what the bake added.
    if copy.len() <= bytes.len() || copy[..bytes.len()] != bytes[..] {
        return Err(RemarksError::Io("bake_shape".into()));
    }
    let tail = &copy[bytes.len()..];
    let old_len = bytes.len() as u64;
    // Written since our read? The end moved: refuse rather than append past it.
    let end = file.seek(SeekFrom::End(0)).map_err(|error| RemarksError::Io(error.to_string()))?;
    if end != old_len {
        return Err(RemarksError::Changed);
    }
    let written = file.write_all(tail).and_then(|()| file.sync_data());
    if let Err(error) = written {
        // Cut back to the file as it was: an update half on disk would leave
        // the last `startxref` pointing nowhere.
        let _ = file.set_len(old_len);
        return Err(RemarksError::Io(error.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::mobile_control::markup::Color;
    use std::fs;

    fn project(pdf: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/draft.pdf"), pdf).unwrap();
        (dir, root)
    }

    fn stamp_of(root: &Path) -> (u64, u64) {
        let meta = fs::metadata(root.join("docs/draft.pdf")).unwrap();
        (meta.len(), mtime_secs(&meta).unwrap())
    }

    fn remark(size: u64, modified: u64, marks: Vec<Mark>) -> RemarksRequest {
        RemarksRequest { size, modified, pages: vec![RemarksPage { n: 1, size: [600.0, 800.0], marks }] }
    }

    fn highlight() -> Mark {
        Mark::Box { color: Color::Yellow, rect: [50.0, 60.0, 200.0, 14.0], comment: Some("check this figure".into()) }
    }

    fn note() -> Mark {
        Mark::Text { color: Color::Black, at: [300.0, 400.0], size: 12.0, text: "Zitat fehlt".into() }
    }

    fn utf16(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xfe, 0xff];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        bytes
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn remarks_are_appended_as_highlights_and_sticky_notes() {
        let pdf = markup_pdf::tests::classic_pdf(&[0, 0], false);
        let (_dir, root) = project(&pdf);
        let (size, modified) = stamp_of(&root);
        save(&root, "docs/draft.pdf", remark(size, modified, vec![highlight(), note()])).unwrap();
        let after = fs::read(root.join("docs/draft.pdf")).unwrap();
        assert!(after.starts_with(&pdf), "the file before stays verbatim");
        let added = &after[pdf.len()..];
        assert!(contains(added, b"/Highlight") && contains(added, b"/Text") && contains(added, b"/Comment"));
        // The words go in hex, UTF-16 with its byte-order mark.
        let hex = |text: &str| utf16(text).iter().map(|b| format!("{b:02X}")).collect::<String>();
        let added_text = String::from_utf8_lossy(added).to_uppercase();
        assert!(added_text.contains(&hex("check this figure")) && added_text.contains(&hex("Zitat fehlt")), "{added_text}");
        assert!(!contains(added, b"/FreeText"), "a note is a sticky note, not text on the page");
    }

    #[test]
    fn a_file_changed_since_the_read_is_left_alone() {
        let pdf = markup_pdf::tests::classic_pdf(&[0], false);
        let (_dir, root) = project(&pdf);
        let (size, modified) = stamp_of(&root);
        assert_eq!(save(&root, "docs/draft.pdf", remark(size + 1, modified, vec![highlight()])), Err(RemarksError::Changed));
        assert_eq!(save(&root, "docs/draft.pdf", remark(size, modified + 5, vec![highlight()])), Err(RemarksError::Changed));
        assert_eq!(fs::read(root.join("docs/draft.pdf")).unwrap(), pdf);
    }

    #[test]
    fn only_remarks_on_a_plain_pdf_are_taken() {
        let pdf = markup_pdf::tests::classic_pdf(&[0], false);
        let (_dir, root) = project(&pdf);
        let (size, modified) = stamp_of(&root);
        let ink = Mark::Ink { color: Color::Red, width: 2.0, points: vec![[1.0, 1.0, 0.5], [9.0, 9.0, 0.5]], style: crate::services::mobile_control::markup::PenStyle::Pen, comment: None };
        assert_eq!(save(&root, "docs/draft.pdf", remark(size, modified, vec![ink])), Err(RemarksError::Invalid));
        assert_eq!(save(&root, "docs/draft.pdf", remark(size, modified, vec![])), Err(RemarksError::Invalid));
        let mut far = remark(size, modified, vec![highlight()]);
        far.pages[0].n = 9;
        assert_eq!(save(&root, "docs/draft.pdf", far), Err(RemarksError::PageMissing));
        assert_eq!(save(&root, "docs/missing.pdf", remark(size, modified, vec![highlight()])), Err(RemarksError::NotFound));
        fs::write(root.join("docs/notes.txt"), b"plain words").unwrap();
        let meta = fs::metadata(root.join("docs/notes.txt")).unwrap();
        let text = remark(meta.len(), mtime_secs(&meta).unwrap(), vec![highlight()]);
        assert_eq!(save(&root, "docs/notes.txt", text), Err(RemarksError::Unsupported));
        assert_eq!(fs::read(root.join("docs/draft.pdf")).unwrap(), pdf);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_never_written_through() {
        let pdf = markup_pdf::tests::classic_pdf(&[0], false);
        let (_dir, root) = project(&pdf);
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("other.pdf");
        fs::write(&target, &pdf).unwrap();
        std::os::unix::fs::symlink(&target, root.join("docs/linked.pdf")).unwrap();
        let meta = fs::metadata(&target).unwrap();
        let request = remark(meta.len(), mtime_secs(&meta).unwrap(), vec![highlight()]);
        assert_eq!(save(&root, "docs/linked.pdf", request), Err(RemarksError::NotFound));
        assert_eq!(fs::read(&target).unwrap(), pdf);
    }

    #[test]
    fn the_switch_needs_the_browser_too() {
        let dir = tempfile::tempdir().unwrap();
        let write = |host: serde_json::Value| {
            fs::write(dir.path().join("settings.json"), serde_json::json!({ crate::brand::MOBILE_HOST_KEY: host }).to_string()).unwrap()
        };
        write(serde_json::json!({ "project_files": true }));
        assert!(!remarks_open(dir.path()));
        write(serde_json::json!({ "project_remarks": true }));
        assert!(!remarks_open(dir.path()));
        write(serde_json::json!({ "project_files": true, "project_remarks": true }));
        assert_eq!(remarks_open(dir.path()), files::files_open(dir.path()));
    }
}
