//! The share hub's protocol (hosted plan §6.2–§6.6, P4a/P4b): what a
//! per-user daemon and `<slug>-hub` say over the hub's unix socket, in one
//! file both compile — the gateway's crate as `app_gateway::hub_wire`, the
//! daemon's by `#[path]` (`services::server::hub_wire`). Plain `std` +
//! `serde`, no brand constants.
//!
//! One request per connection: a JSON line in, then — for a push only — the
//! bundle's bytes (exactly [`Request::Push`]'s `bytes`), then a JSON line
//! out. Who may do what is the hub's decision from the caller's
//! `SO_PEERCRED` uid, never from anything in the request (§4.3: "share
//! requests name share ids, not paths").

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// The socket's file name in `/run/<slug>`.
pub const SOCKET_NAME: &str = "hub.sock";
/// A request or reply line is never longer.
pub const MAX_LINE: usize = 256 * 1024;
/// The largest bundle one push may carry.
pub const MAX_BUNDLE: u64 = 4 * 1024 * 1024 * 1024;
/// Ref updates in one push.
pub const MAX_UPDATES: usize = 256;
/// Members of one share.
pub const MAX_MEMBERS: usize = 256;
/// A share's display name (the owner's project name), in characters.
pub const MAX_NAME: usize = 80;
/// A presence report older than this is no longer shown.
pub const PRESENCE_TTL: u64 = 10 * 60;
/// How long a deleted share's hub is kept in the holding area, and its
/// tombstone shown to former members ("deleted by owner").
pub const RETENTION: u64 = 30 * 24 * 60 * 60;
/// The all-zero object id: "no such ref" as an old or new value.
pub const ZERO_OID: &str = "0000000000000000000000000000000000000000";

/// A member's role on one share.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    /// May fetch.
    Viewer,
    /// May fetch, and move `refs/heads/<own name>/*` through the hub.
    Editor,
    /// Made the share: may move every branch and tag, grant, revoke, delete.
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Request {
    /// Make a new, empty hub; the caller owns it.
    Create { name: String },
    /// Give `user` (a server user, never the caller) `role` on `share`, or
    /// change it (the owner).
    Grant { share: String, user: String, role: Role },
    /// Take `user` off `share` (the owner): their read access ends at once.
    Revoke { share: String, user: String },
    /// Move the hub to the holding area (the owner); members see "deleted by
    /// owner" for [`RETENTION`].
    Delete { share: String },
    /// Every share the caller owns or is a member of (and the tombstones of
    /// deleted ones), with the co-members' presence.
    List,
    /// Apply `updates`, with the objects in the bundle that follows the line
    /// (`bytes` long; 0 when it carries none, e.g. deletions). `head` (the
    /// owner) points the hub's `HEAD` at a branch.
    Push { share: String, updates: Vec<RefUpdate>, bytes: u64, #[serde(default)] head: Option<String> },
    /// "I have this share open" (or closed): shown to its other members.
    Presence { share: String, open: bool },
    /// Take `user` off every share they are a member of (root only: the
    /// admin helper's `user-remove`, so a removed account's named ACL
    /// entries do not outlive its membership).
    Forget { user: String },
}

/// One ref move, compare-and-swap on `old`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefUpdate {
    /// Full name (`refs/heads/…`, `refs/tags/…`).
    #[serde(rename = "ref")]
    pub name: String,
    /// What the hub must hold now ([`ZERO_OID`]: nothing).
    pub old: String,
    /// What it holds after ([`ZERO_OID`]: delete).
    pub new: String,
    /// Allow a non-fast-forward move.
    #[serde(default)]
    pub force: bool,
}

/// A share as one caller sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareInfo {
    pub id: String,
    pub name: String,
    pub owner: String,
    /// The caller's role (`owner` for their own).
    pub role: String,
    /// The bare hub's path (what a member fetches from and its fence binds).
    pub path: String,
    pub created: u64,
    /// Every member with their role (the owner is not listed).
    #[serde(default)]
    pub members: Vec<Member>,
    /// Who has it open now (never the caller).
    #[serde(default)]
    pub presence: Vec<Presence>,
    /// Set when the owner deleted it: the hub is gone from `path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub user: String,
    pub role: Role,
    pub since: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presence {
    pub user: String,
    pub since: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    /// A fixed token: `refused`, `invalid`, `unknown-share`, `not-owner`,
    /// `not-a-user`, `sharing-off`, `ref-refused`, `stale`, `non-fast-forward`,
    /// `bad-bundle`, `too-large`, `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// For `ref-refused` / `stale` / `non-fast-forward`: the refs at fault.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<ShareInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<ShareInfo>,
}

