//! The shared-calendar service (hosted plan §6.7, P4c): `<slug>-calendar`,
//! running as `<slug>-cal`, holding every calendar a user opened to others
//! in its own `0700` state directory, on a unix socket by `SO_PEERCRED`.
//! The calendar counterpart of the share hub ([`crate::hub`]):
//!
//! * **Sharing is a move.** A calendar that is shared for the first time
//!   comes in whole — its events, its tasks and the board columns they sit
//!   in — and leaves the owner's `calendar.json`; `unshare` hands it all back.
//!   Private calendars never touch the service.
//! * **Roles per part.** The owner opens a calendar's events, its tasks (its
//!   to-do list), or both, to named users as viewer or editor. A viewer's
//!   write is refused here, whatever the daemon claims.
//! * **Compare-and-swap per record** (the `rev` of #171): a write names the
//!   revision it read, a stale one is `stale`; every change bumps the
//!   calendar's revision, and `wait` wakes every daemon watching it.
//! * **What never crosses**: a task's mail link, its file link, the
//!   appointment it came from, its project, an event's CalDAV address
//!   ([`cal_wire::clean_record`], on every way in). Text is bounded per field,
//!   records per calendar. Alarm *state* (fired, snoozed, dismissed) is each
//!   user's own and never comes here.
//! * **Switches**: with the admin's `calendar_sharing` off nothing new is
//!   opened and incoming calendars are hidden (owners keep theirs); with
//!   `calendar` or `todo` off that part is closed for everyone (§6.7).
//! * **Audit**: who shared, opened, closed or took back which calendar id —
//!   never a title, a time or a record.
//!
//! Storage: one JSON file per calendar (`<id>.json`, `0600`, written
//! atomically under a per-calendar lock). The plan names SQLite; at a few
//! calendars per user and whole-calendar reads, a file each is the same
//! shape with no new dependency in this crate (deviation, noted in
//! `docs/context/sharing.md`).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::audit::{AuditLog, Row};
use crate::cal_wire::{self, CalContent, CalInfo, Change, Grant, Part, Reply, Request, Role, MAX_LINE};
use crate::hub::HubPeers;
use crate::names;

pub const MAX_CONNECTIONS: usize = 64;
pub const MAX_PER_UID: usize = 6;
/// Every request but `wait` (whose own bound is [`cal_wire::MAX_WAIT_MS`]).
pub const DEADLINE: Duration = Duration::from_secs(10);
pub const VERB_SHARE: &str = "calendar-share";
pub const VERB_GRANT: &str = "calendar-grant";
pub const VERB_REVOKE: &str = "calendar-revoke";
pub const VERB_UNSHARE: &str = "calendar-unshare";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    owner: String,
    /// The calendar's id in the owner's own store.
    origin: String,
    name: String,
    color: String,
    rev: u64,
    #[serde(default)]
    members: BTreeMap<String, Grant>,
    #[serde(default)]
    events: Vec<Value>,
    #[serde(default)]
    tasks: Vec<Value>,
    #[serde(default)]
    columns: Vec<Value>,
}

pub struct Calendars {
    dir: PathBuf,
    peers: Box<dyn HubPeers>,
    policy_file: Option<PathBuf>,
    audit: AuditLog,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Bumped on every change; `wait` watches it.
    changes: tokio::sync::watch::Sender<u64>,
}

/// The admin's switches as the service applies them.
#[derive(Debug, Clone, Copy)]
struct Switches {
    sharing: bool,
    events: bool,
    tasks: bool,
}

fn rec_id(record: &Value) -> Option<&str> {
    record.get("id").and_then(Value::as_str)
}

fn rec_rev(record: &Value) -> u64 {
    record.get("rev").and_then(Value::as_u64).unwrap_or(0)
}

