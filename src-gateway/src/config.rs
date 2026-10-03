//! The gateway's configuration, from its unit's environment (and the shared
//! `/etc/<slug>/server.env`). Hosted plan Q8: Tailscale Serve terminates TLS
//! and forwards to loopback, so both listeners must be loopback addresses.

use std::net::SocketAddr;
use std::path::PathBuf;

use crate::wire;

pub const LISTEN_ENV: &str = "GATEWAY_LISTEN";
pub const CONTENT_LISTEN_ENV: &str = "GATEWAY_CONTENT_LISTEN";
pub const STATE_DIR_ENV: &str = "GATEWAY_STATE_DIR";
pub const SOCKET_DIR_ENV: &str = "GATEWAY_SOCKET_DIR";
pub const PWA_DIR_ENV: &str = "GATEWAY_PWA_DIR";
pub const KEEPER_SOCKET_ENV: &str = "GATEWAY_KEEPER_SOCKET";

pub const DEFAULT_LISTEN: &str = "127.0.0.1:8740";
pub const DEFAULT_CONTENT_LISTEN: &str = "127.0.0.1:8741";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayConfig {
    pub listen: SocketAddr,
    /// The user-content origin's listener; `None` when no content origin is
    /// configured (then daemons mint no tickets either).
    pub content_listen: Option<SocketAddr>,
    /// `https://host[:port]`: what devices sign and `Origin` must equal.
    pub origin: String,
    pub content_origin: Option<String>,
    pub state_dir: PathBuf,
    pub socket_dir: PathBuf,
    /// The phone PWA's built files (`mobile-dist`), served before sign-in.
    pub pwa_dir: PathBuf,
    /// The key keeper's socket (`/run/<slug>/auth.sock`): the admin's agent
    /// API keys are offered and withdrawn through it (plan §5.4).
    pub keeper_socket: PathBuf,
}

/// `https://host[:port]` with no path; anything else is refused.
pub fn validate_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let rest = trimmed.strip_prefix("https://").ok_or_else(|| format!("not an https origin: {raw}"))?;
    if rest.is_empty() || rest.contains('/') || rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return Err(format!("not an origin: {raw}"));
    }
    if !rest.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']')) {
        return Err(format!("not an origin: {raw}"));
    }
    Ok(trimmed.to_ascii_lowercase())
}

/// `https://host[:port]` → `host[:port]`.
pub fn host_of(origin: &str) -> &str {
    origin.split_once("://").map(|(_, rest)| rest).unwrap_or(origin)
}

impl GatewayConfig {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(crate::brand::env)
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let name = |n: &str| crate::brand::CURRENT.env_name(n);
        let get = |n: &str| lookup(n).filter(|v| !v.trim().is_empty());
        let loopback = |n: &str, default: &str| -> Result<SocketAddr, String> {
            let raw = get(n).unwrap_or_else(|| default.to_string());
            let addr: SocketAddr = raw.trim().parse().map_err(|_| format!("{} is not an address: {raw}", name(n)))?;
            if !addr.ip().is_loopback() {
                return Err(format!("{} must be a loopback address (Tailscale Serve fronts the gateway): {raw}", name(n)));
            }
            Ok(addr)
        };
        let origin = validate_origin(&get(wire::env::ORIGIN).ok_or_else(|| format!("{} is not set", name(wire::env::ORIGIN)))?)?;
        let content_origin = get(wire::env::CONTENT_ORIGIN).map(|o| validate_origin(&o)).transpose()?;
        if content_origin.as_deref() == Some(origin.as_str()) {
            return Err("the user-content origin must differ from the app's origin".into());
        }
        let listen = loopback(LISTEN_ENV, DEFAULT_LISTEN)?;
        let content_listen = match content_origin {
            Some(_) => Some(loopback(CONTENT_LISTEN_ENV, DEFAULT_CONTENT_LISTEN)?),
            None => None,
        };
        if content_listen == Some(listen) {
            return Err("the two listeners need different ports".into());
        }
        Ok(Self {
            listen,
            content_listen,
            origin,
            content_origin,
            state_dir: get(STATE_DIR_ENV).map(PathBuf::from).unwrap_or_else(crate::names::gateway_state_dir),
            socket_dir: get(SOCKET_DIR_ENV).map(PathBuf::from).unwrap_or_else(crate::names::socket_dir),
            pwa_dir: get(PWA_DIR_ENV).map(PathBuf::from).unwrap_or_else(|| crate::names::share_dir().join("mobile-dist")),
            keeper_socket: get(KEEPER_SOCKET_ENV).map(PathBuf::from).unwrap_or_else(crate::names::keeper_socket),
        })
    }

    pub fn public_host(&self) -> &str {
        host_of(&self.origin)
    }

    pub fn policy_path(&self) -> PathBuf {
        self.state_dir.join(crate::policy::POLICY_FILE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    #[test]
    fn the_config_is_loopback_https_and_two_origins() {
        let ok = GatewayConfig::from_lookup(env(&[(wire::env::ORIGIN, "https://Desk.example.ts.net/"), (wire::env::CONTENT_ORIGIN, "https://desk.example.ts.net:8443")])).unwrap();
        assert_eq!(ok.origin, "https://desk.example.ts.net");
        assert_eq!(ok.public_host(), "desk.example.ts.net");
        assert_eq!(ok.listen.to_string(), DEFAULT_LISTEN);
        assert_eq!(ok.content_listen.unwrap().to_string(), DEFAULT_CONTENT_LISTEN);
        assert!(GatewayConfig::from_lookup(env(&[])).unwrap_err().contains("SERVER_ORIGIN"));
        assert!(GatewayConfig::from_lookup(env(&[(wire::env::ORIGIN, "http://desk.example.ts.net")])).is_err());
        assert!(GatewayConfig::from_lookup(env(&[(wire::env::ORIGIN, "https://desk.example.ts.net/path")])).is_err());
        assert!(GatewayConfig::from_lookup(env(&[(wire::env::ORIGIN, "https://desk.example.ts.net"), (LISTEN_ENV, "0.0.0.0:8740")])).unwrap_err().contains("loopback"));
        assert!(GatewayConfig::from_lookup(env(&[(wire::env::ORIGIN, "https://a.example"), (wire::env::CONTENT_ORIGIN, "https://a.example")])).is_err());
        let plain = GatewayConfig::from_lookup(env(&[(wire::env::ORIGIN, "https://a.example")])).unwrap();
        assert_eq!(plain.content_listen, None);
    }
}
