//! **Download as zip** (`docs/phone_files_browsing_plan.md`, L10): one folder
//! of this computer's side of a project, as a stored (uncompressed) zip
//! streamed to the phone. Read-only, like the listing it mirrors.
//!
//! The walk is the drawer's (`files::walked_paths`): no link followed, none
//! of the names the drawer hides (`files::hidden`: `.git`, the project's own
//! folder, `.env*`), never into `files::WALK_SKIP` (build caches, installed
//! packages). Every file is opened relative to its held folder
//! (`ProjectDir`), so a link swapped in after the walk is never read. A
//! folder past [`MAX_ZIP_FILES`] files or [`MAX_ZIP_BYTES`] bytes is refused
//! before a byte is sent.

use std::io::{Read, Write};
use std::path::Path;

use super::files::{self, FilesError, ProjectDir};

/// The most files one zip holds.
pub const MAX_ZIP_FILES: usize = 2_000;
/// The most bytes of files one zip holds (no ZIP64 needed below 4 GiB).
pub const MAX_ZIP_BYTES: u64 = 1024 * 1024 * 1024;

/// What a zip of a folder will hold: each file's path below the root and
/// the name it takes inside the zip.
#[derive(Debug)]
pub struct Planned {
    files: Vec<(String, String)>,
    pub bytes: u64,
}

impl Planned {
    pub fn count(&self) -> usize {
        self.files.len()
    }
}

/// The files of the folder `under` (`""` is the root), walked as the drawer
/// walks; `TooLarge` past the caps, `NotFound` for a folder that is not one.
pub fn plan(root: &Path, under: &str) -> Result<Planned, FilesError> {
    // The folder itself, opened without a link on the way.
    ProjectDir::open(root, under)?;
    let (walked, stopped) = files::walked_paths(root, under, files::WALK_SKIP)?;
    if stopped {
        return Err(FilesError::TooLarge);
    }
    let mut planned = Planned { files: Vec::new(), bytes: 0 };
    for (rel, is_dir) in walked {
        if is_dir {
            continue;
        }
        let (parent, leaf) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
        let Ok(dir) = ProjectDir::open(root, parent) else { continue };
        let Some((_file, meta)) = dir.open_file(leaf) else { continue };
        planned.bytes = planned.bytes.saturating_add(meta.len());
        let inside = if under.is_empty() { rel.clone() } else { rel[under.len() + 1..].to_string() };
        planned.files.push((rel, inside));
        if planned.files.len() > MAX_ZIP_FILES || planned.bytes > MAX_ZIP_BYTES {
            return Err(FilesError::TooLarge);
        }
    }
    Ok(planned)
}

/// Writes the zip of `planned` to `out`, each file read through a handle
/// opened relative to its held folder; a file gone since the plan is left
/// out, one that grew is cut at what the plan allows in all.
pub fn write(root: &Path, planned: &Planned, out: impl Write) -> std::io::Result<()> {
    use zip::write::SimpleFileOptions;
    let mut zip = zip::ZipWriter::new_stream(out);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);
    let mut budget = planned.bytes;
    for (rel, inside) in &planned.files {
        let (parent, leaf) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
        let Ok(dir) = ProjectDir::open(root, parent) else { continue };
        let Some((file, meta)) = dir.open_file(leaf) else { continue };
        zip.start_file(inside.as_str(), options).map_err(std::io::Error::other)?;
        let take = meta.len().min(budget);
        let copied = std::io::copy(&mut file.take(take), &mut zip)?;
        budget -= copied;
    }
    zip.finish().map_err(std::io::Error::other)?.flush()
}

/// A `Write` that hands what it is given to the response body in chunks
/// (`tokio::sync::mpsc`), from the blocking thread the zip is written on.
/// The phone gone, a send fails and the write stops.
pub struct ChannelWriter {
    sender: tokio::sync::mpsc::Sender<std::io::Result<bytes::Bytes>>,
    buffer: Vec<u8>,
}

const CHUNK: usize = 64 * 1024;

impl ChannelWriter {
    pub fn new(sender: tokio::sync::mpsc::Sender<std::io::Result<bytes::Bytes>>) -> Self {
        Self { sender, buffer: Vec::with_capacity(CHUNK) }
    }

    fn send(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = bytes::Bytes::from(std::mem::replace(&mut self.buffer, Vec::with_capacity(CHUNK)));
        self.sender
            .blocking_send(Ok(chunk))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the phone stopped the download"))
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(data);
        if self.buffer.len() >= CHUNK {
            self.send()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// The names a zip holds, sorted.
    fn names_in(archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>) -> Vec<String> {
        let mut names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().unwrap().to_string()).collect();
        names.sort();
        names
    }

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("paper").join("figs")).unwrap();
        fs::create_dir_all(root.join("paper").join("node_modules").join("x")).unwrap();
        fs::write(root.join("paper").join("main.tex"), "\\documentclass{article}").unwrap();
        fs::write(root.join("paper").join("figs").join("a.png"), b"\x89PNG\r\n\x1a\nbody").unwrap();
        fs::write(root.join("paper").join(".env.local"), "TOKEN=1").unwrap();
        fs::write(root.join("paper").join(".latexmkrc"), "listed by the drawer").unwrap();
        fs::write(root.join("paper").join("node_modules").join("x").join("i.js"), "skip me").unwrap();
        fs::write(root.join("outside.txt"), "not in the folder").unwrap();
        dir
    }

    #[test]
    fn a_folder_zips_what_the_drawer_lists_and_reads_back() {
        let dir = tree();
        let planned = plan(dir.path(), "paper").unwrap();
        let mut bytes = Vec::new();
        write(dir.path(), &planned, &mut bytes).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(names_in(&mut archive), [".latexmkrc", "figs/a.png", "main.tex"], "no .env, nothing skipped, nothing outside");
        let mut tex = String::new();
        archive.by_name("main.tex").unwrap().read_to_string(&mut tex).unwrap();
        assert_eq!(tex, "\\documentclass{article}");
    }

    #[test]
    fn too_many_files_or_a_missing_folder_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("many")).unwrap();
        for i in 0..=MAX_ZIP_FILES {
            fs::write(dir.path().join("many").join(format!("{i}.txt")), "x").unwrap();
        }
        assert_eq!(plan(dir.path(), "many").unwrap_err(), FilesError::TooLarge);
        assert!(plan(dir.path(), "gone").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_folder_is_never_followed() {
        let dir = tree();
        std::os::unix::fs::symlink(dir.path().join("outside.txt"), dir.path().join("paper").join("link.txt")).unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("paper").join("up")).unwrap();
        let planned = plan(dir.path(), "paper").unwrap();
        let mut bytes = Vec::new();
        write(dir.path(), &planned, &mut bytes).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(names_in(&mut archive), [".latexmkrc", "figs/a.png", "main.tex"], "no link and nothing through one");
    }
}
