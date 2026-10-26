//! Folder copy that never follows a link inside the tree.
//!
//! The file tree's Copy/Paste, the cross-device move fallback and the import of
//! a dropped or downloaded folder all copy a tree an agent may have written to.
//! The top-level source is whatever the caller resolved (the user picked it);
//! everything below it is looked at without following a link: a link is
//! recreated as a link (Unix; skipped on Windows), a pipe, socket or device is
//! skipped and reported, and a regular file is read from a handle opened
//! `O_NOFOLLOW | O_NONBLOCK` and checked regular on that handle. The copy is
//! written through [`ProjectDir`] handles (`mkdirat`, `O_EXCL | O_NOFOLLOW`,
//! `symlinkat`), so a link planted in the half-made destination is not followed
//! either. Bytes, entries and depth are bounded; hitting a bound removes the
//! half-made copy and fails.

use std::io::{self, Read};
use std::path::Path;

use serde::Serialize;

use crate::services::home_io::{HomeDir, HomeFile};
use crate::services::mobile_control::files::ProjectDir;

/// Most entries (files, folders, links, skipped ones) one copy walks.
pub const MAX_ENTRIES: usize = 200_000;
/// Most file bytes one copy writes.
pub const MAX_BYTES: u64 = 32 << 30;
const MAX_DEPTH: usize = 128;
/// Skipped paths named in a report; the rest are only counted.
const REPORT_NAMES: usize = 20;

#[derive(Debug, Clone, Copy)]
struct Limits {
    entries: usize,
    bytes: u64,
    depth: usize,
}

const LIMITS: Limits = Limits { entries: MAX_ENTRIES, bytes: MAX_BYTES, depth: MAX_DEPTH };

/// What a copy left out: pipes, sockets, devices, names that are not plain
/// UTF-8, anything that changed under the walk, and (Windows) links.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    /// The first skipped paths, relative to the copied folder.
    pub skipped: Vec<String>,
    /// How many were skipped in all.
    pub skipped_count: usize,
}

impl CopyReport {
    fn skip(&mut self, rel: String) {
        self.skipped_count += 1;
        if self.skipped.len() < REPORT_NAMES {
            self.skipped.push(rel);
        }
    }

    /// `"a, b, … (+3 more)"`, for a message.
    pub fn summary(&self) -> String {
        let more = self.skipped_count.saturating_sub(self.skipped.len());
        let mut text = self.skipped.join(", ");
        if more > 0 {
            text.push_str(&format!(" (+{more} more)"));
        }
        text
    }
}

/// Copy `src` (a file or a folder, taken as given) to `dest`, which must not
/// exist yet and whose parent must.
pub fn copy_tree(src: &Path, dest: &Path) -> io::Result<CopyReport> {
    copy_tree_with(src, dest, LIMITS, true)
}

/// [`copy_tree`] that leaves every link out (reported as skipped) instead of
/// recreating it: for a third-party tree whose links mean nothing at the
/// destination (a skill repository's `notes -> ~/.ssh`).
pub fn copy_tree_without_links(src: &Path, dest: &Path) -> io::Result<CopyReport> {
    copy_tree_with(src, dest, LIMITS, false)
}

fn copy_tree_with(src: &Path, dest: &Path, limits: Limits, keep_links: bool) -> io::Result<CopyReport> {
    let parent = dest.parent().ok_or_else(|| invalid("the destination has no folder"))?;
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| invalid("the destination name is not valid"))?;
    let siblings = HomeDir::open_below(parent, 0).ok_or_else(|| other("the destination folder is not available"))?;
    if siblings.file(name).is_some_and(|f| f.exists()) {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("'{}' already exists", dest.display())));
    }
    let into = ProjectDir::open_root(parent).map_err(|_| other("the destination folder is not available"))?;
    let mut run = Run { limits, keep_links, entries: 0, bytes: 0, report: CopyReport::default() };
    let made = if std::fs::metadata(src)?.is_dir() {
        run.top_dir(src, &into, name)
    } else {
        let file = HomeFile::open_below(src, 1).ok_or_else(|| other("the source is not available"))?;
        run.file(&file, &into, name, name)
    };
    match made {
        Ok(()) => Ok(run.report),
        Err(error) => {
            // The destination was absent when this began, so what is there is ours.
            let _ = siblings.remove_tree(name);
            Err(error)
        }
    }
}