fn new_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Calendars {
    pub fn new(dir: PathBuf, peers: Box<dyn HubPeers>) -> Self {
        let audit = AuditLog::in_dir(&dir);
        let (changes, _) = tokio::sync::watch::channel(0);
        Calendars { dir, peers, policy_file: None, audit, locks: Mutex::default(), changes }
    }

    pub fn with_policy(mut self, path: PathBuf) -> Self {
        self.policy_file = Some(path);
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn switches(&self) -> Switches {
        match &self.policy_file {
            None => Switches { sharing: true, events: true, tasks: true },
            Some(path) => match crate::policy::Policy::load(path) {
                Ok(p) => Switches { sharing: p.features.calendar_sharing, events: p.features.calendar, tasks: p.features.todo },
                // Unreadable → off, the daemons' rule.
                Err(_) => Switches { sharing: false, events: false, tasks: false },
            },
        }
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn load(&self, id: &str) -> Option<Stored> {
        if !cal_wire::valid_id(id) {
            return None;
        }
        crate::read_regular(&self.path(id)).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    fn save(&self, id: &str, stored: &Stored) -> Result<(), String> {
        let bytes = serde_json::to_vec(stored).map_err(|e| e.to_string())?;
        crate::write_atomic(&self.path(id), &bytes, 0o600).map_err(|e| e.to_string())?;
        self.changes.send_modify(|n| *n += 1);
        Ok(())
    }

    fn ids(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut ids: Vec<String> = entries.flatten().filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(str::to_string)).filter(|id| cal_wire::valid_id(id)).collect();
        ids.sort();
        ids
    }

    fn lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.locks.lock().unwrap_or_else(PoisonError::into_inner).entry(id.to_string()).or_default().clone()
    }

    /// The caller's role on each part, after the admin's switches; `None`
    /// for both when the calendar is not theirs to see.
    fn roles(&self, stored: &Stored, user: &str, sw: Switches) -> (Option<Role>, Option<Role>) {
        let (events, tasks) = if stored.owner == user {
            (Some(Role::Owner), Some(Role::Owner))
        } else if !sw.sharing {
            (None, None)
        } else {
            stored.members.get(user).map(|g| (g.events, g.tasks)).unwrap_or((None, None))
        };
        (events.filter(|_| sw.events), tasks.filter(|_| sw.tasks))
    }

    fn info(&self, id: &str, stored: &Stored, user: &str, sw: Switches) -> CalInfo {
        let (events, tasks) = self.roles(stored, user, sw);
        CalInfo {
            id: id.to_string(),
            owner: stored.owner.clone(),
            name: stored.name.clone(),
            color: stored.color.clone(),
            events,
            tasks,
            rev: stored.rev,
            members: if stored.owner == user { stored.members.clone() } else { BTreeMap::new() },
        }
    }

    /// Answer one request from `uid` (all but `wait`).
    pub fn answer(&self, uid: u32, request: Request) -> Reply {
        let Some(user) = self.peers.user_of(uid) else {
            eprintln!("calendar: refused uid {uid}");
            return Reply::error("refused");
        };
        let sw = self.switches();
        match request {
            Request::Share { name, color, origin, events, tasks, columns } => self.share(&user, sw, &name, &color, &origin, events, tasks, columns),
            Request::Grant { id, user: member, events, tasks } => self.grant(&user, sw, &id, &member, events, tasks),
            Request::Revoke { id, user: member } => self.revoke(&user, &id, &member),
            Request::List => Reply { list: self.list(&user, sw), ..Reply::ok() },
            Request::Get { id } => self.get(&user, sw, &id),
            Request::Apply { id, change } => self.apply(&user, sw, &id, change),
            Request::Unshare { id } => self.unshare(&user, &id),
            Request::Wait { .. } => Reply::error("invalid"),
        }
    }

    /// What `user` may see, by id and revision (for `wait`).
    pub fn visible(&self, uid: u32) -> Option<BTreeMap<String, u64>> {
        let user = self.peers.user_of(uid)?;
        Some(self.list(&user, self.switches()).into_iter().map(|i| (i.id, i.rev)).collect())
    }

    fn list(&self, user: &str, sw: Switches) -> Vec<CalInfo> {
        self.ids()
            .into_iter()
            .filter_map(|id| {
                let stored = self.load(&id)?;
                let info = self.info(&id, &stored, user, sw);
                (stored.owner == user || info.events.is_some() || info.tasks.is_some()).then_some(info)
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn share(&self, user: &str, sw: Switches, name: &str, color: &str, origin: &str, events: Vec<Value>, tasks: Vec<Value>, columns: Vec<Value>) -> Reply {
        if !sw.sharing {
            return Reply::error("sharing-off");
        }
        let short = |s: &str| !s.trim().is_empty() && s.chars().count() <= cal_wire::MAX_SHORT_CHARS && !s.chars().any(char::is_control);
        if !short(name) || color.chars().count() > 64 || !cal_wire::valid_record_id(origin) {
            return Reply::error("invalid");
        }
        if events.len() + tasks.len() > cal_wire::MAX_RECORDS || columns.len() > cal_wire::MAX_COLUMNS {
            return Reply::error("too-large");
        }
        let id = new_id();
        let mut seen = std::collections::HashSet::new();
        let mut take = |records: Vec<Value>| -> Result<Vec<Value>, &'static str> {
            records
                .into_iter()
                .map(|r| {
                    let mut r = cal_wire::clean_record(r)?;
                    let keep = rec_id(&r).filter(|i| cal_wire::valid_record_id(i) && !seen.contains(*i)).map(str::to_string);
                    let rid = keep.unwrap_or_else(new_id);
                    seen.insert(rid.clone());
                    r["id"] = Value::String(rid);
                    r["calendar_id"] = Value::String(id.clone());
                    r["rev"] = Value::from(1u64);
                    Ok(r)
                })
                .collect()
        };
        let (events, tasks) = match (take(events), take(tasks)) {
            (Ok(e), Ok(t)) => (e, t),
            (Err(e), _) | (_, Err(e)) => return Reply::error(e),
        };
        let columns = match columns.into_iter().map(cal_wire::clean_record).collect::<Result<Vec<_>, _>>() {
            Ok(c) => c,
            Err(e) => return Reply::error(e),
        };
        let stored = Stored { owner: user.into(), origin: origin.into(), name: name.into(), color: color.into(), rev: 1, members: BTreeMap::new(), events, tasks, columns };
        if let Err(e) = self.save(&id, &stored) {
            eprintln!("calendar: share: {e}");
            self.audit.record(Row::new(user, None, VERB_SHARE, "failed"));
            return Reply::error("failed");
        }
        self.audit.record(Row::new(user, None, VERB_SHARE, "ok").resource(&id));
        Reply { info: Some(self.info(&id, &stored, user, sw)), ..Reply::ok() }
    }

    /// Load `id` under its lock for a change by its owner.
    fn owned(&self, user: &str, id: &str) -> Result<Stored, Box<Reply>> {
        let stored = self.load(id).ok_or_else(|| Box::new(Reply::error("unknown-calendar")))?;
        if stored.owner != user {
            // A member learns nothing more than a stranger.
            return Err(Box::new(Reply::error(if stored.members.contains_key(user) { "not-owner" } else { "unknown-calendar" })));
        }
        Ok(stored)
    }

    fn grant(&self, user: &str, sw: Switches, id: &str, member: &str, events: Option<Role>, tasks: Option<Role>) -> Reply {
        let lock = self.lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut stored = match self.owned(user, id) {
            Ok(s) => s,
            Err(reply) => return *reply,
        };
        if member == user || !crate::wire::valid_account_name(member) || events == Some(Role::Owner) || tasks == Some(Role::Owner) {
            return Reply::error("invalid");
        }
        if events.is_none() && tasks.is_none() {
            return self.revoke_locked(user, id, member, stored);
        }
        if !sw.sharing {
            return Reply::error("sharing-off");
        }
        if self.peers.uid_of(member).is_none() {
            return Reply::error("not-a-user");
        }
        if !stored.members.contains_key(member) && stored.members.len() >= cal_wire::MAX_MEMBERS {
            return Reply::error("too-large");
        }
        stored.members.insert(member.to_string(), Grant { events, tasks });
        stored.rev += 1;
        if let Err(e) = self.save(id, &stored) {
            eprintln!("calendar: grant: {e}");
            return Reply::error("failed");
        }
        let how = format!("events:{}/tasks:{}", events.map_or("-", role_word), tasks.map_or("-", role_word));
        self.audit.record(Row::new(user, None, VERB_GRANT, &how).resource(&format!("{id}/{member}")));
        Reply { info: Some(self.info(id, &stored, user, sw)), ..Reply::ok() }
    }

    fn revoke(&self, user: &str, id: &str, member: &str) -> Reply {
        let lock = self.lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        match self.owned(user, id) {
            Ok(stored) => self.revoke_locked(user, id, member, stored),
            Err(reply) => *reply,
        }
    }

    fn revoke_locked(&self, user: &str, id: &str, member: &str, mut stored: Stored) -> Reply {
        if stored.members.remove(member).is_none() {
            return Reply::error("invalid");
        }
        stored.rev += 1;
        if let Err(e) = self.save(id, &stored) {
            eprintln!("calendar: revoke: {e}");
            return Reply::error("failed");
        }
        self.audit.record(Row::new(user, None, VERB_REVOKE, "ok").resource(&format!("{id}/{member}")));
        Reply::ok()
    }

    fn get(&self, user: &str, sw: Switches, id: &str) -> Reply {
        let Some(stored) = self.load(id) else { return Reply::error("unknown-calendar") };
        let info = self.info(id, &stored, user, sw);
        if info.events.is_none() && info.tasks.is_none() {
            return Reply::error("unknown-calendar");
        }
        let content = CalContent {
            events: if info.events.is_some() { stored.events } else { Vec::new() },
            columns: if info.tasks.is_some() { stored.columns } else { Vec::new() },
            tasks: if info.tasks.is_some() { stored.tasks } else { Vec::new() },
            info,
            origin: None,
        };
        Reply { content: Some(content), ..Reply::ok() }
    }

    fn apply(&self, user: &str, sw: Switches, id: &str, change: Change) -> Reply {
        let lock = self.lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(mut stored) = self.load(id) else { return Reply::error("unknown-calendar") };
        let (events_role, tasks_role) = self.roles(&stored, user, sw);
        let part = match &change {
            Change::PutEvent { .. } | Change::DeleteEvent { .. } => Part::Events,
            _ => Part::Tasks,
        };
        let role = if part == Part::Events { events_role } else { tasks_role };
        match role {
            None if events_role.is_none() && tasks_role.is_none() => return Reply::error("unknown-calendar"),
            None => return Reply::error(if (part == Part::Events && !sw.events) || (part == Part::Tasks && !sw.tasks) { "feature-off" } else { "read-only" }),
            Some(Role::Viewer) => return Reply::error("read-only"),
            Some(_) => {}
        }
        let total = stored.events.len() + stored.tasks.len();
        let records = if part == Part::Events { &mut stored.events } else { &mut stored.tasks };
        let mut stored_record = None;
        match change {
            Change::PutEvent { record, base_rev } | Change::PutTask { record, base_rev } => {
                let mut record = match cal_wire::clean_record(record) {
                    Ok(r) => r,
                    Err(e) => return Reply::error(e),
                };
                let wanted = rec_id(&record).filter(|i| cal_wire::valid_record_id(i)).map(str::to_string);
                let at = wanted.as_deref().and_then(|w| records.iter().position(|r| rec_id(r) == Some(w)));
                match (at, base_rev) {
                    (Some(i), base) if rec_rev(&records[i]) == base => {
                        record["id"] = Value::String(wanted.unwrap_or_default());
                        record["rev"] = Value::from(base + 1);
                        record["calendar_id"] = Value::String(id.to_string());
                        records[i] = record.clone();
                    }
                    (Some(_), _) => return Reply::error("stale"),
                    (None, 0) => {
                        if total >= cal_wire::MAX_RECORDS {
                            return Reply::error("too-large");
                        }
                        // A create keeps a fresh id the caller minted, never one in use.
                        record["id"] = Value::String(wanted.unwrap_or_else(new_id));
                        record["rev"] = Value::from(1u64);
                        record["calendar_id"] = Value::String(id.to_string());
                        records.push(record.clone());
                    }
                    (None, _) => return Reply::error("stale"),
                }
                stored_record = Some(record);
            }
            Change::DeleteEvent { record_id, base_rev } | Change::DeleteTask { record_id, base_rev } => {
                let Some(i) = records.iter().position(|r| rec_id(r) == Some(record_id.as_str())) else { return Reply::error("stale") };
                if rec_rev(&records[i]) != base_rev {
                    return Reply::error("stale");
                }
                records.remove(i);
            }
            Change::Columns { columns } => {
                if columns.len() > cal_wire::MAX_COLUMNS {
                    return Reply::error("too-large");
                }
                match columns.into_iter().map(cal_wire::clean_record).collect::<Result<Vec<_>, _>>() {
                    Ok(c) => stored.columns = c,
                    Err(e) => return Reply::error(e),
                }
            }
        }
        stored.rev += 1;
        if let Err(e) = self.save(id, &stored) {
            eprintln!("calendar: apply: {e}");
            return Reply::error("failed");
        }
        Reply { record: stored_record, info: Some(self.info(id, &stored, user, sw)), ..Reply::ok() }
    }

    fn unshare(&self, user: &str, id: &str) -> Reply {
        let lock = self.lock(id);
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let stored = match self.owned(user, id) {
            Ok(s) => s,
            Err(reply) => return *reply,
        };
        if let Err(e) = std::fs::remove_file(self.path(id)) {
            eprintln!("calendar: unshare: {e}");
            return Reply::error("failed");
        }
        self.changes.send_modify(|n| *n += 1);
        self.audit.record(Row::new(user, None, VERB_UNSHARE, "ok").resource(id));
        let sw = Switches { sharing: true, events: true, tasks: true };
        let content = CalContent { info: self.info(id, &stored, user, sw), events: stored.events, tasks: stored.tasks, columns: stored.columns, origin: Some(stored.origin) };
        Reply { content: Some(content), ..Reply::ok() }
    }

    /// `wait`: answer at once if `revs` is not what `uid` may see now, else
    /// when it changes or `timeout_ms` passes.
    pub async fn wait(&self, uid: u32, revs: BTreeMap<String, u64>, timeout_ms: u64) -> Reply {
        let mut rx = self.changes.subscribe();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.min(cal_wire::MAX_WAIT_MS));
        loop {
            let Some(now) = self.visible(uid) else { return Reply::error("refused") };
            if now != revs {
                return Reply { changed: true, ..Reply::ok() };
            }
            match tokio::time::timeout_at(deadline, rx.changed()).await {
                Ok(Ok(())) => continue,
                // Timed out, or the sender is gone: nothing changed.
                _ => return Reply::ok(),
            }
        }
    }
}

fn role_word(role: Role) -> &'static str {
    match role {
        Role::Viewer => "viewer",
        Role::Editor => "editor",
        Role::Owner => "owner",
    }
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
pub async fn serve(service: Arc<Calendars>, listener: tokio::net::UnixListener) -> Result<(), String> {
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let per_uid = Arc::new(PerUid::default());
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("calendar: accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(uid) = stream.peer_cred().map(|c| c.uid()) else { continue };
        let Some(uid_slot) = PerUid::take(&per_uid, uid) else { continue };
        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
        let service = service.clone();
        tokio::spawn(async move {
            let _slots = (permit, uid_slot);
            let bound = DEADLINE + Duration::from_millis(cal_wire::MAX_WAIT_MS);
            let _ = tokio::time::timeout(bound, one(service, uid, stream)).await;
        });
    }
}

async fn read_line(stream: &mut tokio::net::UnixStream) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        if let Some(end) = line.iter().position(|&b| b == b'\n') {
            line.truncate(end);
            return Ok(line);
        }
        if line.len() > MAX_LINE {
            return Err(std::io::Error::other("line too long"));
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(line);
        }
        line.extend_from_slice(&chunk[..n]);
    }
}

