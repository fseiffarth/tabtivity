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
use std::sync::OnceLock;

use crate::brand;
use crate::services::core_dispatch::Role;

#[cfg(unix)]
pub mod daemon;

pub const MODE_ENV: &str = "SERVER_MODE";
pub const SOCKET_ENV: &str = "SERVER_SOCKET";
pub const GATEWAY_UID_ENV: &str = "SERVER_GATEWAY_UID";
pub const ORIGIN_ENV: &str = "SERVER_ORIGIN";
pub const CONTENT_ORIGIN_ENV: &str = "SERVER_CONTENT_ORIGIN";
pub const TMUX_SOCKET_ENV: &str = "TMUX_SOCKET";
pub const CLI_ROOT_ENV: &str = "SERVER_CLI_ROOT";
/// The account this daemon serves, by name — what a pairing code is prefixed
/// with so the gateway can route a new device's `pair` (`user:code`).
pub const USER_ENV: &str = "SERVER_USER";

/// The account the gateway routed this request for (its user name).
pub const USER_HEADER: &str = "x-gateway-user";
/// `admin` or `user`: the account's role in the gateway's table.
pub const ROLE_HEADER: &str = "x-gateway-role";
/// The device id the gateway's routing cookie names, when it has one.
pub const DEVICE_HEADER: &str = "x-gateway-device";

/// Is this process a per-user server daemon? Read once: the unit sets it
/// before start, and nothing flips it at run time.
pub fn is_server() -> bool {
    static MODE: OnceLock<bool> = OnceLock::new();
    *MODE.get_or_init(|| brand::env(MODE_ENV).as_deref() == Some("1"))
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
        Some(user) => format!("{user}:{code}"),
        None => code.to_string(),
    }
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
}