impl Reply {
    pub fn ok() -> Self {
        Reply { ok: true, ..Reply::default() }
    }
    pub fn error(token: &str) -> Self {
        Reply { ok: false, error: Some(token.to_string()), ..Reply::default() }
    }
    pub fn refs(token: &str, refs: Vec<String>) -> Self {
        Reply { refs, ..Reply::error(token) }
    }
}

/// A share id: 32 lowercase hex characters, minted by the hub.
pub fn valid_share_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A share's display name: 1..=[`MAX_NAME`] characters, no control characters.
pub fn valid_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=MAX_NAME).contains(&count) && !name.chars().any(char::is_control) && name.trim() == name
}

/// A full object id (SHA-1 or SHA-256 hex).
pub fn valid_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_zero(oid: &str) -> bool {
    oid.bytes().all(|b| b == b'0')
}

/// A ref the hub accepts: `refs/heads/…` or `refs/tags/…`, a strict subset
/// of git's own rules (plain ASCII segments of `[A-Za-z0-9._-]`, none empty,
/// none starting with `.` or `-`, none ending in `.lock`, no `..`).
pub fn valid_ref(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/tags/")) else {
        return false;
    };
    name.len() <= 200
        && !rest.is_empty()
        && !rest.contains("..")
        && rest.split('/').all(|seg| {
            !seg.is_empty()
                && !seg.starts_with('.')
                && !seg.starts_with('-')
                && !seg.ends_with(".lock")
                && seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
}

/// May `user`, with `role` on a share, move `name`? The owner moves
/// anything; an editor only branches under `refs/heads/<user>/`; a viewer
/// nothing (§6.2 step 3). Assumes [`valid_ref`].
pub fn ref_allowed(role: Role, user: &str, name: &str) -> bool {
    match role {
        Role::Owner => true,
        Role::Editor => name.strip_prefix("refs/heads/").and_then(|rest| rest.strip_prefix(user)).is_some_and(|rest| rest.starts_with('/') && rest.len() > 1),
        Role::Viewer => false,
    }
}

/// The branch an editor's local `branch` is pushed to: `refs/heads/<user>/<branch>`.
pub fn member_branch(user: &str, branch: &str) -> String {
    format!("refs/heads/{user}/{branch}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_are_strict_and_rules_follow_the_role() {
        for ok in ["refs/heads/main", "refs/heads/bob/fix-1", "refs/tags/v1.0"] {
            assert!(valid_ref(ok), "{ok}");
        }
        for bad in ["main", "refs/heads/", "refs/heads/a..b", "refs/heads/.x", "refs/heads/x.lock", "refs/heads/a//b", "refs/remotes/o/x", "refs/heads/-x", "refs/heads/a b", "HEAD"] {
            assert!(!valid_ref(bad), "{bad}");
        }
        assert!(ref_allowed(Role::Owner, "alice", "refs/heads/main"));
        assert!(ref_allowed(Role::Editor, "bob", "refs/heads/bob/main"));
        assert!(!ref_allowed(Role::Editor, "bob", "refs/heads/main"), "only the owner moves main");
        assert!(!ref_allowed(Role::Editor, "bob", "refs/heads/bobby/main"), "a prefix of another name is not one's own");
        assert!(!ref_allowed(Role::Editor, "bob", "refs/heads/carol/main"), "nor another member's");
        assert!(!ref_allowed(Role::Editor, "bob", "refs/heads/bob/"));
        assert!(!ref_allowed(Role::Editor, "bob", "refs/tags/bob/v1"));
        assert!(!ref_allowed(Role::Viewer, "bob", "refs/heads/bob/main"), "a viewer pushes nothing");
        assert_eq!(member_branch("bob", "main"), "refs/heads/bob/main");
    }

    #[test]
    fn ids_names_and_oids_are_bounded() {
        assert!(valid_share_id(&"a".repeat(32)));
        assert!(!valid_share_id(&"A".repeat(32)) && !valid_share_id("../x") && !valid_share_id(&"a".repeat(31)));
        assert!(valid_name("Thesis 2026") && !valid_name("") && !valid_name(" x") && !valid_name("a\nb") && !valid_name(&"x".repeat(81)));
        assert!(valid_oid(&"0".repeat(40)) && valid_oid(&"f".repeat(64)) && !valid_oid("abc") && !valid_oid(&"G".repeat(40)));
        assert!(is_zero(ZERO_OID));
        let push = Request::Push { share: "a".repeat(32), updates: vec![RefUpdate { name: "refs/heads/main".into(), old: ZERO_OID.into(), new: "1".repeat(40), force: false }], bytes: 10, head: None };
        let line = serde_json::to_string(&push).unwrap();
        assert!(line.contains(r#""op":"push""#) && line.contains(r#""ref":"refs/heads/main""#), "{line}");
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), push);
    }
}
