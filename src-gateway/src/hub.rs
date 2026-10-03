//! The share hub (hosted plan §6.2–§6.6, P4a/P4b): `<slug>-hub`, the one
//! account that owns and writes every bare hub under
//! `/srv/<slug>/shared/<id>.git`, on a unix socket by `SO_PEERCRED`.
//!
//! * **The owner's project never moves.** A share is an empty bare repo the
//!   hub makes (`git init --bare --template=`: no hooks, no `info/`, no
//!   sample anything); the owner's daemon pushes into it through this
//!   service. Nobody but the hub can write a hub — so no member can plant a
//!   hook or a config key there, which is what makes a reader's
//!   `-c safe.directory=<this hub>` safe (§6.2 step 5). The hub itself runs
//!   no hook: every git call pins `core.hooksPath=/dev/null`, and nothing
//!   ever runs `receive-pack` (deviation from the plan's "root-owned
//!   `config`/`hooks/`": the hub must create hubs at run time without root,
//!   and an account no member can act as gives the same guarantee).
//! * **Read access is a named-user ACL** ([`crate::acl`]): the owner and
//!   every member get `r-X` on the whole tree and in every directory's
//!   default ACL, so new objects inherit it; group and other get nothing; the
//!   root is `0711`, so nobody can list the hubs. A revoke takes the entry off
//!   the top first (every path lookup fails at once), then off every entry.
//! * **Pushes are bundles, checked before any ref moves.** A daemon sends
//!   `git bundle` bytes after its request line; the hub verifies the bundle
//!   against the hub, unbundles the objects (`git bundle unbundle` writes no
//!   ref), then applies the ref rules ([`hub_wire::ref_allowed`]: the owner
//!   moves anything, an editor `refs/heads/<self>/*`, a viewer nothing), a
//!   compare-and-swap on every old value and a fast-forward check, and moves
//!   the refs in one `update-ref --stdin` transaction. No pkt-line parsing,
//!   no hook, no member-run git against a writable repo (§6.2 step 3).
//! * **The table** (`shares.json` in the hub's `0700` state dir) holds who
//!   owns and who may read each share — the hub's own, like the key keeper's
//!   lists (deviation from "ref rules from the gateway database": the hub
//!   is the only process that applies them, so they live with it).
//! * **Presence** (§6.4) is attributed by the caller's uid and shown only to
//!   the share's other members; it carries no project content.
//! * **Delete** moves the hub to a holding area for [`hub_wire::RETENTION`]
//!   and leaves a tombstone members see as "deleted by owner"; the owner's
//!   own project is untouched.
//! * **Policy**: with the admin's `project_sharing` switch off, no new share
//!   and no new member; what exists keeps working (§6.7's rule for switches).
//! * **Audit**: `audit.jsonl` beside the table — who made, granted, revoked,
//!   deleted and pushed to which share id; never a name, path or ref.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::audit::{AuditLog, Row};
use crate::hub_wire::{self, Member, Presence, RefUpdate, Reply, Request, Role, ShareInfo, MAX_LINE};
use crate::{acl, names};

pub const TABLE_FILE: &str = "shares.json";
/// Where deleted hubs wait out the retention window (inside the shared root,
/// `0700`).
pub const HOLDING_DIR: &str = ".deleted";
pub const MAX_CONNECTIONS: usize = 32;
pub const MAX_PER_UID: usize = 4;
/// Every request but a push: an ACL walk over a large hub included.
pub const DEADLINE: Duration = Duration::from_secs(120);
/// A push: the upload and the unbundle.
pub const PUSH_DEADLINE: Duration = Duration::from_secs(30 * 60);
pub const VERB_CREATE: &str = "share-create";
pub const VERB_GRANT: &str = "share-grant";
pub const VERB_REVOKE: &str = "share-revoke";
pub const VERB_DELETE: &str = "share-delete";
pub const VERB_PUSH: &str = "share-push";

/// One share's presence reports: user → (open since, last report).
type Seen = HashMap<String, (u64, u64)>;

