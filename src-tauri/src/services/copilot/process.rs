//! Installed native CLS inside a filesystem boundary. No host credential stores,
//! inherited tokens, shell resolution, or writable host mounts reach the server.
use std::path::{Path, PathBuf};
use app_core::sync::LockExt;
use std::process::Stdio;
use std::sync::Mutex;
use tokio::process::{Child, ChildStdin, ChildStdout};
use super::rpc::LogSink;

pub const SERVER_VERSION: &str = "1.547.0";

pub fn install_directory() -> PathBuf {
    crate::storage::state_dir().join("copilot").join(SERVER_VERSION)
}

pub fn supported() -> bool {
    cfg!(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))
}

pub fn server_path(installation: &Path) -> Result<PathBuf, String> {
    if !supported() { return Err("copilot_unsupported_platform".into()); }
    let architecture = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let base = installation.canonicalize().map_err(|_| "copilot_not_installed")?;
    let executable = base.join(format!("node_modules/@github/copilot-language-server-linux-{architecture}/copilot-language-server"))
        .canonicalize().map_err(|_| "copilot_not_installed")?;
    if !executable.starts_with(&base) || !executable.is_file() { return Err("copilot_invalid_installation".into()); }
    Ok(executable)
}

pub fn install_command() -> Result<String, String> {
    if !supported() { return Err("copilot_unsupported_platform".into()); }
    let path = crate::quote::posix(&install_directory().to_string_lossy());
    Ok(format!("npm install --prefix {path} --ignore-scripts --no-audit --no-fund @github/copilot-language-server@{SERVER_VERSION}"))
}

/// Pure plan, deliberately much narrower than the general agent fence: no host
/// root/home mount, no shell/user config, no writable project. RAM-only server
/// state disappears with the mount namespace. auth.db is a directory so the
/// pinned CLS uses its inspected in-memory credential repository.
#[cfg(target_os = "linux")]
fn fence_args(executable: &Path, installation: &Path, project: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = [
        "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        // No --clearenv: the bwrap process itself starts from an empty
        // environment plus [`forwarded_env`] (see `launch_installed`).
        "--unshare-user", "--cap-drop", "ALL",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run",
        "--dir", concat!("/run/", crate::app_slug!(), "-copilot/config/github-copilot/auth.db"),
        "--setenv", "XDG_CONFIG_HOME", concat!("/run/", crate::app_slug!(), "-copilot/config"),
        "--setenv", "XDG_CACHE_HOME", concat!("/run/", crate::app_slug!(), "-copilot/cache"),
        "--setenv", "XDG_STATE_HOME", concat!("/run/", crate::app_slug!(), "-copilot/state"),
        "--setenv", "COPILOT_HOME", concat!("/run/", crate::app_slug!(), "-copilot/copilot"),
        "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/bin:/bin",
        "--setenv", "LANG", "C.UTF-8",
    ].iter().map(Into::into).collect();
    // System libraries, CA roots and resolver config only. /etc as a whole can
    // contain VPN and machine credentials, so it is never mounted wholesale.
    for path in ["/usr", "/lib", "/lib64", "/bin", "/etc/ssl", "/etc/pki", "/etc/ca-certificates",
        "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group"] {
        if Path::new(path).exists() {
            args.extend(["--ro-bind".into(), path.into(), path.into()]);
        }
    }
    args.extend(["--ro-bind".into(), installation.as_os_str().into(), installation.as_os_str().into(),
        "--ro-bind".into(), project.as_os_str().into(), project.as_os_str().into(),
        "--chdir".into(), project.as_os_str().into(), "--".into(), executable.as_os_str().into(), "--stdio".into()]);
    args
}

/// The host variables the server may see: the proxy settings (both cases) and
/// extra CA roots, so a network that needs them still reaches GitHub. Set on
/// the bwrap process's own environment, never as `--setenv` arguments: an
/// argument list is readable by every local account, and a proxy address can
/// hold a password. Pure + tested.
const FORWARDED_ENV: &[&str] = &[
    "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

fn forwarded_env(get: impl Fn(&str) -> Option<std::ffi::OsString>) -> Vec<(&'static str, std::ffi::OsString)> {
    FORWARDED_ENV.iter().filter_map(|name| Some((*name, get(name).filter(|value| !value.is_empty())?))).collect()
}

/// Hand each stderr line to the project's log; the task ends with the stream
/// (the process exiting or being killed), so it never outlives the server.
fn drain_stderr(stderr: tokio::process::ChildStderr, log: LogSink) {
    use tokio::io::AsyncBufReadExt;
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log(format!("stderr: {line}"));
        }
    });
}

pub struct ManagedProcess { child: Mutex<Option<Child>> }

impl ManagedProcess {
    pub fn launch(project: &Path, log: Option<LogSink>) -> Result<(Self, ChildStdout, ChildStdin), String> {
        Self::launch_installed(&install_directory(), project, log)
    }

