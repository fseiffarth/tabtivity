//! MCP authorization is backend policy, never a model instruction or a hint.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

use super::root_mcp::Caller;

pub const MAX_BODY: usize = 128 * 1024;
pub const MAX_RESPONSE: usize = 512 * 1024;
pub const MAX_ROWS: usize = 100;
pub const MAX_PENDING: usize = 500;
pub const MAX_PENDING_PER_TAB: usize = 100;
pub const MAX_LOG_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct Audit {
    /// Empty for a request that never authenticated ([`audit_admission`]).
    pub session: String,
    /// `None` for the same: no token, no class.
    pub caller: Option<Caller>,
    pub tool: String,
    pub outcome: &'static str,
    pub elapsed_ms: u64,
    pub time: u64,
    pub target: Option<String>,
    pub reason: Option<&'static str>,
}
static AUDIT: std::sync::Mutex<std::collections::VecDeque<Audit>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
/// Rows in memory at most; the oldest goes when a new one arrives.
pub const AUDIT_ROWS: usize = 500;
/// Of those, how many may be unauthenticated admission failures: a probe
/// must show, but a flood of probes must not push the real records out.
pub const AUDIT_ADMISSION_ROWS: usize = 50;
/// The `tool` of an [`audit_admission`] row.
pub const ADMISSION: &str = "admission";

/// A request refused before it authenticated: wrong or missing token, a
/// browser `Origin`, a foreign `Host`. Only the fixed `reason` is kept — never
/// the header, the token material or the path as sent — and the category is
/// bounded on its own ([`AUDIT_ADMISSION_ROWS`]).
pub fn audit_admission(reason: &'static str) {
    let mut rows = AUDIT.lock().unwrap_or_else(|p| p.into_inner());
    if rows.iter().filter(|r| r.tool == ADMISSION).count() >= AUDIT_ADMISSION_ROWS {
        if let Some(oldest) = rows.iter().position(|r| r.tool == ADMISSION) {
            rows.remove(oldest);
        }
    }
    if rows.len() >= AUDIT_ROWS {
        rows.pop_front();
    }
    rows.push_back(Audit {
        session: String::new(), caller: None, tool: ADMISSION.into(), outcome: "denied",
        elapsed_ms: 0, target: None, reason: Some(reason),
        time: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
    });
}
pub fn audit(
    session: &super::root_mcp::Session,
    name: &str,
    outcome: &'static str,
    elapsed: std::time::Duration,
) {
    audit_reason(session, name, outcome, elapsed, None);
}

