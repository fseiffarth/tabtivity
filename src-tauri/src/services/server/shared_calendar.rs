//! Shared calendars and to-do lists, the daemon's half (hosted plan §6.7,
//! P4c; rationale in `docs/context/sharing.md`).
//!
//! The service (`<slug>-calendar`, `src-gateway/src/calendars.rs`) holds
//! every calendar a user opened to others and decides who may read or write
//! which part by uid. This side:
//!
//! * **merges** the calendars this user may see into what `calendar_load`
//!   answers — as calendars with the id `shared:<service id>`, their records
//!   carrying that calendar id — so the calendar, the board and the alarms
//!   of this user's own pages show them with no new store. A calendar this
//!   user may only read comes as `readonly`;
//! * **routes** an edit of such a record to the service (per-record
//!   compare-and-swap on its `rev`), and refuses moving a record between a
//!   shared calendar and a private one (v1: recreate it instead);
//! * **caches** what it read by the calendar's revision and drops a
//!   calendar's copy the moment the service stops listing it (a revoke);
//! * **moves** a calendar in on its first share and back on unshare (§6.7
//!   "sharing is a move") — never a CalDAV or read-only (subscribed) one,
//!   never the default calendar;
//! * keeps this user's own **visibility** of a shared calendar in its own
//!   state (`shared-calendars.json`): a checkbox is per viewer, like alarm
//!   state, which stays in each user's own fired record.
//!
//! Agents never reach a shared calendar: the fence hides the service's
//! socket (`/run` is a tmpfs), the agent-facing calendar paths read and write
//! `calendar.json` only, and [`is_shared_id`] refuses a write naming one.

use std::collections::{BTreeMap, BTreeSet};
use app_core::sync::LockExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cal_wire::{self, CalContent, CalInfo, Change, Reply, Request, Role};
use crate::brand;
use crate::schema::calendar::{Calendar, CalendarData, CalendarEvent, CalendarTask, DEFAULT_CALENDAR_ID};

/// The calendar id prefix of a shared calendar in this user's merged view.
pub const ID_PREFIX: &str = "shared:";
pub const SOCKET_ENV: &str = "SERVER_CALENDAR_SOCKET";
pub const STATE_FILE: &str = "shared-calendars.json";

pub fn is_shared_id(calendar_id: &str) -> bool {
    calendar_id.starts_with(ID_PREFIX)
}

fn local_id(service_id: &str) -> String {
    format!("{ID_PREFIX}{service_id}")
}

fn service_id(calendar_id: &str) -> Option<&str> {
    calendar_id.strip_prefix(ID_PREFIX).filter(|id| cal_wire::valid_id(id))
}

pub fn service_socket() -> PathBuf {
    brand::env(SOCKET_ENV)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new("/run").join(brand::SLUG).join(cal_wire::SOCKET_NAME))
}

/// One request to the service at `socket`.
#[cfg(unix)]
pub fn ask_at(socket: &Path, request: &Request) -> Result<Reply, String> {
    use std::io::{Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| format!("the shared-calendar service ({}): {e}", socket.display()))?;
    let wait = std::time::Duration::from_millis(cal_wire::MAX_WAIT_MS + 15_000);
    stream.set_read_timeout(Some(wait)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(15))).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| format!("the shared-calendar service: {e}"))?;
    let mut answer = Vec::new();
    stream.take(cal_wire::MAX_LINE as u64 + 1).read_to_end(&mut answer).map_err(|e| format!("the shared-calendar service: {e}"))?;
    let end = answer.iter().position(|&b| b == b'\n').unwrap_or(answer.len());
    if end == 0 {
        return Err("the shared-calendar service closed the connection without an answer".into());
    }
    serde_json::from_slice::<Reply>(&answer[..end]).map_err(|e| format!("the shared-calendar service's answer: {e}"))
}

#[cfg(not(unix))]
pub fn ask_at(_socket: &Path, _request: &Request) -> Result<Reply, String> {
    Err("Shared calendars need the hosted server".into())
}

