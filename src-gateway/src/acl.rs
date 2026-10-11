//! POSIX ACLs on the share hubs (hosted plan §6.2 step 2): **named-user
//! entries, never a group**. A named entry is checked on every access, so a
//! grant or revoke takes effect at once, with no daemon restart — a
//! supplementary group would be fixed at login and survive a revoke in every
//! running process.
//!
//! Written straight to the `system.posix_acl_access` / `system.posix_acl_default`
//! extended attributes through a descriptor opened `O_NOFOLLOW` (the kernel's
//! xattr format, `linux/posix_acl_xattr.h`), so the hub needs neither
//! `setfacl` nor libacl. The hub only ever changes ACLs on files it owns,
//! which the owner of a file may do without any capability.

use std::collections::BTreeMap;

const VERSION: u32 = 2;
const TAG_USER_OBJ: u16 = 0x01;
const TAG_USER: u16 = 0x02;
const TAG_GROUP_OBJ: u16 = 0x04;
const TAG_GROUP: u16 = 0x08;
const TAG_MASK: u16 = 0x10;
const TAG_OTHER: u16 = 0x20;
const UNDEFINED_ID: u32 = u32::MAX;

pub const ACCESS: &str = "system.posix_acl_access";
pub const DEFAULT: &str = "system.posix_acl_default";

/// `r` / `w` / `x` bits as in a mode's triple.
pub const R: u16 = 4;
pub const W: u16 = 2;
pub const X: u16 = 1;

/// An ACL: the three base entries, named users and groups, and the mask.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Acl {
    pub owner: u16,
    pub group: u16,
    pub other: u16,
    pub users: BTreeMap<u32, u16>,
    pub groups: BTreeMap<u32, u16>,
    pub mask: Option<u16>,
}

impl Acl {
    /// The ACL a plain mode means.
    pub fn from_mode(mode: u32) -> Acl {
        Acl { owner: ((mode >> 6) & 7) as u16, group: ((mode >> 3) & 7) as u16, other: (mode & 7) as u16, ..Acl::default() }
    }

    /// Recompute the mask as `setfacl` does: the union of the group entry and
    /// every named entry; none when there are no named entries.
    pub fn recompute_mask(&mut self) {
        if self.users.is_empty() && self.groups.is_empty() {
            self.mask = None;
        } else {
            self.mask = Some(self.users.values().chain(self.groups.values()).fold(self.group, |m, p| m | p));
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + 8 * (4 + self.users.len() + self.groups.len()));
        out.extend_from_slice(&VERSION.to_le_bytes());
        let mut entry = |tag: u16, perm: u16, id: u32| {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&(perm & 7).to_le_bytes());
            out.extend_from_slice(&id.to_le_bytes());
        };
        // The kernel wants entries sorted by tag, then id.
        entry(TAG_USER_OBJ, self.owner, UNDEFINED_ID);
        for (uid, perm) in &self.users {
            entry(TAG_USER, *perm, *uid);
        }
        entry(TAG_GROUP_OBJ, self.group, UNDEFINED_ID);
        for (gid, perm) in &self.groups {
            entry(TAG_GROUP, *perm, *gid);
        }
        let mask = self.mask.or_else(|| (!self.users.is_empty() || !self.groups.is_empty()).then_some(7));
        if let Some(mask) = mask {
            entry(TAG_MASK, mask, UNDEFINED_ID);
        }
        entry(TAG_OTHER, self.other, UNDEFINED_ID);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Acl, String> {
        if bytes.len() < 4 || !(bytes.len() - 4).is_multiple_of(8) {
            return Err("not an ACL".into());
        }
        if u32::from_le_bytes(bytes[0..4].try_into().unwrap_or_default()) != VERSION {
            return Err("unknown ACL version".into());
        }
        let mut acl = Acl::default();
        for chunk in bytes[4..].chunks_exact(8) {
            let tag = u16::from_le_bytes([chunk[0], chunk[1]]);
            let perm = u16::from_le_bytes([chunk[2], chunk[3]]) & 7;
            let id = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
            match tag {
                TAG_USER_OBJ => acl.owner = perm,
                TAG_USER => {
                    acl.users.insert(id, perm);
                }
                TAG_GROUP_OBJ => acl.group = perm,
                TAG_GROUP => {
                    acl.groups.insert(id, perm);
                }
                TAG_MASK => acl.mask = Some(perm),
                TAG_OTHER => acl.other = perm,
                other => return Err(format!("unknown ACL tag {other:#x}")),
            }
        }
        Ok(acl)
    }
}

