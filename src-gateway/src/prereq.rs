//! The deployment prerequisites of hosted plan §8, checked at install and in
//! P3's exit (`<slug>-admin-helper check`). Read-only; runs unprivileged.
//!
//! Every check goes through [`Probe`], so the tests feed it a fake machine.

use std::path::{Path, PathBuf};

use crate::brand::SLUG;
use crate::names;

/// What the checks read of the machine.
pub trait Probe {
    fn read(&self, path: &Path) -> Option<String>;
    /// `(mode, uid)` of a path, not following a final symlink.
    fn mode_owner(&self, path: &Path) -> Option<(u32, u32)>;
    /// Run a command; `Ok(stdout)` on exit 0, `Err(stderr or why)` else.
    fn run(&self, argv: &[&str]) -> Result<String, String>;
    /// Is the check running as root (`sudo … check`, the isolation test)?
    fn is_root(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub id: &'static str,
    pub verdict: Verdict,
    pub detail: String,
}

fn check(id: &'static str, verdict: Verdict, detail: impl Into<String>) -> Check {
    Check { id, verdict, detail: detail.into() }
}

/// Unprivileged user namespaces, as bubblewrap needs them: the sysctls, then
/// bubblewrap itself (the AppArmor restriction only shows when it runs).
/// Run as root, the probe drops to `nobody` first: root may always open a
/// user namespace, so a root probe would pass on a machine where every
/// user's agent fails closed.
pub fn userns(p: &dyn Probe) -> Check {
    let num = |path: &str| p.read(Path::new(path)).and_then(|s| s.trim().parse::<i64>().ok());
    if num("/proc/sys/kernel/unprivileged_userns_clone") == Some(0) {
        return check("userns", Verdict::Fail, "kernel.unprivileged_userns_clone = 0: every agent would fail closed");
    }
    if num("/proc/sys/user/max_user_namespaces") == Some(0) {
        return check("userns", Verdict::Fail, "user.max_user_namespaces = 0");
    }
    const PROBE: [&str; 6] = ["bwrap", "--unshare-user", "--ro-bind", "/", "/", "true"];
    let as_nobody: Vec<&str> = ["runuser", "-u", "nobody", "--"].into_iter().chain(PROBE).collect();
    match p.run(if p.is_root() { &as_nobody } else { &PROBE }) {
        Ok(_) => check("userns", Verdict::Ok, "bubblewrap starts an unprivileged user namespace"),
        Err(e) => {
            let apparmor = num("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") == Some(1);
            check(
                "userns",
                Verdict::Fail,
                if apparmor {
                    format!("bubblewrap failed ({e}); kernel.apparmor_restrict_unprivileged_userns = 1 needs a bwrap AppArmor profile")
                } else {
                    format!("bubblewrap failed: {e}")
                },
            )
        }
    }
}

/// `/proc` mounted `hidepid=invisible` (or `2`).
pub fn hidepid(p: &dyn Probe) -> Check {
    let mounts = p.read(Path::new("/proc/self/mounts")).unwrap_or_default();
    let proc_line = mounts.lines().find(|l| {
        let mut f = l.split_whitespace();
        f.next() == Some("proc") && f.next() == Some("/proc")
    });
    match proc_line {
        Some(line) if line.contains("hidepid=invisible") || line.contains("hidepid=2") => check("hidepid", Verdict::Ok, "/proc is hidepid=invisible"),
        Some(_) => check("hidepid", Verdict::Fail, "/proc is not mounted hidepid=invisible: users see each other's processes and command lines"),
        None => check("hidepid", Verdict::Fail, "no /proc mount found"),
    }
}

/// `kernel.yama.ptrace_scope >= 1`.
pub fn ptrace_scope(p: &dyn Probe) -> Check {
    match p.read(Path::new("/proc/sys/kernel/yama/ptrace_scope")).and_then(|s| s.trim().parse::<u32>().ok()) {
        Some(v) if v >= 1 => check("ptrace_scope", Verdict::Ok, format!("kernel.yama.ptrace_scope = {v}")),
        Some(v) => check("ptrace_scope", Verdict::Fail, format!("kernel.yama.ptrace_scope = {v}: a user's processes could read the daemon's memory")),
        None => check("ptrace_scope", Verdict::Fail, "Yama is not available"),
    }
}

/// The kernel persistent keyring (`CONFIG_PERSISTENT_KEYRINGS`).
pub fn persistent_keyring(p: &dyn Probe) -> Check {
    match p.read(Path::new("/proc/sys/kernel/keys/persistent_keyring_expiry")) {
        Some(_) => check("persistent_keyring", Verdict::Ok, "the kernel has persistent keyrings"),
        None => check("persistent_keyring", Verdict::Fail, "no persistent keyrings (CONFIG_PERSISTENT_KEYRINGS): the secrets key cannot outlive a daemon restart"),
    }
}

/// The installed daemon and tmux units carry `PrivateTmp=yes`.
pub fn private_tmp(p: &dyn Probe) -> Check {
    let units = [format!("{SLUG}-serverd@.service"), format!("{SLUG}-tmux@.service")];
    let missing: Vec<&str> = units
        .iter()
        .filter(|u| !p.read(&Path::new("/etc/systemd/system").join(u.as_str())).is_some_and(|text| text.lines().any(|l| l.trim() == "PrivateTmp=yes")))
        .map(String::as_str)
        .collect();
    if missing.is_empty() {
        check("private_tmp", Verdict::Ok, "the daemon and tmux units have PrivateTmp=yes")
    } else {
        check("private_tmp", Verdict::Fail, format!("not installed or without PrivateTmp=yes: {}", missing.join(", ")))
    }
}

/// Every server user's home is `0700` (group and other have nothing).
pub fn homes(p: &dyn Probe, homes: &[(String, PathBuf)]) -> Check {
    let open: Vec<String> = homes
        .iter()
        .filter(|(_, home)| p.mode_owner(home).is_none_or(|(mode, _)| mode & 0o077 != 0))
        .map(|(user, home)| format!("{user} ({})", home.display()))
        .collect();
    if open.is_empty() {
        check("homes_0700", Verdict::Ok, format!("{} home(s) are 0700", homes.len()))
    } else {
        check("homes_0700", Verdict::Fail, format!("not 0700 (or missing): {}", open.join(", ")))
    }
}

/// tmux ≥ 3.2 (the tmux unit's `-D`).
pub fn tmux(p: &dyn Probe) -> Check {
    let Ok(out) = p.run(&["tmux", "-V"]) else {
        return check("tmux", Verdict::Fail, "tmux is not installed");
    };
    let version = out.trim().trim_start_matches("tmux ").trim_start_matches("next-");
    let mut parts = version.split(|c: char| !c.is_ascii_digit());
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    if (major, minor) >= (3, 2) {
        check("tmux", Verdict::Ok, out.trim().to_string())
    } else {
        check("tmux", Verdict::Fail, format!("{} is older than 3.2 (the tmux unit needs -D)", out.trim()))
    }
}

/// `/run/<slug>/users` is root's and not open to everyone.
pub fn socket_dir(p: &dyn Probe) -> Check {
    let dir = names::socket_dir();
    match p.mode_owner(&dir) {
        Some((mode, 0)) if mode & 0o002 == 0 && mode & 0o007 == 0 => check("socket_dir", Verdict::Ok, format!("{} is root's, {:o}", dir.display(), mode & 0o777)),
        Some((mode, uid)) => check("socket_dir", Verdict::Fail, format!("{} is uid {uid}'s, {:o}: must be root's and closed to others", dir.display(), mode & 0o777)),
        None => check("socket_dir", Verdict::Warn, format!("{} does not exist yet (systemd-tmpfiles creates it at boot)", dir.display())),
    }
}

/// Every check, in order.
pub fn all(p: &dyn Probe, user_homes: &[(String, PathBuf)]) -> Vec<Check> {
    vec![userns(p), hidepid(p), ptrace_scope(p), persistent_keyring(p), private_tmp(p), homes(p, user_homes), tmux(p), socket_dir(p)]
}

/// The real machine.
pub struct System;

impl Probe for System {
    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn mode_owner(&self, path: &Path) -> Option<(u32, u32)> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            std::fs::symlink_metadata(path).ok().map(|m| (m.mode(), m.uid()))
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            None
        }
    }

    fn run(&self, argv: &[&str]) -> Result<String, String> {
        let (program, args) = argv.split_first().ok_or("empty command")?;
        let out = std::process::Command::new(program).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    fn is_root(&self) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: geteuid has no preconditions.
            unsafe { libc::geteuid() == 0 }
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake {
        files: HashMap<PathBuf, String>,
        modes: HashMap<PathBuf, (u32, u32)>,
        commands: HashMap<String, Result<String, String>>,
        root: bool,
    }

    impl Probe for Fake {
        fn read(&self, path: &Path) -> Option<String> {
            self.files.get(path).cloned()
        }
        fn mode_owner(&self, path: &Path) -> Option<(u32, u32)> {
            self.modes.get(path).copied()
        }
        fn run(&self, argv: &[&str]) -> Result<String, String> {
            self.commands.get(argv[0]).cloned().unwrap_or(Err("not found".into()))
        }
        fn is_root(&self) -> bool {
            self.root
        }
    }

    /// Root may always open a user namespace: a root `check` probes bwrap
    /// as `nobody`, or it would pass where every user's fence fails.
    #[test]
    fn the_userns_probe_never_runs_bubblewrap_as_root() {
        let mut f = good();
        f.root = true;
        f.commands.insert("runuser".into(), Err("bwrap: setting up uid map: Permission denied".into()));
        assert_eq!(userns(&f).verdict, Verdict::Fail, "bwrap itself (as root) would have passed");
        f.commands.insert("runuser".into(), Ok(String::new()));
        assert_eq!(userns(&f).verdict, Verdict::Ok);
    }

    fn good() -> Fake {
        let mut f = Fake::default();
        f.files.insert("/proc/self/mounts".into(), "sysfs /sys sysfs rw 0 0\nproc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible 0 0\n".into());
        f.files.insert("/proc/sys/kernel/yama/ptrace_scope".into(), "1\n".into());
        f.files.insert("/proc/sys/kernel/keys/persistent_keyring_expiry".into(), "259200\n".into());
        f.files.insert(PathBuf::from("/etc/systemd/system").join(format!("{SLUG}-serverd@.service")), crate::units::serverd_service());
        f.files.insert(PathBuf::from("/etc/systemd/system").join(format!("{SLUG}-tmux@.service")), crate::units::tmux_service());
        f.modes.insert("/home/alice".into(), (0o40700, 1001));
        f.modes.insert(names::socket_dir(), (0o40750, 0));
        f.commands.insert("bwrap".into(), Ok(String::new()));
        f.commands.insert("tmux".into(), Ok("tmux 3.4\n".into()));
        f
    }

    #[test]
    fn a_prepared_machine_passes_every_check() {
        let checks = all(&good(), &[("alice".into(), "/home/alice".into())]);
        assert!(checks.iter().all(|c| c.verdict == Verdict::Ok), "{checks:#?}");
    }

    #[test]
    fn each_missing_prerequisite_fails_by_name() {
        let homes = [("alice".to_string(), PathBuf::from("/home/alice"))];
        let mut f = good();
        f.files.insert("/proc/self/mounts".into(), "proc /proc proc rw,relatime 0 0\n".into());
        f.files.insert("/proc/sys/kernel/yama/ptrace_scope".into(), "0".into());
        f.files.remove(Path::new("/proc/sys/kernel/keys/persistent_keyring_expiry"));
        f.files.insert(PathBuf::from("/etc/systemd/system").join(format!("{SLUG}-tmux@.service")), "[Service]\n".into());
        f.modes.insert("/home/alice".into(), (0o40755, 1001));
        f.modes.insert(names::socket_dir(), (0o40777, 0));
        f.commands.insert("bwrap".into(), Err("setting up uid map: Permission denied".into()));
        f.files.insert("/proc/sys/kernel/apparmor_restrict_unprivileged_userns".into(), "1".into());
        f.commands.insert("tmux".into(), Ok("tmux 3.0a".into()));
        let failed: Vec<&str> = all(&f, &homes).iter().filter(|c| c.verdict == Verdict::Fail).map(|c| c.id).collect();
        assert_eq!(failed, ["userns", "hidepid", "ptrace_scope", "persistent_keyring", "private_tmp", "homes_0700", "tmux", "socket_dir"]);
        assert!(userns(&f).detail.contains("AppArmor"));
        f.files.insert("/proc/sys/kernel/unprivileged_userns_clone".into(), "0".into());
        assert!(userns(&f).detail.contains("unprivileged_userns_clone"));
    }
}
