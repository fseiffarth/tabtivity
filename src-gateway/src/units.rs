//! The server's systemd units, slices and runtime directories (hosted plan
//! §3.1, §8), rendered as text the helper writes and the tests snapshot.
//!
//! Deviations from §3.1's sketch, each for a reason:
//! * **Socket activation** starts a user's daemon: `<slug>-serverd@.socket`
//!   holds `/run/<slug>/users/<user>.sock` (`root:<slug>-gw 0660`), so the
//!   gateway never needs a root verb to start one, and no user can squat
//!   another's socket path (the directory is root's).
//! * **Slices nest by name**: `<slug>-users-<user>.slice` is a child of
//!   `<slug>-users.slice` (systemd reads the dash as nesting); per-user
//!   limits live in that file, which `user-add` writes.
//! * The daemon unit joins the tmux unit's namespaces (`JoinsNamespaceOf=`),
//!   so both see one private `/tmp`; tmux's socket lives in
//!   `/run/<slug>/tmux/<user>` (`TMUX_TMPDIR`), the tmux unit's runtime dir.
//! * No `ProtectSystem=`, `ProtectHome=`, `RestrictNamespaces=` or
//!   `NoNewPrivileges=` on the daemon or tmux units: the agent fence
//!   (bubblewrap) needs user namespaces and the user's home (§8).

use std::path::PathBuf;

use crate::brand::{self, DISPLAY, SLUG};
use crate::names;
use crate::wire;

/// What `install` writes: `(path, contents, mode)`.
pub type Rendered = Vec<(PathBuf, String, u32)>;

/// Per-user resource limits, validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// `MemoryMax=`: bytes with a K/M/G/T suffix, or a percentage.
    pub memory_max: String,
    pub tasks_max: u32,
    pub cpu_weight: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self { memory_max: "8G".into(), tasks_max: 4096, cpu_weight: 100 }
    }
}

impl Limits {
    pub fn validate(&self) -> Result<(), String> {
        let m = self.memory_max.as_str();
        let (digits, suffix) = m.split_at(m.find(|c: char| !c.is_ascii_digit()).unwrap_or(m.len()));
        let ok = !digits.is_empty() && digits.len() <= 12 && matches!(suffix, "" | "K" | "M" | "G" | "T" | "%") && (suffix != "%" || digits.parse::<u32>().is_ok_and(|p| (1..=100).contains(&p)));
        if !ok {
            return Err(format!("not a memory limit: {m:?} (e.g. 8G or 25%)"));
        }
        if !(16..=1_000_000).contains(&self.tasks_max) {
            return Err(format!("tasks limit out of range: {}", self.tasks_max));
        }
        if !(1..=10_000).contains(&self.cpu_weight) {
            return Err(format!("CPU weight out of range: {}", self.cpu_weight));
        }
        Ok(())
    }
}

/// The deployment's facts the shared environment file carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deployment {
    pub origin: String,
    pub content_origin: Option<String>,
    pub gateway_uid: u32,
}

fn unit_dir() -> PathBuf {
    PathBuf::from("/etc/systemd/system")
}

fn env(name: &str) -> String {
    brand::CURRENT.env_name(name)
}

/// `/etc/<slug>/server.env`: read by the gateway and every daemon.
pub fn server_env(d: &Deployment) -> String {
    let mut out = format!("# {DISPLAY} server: written by the admin helper's `install`; edit with it.\n");
    out.push_str(&format!("{}={}\n", env(wire::env::ORIGIN), d.origin));
    if let Some(content) = &d.content_origin {
        out.push_str(&format!("{}={content}\n", env(wire::env::CONTENT_ORIGIN)));
    }
    out.push_str(&format!("{}={}\n", env(wire::env::GATEWAY_UID), d.gateway_uid));
    out.push_str(&format!("{}={}\n", env(wire::env::POLICY_FILE), names::gateway_state_dir().join(crate::policy::POLICY_FILE).display()));
    out.push_str(&format!("{}={}\n", env(wire::env::CLI_ROOT), names::cli_root().display()));
    out.push_str(&format!("{}={}\n", env("WEB_DIST"), names::share_dir().join("web-dist").display()));
    out
}