/// A refusal of the service, in words.
pub fn explain(reply: &Reply) -> String {
    match reply.error.as_deref().unwrap_or("failed") {
        "refused" => "The shared-calendar service does not serve this account".into(),
        "unknown-calendar" => "That calendar does not exist, or it is no longer shared with you".into(),
        "not-owner" => "Only the calendar's owner can do that".into(),
        "not-a-user" => "There is no server user by that name".into(),
        "read-only" => "You can read this shared calendar but not change it".into(),
        "sharing-off" => "The administrator has switched calendar and to-do sharing off".into(),
        "feature-off" => "The administrator has switched this feature off".into(),
        "stale" => "Someone changed this meanwhile; reload and try again".into(),
        "too-large" => "That is larger than a shared calendar takes".into(),
        "invalid" => "The shared-calendar service refused the request as malformed".into(),
        other => format!("The shared-calendar service could not do that ({other})"),
    }
}

fn expect_ok(reply: Reply) -> Result<Reply, String> {
    if reply.ok {
        Ok(reply)
    } else {
        Err(explain(&reply))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Prefs {
    /// Shared calendars this user unchecked (service ids).
    #[serde(default)]
    hidden: BTreeSet<String>,
    /// The owner's own links of the tasks of their shared to-do lists — the
    /// fields that never cross a share ([`cal_wire::STRIPPED_FIELDS`]), kept
    /// here by task id so the owner's card still shows its mail and file and
    /// gets them back on unshare.
    #[serde(default)]
    kept: BTreeMap<String, serde_json::Map<String, Value>>,
}

fn load_prefs(state_dir: &Path) -> Prefs {
    std::fs::read(state_dir.join(STATE_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_prefs(state_dir: &Path, prefs: &Prefs) -> Result<(), String> {
    crate::services::mobile_control::store::write_json_atomic(&state_dir.join(STATE_FILE), prefs, 0o600)
}

/// The fields of `record` that never cross a share.
fn stripped_of(record: &Value) -> serde_json::Map<String, Value> {
    record
        .as_object()
        .map(|o| o.iter().filter(|(k, v)| (cal_wire::STRIPPED_FIELDS.contains(&k.as_str()) || k.starts_with("caldav_")) && !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Lay the owner's kept fields back over a task record.
fn overlay(record: &mut Value, kept: Option<&serde_json::Map<String, Value>>) {
    if let (Some(object), Some(kept)) = (record.as_object_mut(), kept) {
        for (key, value) in kept {
            object.insert(key.clone(), value.clone());
        }
    }
}

/// What this daemon last read of each shared calendar, by service id.
pub struct Shared {
    socket: PathBuf,
    state_dir: PathBuf,
    cache: Mutex<BTreeMap<String, CalContent>>,
    /// One `wait` at the service at a time, whatever number of pages watch:
    /// each held connection is one of the service's few per account (and
    /// overall), so a user with many pages open would otherwise starve their
    /// own edits — and other users'.
    waiting: Mutex<()>,
    /// When the last `wait` at the service ended, and what it said.
    last_wait: Mutex<Option<(std::time::Instant, bool)>>,
}

fn editable(role: Option<Role>) -> bool {
    matches!(role, Some(Role::Editor | Role::Owner))
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

impl Shared {
    pub fn new(socket: PathBuf, state_dir: PathBuf) -> Self {
        Shared { socket, state_dir, cache: Mutex::default(), waiting: Mutex::default(), last_wait: Mutex::default() }
    }

    /// Ask the service what this user may see; fetch every calendar whose
    /// revision moved; drop the copy of every one it no longer lists.
    pub fn refresh(&self) -> Result<Vec<CalInfo>, String> {
        let list = expect_ok(ask_at(&self.socket, &Request::List)?)?.list;
        let stale: Vec<String> = {
            let cache = self.cache.lock_ok();
            list.iter().filter(|i| cache.get(&i.id).is_none_or(|c| c.info.rev != i.rev || c.info.events != i.events || c.info.tasks != i.tasks)).map(|i| i.id.clone()).collect()
        };
        let mut fetched = BTreeMap::new();
        for id in stale {
            // Revoked between the list and the get: it simply goes.
            if let Reply { ok: true, content: Some(content), .. } = ask_at(&self.socket, &Request::Get { id: id.clone() })? {
                fetched.insert(id, content);
            }
        }
        let mut cache = self.cache.lock_ok();
        let listed: BTreeSet<&str> = list.iter().map(|i| i.id.as_str()).collect();
        cache.retain(|id, _| listed.contains(id.as_str()));
        cache.extend(fetched);
        Ok(list)
    }

    /// The revisions of what this daemon holds (for `wait`).
    pub fn revs(&self) -> BTreeMap<String, u64> {
        self.cache.lock_ok().iter().map(|(id, c)| (id.clone(), c.info.rev)).collect()
    }

    /// Block until the service has something newer than this daemon's copy
    /// (at most [`cal_wire::MAX_WAIT_MS`]); `true` when it does.
    /// Callers that arrive while one wait is out share its answer.
    pub fn wait(&self) -> Result<bool, String> {
        let asked = std::time::Instant::now();
        let _turn = self.waiting.lock_ok();
        if let Some((ended, changed)) = *self.last_wait.lock_ok() {
            if ended >= asked {
                return Ok(changed);
            }
        }
        let changed = expect_ok(ask_at(&self.socket, &Request::Wait { revs: self.revs(), timeout_ms: cal_wire::MAX_WAIT_MS })?)?.changed;
        if changed {
            // Catch the copy up, so the next wait blocks even when no page
            // reloads the calendar (a page that never opened it).
            self.refresh()?;
        }
        *self.last_wait.lock_ok() = Some((std::time::Instant::now(), changed));
        Ok(changed)
    }

    /// Append every shared calendar this user may see to `data` (a fresh
    /// read of the service; on failure, the last copy).
    pub fn merge_into(&self, data: &mut CalendarData) {
        if let Err(e) = self.refresh() {
            eprintln!("shared calendars: {e}");
        }
        let Prefs { hidden, kept } = load_prefs(&self.state_dir);
        let cache = self.cache.lock_ok();
        for (id, content) in cache.iter() {
            let cal_id = local_id(id);
            let info = &content.info;
            let mut extra = std::collections::HashMap::new();
            extra.insert("shared".to_string(), serde_json::json!({ "owner": info.owner, "events": info.events, "tasks": info.tasks }));
            data.calendars.push(Calendar {
                id: cal_id.clone(),
                name: info.name.clone(),
                color: info.color.clone(),
                visible: !hidden.contains(id),
                readonly: !editable(info.events) && !editable(info.tasks),
                rev: info.rev,
                extra,
            });
            for record in &content.events {
                if let Ok(mut event) = serde_json::from_value::<CalendarEvent>(record.clone()) {
                    event.calendar_id = cal_id.clone();
                    data.events.push(event);
                }
            }
            let owner = info.tasks == Some(Role::Owner);
            for record in &content.tasks {
                let mut record = record.clone();
                if owner {
                    let id = record.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    overlay(&mut record, kept.get(&id));
                }
                if let Ok(mut task) = serde_json::from_value::<CalendarTask>(record) {
                    task.calendar_id = cal_id.clone();
                    data.tasks.push(task);
                }
            }
        }
    }

    /// The shared calendar (service id) whose cached events hold `record_id`.
    fn owner_of_event(&self, record_id: &str) -> Option<(String, u64)> {
        let cache = self.cache.lock_ok();
        cache.iter().find_map(|(id, c)| c.events.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(record_id)).map(|e| (id.clone(), e.get("rev").and_then(Value::as_u64).unwrap_or(0))))
    }

    fn owner_of_task(&self, record_id: &str) -> Option<(String, u64)> {
        let cache = self.cache.lock_ok();
        cache.iter().find_map(|(id, c)| c.tasks.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(record_id)).map(|t| (id.clone(), t.get("rev").and_then(Value::as_u64).unwrap_or(0))))
    }

    fn apply(&self, id: &str, change: Change) -> Result<Option<Value>, String> {
        let reply = expect_ok(ask_at(&self.socket, &Request::Apply { id: id.to_string(), change })?)?;
        // The next load re-reads the calendar; this one change is enough
        // until then.
        let _ = self.refresh();
        Ok(reply.record)
    }

    /// Create or update `event` in its shared calendar, or `None` when it
    /// is not one (the caller writes it locally). A record that would move
    /// between a shared calendar and a private one is refused.
    pub fn put_event(&self, event: &CalendarEvent, exists_locally: bool) -> Option<Result<CalendarEvent, String>> {
        let target = service_id(&event.calendar_id).map(str::to_string);
        let cached = (!event.id.is_empty()).then(|| self.owner_of_event(&event.id)).flatten();
        match (&target, &cached) {
            (None, None) => return None,
            (None, Some(_)) => return Some(Err(cross_move())),
            (Some(_), None) if exists_locally => return Some(Err(cross_move())),
            (Some(to), Some((from, _))) if to != from => return Some(Err(cross_move())),
            _ => {}
        }
        let to = target?;
        // The revision the page edited, so an edit made on an older copy is
        // refused as stale rather than written over a newer one.
        let base_rev = if cached.is_some() { event.rev } else { 0 };
        Some((|| {
            let record = to_value(event)?;
            let stored = self.apply(&to, Change::PutEvent { record, base_rev })?.ok_or("the service stored nothing")?;
            let mut out: CalendarEvent = serde_json::from_value(stored).map_err(|e| e.to_string())?;
            out.calendar_id = local_id(&to);
            Ok(out)
        })())
    }

    pub fn put_task(&self, task: &CalendarTask, exists_locally: bool) -> Option<Result<CalendarTask, String>> {
        let target = service_id(&task.calendar_id).map(str::to_string);
        let cached = (!task.id.is_empty()).then(|| self.owner_of_task(&task.id)).flatten();
        match (&target, &cached) {
            (None, None) => return None,
            (None, Some(_)) => return Some(Err(cross_move())),
            (Some(_), None) if exists_locally => return Some(Err(cross_move())),
            (Some(to), Some((from, _))) if to != from => return Some(Err(cross_move())),
            _ => {}
        }
        let to = target?;
        let base_rev = if cached.is_some() { task.rev } else { 0 };
        let owner = self.cache.lock_ok().get(&to).is_some_and(|c| c.info.tasks == Some(Role::Owner));
        Some((|| {
            let record = to_value(task)?;
            let keep = stripped_of(&record);
            let mut stored = self.apply(&to, Change::PutTask { record, base_rev })?.ok_or("the service stored nothing")?;
            if owner {
                // The owner's own links stay theirs, here, never in the service.
                let id = stored.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                let mut prefs = load_prefs(&self.state_dir);
                if keep.is_empty() {
                    prefs.kept.remove(&id);
                } else {
                    prefs.kept.insert(id.clone(), keep.clone());
                }
                save_prefs(&self.state_dir, &prefs)?;
                overlay(&mut stored, Some(&keep));
            }
            let mut out: CalendarTask = serde_json::from_value(stored).map_err(|e| e.to_string())?;
            out.calendar_id = local_id(&to);
            Ok(out)
        })())
    }

    /// Delete an event of a shared calendar, or `None` when it is not one.
    pub fn delete_event(&self, record_id: &str) -> Option<Result<(), String>> {
        let (id, base_rev) = self.owner_of_event(record_id)?;
        Some(self.apply(&id, Change::DeleteEvent { record_id: record_id.to_string(), base_rev }).map(|_| ()))
    }

    pub fn delete_task(&self, record_id: &str) -> Option<Result<(), String>> {
        let (id, base_rev) = self.owner_of_task(record_id)?;
        Some(self.apply(&id, Change::DeleteTask { record_id: record_id.to_string(), base_rev }).map(|_| ()))
    }

    /// A shared calendar's checkbox: this user's own, kept here.
    pub fn set_visible(&self, calendar_id: &str, visible: bool) -> Result<(), String> {
        let id = service_id(calendar_id).ok_or("not a shared calendar")?;
        let mut prefs = load_prefs(&self.state_dir);
        if visible {
            prefs.hidden.remove(id);
        } else {
            prefs.hidden.insert(id.to_string());
        }
        save_prefs(&self.state_dir, &prefs)
    }

    /// Is `task_id` a task of a shared calendar this daemon holds?
    pub fn holds_task(&self, task_id: &str) -> bool {
        self.owner_of_task(task_id).is_some()
    }

    /// The cached task `task_id`, as the calendar shows it.
    pub fn task(&self, task_id: &str) -> Option<CalendarTask> {
        let cache = self.cache.lock_ok();
        cache.iter().find_map(|(id, c)| {
            c.tasks.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(task_id)).and_then(|t| serde_json::from_value::<CalendarTask>(t.clone()).ok()).map(|mut t| {
                t.calendar_id = local_id(id);
                t
            })
        })
    }
}

fn cross_move() -> String {
    "A record cannot move between a shared calendar and a private one; create it again in the other calendar".to_string()
}

/// Drop every shared calendar and record from `data` (before a whole-document
/// save writes `calendar.json`: shared ones live in the service).
pub fn strip_shared(data: &mut CalendarData) {
    data.calendars.retain(|c| !is_shared_id(&c.id));
    data.events.retain(|e| !is_shared_id(&e.calendar_id));
    data.tasks.retain(|t| !is_shared_id(&t.calendar_id));
}

/// The process's own [`Shared`], in server mode.
pub fn global() -> Option<&'static Shared> {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    super::is_server().then(|| SHARED.get_or_init(|| Shared::new(service_socket(), crate::storage::state_dir())))
}

/// Why `calendar` cannot be shared: the default calendar (new events land
/// there), a CalDAV one (its truth is the CalDAV server; share it there), a
/// read-only subscription, or one that already is.
pub fn share_refusal(calendar: &Calendar) -> Option<&'static str> {
    if calendar.id == DEFAULT_CALENDAR_ID {
        return Some("The default calendar cannot be shared; make a calendar of its own for what you want to share");
    }
    if is_shared_id(&calendar.id) {
        return Some("This calendar is already shared");
    }
    if calendar.extra.get("caldav_account_id").and_then(Value::as_str).is_some_and(|v| !v.is_empty()) {
        return Some("A CalDAV calendar cannot be shared here; share it on its CalDAV server");
    }
    if calendar.readonly {
        return Some("A read-only (subscribed) calendar cannot be shared");
    }
    None
}

/// Move calendar `calendar_id` of the store at `path` into the service:
/// taken out of `calendar.json` first (in one transaction), then shared; if
/// the service refuses, put back as it was.
pub fn share_in(path: &Path, state_dir: &Path, socket: &Path, calendar_id: &str) -> Result<CalInfo, String> {
    use crate::commands::calendar::transact;
    let (taken, _) = transact(path, |data| {
        let calendar = data.calendars.iter().find(|c| c.id == calendar_id).cloned().ok_or("Unknown calendar")?;
        if let Some(why) = share_refusal(&calendar) {
            return Err(why.to_string());
        }
        let events: Vec<CalendarEvent> = data.events.iter().filter(|e| e.calendar_id == calendar_id).cloned().collect();
        let tasks: Vec<CalendarTask> = data.tasks.iter().filter(|t| t.calendar_id == calendar_id).cloned().collect();
        data.calendars.retain(|c| c.id != calendar_id);
        data.events.retain(|e| e.calendar_id != calendar_id);
        data.tasks.retain(|t| t.calendar_id != calendar_id);
        Ok((calendar, events, tasks, data.task_columns.clone()))
    })?;
    let (calendar, events, tasks, columns) = taken;
    let request = (|| -> Result<Request, String> {
        Ok(Request::Share {
            name: calendar.name.clone(),
            color: calendar.color.clone(),
            origin: calendar.id.clone(),
            events: events.iter().map(to_value).collect::<Result<_, _>>()?,
            tasks: tasks.iter().map(to_value).collect::<Result<_, _>>()?,
            columns: columns.iter().map(to_value).collect::<Result<_, _>>()?,
        })
    })();
    let shared = request.and_then(|r| ask_at(socket, &r)).and_then(expect_ok);
    match shared {
        Ok(reply) => {
            // What the service will never hold stays with the owner.
            let mut prefs = load_prefs(state_dir);
            for task in &tasks {
                let keep = to_value(task).map(|v| stripped_of(&v)).unwrap_or_default();
                if !keep.is_empty() {
                    prefs.kept.insert(task.id.clone(), keep);
                }
            }
            save_prefs(state_dir, &prefs)?;
            reply.info.ok_or_else(|| "the service sent no calendar".to_string())
        }
        Err(error) => {
            // Put it back: nothing was shared.
            let back = transact(path, |data| {
                if !data.calendars.iter().any(|c| c.id == calendar.id) {
                    data.calendars.push(calendar.clone());
                }
                let have_e: BTreeSet<String> = data.events.iter().map(|e| e.id.clone()).collect();
                data.events.extend(events.iter().filter(|e| !have_e.contains(&e.id)).cloned());
                let have_t: BTreeSet<String> = data.tasks.iter().map(|t| t.id.clone()).collect();
                data.tasks.extend(tasks.iter().filter(|t| !have_t.contains(&t.id)).cloned());
                Ok(())
            });
            if let Err(e) = back {
                eprintln!("shared calendars: putting {calendar_id} back failed: {e}");
            }
            Err(error)
        }
    }
}

/// Stop sharing `id` (the owner): everything comes back into `calendar.json`
/// under the calendar's own id (a fresh one if that is taken meanwhile).
/// If the write-back fails, the content is kept in
/// `<state>/`[`RETURNED_DIR`]`/<id>.json` (the service no longer has it).
pub fn unshare_in(path: &Path, state_dir: &Path, socket: &Path, id: &str) -> Result<(), String> {
    let content = expect_ok(ask_at(socket, &Request::Unshare { id: id.to_string() })?)?.content.ok_or("the service sent nothing back")?;
    if let Err(error) = put_back(path, state_dir, &content) {
        let kept = state_dir.join(RETURNED_DIR).join(format!("{id}.json"));
        let saved = std::fs::create_dir_all(state_dir.join(RETURNED_DIR)).map_err(|e| e.to_string()).and_then(|_| crate::services::mobile_control::store::write_json_atomic(&kept, &content, 0o600));
        return Err(match saved {
            Ok(()) => format!("The calendar came back but could not be stored in your calendar ({error}); it is kept in {}", kept.display()),
            Err(e) => format!("The calendar came back but could not be stored in your calendar ({error}), nor kept aside ({e})"),
        });
    }
    forget_prefs(state_dir, id, &content)
}

/// Where [`unshare_in`] keeps a calendar it could not put back.
pub const RETURNED_DIR: &str = "shared-calendars-returned";

fn put_back(path: &Path, state_dir: &Path, content: &CalContent) -> Result<(), String> {
    use crate::commands::calendar::transact;
    let prefs = load_prefs(state_dir);
    transact(path, |data| {
        let mut cal_id = content.origin.clone().filter(|o| !o.is_empty()).unwrap_or_else(crate::commands::projects::uuid_v4);
        if data.calendars.iter().any(|c| c.id == cal_id) {
            cal_id = crate::commands::projects::uuid_v4();
        }
        data.calendars.push(Calendar { id: cal_id.clone(), name: content.info.name.clone(), color: content.info.color.clone(), visible: true, readonly: false, rev: 0, extra: Default::default() });
        let taken_e: BTreeSet<String> = data.events.iter().map(|e| e.id.clone()).collect();
        for record in &content.events {
            if let Ok(mut event) = serde_json::from_value::<CalendarEvent>(record.clone()) {
                if taken_e.contains(&event.id) {
                    event.id = crate::commands::projects::uuid_v4();
                }
                event.calendar_id = cal_id.clone();
                event.rev = 0;
                data.events.push(event);
            }
        }
        let taken_t: BTreeSet<String> = data.tasks.iter().map(|t| t.id.clone()).collect();
        for record in &content.tasks {
            let mut record = record.clone();
            let id = record.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            overlay(&mut record, prefs.kept.get(&id));
            if let Ok(mut task) = serde_json::from_value::<CalendarTask>(record) {
                if taken_t.contains(&task.id) {
                    task.id = crate::commands::projects::uuid_v4();
                }
                task.calendar_id = cal_id.clone();
                task.rev = 0;
                data.tasks.push(task);
            }
        }
        data.normalize();
        Ok(())
    })
    .map(|_| ())
}

/// The owner's kept links and checkbox of an unshared calendar, forgotten.
fn forget_prefs(state_dir: &Path, id: &str, content: &CalContent) -> Result<(), String> {
    let mut prefs = load_prefs(state_dir);
    for record in &content.tasks {
        if let Some(id) = record.get("id").and_then(Value::as_str) {
            prefs.kept.remove(id);
        }
    }
    prefs.hidden.remove(id);
    save_prefs(state_dir, &prefs)
}

// Against the real hub/calendar services, which are Linux-only (`app-gateway`
// is a Linux dev-dependency).
#[cfg(all(test, target_os = "linux"))]
mod tests;
