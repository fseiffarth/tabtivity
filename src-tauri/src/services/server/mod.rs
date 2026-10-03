//! Server mode — hosted plan §3.1, §3.6 and §10 P3
//! (`docs/tabtivity_hosted_plan.md`): one machine, several Unix accounts, each
//! with its own **per-user daemon** (`tabtivity-serverd`, [`daemon`]) behind
//! one **gateway** (`src-gateway/`, its own crate: auth routing, the audit log,
//! no core services linked).
//!
//! The daemon is the Mobile sidecar's host (`mobile_control::host`) listening
//! on a unix socket instead of loopback: the same routes for the phone, the
//! same `web_client` transport for the browser, the same headless owner. What
//! server mode changes is written here, in one place, and every switch is an
//! environment variable the daemon's unit sets — nothing in the desktop app
//! ever reads them as set, so the desktop is unchanged:
//!
//! | `<PREFIX>…` | Meaning |
//! |---|---|
//! | `SERVER_MODE=1` | this process serves one account behind the gateway |
//! | `SERVER_SOCKET` | the unix socket to listen on (`/run/<slug>/users/<uid>.sock`) |
//! | `SERVER_GATEWAY_UID` | the uid every connection must come from (`SO_PEERCRED`) |
//! | `SERVER_ORIGIN` | the gateway's public origin (`https://host`), what devices sign |
//! | `SERVER_CONTENT_ORIGIN` | the user-content origin the gateway serves `/content/*` on; unset → no tickets |
//! | `TMUX_SOCKET` | the tmux server name (`tmux -L …`); server mode defaults it to the slug |
//! | `SERVER_CLI_ROOT` | the server-wide, admin-owned CLI install root (§5.1) |
//! | `SERVER_KEEPER_SOCKET` | the key keeper's socket when not `/run/<slug>/auth.sock` (§5.4) |
//!
//! **Trust.** The daemon accepts a connection only from the gateway's uid, so
//! the headers the gateway adds ([`USER_HEADER`], [`ROLE_HEADER`],
//! [`DEVICE_HEADER`]) are the gateway's word — trusted for *routing-level*
//! facts (which account this is, whether the admin made it an admin), never
//! for identity: a device still signs the daemon's own nonce against the key
//! the daemon holds (`mobile_control::auth`), and the gateway cannot mint a
//! pairing code — the invite the admin helper writes into the user's control
//! dir is checked here, not there.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use crate::brand;
use crate::services::core_dispatch::Role;

#[cfg(unix)]
pub mod daemon;
pub mod secrets;
pub mod vault;

/// What the gateway and this daemon agree on, compiled from the gateway's
/// crate so the two cannot drift (headers, env names, name rules).
#[path = "../../../../src-gateway/src/wire.rs"]
pub mod wire;
/// The server-wide policy file the gateway owns (feature switches, the
/// Ollama allowlist), same source as the gateway's.
#[path = "../../../../src-gateway/src/policy.rs"]
pub mod policy;
/// The key keeper's protocol (the administrator's agent API keys, plan
/// §5.4), same source as the gateway's and the keeper's.
#[path = "../../../../src-gateway/src/keys_wire.rs"]
pub mod keys_wire;
pub mod agent_keys;
/// The share hub's protocol (shared projects, plan §6.2), same source as
/// the hub's.
#[path = "../../../../src-gateway/src/hub_wire.rs"]
pub mod hub_wire;
pub mod share;
/// The shared-calendar service's protocol (plan §6.7), same source as the
/// service's.
#[path = "../../../../src-gateway/src/cal_wire.rs"]
pub mod cal_wire;
pub mod shared_calendar;

