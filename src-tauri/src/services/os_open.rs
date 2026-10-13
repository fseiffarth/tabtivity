//! Handing a file to the operating system's default app (threat recheck
//! gap 21, decision C2).
//!
//! A file with no in-app viewer, a Shift+double-click, a terminal path link,
//! a Reader change card and a phone upload in the global inbox all end in
//! `opener::open`, which on every OS *runs* a launcher: a `.desktop` entry
//! or an executable script on Linux, an `.app` or `.command` on macOS, an
//! `.exe`, `.lnk` or `.bat` on Windows. Anything inside a project folder is
//! attacker-controlled, so a file an agent wrote could be a program the user
//! starts by "opening" it. The window asks first (naming the file); this
//! module is the part that never asks: a launcher type, or a file with an
//! execute bit, is refused outright with [`REFUSED_LAUNCHER`], which the
//! frontend maps to a message.
//!
//! The check runs only where the OS picks the program. A default app the
//! user configured for the extension, or an explicit handler, is the user's
//! own choice and is not judged here.
//!
//! On a filesystem without real Unix permissions (FAT/exFAT, NTFS through
//! `ntfs3` or ntfs-3g, CIFS/SMB, WSL's 9p/drvfs `/mnt/*`) every file shows the
//! mount's fixed mode, usually with `x` set, so the execute bit says nothing
//! there: such a file is judged by its name only (follow-up decision (a)),
//! and still gets the window's question like any other. When the filesystem
//! cannot be told, the execute bit counts ([`UnixModes::Unknown`]).

use std::path::Path;

/// The fixed refusal the frontend maps to its message.
pub const REFUSED_LAUNCHER: &str = "open_refused_launcher";

/// Which operating system's default-app rules apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

/// Linux (and the other free Unixes): desktop entries, scripts, AppImages,
/// Java archives, and the Windows programs Wine registers itself for.
const LINUX: &[&str] = &[
    "desktop", "sh", "bash", "zsh", "csh", "ksh", "fish", "run", "appimage", "jar",
    // Wine's `wine start` associations.
    "exe", "com", "msi", "bat", "cmd", "lnk", "scr", "pif",
];

/// macOS: bundles, Terminal-run scripts and settings, installers, Automator
/// and AppleScript, location files that can point at an app, Java archives.
const MACOS: &[&str] = &[
    "app", "command", "tool", "terminal", "pkg", "mpkg", "workflow", "action", "scpt",
    "scptd", "applescript", "osax", "prefpane", "fileloc", "jar", "sh",
];

/// Windows: the default `PATHEXT` set (it may be unset or trimmed), plus
/// shortcuts, installers, script hosts, control-panel and registry files,
/// ClickOnce, and the Python launcher's associations.
const WINDOWS: &[&str] = &[
    "com", "exe", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msc", "lnk", "url",
    "scr", "pif", "msi", "msp", "mst", "hta", "ps1", "psm1", "cpl", "reg", "inf", "scf",
    "appref-ms", "application", "gadget", "chm", "diagcab", "xbap", "settingcontent-ms",
    "library-ms", "searchconnector-ms", "website", "jar", "py", "pyw", "pyz", "pyzw",
];

/// Every launcher extension any of the three systems knows, for a file that
/// may be opened on another machine (`services::connect`).
pub fn is_launcher_on_any_os(name: &str) -> bool {
    [Os::Linux, Os::MacOs, Os::Windows]
        .into_iter()
        .any(|os| is_launcher_name(name, os, None))
}

/// Would `os` run a file named `name` instead of showing it? `pathext` is
/// the Windows `PATHEXT` value, whose entries count too. Case-insensitive;
/// on Windows the trailing dots and spaces Win32 strips are stripped first
/// (`evil.exe.` opens as `evil.exe`).
pub fn is_launcher_name(name: &str, os: Os, pathext: Option<&str>) -> bool {
    let name = if os == Os::Windows {
        name.trim_end_matches(['.', ' '])
    } else {
        name
    };
    // A dotfile (`.desktop` alone) is still that type to a file manager.
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    let list = match os {
        Os::Linux => LINUX,
        Os::MacOs => MACOS,
        Os::Windows => WINDOWS,
    };
    if list.contains(&ext.as_str()) {
        return true;
    }
    os == Os::Windows
        && pathext.is_some_and(|value| {
            value
                .split(';')
                .map(|entry| entry.trim().trim_start_matches('.').to_ascii_lowercase())
                .any(|entry| !entry.is_empty() && entry == ext)
        })
}

