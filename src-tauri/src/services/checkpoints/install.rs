//! Putting a checkpoint's file into the folder, and taking an added one away,
//! without resolving a path the agent can write twice (threat model gap 115).
//!
//! The folder is an agent's work tree: a process inside its fence can swap
//! any subfolder for a link at any moment. A path checked with `lstat` and
//! then handed to `open`/`unlink` (or to git, which caches "this leading
//! folder is a real folder" after its first file) can be redirected outside
//! the fence. So on Unix every operation here goes through directory handles,
//! the shape of `services::home_io`:
//!
//! - the bound folder is opened by a walk from `/` that follows no link (its
//!   path is canonical, so a link anywhere on it means it moved);
//! - each leading component is opened `O_DIRECTORY | O_NOFOLLOW` relative to
//!   the one above, and made through that handle when missing; a link or a
//!   non-folder there fails that one path ("is a link", "is not a folder");
//! - a file is copied from the private staging folder into an exclusive
//!   temporary in its destination folder and `renameat` into place on the
//!   same handle; a link is made there with `symlinkat` and renamed the same
//!   way, never followed; a removal is an `unlinkat` on the held parent.
//!
//! Whatever the agent renames afterwards moves the handle's folder with it,
//! so a write lands inside the folder or nowhere.
//!
//! Windows has no agent fence (its agents run with the user's full rights),
//! so that arm stays path-based: [`plain_path`] is checked again immediately
//! before each write and removal, and a swap in the instant between that
//! check and the write remains possible there.

use std::path::{Path, PathBuf};

#[cfg(not(unix))]
use super::restore::plain_path;
use super::restore::NO_UNDO;
#[cfg(not(unix))]
use super::store::rel_path;
#[cfg(unix)]
use super::store::shown;

/// What a path is put back as, from the staging folder.
pub enum Entry {
    /// A regular file there; `exec`: it gets the executable bits.
    File { from: PathBuf, exec: bool },
    /// A symbolic link with this target (made as a link, never followed).
    Link { target: PathBuf },
}

/// A fresh name for a temporary in a destination folder.
fn temp_name() -> String {
    format!(".{}-restore-{}.tmp", crate::brand::SLUG, super::store::new_id(crate::clock::now_ms()))
}

/// The bound folder, held open.
pub struct Target {
    #[cfg(unix)]
    dir: unix::Dir,
    #[cfg(not(unix))]
    folder: PathBuf,
}

#[cfg(unix)]
mod unix {
    use std::ffi::{CStr, CString};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

    pub fn c_name(name: &[u8]) -> io::Result<CString> {
        CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }

    /// A folder held open.
    pub struct Dir(pub OwnedFd);

    impl Dir {
        fn raw(&self) -> RawFd {
            self.0.as_raw_fd()
        }

        pub fn root() -> io::Result<Dir> {
            // SAFETY: a NUL-terminated path; the descriptor is owned below.
            let fd = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: just opened, owned by nothing else.
            Ok(Dir(unsafe { OwnedFd::from_raw_fd(fd) }))
        }

        pub fn dup(&self) -> io::Result<Dir> {
            Ok(Dir(self.0.try_clone()?))
        }

