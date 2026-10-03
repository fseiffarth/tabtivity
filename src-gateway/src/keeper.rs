//! The key keeper (hosted plan §5.4, P3b): the administrator's API keys for
//! agent CLIs, held by `<slug>-auth` and handed to a server user's own
//! daemon when that user picked "the administrator's key" for a CLI (§5.2).
//!
//! * **Storage**: `/var/lib/<slug>-auth/<cli-id>/api-key`, `0600`, in a
//!   `0700` state directory of `<slug>-auth` — never in `settings.json`, the
//!   gateway's state or any user's home.
//! * **Socket**: `/run/<slug>/auth.sock`, made by `<slug>-auth-keeper.socket`
//!   (systemd, `0666` in the root-owned `/run/<slug>`, so nobody can squat
//!   it); every caller is classified by its `SO_PEERCRED` uid alone
//!   ([`Peers`]): the gateway's account may offer, withdraw and list keys —
//!   never read one back; a server user (the helper's own linkable-account
//!   rule, [`crate::helper::check_account`]: in `<slug>-users`, uid ≥ 1000, in no
//!   root-equivalent group) may list the offer and fetch a key — only a key
//!   whose list names it ([`Meta::users`], set by the administrator; a new
//!   key's list is empty) — and ask for the keys' fingerprints; anyone else
//!   is refused. Fenced agents never reach it: the fence mounts a fresh
//!   tmpfs over `/run`.
//! * **Fair share**: at most [`MAX_CONNECTIONS`] connections at once and
//!   [`MAX_PER_UID`] of them per caller uid, each bounded by [`DEADLINE`], so
//!   one user holding connections open cannot fail another's spawns.
//! * **Earlier keys** are remembered as fingerprints only
//!   (`<cli>/previous.json`, [`keys_wire::Fingerprint`]), so a daemon can tell
//!   that a login file holds a key the administrator has since rotated or
//!   withdrawn, and never adopts it as the user's own login.
//! * **Audit**: `audit.jsonl` beside the keys (the gateway's [`AuditLog`]
//!   format): who set or withdrew which CLI's key, who added or removed which
//!   user on its list (resource `<cli>/<user>`), and who fetched one (at
//!   most one row per user and CLI per [`DELIVERY_AUDIT_EVERY`], so a user
//!   cannot flood the log). Never the key, never a fragment of it.
//!
//! The administrator's role is the gateway's word (its table, its routing
//! cookie): the keeper trusts the gateway's uid for "set by this admin", as
//! every daemon trusts its role header. A compromised gateway can replace or
//! withdraw keys; it cannot read one.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::audit::{AuditLog, Row};
use crate::keys_wire::{self, Fingerprint, KeyStatus, Offer, Reply, Request, MAX_LINE};
use crate::{names, wire};

pub const KEY_FILE: &str = "api-key";
pub const META_FILE: &str = "meta.json";
/// Fingerprints of the CLI's earlier keys (never a key).
pub const PREVIOUS_FILE: &str = "previous.json";
/// Connections served at once; more are closed unanswered (local users can
/// connect; none may hold the keeper).
pub const MAX_CONNECTIONS: usize = 32;
/// Connections served at once per caller uid: one user keeping connections
/// open leaves the other slots to everyone else (P3b review, finding 6).
pub const MAX_PER_UID: usize = 4;
/// The whole exchange — read, answer, write — or the connection is dropped.
/// A request is one short line and the answer a file read: an honest caller
/// is done in milliseconds.
pub const DEADLINE: Duration = Duration::from_secs(2);
/// A fetch is audited at most this often per user and CLI.
pub const DELIVERY_AUDIT_EVERY: u64 = 10 * 60;
pub const VERB_SET: &str = "agent-key-set";
pub const VERB_REMOVE: &str = "agent-key-remove";
pub const VERB_DELIVERED: &str = "agent-key-delivered";
pub const VERB_USER_ADD: &str = "agent-key-user-add";
pub const VERB_USER_REMOVE: &str = "agent-key-user-remove";