pub const MODE_ENV: &str = wire::env::MODE;
pub const SOCKET_ENV: &str = wire::env::SOCKET;
pub const GATEWAY_UID_ENV: &str = wire::env::GATEWAY_UID;
pub const ORIGIN_ENV: &str = wire::env::ORIGIN;
pub const CONTENT_ORIGIN_ENV: &str = wire::env::CONTENT_ORIGIN;
pub const TMUX_SOCKET_ENV: &str = wire::env::TMUX_SOCKET;
pub const CLI_ROOT_ENV: &str = wire::env::CLI_ROOT;
/// The account this daemon serves, by name — what a pairing code is prefixed
/// with so the gateway can route a new device's `pair` (`user:code`).
pub const USER_ENV: &str = wire::env::USER;
pub const POLICY_FILE_ENV: &str = wire::env::POLICY_FILE;

pub use wire::{DEVICE_HEADER, ROLE_HEADER, USER_HEADER};

/// Is this process a per-user server daemon? Read once: the unit sets it
/// before start, and nothing flips it at run time.
pub fn is_server() -> bool {
    *SERVER_MODE.get_or_init(|| brand::env(MODE_ENV).as_deref() == Some("1"))
}

static SERVER_MODE: OnceLock<bool> = OnceLock::new();

/// This process is the server's own binary run as a helper of a server
/// tab (the `agent_bin` shim of a shell tab, whose environment comes from
/// tmux, not the daemon's unit): server mode without the unit's variable,
/// for this process only — nothing it starts inherits a marker. Before
/// anything has asked [`is_server`].
pub fn mark_server_process() {
    let _ = SERVER_MODE.set(true);
}

/// The tmux server every spawn, attach and probe uses (`tmux -L <name>`):
/// `<PREFIX>TMUX_SOCKET` when set, the slug in server mode (plan §3.1: a
/// dedicated socket in its own unit, so a user's SSH-started tmux never hosts
/// the app's sessions outside the slice), else the default server as today.
pub fn tmux_socket() -> Option<String> {
    static SOCKET: OnceLock<Option<String>> = OnceLock::new();
    SOCKET
        .get_or_init(|| {
            brand::env(TMUX_SOCKET_ENV)
                .filter(|s| !s.trim().is_empty())
                .or_else(|| is_server().then(|| brand::SLUG.to_string()))
        })
        .clone()
}

/// What the daemon needs to start, all from the unit's environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub state_dir: PathBuf,
    pub socket_path: PathBuf,
    /// The one uid connections may come from; `None` is the daemon's own
    /// (a local test), never "anyone".
    pub gateway_uid: Option<u32>,
    /// The public origin devices sign (`https://host`).
    pub origin: String,
    /// The user-content origin, if the gateway serves one.
    pub content_origin: Option<String>,
}

impl ServerConfig {
    /// Read the unit's environment; `Err` names the first thing missing.
    pub fn from_env(state_dir: PathBuf) -> Result<Self, String> {
        Self::from_lookup(state_dir, brand::env)
    }

    pub fn from_lookup(state_dir: PathBuf, lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let socket_path = lookup(SOCKET_ENV)
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| format!("{} is not set", brand::CURRENT.env_name(SOCKET_ENV)))?;
        let gateway_uid = match lookup(GATEWAY_UID_ENV) {
            Some(raw) if !raw.trim().is_empty() => {
                Some(raw.trim().parse::<u32>().map_err(|_| format!("{} is not a uid: {raw}", brand::CURRENT.env_name(GATEWAY_UID_ENV)))?)
            }
            _ => None,
        };
        let origin = lookup(ORIGIN_ENV)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("{} is not set", brand::CURRENT.env_name(ORIGIN_ENV)))?;
        let origin = crate::services::mobile_control::config::validate_origin(&origin)?;
        let content_origin = match lookup(CONTENT_ORIGIN_ENV).filter(|s| !s.trim().is_empty()) {
            Some(raw) => Some(crate::services::mobile_control::config::validate_origin(&raw)?),
            None => None,
        };
        Ok(Self { state_dir, socket_path, gateway_uid, origin, content_origin })
    }

    /// The gateway's public host (`host[:port]`), what `Host` carries.
    pub fn public_host(&self) -> String {
        host_of(&self.origin)
    }
}

