//! The key keeper's protocol (hosted plan §5.2, §5.4, P3b): what the
//! gateway, the keeper and a per-user daemon say over the keeper's unix
//! socket, in one file all three compile — the gateway's crate as
//! `app_gateway::keys_wire`, the daemon's by `#[path]`
//! (`services::server::keys_wire`). Plain `std` + `serde` + `sha2` (both
//! crates have it), no brand constants.
//!
//! One request per connection: a JSON line in, a JSON line out. Who may ask
//! what is the keeper's decision from the caller's `SO_PEERCRED` uid, never
//! from anything in the request: the gateway's account offers and withdraws
//! keys (for an administrator the gateway named), a server user's own uid
//! fetches one — when the administrator put that user on the key's list. The
//! key never travels towards the gateway.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The socket's file name in `/run/<slug>`.
pub const SOCKET_NAME: &str = "auth.sock";
/// A request or reply line is never longer (a key is far below it).
pub const MAX_LINE: usize = 16 * 1024;
/// API keys are long random tokens; anything shorter is a typo.
pub const MIN_KEY_LEN: usize = 16;
pub const MAX_KEY_LEN: usize = 1024;
/// Users on one key's list, at most.
pub const MAX_USERS: usize = 1024;
/// Fingerprints of earlier keys the keeper remembers per CLI.
pub const MAX_HISTORY: usize = 32;
/// [`holds_any`] looks at no more than this much of a file.
pub const MAX_SCAN: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Request {
    /// Which CLIs have a key on offer: to a server user, only the keys whose
    /// list names them; to the gateway, every one.
    Offered,
    /// The key itself (a server user's own uid, on the key's list).
    Get { cli: String },
    /// Fingerprints of the current and earlier keys of `cli` (any server
    /// user): enough to tell whether a file holds one, never the key.
    Fingerprints { cli: String },
    /// Replace the list of users who may fetch `cli`'s key (the gateway, for
    /// the administrator `by`).
    Users { cli: String, users: Vec<String>, by: String },
    /// Offer or replace a key (the gateway, for the administrator `by`).
    Set { cli: String, key: String, by: String },
    /// Withdraw a key (the gateway, for the administrator `by`).
    Remove { cli: String, by: String },
    /// Per offered CLI: when, by whom, and who fetched it lately (the
    /// gateway, for the admin panel).
    Status,
}

/// One offered key, without the key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offer {
    pub cli: String,
    /// Unix seconds of the last set.
    pub updated: u64,
}

/// One offered key as the admin panel shows it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyStatus {
    pub cli: String,
    pub updated: u64,
    /// The administrator who set it.
    pub by: String,
    /// Accounts that fetched it in the last [`RECENT_USE_SECS`].
    #[serde(default)]
    pub users: Vec<String>,
    /// Accounts the administrator allows to fetch it; nobody else can.
    #[serde(default)]
    pub allowed: Vec<String>,
}

/// A key's fingerprint: its length and SHA-256 — enough to recognise the key
/// in a file, of no use for calling the provider.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Fingerprint {
    pub len: usize,
    pub sha256: String,
}

pub fn fingerprint(key: &str) -> Fingerprint {
    Fingerprint { len: key.len(), sha256: sha256_hex(key.as_bytes()) }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Does `bytes` contain a key with one of these fingerprints anywhere?
/// `None` when the file is larger than [`MAX_SCAN`] (cannot be told cheaply).
pub fn holds_any(bytes: &[u8], prints: &[Fingerprint]) -> Option<bool> {
    if bytes.len() > MAX_SCAN {
        return None;
    }
    let mut lens: Vec<usize> = prints.iter().map(|p| p.len).filter(|&l| l > 0).collect();
    lens.sort_unstable();
    lens.dedup();
    let found = lens.into_iter().any(|len| {
        bytes.windows(len).any(|w| {
            let hex = sha256_hex(w);
            prints.iter().any(|p| p.len == len && p.sha256 == hex)
        })
    });
    Some(found)
}

/// How far back the admin panel's "used by" looks.
pub const RECENT_USE_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    /// A fixed token (`refused`, `invalid`, `no-key`, `failed`), never text
    /// from the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub offered: Vec<Offer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub status: Vec<KeyStatus>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fingerprints: Vec<Fingerprint>,
}

impl Reply {
    pub fn ok() -> Self {
        Reply { ok: true, ..Reply::default() }
    }

    pub fn error(token: &str) -> Self {
        Reply { ok: false, error: Some(token.to_string()), ..Reply::default() }
    }
}

/// A CLI id as the registry spells it (`claude`, `cursor-agent`): also a
/// directory name under the keeper's state dir, so nothing else passes.
pub fn valid_cli_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
}

/// An API key as vendors issue them: base64url-ish ASCII, no whitespace,
/// quotes or shell metacharacters — it ends up in an environment variable
/// and must never need quoting to stay one token.
pub fn valid_key(key: &str) -> bool {
    (MIN_KEY_LEN..=MAX_KEY_LEN).contains(&key.len())
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'+' | b'/' | b'=' | b':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_and_replies_have_a_stable_shape() {
        let set = Request::Set { cli: "claude".into(), key: "k".into(), by: "alice".into() };
        assert_eq!(serde_json::to_string(&set).unwrap(), r#"{"op":"set","cli":"claude","key":"k","by":"alice"}"#);
        assert_eq!(serde_json::from_str::<Request>(r#"{"op":"offered"}"#).unwrap(), Request::Offered);
        assert!(serde_json::from_str::<Request>(r#"{"op":"get"}"#).is_err());
        assert_eq!(serde_json::to_string(&Reply::error("refused")).unwrap(), r#"{"ok":false,"error":"refused"}"#);
    }

    #[test]
    fn ids_and_keys_are_strict() {
        for ok in ["claude", "cursor-agent", "mini-swe-agent", "a1"] {
            assert!(valid_cli_id(ok), "{ok}");
        }
        for bad in ["", "Claude", "../x", "a/b", "-x", "a.b", &"a".repeat(33)] {
            assert!(!valid_cli_id(bad), "{bad}");
        }
        assert!(valid_key("fake-key-AbCdEf0123456789_-xyz"));
        assert!(valid_key("fakeAIza-0123456789abcdefghijk"));
        for bad in ["short", "sk-has space-0123456789", "sk-quote'0123456789", "sk-newline\n0123456789", "sk-dollar$0123456789"] {
            assert!(!valid_key(bad), "{bad:?}");
        }
        assert!(!valid_key(&"a".repeat(MAX_KEY_LEN + 1)));
    }

    #[test]
    fn a_fingerprint_finds_its_key_anywhere_in_a_file_and_nothing_else() {
        let (old, new) = ("fake-key-OLD0123456789abcdef", "fake-key-NEW0123456789abcdef");
        let prints = [fingerprint(old), fingerprint(new)];
        assert_eq!(prints[0].len, old.len());
        assert!(!prints[0].sha256.contains("OLD"));
        for file in [format!("saved: {old}\n"), format!("{{\"k\":\"{new}\"}}"), old.to_string()] {
            assert_eq!(holds_any(file.as_bytes(), &prints), Some(true), "{file}");
        }
        assert_eq!(holds_any(b"saved: fake-key-USERS0123456789abcd\n", &prints), Some(false));
        assert_eq!(holds_any(&old.as_bytes()[1..], &prints), Some(false), "a fragment is not the key");
        assert_eq!(holds_any(b"anything", &[]), Some(false));
        assert_eq!(holds_any(&vec![b'a'; MAX_SCAN + 1], &prints), None);
    }
}
