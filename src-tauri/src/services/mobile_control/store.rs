use std::{fs, io::Write, path::Path};

use serde::{de::DeserializeOwned, Serialize};

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T, mode: u32) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    write_bytes_atomic(path, &bytes, mode)
}

/// Write `bytes` to a sibling created with `mode`, then rename it over `path`,
/// so a reader sees either the old contents or the new ones and never a
/// truncated file. The sibling carries the private mode from creation, so key
/// material is never world-readable for even an instant. On Windows the
/// sibling is restricted to its owner (`private_file::restrict_to_owner`)
/// before a byte is written, and the rename keeps that ACL; `mode` is not
/// used there.
pub fn write_bytes_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = mode;
    let parent = path.parent().ok_or("state path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("open {}: {e}", tmp.display()))?;
    #[cfg(windows)]
    crate::services::private_file::restrict_to_owner(&tmp);
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(unix)]
pub fn ensure_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("inspect {}: {e}", path.display()))?;
    if !metadata.file_type().is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.permissions().mode() & 0o600 != 0o600
    {
        return Err(format!(
            "{} must be an owner-readable/writable private regular file",
            path.display()
        ));
    }
    Ok(())
}

/// Not checked off Unix: verifying a Windows ACL is a second reader beside
/// `private_file`'s writer and is not built. The files are restricted when
/// written (`write_bytes_atomic`), and the profile folder's ACL is the
/// barrier for one placed by hand.
#[cfg(not(unix))]
pub fn ensure_private_file(_: &Path) -> Result<(), String> {
    Ok(())
}

pub fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Doc {
        n: u32,
        s: String,
    }

    /// The atomic writer creates missing parents, leaves no `.tmp` sibling
    /// behind, and a second write replaces the content wholesale.
    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("devices.json");
        let doc = Doc { n: 1, s: "one".into() };
        write_json_atomic(&path, &doc, 0o600).unwrap();
        assert_eq!(read_json::<Doc>(&path).unwrap(), doc);
        assert!(!path.with_extension("tmp").exists());

        let next = Doc { n: 2, s: "two".into() };
        write_json_atomic(&path, &next, 0o600).unwrap();
        assert_eq!(read_json::<Doc>(&path).unwrap(), next);
        assert!(!path.with_extension("tmp").exists());
    }

    /// Both failure modes name the file, so a log line says which of the
    /// store's files is missing or damaged.
    #[test]
    fn read_errors_name_the_path_and_the_stage() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("absent.json");
        let err = read_json::<Doc>(&missing).unwrap_err();
        assert!(err.starts_with("read "), "{err}");
        assert!(err.contains("absent.json"), "{err}");

        let damaged = dir.path().join("damaged.json");
        fs::write(&damaged, b"{\"n\":").unwrap();
        let err = read_json::<Doc>(&damaged).unwrap_err();
        assert!(err.starts_with("parse "), "{err}");
        assert!(err.contains("damaged.json"), "{err}");
    }

    /// Key material is private from the moment the file exists: the written
    /// file carries exactly the requested mode.
    #[cfg(unix)]
    #[test]
    fn the_written_file_carries_the_requested_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.key");
        write_bytes_atomic(&path, b"secret", 0o600).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read(&path).unwrap(), b"secret");
        ensure_private_file(&path).unwrap();
    }

    /// The private-file check refuses everything that is not an owner-only,
    /// owner-writable regular file: group/world bits, a read-only owner mode,
    /// a directory, and a symlink to an otherwise fine file.
    #[cfg(unix)]
    #[test]
    fn ensure_private_file_refuses_shared_readonly_directory_and_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("shared");
        fs::write(&shared, b"x").unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(ensure_private_file(&shared).is_err());

        let readonly = dir.path().join("readonly");
        fs::write(&readonly, b"x").unwrap();
        fs::set_permissions(&readonly, fs::Permissions::from_mode(0o400)).unwrap();
        assert!(ensure_private_file(&readonly).is_err(), "must be writable too");

        assert!(ensure_private_file(dir.path()).is_err(), "a directory is not a file");

        let good = dir.path().join("good");
        fs::write(&good, b"x").unwrap();
        fs::set_permissions(&good, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&good, &link).unwrap();
        assert!(ensure_private_file(&link).is_err(), "symlink_metadata sees the link");
        assert!(ensure_private_file(&good).is_ok());
    }

    /// The control dir is created owner-only, and tightened if it exists.
    #[cfg(unix)]
    #[test]
    fn ensure_private_dir_creates_and_tightens_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("mobile-control");
        ensure_private_dir(&control).unwrap();
        assert_eq!(fs::metadata(&control).unwrap().permissions().mode() & 0o777, 0o700);
        fs::set_permissions(&control, fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&control).unwrap();
        assert_eq!(fs::metadata(&control).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