    /// Also used by the standalone probe, with its isolated installation.
    /// `log` receives the server's stderr, line by line; without one it is
    /// discarded.
    pub fn launch_installed(installation: &Path, project: &Path, log: Option<LogSink>)
        -> Result<(Self, ChildStdout, ChildStdin), String> {
        let executable = server_path(installation)?;
        let installation = installation.canonicalize().map_err(|_| "copilot_not_installed")?;
        let project = project.canonicalize().map_err(|_| "copilot_invalid_project")?;
        if !project.is_dir() || installation.starts_with(&project) || crate::storage::state_dir().starts_with(&project) {
            return Err("copilot_invalid_project".into());
        }
        #[cfg(target_os = "linux")]
        let mut command = {
            // Resolve a system fence, not an executable planted in the project.
            let fence = ["/usr/bin/bwrap", "/bin/bwrap"].iter().find(|path| Path::new(path).is_file())
                .ok_or("copilot_fence_unavailable")?;
            let mut command = tokio::process::Command::new(fence);
            command.args(fence_args(&executable, &installation, &project));
            command
        };
        #[cfg(not(target_os = "linux"))]
        let mut command = {
            let _ = (&executable, &installation, &project);
            Err::<tokio::process::Command, _>("copilot_unsupported_platform")?
        };
        command.env_clear().envs(forwarded_env(|name| std::env::var_os(name)))
            .current_dir(&installation).stdin(Stdio::piped()).stdout(Stdio::piped())
            .stderr(if log.is_some() { Stdio::piped() } else { Stdio::null() }).kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| "copilot_spawn_failed")?;
        let output = child.stdout.take().ok_or("copilot_spawn_failed")?;
        let input = child.stdin.take().ok_or("copilot_spawn_failed")?;
        if let (Some(log), Some(stderr)) = (log, child.stderr.take()) {
            drain_stderr(stderr, log);
        }
        Ok((Self { child: Mutex::new(Some(child)) }, output, input))
    }

    pub fn alive(&self) -> bool {
        self.child.lock_ok().as_mut().is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    pub fn stop(&self) {
        let Some(mut child) = self.child.lock_ok().take() else { return; };
        if matches!(child.try_wait(), Ok(None)) {
            if let Some(pid) = child.id() {
                crate::terminal::reap_child_subtree(pid, crate::terminal::ReapMode::Immediate);
            }
            let _ = child.start_kill();
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { let _ = child.wait().await; });
        }
    }
}

impl Drop for ManagedProcess { fn drop(&mut self) { self.stop(); } }

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    fn boundary_has_no_host_writes_or_inherited_credentials() {
        let args = fence_args(Path::new("/state/cls/bin"), Path::new("/state/cls"), Path::new("/project"));
        let args: Vec<_> = args.iter().map(|a| a.to_string_lossy()).collect();
        // The environment is the bwrap process's own (env_clear + the
        // forwarded set), so no host variable rides on the argument list.
        assert!(!args.iter().any(|a| a == "--clearenv"));
        assert!(!args.iter().any(|a| a.contains("proxy") || a.contains("PROXY") || a.contains("CERT")));
        assert!(!args.iter().any(|a| a == "--bind"));
        assert!(!args.windows(3).any(|a| a[0] == "--ro-bind" && a[1] == "/"));
        assert!(args.iter().any(|a| a.ends_with("github-copilot/auth.db")));
        assert!(args.windows(3).any(|a| a == ["--ro-bind", "/project", "/project"]));
    }
    /// B9: exactly the proxy and CA variables reach the fence, nothing else of
    /// the host environment (tokens, HOME, DISPLAY, SSH agent).
    #[test]
    fn only_proxy_and_ca_variables_are_forwarded() {
        let host = |name: &str| -> Option<std::ffi::OsString> {
            match name {
                "HOME" | "GITHUB_TOKEN" | "GH_TOKEN" | "SSH_AUTH_SOCK" | "DISPLAY" => Some("leak".into()),
                "no_proxy" => Some("".into()),
                _ => Some(format!("value-of-{name}").into()),
            }
        };
        let forwarded = forwarded_env(host);
        let names: Vec<&str> = forwarded.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]);
        assert_eq!(forwarded[0].1, std::ffi::OsString::from("value-of-http_proxy"));
        assert!(forwarded_env(|_| None).is_empty());
    }

    #[test]
    fn executable_cannot_escape_installation_via_symlink() {
        let install = tempfile::tempdir().unwrap();
        let architecture = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
        let dir = install.path().join(format!("node_modules/@github/copilot-language-server-linux-{architecture}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink("/bin/true", dir.join("copilot-language-server")).unwrap();
        assert_eq!(server_path(install.path()).unwrap_err(), "copilot_invalid_installation");
    }
}
