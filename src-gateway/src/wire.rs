//! What the gateway and a per-user daemon must agree on, in one file both
//! compile: the gateway's crate as `app_gateway::wire`, the daemon's
//! (`src-tauri/src/services/server/mod.rs`) by `#[path]`, so the two cannot
//! drift. Plain `std` only, no brand constants (the includer adds those).
//!
//! Hosted plan §3.1, §4.1: the gateway routes each request to one account's
//! daemon socket and tells the daemon, in headers only the gateway can set
//! (the daemon accepts connections from the gateway's uid alone), which
//! account and role the request is for.

#![allow(dead_code)]

/// The account the gateway routed this request for (its user name).
pub const USER_HEADER: &str = "x-gateway-user";
/// `admin` or `user`: the account's role in the gateway's table.
pub const ROLE_HEADER: &str = "x-gateway-role";
/// The device id the gateway's routing cookie names, when it has one.
pub const DEVICE_HEADER: &str = "x-gateway-device";
/// Every header the gateway sets starts with this; it strips any a client
/// sent before adding its own.
pub const HEADER_PREFIX: &str = "x-gateway-";

/// Environment names (without the brand's prefix) the units set.
pub mod env {
    pub const MODE: &str = "SERVER_MODE";
    pub const SOCKET: &str = "SERVER_SOCKET";
    pub const GATEWAY_UID: &str = "SERVER_GATEWAY_UID";
    pub const ORIGIN: &str = "SERVER_ORIGIN";
    pub const CONTENT_ORIGIN: &str = "SERVER_CONTENT_ORIGIN";
    pub const USER: &str = "SERVER_USER";
    pub const TMUX_SOCKET: &str = "TMUX_SOCKET";
    pub const CLI_ROOT: &str = "SERVER_CLI_ROOT";
    /// The server-wide policy file the gateway owns and every daemon reads
    /// (feature switches, the Ollama model allowlist).
    pub const POLICY_FILE: &str = "SERVER_POLICY_FILE";
}

/// Is `name` an account name the server accepts? `^[a-z][a-z0-9_]{0,31}$`:
/// no `-`, because a dash in a slice name means nesting to systemd
/// (`<slug>-users-<name>.slice` must sit directly under `<slug>-users.slice`),
/// no `:` (the routed pairing code's separator), no `.` (the routing cookie's).
pub fn valid_account_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && name.len() <= 32
        && bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

/// A device id as the gateway records it: what the daemon minted, checked,
/// because the daemon is its user's and its answers are untrusted (§4.3).
pub fn valid_device_id(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// `user:code` — the pairing code as the admin helper prints it and a new
/// device types it; the gateway routes by the prefix and forwards the code.
pub fn routed_code(user: &str, code: &str) -> String {
    format!("{user}:{code}")
}

/// Split a routed pairing code; `None` unless the user part is a valid name
/// and the code part is non-empty.
pub fn split_routed_code(raw: &str) -> Option<(&str, &str)> {
    let (user, code) = raw.trim().split_once(':')?;
    (valid_account_name(user) && !code.is_empty()).then_some((user, code))
}

/// The path of a ticketed file on the user-content origin:
/// `/content/<user>/<ticket>`; the gateway strips the user and forwards
/// `/content/<ticket>` to that user's daemon.
pub fn content_path(user: &str, ticket: &str) -> String {
    format!("/content/{user}/{ticket}")
}

/// The daemon socket of `user` under `dir` (`/run/<slug>/users`).
pub fn socket_path(dir: &std::path::Path, user: &str) -> std::path::PathBuf {
    dir.join(format!("{user}.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_names_are_strict() {
        for ok in ["alice", "a", "bob_2", "x23456789012345678901234567890ab"] {
            assert!(valid_account_name(ok), "{ok}");
        }
        for bad in ["", "Alice", "1bob", "al-ice", "al:ice", "al.ice", "root ", "x234567890123456789012345678901ab", "../x"] {
            assert!(!valid_account_name(bad), "{bad}");
        }
    }

    #[test]
    fn routed_codes_round_trip_and_refuse_odd_users() {
        assert_eq!(split_routed_code(&routed_code("alice", "12345678")), Some(("alice", "12345678")));
        assert_eq!(split_routed_code(" bob:1 "), Some(("bob", "1")));
        assert_eq!(split_routed_code("12345678"), None);
        assert_eq!(split_routed_code("Al:1"), None);
        assert_eq!(split_routed_code("al:"), None);
    }

    #[test]
    fn device_ids_are_bounded_and_plain() {
        assert!(valid_device_id("dev_abcdEFGH-123"));
        assert!(!valid_device_id("short"));
        assert!(!valid_device_id("has.dot.in.it.x"));
        assert!(!valid_device_id(&"a".repeat(129)));
    }
}