#[cfg(target_os = "linux")]
mod sys {
    use super::Acl;
    use std::ffi::CString;
    use std::os::unix::io::AsRawFd;

    fn name(attr: &str) -> CString {
        CString::new(attr).unwrap_or_default()
    }

    /// The ACL stored under `attr` on `file`, or `None` when there is none.
    pub fn get(file: &std::fs::File, attr: &str) -> std::io::Result<Option<Acl>> {
        let attr = name(attr);
        let mut buf = vec![0u8; 4096];
        // SAFETY: a valid descriptor, a NUL-terminated name and a buffer of
        // the stated length.
        let n = unsafe { libc::fgetxattr(file.as_raw_fd(), attr.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
        if n < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENODATA) => Ok(None),
                _ => Err(error),
            };
        }
        buf.truncate(n as usize);
        Acl::decode(&buf).map(Some).map_err(std::io::Error::other)
    }

    pub fn set(file: &std::fs::File, attr: &str, acl: &Acl) -> std::io::Result<()> {
        let attr = name(attr);
        let bytes = acl.encode();
        // SAFETY: a valid descriptor, name and buffer.
        let rc = unsafe { libc::fsetxattr(file.as_raw_fd(), attr.as_ptr(), bytes.as_ptr().cast(), bytes.len(), 0) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn remove(file: &std::fs::File, attr: &str) -> std::io::Result<()> {
        let attr = name(attr);
        // SAFETY: a valid descriptor and name.
        let rc = unsafe { libc::fremovexattr(file.as_raw_fd(), attr.as_ptr()) };
        if rc != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENODATA) {
                return Err(error);
            }
        }
        Ok(())
    }
}

/// Open `path` for an ACL change without following a final symlink: a
/// directory or a regular file, anything else (a symlink, a FIFO) is `None`.
#[cfg(target_os = "linux")]
fn open_plain(path: &std::path::Path) -> std::io::Result<Option<(std::fs::File, bool)>> {
    use std::os::unix::fs::OpenOptionsExt;
    let meta = std::fs::symlink_metadata(path)?;
    let is_dir = meta.is_dir();
    if !is_dir && !meta.is_file() {
        return Ok(None);
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | if is_dir { libc::O_DIRECTORY } else { 0 });
    Ok(Some((options.open(path)?, is_dir)))
}

/// Base access entries of a hub entry: the hub's own `rwx`/`rw` from the
/// mode, nothing for its group or others.
#[cfg(target_os = "linux")]
fn base(file: &std::fs::File, existing: Option<Acl>) -> std::io::Result<Acl> {
    use std::os::unix::fs::MetadataExt;
    Ok(match existing {
        Some(acl) => acl,
        None => {
            let mut acl = Acl::from_mode(file.metadata()?.mode());
            acl.group = 0;
            acl.other = 0;
            acl
        }
    })
}

/// Give `uid` read access to one entry (`r-x` on a directory, `r--` on a
/// file) — and, on a directory, the same in its default ACL so whatever the
/// hub writes there later inherits it — or, with `read = false`, take every
/// entry of `uid` off it. Group and other stay `---`.
#[cfg(target_os = "linux")]
pub fn set_user(path: &std::path::Path, uid: u32, read: bool) -> std::io::Result<()> {
    let Some((file, is_dir)) = open_plain(path)? else { return Ok(()) };
    let mut access = base(&file, sys::get(&file, ACCESS)?)?;
    if read {
        access.users.insert(uid, if is_dir { R | X } else { R });
    } else {
        access.users.remove(&uid);
    }
    access.recompute_mask();
    sys::set(&file, ACCESS, &access)?;
    if is_dir {
        let mut default = match sys::get(&file, DEFAULT)? {
            Some(acl) => acl,
            None => Acl { owner: R | W | X, group: 0, other: 0, ..Acl::default() },
        };
        if read {
            default.users.insert(uid, R | X);
        } else {
            default.users.remove(&uid);
        }
        default.recompute_mask();
        if default.users.is_empty() && default.groups.is_empty() {
            sys::remove(&file, DEFAULT)?;
        } else {
            sys::set(&file, DEFAULT, &default)?;
        }
    }
    Ok(())
}

