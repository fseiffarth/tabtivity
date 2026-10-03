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

/// A group's gid and members from `/etc/group`.
fn group_entry(p: &dyn Probe, name: &str) -> Option<(u32, Vec<String>)> {
    let text = p.read(Path::new("/etc/group"))?;
    text.lines().find_map(|line| {
        let mut f = line.split(':');
        (f.next()? == name).then_some(())?;
        let gid = f.nth(1)?.parse().ok()?;
        let members = f.next().unwrap_or("").split(',').filter(|m| !m.is_empty()).map(str::to_string).collect();
        Some((gid, members))
    })
}

/// Does the machine run a graphical session (a display manager)? Then it
/// is someone's desktop, and polkit must see every process.
pub fn graphical(p: &dyn Probe) -> bool {
    p.run(&["systemctl", "is-active", "display-manager.service"]).is_ok_and(|out| out.trim() == "active")
}

/// `/proc` mounted `hidepid=invisible` (or `2`). On a machine with a
/// graphical session it also needs `gid=` the exception group
/// (`names::proc_group`) and polkit in that group by its drop-in, or a
/// desktop session's authorizations break (user decision 2026-10-03).
pub fn hidepid(p: &dyn Probe) -> Check {
    let mounts = p.read(Path::new("/proc/self/mounts")).unwrap_or_default();
    let proc_line = mounts.lines().find(|l| {
        let mut f = l.split_whitespace();
        f.next() == Some("proc") && f.next() == Some("/proc")
    });
    let Some(line) = proc_line else {
        return check("hidepid", Verdict::Fail, "no /proc mount found");
    };
    let options: Vec<&str> = line.split_whitespace().nth(3).unwrap_or("").split(',').collect();
    if !options.iter().any(|o| *o == "hidepid=invisible" || *o == "hidepid=2") {
        return check("hidepid", Verdict::Fail, "/proc is not mounted hidepid=invisible: users see each other's processes and command lines");
    }
    if !graphical(p) {
        return check("hidepid", Verdict::Ok, "/proc is hidepid=invisible (no graphical session)");
    }
    let group = names::proc_group();
    let mount_gid = options.iter().find_map(|o| o.strip_prefix("gid=")).and_then(|g| g.parse::<u32>().ok());
    let Some((group_gid, _)) = group_entry(p, &group) else {
        return check("hidepid", Verdict::Fail, format!("a graphical session runs here, and the /proc exception group {group} does not exist: run the helper's install"));
    };
    if mount_gid != Some(group_gid) {
        return check("hidepid", Verdict::Fail, format!("a graphical session runs here: /proc needs gid={group_gid} ({group}) beside hidepid=invisible, or polkit cannot see the session's processes (the install printed the fstab line)"));
    }
    let missing: Vec<String> = names::PROC_EXCEPTION_UNITS
        .iter()
        .filter(|unit| !p.read(&names::proc_dropin(unit)).is_some_and(|text| text.lines().any(|l| l.trim() == format!("SupplementaryGroups={group}"))))
        .map(|unit| unit.to_string())
        .collect();
    if !missing.is_empty() {
        return check("hidepid", Verdict::Fail, format!("a graphical session runs here and {} is not in {group} (no drop-in): run the helper's install", missing.join(", ")));
    }
    check("hidepid", Verdict::Ok, format!("/proc is hidepid=invisible,gid={group_gid}; {} see every process", names::PROC_EXCEPTION_UNITS.join(", ")))
}