pub fn gateway_service() -> String {
    format!(
        "[Unit]\n\
Description={DISPLAY} gateway\n\
After=network-online.target\n\
Wants=network-online.target\n\
\n\
[Service]\n\
Type=simple\n\
User={gw}\n\
Group={gw}\n\
EnvironmentFile={env}\n\
Environment={pwa}={share}/mobile-dist\n\
ExecStart={bin} serve\n\
StateDirectory={state}\n\
StateDirectoryMode=0755\n\
Restart=on-failure\n\
RestartSec=2\n\
# Two descriptors per forwarded connection (server::MAX_CONNECTIONS of them).\n\
LimitNOFILE=8192\n\
NoNewPrivileges=yes\n\
ProtectSystem=strict\n\
ProtectHome=yes\n\
PrivateTmp=yes\n\
PrivateDevices=yes\n\
ProtectKernelTunables=yes\n\
ProtectKernelModules=yes\n\
ProtectControlGroups=yes\n\
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\
RestrictNamespaces=yes\n\
LockPersonality=yes\n\
MemoryDenyWriteExecute=yes\n\
SystemCallArchitectures=native\n\
CapabilityBoundingSet=\n\
\n\
[Install]\n\
WantedBy=multi-user.target\n",
        gw = names::gateway_account(),
        env = names::server_env_file().display(),
        pwa = env(crate::config::PWA_DIR_ENV),
        share = names::share_dir().display(),
        bin = names::gateway_binary().display(),
        state = names::gateway_state_dir().file_name().and_then(|n| n.to_str()).unwrap_or_default(),
    )
}

pub fn population_slice() -> String {
    format!(
        "[Unit]\nDescription={DISPLAY} users, all together\nBefore=slices.target\n\n[Slice]\n# The ceiling for the whole population; each user's own slice nests below.\nMemoryMax=90%\nCPUWeight=100\n"
    )
}

pub fn user_slice(user: &str, limits: &Limits) -> String {
    format!(
        "[Unit]\nDescription={DISPLAY} user {user}\nBefore=slices.target\n\n[Slice]\nMemoryMax={}\nTasksMax={}\nCPUWeight={}\n",
        limits.memory_max, limits.tasks_max, limits.cpu_weight
    )
}

pub fn serverd_socket() -> String {
    format!(
        "[Unit]\n\
Description={DISPLAY} daemon socket for %i\n\
\n\
[Socket]\n\
ListenStream={dir}/%i.sock\n\
SocketUser=root\n\
SocketGroup={gw}\n\
SocketMode=0660\n\
DirectoryMode=0755\n\
Accept=no\n\
\n\
[Install]\n\
WantedBy=sockets.target\n",
        dir = names::socket_dir().display(),
        gw = names::gateway_account(),
    )
}

pub fn serverd_service() -> String {
    let tmux = format!("{}tmux@%i.service", brand::SERVER_ACCOUNT_PREFIX);
    let socket = format!("{}serverd@%i.socket", brand::SERVER_ACCOUNT_PREFIX);
    format!(
        "[Unit]\n\
Description={DISPLAY} daemon for %i\n\
Requires={socket} {tmux}\n\
After={socket} {tmux} network-online.target\n\
Wants=network-online.target\n\
JoinsNamespaceOf={tmux}\n\
\n\
[Service]\n\
Type=simple\n\
User=%i\n\
Slice={prefix}users-%i.slice\n\
EnvironmentFile={envfile}\n\
Environment={mode}=1 {user}=%i {sock}={dir}/%i.sock {tmuxsock}={SLUG} TMUX_TMPDIR={tmuxdir}/%i\n\
WorkingDirectory=~\n\
ExecStart={bin}\n\
Restart=on-failure\n\
RestartSec=2\n\
PrivateTmp=yes\n\
# No ProtectSystem=/ProtectHome=/RestrictNamespaces=/NoNewPrivileges=: the\n\
# agent fence (bubblewrap) needs user namespaces and the user's home.\n",
        prefix = brand::SERVER_ACCOUNT_PREFIX,
        envfile = names::server_env_file().display(),
        mode = env(wire::env::MODE),
        user = env(wire::env::USER),
        sock = env(wire::env::SOCKET),
        dir = names::socket_dir().display(),
        tmuxsock = env(wire::env::TMUX_SOCKET),
        tmuxdir = names::tmux_dir("x").parent().map(|p| p.display().to_string()).unwrap_or_default(),
        bin = names::serverd_binary().display(),
    )
}

