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

use std::collections::BTreeMap;

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
    /// Deliver `cli`'s key through the broker (`broker: true`; only a CLI in
    /// [`BROKER_CLIS`]) or directly (the gateway, for the administrator
    /// `by`). Either way every broker token of that CLI is dropped.
    Delivery { cli: String, broker: bool, by: String },
    /// A monthly budget in billed tokens ([`billed`]) for `user`, or the
    /// key's default when `user` is `None`; `tokens: None` clears it (the
    /// gateway, for the administrator `by`).
    Budget { cli: String, user: Option<String>, tokens: Option<u64>, by: String },
    /// Drop `user`'s broker token for `cli`: their running agents are cut
    /// off at the next request, their next fetch mints a new one (the
    /// gateway, for the administrator `by`).
    RenewToken { cli: String, user: String, by: String },
    /// This month's brokered use of `cli` and the budget (a server user, of
    /// their own use).
    Usage { cli: String },
    /// Take `user` off every key's list, with their broker tokens and
    /// budgets (root only: the admin helper's `user-remove`).
    Forget { user: String },
}

/// The port of the key broker (plan §5.4, P5) on loopback: next to the
/// gateway's 8740/8741, below the desktop sidecar's 8742/8743.
pub const BROKER_PORT: u16 = 8739;

/// A CLI the broker can serve: it takes a base URL override, so its agents
/// call the broker instead of the provider (plan Q2's "does the CLI accept a
/// base-URL override"). Only rows whose override the vendor documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrokerCli {
    pub id: &'static str,
    /// The provider's API origin the broker forwards to.
    pub upstream: &'static str,
    /// The variable that points the CLI at the broker.
    pub base_url_env: &'static str,
}

/// Claude Code takes `ANTHROPIC_BASE_URL` (documented, used with LLM
/// gateways). Gemini CLI and Mistral Vibe are not listed: their base-URL
/// overrides are not verified (Q2), so their keys are delivered directly.
pub const BROKER_CLIS: &[BrokerCli] = &[BrokerCli { id: "claude", upstream: "https://api.anthropic.com", base_url_env: "ANTHROPIC_BASE_URL" }];

pub fn broker_cli(id: &str) -> Option<&'static BrokerCli> {
    BROKER_CLIS.iter().find(|c| c.id == id)
}

/// What an agent of `cli` is pointed at: the broker on loopback, one path
/// prefix per CLI (`http://127.0.0.1:<port>/<cli>`). Fenced agents share the
/// host's network namespace, so they reach it; any local process can, which
/// is why every request carries a per-user broker token.
pub fn broker_url(port: u16, cli: &str) -> String {
    format!("http://127.0.0.1:{port}/{cli}")
}

/// Billed tokens, the budget's unit: input, cache writes and output count in
/// full, cache reads at a tenth (they cost about a tenth of an input token
/// at Anthropic's prices). One number per request whatever the model.
pub fn billed(usage: &Usage) -> u64 {
    usage.input.saturating_add(usage.cache_write).saturating_add(usage.output).saturating_add(usage.cache_read / 10)
}

/// Token counts of brokered requests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub cache_write: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub requests: u64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.requests = self.requests.saturating_add(other.requests);
    }
}

/// One user's brokered use of one CLI in one month (`YYYY-MM`, UTC).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonthUsage {
    #[serde(default)]
    pub user: String,
    pub month: String,
    #[serde(flatten)]
    pub usage: Usage,
    /// [`billed`] of `usage`.
    #[serde(default)]
    pub billed: u64,
    /// The budget in force for this user (`None`: no cap).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<u64>,
}

/// `YYYY-MM` of a unix time, UTC (civil from days, H. Hinnant's algorithm).
pub fn month_of(unix: u64) -> String {
    let days = (unix / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}")
}

/// One offered key, without the key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offer {
    pub cli: String,
    /// Unix seconds of the last set.
    pub updated: u64,
    /// Through the broker: the base URL the CLI is pointed at (its
    /// [`BrokerCli::base_url_env`]); the key `get` hands out is then the
    /// user's broker token, never the administrator's key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
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
    /// Delivered through the broker (agents get a token, never the key).
    #[serde(default)]
    pub broker: bool,
    /// The monthly budget of a listed user without one of their own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_budget: Option<u64>,
    /// Per-user monthly budgets.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub budgets: BTreeMap<String, u64>,
    /// This month's brokered use, per user who made any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub usage: Vec<MonthUsage>,
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
    /// With a broker token in `key`: where the CLI sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<MonthUsage>,
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
    fn months_are_utc_calendar_months_and_billing_discounts_cache_reads() {
        assert_eq!(month_of(0), "1970-01");
        assert_eq!(month_of(951_782_400), "2000-02", "a leap day");
        assert_eq!(month_of(1_727_740_799), "2024-09", "the last second of September");
        assert_eq!(month_of(1_727_740_800), "2024-10");
        assert_eq!(month_of(4_107_542_400), "2100-03");
        let usage = Usage { input: 100, output: 50, cache_write: 20, cache_read: 1000, requests: 1 };
        assert_eq!(billed(&usage), 270);
        assert_eq!(broker_url(BROKER_PORT, "claude"), "http://127.0.0.1:8739/claude");
        assert!(broker_cli("claude").is_some() && broker_cli("gemini").is_none(), "only a documented base-URL override");
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
