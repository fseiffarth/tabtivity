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

    /// Replace the file's content **keeping its inode**, for a file that is
    /// bind-mounted read-only into running fences and pinned by inode for a
    /// spawn that is starting (`agent_fence::verify_control_pins`): a rename
    /// over it would detach those mounts and refuse that spawn. The existing
    /// name is opened `O_WRONLY | O_NOFOLLOW | O_NONBLOCK` relative to the
    /// handle and written only when the opened inode is a regular file with
    /// one link (a hard link planted there is never written through); then
    /// the bytes go in at offset 0 and the length is cut to them. A missing
    /// name is created `O_EXCL` (`0600`), so two writers racing to create it
    /// end up writing the same inode. A link, FIFO, socket or hard-linked file
    /// at the name falls back to [`HomeFile::write`], which replaces it.
    pub fn write_in_place(&self, bytes: &[u8]) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::io::{Seek, Write};
            let flags = libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK;
            for _ in 0..4 {
                let file = match self.open_at(&self.name, flags, 0) {
                    Ok(file) => file,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {
                        match self.open_at(&self.name, flags | libc::O_CREAT | libc::O_EXCL, 0o600) {
                            Ok(file) => file,
                            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                            Err(e) => return Err(e),
                        }
                    }
                    // `ELOOP` for a link, `ENXIO` for a FIFO with no reader,
                    // `EISDIR`, … — not a plain file to keep.
                    Err(_) => return self.write(bytes),
                };
                let meta = file.metadata()?;
                {
                    use std::os::unix::fs::MetadataExt;
                    if !meta.is_file() || meta.nlink() != 1 {
                        drop(file);
                        return self.write(bytes);
                    }
                }
                let mut file = file;
                file.seek(io::SeekFrom::Start(0))?;
                file.write_all(bytes)?;
                file.set_len(bytes.len() as u64)?;
                return file.flush();
            }
            Err(io::Error::new(io::ErrorKind::AlreadyExists, "the file kept appearing and vanishing"))
        }
        #[cfg(not(unix))]
        {
            self.write(bytes)
        }
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

    /// Move the name aside within its directory to `<name><suffix>`, or
    /// `<name><suffix>.1`, `.2`, … when that is taken; returns the new name.
    /// Relative to the handle, so a link at the name is moved, never
    /// followed, and an existing name is never replaced (`RENAME_NOREPLACE`
    /// on Linux, `RENAME_EXCL` on macOS; on a filesystem without either, a
    /// hard link then an unlink, see [`HomeFile::link_aside`]; on Windows,
    /// which has no fence, a check just before the rename).
    pub fn rename_aside(&self, suffix: &str) -> io::Result<String> {
        let name = self.name.to_string_lossy().into_owned();
        for n in 0..1000u32 {
            let to = if n == 0 { format!("{name}{suffix}") } else { format!("{name}{suffix}.{n}") };
            if components(&to).is_none_or(|p| p.len() != 1 || p[0] != to) {
                return Err(io::Error::from(io::ErrorKind::InvalidInput));
            }
            match self.rename_noreplace(std::ffi::OsStr::new(&to)) {
                Ok(()) => return Ok(to),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free name to move the file aside to"))
    }

    #[cfg(unix)]
    fn rename_noreplace(&self, to: &OsStr) -> io::Result<()> {
        let (from_c, to_c) = (cstr(&self.name)?, cstr(to)?);
        #[cfg(any(all(target_os = "linux", target_env = "gnu"), target_os = "macos"))]
        let fd = self.dir.fd.as_raw_fd();
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        {
            // SAFETY: valid C strings and descriptor.
            if unsafe { libc::renameat2(fd, from_c.as_ptr(), fd, to_c.as_ptr(), libc::RENAME_NOREPLACE) } == 0 {
                return Ok(());
            }
            let e = io::Error::last_os_error();
            if !matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOSYS)) {
                return Err(e);
            }
        }
        #[cfg(target_os = "macos")]
        {
            // SAFETY: valid C strings and descriptor.
            if unsafe { libc::renameatx_np(fd, from_c.as_ptr(), fd, to_c.as_ptr(), libc::RENAME_EXCL) } == 0 {
                return Ok(());
            }
            let e = io::Error::last_os_error();
            if !matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOTSUP)) {
                return Err(e);
            }
        }
        self.link_aside(&from_c, &to_c)
    }

    /// The no-replace move on a filesystem without an atomic flag for it
    /// (NFS answers `RENAME_NOREPLACE` with `EINVAL`): hard-link `from` to
    /// `to`, which fails on an existing name, then drop `from` if it is still
    /// the same file. Never a replacing rename: a filesystem without hard
    /// links refuses the move, and the caller keeps what it has. If `from`
    /// was replaced in between, the newcomer stays where it is and the file
    /// that was there is the one at `to`.
    #[cfg(unix)]
    fn link_aside(&self, from: &std::ffi::CStr, to: &std::ffi::CStr) -> io::Result<()> {
        let fd = self.dir.fd.as_raw_fd();
        // SAFETY: valid C strings and descriptor; flags 0 links a symlink
        // itself, never what it points at.
        if unsafe { libc::linkat(fd, from.as_ptr(), fd, to.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let id = |name: &std::ffi::CStr| {
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: valid C string, descriptor and out-pointer.
            let r = unsafe { libc::fstatat(fd, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
            (r == 0).then_some((st.st_dev, st.st_ino))
        };
        if id(from).is_none_or(|a| Some(a) != id(to)) {
            return Ok(());
        }
        // SAFETY: valid C string and descriptor.
        if unsafe { libc::unlinkat(fd, from.as_ptr(), 0) } != 0 {
            let e = io::Error::last_os_error();
            // Not left under two names: drop the link just made.
            // SAFETY: valid C string and descriptor.
            unsafe { libc::unlinkat(fd, to.as_ptr(), 0) };
            return Err(e);
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn rename_noreplace(&self, to: &std::ffi::OsStr) -> io::Result<()> {
        let target = self.dir.path.join(to);
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(self.path(), target)
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

    /// Make the name a folder (`dir`) or a regular file, created empty where
    /// missing. A link or any other special file there (a FIFO, a socket) is
    /// removed first — never what a link points at; a regular file or folder
    /// already there is kept, whichever was asked for. The [`Meta`] returned
    /// is read off a handle opened without following a link, so its `ino` is
    /// the inode now at the name: a caller that later uses the *path* can
    /// re-`lstat` it and compare (`agent_fence::verify_control_pins`).
    pub fn ensure(&self, dir: bool) -> io::Result<Meta> {
        #[cfg(unix)]
        {
            if self.metadata().is_some_and(|m| !(m.is_file || m.is_dir)) {
                if let Err(e) = self.unlink_in_dir(&self.name) {
                    if e.kind() != io::ErrorKind::NotFound {
                        return Err(e);
                    }
                }
            }
            if !self.exists() {
                if dir {
                    let c = cstr(&self.name)?;
                    // SAFETY: valid C string and descriptor.
                    if unsafe { libc::mkdirat(self.dir.fd.as_raw_fd(), c.as_ptr(), 0o700) } != 0 {
                        let e = io::Error::last_os_error();
                        if e.kind() != io::ErrorKind::AlreadyExists {
                            return Err(e);
                        }
                    }
                } else {
                    // No `O_TRUNC`: a file that appeared meanwhile is kept; a
                    // link that did fails `ELOOP`, a FIFO `ENXIO`.
                    self.open_at(&self.name, libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0o600)?;
                }
            }
            let held = self.open_at(&self.name, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0)?;
            let meta = meta_of(&held.metadata()?);
            if !(meta.is_file || meta.is_dir) {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "neither a regular file nor a folder"));
            }
            Ok(meta)
        }
        #[cfg(not(unix))]
        {
            let path = self.path();
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !(m.is_file() || m.is_dir())) {
                let _ = std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path));
            }
            if std::fs::symlink_metadata(&path).is_err() {
                if dir {
                    if let Err(e) = std::fs::create_dir(&path) {
                        if e.kind() != io::ErrorKind::AlreadyExists {
                            return Err(e);
                        }
                    }
                } else {
                    std::fs::OpenOptions::new().append(true).create(true).open(&path)?;
                }
            }
            match self.metadata() {
                Some(meta) if !meta.is_symlink && (meta.is_file || meta.is_dir) => Ok(meta),
                Some(_) => Err(io::Error::new(io::ErrorKind::InvalidInput, "neither a regular file nor a folder")),
                None => Err(io::Error::from(io::ErrorKind::NotFound)),
            }
        }
    }
}

/// [`Meta`] of an open handle's `fstat`.
#[cfg(unix)]
fn meta_of(m: &std::fs::Metadata) -> Meta {
    use std::os::unix::fs::MetadataExt;
    Meta {
        is_file: m.file_type().is_file(),
        is_dir: m.file_type().is_dir(),
        is_symlink: m.file_type().is_symlink(),
        len: m.len(),
        mode: m.mode() & 0o7777,
        ino: Some((m.dev(), m.ino())),
    }
}

// ---------------------------------------------------------------------------
// Agent-written records, read by path (threat model gap 29)
// ---------------------------------------------------------------------------
//
// The live-session slice a fenced agent's hook writes (`<uid>`, `.turn`,
// `.src`, `.mode`, `.prev`), a project's `.git/commondir` and `.git` pointer,
// a CLI's session metadata and its transcripts are all files an agent can
// replace with a FIFO, a link or something huge. A plain `read_to_string`
// blocks forever on the FIFO — on the turn watcher's one thread, that stops
// turn state for every tab — so these reads go through here.

/// The most an agent-written record is read: a session id, a turn word, a
/// `.git` pointer, a CLI's `meta.json` are all far below it.
pub const RECORD_CAP: u64 = 64 * 1024;

/// Open `path` for reading the way the host must open a file an agent can
/// write: never through a link at its last component, never blocking on a
/// planted FIFO (`O_NONBLOCK`), and only when the *opened* inode is a regular
/// file. The folders above it are the caller's to vouch for. Windows has no
/// FIFOs to plant and no fence; it keeps the `lstat` check.
pub fn open_regular(path: &Path) -> Option<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        file.metadata().ok()?.is_file().then_some(file)
    }
    #[cfg(not(unix))]
    {
        if !std::fs::symlink_metadata(path).ok()?.is_file() {
            return None;
        }
        std::fs::File::open(path).ok()
    }
}

