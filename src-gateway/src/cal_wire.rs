//! The shared-calendar service's protocol (hosted plan §6.7, P4c): what a
//! per-user daemon and `<slug>-calendar` say over its unix socket, in one
//! file both compile — the gateway's crate as `app_gateway::cal_wire`, the
//! daemon's by `#[path]` (`services::server::cal_wire`). Plain `std` +
//! `serde` + `serde_json`, no brand constants.
//!
//! One request per connection: a JSON line each way. Who may do what is the
//! service's decision from the caller's `SO_PEERCRED` uid. Records travel as
//! JSON objects in the shape of the app's `calendar.json` (`CalendarEvent`,
//! `CalendarTask`, `TaskColumn`); the service needs only their `id`, `rev`
//! and the fields it strips or bounds, so a field the app adds later passes
//! through unchanged.

#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SOCKET_NAME: &str = "calendar.sock";
/// A request or reply line is never longer.
pub const MAX_LINE: usize = 16 * 1024 * 1024;
/// Records (events plus tasks) one shared calendar may hold.
pub const MAX_RECORDS: usize = 20_000;
/// One record, serialized.
pub const MAX_RECORD_BYTES: usize = 128 * 1024;
/// One string field of a record (notes are the long ones).
pub const MAX_FIELD_CHARS: usize = 32 * 1024;
/// A title, a name, a location: one line of text.
pub const MAX_SHORT_CHARS: usize = 1024;
/// Members of one shared calendar.
pub const MAX_MEMBERS: usize = 256;
/// Board columns of one shared to-do list.
pub const MAX_COLUMNS: usize = 64;
/// The longest a `wait` may block.
pub const MAX_WAIT_MS: u64 = 25_000;

/// What never crosses a share (§6.7): a task's mail link (mail is private),
/// its file link (it names the owner's paths), the appointment it was made
/// from (another calendar's title and place) and its project (a raw project
/// id never leaves its user's daemon); an event's CalDAV address. Stripped
/// on the way in, by the service, whatever a daemon sends.
pub const STRIPPED_FIELDS: &[&str] = &["mail", "file", "event", "project_id", "caldav_href", "caldav_etag"];
/// Short fields, bounded to [`MAX_SHORT_CHARS`].
pub const SHORT_FIELDS: &[&str] = &["title", "name", "location", "category", "color", "start", "end", "due", "completed", "created", "conference", "status", "column"];

/// A member's role on one part of a shared calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Viewer,
    Editor,
    Owner,
}

/// Which part of a calendar an operation touches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Part {
    Events,
    Tasks,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Request {
    /// Move a calendar in (the caller owns it): its name and colour, all its
    /// events and tasks, and the board columns its tasks sit in. `origin` is
    /// the calendar's id in the owner's own store, given back on `unshare`.
    Share { name: String, color: String, origin: String, events: Vec<Value>, tasks: Vec<Value>, columns: Vec<Value> },
    /// Open (or change, or close with `None`) each part of `id` to `user`.
    Grant { id: String, user: String, events: Option<Role>, tasks: Option<Role> },
    /// Take `user` off `id`: their next read fails.
    Revoke { id: String, user: String },
    /// Every shared calendar the caller may see, with their role per part.
    List,
    /// One calendar: the parts the caller may see.
    Get { id: String },
    /// One change, compare-and-swap on the record's revision.
    Apply { id: String, change: Change },
    /// Stop sharing (the owner): everything comes back, the service forgets it.
    Unshare { id: String },
    /// Block until a calendar the caller may see is not at the revision
    /// given (or appeared, or went away), or `timeout_ms` passed.
    Wait { revs: BTreeMap<String, u64>, timeout_ms: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Change {
    /// Create (`base_rev` 0, the service mints the id when it is empty or
    /// taken) or replace an event.
    PutEvent { record: Value, base_rev: u64 },
    DeleteEvent { record_id: String, base_rev: u64 },
    PutTask { record: Value, base_rev: u64 },
    DeleteTask { record_id: String, base_rev: u64 },
    /// Replace the to-do list's board columns (tasks editors and the owner).
    Columns { columns: Vec<Value> },
}

/// One shared calendar as one caller sees it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CalInfo {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub color: String,
    /// The caller's role on its events (`None`: not opened to them).
    #[serde(default)]
    pub events: Option<Role>,
    #[serde(default)]
    pub tasks: Option<Role>,
    /// Bumped by every change.
    pub rev: u64,
    /// The owner's view only: who may see what.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub members: BTreeMap<String, Grant>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    #[serde(default)]
    pub events: Option<Role>,
    #[serde(default)]
    pub tasks: Option<Role>,
}

/// A calendar's content, the parts the caller may see.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CalContent {
    pub info: CalInfo,
    #[serde(default)]
    pub events: Vec<Value>,
    #[serde(default)]
    pub tasks: Vec<Value>,
    #[serde(default)]
    pub columns: Vec<Value>,
    /// The owner's own calendar id (only in an `unshare` reply).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    /// A fixed token: `refused`, `invalid`, `unknown-calendar`, `not-owner`,
    /// `not-a-user`, `read-only`, `sharing-off`, `feature-off`, `stale`,
    /// `too-large`, `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<CalInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub list: Vec<CalInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<CalContent>,
    /// The record a `put` stored (with its new `rev`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<Value>,
    /// For `wait`: something changed.
    #[serde(default)]
    pub changed: bool,
}