/// `https://host[:port]` → `host[:port]`.
pub fn host_of(origin: &str) -> String {
    origin
        .trim_end_matches('/')
        .split_once("://")
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_else(|| origin.to_string())
}

/// The role the gateway names for this request, trusted only in server mode
/// (the connection came through the peer-checked socket). Missing or unknown
/// → a user: the role fails closed.
pub fn gateway_role(headers: &axum::http::HeaderMap) -> Option<Role> {
    if !is_server() {
        return None;
    }
    Some(gateway_role_in(headers))
}

/// [`gateway_role`] without the mode check — what the daemon's tests call.
pub fn gateway_role_in(headers: &axum::http::HeaderMap) -> Role {
    headers
        .get(ROLE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(Role::parse)
        .unwrap_or(Role::User)
}

/// The account name the unit set, in server mode.
pub fn user_name() -> Option<String> {
    static USER: OnceLock<Option<String>> = OnceLock::new();
    USER.get_or_init(|| is_server().then(|| brand::env(USER_ENV)).flatten().filter(|s| !s.trim().is_empty())).clone()
}

/// A pairing code as the gateway needs it: `user:code` on a server (the
/// gateway routes a new device's `pair` by the prefix and forwards the eight
/// digits), the bare code on the desktop.
pub fn routed_pairing_code(code: &str) -> String {
    match user_name() {
        Some(user) => wire::routed_code(&user, code),
        None => code.to_string(),
    }
}

/// A ticket's path on the user-content origin: `/content/<user>/<ticket>` on
/// a server (the gateway routes by the user), `/content/<ticket>` otherwise.
pub fn content_path(ticket: &str) -> String {
    match user_name() {
        Some(user) => wire::content_path(&user, ticket),
        None => format!("/content/{ticket}"),
    }
}

/// The server-wide policy, in server mode; `None` on the desktop. Re-read
/// at most every few seconds; an unreadable file fails closed
/// ([`policy::Policy::fail_closed`]) and says so once per read.
pub fn server_policy() -> Option<policy::Policy> {
    if !is_server() {
        return None;
    }
    let path = brand::env(POLICY_FILE_ENV).filter(|p| !p.trim().is_empty()).map(PathBuf::from);
    Some(cached(&POLICY_CACHE, || load_policy(path.as_deref())))
}

/// The policy at `path`; no path (the unit's environment lost it) or an
/// unreadable file fails closed, never open — a server daemon without the
/// admin's policy must not fall back to the user's own `settings.json`.
fn load_policy(path: Option<&Path>) -> policy::Policy {
    let Some(path) = path else {
        eprintln!("server policy: {} is not set; switchable features are off", brand::CURRENT.env_name(POLICY_FILE_ENV));
        return policy::Policy::fail_closed();
    };
    policy::Policy::load(path).unwrap_or_else(|error| {
        eprintln!("server policy: {error}; switchable features are off until it reads");
        policy::Policy::fail_closed()
    })
}

static POLICY_CACHE: Mutex<Option<(Instant, policy::Policy)>> = Mutex::new(None);
static USER_OFF_CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
const CACHE_FOR: Duration = Duration::from_secs(3);

fn cached<T: Clone>(slot: &Mutex<Option<(Instant, T)>>, load: impl FnOnce() -> T) -> T {
    let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((at, value)) = slot.as_ref() {
        if at.elapsed() < CACHE_FOR {
            return value.clone();
        }
    }
    let value = load();
    *slot = Some((Instant::now(), value.clone()));
    value
}

/// A feature the admin and the user can switch off (§6.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    Mail,
    Calendar,
    Todo,
}

impl Feature {
    pub fn as_str(self) -> &'static str {
        match self {
            Feature::Mail => "mail",
            Feature::Calendar => "calendar",
            Feature::Todo => "todo",
        }
    }
}