async fn one(service: Arc<Calendars>, uid: u32, mut stream: tokio::net::UnixStream) -> std::io::Result<()> {
    let line = match tokio::time::timeout(DEADLINE, read_line(&mut stream)).await {
        Ok(read) => read?,
        Err(_) => return Ok(()),
    };
    let reply = match serde_json::from_slice::<Request>(&line) {
        Err(_) => Reply::error("invalid"),
        Ok(Request::Wait { revs, timeout_ms }) => service.wait(uid, revs, timeout_ms).await,
        Ok(request) => {
            let service = service.clone();
            tokio::task::spawn_blocking(move || service.answer(uid, request)).await.unwrap_or_else(|_| Reply::error("failed"))
        }
    };
    let mut out = serde_json::to_vec(&reply).map_err(std::io::Error::other)?;
    out.push(b'\n');
    stream.write_all(&out).await?;
    stream.shutdown().await
}

/// One request to the service at `socket` (tests and tools).
pub async fn ask(socket: &Path, request: &Request) -> Result<Reply, String> {
    let mut stream = tokio::net::UnixStream::connect(socket).await.map_err(|e| format!("{}: {e}", socket.display()))?;
    let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).await.map_err(|e| e.to_string())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.map_err(|e| e.to_string())?;
    let end = answer.iter().position(|&b| b == b'\n').unwrap_or(answer.len());
    serde_json::from_slice::<Reply>(&answer[..end]).map_err(|e| format!("calendar answer: {e}"))
}

/// The default places, for the unit.
pub fn default_service() -> Calendars {
    Calendars::new(names::calendar_state_dir(), Box::new(crate::hub::SystemHubPeers)).with_policy(names::gateway_state_dir().join(crate::policy::POLICY_FILE))
}

#[cfg(test)]
mod tests;
