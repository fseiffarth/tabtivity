//! Directory-handle-relative I/O inside an agent-writable home.
//!
//! Tabtivity prepares every agent home **unfenced** — laying in the Tabtivity-wide
//! layer, registering its hooks, reconciling logins, scrubbing leftovers —
//! while a fenced agent of that scope may be rewriting the same tree. A path
//! checked and then used is a race: between `lstat(~/.claude)` and
//! `rename(tmp, ~/.claude/settings.json)` the agent can swap `.claude` for a
//! link to the user's real home, and Tabtivity's write lands there. Exclusive
//! temporaries and a `O_NOFOLLOW` on the final component do not close that
//! window; only doing every operation relative to a directory handle does.
//!
//! [`HomeDir`] is such a handle: opened once by an `openat(O_DIRECTORY |
//! O_NOFOLLOW)` walk from the home, so a link at any component is refused
//! and there is no path left to swap afterwards — whatever the agent renames
//! later moves the handle's directory with it, and the write stays inside
//! the home. [`HomeFile`] is one name in such a directory; its reads, writes
//! (exclusive temporary, `renameat` into place), removals and mode changes
//! all go through the handle. The home itself sits under the state dir,
//! which no agent can write, so opening it by name is safe.
//!
//! The same handles serve a project's git dir, which a fenced agent can
//! write too: `services::git_guard` reads and writes `info/exclude` through
//! them, with the git dir as the root (#2347).
//!
//! Windows has no fence, so its agents run with the user's full rights
//! anyway; that build keeps the path-based checks behind the same API.
//! AppHandle-free and unit-testable.

use std::ffi::OsString;
#[cfg(unix)]
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

/// What `lstat` says about a name, without following a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Meta {
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub len: u64,
    /// Permission bits (`0o7777`); on Windows `0o444` for read-only, else `0o666`.
    pub mode: u32,
    /// `(device, inode)` where the platform exposes them.
    pub ino: Option<(u64, u64)>,
}

/// Split a home-relative path into components, refusing anything that could
/// leave the home lexically.
fn components(rel: &str) -> Option<Vec<&str>> {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|p| *p == "." || *p == "..") {
        return None;
    }
    Some(parts)
}

#[cfg(unix)]
fn cstr(name: &OsStr) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// A directory inside an agent home, held open.
#[derive(Debug)]
pub struct HomeDir {
    #[cfg(unix)]
    fd: OwnedFd,
    path: PathBuf,
}

impl HomeDir {
    /// Open `home/rel` (or `home` itself for an empty `rel`), creating missing
    /// directories private to the user. `None` for a link or a non-directory
    /// at any component.
    pub fn open(home: &Path, rel: &str) -> Option<Self> {
        Self::open_in(home, rel, true)
    }

    /// [`HomeDir::open`] without creating anything: `None` when missing.
    pub fn open_existing(home: &Path, rel: &str) -> Option<Self> {
        Self::open_in(home, rel, false)
    }

    fn open_in(home: &Path, rel: &str, create: bool) -> Option<Self> {
        let parts = if rel.is_empty() { Vec::new() } else { components(rel)? };
        if create {
            crate::services::agent_home::create_private_dir(home).ok()?;
        }
        let mut dir = Self::open_root(home).ok()?;
        for part in parts {
            dir = dir.subdir_in(part, create).ok()?;
        }
        Some(dir)
    }

    #[cfg(unix)]
    fn open_root(path: &Path) -> io::Result<Self> {
        // The home's own path is Tabtivity's (under the state dir); a link in the
        // middle of *that* path — a symlinked temp dir on macOS, say — is the
        // user's own doing, so the root itself is opened by name.
        let c = cstr(path.as_os_str())?;
        // SAFETY: a valid C string; the descriptor is owned below.
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(HomeDir { fd: unsafe { OwnedFd::from_raw_fd(fd) }, path: path.to_path_buf() })
    }