/// Who a uid is: a server user (by name), or nobody the hub serves.
pub trait HubPeers: Send + Sync {
    /// The server user `uid` is, or `None`.
    fn user_of(&self, uid: u32) -> Option<String>;
    /// The uid of server user `name`, or `None` (not an account, or not one
    /// the helper would link).
    fn uid_of(&self, name: &str) -> Option<u32>;
}

/// The real machine: the helper's own account rule.
pub struct SystemHubPeers;

impl HubPeers for SystemHubPeers {
    fn user_of(&self, uid: u32) -> Option<String> {
        let name = crate::keeper::name_of_uid(uid)?;
        (self.uid_of(&name) == Some(uid)).then_some(name)
    }

    fn uid_of(&self, name: &str) -> Option<u32> {
        use crate::helper::Accounts;
        let account = crate::helper::SystemAccounts.lookup(name)?;
        crate::helper::check_account(&account).is_ok().then_some(account.uid)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Table {
    #[serde(default)]
    shares: BTreeMap<String, Share>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Share {
    owner: String,
    owner_uid: u32,
    name: String,
    created: u64,
    #[serde(default)]
    members: BTreeMap<String, Grant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted: Option<u64>,
    /// Where a deleted hub waits (holding area), for the purge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    held_at: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Grant {
    uid: u32,
    role: Role,
    since: u64,
}

impl Share {
    fn role_of(&self, user: &str) -> Option<Role> {
        if self.owner == user {
            Some(Role::Owner)
        } else {
            self.members.get(user).map(|g| g.role)
        }
    }
}

pub struct Hub {
    root: PathBuf,
    state: PathBuf,
    git: PathBuf,
    peers: Box<dyn HubPeers>,
    policy_file: Option<PathBuf>,
    audit: AuditLog,
    table: Mutex<()>,
    /// One push or ACL change per share at a time.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// share → user → (open since, last report).
    presence: Mutex<HashMap<String, Seen>>,
}

impl Hub {
    pub fn new(root: PathBuf, state: PathBuf, peers: Box<dyn HubPeers>) -> Self {
        let audit = AuditLog::in_dir(&state);
        Hub { root, state, git: PathBuf::from("git"), peers, policy_file: None, audit, table: Mutex::default(), locks: Mutex::default(), presence: Mutex::default() }
    }

    /// Read the admin's switches from this file at every request (the
    /// gateway's `policy.json`); none set → sharing allowed.
    pub fn with_policy(mut self, path: PathBuf) -> Self {
        self.policy_file = Some(path);
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn sharing_allowed(&self) -> bool {
        match &self.policy_file {
            None => true,
            // Unreadable → off (the daemons' fail-closed rule).
            Some(path) => crate::policy::Policy::load(path).map(|p| p.features.project_sharing).unwrap_or(false),
        }
    }

    pub fn hub_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.git"))
    }

    fn load(&self) -> Table {
        crate::read_regular(&self.state.join(TABLE_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save(&self, table: &Table) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(table).map_err(|e| e.to_string())?;
        crate::write_atomic(&self.state.join(TABLE_FILE), &bytes, 0o600).map_err(|e| e.to_string())
    }

    /// Read-modify-write the table under its lock.
    fn update<T>(&self, edit: impl FnOnce(&mut Table) -> Result<T, Box<Reply>>) -> Result<T, Box<Reply>> {
        let _guard = self.table.lock().unwrap_or_else(PoisonError::into_inner);
        let mut table = self.load();
        let out = edit(&mut table)?;
        self.save(&table).map_err(|e| {
            eprintln!("hub: save: {e}");
            Reply::error("failed")
        })?;
        Ok(out)
    }

    fn share_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.locks.lock().unwrap_or_else(PoisonError::into_inner).entry(id.to_string()).or_default().clone()
    }

    /// The share `id` and the caller's role on it (not deleted).
    fn live(&self, id: &str, user: &str) -> Result<(Share, Role), Box<Reply>> {
        if !hub_wire::valid_share_id(id) {
            return Err(Reply::error("invalid").into());
        }
        let table = self.load();
        let share = table.shares.get(id).filter(|s| s.deleted.is_none()).ok_or_else(|| Reply::error("unknown-share"))?;
        // Not a member reads exactly like no such share.
        let role = share.role_of(user).ok_or_else(|| Reply::error("unknown-share"))?;
        Ok((share.clone(), role))
    }

    /// Answer one request from `uid`; `bundle` is the push's uploaded file.
    pub fn answer(&self, uid: u32, request: Request, bundle: Option<&Path>) -> Reply {
        if let Request::Forget { user } = &request {
            return if uid == 0 { self.forget(user) } else { Reply::error("refused") };
        }
        let Some(user) = self.peers.user_of(uid) else {
            eprintln!("hub: refused uid {uid}");
            return Reply::error("refused");
        };
        self.purge(crate::now());
        match request {
            Request::Create { name } => self.create(&user, &name),
            Request::Grant { share, user: member, role } => self.grant(&user, &share, &member, role),
            Request::Revoke { share, user: member } => self.revoke(&user, &share, &member),
            Request::Delete { share } => self.delete(&user, &share),
            Request::List => Reply { shares: self.list(&user, crate::now()), ..Reply::ok() },
            Request::Push { share, updates, head, .. } => self.push(&user, &share, &updates, head.as_deref(), bundle),
            Request::Presence { share, open } => self.presence(&user, &share, open),
            Request::Forget { .. } => Reply::error("refused"),
        }
    }

    /// Take `user` off every share they are a member of: the table first,
    /// then the ACL entry of the uid the table recorded (the account may be
    /// gone from the machine already). Shares they own stay as they are.
    fn forget(&self, user: &str) -> Reply {
        if !crate::wire::valid_account_name(user) {
            return Reply::error("invalid");
        }
        let dropped = self.update(|t| {
            let mut dropped = Vec::new();
            for (id, share) in t.shares.iter_mut() {
                if let Some(grant) = share.members.remove(user) {
                    dropped.push((id.clone(), grant.uid, share.deleted.is_some()));
                }
            }
            Ok(dropped)
        });
        let dropped = match dropped {
            Ok(dropped) => dropped,
            Err(reply) => return *reply,
        };
        let mut failed = false;
        for (id, uid, deleted) in dropped {
            self.forget_presence(&id, user);
            if deleted {
                continue;
            }
            let lock = self.share_lock(&id);
            let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
            let walked = acl::set_user_tree(&self.hub_path(&id), uid, false);
            if let Err(e) = &walked {
                eprintln!("hub: forget {user} on {id}: {e}");
                failed = true;
            }
            self.audit.record(Row::new("root", None, VERB_REVOKE, if walked.is_ok() { "ok" } else { "failed" }).resource(&format!("{id}/{user}")));
        }
        if failed {
            Reply::error("failed")
        } else {
            Reply::ok()
        }
    }

    /// May `uid` push `request` (role and ref rules only, before the bytes
    /// are read: a viewer never uploads a bundle).
    pub fn may_push(&self, uid: u32, request: &Request) -> Result<(), Box<Reply>> {
        let Request::Push { share, updates, bytes, .. } = request else { return Err(Reply::error("invalid").into()) };
        let user = self.peers.user_of(uid).ok_or_else(|| Reply::error("refused"))?;
        if *bytes > hub_wire::MAX_BUNDLE {
            return Err(Reply::error("too-large").into());
        }
        let (_, role) = self.live(share, &user)?;
        check_updates(role, &user, updates)
    }

    fn create(&self, user: &str, name: &str) -> Reply {
        if !hub_wire::valid_name(name) {
            return Reply::error("invalid");
        }
        if !self.sharing_allowed() {
            return Reply::error("sharing-off");
        }
        let Some(uid) = self.peers.uid_of(user) else { return Reply::error("refused") };
        let id = new_id();
        let path = self.hub_path(&id);
        let made = (|| -> Result<(), String> {
            let out = self.git_cmd(None).args(["init", "--bare", "--quiet", "--template="]).arg(&path).output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
            acl::set_user_tree(&path, uid, true).map_err(|e| format!("ACL: {e}"))
        })();
        if let Err(e) = made {
            eprintln!("hub: create: {e}");
            let _ = std::fs::remove_dir_all(&path);
            self.audit.record(Row::new(user, None, VERB_CREATE, "failed"));
            return Reply::error("failed");
        }
        let now = crate::now();
        let share = Share { owner: user.into(), owner_uid: uid, name: name.into(), created: now, members: BTreeMap::new(), deleted: None, held_at: None };
        if let Err(reply) = self.update(|t| {
            t.shares.insert(id.clone(), share.clone());
            Ok(())
        }) {
            let _ = std::fs::remove_dir_all(&path);
            return *reply;
        }
        self.audit.record(Row::new(user, None, VERB_CREATE, "ok").resource(&id));
        Reply { share: Some(self.info(&id, &share, user, now)), ..Reply::ok() }
    }

    fn grant(&self, user: &str, id: &str, member: &str, role: Role) -> Reply {
        let (share, mine) = match self.live(id, user) {
            Ok(found) => found,
            Err(reply) => return *reply,
        };
        if mine != Role::Owner {
            return Reply::error("not-owner");
        }
        if role == Role::Owner || member == share.owner || !crate::wire::valid_account_name(member) {
            return Reply::error("invalid");
        }
        if !share.members.contains_key(member) && !self.sharing_allowed() {
            return Reply::error("sharing-off");
        }
        if share.members.len() >= hub_wire::MAX_MEMBERS && !share.members.contains_key(member) {
            return Reply::error("invalid");
        }
        let Some(member_uid) = self.peers.uid_of(member) else { return Reply::error("not-a-user") };
        let lock = self.share_lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        if let Err(e) = acl::set_user_tree(&self.hub_path(id), member_uid, true) {
            eprintln!("hub: grant {id}: {e}");
            self.audit.record(Row::new(user, None, VERB_GRANT, "failed").resource(&format!("{id}/{member}")));
            return Reply::error("failed");
        }
        let now = crate::now();
        let result = self.update(|t| {
            let share = t.shares.get_mut(id).ok_or_else(|| Reply::error("unknown-share"))?;
            let since = share.members.get(member).map(|g| g.since).unwrap_or(now);
            share.members.insert(member.to_string(), Grant { uid: member_uid, role, since });
            Ok(share.clone())
        });
        match result {
            Ok(share) => {
                self.audit.record(Row::new(user, None, VERB_GRANT, role.as_str()).resource(&format!("{id}/{member}")));
                Reply { share: Some(self.info(id, &share, user, now)), ..Reply::ok() }
            }
            Err(reply) => *reply,
        }
    }

    fn revoke(&self, user: &str, id: &str, member: &str) -> Reply {
        let (share, mine) = match self.live(id, user) {
            Ok(found) => found,
            Err(reply) => return *reply,
        };
        if mine != Role::Owner {
            return Reply::error("not-owner");
        }
        let Some(grant) = share.members.get(member).cloned() else { return Reply::error("invalid") };
        let lock = self.share_lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        // The table first: from here on the member may not push, even if
        // the walk below fails half-way (it is retried by a second revoke).
        let result = self.update(|t| {
            let share = t.shares.get_mut(id).ok_or_else(|| Reply::error("unknown-share"))?;
            share.members.remove(member);
            Ok(share.clone())
        });
        let share = match result {
            Ok(share) => share,
            Err(reply) => return *reply,
        };
        self.forget_presence(id, member);
        let walked = acl::set_user_tree(&self.hub_path(id), grant.uid, false);
        if let Err(e) = &walked {
            eprintln!("hub: revoke {id}: {e}");
        }
        self.audit.record(Row::new(user, None, VERB_REVOKE, if walked.is_ok() { "ok" } else { "failed" }).resource(&format!("{id}/{member}")));
        if walked.is_err() {
            return Reply::error("failed");
        }
        Reply { share: Some(self.info(id, &share, user, crate::now())), ..Reply::ok() }
    }

    fn delete(&self, user: &str, id: &str) -> Reply {
        let (share, mine) = match self.live(id, user) {
            Ok(found) => found,
            Err(reply) => return *reply,
        };
        if mine != Role::Owner {
            return Reply::error("not-owner");
        }
        let lock = self.share_lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.hub_path(id);
        let now = crate::now();
        let holding = self.root.join(HOLDING_DIR);
        let moved = (|| -> Result<PathBuf, String> {
            // Cut every lookup first, then move it out of reach.
            for uid in share.members.values().map(|g| g.uid).chain([share.owner_uid]) {
                acl::set_user(&path, uid, false).map_err(|e| e.to_string())?;
            }
            if !holding.is_dir() {
                use std::os::unix::fs::DirBuilderExt;
                std::fs::DirBuilder::new().mode(0o700).create(&holding).map_err(|e| e.to_string())?;
            }
            let held = holding.join(format!("{id}.{now}.git"));
            std::fs::rename(&path, &held).map_err(|e| e.to_string())?;
            for uid in share.members.values().map(|g| g.uid).chain([share.owner_uid]) {
                let _ = acl::set_user_tree(&held, uid, false);
            }
            Ok(held)
        })();
        let held = match moved {
            Ok(held) => held,
            Err(e) => {
                eprintln!("hub: delete {id}: {e}");
                self.audit.record(Row::new(user, None, VERB_DELETE, "failed").resource(id));
                return Reply::error("failed");
            }
        };
        if let Err(reply) = self.update(|t| {
            if let Some(share) = t.shares.get_mut(id) {
                share.deleted = Some(now);
                share.held_at = Some(held.clone());
            }
            Ok(())
        }) {
            return *reply;
        }
        self.presence.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
        self.audit.record(Row::new(user, None, VERB_DELETE, "ok").resource(id));
        Reply::ok()
    }

    /// Drop tombstones and held hubs past the retention window.
    fn purge(&self, now: u64) {
        let table = self.load();
        let expired: Vec<String> = table.shares.iter().filter(|(_, s)| s.deleted.is_some_and(|d| now.saturating_sub(d) > hub_wire::RETENTION)).map(|(id, _)| id.clone()).collect();
        if expired.is_empty() {
            return;
        }
        let holding = self.root.join(HOLDING_DIR);
        let _ = self.update(|t| {
            for id in &expired {
                if let Some(share) = t.shares.remove(id) {
                    if let Some(held) = share.held_at.filter(|p| p.parent() == Some(holding.as_path())) {
                        let _ = std::fs::remove_dir_all(held);
                    }
                }
            }
            Ok(())
        });
    }

    fn info(&self, id: &str, share: &Share, user: &str, now: u64) -> ShareInfo {
        let presence = self
            .presence
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .map(|users| {
                let mut rows: Vec<Presence> = users
                    .iter()
                    .filter(|(who, (_, seen))| who.as_str() != user && now.saturating_sub(*seen) <= hub_wire::PRESENCE_TTL)
                    .map(|(who, (since, _))| Presence { user: who.clone(), since: *since })
                    .collect();
                rows.sort_by(|a, b| a.user.cmp(&b.user));
                rows
            })
            .unwrap_or_default();
        ShareInfo {
            id: id.to_string(),
            name: share.name.clone(),
            owner: share.owner.clone(),
            role: share.role_of(user).map(Role::as_str).unwrap_or("viewer").to_string(),
            path: self.hub_path(id).to_string_lossy().into_owned(),
            created: share.created,
            members: share.members.iter().map(|(name, g)| Member { user: name.clone(), role: g.role, since: g.since }).collect(),
            presence: if share.deleted.is_some() { Vec::new() } else { presence },
            deleted: share.deleted,
        }
    }

    pub fn list(&self, user: &str, now: u64) -> Vec<ShareInfo> {
        self.load().shares.iter().filter(|(_, s)| s.role_of(user).is_some()).map(|(id, s)| self.info(id, s, user, now)).collect()
    }

    fn presence(&self, user: &str, id: &str, open: bool) -> Reply {
        if let Err(reply) = self.live(id, user) {
            return *reply;
        }
        let mut map = self.presence.lock().unwrap_or_else(PoisonError::into_inner);
        let users = map.entry(id.to_string()).or_default();
        if open {
            // A refresh keeps the first `since` of a report that has not
            // expired, and moves its last-seen time.
            let now = crate::now();
            let entry = users.entry(user.to_string()).or_insert((now, now));
            if now.saturating_sub(entry.1) > hub_wire::PRESENCE_TTL {
                entry.0 = now;
            }
            entry.1 = now;
        } else {
            users.remove(user);
        }
        Reply::ok()
    }

    fn forget_presence(&self, id: &str, user: &str) {
        if let Some(users) = self.presence.lock().unwrap_or_else(PoisonError::into_inner).get_mut(id) {
            users.remove(user);
        }
    }

    /// A git command against the hubs: no hooks, no system or global config,
    /// a fixed environment.
    fn git_cmd(&self, hub: Option<&Path>) -> Command {
        let mut cmd = Command::new(&self.git);
        cmd.env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", &self.state)
            .env("LC_ALL", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "-c", "transfer.fsckObjects=true"])
            .current_dir(&self.state);
        if let Some(hub) = hub {
            cmd.arg("--git-dir").arg(hub);
        }
        cmd
    }

    fn git_ok(&self, hub: &Path, args: &[&str]) -> Result<String, String> {
        let out = self.git_cmd(Some(hub)).args(args).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    fn push(&self, user: &str, id: &str, updates: &[RefUpdate], head: Option<&str>, bundle: Option<&Path>) -> Reply {
        let (_, role) = match self.live(id, user) {
            Ok(found) => found,
            Err(reply) => return *reply,
        };
        if let Err(reply) = check_updates(role, user, updates) {
            return *reply;
        }
        if head.is_some_and(|h| role != Role::Owner || !h.starts_with("refs/heads/") || !hub_wire::valid_ref(h)) {
            return Reply::error("ref-refused");
        }
        let lock = self.share_lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let hub = self.hub_path(id);
        let result = self.apply_push(&hub, updates, head, bundle);
        self.audit.record(Row::new(user, None, VERB_PUSH, if result.ok { "ok" } else { result.error.as_deref().unwrap_or("failed") }).resource(id));
        result
    }

    fn apply_push(&self, hub: &Path, updates: &[RefUpdate], head: Option<&str>, bundle: Option<&Path>) -> Reply {
        // Compare-and-swap: every old value is what the hub holds now.
        let current = match self.git_ok(hub, &["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"]) {
            Ok(text) => text.lines().filter_map(|l| l.split_once(' ')).map(|(oid, name)| (name.to_string(), oid.to_string())).collect::<HashMap<_, _>>(),
            Err(e) => {
                eprintln!("hub: for-each-ref: {e}");
                return Reply::error("failed");
            }
        };
        let stale: Vec<String> = updates
            .iter()
            .filter(|u| match current.get(&u.name) {
                Some(oid) => *oid != u.old,
                None => !hub_wire::is_zero(&u.old),
            })
            .map(|u| u.name.clone())
            .collect();
        if !stale.is_empty() {
            return Reply::refs("stale", stale);
        }
        if let Some(file) = bundle {
            if let Err(e) = self.git_ok(hub, &["bundle", "verify", "--quiet", &file.to_string_lossy()]) {
                eprintln!("hub: bundle verify: {e}");
                return Reply::error("bad-bundle");
            }
            if let Err(e) = self.git_ok(hub, &["bundle", "unbundle", &file.to_string_lossy()]) {
                eprintln!("hub: unbundle: {e}");
                return Reply::error("bad-bundle");
            }
        }
        let mut refused = Vec::new();
        let mut non_ff = Vec::new();
        for update in updates.iter().filter(|u| !hub_wire::is_zero(&u.new)) {
            let kind = self.git_ok(hub, &["cat-file", "-t", &update.new]).unwrap_or_default();
            let kind = kind.trim();
            let fits = if update.name.starts_with("refs/heads/") { kind == "commit" } else { matches!(kind, "commit" | "tag") };
            if !fits {
                refused.push(update.name.clone());
                continue;
            }
            if !update.force && !hub_wire::is_zero(&update.old) && update.old != update.new {
                let ancestor = self.git_cmd(Some(hub)).args(["merge-base", "--is-ancestor", &update.old, &update.new]).status().is_ok_and(|s| s.success());
                if !ancestor {
                    non_ff.push(update.name.clone());
                }
            }
        }
        if !refused.is_empty() {
            return Reply::refs("bad-bundle", refused);
        }
        if !non_ff.is_empty() {
            return Reply::refs("non-fast-forward", non_ff);
        }
        let mut script = String::from("start\n");
        for update in updates {
            if hub_wire::is_zero(&update.new) {
                script.push_str(&format!("delete {} {}\n", update.name, update.old));
            } else {
                script.push_str(&format!("update {} {} {}\n", update.name, update.new, update.old));
            }
        }
        script.push_str("prepare\ncommit\n");
        let moved = (|| -> Result<(), String> {
            use std::io::Write;
            let mut child = self.git_cmd(Some(hub)).args(["update-ref", "--stdin"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
            child.stdin.take().ok_or("no stdin")?.write_all(script.as_bytes()).map_err(|e| e.to_string())?;
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            out.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string())
        })();
        if let Err(e) = moved {
            eprintln!("hub: update-ref: {e}");
            return Reply::error("stale");
        }
        if let Some(head) = head {
            if self.git_ok(hub, &["rev-parse", "--verify", "--quiet", head]).is_ok() {
                let _ = self.git_ok(hub, &["symbolic-ref", "HEAD", head]);
            }
        }
        Reply::ok()
    }
}

/// Every update well-formed and allowed for `role`.
fn check_updates(role: Role, user: &str, updates: &[RefUpdate]) -> Result<(), Box<Reply>> {
    if updates.is_empty() || updates.len() > hub_wire::MAX_UPDATES {
        return Err(Reply::error("invalid").into());
    }
    let mut seen = std::collections::HashSet::new();
    for update in updates {
        if !hub_wire::valid_ref(&update.name) || !hub_wire::valid_oid(&update.old) || !hub_wire::valid_oid(&update.new) || !seen.insert(&update.name) {
            return Err(Reply::error("invalid").into());
        }
    }
    let refused: Vec<String> = updates.iter().filter(|u| !hub_wire::ref_allowed(role, user, &u.name)).map(|u| u.name.clone()).collect();
    if refused.is_empty() {
        Ok(())
    } else {
        Err(Reply::refs("ref-refused", refused).into())
    }
}

fn new_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Default)]
struct PerUid(Mutex<HashMap<u32, usize>>);

struct UidSlot {
    table: Arc<PerUid>,
    uid: u32,
}

impl PerUid {
    fn take(table: &Arc<PerUid>, uid: u32) -> Option<UidSlot> {
        let mut map = table.0.lock().unwrap_or_else(PoisonError::into_inner);
        let used = map.entry(uid).or_insert(0);
        if *used >= MAX_PER_UID {
            return None;
        }
        *used += 1;
        Some(UidSlot { table: table.clone(), uid })
    }
}

impl Drop for UidSlot {
    fn drop(&mut self) {
        let mut map = self.table.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(used) = map.get_mut(&self.uid) {
            *used = used.saturating_sub(1);
            if *used == 0 {
                map.remove(&self.uid);
            }
        }
    }
}

/// Serve `listener`: one task per connection, capped overall and per uid.
pub async fn serve(hub: Arc<Hub>, listener: tokio::net::UnixListener) -> Result<(), String> {
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let per_uid = Arc::new(PerUid::default());
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("hub: accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(uid) = stream.peer_cred().map(|c| c.uid()) else { continue };
        let Some(uid_slot) = PerUid::take(&per_uid, uid) else { continue };
        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
        let hub = hub.clone();
        tokio::spawn(async move {
            let _slots = (permit, uid_slot);
            let _ = tokio::time::timeout(PUSH_DEADLINE, one(hub, uid, stream)).await;
        });
    }
}

/// Read up to the first newline (at most [`MAX_LINE`]); whatever came after
/// it in the same reads is returned too (the start of a push's bundle).
async fn read_head<R: AsyncReadExt + Unpin>(reader: &mut R) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(end) = buf.iter().position(|&b| b == b'\n') {
            let rest = buf.split_off(end + 1);
            buf.truncate(end);
            return Ok((buf, rest));
        }
        if buf.len() > MAX_LINE {
            return Err(std::io::Error::other("line too long"));
        }
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            return Ok((buf, Vec::new()));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

async fn reply_to(stream: &mut tokio::net::UnixStream, reply: &Reply) -> std::io::Result<()> {
    let mut out = serde_json::to_vec(reply).map_err(std::io::Error::other)?;
    out.push(b'\n');
    stream.write_all(&out).await?;
    stream.shutdown().await
}

async fn one(hub: Arc<Hub>, uid: u32, mut stream: tokio::net::UnixStream) -> std::io::Result<()> {
    let (line, rest) = match tokio::time::timeout(DEADLINE, read_head(&mut stream)).await {
        Ok(read) => read?,
        Err(_) => return Ok(()),
    };
    let Ok(request) = serde_json::from_slice::<Request>(&line) else {
        return reply_to(&mut stream, &Reply::error("invalid")).await;
    };
    let mut bundle: Option<tempfile_path::TempPath> = None;
    if let Request::Push { bytes, .. } = &request {
        if let Err(reply) = hub.may_push(uid, &request) {
            return reply_to(&mut stream, &reply).await;
        }
        if *bytes > 0 {
            match receive_bundle(&hub.state, &mut stream, rest, *bytes).await {
                Ok(path) => bundle = Some(path),
                Err(e) => {
                    eprintln!("hub: upload: {e}");
                    return reply_to(&mut stream, &Reply::error("bad-bundle")).await;
                }
            }
        }
    }
    let is_push = matches!(request, Request::Push { .. });
    let path = bundle.as_ref().map(|b| b.0.clone());
    let work = tokio::task::spawn_blocking(move || hub.answer(uid, request, path.as_deref()));
    let reply = if is_push {
        work.await.unwrap_or_else(|_| Reply::error("failed"))
    } else {
        match tokio::time::timeout(DEADLINE, work).await {
            Ok(done) => done.unwrap_or_else(|_| Reply::error("failed")),
            Err(_) => Reply::error("failed"),
        }
    };
    drop(bundle);
    reply_to(&mut stream, &reply).await
}

/// A file removed when dropped (the uploaded bundle).
mod tempfile_path {
    pub struct TempPath(pub std::path::PathBuf);
    impl Drop for TempPath {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// Write exactly `bytes` bytes of the connection (starting with `head`)
/// into a `0600` file under the hub's state dir.
async fn receive_bundle(state: &Path, stream: &mut tokio::net::UnixStream, head: Vec<u8>, bytes: u64) -> std::io::Result<tempfile_path::TempPath> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = state.join("incoming");
    if !dir.is_dir() {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).recursive(true).create(&dir)?;
    }
    let path = tempfile_path::TempPath(dir.join(format!("{}.bundle", new_id())));
    let file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&path.0)?;
    let mut file = tokio::fs::File::from_std(file);
    if head.len() as u64 > bytes {
        return Err(std::io::Error::other("more bytes than announced"));
    }
    file.write_all(&head).await?;
    let mut left = bytes - head.len() as u64;
    let mut chunk = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = chunk.len().min(left as usize);
        let n = stream.read(&mut chunk[..want]).await?;
        if n == 0 {
            return Err(std::io::Error::other("the upload ended early"));
        }
        file.write_all(&chunk[..n]).await?;
        left -= n as u64;
    }
    file.sync_all().await?;
    Ok(path)
}

/// One request to the hub at `socket` (tests and tools; the daemon has its
/// own blocking client).
pub async fn ask(socket: &Path, request: &Request, bundle: &[u8]) -> Result<Reply, String> {
    let mut stream = tokio::net::UnixStream::connect(socket).await.map_err(|e| format!("{}: {e}", socket.display()))?;
    let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).await.map_err(|e| e.to_string())?;
    stream.write_all(bundle).await.map_err(|e| e.to_string())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.map_err(|e| e.to_string())?;
    let end = answer.iter().position(|&b| b == b'\n').unwrap_or(answer.len());
    serde_json::from_slice::<Reply>(&answer[..end]).map_err(|e| format!("hub answer: {e}"))
}

/// The default places, for the unit.
pub fn default_hub() -> Hub {
    Hub::new(names::shared_root(), names::hub_state_dir(), Box::new(SystemHubPeers)).with_policy(names::gateway_state_dir().join(crate::policy::POLICY_FILE))
}

#[cfg(test)]
mod tests;