        /// The folder `name` in this one, never through a link.
        pub fn child(&self, name: &CStr) -> io::Result<Dir> {
            // SAFETY: a live directory descriptor and a NUL-terminated name.
            let fd = unsafe {
                libc::openat(self.raw(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: just opened, owned by nothing else.
            Ok(Dir(unsafe { OwnedFd::from_raw_fd(fd) }))
        }

        /// Make the folder `name` (as `mkdir` would, under the umask). An
        /// existing name is fine: [`Dir::child`] then decides.
        pub fn mkdir(&self, name: &CStr) -> io::Result<()> {
            // SAFETY: as above; `mkdirat` never follows a link at the name.
            if unsafe { libc::mkdirat(self.raw(), name.as_ptr(), 0o777) } != 0 {
                let e = io::Error::last_os_error();
                if e.kind() != io::ErrorKind::AlreadyExists {
                    return Err(e);
                }
            }
            Ok(())
        }

        /// The file type bits (`S_IFMT`) at `name`, not following a link;
        /// `None` when nothing is there.
        pub fn kind(&self, name: &CStr) -> io::Result<Option<libc::mode_t>> {
            let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: a live directory descriptor, a NUL-terminated name, room for the answer.
            if unsafe { libc::fstatat(self.raw(), name.as_ptr(), st.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
                let e = io::Error::last_os_error();
                return if e.kind() == io::ErrorKind::NotFound { Ok(None) } else { Err(e) };
            }
            // SAFETY: `fstatat` succeeded and filled it.
            Ok(Some(unsafe { st.assume_init() }.st_mode & libc::S_IFMT))
        }

        /// Remove the name (a file or a link itself; `folder`: an empty folder).
        pub fn unlink(&self, name: &CStr, folder: bool) -> io::Result<()> {
            let flags = if folder { libc::AT_REMOVEDIR } else { 0 };
            // SAFETY: a live directory descriptor and a NUL-terminated name.
            if unsafe { libc::unlinkat(self.raw(), name.as_ptr(), flags) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Rename `from` over `to`, both in this folder (an entry at `to` is
        /// replaced, a link there never followed).
        pub fn rename(&self, from: &CStr, to: &CStr) -> io::Result<()> {
            // SAFETY: a live directory descriptor and NUL-terminated names.
            if unsafe { libc::renameat(self.raw(), from.as_ptr(), self.raw(), to.as_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// A new file `name` (exclusive, never through a link) with `mode`
        /// less the umask.
        pub fn create(&self, name: &CStr, mode: u32) -> io::Result<std::fs::File> {
            let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            // SAFETY: a live directory descriptor and a NUL-terminated name.
            let fd = unsafe { libc::openat(self.raw(), name.as_ptr(), flags, mode as libc::c_uint) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: just opened, owned by nothing else.
            Ok(unsafe { std::fs::File::from_raw_fd(fd) })
        }

        /// A new symbolic link `name` to `target`.
        pub fn symlink(&self, target: &CStr, name: &CStr) -> io::Result<()> {
            // SAFETY: NUL-terminated strings and a live directory descriptor.
            if unsafe { libc::symlinkat(target.as_ptr(), self.raw(), name.as_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }
}

#[cfg(unix)]
fn is_dir(kind: libc::mode_t) -> bool {
    kind == libc::S_IFDIR
}

#[cfg(unix)]
impl Target {
    /// `folder` (canonical), opened by a walk from `/` that follows no link.
    pub fn open(folder: &Path) -> Result<Self, String> {
        use std::os::unix::ffi::OsStrExt;
        use std::path::Component;
        let moved = || format!("{}: not the folder it was any more (a link on its path)", folder.display());
        let mut dir = unix::Dir::root().map_err(|e| format!("{}: {e}", folder.display()))?;
        let mut parts = folder.components();
        if parts.next() != Some(Component::RootDir) {
            return Err(moved());
        }
        for part in parts {
            let Component::Normal(name) = part else { return Err(moved()) };
            let name = unix::c_name(name.as_bytes()).map_err(|_| moved())?;
            dir = match dir.child(&name) {
                Ok(child) => child,
                Err(e) if dir.kind(&name).ok().flatten().is_some_and(|k| !is_dir(k)) => return Err(format!("{}: {e}", moved())),
                Err(e) => return Err(format!("{}: {e}", folder.display())),
            };
        }
        Ok(Self { dir })
    }

    /// The folder `rel`'s leaf is in, reached through handles, and the leaf's
    /// name. `create`: missing folders are made. `Ok(None)`: a leading folder
    /// is missing and `create` is off.
    fn parent(&self, rel: &[u8], create: bool) -> Result<Option<(unix::Dir, std::ffi::CString)>, String> {
        let parts: Vec<&[u8]> = rel.split(|b| *b == b'/').collect();
        let Some((leaf, lead)) = parts.split_last() else { return Err("not a path inside the folder".into()) };
        let mut dir = self.dir.dup().map_err(|e| e.to_string())?;
        for part in lead {
            let name = unix::c_name(part).map_err(|_| "not a path inside the folder".to_string())?;
            let mut made = false;
            dir = loop {
                match dir.child(&name) {
                    Ok(child) => break child,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound && !made => {
                        made = true;
                        dir.mkdir(&name).map_err(|e| format!("{}: {e}", shown(part)))?;
                    }
                    Err(e) => {
                        return Err(match dir.kind(&name) {
                            Ok(Some(libc::S_IFLNK)) => format!("{} is a link", shown(part)),
                            Ok(Some(kind)) if !is_dir(kind) => format!("{} is not a folder", shown(part)),
                            _ => format!("{}: {e}", shown(part)),
                        })
                    }
                }
            };
        }
        let leaf = unix::c_name(leaf).map_err(|_| "not a path inside the folder".to_string())?;
        Ok(Some((dir, leaf)))
    }

    /// Take the file or link at `rel` away. Nothing there (or no folder for
    /// it) counts as done.
    pub fn remove(&self, rel: &[u8]) -> Result<(), String> {
        let Some((dir, leaf)) = self.parent(rel, false)? else { return Ok(()) };
        match dir.kind(&leaf).map_err(|e| e.to_string())? {
            None => Ok(()),
            Some(kind) if is_dir(kind) => Err("is now a folder".into()),
            Some(_) => match dir.unlink(&leaf, false) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            },
        }
    }

    /// Remove an empty folder at `rel` (a file the checkpoint had where a
    /// folder is now, whose added files were just taken away).
    pub fn clear_folder(&self, rel: &[u8]) {
        if let Ok(Some((dir, leaf))) = self.parent(rel, false) {
            if dir.kind(&leaf).ok().flatten().is_some_and(is_dir) {
                let _ = dir.unlink(&leaf, true);
            }
        }
    }

    /// Put `entry` at `rel`. `only_if_absent`: refused ([`NO_UNDO`]) when
    /// something other than a folder is there now (the undo snapshot holds
    /// no copy of it).
    pub fn install(&self, rel: &[u8], entry: &Entry, only_if_absent: bool) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::ffi::OsStrExt;
        let (dir, leaf) = self.parent(rel, true)?.ok_or("not a path inside the folder")?;
        match dir.kind(&leaf).map_err(|e| e.to_string())? {
            Some(kind) if is_dir(kind) => return Err("is now a folder".into()),
            Some(_) if only_if_absent => return Err(NO_UNDO.into()),
            _ => {}
        }
        let mut tries = 0;
        let temp = loop {
            tries += 1;
            let temp = unix::c_name(temp_name().as_bytes()).map_err(|e| e.to_string())?;
            let made = match entry {
                Entry::File { from, exec } => {
                    // The staging folder is under the state dir: no agent reaches it.
                    let mut source = std::fs::File::open(from).map_err(|e| e.to_string())?;
                    dir.create(&temp, if *exec { 0o777 } else { 0o666 }).and_then(|mut file| {
                        let copied = std::io::copy(&mut source, &mut file).and_then(|_| file.flush());
                        if copied.is_err() {
                            let _ = dir.unlink(&temp, false);
                        }
                        copied
                    })
                }
                Entry::Link { target } => unix::c_name(target.as_os_str().as_bytes()).and_then(|to| dir.symlink(&to, &temp)),
            };
            match made {
                Ok(_) => break temp,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && tries < 16 => continue,
                Err(e) => return Err(e.to_string()),
            }
        };
        dir.rename(&temp, &leaf).map_err(|e| {
            let _ = dir.unlink(&temp, false);
            e.to_string()
        })
    }
}

#[cfg(not(unix))]
impl Target {
    pub fn open(folder: &Path) -> Result<Self, String> {
        match std::fs::symlink_metadata(folder) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(Self { folder: folder.to_path_buf() }),
            Ok(_) => Err(format!("{}: not the folder it was any more", folder.display())),
            Err(e) => Err(format!("{}: {e}", folder.display())),
        }
    }

    /// `rel` under the folder, after [`plain_path`] (checked again at each use).
    fn checked(&self, rel: &[u8]) -> Result<PathBuf, String> {
        plain_path(&self.folder, rel)?;
        Ok(self.folder.join(rel_path(rel)))
    }

    pub fn remove(&self, rel: &[u8]) -> Result<(), String> {
        let target = self.checked(rel)?;
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Err("is now a folder".into()),
            Ok(meta) => match std::fs::remove_file(&target) {
                Err(_) if meta.file_type().is_symlink() => std::fs::remove_dir(&target).map_err(|e| e.to_string()),
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn clear_folder(&self, rel: &[u8]) {
        if let Ok(target) = self.checked(rel) {
            if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
                let _ = std::fs::remove_dir(&target);
            }
        }
    }

    pub fn install(&self, rel: &[u8], entry: &Entry, only_if_absent: bool) -> Result<(), String> {
        let target = self.checked(rel)?;
        let parent = target.parent().ok_or("not a path inside the folder")?.to_path_buf();
        std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        // Again, immediately before the write: the folders found or just made
        // are plain folders.
        self.checked(rel)?;
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => return Err("is now a folder".into()),
            Ok(_) if only_if_absent => return Err(NO_UNDO.into()),
            _ => {}
        }
        match entry {
            Entry::File { from, exec: _ } => {
                let mut source = std::fs::File::open(from).map_err(|e| e.to_string())?;
                let mut temp = tempfile::NamedTempFile::new_in(&parent).map_err(|e| e.to_string())?;
                std::io::copy(&mut source, &mut temp).map_err(|e| e.to_string())?;
                let temp = temp.into_temp_path();
                std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
                let _ = temp.keep();
                Ok(())
            }
            Entry::Link { target: to } => {
                let temp = parent.join(temp_name());
                #[cfg(windows)]
                std::os::windows::fs::symlink_file(to, &temp).map_err(|e| e.to_string())?;
                #[cfg(not(windows))]
                let _ = to;
                std::fs::rename(&temp, &target).map_err(|e| {
                    let _ = std::fs::remove_file(&temp);
                    e.to_string()
                })
            }
        }
    }
}