impl Reply {
    pub fn ok() -> Self {
        Reply { ok: true, ..Reply::default() }
    }
    pub fn error(token: &str) -> Self {
        Reply { ok: false, error: Some(token.to_string()), ..Reply::default() }
    }
}

/// A calendar id the service mints: 32 lowercase hex characters.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A record id: what the app mints (uuids) or the service does; bounded,
/// plain.
pub fn valid_record_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@'))
}

/// Strip what never crosses a share and bound what may: an object only,
/// [`STRIPPED_FIELDS`] and every `caldav_*` key removed, every string of
/// [`SHORT_FIELDS`] at most [`MAX_SHORT_CHARS`], any other string at most
/// [`MAX_FIELD_CHARS`] (nested ones too), the whole record at most
/// [`MAX_RECORD_BYTES`]. `rev` is the service's, so it is dropped too.
pub fn clean_record(mut record: Value) -> Result<Value, &'static str> {
    let Some(object) = record.as_object_mut() else { return Err("invalid") };
    object.retain(|key, _| !STRIPPED_FIELDS.contains(&key.as_str()) && !key.starts_with("caldav_") && key != "rev");
    for (key, value) in object.iter() {
        let limit = if SHORT_FIELDS.contains(&key.as_str()) { MAX_SHORT_CHARS } else { MAX_FIELD_CHARS };
        if !strings_within(value, limit) {
            return Err("too-large");
        }
    }
    if serde_json::to_vec(&record).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_RECORD_BYTES {
        return Err("too-large");
    }
    Ok(record)
}

fn strings_within(value: &Value, limit: usize) -> bool {
    match value {
        Value::String(s) => s.chars().count() <= limit && !s.contains('\0'),
        Value::Array(items) => items.iter().all(|v| strings_within(v, MAX_FIELD_CHARS)),
        Value::Object(map) => map.values().all(|v| strings_within(v, MAX_FIELD_CHARS)),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn links_never_cross_and_fields_are_bounded() {
        let task = json!({
            "id": "t1", "calendar_id": "c", "title": "Reply to the reviewer", "rev": 9,
            "mail": {"message_id": "<m@x>", "subject": "private"},
            "file": {"path": "/home/alice/thesis/notes.md"},
            "event": {"event_id": "e", "title": "Dentist"},
            "project_id": "p-123", "caldav_href": "/dav/x.ics", "caldav_whatever": 1,
            "tags": ["a"], "subtasks": [{"title": "x", "done": false}]
        });
        let clean = clean_record(task).unwrap();
        let keys: Vec<&str> = clean.as_object().unwrap().keys().map(String::as_str).collect();
        for gone in ["mail", "file", "event", "project_id", "caldav_href", "caldav_whatever", "rev"] {
            assert!(!keys.contains(&gone), "{gone} crossed: {clean}");
        }
        assert!(keys.contains(&"tags") && keys.contains(&"subtasks"));
        assert_eq!(clean_record(json!({"title": "x".repeat(MAX_SHORT_CHARS + 1)})), Err("too-large"));
        assert!(clean_record(json!({"notes": "x".repeat(MAX_SHORT_CHARS + 1)})).is_ok(), "notes may be long");
        assert_eq!(clean_record(json!({"notes": "x".repeat(MAX_FIELD_CHARS + 1)})), Err("too-large"));
        assert_eq!(clean_record(json!({"subtasks": [{"title": "x".repeat(MAX_FIELD_CHARS + 1)}]})), Err("too-large"));
        assert_eq!(clean_record(json!("not an object")), Err("invalid"));
        assert!(valid_id(&"0".repeat(32)) && !valid_id("../x"));
        assert!(valid_record_id("6a1c-uuid_x") && !valid_record_id("a/b") && !valid_record_id(""));
    }
}