/// May `path` be handed to the OS default app? Refuses ([`REFUSED_LAUNCHER`])
/// when the name as given **or** the file it resolves to is a launcher type,
/// so neither `notes.txt -> run.desktop` nor `run.desktop -> notes.txt`
/// passes (file managers judge a file by the name they are given), and on
/// Unix a regular file with any execute bit, unless its filesystem has no
/// Unix modes ([`UnixModes::None`]). A folder passes (it opens in
/// the file manager) unless it is a macOS bundle. A path that does not
/// resolve is an error too: the OS could not open it either.
pub fn check(path: &Path) -> Result<(), String> {
    check_with(path, Os::current(), std::env::var("PATHEXT").ok().as_deref(), &unix_modes_of)
}

/// Does the filesystem a file lives on keep real Unix permissions?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnixModes {
    /// A Unix filesystem (ext4, btrfs, xfs, tmpfs, APFS, NFS, sshfs, …): the
    /// execute bit is the file's own.
    Real,
    /// FAT/exFAT, NTFS, CIFS/SMB, 9p/drvfs: the mode is the mount's, the same
    /// for every file, so the execute bit is ignored.
    None,
    /// Could not tell: the execute bit counts (the stricter rule).
    Unknown,
}

/// Filesystem type names (Linux `/proc/self/mountinfo`, macOS
/// `statfs.f_fstypename`) whose files carry no Unix mode of their own.
/// `fuseblk` is the block-device FUSE type ntfs-3g and exfat-fuse mount as.
const NO_MODE_FS_NAMES: &[&str] = &[
    "vfat", "msdos", "fat", "exfat", "ntfs", "ntfs3", "fuseblk", "fuse.ntfs-3g", "fuse.exfat",
    "fuse.exfat-fuse", "cifs", "smb3", "smbfs", "9p", "drvfs",
];

/// Is a filesystem of type `name` one whose files carry no Unix mode?
pub fn fs_name_lacks_unix_modes(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    NO_MODE_FS_NAMES.contains(&name.as_str())
}

/// Linux `statfs.f_type` magic numbers of filesystems without Unix modes:
/// MSDOS/vfat, exFAT, the old `ntfs` driver (`NTFS_SB_MAGIC`), `ntfs3` (its
/// own `"ntfs"` magic, not in `magic.h`), CIFS, SMB2/3, SMB, 9p.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const NO_MODE_FS_MAGIC: &[u32] = &[
    0x4d44, 0x2011_bab0, 0x5346_544e, 0x7366_746e, 0xff53_4d42, 0xfe53_4d42, 0x517b, 0x0102_1997,
];

/// Linux: judge by the `statfs` magic first, then by the type name of the
/// mount the file is on (`fuseblk` ntfs-3g and WSL's `drvfs` share their
/// magic with filesystems that do have modes).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_unix_modes(magic: Option<u32>, mount_fstype: Option<&str>) -> UnixModes {
    let Some(magic) = magic else {
        return UnixModes::Unknown;
    };
    if NO_MODE_FS_MAGIC.contains(&magic) || mount_fstype.is_some_and(fs_name_lacks_unix_modes) {
        UnixModes::None
    } else {
        UnixModes::Real
    }
}