/// An agent-written record at `path`, whole, as text: [`open_regular`]'s
/// checks, and `None` past [`RECORD_CAP`] bytes or for non-UTF-8.
pub fn read_record(path: &Path) -> Option<String> {
    read_record_capped(path, RECORD_CAP)
}

/// [`read_record`] with a caller's own cap, for an agent-written file that is
/// legitimately bigger than a record (Vibe's `meta.json` embeds the system
/// prompt and every tool schema).
pub fn read_record_capped(path: &Path, cap: u64) -> Option<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    open_regular(path)?.take(cap + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > cap {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Run `f` on its own thread and fail the test if it has not returned within
/// a few seconds — a reader that blocks on a FIFO fails instead of hanging the
/// suite (the stuck thread is left behind).
#[cfg(all(test, unix))]
pub(crate) fn within_deadline<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .expect("the read blocked: it must never wait on a FIFO")
}

/// Plant a FIFO at `path`.
#[cfg(all(test, unix))]
pub(crate) fn mkfifo(path: &Path) {
    let c = std::ffi::CString::new(path.to_string_lossy().into_owned()).unwrap();
    // SAFETY: a valid C string.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
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

    #[test]
    fn a_record_reads_whole_up_to_the_cap_and_not_past_it() {
        let tmp = tempfile::tempdir().unwrap();
        let rec = tmp.path().join("rec");
        std::fs::write(&rec, "abc\n").unwrap();
        assert_eq!(read_record(&rec).as_deref(), Some("abc\n"));
        assert!(open_regular(&rec).is_some());
        std::fs::write(&rec, vec![b'a'; RECORD_CAP as usize]).unwrap();
        assert_eq!(read_record(&rec).map(|s| s.len()), Some(RECORD_CAP as usize));
        std::fs::write(&rec, vec![b'a'; RECORD_CAP as usize + 1]).unwrap();
        assert_eq!(read_record(&rec), None, "an oversized record is refused");
        assert_eq!(read_record_capped(&rec, 4), None);
        assert_eq!(read_record(&tmp.path().join("missing")), None);
        assert_eq!(read_record(tmp.path()), None, "a folder is not a record");
        assert!(open_regular(tmp.path()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_record_is_never_read_through_a_link_or_from_a_fifo() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("victim");
        std::fs::write(&victim, "secret").unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        assert_eq!(read_record(&link), None);
        assert!(open_regular(&link).is_none());
        let fifo = tmp.path().join("fifo");
        mkfifo(&fifo);
        assert_eq!(within_deadline(move || read_record(&fifo)), None);
        let fifo = tmp.path().join("fifo");
        assert!(within_deadline(move || open_regular(&fifo).is_none()));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_replaces_a_link_or_fifo_and_keeps_what_is_real() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let dir = HomeDir::open_existing(&home, "").unwrap();
        // Missing: created, as asked.
        let made = dir.file("config.toml").unwrap().ensure(false).unwrap();
        assert!(made.is_file && made.len == 0);
        assert!(dir.file("tools").unwrap().ensure(true).unwrap().is_dir);
        // A link is replaced, its target untouched.
        std::fs::write(outside.join("x"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.join("x"), home.join(".env")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("skills")).unwrap();
        assert!(dir.file(".env").unwrap().ensure(false).unwrap().is_file);
        assert!(dir.file("skills").unwrap().ensure(true).unwrap().is_dir);
        assert!(!std::fs::symlink_metadata(home.join(".env")).unwrap().file_type().is_symlink());
        assert!(!std::fs::symlink_metadata(home.join("skills")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(outside.join("x")).unwrap(), "keep");
        // A FIFO is replaced without blocking.
        mkfifo(&home.join("hooks.toml"));
        let fifo_home = home.clone();
        let meta = within_deadline(move || {
            HomeDir::open_existing(&fifo_home, "").unwrap().file("hooks.toml").unwrap().ensure(false).unwrap()
        });
        assert!(meta.is_file);
        // An existing file keeps its contents, and the identity is its inode.
        std::fs::write(home.join("AGENTS.md"), "mine").unwrap();
        let meta = dir.file("AGENTS.md").unwrap().ensure(false).unwrap();
        assert_eq!(std::fs::read_to_string(home.join("AGENTS.md")).unwrap(), "mine");
        use std::os::unix::fs::MetadataExt;
        let st = std::fs::symlink_metadata(home.join("AGENTS.md")).unwrap();
        assert_eq!(meta.ino, Some((st.dev(), st.ino())));
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

    /// `write_in_place` keeps the inode of a plain file (shorter and longer
    /// content alike), creates a missing one, and never writes through a
    /// link, a hard link or a FIFO: those are replaced.
    #[cfg(unix)]
    #[test]
    fn an_in_place_write_keeps_the_inode_and_replaces_what_is_not_plain() {
        use std::os::unix::fs::MetadataExt;
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let ino = |name: &str| std::fs::symlink_metadata(home.join(name)).unwrap().ino();
        let file = HomeFile::open(&home, "hooks.toml").unwrap();
        file.write_in_place(b"a long first version\n").unwrap();
        let first = ino("hooks.toml");
        file.write_in_place(b"short\n").unwrap();
        assert_eq!(std::fs::read(home.join("hooks.toml")).unwrap(), b"short\n");
        file.write_in_place(b"a longer second version\n").unwrap();
        assert_eq!(std::fs::read(home.join("hooks.toml")).unwrap(), b"a longer second version\n");
        assert_eq!(ino("hooks.toml"), first);
        assert_eq!(file.metadata().unwrap().mode & 0o777, 0o600);

        let victim = tmp.path().join("victim");
        std::fs::write(&victim, "keep").unwrap();
        let linked = HomeFile::open(&home, "linked").unwrap();
        std::os::unix::fs::symlink(&victim, home.join("linked")).unwrap();
        linked.write_in_place(b"new").unwrap();
        assert!(linked.is_file());
        std::fs::remove_file(home.join("linked")).unwrap();
        std::fs::hard_link(&victim, home.join("linked")).unwrap();
        linked.write_in_place(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(linked.read().unwrap(), b"new");

        mkfifo(&home.join("fifo"));
        let at = home.clone();
        within_deadline(move || HomeFile::open(&at, "fifo").unwrap().write_in_place(b"x").unwrap());
        assert!(std::fs::symlink_metadata(home.join("fifo")).unwrap().is_file());
    }

    /// `rename_aside` moves the name (a link as a link) to the first free
    /// `<name><suffix>[.N]`, never replacing or following anything.
    #[cfg(unix)]
    #[test]
    fn a_rename_aside_takes_a_free_name_and_never_follows_a_link() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".vibe")).unwrap();
        std::fs::write(home.join(".vibe/.env"), "mine").unwrap();
        let file = HomeFile::open_existing(&home, ".vibe/.env").unwrap();
        assert_eq!(file.rename_aside(".old").unwrap(), ".env.old");
        assert!(!home.join(".vibe/.env").exists());
        assert_eq!(std::fs::read_to_string(home.join(".vibe/.env.old")).unwrap(), "mine");

        std::fs::write(home.join(".vibe/.env"), "second").unwrap();
        assert_eq!(file.rename_aside(".old").unwrap(), ".env.old.1");
        assert_eq!(std::fs::read_to_string(home.join(".vibe/.env.old")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(home.join(".vibe/.env.old.1")).unwrap(), "second");

        let victim = tmp.path().join("victim");
        std::fs::write(&victim, "keep").unwrap();
        std::os::unix::fs::symlink(&victim, home.join(".vibe/.env")).unwrap();
        assert_eq!(file.rename_aside(".old").unwrap(), ".env.old.2");
        assert!(std::fs::symlink_metadata(home.join(".vibe/.env.old.2")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert!(!tmp.path().join("victim.old").exists());

        // Nothing at the name: an error, nothing created.
        assert!(file.rename_aside(".old").is_err());
        assert!(!home.join(".vibe/.env.old.3").exists());
    }

    /// The fallback for a filesystem without `RENAME_NOREPLACE` (NFS) is a
    /// hard link then an unlink, never a replacing rename: a taken name is
    /// refused with both files intact, a link is moved as a link.
    #[cfg(unix)]
    #[test]
    fn the_link_fallback_never_replaces_and_never_follows() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".vibe")).unwrap();
        std::fs::write(home.join(".vibe/.env"), "mine").unwrap();
        std::fs::write(home.join(".vibe/.env.old"), "older").unwrap();
        let file = HomeFile::open_existing(&home, ".vibe/.env").unwrap();
        let c = |s: &str| std::ffi::CString::new(s).unwrap();

        let err = file.link_aside(&c(".env"), &c(".env.old")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(home.join(".vibe/.env")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(home.join(".vibe/.env.old")).unwrap(), "older");

        file.link_aside(&c(".env"), &c(".env.old.1")).unwrap();
        assert!(!home.join(".vibe/.env").exists());
        assert_eq!(std::fs::read_to_string(home.join(".vibe/.env.old.1")).unwrap(), "mine");

        let victim = tmp.path().join("victim");
        std::fs::write(&victim, "keep").unwrap();
        std::os::unix::fs::symlink(&victim, home.join(".vibe/.env")).unwrap();
        file.link_aside(&c(".env"), &c(".env.old.2")).unwrap();
        assert!(std::fs::symlink_metadata(home.join(".vibe/.env")).is_err());
        assert!(std::fs::symlink_metadata(home.join(".vibe/.env.old.2")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
    }
}