/// Remove a copy [`copy_tree`] made, for a caller that finds it unusable.
pub fn discard(dest: &Path) {
    if let (Some(parent), Some(name)) = (dest.parent(), dest.file_name().and_then(|n| n.to_str())) {
        if let Some(dir) = HomeDir::open_below(parent, 0) {
            let _ = dir.remove_tree(name);
        }
    }
}

struct Run {
    limits: Limits,
    keep_links: bool,
    entries: usize,
    bytes: u64,
    report: CopyReport,
}

impl Run {
    fn top_dir(&mut self, src: &Path, into: &ProjectDir, name: &str) -> io::Result<()> {
        let source = HomeDir::open_below(src, 0).ok_or_else(|| other("the source is not available"))?;
        into.create_dir(name)?;
        let target = into
            .lookup_dir(name)
            .ok()
            .flatten()
            .ok_or_else(|| other("the destination folder could not be opened"))?;
        self.dir(&source, &target, "", 0)
    }

    fn dir(&mut self, source: &HomeDir, target: &ProjectDir, rel: &str, depth: usize) -> io::Result<()> {
        if depth > self.limits.depth {
            return Err(too_large("the folders are nested too deeply"));
        }
        let (names, odd) = source.entry_names();
        for _ in 0..odd {
            self.entry()?;
            self.report.skip(join(rel, "<name not valid UTF-8>"));
        }
        for name in names {
            self.entry()?;
            let path = join(rel, &name);
            let Some(item) = source.file(&name) else {
                self.report.skip(path);
                continue;
            };
            let Ok(meta) = item.lstat() else {
                self.report.skip(path);
                continue;
            };
            if meta.is_symlink && !self.keep_links {
                self.report.skip(path);
            } else if meta.is_symlink {
                self.link(&item, target, &name, path);
            } else if meta.is_dir {
                let Some(child) = source.open_subdir(&name) else {
                    self.report.skip(path);
                    continue;
                };
                target.create_dir(&name)?;
                let made = target
                    .lookup_dir(&name)
                    .ok()
                    .flatten()
                    .ok_or_else(|| other("a destination folder could not be opened"))?;
                self.dir(&child, &made, &path, depth + 1)?;
            } else if meta.is_file {
                self.file(&item, target, &name, &path)?;
            } else {
                self.report.skip(path);
            }
        }
        Ok(())
    }

    #[cfg(unix)]
    fn link(&mut self, item: &HomeFile, target: &ProjectDir, name: &str, path: String) {
        let made = item.read_link().is_some_and(|to| target.create_symlink(name, &to).is_ok());
        if !made {
            self.report.skip(path);
        }
    }

    #[cfg(not(unix))]
    fn link(&mut self, _item: &HomeFile, _target: &ProjectDir, _name: &str, path: String) {
        self.report.skip(path);
    }

    fn file(&mut self, item: &HomeFile, target: &ProjectDir, name: &str, path: &str) -> io::Result<()> {
        let Some(input) = item.open_read() else {
            self.report.skip(path.to_string());
            return Ok(());
        };
        #[cfg(unix)]
        let mode = input.metadata().ok().map(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o777);
        let mut out = target.create_file(name)?;
        let room = self.limits.bytes.saturating_sub(self.bytes);
        // One byte past the room tells "exactly full" from "over".
        let copied = io::copy(&mut input.take(room.saturating_add(1)), &mut out)?;
        if copied > room {
            return Err(too_large("the copy is larger than the limit"));
        }
        self.bytes += copied;
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            let _ = out.set_permissions(std::fs::Permissions::from_mode(mode));
        }
        Ok(())
    }

    fn entry(&mut self) -> io::Result<()> {
        self.entries += 1;
        if self.entries > self.limits.entries {
            return Err(too_large("the folder holds too many entries"));
        }
        Ok(())
    }
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_string())
}

fn other(message: &str) -> io::Error {
    io::Error::other(message.to_string())
}