/// The filesystem type of the mount `path` (absolute, canonical) is on, per
/// a `/proc/self/mountinfo` text: the longest matching mount point, the last
/// one listed among equals (a later mount over the same point hides the
/// earlier). Mount points are octal-escaped (`\040` for a space).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn mount_fstype_for(mountinfo: &str, path: &Path) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for line in mountinfo.lines() {
        let Some((pre, post)) = line.split_once(" - ") else {
            continue;
        };
        let (Some(point), Some(fstype)) = (pre.split(' ').nth(4), post.split(' ').next()) else {
            continue;
        };
        let point = unescape_mount(point);
        let point = Path::new(&point);
        if !path.starts_with(point) {
            continue;
        }
        let depth = point.components().count();
        if best.as_ref().is_none_or(|(d, _)| depth >= *d) {
            best = Some((depth, fstype.to_string()));
        }
    }
    best.map(|(_, fstype)| fstype)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn unescape_mount(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 3 < bytes.len()
            && bytes[i + 1..i + 4].iter().all(|b| (b'0'..=b'7').contains(b))
        {
            out.push((bytes[i + 1] - b'0') * 64 + (bytes[i + 2] - b'0') * 8 + (bytes[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the filesystem holding `path` (resolved) says about Unix modes.
#[cfg(target_os = "linux")]
fn unix_modes_of(path: &Path) -> UnixModes {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return UnixModes::Unknown;
    };
    // SAFETY: `c_path` is NUL-terminated and outlives the call; `st` is a
    // plain C struct the call fills in.
    let magic = unsafe {
        let mut st: libc::statfs = std::mem::zeroed();
        if libc::statfs(c_path.as_ptr(), &mut st) == 0 {
            // The kernel's `f_type` is an unsigned long; magics fit 32 bits.
            Some(st.f_type as u32)
        } else {
            None
        }
    };
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").ok();
    let fstype = mountinfo.as_deref().and_then(|m| mount_fstype_for(m, path));
    linux_unix_modes(magic, fstype.as_deref())
}

/// What the filesystem holding `path` (resolved) says about Unix modes.
#[cfg(target_os = "macos")]
fn unix_modes_of(path: &Path) -> UnixModes {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return UnixModes::Unknown;
    };
    // SAFETY: as above; `f_fstypename` is a NUL-terminated C string array.
    let name = unsafe {
        let mut st: libc::statfs = std::mem::zeroed();
        if libc::statfs(c_path.as_ptr(), &mut st) != 0 {
            return UnixModes::Unknown;
        }
        std::ffi::CStr::from_ptr(st.f_fstypename.as_ptr()).to_string_lossy().into_owned()
    };
    if fs_name_lacks_unix_modes(&name) {
        UnixModes::None
    } else {
        UnixModes::Real
    }
}

/// Other Unixes: not told apart, so the execute bit counts. Windows has no
/// execute bit to judge.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn unix_modes_of(_path: &Path) -> UnixModes {
    UnixModes::Unknown
}

#[cfg(test)]
fn check_for(path: &Path, os: Os, pathext: Option<&str>) -> Result<(), String> {
    check_with(path, os, pathext, &unix_modes_of)
}

fn check_with(
    path: &Path,
    os: Os,
    pathext: Option<&str>,
    modes_of: &dyn Fn(&Path) -> UnixModes,
) -> Result<(), String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let launcher = |p: &Path| {
        p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| is_launcher_name(n, os, pathext))
    };
    let meta = std::fs::metadata(&real).map_err(|e| format!("{}: {e}", path.display()))?;
    // A folder opens in the file manager, except a macOS bundle (`X.app`,
    // `Y.pkg`), which `open` runs.
    if meta.is_dir() {
        return if os == Os::MacOs && (launcher(path) || launcher(&real)) {
            Err(REFUSED_LAUNCHER.to_string())
        } else {
            Ok(())
        };
    }
    if launcher(path) || launcher(&real) {
        return Err(REFUSED_LAUNCHER.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Asked only for an executable file: a mount without Unix modes
        // shows `x` on everything, so there the name alone decides.
        if meta.permissions().mode() & 0o111 != 0 && modes_of(&real) != UnixModes::None {
            return Err(REFUSED_LAUNCHER.to_string());
        }
    }
    #[cfg(not(unix))]
    let _ = modes_of;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_os_refuses_its_own_launchers_in_any_case() {
        for (os, names) in [
            (Os::Linux, &["run.desktop", "x.SH", "a.AppImage", "b.jar", "setup.exe", "go.run", "w.bat"][..]),
            (Os::MacOs, &["Evil.app", "go.command", "t.tool", "s.terminal", "i.pkg", "w.workflow", "s.scpt", "f.fileloc", "b.JAR"][..]),
            (
                Os::Windows,
                &["a.exe", "b.LNK", "c.cmd", "d.bat", "e.vbs", "f.ps1", "g.js", "h.msi", "i.hta", "j.url",
                  "k.reg", "l.cpl", "m.appref-ms", "n.settingcontent-ms", "o.application", "p.msc", "q.jar",
                  "r.scr", "s.wsf", "t.py"][..],
            ),
        ] {
            for name in names {
                assert!(is_launcher_name(name, os, None), "{name} on {os:?}");
            }
        }
    }

    #[test]
    fn documents_are_not_launchers_and_lists_stay_per_os() {
        for os in [Os::Linux, Os::MacOs, Os::Windows] {
            for name in ["paper.pdf", "notes.txt", "data.csv", "photo.JPG", "README", "archive.tar.gz", "desktop"] {
                assert!(!is_launcher_name(name, os, None), "{name} on {os:?}");
            }
        }
        // A `.js` or `.py` is a script host only on Windows; `.desktop` only
        // means something to a Linux desktop.
        assert!(!is_launcher_name("app.js", Os::Linux, None));
        assert!(!is_launcher_name("tool.py", Os::MacOs, None));
        assert!(!is_launcher_name("run.desktop", Os::Windows, None));
        assert!(is_launcher_on_any_os("run.desktop") && is_launcher_on_any_os("x.lnk") && is_launcher_on_any_os("y.app"));
        assert!(!is_launcher_on_any_os("paper.pdf"));
    }

    #[test]
    fn windows_counts_pathext_and_strips_trailing_dots_and_spaces() {
        assert!(is_launcher_name("evil.exe.", Os::Windows, None));
        assert!(is_launcher_name("evil.exe . ", Os::Windows, None));
        assert!(!is_launcher_name("tool.foo", Os::Windows, None));
        assert!(is_launcher_name("tool.FOO", Os::Windows, Some(".COM;.EXE;.foo")));
        assert!(!is_launcher_name("tool.foo", Os::Linux, Some(".FOO")));
        assert!(!is_launcher_name("tool.txt", Os::Windows, Some(";;.")));
    }

    #[test]
    fn check_refuses_a_launcher_by_either_name_and_passes_a_document() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("paper.pdf");
        std::fs::write(&doc, b"%PDF").unwrap();
        assert_eq!(check_for(&doc, Os::Linux, None), Ok(()));
        let launcher = dir.path().join("run.desktop");
        std::fs::write(&launcher, b"[Desktop Entry]").unwrap();
        assert_eq!(check_for(&launcher, Os::Linux, None).unwrap_err(), REFUSED_LAUNCHER);
        assert!(check_for(&dir.path().join("missing.pdf"), Os::Linux, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn check_judges_a_link_by_its_name_and_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("run.desktop");
        std::fs::write(&launcher, b"[Desktop Entry]").unwrap();
        let disguised = dir.path().join("notes.txt");
        std::os::unix::fs::symlink(&launcher, &disguised).unwrap();
        assert_eq!(check_for(&disguised, Os::Linux, None).unwrap_err(), REFUSED_LAUNCHER);
        let doc = dir.path().join("plain.txt");
        std::fs::write(&doc, b"hi").unwrap();
        let named = dir.path().join("go.desktop");
        std::os::unix::fs::symlink(&doc, &named).unwrap();
        assert_eq!(check_for(&named, Os::Linux, None).unwrap_err(), REFUSED_LAUNCHER);
    }

    #[cfg(unix)]
    #[test]
    fn check_refuses_an_executable_file_but_not_a_folder() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("notes.txt");
        std::fs::write(&script, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(check_for(&script, Os::Linux, None), Ok(()));
        for mode in [0o744, 0o654, 0o645] {
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(check_for(&script, Os::Linux, None).unwrap_err(), REFUSED_LAUNCHER, "{mode:o}");
        }
        let folder = dir.path().join("photos");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(check_for(&folder, Os::Linux, None), Ok(()));
    }

    #[test]
    fn a_folder_is_refused_only_as_a_macos_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("Evil.app");
        std::fs::create_dir(&bundle).unwrap();
        assert_eq!(check_for(&bundle, Os::MacOs, None).unwrap_err(), REFUSED_LAUNCHER);
        let plain = dir.path().join("scripts.sh");
        std::fs::create_dir(&plain).unwrap();
        assert_eq!(check_for(&plain, Os::Linux, None), Ok(()));
        assert_eq!(check_for(&dir.path().join("Evil.app"), Os::Windows, None), Ok(()));
        assert_eq!(check_for(dir.path(), Os::MacOs, None), Ok(()));
    }

    #[test]
    fn filesystems_without_unix_modes_are_known_by_name_and_magic() {
        for name in ["vfat", "MSDOS", "exfat", "ntfs", "ntfs3", "fuseblk", "cifs", "smb3", "smbfs", "9p", "drvfs"] {
            assert!(fs_name_lacks_unix_modes(name), "{name}");
        }
        for name in ["ext4", "btrfs", "xfs", "tmpfs", "apfs", "hfs", "nfs", "nfs4", "fuse.sshfs", "fuse", "overlay", ""] {
            assert!(!fs_name_lacks_unix_modes(name), "{name}");
        }
        // statfs magics: vfat, exFAT, NTFS (old driver and ntfs3, whose
        // `ntfs_fill_super` sets `0x7366746e`), CIFS, SMB2, 9p.
        for magic in [0x4d44, 0x2011_bab0, 0x5346_544e, 0x7366_746e, 0xff53_4d42, 0xfe53_4d42, 0x0102_1997] {
            assert_eq!(linux_unix_modes(Some(magic), Some("whatever")), UnixModes::None, "{magic:x}");
        }
        // ext4 and tmpfs keep modes; a FUSE mount is told by its type name.
        assert_eq!(linux_unix_modes(Some(0xef53), Some("ext4")), UnixModes::Real);
        assert_eq!(linux_unix_modes(Some(0x0102_1994), None), UnixModes::Real);
        assert_eq!(linux_unix_modes(Some(0x6573_5546), Some("fuseblk")), UnixModes::None);
        assert_eq!(linux_unix_modes(Some(0x6573_5546), Some("fuse.sshfs")), UnixModes::Real);
        // WSL1's drvfs has its own magic; its mount type gives it away.
        assert_eq!(linux_unix_modes(Some(0x5346_4846), Some("drvfs")), UnixModes::None);
        // statfs failed: the stricter rule.
        assert_eq!(linux_unix_modes(None, Some("vfat")), UnixModes::Unknown);
    }

    #[test]
    fn the_mount_a_path_is_on_is_the_longest_and_latest_match() {
        let mountinfo = "\
22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
30 22 0:40 / /mnt/c rw,noatime - 9p drvfs rw,aname=drvfs
31 22 8:17 / /media/u/MY\\040STICK rw,nosuid shared:5 - vfat /dev/sdb1 rw,fmask=0022
32 22 0:41 / /data rw - ext4 /dev/sdc1 rw
33 22 0:42 / /data rw - fuseblk /dev/sdd1 rw
broken line without separator
";
        let at = |p: &str| mount_fstype_for(mountinfo, Path::new(p));
        assert_eq!(at("/home/u/notes.txt").as_deref(), Some("ext4"));
        assert_eq!(at("/mnt/c/Users/x/run.txt").as_deref(), Some("9p"));
        assert_eq!(at("/mnt/cd/file").as_deref(), Some("ext4"));
        assert_eq!(at("/media/u/MY STICK/a.txt").as_deref(), Some("vfat"));
        assert_eq!(at("/data/x").as_deref(), Some("fuseblk"));
        assert_eq!(mount_fstype_for("", Path::new("/x")), None);
        assert_eq!(unescape_mount("a\\040b\\134c\\04"), "a b\\c\\04");
    }

    #[cfg(unix)]
    #[test]
    fn an_execute_bit_is_ignored_only_where_the_filesystem_has_no_modes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("notes.txt");
        std::fs::write(&doc, b"hi").unwrap();
        std::fs::set_permissions(&doc, std::fs::Permissions::from_mode(0o755)).unwrap();
        let launcher = dir.path().join("run.desktop");
        std::fs::write(&launcher, b"[Desktop Entry]").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let none = |_: &Path| UnixModes::None;
        let real = |_: &Path| UnixModes::Real;
        let unknown = |_: &Path| UnixModes::Unknown;
        // A USB stick / SMB share / WSL `/mnt/c`: name only (the window still asks).
        assert_eq!(check_with(&doc, Os::Linux, None, &none), Ok(()));
        assert_eq!(check_with(&doc, Os::MacOs, None, &none), Ok(()));
        assert_eq!(check_with(&launcher, Os::Linux, None, &none).unwrap_err(), REFUSED_LAUNCHER);
        // A Unix filesystem, or one that could not be told: the bit counts.
        assert_eq!(check_with(&doc, Os::Linux, None, &real).unwrap_err(), REFUSED_LAUNCHER);
        assert_eq!(check_with(&doc, Os::Linux, None, &unknown).unwrap_err(), REFUSED_LAUNCHER);
        // The filesystem is asked about only for an executable file.
        std::fs::set_permissions(&doc, std::fs::Permissions::from_mode(0o644)).unwrap();
        let asked = std::cell::Cell::new(false);
        let probe = |_: &Path| {
            asked.set(true);
            UnixModes::Real
        };
        assert_eq!(check_with(&doc, Os::Linux, None, &probe), Ok(()));
        assert!(!asked.get());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_temp_folder_is_on_a_filesystem_with_unix_modes() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(unix_modes_of(&real), UnixModes::Real);
    }
}