    #[cfg(not(unix))]
    fn open_root(path: &Path) -> io::Result<Self> {
        if !std::fs::metadata(path)?.is_dir() {
            return Err(io::Error::from(io::ErrorKind::NotADirectory));
        }
        Ok(HomeDir { path: path.to_path_buf() })
    }

    /// The child directory `name`, opened without following a link, created
    /// (`0700`) when `create` and missing.
    #[cfg(unix)]
    fn subdir_in(&self, name: &str, create: bool) -> io::Result<Self> {
        let c = cstr(OsStr::new(name))?;
        let mut may_create = create;
        loop {
            // SAFETY: valid C string and descriptor.
            let fd = unsafe {
                libc::openat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd >= 0 {
                return Ok(HomeDir { fd: unsafe { OwnedFd::from_raw_fd(fd) }, path: self.path.join(name) });
            }
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::NotFound && may_create {
                may_create = false;
                // SAFETY: as above.
                if unsafe { libc::mkdirat(self.fd.as_raw_fd(), c.as_ptr(), 0o700) } != 0 {
                    let e = io::Error::last_os_error();
                    if e.kind() != io::ErrorKind::AlreadyExists {
                        return Err(e);
                    }
                }
                continue;
            }
            return Err(err);
        }
    }

    #[cfg(not(unix))]
    fn subdir_in(&self, name: &str, create: bool) -> io::Result<Self> {
        let path = self.path.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                Err(io::Error::from(io::ErrorKind::NotADirectory))
            }
            Ok(_) => Ok(HomeDir { path }),
            Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                crate::services::agent_home::create_private_dir(&path)?;
                Ok(HomeDir { path })
            }
            Err(e) => Err(e),
        }
    }

    /// Where the handle was opened; for messages and mount points, never for
    /// I/O.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Open the child directory `name`, creating it when missing.
    pub fn subdir(&self, name: &str) -> Option<Self> {
        components(name).filter(|p| p.len() == 1)?;
        self.subdir_in(name, true).ok()
    }

    /// One name in this directory (a single component).
    pub fn file(&self, name: &str) -> Option<HomeFile> {
        components(name).filter(|p| p.len() == 1)?;
        Some(HomeFile { dir: self.try_clone().ok()?, name: OsString::from(name) })
    }

    #[cfg(unix)]
    fn try_clone(&self) -> io::Result<Self> {
        Ok(HomeDir { fd: self.fd.try_clone()?, path: self.path.clone() })
    }

    #[cfg(not(unix))]
    fn try_clone(&self) -> io::Result<Self> {
        Ok(HomeDir { path: self.path.clone() })
    }

    /// The names in this directory. Listed by path — a name is only ever
    /// acted on through the handle, so a listing of the wrong directory
    /// yields names that fail there.
    pub fn names(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.path) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .collect();
        names.sort();
        names
    }

    /// Make the directory private to the user (`0700`).
    pub fn set_private(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            // SAFETY: an open descriptor.
            if unsafe { libc::fchmod(self.fd.as_raw_fd(), 0o700) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            Ok(())
        }
    }
}

/// One name inside a [`HomeDir`].
#[derive(Debug)]
pub struct HomeFile {
    dir: HomeDir,
    name: OsString,
}