fn too_large(message: &str) -> io::Error {
    io::Error::other(format!("too large to copy: {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn small(entries: usize, bytes: u64) -> Limits {
        Limits { entries, bytes, depth: MAX_DEPTH }
    }

    #[test]
    fn copies_files_and_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join("a/b")).unwrap();
        fs::write(src.join("top.txt"), "top").unwrap();
        fs::write(src.join("a/b/deep.txt"), "deep").unwrap();
        fs::create_dir(src.join("empty")).unwrap();

        let report = copy_tree(&src, &tmp.path().join("dst")).unwrap();

        assert_eq!(report, CopyReport::default());
        assert_eq!(fs::read_to_string(tmp.path().join("dst/top.txt")).unwrap(), "top");
        assert_eq!(fs::read_to_string(tmp.path().join("dst/a/b/deep.txt")).unwrap(), "deep");
        assert!(tmp.path().join("dst/empty").is_dir());
        assert!(src.join("top.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn without_links_skips_every_link_and_stays_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join("a")).unwrap();
        fs::write(src.join("a").join("f.txt"), "f").unwrap();
        std::os::unix::fs::symlink(tmp.path(), src.join("out")).unwrap();
        std::os::unix::fs::symlink("f.txt", src.join("a").join("rel")).unwrap();

        let report = copy_tree_without_links(&src, &tmp.path().join("dst")).unwrap();
        assert_eq!(report.skipped_count, 2);
        assert_eq!(fs::read_to_string(tmp.path().join("dst").join("a").join("f.txt")).unwrap(), "f");
        assert!(fs::symlink_metadata(tmp.path().join("dst").join("out")).is_err());
        assert!(fs::symlink_metadata(tmp.path().join("dst").join("a").join("rel")).is_err());

        let error = copy_tree_with(&src, &tmp.path().join("dst2"), small(2, MAX_BYTES), false).unwrap_err();
        assert!(error.to_string().contains("too many entries"), "{error}");
        assert!(!tmp.path().join("dst2").exists());
    }

    #[test]
    fn copies_a_single_file() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), "hello").unwrap();

        copy_tree(&tmp.path().join("a.txt"), &tmp.path().join("b.txt")).unwrap();

        assert_eq!(fs::read_to_string(tmp.path().join("b.txt")).unwrap(), "hello");
    }

    #[test]
    fn refuses_an_existing_destination_and_leaves_it_alone() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        fs::create_dir(tmp.path().join("dst")).unwrap();
        fs::write(tmp.path().join("dst/keep.txt"), "keep").unwrap();

        let error = copy_tree(&tmp.path().join("src"), &tmp.path().join("dst")).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(tmp.path().join("dst/keep.txt")).unwrap(), "keep");
    }

    #[test]
    fn an_entry_limit_stops_the_copy_and_removes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir(&src).unwrap();
        for n in 0..5 {
            fs::write(src.join(format!("f{n}")), "x").unwrap();
        }

        let error = copy_tree_with(&src, &tmp.path().join("dst"), small(3, MAX_BYTES), true).unwrap_err();

        assert!(error.to_string().contains("too many entries"), "{error}");
        assert!(!tmp.path().join("dst").exists());
        assert!(src.join("f0").exists());
    }

    #[test]
    fn a_byte_limit_stops_the_copy_and_removes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("a"), vec![1u8; 600]).unwrap();
        fs::write(src.join("b"), vec![2u8; 600]).unwrap();

        let error = copy_tree_with(&src, &tmp.path().join("dst"), small(100, 1000), true).unwrap_err();

        assert!(error.to_string().contains("larger than the limit"), "{error}");
        assert!(!tmp.path().join("dst").exists());
        // Exactly the limit is fine.
        copy_tree_with(&src, &tmp.path().join("dst2"), small(100, 1200), true).unwrap();
        assert_eq!(fs::read(tmp.path().join("dst2/b")).unwrap().len(), 600);
    }

    #[test]
    fn a_depth_limit_stops_the_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join("a/b/c")).unwrap();

        let limits = Limits { entries: 100, bytes: MAX_BYTES, depth: 1 };
        let error = copy_tree_with(&src, &tmp.path().join("dst"), limits, true).unwrap_err();

        assert!(error.to_string().contains("nested too deeply"), "{error}");
        assert!(!tmp.path().join("dst").exists());
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        #[test]
        fn a_link_is_recreated_as_a_link_and_never_followed() {
            let tmp = tempfile::tempdir().unwrap();
            let outside = tmp.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("secret.txt"), "secret").unwrap();
            let src = tmp.path().join("src");
            fs::create_dir(&src).unwrap();
            symlink(&outside, src.join("dir-link")).unwrap();
            symlink(outside.join("secret.txt"), src.join("file-link")).unwrap();
            symlink("rel-target", src.join("rel-link")).unwrap();
            symlink("nowhere", src.join("dangling")).unwrap();

            let report = copy_tree(&src, &tmp.path().join("dst")).unwrap();

            assert_eq!(report, CopyReport::default());
            let dst = tmp.path().join("dst");
            for (name, to) in [
                ("dir-link", outside.clone()),
                ("file-link", outside.join("secret.txt")),
                ("rel-link", "rel-target".into()),
                ("dangling", "nowhere".into()),
            ] {
                let meta = fs::symlink_metadata(dst.join(name)).unwrap();
                assert!(meta.file_type().is_symlink(), "{name} is a link");
                assert_eq!(fs::read_link(dst.join(name)).unwrap(), to);
            }
        }

        #[test]
        fn a_link_loop_terminates() {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("src");
            fs::create_dir_all(src.join("a")).unwrap();
            fs::write(src.join("a/f.txt"), "f").unwrap();
            symlink("..", src.join("a/up")).unwrap();
            symlink("../src", src.join("a/self")).unwrap();
            symlink("loop-b", src.join("loop-a")).unwrap();
            symlink("loop-a", src.join("loop-b")).unwrap();

            let report = copy_tree(&src, &tmp.path().join("dst")).unwrap();

            assert_eq!(report.skipped_count, 0);
            assert!(fs::symlink_metadata(tmp.path().join("dst/a/up")).unwrap().file_type().is_symlink());
            assert_eq!(fs::read_to_string(tmp.path().join("dst/a/f.txt")).unwrap(), "f");
        }

        #[test]
        fn a_link_to_a_device_is_a_link_and_is_never_read() {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("src");
            fs::create_dir(&src).unwrap();
            symlink("/dev/zero", src.join("zero")).unwrap();
            symlink("/dev/stdin", src.join("stdin")).unwrap();

            let report = copy_tree(&src, &tmp.path().join("dst")).unwrap();

            assert_eq!(report, CopyReport::default());
            assert_eq!(fs::read_link(tmp.path().join("dst/zero")).unwrap(), Path::new("/dev/zero"));
            assert_eq!(fs::read_link(tmp.path().join("dst/stdin")).unwrap(), Path::new("/dev/stdin"));
        }

        #[test]
        fn pipes_and_sockets_are_skipped_and_reported() {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("src");
            fs::create_dir_all(src.join("sub")).unwrap();
            fs::write(src.join("real.txt"), "real").unwrap();
            let fifo = std::ffi::CString::new(src.join("sub/pipe").to_str().unwrap()).unwrap();
            // SAFETY: a valid NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            let _socket = std::os::unix::net::UnixListener::bind(src.join("sock")).unwrap();

            let report = copy_tree(&src, &tmp.path().join("dst")).unwrap();

            assert_eq!(report.skipped_count, 2);
            assert!(report.skipped.contains(&"sub/pipe".to_string()), "{report:?}");
            assert!(report.skipped.contains(&"sock".to_string()), "{report:?}");
            assert!(!tmp.path().join("dst/sub/pipe").exists());
            assert!(!tmp.path().join("dst/sock").exists());
            assert_eq!(fs::read_to_string(tmp.path().join("dst/real.txt")).unwrap(), "real");
            assert!(report.summary().contains("sub/pipe"));
        }

        #[test]
        fn a_regular_files_mode_survives_but_not_setuid() {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("src");
            fs::create_dir(&src).unwrap();
            fs::write(src.join("run.sh"), "#!/bin/sh").unwrap();
            fs::set_permissions(src.join("run.sh"), fs::Permissions::from_mode(0o4755)).unwrap();

            copy_tree(&src, &tmp.path().join("dst")).unwrap();

            let mode = fs::metadata(tmp.path().join("dst/run.sh")).unwrap().permissions().mode();
            assert_eq!(mode & 0o7777, 0o755);
        }

        #[test]
        fn the_top_level_source_is_taken_as_resolved() {
            let tmp = tempfile::tempdir().unwrap();
            let real = tmp.path().join("real");
            fs::create_dir(&real).unwrap();
            fs::write(real.join("f.txt"), "f").unwrap();
            symlink(&real, tmp.path().join("top-link")).unwrap();

            copy_tree(&tmp.path().join("top-link"), &tmp.path().join("dst")).unwrap();

            assert_eq!(fs::read_to_string(tmp.path().join("dst/f.txt")).unwrap(), "f");
        }

        #[test]
        fn a_link_planted_at_the_destination_is_not_written_through() {
            let tmp = tempfile::tempdir().unwrap();
            let elsewhere = tmp.path().join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            symlink(&elsewhere, tmp.path().join("dst")).unwrap();
            let src = tmp.path().join("src");
            fs::create_dir(&src).unwrap();
            fs::write(src.join("f.txt"), "f").unwrap();

            let error = copy_tree(&src, &tmp.path().join("dst")).unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
            assert!(!elsewhere.join("f.txt").exists());
        }
    }
}