/// Who is on the other end, by uid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Peer {
    /// The gateway's account (`<slug>-gw`).
    Gateway,
    /// A server user, by account name.
    User(String),
    Refused,
}

pub trait Peers: Send + Sync {
    fn classify(&self, uid: u32) -> Peer;
}

/// The real machine: the uid's name (`getpwuid_r`), then the gateway's
/// account or the helper's account rule.
pub struct SystemPeers;

impl Peers for SystemPeers {
    fn classify(&self, uid: u32) -> Peer {
        use crate::helper::Accounts;
        let Some(name) = name_of_uid(uid) else { return Peer::Refused };
        if name == names::gateway_account() {
            return Peer::Gateway;
        }
        match crate::helper::SystemAccounts.lookup(&name) {
            Some(account) if account.uid == uid && crate::helper::check_account(&account).is_ok() => Peer::User(name),
            _ => Peer::Refused,
        }
    }
}

pub(crate) fn name_of_uid(uid: u32) -> Option<String> {
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the call; the name is copied out
    // before `buf` drops.
    let rc = unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() {
        return None;
    }
    // SAFETY: pw_name is NUL-terminated inside `buf`.
    Some(unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) }.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Meta {
    updated: u64,
    by: String,
    /// The accounts allowed to fetch this key. Empty for a new key: the
    /// administrator names its users explicitly; replacing the key keeps the
    /// list, withdrawing it forgets the list.
    #[serde(default)]
    users: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Previous {
    #[serde(default)]
    fingerprints: Vec<Fingerprint>,
}

pub struct Keeper {
    dir: PathBuf,
    audit: AuditLog,
    peers: Box<dyn Peers>,
    /// Sets and removes, one at a time.
    write: Mutex<()>,
    /// `(user, cli)` → when its last fetch was audited.
    delivered: Mutex<HashMap<(String, String), u64>>,
}

impl Keeper {
    pub fn new(dir: PathBuf, peers: Box<dyn Peers>) -> Self {
        let audit = AuditLog::in_dir(&dir);
        Keeper { dir, audit, peers, write: Mutex::default(), delivered: Mutex::default() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Answer one request line from `uid`.
    pub fn answer(&self, uid: u32, line: &[u8]) -> Reply {
        let peer = self.peers.classify(uid);
        if peer == Peer::Refused {
            eprintln!("keeper: refused uid {uid}");
            return Reply::error("refused");
        }
        let Ok(request) = serde_json::from_slice::<Request>(line) else {
            return Reply::error("invalid");
        };
        match (peer, request) {
            (Peer::Gateway, Request::Offered) => Reply { offered: self.offered(), ..Reply::ok() },
            (Peer::User(user), Request::Offered) => Reply { offered: self.offered_to(&user), ..Reply::ok() },
            (Peer::User(user), Request::Get { cli }) => self.get(&user, &cli),
            (Peer::User(_), Request::Fingerprints { cli }) => self.fingerprints(&cli),
            (Peer::Gateway, Request::Set { cli, key, by }) => self.set(&cli, &key, &by),
            (Peer::Gateway, Request::Remove { cli, by }) => self.remove(&cli, &by),
            (Peer::Gateway, Request::Users { cli, users, by }) => self.set_users(&cli, &users, &by),
            (Peer::Gateway, Request::Status) => Reply { status: self.status(crate::now()), ..Reply::ok() },
            _ => Reply::error("refused"),
        }
    }

    fn cli_dir(&self, cli: &str) -> Option<PathBuf> {
        keys_wire::valid_cli_id(cli).then(|| self.dir.join(cli))
    }

    fn meta_of(&self, cli: &str) -> Option<Meta> {
        let dir = self.cli_dir(cli)?;
        let key = std::fs::symlink_metadata(dir.join(KEY_FILE)).ok()?;
        if !key.is_file() {
            return None;
        }
        Some(crate::read_regular(&dir.join(META_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default())
    }

    /// Every CLI with a key on offer, by id.
    pub fn offered(&self) -> Vec<Offer> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|id| keys_wire::valid_cli_id(id))
            .collect();
        ids.sort();
        ids.into_iter().filter_map(|cli| self.meta_of(&cli).map(|m| Offer { cli, updated: m.updated })).collect()
    }

    /// The offered CLIs whose list names `user`.
    pub fn offered_to(&self, user: &str) -> Vec<Offer> {
        self.offered().into_iter().filter(|o| self.meta_of(&o.cli).is_some_and(|m| m.users.contains(user))).collect()
    }

    /// The current key of `cli`, if one is on offer. `Err` only when the
    /// file is there but cannot be read.
    fn read_key(&self, dir: &Path, cli: &str) -> Result<Option<String>, ()> {
        match crate::read_regular(&dir.join(KEY_FILE)) {
            Ok(bytes) => Ok(String::from_utf8(bytes).ok().map(|k| k.trim().to_string()).filter(|k| keys_wire::valid_key(k))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => {
                eprintln!("keeper: {cli}: {e}");
                Err(())
            }
        }
    }

    fn get(&self, user: &str, cli: &str) -> Reply {
        let Some(dir) = self.cli_dir(cli) else { return Reply::error("invalid") };
        // Not on the list reads exactly like no key at all: a user learns
        // nothing about keys offered to others.
        if !self.meta_of(cli).is_some_and(|m| m.users.contains(user)) {
            return Reply::error("no-key");
        }
        let Ok(key) = self.read_key(&dir, cli) else { return Reply::error("failed") };
        let Some(key) = key else { return Reply::error("no-key") };
        let now = crate::now();
        let due = {
            let mut delivered = self.delivered.lock().unwrap_or_else(PoisonError::into_inner);
            let slot = delivered.entry((user.to_string(), cli.to_string())).or_insert(0);
            let due = now.saturating_sub(*slot) >= DELIVERY_AUDIT_EVERY;
            if due {
                *slot = now;
            }
            due
        };
        if due {
            self.audit.record(Row::new(user, None, VERB_DELIVERED, "ok").resource(cli));
        }
        Reply { key: Some(key), ..Reply::ok() }
    }

    /// Fingerprints of the current key and the remembered earlier ones.
    fn fingerprints(&self, cli: &str) -> Reply {
        let Some(dir) = self.cli_dir(cli) else { return Reply::error("invalid") };
        let Ok(current) = self.read_key(&dir, cli) else { return Reply::error("failed") };
        let mut fingerprints = self.previous_of(&dir).fingerprints;
        fingerprints.extend(current.as_deref().map(keys_wire::fingerprint));
        Reply { fingerprints, ..Reply::ok() }
    }

    fn previous_of(&self, dir: &Path) -> Previous {
        crate::read_regular(&dir.join(PREVIOUS_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Remember the current key's fingerprint before it is replaced or
    /// withdrawn (the newest [`keys_wire::MAX_HISTORY`] are kept).
    fn remember_current(&self, dir: &Path, cli: &str) -> std::io::Result<()> {
        let Ok(Some(current)) = self.read_key(dir, cli) else { return Ok(()) };
        let print = keys_wire::fingerprint(&current);
        let mut previous = self.previous_of(dir);
        previous.fingerprints.retain(|p| *p != print);
        previous.fingerprints.push(print);
        let excess = previous.fingerprints.len().saturating_sub(keys_wire::MAX_HISTORY);
        previous.fingerprints.drain(..excess);
        let bytes = serde_json::to_vec(&previous).map_err(std::io::Error::other)?;
        crate::write_atomic(&dir.join(PREVIOUS_FILE), &bytes, 0o600)
    }

    fn set(&self, cli: &str, key: &str, by: &str) -> Reply {
        let (Some(dir), true, true) = (self.cli_dir(cli), keys_wire::valid_key(key), wire::valid_account_name(by)) else {
            return Reply::error("invalid");
        };
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let result = (|| -> std::io::Result<()> {
            match std::fs::symlink_metadata(&dir) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => return Err(std::io::Error::other("not a directory")),
                Err(_) => {
                    use std::os::unix::fs::DirBuilderExt;
                    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
                }
            }
            // A replaced key keeps its list; a new offer starts with nobody.
            let users = self.meta_of(cli).map(|m| m.users).unwrap_or_default();
            self.remember_current(&dir, cli)?;
            crate::write_atomic(&dir.join(KEY_FILE), key.as_bytes(), 0o600)?;
            let meta = serde_json::to_vec(&Meta { updated: crate::now(), by: by.to_string(), users }).map_err(std::io::Error::other)?;
            crate::write_atomic(&dir.join(META_FILE), &meta, 0o600)
        })();
        match result {
            Ok(()) => {
                self.audit.record(Row::new(by, None, VERB_SET, "ok").resource(cli));
                Reply::ok()
            }
            Err(e) => {
                eprintln!("keeper: set {cli}: {e}");
                self.audit.record(Row::new(by, None, VERB_SET, "failed").resource(cli));
                Reply::error("failed")
            }
        }
    }

    fn remove(&self, cli: &str, by: &str) -> Reply {
        let (Some(dir), true) = (self.cli_dir(cli), wire::valid_account_name(by)) else {
            return Reply::error("invalid");
        };
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let had = std::fs::symlink_metadata(dir.join(KEY_FILE)).is_ok();
        if had {
            if let Err(e) = self.remember_current(&dir, cli) {
                eprintln!("keeper: remove {cli}: {e}");
                self.audit.record(Row::new(by, None, VERB_REMOVE, "failed").resource(cli));
                return Reply::error("failed");
            }
        }
        for file in [KEY_FILE, META_FILE] {
            match std::fs::remove_file(dir.join(file)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    eprintln!("keeper: remove {cli}: {e}");
                    self.audit.record(Row::new(by, None, VERB_REMOVE, "failed").resource(cli));
                    return Reply::error("failed");
                }
            }
        }
        // The directory stays while it remembers earlier keys' fingerprints.
        let _ = std::fs::remove_dir(&dir);
        self.audit.record(Row::new(by, None, VERB_REMOVE, if had { "ok" } else { "none" }).resource(cli));
        Reply::ok()
    }

    /// Replace the list of users who may fetch `cli`'s key; one audit row
    /// per user added or removed (resource `<cli>/<user>`).
    fn set_users(&self, cli: &str, users: &[String], by: &str) -> Reply {
        let valid = users.len() <= keys_wire::MAX_USERS && users.iter().all(|u| wire::valid_account_name(u));
        let (Some(dir), true, true) = (self.cli_dir(cli), valid, wire::valid_account_name(by)) else {
            return Reply::error("invalid");
        };
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(mut meta) = self.meta_of(cli) else { return Reply::error("no-key") };
        let wanted: BTreeSet<String> = users.iter().cloned().collect();
        let added: Vec<String> = wanted.difference(&meta.users).cloned().collect();
        let removed: Vec<String> = meta.users.difference(&wanted).cloned().collect();
        meta.users = wanted;
        let written = serde_json::to_vec(&meta).map_err(std::io::Error::other).and_then(|bytes| crate::write_atomic(&dir.join(META_FILE), &bytes, 0o600));
        let result = if written.is_ok() { "ok" } else { "failed" };
        if let Err(e) = written {
            eprintln!("keeper: users {cli}: {e}");
        }
        for (verb, names) in [(VERB_USER_ADD, &added), (VERB_USER_REMOVE, &removed)] {
            for name in names {
                self.audit.record(Row::new(by, None, verb, result).resource(&format!("{cli}/{name}")));
            }
        }
        if result == "ok" {
            Reply::ok()
        } else {
            Reply::error("failed")
        }
    }

    /// The admin panel's view: per offered key, when and by whom, and which
    /// accounts fetched it in the last [`keys_wire::RECENT_USE_SECS`].
    pub fn status(&self, now: u64) -> Vec<KeyStatus> {
        let since = now.saturating_sub(keys_wire::RECENT_USE_SECS);
        let rows = self.audit.rows();
        self.offered()
            .into_iter()
            .map(|offer| {
                let meta = self.meta_of(&offer.cli).unwrap_or_default();
                let users: BTreeSet<String> = rows
                    .iter()
                    .filter(|r| r.verb == VERB_DELIVERED && r.time >= since && r.resource.as_deref() == Some(offer.cli.as_str()))
                    .map(|r| r.user.clone())
                    .collect();
                KeyStatus { cli: offer.cli, updated: meta.updated, by: meta.by, users: users.into_iter().collect(), allowed: meta.users.into_iter().collect() }
            })
            .collect()
    }
}

/// Connections in flight per caller uid; a [`UidSlot`] gives its one back
/// when dropped.
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

/// Serve `listener` until it fails: one task per connection, at most
/// [`MAX_CONNECTIONS`] and [`MAX_PER_UID`] per caller uid, each bounded by
/// [`DEADLINE`]. A connection over either cap is closed unanswered.
pub async fn serve(keeper: Arc<Keeper>, listener: tokio::net::UnixListener) -> Result<(), String> {
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let per_uid = Arc::new(PerUid::default());
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("keeper: accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(uid) = stream.peer_cred().map(|c| c.uid()) else { continue };
        let Some(uid_slot) = PerUid::take(&per_uid, uid) else {
            continue;
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let keeper = keeper.clone();
        tokio::spawn(async move {
            let _slots = (permit, uid_slot);
            let _ = tokio::time::timeout(DEADLINE, one(&keeper, uid, stream)).await;
        });
    }
}

async fn read_line<R: AsyncReadExt + Unpin>(reader: &mut R) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        line.extend_from_slice(&chunk[..n]);
        if line.len() > MAX_LINE {
            return Err(std::io::Error::other("line too long"));
        }
        if let Some(end) = line.iter().position(|&b| b == b'\n') {
            line.truncate(end);
            break;
        }
    }
    Ok(line)
}

async fn one(keeper: &Keeper, uid: u32, mut stream: tokio::net::UnixStream) -> std::io::Result<()> {
    let line = read_line(&mut stream).await?;
    let reply = keeper.answer(uid, &line);
    let mut out = serde_json::to_vec(&reply).map_err(std::io::Error::other)?;
    out.push(b'\n');
    stream.write_all(&out).await?;
    stream.shutdown().await
}

/// One request to the keeper at `socket` (the gateway's side).
pub async fn ask(socket: &Path, request: &Request) -> Result<Reply, String> {
    let exchange = async {
        let mut stream = tokio::net::UnixStream::connect(socket).await.map_err(|e| format!("{}: {e}", socket.display()))?;
        let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stream.write_all(&line).await.map_err(|e| e.to_string())?;
        let answer = read_line(&mut stream).await.map_err(|e| e.to_string())?;
        serde_json::from_slice::<Reply>(&answer).map_err(|e| format!("keeper answer: {e}"))
    };
    tokio::time::timeout(DEADLINE, exchange).await.map_err(|_| "the key keeper did not answer".to_string())?
}

/// The listening socket systemd passed (`LISTEN_PID` is this process,
/// `LISTEN_FDS` ≥ 1, fd 3), close-on-exec, or `None`.
pub fn activation_listener() -> Result<Option<tokio::net::UnixListener>, String> {
    use std::os::unix::io::FromRawFd;
    let for_us = std::env::var("LISTEN_PID").ok().and_then(|p| p.trim().parse::<u32>().ok()) == Some(std::process::id());
    let count = std::env::var("LISTEN_FDS").ok().and_then(|n| n.trim().parse::<i32>().ok()).unwrap_or(0);
    if !for_us || count < 1 {
        return Ok(None);
    }
    // SAFETY: F_SETFD on the descriptor systemd passed this process.
    if unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err(format!("activation socket: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: systemd hands this process fd 3 as its listening socket.
    let listener = unsafe { std::os::unix::net::UnixListener::from_raw_fd(3) };
    listener.set_nonblocking(true).map_err(|e| format!("activation socket: {e}"))?;
    tokio::net::UnixListener::from_std(listener).map(Some).map_err(|e| format!("activation socket: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every uid is the same in a test: the classifier decides who it is.
    struct As(Peer);

    impl Peers for As {
        fn classify(&self, _: u32) -> Peer {
            self.0.clone()
        }
    }

    const KEY: &str = "fake-key-TEST0123456789abcdef";

    fn keeper(dir: &Path, peer: Peer) -> Keeper {
        Keeper::new(dir.to_path_buf(), Box::new(As(peer)))
    }

    fn ask_line(k: &Keeper, request: Request) -> Reply {
        k.answer(1000, &serde_json::to_vec(&request).unwrap())
    }

    fn allow(gw: &Keeper, cli: &str, users: &[&str]) {
        let reply = ask_line(gw, Request::Users { cli: cli.into(), users: users.iter().map(|u| u.to_string()).collect(), by: "admin".into() });
        assert!(reply.ok, "{reply:?}");
    }

    #[test]
    fn only_users_on_a_keys_list_see_or_fetch_it_and_the_list_is_audited() {
        let dir = tempfile::tempdir().unwrap();
        let gw = keeper(dir.path(), Peer::Gateway);
        let alice = keeper(dir.path(), Peer::User("alice".into()));
        let bob = keeper(dir.path(), Peer::User("bob".into()));
        let users = |names: &[&str]| Request::Users { cli: "claude".into(), users: names.iter().map(|u| u.to_string()).collect(), by: "admin".into() };
        assert_eq!(ask_line(&gw, users(&["alice"])).error.as_deref(), Some("no-key"), "no list without a key");
        assert!(ask_line(&gw, Request::Set { cli: "claude".into(), key: KEY.into(), by: "admin".into() }).ok);
        assert_eq!(ask_line(&alice, users(&["alice"])).error.as_deref(), Some("refused"), "a user cannot put themselves on it");
        assert_eq!(ask_line(&gw, users(&["Not Valid"])).error.as_deref(), Some("invalid"));
        allow(&gw, "claude", &["alice", "bob"]);
        assert_eq!(ask_line(&gw, Request::Status).status[0].allowed, ["alice", "bob"]);
        assert!(ask_line(&bob, Request::Get { cli: "claude".into() }).ok);
        allow(&gw, "claude", &["alice"]);
        assert!(ask_line(&bob, Request::Offered).offered.is_empty(), "taken off the list: not offered to bob");
        assert_eq!(ask_line(&bob, Request::Get { cli: "claude".into() }).error.as_deref(), Some("no-key"), "and not fetched by bob");
        assert_eq!(ask_line(&alice, Request::Get { cli: "claude".into() }).key.as_deref(), Some(KEY));
        // Replacing the key keeps its list; withdrawing forgets it.
        assert!(ask_line(&gw, Request::Set { cli: "claude".into(), key: "fake-key-ROTATED0123456789ab".into(), by: "admin".into() }).ok);
        assert_eq!(ask_line(&alice, Request::Get { cli: "claude".into() }).key.as_deref(), Some("fake-key-ROTATED0123456789ab"));
        assert!(ask_line(&gw, Request::Remove { cli: "claude".into(), by: "admin".into() }).ok);
        assert!(ask_line(&gw, Request::Set { cli: "claude".into(), key: KEY.into(), by: "admin".into() }).ok);
        assert!(ask_line(&alice, Request::Offered).offered.is_empty(), "a re-offered key starts with nobody");
        let audit = std::fs::read_to_string(dir.path().join(crate::audit::AUDIT_FILE)).unwrap();
        let rows: Vec<&str> = audit.lines().filter(|l| l.contains("agent-key-user")).collect();
        assert_eq!(rows.len(), 3, "{audit}");
        assert!(rows[0].contains(VERB_USER_ADD) && rows[0].contains("claude/alice") && rows[0].contains(r#""user":"admin""#), "{}", rows[0]);
        assert!(rows[2].contains(VERB_USER_REMOVE) && rows[2].contains("claude/bob"), "{}", rows[2]);
        assert!(!audit.contains(KEY), "{audit}");
    }

    #[test]
    fn earlier_keys_are_remembered_by_fingerprint_only() {
        let dir = tempfile::tempdir().unwrap();
        let gw = keeper(dir.path(), Peer::Gateway);
        let carol = keeper(dir.path(), Peer::User("carol".into()));
        let old = "fake-key-FIRST0123456789abcdef";
        assert!(ask_line(&carol, Request::Fingerprints { cli: "vibe".into() }).fingerprints.is_empty());
        assert!(ask_line(&gw, Request::Set { cli: "vibe".into(), key: old.into(), by: "admin".into() }).ok);
        assert!(ask_line(&gw, Request::Set { cli: "vibe".into(), key: KEY.into(), by: "admin".into() }).ok);
        // Any server user may ask, listed or not: a fingerprint calls no provider.
        let prints = ask_line(&carol, Request::Fingerprints { cli: "vibe".into() }).fingerprints;
        assert_eq!(prints, [keys_wire::fingerprint(old), keys_wire::fingerprint(KEY)]);
        assert_eq!(ask_line(&gw, Request::Fingerprints { cli: "vibe".into() }).error.as_deref(), Some("refused"));
        assert!(ask_line(&gw, Request::Remove { cli: "vibe".into(), by: "admin".into() }).ok);
        let prints = ask_line(&carol, Request::Fingerprints { cli: "vibe".into() }).fingerprints;
        assert_eq!(prints.len(), 2, "a withdrawn key is still recognised: {prints:?}");
        let on_disk = std::fs::read_to_string(dir.path().join("vibe").join(PREVIOUS_FILE)).unwrap();
        assert!(!on_disk.contains(old) && !on_disk.contains(KEY), "{on_disk}");
        let audit = std::fs::read_to_string(dir.path().join(crate::audit::AUDIT_FILE)).unwrap();
        assert!(!audit.contains(VERB_DELIVERED), "asking for fingerprints is no delivery: {audit}");
    }

    #[test]
    fn one_uid_cannot_hold_every_slot() {
        let table = Arc::new(PerUid::default());
        let held: Vec<UidSlot> = (0..MAX_PER_UID).map(|_| PerUid::take(&table, 1001).unwrap()).collect();
        assert!(PerUid::take(&table, 1001).is_none(), "the hog is capped");
        assert!(PerUid::take(&table, 1002).is_some(), "another user still gets in");
        drop(held);
        assert!(PerUid::take(&table, 1001).is_some(), "slots come back when connections end");
        assert!(table.0.lock().unwrap().get(&1002).is_none(), "an idle uid leaves no entry");
    }

    #[test]
    fn only_the_gateway_offers_and_only_a_user_fetches() {
        let dir = tempfile::tempdir().unwrap();
        let gw = keeper(dir.path(), Peer::Gateway);
        let alice = keeper(dir.path(), Peer::User("alice".into()));
        let stranger = keeper(dir.path(), Peer::Refused);
        let set = Request::Set { cli: "claude".into(), key: KEY.into(), by: "admin".into() };
        assert_eq!(ask_line(&alice, set.clone()).error.as_deref(), Some("refused"), "a user cannot offer");
        assert!(ask_line(&gw, set).ok);
        assert_eq!(ask_line(&gw, Request::Get { cli: "claude".into() }).error.as_deref(), Some("refused"), "the gateway never reads a key back");
        assert_eq!(ask_line(&stranger, Request::Offered).error.as_deref(), Some("refused"));
        assert!(ask_line(&alice, Request::Offered).offered.is_empty(), "a new key is offered to nobody");
        assert_eq!(ask_line(&alice, Request::Get { cli: "claude".into() }).error.as_deref(), Some("no-key"));
        allow(&gw, "claude", &["alice"]);
        let offered = ask_line(&alice, Request::Offered).offered;
        assert_eq!(offered.iter().map(|o| o.cli.as_str()).collect::<Vec<_>>(), ["claude"]);
        let got = ask_line(&alice, Request::Get { cli: "claude".into() });
        assert_eq!(got.key.as_deref(), Some(KEY));
        assert_eq!(ask_line(&alice, Request::Get { cli: "codex".into() }).error.as_deref(), Some("no-key"));
        assert_eq!(ask_line(&alice, Request::Get { cli: "../gw".into() }).error.as_deref(), Some("invalid"));
        assert_eq!(ask_line(&alice, Request::Status).error.as_deref(), Some("refused"), "who uses it is the admin's");
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.path().join("claude").join(KEY_FILE)), 0o600);
        assert_eq!(mode(dir.path().join("claude")), 0o700);
    }

    #[test]
    fn the_audit_names_who_and_what_never_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let gw = keeper(dir.path(), Peer::Gateway);
        let alice = keeper(dir.path(), Peer::User("alice".into()));
        let bob = keeper(dir.path(), Peer::User("bob".into()));
        assert!(ask_line(&gw, Request::Set { cli: "claude".into(), key: KEY.into(), by: "admin".into() }).ok);
        allow(&gw, "claude", &["alice", "bob"]);
        for _ in 0..5 {
            assert!(ask_line(&alice, Request::Get { cli: "claude".into() }).ok);
        }
        let status = ask_line(&gw, Request::Status).status;
        assert_eq!(status.len(), 1);
        assert_eq!((status[0].by.as_str(), status[0].users.clone()), ("admin", vec!["alice".to_string()]), "bob never fetched it");
        assert!(ask_line(&bob, Request::Offered).ok);
        let audit = std::fs::read_to_string(dir.path().join(crate::audit::AUDIT_FILE)).unwrap();
        assert!(!audit.contains(KEY) && !audit.contains(&KEY[KEY.len() - 8..]), "{audit}");
        assert_eq!(audit.matches(VERB_DELIVERED).count(), 1, "five fetches, one row: {audit}");
        assert!(ask_line(&gw, Request::Remove { cli: "claude".into(), by: "admin".into() }).ok);
        assert_eq!(ask_line(&alice, Request::Get { cli: "claude".into() }).error.as_deref(), Some("no-key"), "withdrawn: the next fetch gets nothing");
        assert!(ask_line(&gw, Request::Offered).offered.is_empty());
        assert!(!dir.path().join("claude").join(KEY_FILE).exists() && !dir.path().join("claude").join(META_FILE).exists());
        let audit = std::fs::read_to_string(dir.path().join(crate::audit::AUDIT_FILE)).unwrap();
        assert!(audit.contains(VERB_SET) && audit.contains(VERB_REMOVE));
    }

    #[test]
    fn bad_input_is_refused_without_echo() {
        let dir = tempfile::tempdir().unwrap();
        let gw = keeper(dir.path(), Peer::Gateway);
        for (cli, key, by) in [("claude", "short", "admin"), ("../x", KEY, "admin"), ("claude", KEY, "Admin!"), ("claude", "has space 0123456789", "admin")] {
            let reply = ask_line(&gw, Request::Set { cli: cli.into(), key: key.into(), by: by.into() });
            assert_eq!(reply.error.as_deref(), Some("invalid"), "{cli} {key} {by}");
        }
        assert_eq!(gw.answer(1, b"{not json").error.as_deref(), Some("invalid"));
        // A planted symlink in place of a CLI's directory is not followed.
        std::os::unix::fs::symlink("/", dir.path().join("codex")).unwrap();
        assert_eq!(ask_line(&gw, Request::Set { cli: "codex".into(), key: KEY.into(), by: "admin".into() }).error.as_deref(), Some("failed"));
    }

    #[tokio::test]
    async fn the_socket_answers_one_line_per_connection() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join(keys_wire::SOCKET_NAME);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir(&state).unwrap();
        tokio::spawn(serve(Arc::new(keeper(&state, Peer::Gateway)), listener));
        let reply = ask(&socket, &Request::Set { cli: "gemini".into(), key: KEY.into(), by: "admin".into() }).await.unwrap();
        assert!(reply.ok, "{reply:?}");
        let reply = ask(&socket, &Request::Status).await.unwrap();
        assert_eq!(reply.status[0].cli, "gemini");
        // An oversized line is dropped, not buffered without end.
        let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let _ = stream.write_all(&vec![b'x'; MAX_LINE + 2048]).await;
        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest).await;
        assert!(rest.is_empty(), "no answer to a flood");
    }
}