/// No server user is in the `/proc` exception group.
pub fn proc_group_members(p: &dyn Probe, users: &[String]) -> Check {
    let group = names::proc_group();
    let members = group_entry(p, &group).map(|(_, m)| m).unwrap_or_default();
    let bad: Vec<&String> = users.iter().filter(|u| members.contains(u)).collect();
    if bad.is_empty() {
        check("proc_group", Verdict::Ok, format!("no server user is in {group}"))
    } else {
        check("proc_group", Verdict::Fail, format!("server users in {group} see every process: {}", bad.iter().map(|u| u.as_str()).collect::<Vec<_>>().join(", ")))
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

/// Rootless Podman for project containers (P5, optional): Podman itself,
/// the setuid `newuidmap`/`newgidmap` (package `uidmap`), and a subordinate
/// uid and gid range for every server user. Only a warning: containers stay
/// off until the administrator switches them on.
pub fn podman(p: &dyn Probe, users: &[String]) -> Check {
    if p.run(&["podman", "--version"]).is_err() {
        return check("podman", Verdict::Warn, "podman is not installed: project containers stay unavailable (optional; apt install podman uidmap)");
    }
    // Setuid or with file capabilities (Ubuntu's): present is what is checked.
    if ["/usr/bin/newuidmap", "/usr/bin/newgidmap"].iter().any(|bin| p.mode_owner(Path::new(bin)).is_none()) {
        return check("podman", Verdict::Warn, "newuidmap/newgidmap are missing (package uidmap): rootless Podman cannot map ids");
    }
    let ranges = |file: &str| p.read(Path::new(file)).unwrap_or_default();
    let (subuid, subgid) = (ranges("/etc/subuid"), ranges("/etc/subgid"));
    let has = |text: &str, user: &str| text.lines().any(|l| l.split(':').next() == Some(user));
    let missing: Vec<&str> = users.iter().map(String::as_str).filter(|u| !has(&subuid, u) || !has(&subgid, u)).collect();
    if missing.is_empty() {
        check("podman", Verdict::Ok, "podman, newuidmap and a subordinate id range for every server user")
    } else {
        check("podman", Verdict::Warn, format!("no subordinate uid/gid range in /etc/subuid, /etc/subgid for: {} (usermod --add-subuids … --add-subgids …)", missing.join(", ")))
    }
}

/// Tailscale Funnel must not publish the gateway (user decision, final
/// review): Serve keeps the sign-in, pairing and content routes on the
/// tailnet; Funnel would put them on the public internet. Fails when any
/// Funnel-enabled HTTPS name proxies (or TCP-forwards) to one of the
/// gateway's loopback listeners — `<PREFIX>GATEWAY_LISTEN` /
/// `GATEWAY_CONTENT_LISTEN` from `server.env`, else 8740/8741.
pub fn funnel(p: &dyn Probe) -> Check {
    let targets = gateway_listeners(p);
    let Ok(out) = p.run(&["tailscale", "serve", "status", "--json"]) else {
        return check("funnel", Verdict::Warn, "`tailscale serve status` did not answer: cannot tell whether Funnel exposes the gateway");
    };
    let Ok(status) = serde_json::from_str::<serde_json::Value>(&out) else {
        return check("funnel", Verdict::Warn, "`tailscale serve status --json` printed no JSON: cannot tell whether Funnel exposes the gateway");
    };
    let exposed = funneled_gateway(&status, &targets);
    if exposed.is_empty() {
        check("funnel", Verdict::Ok, "Tailscale Funnel does not expose the gateway")
    } else {
        check("funnel", Verdict::Fail, format!("Tailscale Funnel exposes the gateway at {} — turn Funnel off for it (`tailscale funnel --https=<port> off`); Serve alone keeps it on the tailnet", exposed.join(", ")))
    }
}

/// The gateway's loopback listeners, `host:port`.
fn gateway_listeners(p: &dyn Probe) -> Vec<String> {
    let env = p.read(&names::server_env_file()).unwrap_or_default();
    let value = |key: &str| {
        env.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(k, _)| k.trim().ends_with(key) && !k.trim().ends_with(&format!("CONTENT_{key}")))
            .map(|(_, v)| v.trim().trim_matches('"').to_string())
            .filter(|v| !v.is_empty())
    };
    vec![
        value(crate::config::LISTEN_ENV).unwrap_or_else(|| crate::config::DEFAULT_LISTEN.to_string()),
        value(crate::config::CONTENT_LISTEN_ENV).unwrap_or_else(|| crate::config::DEFAULT_CONTENT_LISTEN.to_string()),
    ]
}

/// The Funnel-enabled names of `status` that reach one of `targets`.
fn funneled_gateway(status: &serde_json::Value, targets: &[String]) -> Vec<String> {
    let reaches = |target: &str| {
        let bare = target.trim_start_matches("http://").trim_start_matches("https+insecure://").trim_start_matches("https://");
        let bare = bare.split('/').next().unwrap_or(bare);
        let bare = bare.strip_prefix("localhost:").map(|port| format!("127.0.0.1:{port}")).unwrap_or_else(|| bare.to_string());
        targets.contains(&bare)
    };
    let Some(allow) = status.get("AllowFunnel").and_then(serde_json::Value::as_object) else { return Vec::new() };
    let mut exposed: Vec<String> = allow
        .iter()
        .filter(|(_, on)| on.as_bool() == Some(true))
        .filter(|(authority, _)| {
            let web = status.get("Web").and_then(|w| w.get(authority.as_str())).and_then(|s| s.get("Handlers")).and_then(serde_json::Value::as_object);
            let by_web = web.is_some_and(|handlers| handlers.values().filter_map(|h| h.get("Proxy").and_then(serde_json::Value::as_str)).any(reaches));
            let port = authority.rsplit_once(':').map(|(_, port)| port).unwrap_or("443");
            let by_tcp = status.get("TCP").and_then(|t| t.get(port)).and_then(|f| f.get("TCPForward")).and_then(serde_json::Value::as_str).is_some_and(reaches);
            by_web || by_tcp
        })
        .map(|(authority, _)| authority.clone())
        .collect();
    exposed.sort();
    exposed
}

/// Every check, in order.
pub fn all(p: &dyn Probe, user_homes: &[(String, PathBuf)]) -> Vec<Check> {
    let users: Vec<String> = user_homes.iter().map(|(u, _)| u.clone()).collect();
    vec![userns(p), hidepid(p), proc_group_members(p, &users), ptrace_scope(p), persistent_keyring(p), private_tmp(p), homes(p, user_homes), tmux(p), socket_dir(p), funnel(p), podman(p, &users)]
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
        f.commands.insert("podman".into(), Ok("podman version 4.9.3\n".into()));
        f.modes.insert("/usr/bin/newuidmap".into(), (0o100755, 0));
        f.modes.insert("/usr/bin/newgidmap".into(), (0o100755, 0));
        f.files.insert("/etc/subuid".into(), "alice:100000:65536\n".into());
        f.files.insert("/etc/subgid".into(), "alice:100000:65536\n".into());
        f.commands.insert("tailscale".into(), Ok(serve_status(false).to_string()));
        f
    }

    /// `tailscale serve status --json` of a gateway behind Serve, with Funnel
    /// on or off for it.
    fn serve_status(funnel: bool) -> serde_json::Value {
        serde_json::json!({
            "TCP": { "443": { "HTTPS": true }, "8443": { "HTTPS": true } },
            "Web": {
                "desk.example.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8740" } } },
                "desk.example.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8741" } } }
            },
            "AllowFunnel": { "desk.example.ts.net:8443": funnel }
        })
    }

    /// User decision (final review): `check` fails while Funnel publishes
    /// any of the gateway's listeners; another service's Funnel is fine.
    #[test]
    fn funnel_on_the_gateway_fails_the_check() {
        let mut f = good();
        assert_eq!(funnel(&f).verdict, Verdict::Ok);
        f.commands.insert("tailscale".into(), Ok(serve_status(true).to_string()));
        let c = funnel(&f);
        assert!(c.verdict == Verdict::Fail && c.detail.contains("desk.example.ts.net:8443"), "{c:?}");
        let mut other = serve_status(false);
        other["Web"]["blog.example.ts.net:443"] = serde_json::json!({ "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } });
        other["AllowFunnel"]["blog.example.ts.net:443"] = serde_json::json!(true);
        f.commands.insert("tailscale".into(), Ok(other.to_string()));
        assert_eq!(funnel(&f).verdict, Verdict::Ok, "another service may use Funnel");
        // A gateway moved to other ports in server.env is still found.
        let mut moved = serve_status(false);
        moved["Web"]["desk.example.ts.net:443"]["Handlers"]["/"]["Proxy"] = serde_json::json!("http://127.0.0.1:9740");
        moved["AllowFunnel"]["desk.example.ts.net:443"] = serde_json::json!(true);
        f.commands.insert("tailscale".into(), Ok(moved.to_string()));
        assert_eq!(funnel(&f).verdict, Verdict::Ok, "9740 is not the gateway by default");
        f.files.insert(names::server_env_file(), format!("{}={}\n", crate::brand::CURRENT.env_name(crate::config::LISTEN_ENV), "127.0.0.1:9740"));
        assert_eq!(funnel(&f).verdict, Verdict::Fail);
        f.commands.insert("tailscale".into(), Err("not running".into()));
        assert_eq!(funnel(&f).verdict, Verdict::Warn);
    }

    /// P5: rootless Podman is optional — each gap is a warning naming it.
    #[test]
    fn rootless_podman_gaps_are_warnings_that_name_the_fix() {
        let users = ["alice".to_string(), "bob".to_string()];
        let mut f = good();
        let c = podman(&f, &users[..1]);
        assert_eq!(c.verdict, Verdict::Ok, "{c:?}");
        let c = podman(&f, &users);
        assert!(c.verdict == Verdict::Warn && c.detail.contains("bob") && c.detail.contains("--add-subuids"), "{c:?}");
        f.modes.remove(&PathBuf::from("/usr/bin/newgidmap"));
        assert!(podman(&f, &users[..1]).detail.contains("uidmap"));
        f.commands.remove("podman");
        let c = podman(&f, &users[..1]);
        assert!(c.verdict == Verdict::Warn && c.detail.contains("not installed"), "{c:?}");
    }

    #[test]
    fn a_prepared_machine_passes_every_check() {
        let checks = all(&good(), &[("alice".into(), "/home/alice".into())]);
        assert!(checks.iter().all(|c| c.verdict == Verdict::Ok), "{checks:#?}");
    }

    /// Someone's desktop (user decision 2026-10-03): a display manager runs,
    /// so hidepid alone is an error — polkit needs the exception group.
    #[test]
    fn a_desktop_machine_needs_the_proc_exception_group() {
        let group = names::proc_group();
        let mut f = good();
        f.commands.insert("systemctl".into(), Ok("active\n".into()));
        assert_eq!(hidepid(&f).verdict, Verdict::Fail, "no group yet");
        f.files.insert("/etc/group".into(), format!("users:x:100:\n{group}:x:989:\n"));
        assert!(hidepid(&f).detail.contains("gid=989"), "{:?}", hidepid(&f));
        f.files.insert("/proc/self/mounts".into(), "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible,gid=989 0 0\n".into());
        assert!(hidepid(&f).detail.contains("polkit.service"), "the drop-in is missing: {:?}", hidepid(&f));
        f.files.insert(names::proc_dropin("polkit.service"), crate::units::proc_dropin());
        assert_eq!(hidepid(&f).verdict, Verdict::Ok, "{:?}", hidepid(&f));
        // A headless server needs no exception.
        let mut g = good();
        g.commands.insert("systemctl".into(), Err("inactive".into()));
        assert_eq!(hidepid(&g).verdict, Verdict::Ok);
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
        f.files.insert("/etc/group".into(), format!("{}:x:989:alice\n", names::proc_group()));
        let failed: Vec<&str> = all(&f, &homes).iter().filter(|c| c.verdict == Verdict::Fail).map(|c| c.id).collect();
        assert_eq!(failed, ["userns", "hidepid", "proc_group", "ptrace_scope", "persistent_keyring", "private_tmp", "homes_0700", "tmux", "socket_dir"]);
        assert!(userns(&f).detail.contains("AppArmor"));
        f.files.insert("/proc/sys/kernel/unprivileged_userns_clone".into(), "0".into());
        assert!(userns(&f).detail.contains("unprivileged_userns_clone"));
    }
}