/// The key keeper's socket (plan §5.4, P3b): systemd makes it in the
/// root-owned `/run/<slug>`, so nobody can squat the path; `0666` because the
/// keeper decides by each caller's uid (`keeper::Peers`), and the gateway's
/// account and every server user must reach it. Fenced agents never do: the
/// fence mounts a fresh tmpfs over `/run`.
pub fn keeper_socket() -> String {
    format!(
        "[Unit]\n\
Description={DISPLAY} key keeper socket\n\
\n\
[Socket]\n\
ListenStream={path}\n\
SocketUser=root\n\
SocketGroup=root\n\
SocketMode=0666\n\
DirectoryMode=0755\n\
Accept=no\n\
\n\
[Install]\n\
WantedBy=sockets.target\n",
        path = names::keeper_socket().display(),
    )
}

/// The key keeper: the administrator's agent API keys, `0600` in its own
/// `0700` state directory, as `<slug>-auth`. It runs no fence and needs no
/// network, so it is hardened like the gateway and more (`PrivateNetwork=`,
/// unix sockets only).
pub fn keeper_service() -> String {
    format!(
        "[Unit]\n\
Description={DISPLAY} key keeper (the administrator's agent API keys)\n\
Requires={socket}\n\
After={socket}\n\
\n\
[Service]\n\
Type=simple\n\
User={auth}\n\
Group={auth}\n\
ExecStart={bin} keeper\n\
StateDirectory={state}\n\
StateDirectoryMode=0700\n\
UMask=0077\n\
Restart=on-failure\n\
RestartSec=2\n\
NoNewPrivileges=yes\n\
ProtectSystem=strict\n\
ProtectHome=yes\n\
PrivateTmp=yes\n\
PrivateDevices=yes\n\
PrivateNetwork=yes\n\
ProtectProc=invisible\n\
ProtectKernelTunables=yes\n\
ProtectKernelModules=yes\n\
ProtectControlGroups=yes\n\
RestrictAddressFamilies=AF_UNIX\n\
RestrictNamespaces=yes\n\
LockPersonality=yes\n\
MemoryDenyWriteExecute=yes\n\
SystemCallArchitectures=native\n\
CapabilityBoundingSet=\n",
        socket = names::keeper_unit("socket"),
        auth = names::auth_account(),
        bin = names::gateway_binary().display(),
        state = names::keeper_state_dir().file_name().and_then(|n| n.to_str()).unwrap_or_default(),
    )
}

/// The drop-in giving a system unit the `/proc` exception group.
pub fn proc_dropin() -> String {
    format!("# {DISPLAY}: /proc is hidepid=invisible; this service must see every process.\n[Service]\nSupplementaryGroups={}\n", names::proc_group())
}

/// The `/etc/fstab` line for `/proc` with the exception group's gid.
pub fn proc_fstab_line(gid: u32) -> String {
    format!("proc /proc proc defaults,nosuid,nodev,noexec,hidepid=invisible,gid={gid} 0 0")
}

pub fn tmux_service() -> String {
    let tmuxdir = names::tmux_dir("x").parent().map(|p| p.display().to_string()).unwrap_or_default();
    let runtime = tmuxdir.trim_start_matches("/run/").to_string();
    format!(
        "[Unit]\n\
Description={DISPLAY} tmux server for %i\n\
\n\
[Service]\n\
Type=simple\n\
User=%i\n\
Slice={prefix}users-%i.slice\n\
Environment=TMUX_TMPDIR={tmuxdir}/%i\n\
RuntimeDirectory={runtime}/%i\n\
RuntimeDirectoryMode=0700\n\
RuntimeDirectoryPreserve=yes\n\
WorkingDirectory=~\n\
# -D: stay in the foreground, keep running with no sessions (tmux >= 3.2).\n\
ExecStart=/usr/bin/tmux -L {SLUG} -D\n\
Restart=on-failure\n\
PrivateTmp=yes\n\
KillMode=control-group\n",
        prefix = brand::SERVER_ACCOUNT_PREFIX,
    )
}

pub fn tmpfiles() -> String {
    format!(
        "# {DISPLAY} server runtime directories.\nd /run/{SLUG} 0755 root root -\nd {users} 0750 root {gw} -\nd /run/{SLUG}/tmux 0755 root root -\n",
        users = names::socket_dir().display(),
        gw = names::gateway_account(),
    )
}

