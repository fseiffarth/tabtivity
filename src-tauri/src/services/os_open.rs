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
/// Unix a regular file with any execute bit. A folder passes (it opens in
/// the file manager) unless it is a macOS bundle. A path that does not
/// resolve is an error too: the OS could not open it either.
pub fn check(path: &Path) -> Result<(), String> {
    check_for(path, Os::current(), std::env::var("PATHEXT").ok().as_deref())
}

fn check_for(path: &Path, os: Os, pathext: Option<&str>) -> Result<(), String> {
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
        if meta.permissions().mode() & 0o111 != 0 {
            return Err(REFUSED_LAUNCHER.to_string());
        }
    }
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
}
