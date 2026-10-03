//! The hosted server's gateway and admin helper (hosted plan §3.1, §4, §8;
//! `docs/tabtivity_hosted_plan.md`, rationale in `docs/context/server_gateway.md`).
//!
//! * **Gateway** ([`server`]): the only listening port, behind Tailscale
//!   Serve. It authenticates devices only by routing — pairing goes to the
//!   account the code names, a challenge to the account that owns the device —
//!   and forwards every request of a signed-in device to **that account's own
//!   daemon socket** ([`proxy`]). It holds the account table ([`db`]), the
//!   routing cookie's key ([`cookie`]) and the audit log ([`audit`]); it links
//!   no core service and reads no user file.
//! * **Admin helper** ([`helper`]): the only root code — accounts, units,
//!   invites, the CLI install root — as a fixed verb set with hard rules,
//!   every verb a [`helper::Plan`] that `--dry-run` prints.
//! * [`units`] renders the systemd units and slices; [`prereq`] checks the
//!   deployment prerequisites of §8.
//!
//! Linux only; the crate builds elsewhere so the workspace does.

#[path = "../../src-core/src/brand.rs"]
pub mod brand;

pub mod wire;

pub mod audit;
pub mod config;
pub mod cookie;
pub mod db;
pub mod names;
pub mod policy;
pub mod prereq;
pub mod statics;
pub mod units;

#[cfg(unix)]
pub mod helper;
#[cfg(unix)]
pub mod proxy;
#[cfg(unix)]
pub mod server;

/// Seconds since the epoch.
pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Write `bytes` to `path` atomically: a sibling temp file, `fsync`, rename,
/// then the directory's `fsync`. `mode` applies to the new file; when this
/// runs as root and the file existed, the new one keeps the old owner (the
/// helper edits files the gateway's account owns).
pub fn write_atomic(path: &std::path::Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent directory"))?;
    let leaf = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{leaf}.{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(&tmp)?;
    let result = (|| {
        file.write_all(bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            file.set_permissions(std::fs::Permissions::from_mode(mode))?;
            // SAFETY: geteuid has no preconditions.
            if unsafe { libc::geteuid() } == 0 {
                if let Ok(old) = std::fs::symlink_metadata(path) {
                    std::os::unix::fs::fchown(&file, Some(old.uid()), Some(old.gid()))?;
                }
            }
        }
        file.sync_all()?;
        std::fs::rename(&tmp, path)?;
        if let Ok(dir) = std::fs::File::open(dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Read a regular file without following a final symlink and without
/// blocking on a FIFO. The helper runs as root over the gateway's state
/// directory, which the gateway's account owns: a symlink or FIFO planted
/// there must not make root read (or hang on) anything else.
pub fn read_regular(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(format!("{}: not a regular file", path.display())));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn read_regular_refuses_symlinks_and_fifos() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::write(&real, b"x").unwrap();
        assert_eq!(super::read_regular(&real).unwrap(), b"x");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(super::read_regular(&link).is_err(), "a planted symlink is not followed");
        let fifo = dir.path().join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(super::read_regular(&fifo).is_err(), "a FIFO is refused, not waited on");
    }

    #[test]
    fn write_atomic_replaces_and_sets_the_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        super::write_atomic(&path, b"one", 0o640).unwrap();
        super::write_atomic(&path, b"two", 0o640).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no temp file left");
    }
}