/// Which switch a command answers to. `calendar_load`/`_save` and the alarm
/// claim carry events and tasks alike, so they go only when both are off.
pub fn features_of(cmd: &str) -> &'static [Feature] {
    const MAIL: &[Feature] = &[Feature::Mail];
    const CALENDAR: &[Feature] = &[Feature::Calendar];
    const TODO: &[Feature] = &[Feature::Todo];
    const EITHER: &[Feature] = &[Feature::Calendar, Feature::Todo];
    match cmd {
        "calendar_load" | "calendar_save" | "calendar_alarms_claim" => EITHER,
        "create_task" | "update_task" | "delete_task" | "todo_columns_set" | "todo_move_tasks" => TODO,
        "create_calendar" | "update_calendar" | "delete_calendar" | "restore_calendar" => CALENDAR,
        _ if cmd.starts_with("mail_") => MAIL,
        _ if cmd.starts_with("caldav_") || cmd.starts_with("calendar_") => CALENDAR,
        _ => &[],
    }
}

/// Is `feature` on for this daemon's user: the admin's policy and the user's
/// own switch both allow it. Always on outside server mode.
pub fn feature_on(feature: Feature) -> bool {
    let Some(policy) = server_policy() else { return true };
    let admin = match feature {
        Feature::Mail => policy.features.mail,
        Feature::Calendar => policy.features.calendar,
        Feature::Todo => policy.features.todo,
    };
    admin && !user_disabled_features().iter().any(|f| f == feature.as_str())
}

/// The command's feature switch refuses it: the first feature named, when
/// every feature it answers to is off.
pub fn feature_refusal(cmd: &str) -> Option<Feature> {
    let features = features_of(cmd);
    (!features.is_empty() && features.iter().all(|f| !feature_on(*f))).then(|| features[0])
}

fn user_disabled_features() -> Vec<String> {
    cached(&USER_OFF_CACHE, || {
        crate::storage::read_json::<crate::schema::Settings>(&crate::storage::state_dir().join("settings.json"))
            .map(|s| s.disabled_features)
            .unwrap_or_default()
    })
}

/// The listening socket systemd passed (socket activation: `LISTEN_PID` is
/// this process, `LISTEN_FDS` ≥ 1, the socket is fd 3), if any.
pub fn activation_fd(lookup: impl Fn(&str) -> Option<String>, pid: u32) -> Option<i32> {
    let for_us = lookup("LISTEN_PID").and_then(|p| p.trim().parse::<u32>().ok()) == Some(pid);
    let count = lookup("LISTEN_FDS").and_then(|n| n.trim().parse::<i32>().ok()).unwrap_or(0);
    (for_us && count >= 1).then_some(3)
}

/// The server-wide CLI install root (plan §5.1): `<PREFIX>SERVER_CLI_ROOT`
/// when set, `/opt/<slug>/agents` in server mode, else none (the desktop's
/// per-user install home applies).
pub fn cli_root() -> Option<PathBuf> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        brand::env(CLI_ROOT_ENV)
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| is_server().then(default_cli_root))
    })
    .clone()
}