/// Everything `install` writes, with its mode.
pub fn render_all(d: &Deployment) -> Rendered {
    let unit = |name: String| unit_dir().join(name);
    let prefix = brand::SERVER_ACCOUNT_PREFIX;
    vec![
        (names::server_env_file(), server_env(d), 0o644),
        (unit(names::gateway_unit()), gateway_service(), 0o644),
        (unit(names::population_slice()), population_slice(), 0o644),
        (unit(format!("{prefix}serverd@.socket")), serverd_socket(), 0o644),
        (unit(format!("{prefix}serverd@.service")), serverd_service(), 0o644),
        (unit(format!("{prefix}tmux@.service")), tmux_service(), 0o644),
        (PathBuf::from("/etc/tmpfiles.d").join(format!("{SLUG}.conf")), tmpfiles(), 0o644),
        (unit(names::keeper_unit("socket")), keeper_socket(), 0o644),
        (unit(names::keeper_unit("service")), keeper_service(), 0o644),
    ]
}

pub fn user_slice_path(user: &str) -> PathBuf {
    unit_dir().join(names::user_slice(user))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deployment() -> Deployment {
        Deployment { origin: "https://desk.example.ts.net".into(), content_origin: Some("https://desk.example.ts.net:8443".into()), gateway_uid: 990 }
    }

    #[test]
    fn the_daemon_units_keep_the_fence_working_and_share_tmp_with_tmux() {
        let service = serverd_service();
        for needed in ["User=%i", "PrivateTmp=yes", "JoinsNamespaceOf=", &format!("{}=1", env(wire::env::MODE)), &format!("TMUX_TMPDIR=/run/{SLUG}/tmux/%i")] {
            assert!(service.contains(needed), "{needed} missing:\n{service}");
        }
        for forbidden in ["\nProtectSystem=", "\nProtectHome=", "\nRestrictNamespaces=", "\nNoNewPrivileges="] {
            assert!(!service.contains(forbidden), "{forbidden} would break bubblewrap");
        }
        let tmux = tmux_service();
        assert!(tmux.contains(&format!("-L {SLUG} -D")) && tmux.contains("PrivateTmp=yes") && tmux.contains("RuntimeDirectoryMode=0700"));
        assert!(serverd_socket().contains("SocketMode=0660") && serverd_socket().contains(&format!("SocketGroup={SLUG}-gw")));
        assert!(gateway_service().contains("ProtectSystem=strict"), "the gateway runs no fence; harden it");
        assert!(gateway_service().contains("\nLimitNOFILE=8192\n"), "room for server::MAX_CONNECTIONS forwarded connections");
    }

    #[test]
    fn the_install_set_is_complete_and_the_env_file_names_the_deployment() {
        let all = render_all(&deployment());
        assert_eq!(all.len(), 9);
        let env_file = &all[0].1;
        assert!(env_file.contains("SERVER_ORIGIN=https://desk.example.ts.net\n"), "{env_file}");
        assert!(env_file.contains("SERVER_GATEWAY_UID=990\n"));
        assert!(env_file.contains(&format!("SERVER_CLI_ROOT=/opt/{SLUG}/agents")));
        assert!(tmpfiles().contains(&format!("d /run/{SLUG}/users 0750 root {SLUG}-gw")));
        assert!(all.iter().all(|(p, _, mode)| p.is_absolute() && *mode == 0o644));
    }

    #[test]
    fn the_key_keeper_is_its_own_hardened_account_on_a_root_made_socket() {
        let socket = keeper_socket();
        assert!(socket.contains(&format!("ListenStream=/run/{SLUG}/auth.sock\n")) && socket.contains("SocketUser=root\n") && socket.contains("SocketMode=0666\n"), "{socket}");
        let service = keeper_service();
        for needed in ["StateDirectoryMode=0700\n", &format!("User={SLUG}-auth\n"), &format!("StateDirectory={SLUG}-auth\n"), "UMask=0077\n", "PrivateNetwork=yes\n", "RestrictAddressFamilies=AF_UNIX\n", "ProtectSystem=strict\n", "-gateway keeper\n"] {
            assert!(service.contains(needed), "{needed} missing:\n{service}");
        }
    }

    #[test]
    fn limits_are_validated() {
        assert!(Limits::default().validate().is_ok());
        for (m, ok) in [("16G", true), ("25%", true), ("512M", true), ("0%", false), ("101%", false), ("8 G", false), ("G", false), ("8Gb", false)] {
            let l = Limits { memory_max: m.into(), ..Limits::default() };
            assert_eq!(l.validate().is_ok(), ok, "{m}");
        }
        assert!(Limits { tasks_max: 1, ..Limits::default() }.validate().is_err());
        assert!(user_slice("alice", &Limits::default()).contains("MemoryMax=8G\nTasksMax=4096\nCPUWeight=100"));
    }
}