/// The named users of `path`'s access ACL with their permission bits.
#[cfg(target_os = "linux")]
pub fn users_of(path: &std::path::Path) -> std::io::Result<BTreeMap<u32, u16>> {
    let Some((file, _)) = open_plain(path)? else { return Ok(BTreeMap::new()) };
    Ok(sys::get(&file, ACCESS)?.map(|a| a.users).unwrap_or_default())
}

/// The named users of a directory's default ACL.
#[cfg(target_os = "linux")]
pub fn default_users_of(path: &std::path::Path) -> std::io::Result<BTreeMap<u32, u16>> {
    let Some((file, _)) = open_plain(path)? else { return Ok(BTreeMap::new()) };
    Ok(sys::get(&file, DEFAULT)?.map(|a| a.users).unwrap_or_default())
}

/// [`set_user`] over `root` and everything below it — `root` first, so a
/// revoke cuts every path lookup before the walk reaches the objects (an
/// already-open descriptor below the top is then still taken off entry by
/// entry). Symlinks are skipped, never followed.
#[cfg(target_os = "linux")]
pub fn set_user_tree(root: &std::path::Path, uid: u32, read: bool) -> std::io::Result<()> {
    set_user(root, uid, read)?;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            set_user(&path, uid, read)?;
            if kind.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_xattr_format_round_trips_like_setfacl_writes_it() {
        // `setfacl -m u:1000:r f` on a 0664 file, read back with getxattr.
        let written = "0200000001000600ffffffff02000400e803000004000600ffffffff10000600ffffffff20000400ffffffff";
        let bytes: Vec<u8> = (0..written.len()).step_by(2).map(|i| u8::from_str_radix(&written[i..i + 2], 16).unwrap()).collect();
        let acl = Acl::decode(&bytes).unwrap();
        assert_eq!((acl.owner, acl.group, acl.other, acl.mask), (6, 6, 4, Some(6)));
        assert_eq!(acl.users.get(&1000), Some(&R));
        assert_eq!(acl.encode(), bytes);
        let mut plain = Acl::from_mode(0o750);
        assert_eq!((plain.owner, plain.group, plain.other), (7, 5, 0));
        plain.recompute_mask();
        assert_eq!(plain.mask, None, "no named entries, no mask");
        assert!(Acl::decode(&[1, 2, 3]).is_err());
    }

    /// Only a uid mapped into this namespace can be named (an unmapped one is
    /// EINVAL), so the test names its own; whether another account can read
    /// is `server-isolation-test.sh`'s job on a real server.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_tree_is_granted_and_revoked_top_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("hub.git");
        std::fs::create_dir_all(root.join("objects/ab")).unwrap();
        std::fs::write(root.join("objects/ab/cd"), b"x").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("link")).unwrap();
        // SAFETY: no preconditions.
        let me = unsafe { libc::geteuid() };
        if set_user(&root, me, true).is_err() {
            eprintln!("this filesystem has no POSIX ACLs; skipped");
            return;
        }
        set_user_tree(&root, me, true).unwrap();
        assert_eq!(users_of(&root).unwrap().get(&me), Some(&(R | X)));
        assert_eq!(users_of(&root.join("objects/ab/cd")).unwrap().get(&me), Some(&R));
        assert_eq!(default_users_of(&root.join("objects")).unwrap().get(&me), Some(&(R | X)), "new objects inherit the grant");
        // A file written later under a granted directory carries the entry.
        std::fs::write(root.join("objects/ab/ef"), b"y").unwrap();
        assert_eq!(users_of(&root.join("objects/ab/ef")).unwrap().get(&me), Some(&(R | X)));
        set_user_tree(&root, me, false).unwrap();
        for path in [root.clone(), root.join("objects"), root.join("objects/ab/cd"), root.join("objects/ab/ef")] {
            assert!(users_of(&path).unwrap().is_empty(), "{}", path.display());
        }
        assert!(default_users_of(&root.join("objects")).unwrap().is_empty());
        assert!(std::fs::symlink_metadata(root.join("link")).unwrap().file_type().is_symlink(), "the link was skipped, not followed");
    }
}