/// `/opt/<slug>/agents`.
pub fn default_cli_root() -> PathBuf {
    Path::new("/opt").join(brand::SLUG).join("agents")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_config_reads_the_unit_environment_and_fails_closed() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
        };
        let ok = ServerConfig::from_lookup(
            PathBuf::from("/s"),
            env(&[(SOCKET_ENV, "/run/x/users/1001.sock"), (GATEWAY_UID_ENV, "998"), (ORIGIN_ENV, "https://desk.example.ts.net"), (CONTENT_ORIGIN_ENV, "https://desk.example.ts.net:8443")]),
        )
        .unwrap();
        assert_eq!(ok.gateway_uid, Some(998));
        assert_eq!(ok.public_host(), "desk.example.ts.net");
        assert_eq!(ok.content_origin.as_deref(), Some("https://desk.example.ts.net:8443"));
        // No content origin → no tickets, not a guess.
        let plain = ServerConfig::from_lookup(PathBuf::from("/s"), env(&[(SOCKET_ENV, "/tmp/d.sock"), (ORIGIN_ENV, "https://desk.example.ts.net")])).unwrap();
        assert_eq!(plain.content_origin, None);
        assert_eq!(plain.gateway_uid, None);
        assert!(ServerConfig::from_lookup(PathBuf::from("/s"), env(&[(ORIGIN_ENV, "https://desk.example.ts.net")])).unwrap_err().contains("SERVER_SOCKET"));
        assert!(ServerConfig::from_lookup(PathBuf::from("/s"), env(&[(SOCKET_ENV, "/tmp/d.sock")])).unwrap_err().contains("SERVER_ORIGIN"));
        assert!(ServerConfig::from_lookup(PathBuf::from("/s"), env(&[(SOCKET_ENV, "/tmp/d.sock"), (ORIGIN_ENV, "http://plain.example")])).is_err(), "the origin must be https");
        assert!(ServerConfig::from_lookup(PathBuf::from("/s"), env(&[(SOCKET_ENV, "/tmp/d.sock"), (GATEWAY_UID_ENV, "gw"), (ORIGIN_ENV, "https://desk.example.ts.net")])).unwrap_err().contains("not a uid"));
        assert_eq!(host_of("https://desk.example.ts.net:8443/"), "desk.example.ts.net:8443");
    }

    #[test]
    fn the_gateway_role_fails_closed() {
        let mut headers = axum::http::HeaderMap::new();
        assert_eq!(gateway_role_in(&headers), Role::User);
        headers.insert(ROLE_HEADER, "admin".parse().unwrap());
        assert_eq!(gateway_role_in(&headers), Role::Admin);
        headers.insert(ROLE_HEADER, "superuser".parse().unwrap());
        assert_eq!(gateway_role_in(&headers), Role::User);
        // Outside server mode the header is nobody's word.
        assert_eq!(gateway_role(&headers), None);
        assert_eq!(default_cli_root(), Path::new("/opt").join(brand::SLUG).join("agents"));
    }

    #[test]
    fn features_map_commands_and_socket_activation_is_ours_only() {
        assert_eq!(features_of("mail_headers"), [Feature::Mail]);
        assert_eq!(features_of("caldav_fetch"), [Feature::Calendar]);
        assert_eq!(features_of("update_task"), [Feature::Todo]);
        assert_eq!(features_of("calendar_load"), [Feature::Calendar, Feature::Todo]);
        assert!(features_of("dev_todo_read").is_empty() && features_of("pty_write").is_empty());
        // Outside server mode every feature is on.
        assert!(feature_on(Feature::Mail) && feature_refusal("mail_sync").is_none());
        let env = |pid: &'static str, fds: &'static str| move |k: &str| match k {
            "LISTEN_PID" => Some(pid.to_string()),
            "LISTEN_FDS" => Some(fds.to_string()),
            _ => None,
        };
        assert_eq!(activation_fd(env("42", "1"), 42), Some(3));
        assert_eq!(activation_fd(env("41", "1"), 42), None, "another process's sockets");
        assert_eq!(activation_fd(env("42", "0"), 42), None);
        assert_eq!(activation_fd(|_| None, 42), None);
        assert_eq!(content_path("t1"), "/content/t1", "the desktop's path; a server prefixes the user");
    }

    #[test]
    fn a_missing_or_broken_policy_fails_closed() {
        let closed = policy::Policy::fail_closed();
        assert_eq!(load_policy(None), closed, "no policy path in server mode is not 'everything on'");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("policy.json");
        std::fs::write(&file, b"{not json").unwrap();
        assert_eq!(load_policy(Some(&file)), closed);
        assert_eq!(load_policy(Some(&dir.path().join("absent.json"))), policy::Policy::default(), "no file yet: the defaults");
    }
}