pub fn audit_reason(session: &super::root_mcp::Session, name: &str, outcome: &'static str, elapsed: std::time::Duration, reason: Option<&'static str>) {
    let mut rows = AUDIT.lock().unwrap_or_else(|p| p.into_inner());
    if rows.len() >= AUDIT_ROWS {
        rows.pop_front();
    }
    rows.push_back(Audit {
        target: session.identity.schedule_target.as_ref().map(|b| b.target.clone()),
        reason,
        session: session.id.clone(),
        caller: Some(session.identity.caller),
        // Do not echo arbitrary method names (which may contain private text).
        tool: if tool(name).is_some() || super::schedule_mcp::tool_names().contains(&name) || super::git_push_mcp::tool_names().contains(&name) {
            name
        } else {
            "protocol"
        }
        .into(),
        outcome,
        elapsed_ms: elapsed.as_millis().min(u64::MAX as u128) as u64,
        time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    });
}
pub fn audit_rows() -> Vec<Audit> {
    AUDIT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .cloned()
        .collect()
}
#[cfg(test)]
pub(crate) fn audit_clear() {
    AUDIT.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub enabled: bool,
    pub local_only: bool,
    pub mail: bool,
    /// `Settings::root_mcp_mail_local_only`: mail for local-model tabs only.
    pub mail_local_only: bool,
    /// `Settings::root_mcp_mail_local_read`: a local-model tab may read the
    /// marked mails ([`Self::reads_mail`]).
    pub mail_local_read: bool,
    pub review: String,
}
impl Policy {
    pub fn load(path: &Path) -> Result<Self, String> {
        // Missing is NOT evidence of a fresh install: the file may have been
        // removed mid-session. Spawn and requests both refuse until initialized.
        let settings: crate::schema::Settings = crate::storage::read_json(path)
            .map_err(|_| "MCP security settings are unavailable".to_string())?;
        Ok(Self::from_settings(&settings))
    }
    pub fn from_settings(s: &crate::schema::Settings) -> Self {
        Self {
            enabled: s.root_mcp(),
            local_only: s.root_mcp_local_only(),
            mail: s.root_mcp_mail(),
            mail_local_only: s.root_mcp_mail_local_only(),
            mail_local_read: s.root_mcp_mail_local_read(),
            review: s
                .root_mcp_review
                .as_deref()
                .filter(|v| matches!(*v, "all" | "destructive" | "off"))
                .unwrap_or("all")
                .to_string(),
        }
    }
    pub fn serves(&self, caller: Caller) -> bool {
        if matches!(caller, Caller::Scheduler | Caller::Pusher | Caller::Helper | Caller::Marker) { return false; }
        self.enabled
            && (!self.local_only || caller == Caller::LocalModel)
            && (caller != Caller::Reader || self.serves_mail(caller))
    }
    /// Whether `caller` is listed and served the mail tools. Only the mail
    /// switch and its local-only companion decide it; [`Self::serves`] still
    /// gates the endpoint as a whole. A reader is never a local model, so
    /// local-only mail serves it nothing.
    pub fn serves_mail(&self, caller: Caller) -> bool {
        self.mail && (!self.mail_local_only || caller == Caller::LocalModel)
    }
    /// Whether `caller` is listed and served the mail **read** tools: a reader
    /// whenever it is served mail, a local-model tab only while
    /// `mail_local_read` is on (and then marked mails only,
    /// `root_mcp_mail::ScopedMail`). A cloud root agent never reads.
    pub fn reads_mail(&self, caller: Caller) -> bool {
        self.serves_mail(caller)
            && match caller {
                Caller::Reader => true,
                Caller::LocalModel => self.mail_local_read,
                Caller::Agent | Caller::Scheduler | Caller::Pusher | Caller::Helper | Caller::Marker => false,
            }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub all: bool,
    pub ids: Vec<String>,
}
impl Scope {
    pub fn contains(&self, id: &str) -> bool {
        self.all || self.ids.iter().any(|v| v == id)
    }
    fn unrestricted() -> Self {
        Self {
            all: true,
            ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Access {
    pub calendars: Scope,
    pub projects: Scope,
    pub accounts: Scope,
    pub families: Vec<String>,
    pub write: bool,
}
impl Access {
    /// The copy a proposal carries (`mcp_access`), read back leniently: a
    /// field a later build added is dropped, not a reason to refuse approval
    /// of what an older build staged. The wire (`root_mcp_session_access`)
    /// stays strict.
    pub fn from_stored(value: &Value) -> Result<Self, String> {
        let mut value = value.clone();
        let obj = value.as_object_mut().ok_or("Invalid MCP access grant")?;
        obj.retain(|k, _| matches!(k.as_str(), "calendars" | "projects" | "accounts" | "families" | "write"));
        for key in ["calendars", "projects", "accounts"] {
            if let Some(scope) = obj.get_mut(key).and_then(Value::as_object_mut) {
                scope.retain(|k, _| matches!(k.as_str(), "all" | "ids"));
            }
        }
        let access: Self = serde_json::from_value(value).map_err(|_| "Invalid MCP access grant")?;
        access.validate()?;
        Ok(access)
    }
    pub fn initial(caller: Caller) -> Self {
        let reader = caller == Caller::Reader;
        Self {
            calendars: if reader {
                Scope::default()
            } else {
                Scope::unrestricted()
            },
            projects: if reader {
                Scope::default()
            } else {
                Scope::unrestricted()
            },
            accounts: Scope::unrestricted(),
            families: if reader {
                vec!["mail".into()]
            } else {
                vec![
                    "calendar".into(),
                    "board".into(),
                    "projects".into(),
                    "mail".into(),
                ]
            },
            write: true,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.families.len() > 4
            || self
                .families
                .iter()
                .any(|f| !matches!(f.as_str(), "calendar" | "board" | "projects" | "mail"))
            || [&self.calendars, &self.projects, &self.accounts]
                .iter()
                .any(|s| s.ids.len() > 1000 || s.ids.iter().any(|id| id.len() > 256))
        {
            return Err("Invalid MCP access grant".into());
        }
        Ok(())
    }
    pub fn allows(&self, caller: Caller, name: &str) -> bool {
        tool(name).is_some_and(|t| {
            t.serves(caller)
                && (t.family == "session" || self.families.iter().any(|f| f == t.family))
                && (!t.write || self.write)
        })
    }
    pub fn row(&self, kind: &str, row: &Value) -> bool {
        let id = |key: &str| row[key].as_str().unwrap_or("");
        match kind {
            "event" => self.calendars.contains(id("calendar_id")),
            "task" => {
                self.calendars.contains(id("calendar_id"))
                    && self.projects.contains(id("project_id"))
            }
            "calendar" => self.calendars.contains(id("id")),
            // Changing shared board structure requires the entire board scope.
            "board" => self.calendars.all && self.projects.all,
            _ => false,
        }
    }
    pub fn filter_calendar(&self, data: &mut Value) {
        for (key, kind) in [
            ("events", "event"),
            ("tasks", "task"),
            ("calendars", "calendar"),
        ] {
            if let Some(rows) = data[key].as_array_mut() {
                rows.retain(|r| self.row(kind, r));
            }
        }
    }
}

pub struct ToolPolicy {
    pub family: &'static str,
    pub write: bool,
    pub destructive: bool,
    root: bool,
    reader: bool,
    /// Also served to a local-model tab. Only the mail read tools set it, and
    /// [`Policy::reads_mail`] still gates them per request.
    local: bool,
    /// Served to [`Caller::Helper`] (`services::help_mcp`) — and then to no
    /// other class: the help tools set it and nothing else.
    help: bool,
    /// Served to [`Caller::Marker`] (`services::markup_mcp`) — and then to
    /// no other class: the two markup tools set it and nothing else.
    marker: bool,
}
impl ToolPolicy {
    pub fn serves(&self, caller: Caller) -> bool {
        match caller {
            Caller::Scheduler | Caller::Pusher => false,
            Caller::Helper => self.help,
            Caller::Marker => self.marker,
            Caller::Reader => self.reader,
            Caller::LocalModel => self.root || self.local,
            Caller::Agent => self.root,
        }
    }
}

/// Every name must be deliberately assigned. Unknown names never inherit a role.
pub fn tool(name: &str) -> Option<ToolPolicy> {
    let (family, write, destructive, root, reader) = match name {
        "proposals_list" => ("session", false, false, true, true),
        "projects_list"
        | "projects_git_status"
        | "sync_status"
        | "time_summary"
        | "usage_recap"
        | "project_activity"
        | "boxes_list" => ("projects", false, false, true, false),
        "calendar_list" | "calendar_free_busy" => ("calendar", false, false, true, true),
        "calendar_create" | "calendar_add_event" => ("calendar", true, false, true, true),
        // Root only: a reader is handed no attachment, and a file's text must
        // not reach the calendar through it (`root_mcp_import`).
        "calendar_import_ics" => ("calendar", true, false, true, false),
        "calendar_update_event" | "calendar_move_events" | "calendar_delete_event" => {
            ("calendar", true, true, true, true)
        }
        "todo_list" => ("board", false, false, true, true),
        "todo_add" | "todo_complete" | "todo_reopen" | "todo_move" => {
            ("board", true, false, true, true)
        }
        "todo_update" | "todo_delete" => ("board", true, true, true, true),
        "mail_accounts_list" | "mail_drafts_list" => ("mail", false, false, true, true),
        "mail_folders" | "mail_search" | "mail_read" | "mail_thread" => {
            return Some(ToolPolicy { family: "mail", write: false, destructive: false, root: false, reader: true, local: true, help: false, marker: false });
        }
        // The help corpus (`services::help_mcp`): read-only, compiled in, and
        // served to the help identity alone — never to a root or reader tab
        // through `/mcp`, so the root tool list stays what it was.
        crate::brand::HELP_TOOL_SEARCH
        | crate::brand::HELP_TOOL_READ
        | crate::brand::HELP_TOOL_TOPICS
        | crate::brand::HELP_TOOL_STATUS => {
            return Some(ToolPolicy { family: "help", write: false, destructive: false, root: false, reader: false, local: false, help: true, marker: false });
        }
        // The markup questions (`services::markup_mcp`): they only put a card
        // in front of the user, served to the markup identity alone on
        // `/mcp/markup` — never to a root or reader tab through `/mcp`.
        "markup_ask" | "markup_withdraw" => {
            return Some(ToolPolicy { family: "markup", write: true, destructive: false, root: false, reader: false, local: false, help: false, marker: true });
        }
        "mail_draft_create" => ("mail", true, false, true, true),
        "mail_draft_update" | "mail_draft_delete" => ("mail", true, true, true, true),
        _ => return None,
    };
    Some(ToolPolicy {
        family,
        write,
        destructive,
        root,
        reader,
        local: false,
        help: false,
        marker: false,
    })
}

/// The schemas here use only these primitive types, required, enum, and bounds.
/// Reject additional arguments instead of silently ignoring misspellings.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    let valid = match schema["type"].as_str() {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.is_i64() || value.is_u64(),
        _ => false,
    };
    if !valid {
        return Err("Invalid argument type".into());
    }
    if let Some(s) = value.as_str() {
        // 32 KiB unless the schema names its own bound (a whole `.ics` file).
        let max = schema["maxLength"].as_u64().map_or(32 * 1024, |n| n as usize);
        if s.len() > max {
            return Err(format!("Argument text exceeds {} KiB", max / 1024));
        }
    }
    if let Some(n) = value.as_f64() {
        if schema["minimum"].as_f64().is_some_and(|min| n < min)
            || schema["maximum"].as_f64().is_some_and(|max| n > max)
        {
            return Err("Argument is outside its permitted range".into());
        }
    }
    if schema["enum"]
        .as_array()
        .is_some_and(|v| !v.contains(value))
    {
        return Err("Invalid argument choice".into());
    }
    if let Some(rows) = value.as_array() {
        if rows.len() > MAX_ROWS {
            return Err("Too many argument items".into());
        }
        for v in rows {
            validate(&schema["items"], v)?;
        }
    }
    if let Some(fields) = value.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for key in required.iter().filter_map(Value::as_str) {
                if !fields.contains_key(key) {
                    return Err(format!("`{key}` is required"));
                }
            }
        }
        for (key, v) in fields {
            let property = schema["properties"].get(key).ok_or("Unknown argument")?;
            validate(property, v)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn settings_errors_do_not_reopen_access() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(Policy::load(&path).is_err());
        for invalid in ["{", "null", "{\"root_mcp\":\"true\"}"] {
            std::fs::write(&path, invalid).unwrap();
            assert!(Policy::load(&path).is_err());
        }
        std::fs::write(&path, "{}").unwrap();
        assert!(Policy::load(&path).unwrap().serves(Caller::Agent));
    }
    /// Every mail switch × local-only × class. The companion narrows mail
    /// only: it never widens it, never touches the other tools, and a reader
    /// (always a cloud CLI) loses the endpoint with it.
    #[test]
    fn mail_local_only_keeps_mail_to_local_models() {
        let classes = [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Scheduler, Caller::Pusher];
        for mail in [false, true] {
            for mail_local_only in [false, true] {
                let policy = Policy { enabled: true, local_only: false, mail, mail_local_only, mail_local_read: false, review: "all".into() };
                for caller in classes {
                    let expected = mail && (!mail_local_only || caller == Caller::LocalModel);
                    assert_eq!(policy.serves_mail(caller), expected, "mail={mail} local={mail_local_only} {caller:?}");
                }
                assert_eq!(policy.serves(Caller::Reader), mail && !mail_local_only, "reader: mail={mail} local={mail_local_only}");
                assert!(policy.serves(Caller::Agent), "the other tools stay on: mail={mail} local={mail_local_only}");
                assert!(policy.serves(Caller::LocalModel));
                assert!(!policy.serves(Caller::Scheduler));
                assert!(!policy.serves(Caller::Pusher));
            }
        }
    }

    #[test]
    fn mail_local_only_is_read_from_settings_and_absent_means_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let load = |body: &str| {
            std::fs::write(&path, body).unwrap();
            Policy::load(&path).unwrap()
        };
        let off = load(r#"{"root_mcp_mail":true}"#);
        assert!(!off.mail_local_only);
        assert!(off.serves_mail(Caller::Agent) && off.serves_mail(Caller::Reader));
        let on = load(r#"{"root_mcp_mail":true,"root_mcp_mail_local_only":true}"#);
        assert!(on.mail_local_only);
        assert!(!on.serves_mail(Caller::Agent) && !on.serves_mail(Caller::Reader));
        assert!(on.serves_mail(Caller::LocalModel));
        // Alone it opens nothing: mail stays off until its own switch is on.
        let alone = load(r#"{"root_mcp_mail_local_only":true}"#);
        assert!(!alone.serves_mail(Caller::LocalModel));
        let explicit_off = load(r#"{"root_mcp_mail":true,"root_mcp_mail_local_only":false}"#);
        assert!(explicit_off.serves_mail(Caller::Agent));
        // A wrongly typed value is unreadable settings, which refuse everything.
        std::fs::write(&path, r#"{"root_mcp_mail":true,"root_mcp_mail_local_only":"yes"}"#).unwrap();
        assert!(Policy::load(&path).is_err());
    }

    /// Reading mail: a reader whenever it is served mail; a local-model tab
    /// only with `mail_local_read`, which also survives `mail_local_only`; a
    /// cloud root agent never, whatever the switches say.
    #[test]
    fn only_readers_and_opted_in_local_models_read_mail() {
        for mail in [false, true] {
            for mail_local_only in [false, true] {
                for mail_local_read in [false, true] {
                    let p = Policy { enabled: true, local_only: false, mail, mail_local_only, mail_local_read, review: "all".into() };
                    let case = format!("mail={mail} local_only={mail_local_only} local_read={mail_local_read}");
                    assert!(!p.reads_mail(Caller::Agent) && !p.reads_mail(Caller::Scheduler), "{case}");
                    assert_eq!(p.reads_mail(Caller::Reader), mail && !mail_local_only, "{case}");
                    assert_eq!(p.reads_mail(Caller::LocalModel), mail && mail_local_read, "{case}");
                }
            }
        }
        for name in ["mail_folders", "mail_search", "mail_read", "mail_thread"] {
            let t = tool(name).unwrap();
            assert!(t.serves(Caller::Reader) && t.serves(Caller::LocalModel), "{name}");
            assert!(!t.serves(Caller::Agent) && !t.serves(Caller::Scheduler) && !t.serves(Caller::Pusher), "{name}");
        }
        // No other tool gains a local-only row.
        for name in super::super::root_mcp::tool_names() {
            let t = tool(name).unwrap();
            if !["mail_folders", "mail_search", "mail_read", "mail_thread"].contains(&name) {
                assert_eq!(t.serves(Caller::LocalModel), t.serves(Caller::Agent), "{name}");
            }
        }
    }

    /// An older build must approve what a newer one staged: a grant with a
    /// field it never heard of parses to the fields it knows, while the same
    /// value on the wire is still refused.
    #[test]
    fn a_stored_grant_tolerates_unknown_fields_the_wire_does_not() {
        let mut stored = serde_json::to_value(Access::initial(Caller::Agent)).unwrap();
        stored["future_field"] = json!({"nested": true});
        stored["calendars"]["future_scope_field"] = json!(1);
        let back = Access::from_stored(&stored).unwrap();
        assert_eq!(back, Access::initial(Caller::Agent));
        assert!(serde_json::from_value::<Access>(stored.clone()).is_err(), "the wire stays strict");
        // A round trip through serialisation is exact once the extras are gone.
        assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(Access::initial(Caller::Agent)).unwrap());
        assert!(Access::from_stored(&json!({"write": true})).is_err(), "a missing field is still missing");
        assert!(Access::from_stored(&json!("no")).is_err());
    }

    /// The validator's own bound on a string: 32 KiB unless the schema names
    /// a larger one (the `.ics` import does), and the message says which.
    #[test]
    fn validator_honours_a_schemas_own_max_length() {
        let default = json!({"type": "string"});
        assert!(validate(&default, &json!("x".repeat(32 * 1024))).is_ok());
        let err = validate(&default, &json!("x".repeat(32 * 1024 + 1))).unwrap_err();
        assert!(err.contains("32 KiB"), "{err}");
        let wide = json!({"type": "string", "maxLength": 96 * 1024});
        assert!(validate(&wide, &json!("x".repeat(96 * 1024))).is_ok());
        let err = validate(&wide, &json!("x".repeat(96 * 1024 + 1))).unwrap_err();
        assert!(err.contains("96 KiB"), "{err}");
        let narrow = json!({"type": "string", "maxLength": 8});
        assert!(validate(&narrow, &json!("123456789")).is_err());
        assert!(validate(&narrow, &json!("12345678")).is_ok());
    }

    /// Audit rows name a tool only when it is one Tabtivity serves; anything else
    /// — a method name an agent made up, private text included — is written
    /// down as `protocol`. The ring holds 500 rows, and the admission failures
    /// in it are bounded on their own so a probe flood cannot evict the rest.
    #[test]
    fn audit_masks_unknown_names_and_caps_its_rows() {
        audit_clear();
        let (_, session) = super::super::root_mcp::test_session(Caller::Agent);
        audit(&session, "calendar_list", "allowed", std::time::Duration::ZERO);
        audit(&session, "schedule_prompt", "refused", std::time::Duration::ZERO);
        audit(&session, "tools/call: my private note about Alice", "refused", std::time::Duration::ZERO);
        audit(&session, "", "denied", std::time::Duration::ZERO);
        let rows = audit_rows();
        let tools: Vec<&str> = rows.iter().map(|r| r.tool.as_str()).collect();
        assert_eq!(tools, ["calendar_list", "schedule_prompt", "protocol", "protocol"]);
        assert!(rows.iter().all(|r| r.caller == Some(Caller::Agent) && r.session == session.id));
        assert!(!serde_json::to_string(&rows).unwrap().contains("Alice"));
        for _ in 0..(AUDIT_ADMISSION_ROWS + 10) {
            audit_admission("unauthorized");
        }
        let rows = audit_rows();
        assert_eq!(rows.iter().filter(|r| r.tool == ADMISSION).count(), AUDIT_ADMISSION_ROWS);
        assert_eq!(rows.iter().filter(|r| r.tool != ADMISSION).count(), 4, "probes evict probes, not records");
        let probe = rows.iter().find(|r| r.tool == ADMISSION).unwrap();
        assert!(probe.caller.is_none() && probe.session.is_empty() && probe.reason == Some("unauthorized") && probe.outcome == "denied");
        for _ in 0..AUDIT_ROWS {
            audit(&session, "ping", "allowed", std::time::Duration::ZERO);
        }
        assert_eq!(audit_rows().len(), AUDIT_ROWS);
        assert_eq!(audit_rows().iter().filter(|r| r.tool == ADMISSION).count(), 0, "the oldest rows go first, probes included");
        super::super::root_mcp::revoke_tab(&session.identity.tab);
        audit_clear();
    }

    #[test]
    fn new_tools_and_reader_data_are_denied() {
        assert!(tool("calendar_new_tool").is_none());
        for name in super::super::root_mcp::tool_names() {
            assert!(tool(name).is_some(), "unclassified tool: {name}");
        }
        let reader = Access::initial(Caller::Reader);
        assert!(!reader.allows(Caller::Reader, "calendar_list"));
        assert!(!reader.row("task", &json!({"project_id":"", "calendar_id":"default"})));
        let mut root = Access::initial(Caller::Agent);
        root.write = false;
        assert!(root.allows(Caller::Agent, "calendar_list"));
        assert!(!root.allows(Caller::Agent, "calendar_add_event"));
    }
}