#[cfg(unix)]
static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl HomeFile {
    /// `home/rel`, its directories opened by handle and created where
    /// missing. `None` when a component is a link or not a directory.
    pub fn open(home: &Path, rel: &str) -> Option<Self> {
        Self::open_in(home, rel, true)
    }

    /// [`HomeFile::open`] without creating directories: `None` when the
    /// file's directory is missing (the file itself may be).
    pub fn open_existing(home: &Path, rel: &str) -> Option<Self> {
        Self::open_in(home, rel, false)
    }

    fn open_in(home: &Path, rel: &str, create: bool) -> Option<Self> {
        let parts = components(rel)?;
        let (name, dirs) = parts.split_last()?;
        let dir = HomeDir::open_in(home, &dirs.join("/"), create)?;
        Some(HomeFile { dir, name: OsString::from(name) })
    }

    /// The directory the file is in.
    pub fn dir(&self) -> &HomeDir {
        &self.dir
    }

    /// The file's path, for messages only.
    pub fn path(&self) -> PathBuf {
        self.dir.path.join(&self.name)
    }

    #[cfg(unix)]
    fn open_at(&self, name: &OsStr, flags: libc::c_int, mode: libc::c_uint) -> io::Result<std::fs::File> {
        let c = cstr(name)?;
        // SAFETY: valid C string and descriptor; the fd is owned by the File.
        let fd = unsafe { libc::openat(self.dir.fd.as_raw_fd(), c.as_ptr(), flags | libc::O_CLOEXEC, mode) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    /// `lstat` of the name, never following a link.
    pub fn metadata(&self) -> Option<Meta> {
        #[cfg(unix)]
        {
            let c = cstr(&self.name).ok()?;
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: valid C string, descriptor and out-pointer.
            let r = unsafe { libc::fstatat(self.dir.fd.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
            if r != 0 {
                return None;
            }
            let kind = st.st_mode & libc::S_IFMT;
            Some(Meta {
                is_file: kind == libc::S_IFREG,
                is_dir: kind == libc::S_IFDIR,
                is_symlink: kind == libc::S_IFLNK,
                len: st.st_size as u64,
                mode: (st.st_mode & 0o7777) as u32,
                ino: Some((st.st_dev as u64, st.st_ino as u64)),
            })
        }
        #[cfg(not(unix))]
        {
            let meta = std::fs::symlink_metadata(self.path()).ok()?;
            Some(Meta {
                is_file: meta.is_file(),
                is_dir: meta.is_dir(),
                is_symlink: meta.file_type().is_symlink(),
                len: meta.len(),
                mode: if meta.permissions().readonly() { 0o444 } else { 0o666 },
                ino: None,
            })
        }
    }

    pub fn exists(&self) -> bool {
        self.metadata().is_some()
    }

    pub fn is_file(&self) -> bool {
        self.metadata().is_some_and(|m| m.is_file)
    }

    /// Open for reading: a regular file only, never through a link, and never
    /// blocking on a planted FIFO (the opened inode is checked, not an
    /// earlier `lstat`).
    pub fn open_read(&self) -> Option<std::fs::File> {
        #[cfg(unix)]
        {
            let file = self
                .open_at(&self.name, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0)
                .ok()?;
            file.metadata().ok()?.is_file().then_some(file)
        }
        #[cfg(not(unix))]
        {
            if !std::fs::symlink_metadata(self.path()).ok()?.is_file() {
                return None;
            }
            std::fs::File::open(self.path()).ok()
        }
    }

    pub fn read(&self) -> Option<Vec<u8>> {
        use std::io::Read;
        let mut file = self.open_read()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        Some(bytes)
    }

    /// The link's target, for a symlink.
    pub fn read_link(&self) -> Option<PathBuf> {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let c = cstr(&self.name).ok()?;
            let mut buf = vec![0u8; libc::PATH_MAX as usize + 1];
            // SAFETY: valid C string, descriptor and buffer of the given size.
            let n = unsafe {
                libc::readlinkat(self.dir.fd.as_raw_fd(), c.as_ptr(), buf.as_mut_ptr() as *mut libc::c_char, buf.len())
            };
            if n < 0 {
                return None;
            }
            buf.truncate(n as usize);
            Some(PathBuf::from(OsString::from_vec(buf)))
        }
        #[cfg(not(unix))]
        {
            std::fs::read_link(self.path()).ok()
        }
    }

    /// Replace the file with `bytes` (`0600`): written to an exclusively
    /// created temporary in the same directory and renamed into place, both
    /// relative to the handle, so a link at the name is replaced rather than
    /// followed and a reader never sees half a file.
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        self.write_as(bytes, 0o600, None)
    }

    /// [`HomeFile::write`] for a file another program owns (git's
    /// `info/exclude`): the result gets exactly `keep` — the replaced file's
    /// permission bits — or, for a new file (`None`), `0644` less the umask.
    pub fn write_keeping_mode(&self, bytes: &[u8], keep: Option<u32>) -> io::Result<()> {
        self.write_as(bytes, 0o644, keep)
    }

    /// The temporary is created with `create_mode` (less the umask), then
    /// set to exactly `keep` on its descriptor before it is renamed in.
    #[cfg_attr(not(unix), allow(unused_variables))]
    fn write_as(&self, bytes: &[u8], create_mode: u32, keep: Option<u32>) -> io::Result<()> {
        use std::io::Write;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let name = self.name.to_string_lossy();
            let pid = std::process::id();
            for _ in 0..32 {
                let n = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0);
                let tmp = OsString::from(format!(".{name}.{}-{pid}-{n}-{nanos:x}.tmp", crate::brand::SLUG));
                let mut file = match self.open_at(
                    &tmp,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW,
                    create_mode as libc::c_uint,
                ) {
                    Ok(file) => file,
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e),
                };
                let moded = match keep {
                    Some(mode) => file.set_permissions(std::fs::Permissions::from_mode(mode & 0o7777)),
                    None => Ok(()),
                };
                let written = moded.and_then(|()| file.write_all(bytes)).and_then(|()| file.flush());
                drop(file);
                let result = written.and_then(|()| self.rename_in_dir(&tmp, &self.name));
                if result.is_err() {
                    let _ = self.unlink_in_dir(&tmp);
                }
                return result;
            }
            Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free temporary name"))
        }
        #[cfg(not(unix))]
        {
            let mut tmp = tempfile::NamedTempFile::new_in(&self.dir.path)?;
            tmp.write_all(bytes)?;
            tmp.persist(self.path()).map_err(|e| e.error)?;
            Ok(())
        }
    }

    #[cfg(unix)]
    fn rename_in_dir(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
        let (from, to) = (cstr(from)?, cstr(to)?);
        // SAFETY: valid C strings and descriptor.
        if unsafe { libc::renameat(self.dir.fd.as_raw_fd(), from.as_ptr(), self.dir.fd.as_raw_fd(), to.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(unix)]
    fn unlink_in_dir(&self, name: &OsStr) -> io::Result<()> {
        let c = cstr(name)?;
        // SAFETY: valid C string and descriptor.
        if unsafe { libc::unlinkat(self.dir.fd.as_raw_fd(), c.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Remove the name (a file or a link; never what a link points at).
    pub fn remove(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            self.unlink_in_dir(&self.name)
        }
        #[cfg(not(unix))]
        {
            std::fs::remove_file(self.path())
        }
    }

    /// Give a regular file at the name the exec bits `want` (`0o111` masked),
    /// keeping the rest of its mode. A link there is left alone.
    pub fn set_exec_bits(&self, want: u32) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = self.open_at(&self.name, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0)?;
            let meta = file.metadata()?;
            if !meta.is_file() {
                return Ok(());
            }
            let mode = meta.permissions().mode();
            let next = (mode & !0o111) | (want & 0o111);
            if next != mode {
                file.set_permissions(std::fs::Permissions::from_mode(next))?;
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = want;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_directory_chain_is_created_private_and_a_write_lands_in_it() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let file = HomeFile::open(&home, ".claude/skills/a/SKILL.md").unwrap();
        assert!(!file.exists());
        file.write(b"skill").unwrap();
        assert_eq!(std::fs::read(home.join(".claude/skills/a/SKILL.md")).unwrap(), b"skill");
        assert_eq!(file.read().unwrap(), b"skill");
        assert!(file.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(home.join(".claude")).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(file.metadata().unwrap().mode & 0o777, 0o600);
        }
        assert!(HomeFile::open_existing(&home, ".codex/config.toml").is_none());
        assert!(HomeFile::open(&home, "../escape").is_none());
        assert!(HomeFile::open(&home, ".claude/./x").is_none());
        file.remove().unwrap();
        assert!(!file.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_component_or_name_is_refused_or_replaced_never_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".claude")).unwrap();
        assert!(HomeFile::open(&home, ".claude/settings.json").is_none());
        assert!(HomeDir::open(&home, ".claude").is_none());

        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let victim = outside.join("victim");
        std::fs::write(&victim, "keep").unwrap();
        std::os::unix::fs::symlink(&victim, home.join(".codex/auth.json")).unwrap();
        let file = HomeFile::open(&home, ".codex/auth.json").unwrap();
        assert!(file.exists() && !file.is_file());
        assert_eq!(file.read(), None);
        assert_eq!(file.read_link().unwrap(), victim);
        file.write(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert!(file.is_file());
        assert_eq!(file.read().unwrap(), b"new");
        // A FIFO at the name neither blocks nor reads.
        let fifo = std::ffi::CString::new(home.join(".codex/fifo").to_string_lossy().into_owned()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let fifo = HomeFile::open(&home, ".codex/fifo").unwrap();
        assert_eq!(fifo.read(), None);
        assert!(!fifo.is_file());
    }

    /// The race the handle closes: after the directory was opened, the agent
    /// swaps it for a link to somewhere else. The write still lands in the
    /// directory the handle holds (now under its new name), never at the
    /// link's target.
    #[cfg(unix)]
    #[test]
    fn a_directory_swapped_after_the_open_does_not_redirect_the_write() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("settings.json"), "host").unwrap();
        let file = HomeFile::open(&home, ".claude/settings.json").unwrap();
        // The agent's move: rename the directory away, plant a link.
        std::fs::rename(home.join(".claude"), home.join(".claude.moved")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".claude")).unwrap();

        file.write(crate::app_slug!().as_bytes()).unwrap();
        file.set_exec_bits(0o111).unwrap();

        assert_eq!(std::fs::read_to_string(outside.join("settings.json")).unwrap(), "host");
        assert_eq!(std::fs::read_to_string(home.join(".claude.moved/settings.json")).unwrap(), crate::app_slug!());
        assert_eq!(file.read().unwrap(), crate::app_slug!().as_bytes());
        file.remove().unwrap();
        assert!(outside.join("settings.json").exists());
        assert!(!home.join(".claude.moved/settings.json").exists());
    }

    #[test]
    fn names_are_listed_and_acted_on_through_the_handle() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/b"), "").unwrap();
        std::fs::write(home.join(".codex/a"), "x").unwrap();
        let dir = HomeDir::open_existing(&home, ".codex").unwrap();
        assert_eq!(dir.names(), ["a", "b"]);
        let a = dir.file("a").unwrap();
        assert_eq!(a.metadata().unwrap().len, 1);
        assert!(dir.file("a/b").is_none());
        assert!(dir.file("..").is_none());
        let sub = dir.subdir("nested").unwrap();
        assert!(home.join(".codex/nested").is_dir());
        sub.file("c").unwrap().write(b"c").unwrap();
        assert_eq!(std::fs::read(home.join(".codex/nested/c")).unwrap(), b"c");
        dir.set_private().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn exec_bits_are_set_on_a_file_and_never_through_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let file = HomeFile::open(&home, ".claude/hook.sh").unwrap();
        file.write(b"#!/bin/sh\n").unwrap();
        file.set_exec_bits(0o111).unwrap();
        assert_eq!(std::fs::metadata(file.path()).unwrap().permissions().mode() & 0o777, 0o711);
        file.set_exec_bits(0).unwrap();
        assert_eq!(std::fs::metadata(file.path()).unwrap().permissions().mode() & 0o777, 0o600);
        let victim = tmp.path().join("victim");
        std::fs::write(&victim, "").unwrap();
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&victim, home.join(".claude/link")).unwrap();
        let link = HomeFile::open(&home, ".claude/link").unwrap();
        assert!(link.set_exec_bits(0o111).is_err());
        assert_eq!(std::fs::metadata(&victim).unwrap().permissions().mode() & 0o777, 0o644);
    }
}
