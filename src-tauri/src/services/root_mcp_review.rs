//! Root MCP's backend-owned copies and immutable, row-based write proposals.
//! Lock order: REVIEW_LOCK, then the calendar RMW lock. No AppHandle or IPC.
use super::root_mcp::{self, Change, Effects, Stores};
use super::root_mcp_security::{self as security, Access};
use crate::{commands::calendar, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

static REVIEW_LOCK: Mutex<()> = Mutex::new(());
pub fn lock() -> MutexGuard<'static, ()> {
    REVIEW_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

// set_caldav_identity_at writes precisely these two fields. The fetch merge
// also replaces content; that content MUST participate in the precondition.
pub const SYNC_FIELDS: &[&str] = &["caldav_etag", "caldav_href"];
/// The store's own bookkeeping on a row (`rev`, #171): never part of what an
/// agent proposes, so it is ignored when a row is compared and carried from
/// the current row when one is written, exactly like the sync fields.
const STORE_FIELDS: &[&str] = &["rev"];
const CONFLICT: &str = "This entry changed since the agent looked at it";
/// An automatic write (`destructive` level) that could not be stored for a
/// reason other than a stale precondition: the store was unreadable, the disk
/// full. Nothing landed; the proposal is `failed`, never `conflicted`.
const FAILED: &str = "The change could not be stored (not a conflict); propose it again";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    pub kind: String,
    pub op: String,
    pub pre: Option<Value>,
    pub post: Value,
    pub local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub tab: String,
    pub tool: String,
    pub args: Value,
    pub created: String,
    pub rows: Vec<Row>,
    // Calendar routing and access are also bound to the review. Changing a
    // subscription while a proposal waits must not redirect an approved push.
    pub calendars: Vec<Value>,
    pub tainted: bool,
    // String, not an enum: future statuses survive an older reader's save.
    pub status: String,
    #[serde(default)]
    pub undo: bool,
    #[serde(default)]
    pub notified: bool,
    #[serde(default, flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Serialize)]
pub struct ReviewEntry {
    #[serde(flatten)]
    pub proposal: Proposal,
    pub digest: String,
    pub closed: bool,
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn digest(p: &Proposal) -> String {
    hash(
        serde_json::to_string(&json!([
            p.id,
            p.tab,
            p.tool,
            p.args,
            p.created,
            p.rows,
            p.calendars,
            p.undo,
            p.tainted,
            p.extra.get("mcp_access"), p.extra.get("mcp_caller"), p.extra.get("mcp_session")
        ]))
        .unwrap()
        .as_bytes(),
    )
}
fn log_path(state: &Path) -> PathBuf {
    state.join("root_mcp/proposals.json")
}
pub fn sandbox(state: &Path, tab: &str) -> PathBuf {
    // PTY ids are opaque, never path components supplied by an agent.
    state
        .join("root_mcp/sandboxes")
        .join(hash(tab.as_bytes()))
        .join("calendar.json")
}
pub fn load(state: &Path) -> Result<Vec<Proposal>, String> {
    let path = log_path(state);
    if !path.exists() {
        return Ok(Vec::new());
    }
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > security::MAX_LOG_BYTES as u64 {
        return Err("MCP proposal log exceeds its size limit".into());
    }
    storage::read_json(&path).map_err(|e| e.to_string())
}
fn save(state: &Path, proposals: &[Proposal]) -> Result<(), String> {
    let mut keep = proposals.to_vec();
    let mut decided = 0;
    keep.reverse();
    keep.retain(|p| {
        // Unknown future statuses are never silently evicted either.
        if matches!(
            p.status.as_str(),
            "applied" | "rejected" | "conflicted" | "undone" | "failed"
        ) {
            decided += 1;
            decided <= 200
        } else {
            true
        }
    });
    keep.reverse();
    if serde_json::to_vec(&keep).map_err(|e| e.to_string())?.len() > security::MAX_LOG_BYTES {
        return Err("MCP proposal storage limit reached; review pending proposals".into());
    }
    storage::write_json_atomic(&log_path(state), &keep).map_err(|e| e.to_string())
}
/// Whether every row of an automatic write already holds in `data`: its
/// `post` is the current row (a delete: no row). What a proposal looks like
/// when the write landed but the log's `applied` save did not follow.
fn landed(data: &Value, p: &Proposal) -> bool {
    p.rows.iter().all(|r| {
        let current = row_at(data, &r.kind, &r.post["id"]);
        if r.op == "delete" { current.is_none() } else { same(&Some(r.post.clone()), &current) }
    })
}

/// The last replay `list` verified: the real file and the pending set it saw.
/// A panel that polls re-reads the log, not the calendar per proposal.
static LIST_SEEN: Mutex<Option<String>> = Mutex::new(None);

pub fn list(stores: &Stores) -> Result<Vec<ReviewEntry>, String> {
    let _guard = lock();
    let mut proposals = load(stores.state)?;
    let real_bytes = std::fs::read(stores.calendar).unwrap_or_default();
    let pending: Vec<(&str, &str)> = proposals.iter().filter(|p| p.status == "pending").map(|p| (p.id.as_str(), p.created.as_str())).collect();
    let signature = hash(serde_json::to_string(&json!([hash(&real_bytes), pending])).unwrap().as_bytes());
    let verified = LIST_SEEN.lock().unwrap_or_else(|p| p.into_inner()).as_deref() == Some(signature.as_str());
    if !verified {
        let mut tabs = std::collections::HashSet::new();
        for p in &proposals {
            if p.status == "pending" {
                tabs.insert(p.tab.clone());
            }
        }
        let real = data_at(stores.calendar)?;
        let mut changed = false;
        for tab in tabs {
            // One working copy per tab, mutated in place: a proposal is checked
            // against a scratch clone only when the tab has more than one, and
            // then the clone is of the copy, not of the whole store again.
            let mut data = real.clone();
            for p in proposals
                .iter_mut()
                .filter(|p| p.tab == tab && p.status == "pending")
            {
                if p.undo && landed(&data, p) {
                    // An automatic write whose rows are already there: it was
                    // applied and the log did not get to say so.
                    p.status = "applied".into();
                    changed = true;
                    continue;
                }
                let mut candidate = data.clone();
                if apply_rows(&mut candidate, &p.rows, &p.calendars).is_ok() {
                    data = candidate;
                } else {
                    p.status = "conflicted".into();
                    changed = true;
                }
            }
        }
        if changed {
            save(stores.state, &proposals)?;
        }
        *LIST_SEEN.lock().unwrap_or_else(|p| p.into_inner()) = Some(signature);
    }
    Ok(proposals
        .into_iter()
        .map(|p| ReviewEntry {
            digest: digest(&p),
            closed: !root_mcp::tab_active(&p.tab),
            proposal: p,
        })
        .collect())
}
pub fn pending_count(state: &Path) -> usize {
    load(state)
        .unwrap_or_default()
        .iter()
        .filter(|p| p.status == "pending")
        .count()
}
fn array_key(kind: &str) -> Result<&'static str, String> {
    match kind {
        "event" => Ok("events"),
        "task" => Ok("tasks"),
        "calendar" => Ok("calendars"),
        _ => Err("Unknown row kind".into()),
    }
}
fn board(data: &Value) -> Value {
    json!({"id": "board", "task_columns": data.get("task_columns").cloned().unwrap_or(json!([])),
        "board_upgrades": data.get("board_upgrades").cloned().unwrap_or(json!([]))})
}
fn row_at(data: &Value, kind: &str, id: &Value) -> Option<Value> {
    if kind == "board" {
        return Some(board(data));
    }
    data.get(array_key(kind).ok()?)?
        .as_array()?
        .iter()
        .find(|r| &r["id"] == id)
        .cloned()
}
fn comparable(mut row: Value) -> Value {
    if let Some(obj) = row.as_object_mut() {
        for key in SYNC_FIELDS.iter().chain(STORE_FIELDS) {
            obj.remove(*key);
        }
    }
    row
}
fn same(pre: &Option<Value>, current: &Option<Value>) -> bool {
    pre.clone().map(comparable) == current.clone().map(comparable)
}
fn put(data: &mut Value, r: &Row, post: Value) -> Result<(), String> {
    if r.kind == "board" {
        for key in ["task_columns", "board_upgrades"] {
            if post[key].as_array().is_some_and(Vec::is_empty) {
                data.as_object_mut().unwrap().remove(key);
            } else {
                data[key] = post[key].clone();
            }
        }
        return Ok(());
    }
    let key = array_key(&r.kind)?;
    let rows = data[key].as_array_mut().ok_or("Invalid calendar store")?;
    let slot = rows.iter().position(|v| v["id"] == post["id"]);
    match (r.op.as_str(), slot) {
        ("delete", Some(i)) => {
            rows.remove(i);
        }
        ("upsert", Some(i)) => rows[i] = post,
        ("upsert", None) => rows.push(post),
        _ => return Err(CONFLICT.into()),
    }
    Ok(())
}
fn change(r: &Row, row: Value) -> Option<Change> {
    let kind = match r.kind.as_str() {
        "event" => "event",
        "task" => "task",
        "calendar" => "calendar",
        _ => return None,
    };
    Some(Change {
        kind,
        op: if r.op == "delete" { "delete" } else { "upsert" },
        row,
        local: r.local,
    })
}

/// Work on a private Value; the caller writes only when ALL rows pass.
pub fn apply_rows(
    data: &mut Value,
    rows: &[Row],
    calendars: &[Value],
) -> Result<Vec<Change>, String> {
    for expected in calendars {
        let actual = row_at(data, "calendar", &expected["id"]);
        if actual.map(comparable) != Some(comparable(expected.clone())) || expected["readonly"] == true {
            return Err(CONFLICT.into());
        }
    }
    let mut effects = Vec::new();
    for r in rows {
        let current = row_at(data, &r.kind, &r.post["id"]);
        if !same(&r.pre, &current) {
            return Err(CONFLICT.into());
        }
        if r.kind == "calendar" && r.op == "delete" {
            // Undo a calendar create only while it is still empty.
            for key in ["events", "tasks"] {
                if data[key]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v["calendar_id"] == r.post["id"]))
                {
                    return Err(CONFLICT.into());
                }
            }
        }
        let mut post = r.post.clone();
        if let Some(current) = current {
            // Deletions address today's resource. Ordinary edits keep fresh
            // push metadata; a relocation deliberately drops the old address.
            // The store's own revision rides along whatever the edit is: the
            // write path stamps the next one from it.
            let carried: Vec<&str> = if r.op == "delete" || current["calendar_id"] == post["calendar_id"] {
                SYNC_FIELDS.iter().chain(STORE_FIELDS).copied().collect()
            } else {
                STORE_FIELDS.to_vec()
            };
            for key in carried {
                if let Some(v) = current.get(key) {
                    post[key] = v.clone();
                } else if let Some(obj) = post.as_object_mut() {
                    obj.remove(key);
                }
            }
        }
        put(data, r, post.clone())?;
        if let Some(c) = change(r, post) {
            effects.push(c);
        }
    }
    Ok(effects)
}

fn data_at(path: &Path) -> Result<Value, String> {
    serde_json::to_value(calendar::read_data(path)?).map_err(|e| e.to_string())
}
fn rebuild(stores: &Stores, tab: &str, proposals: &mut [Proposal]) -> Result<PathBuf, String> {
    let path = sandbox(stores.state, tab);
    let real_bytes = match std::fs::read(stores.calendar) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.to_string()),
    };
    let pending: Vec<&Proposal> = proposals
        .iter()
        .filter(|p| p.tab == tab && p.status == "pending")
        .collect();
    let signature = hash(
        serde_json::to_string(&json!([hash(&real_bytes), pending, stores.access]))
            .unwrap()
            .as_bytes(),
    );
    let stamp_path = path.with_extension("stamp.json");
    if let (Ok(stamp), Ok(copy)) = (
        storage::read_json::<Value>(&stamp_path),
        std::fs::read(&path),
    ) {
        if stamp["source"] == signature && stamp["copy"] == hash(&copy) {
            return Ok(path);
        }
    }
    let mut data = data_at(stores.calendar)?;
    for p in proposals
        .iter_mut()
        .filter(|p| p.tab == tab && p.status == "pending")
    {
        let mut candidate = data.clone();
        if apply_rows(&mut candidate, &p.rows, &p.calendars).is_ok() {
            data = candidate;
        } else {
            p.status = "conflicted".into();
        }
    }
    stores.access.filter_calendar(&mut data);
    storage::write_json_atomic(&path, &data).map_err(|e| e.to_string())?;
    let copy = std::fs::read(&path).map_err(|e| e.to_string())?;
    storage::write_json_atomic(
        &stamp_path,
        &json!({"source": signature, "copy": hash(&copy)}),
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

fn capture(before: &Value, after: &Value, changes: &[Change]) -> Result<Vec<Row>, String> {
    let mut cursor = before.clone();
    let mut rows = Vec::new();
    // Preserve relocation's delete/upsert ordering for the CalDAV event path.
    for c in changes {
        let r = Row {
            kind: c.kind.into(),
            op: c.op.into(),
            pre: row_at(&cursor, c.kind, &c.row["id"]),
            post: c.row.clone(),
            local: c.local,
        };
        put(&mut cursor, &r, r.post.clone())?;
        rows.push(r);
    }
    // A first board move seeds columns and normalizes other cards. Capture
    // these side effects too; a Change alone does not describe the whole write.
    for kind in ["calendar", "event", "task"] {
        let key = array_key(kind)?;
        for post in after[key].as_array().ok_or("Invalid calendar store")? {
            let pre = row_at(&cursor, kind, &post["id"]);
            if !same(&pre, &Some(post.clone())) {
                // A card the seeding merely filed into a column is not part of
                // the write: the store derives that placement on every read
                // once the board exists, so the proposal carries only the
                // board row. It is also what keeps a first move on a big
                // unplaced board inside the batch limit.
                if kind == "task" && pre.as_ref().is_some_and(|pre| placement_backfill(pre, post)) {
                    continue;
                }
                rows.push(Row {
                    kind: kind.into(),
                    op: "upsert".into(),
                    pre,
                    post: post.clone(),
                    local: true,
                });
            }
        }
    }
    if board(before) != board(after) {
        rows.push(Row {
            kind: "board".into(),
            op: "upsert".into(),
            pre: Some(board(before)),
            post: board(after),
            local: true,
        });
    }
    Ok(rows)
}
/// `post` is `pre` with a column and rank filled in where there was none.
fn placement_backfill(pre: &Value, post: &Value) -> bool {
    let unplaced = pre["column"].as_str().is_none_or(str::is_empty);
    let (pre, post) = (comparable(pre.clone()), comparable(post.clone()));
    let (Some(a), Some(b)) = (pre.as_object(), post.as_object()) else { return false };
    unplaced && a.iter().all(|(k, v)| k == "column" || k == "rank" || b.get(k) == Some(v))
        && b.iter().all(|(k, v)| k == "column" || k == "rank" || a.get(k) == Some(v))
}

fn calendar_context(before: &Value, after: &Value, rows: &[Row]) -> Result<Vec<Value>, String> {
    let mut calendars = Vec::new();
    for r in rows
        .iter()
        .filter(|r| matches!(r.kind.as_str(), "event" | "task"))
    {
        for row in r.pre.iter().chain(std::iter::once(&r.post)) {
            let id = &row["calendar_id"];
            let cal = row_at(before, "calendar", id)
                .or_else(|| row_at(after, "calendar", id))
                .ok_or("Calendar no longer exists")?;
            if cal["readonly"] == true {
                return Err("Calendar is read-only".into());
            }
            if !calendars.contains(&cal) {
                calendars.push(cal);
            }
        }
    }
    Ok(calendars)
}
pub fn level(settings: &Path) -> String {
    storage::read_json::<crate::schema::Settings>(settings)
        .ok()
        .and_then(|s| s.root_mcp_review)
        .filter(|s| matches!(s.as_str(), "all" | "destructive" | "off"))
        .unwrap_or_else(|| "all".into())
}

pub fn call(
    stores: &Stores,
    tab: &str,
    name: &str,
    args: &Value,
) -> Result<(Value, Effects), String> {
    stores.check()?;
    if !stores.access.allows(stores.caller, name) { return Err("unknown tool".into()); }
    // Before the lock: the sweeps touch no calendar row, and a git sweep can run
    // for its whole deadline — held across it, the lock would stall every
    // review decision and every tab teardown for that long.
    if security::tool(name).is_some_and(|t| t.family == "projects") {
        return root_mcp::call_tool(stores, name, args);
    }
    let _guard = lock();
    stores.check()?;
    // A reader's taint is its class; a local-model tab's is latched by its
    // first mail read. Either way every write stages, additive ones included,
    // and `off` cannot lower that.
    let reader = stores.caller == root_mcp::Caller::Reader
        || stores.session.is_some_and(|s| s.has_read_mail());
    let scoped = !stores.access.calendars.all || !stores.access.projects.all;
    let level = if reader || scoped { "all".to_string() } else { stores.policy.review.clone() };
    if level == "off" && name != "proposals_list" {
        return root_mcp::call_tool(stores, name, args);
    }
    let mut proposals = load(stores.state)?;
    if security::tool(name).is_some_and(|t| t.write) {
        let pending = proposals.iter().filter(|p| p.status == "pending").count();
        let own = proposals.iter().filter(|p| p.status == "pending" && p.tab == tab).count();
        if pending >= security::MAX_PENDING || own >= security::MAX_PENDING_PER_TAB {
            return Err("MCP pending proposal limit reached; review existing proposals".into());
        }
    }
    // Rebuild on a changed real file or proposal sequence. Its one edit to the
    // log is a status; an untouched log is not rewritten on every read.
    let statuses = |ps: &[Proposal]| ps.iter().map(|p| p.status.clone()).collect::<Vec<_>>();
    let loaded = statuses(&proposals);
    let path = if level != "off" {
        Some(rebuild(stores, tab, &mut proposals)?)
    } else {
        None
    };
    let dropped: Vec<String> = proposals
        .iter()
        .filter(|p| p.tab == tab && p.status == "conflicted" && !p.notified)
        .map(|p| p.id.clone())
        .collect();
    if statuses(&proposals) != loaded {
        save(stores.state, &proposals)?;
    }
    if name == "proposals_list" {
        let own: Vec<Value> = proposals
            .iter()
            .filter(|p| p.tab == tab)
            .map(|p| json!({"id": p.id, "tool": p.tool, "status": p.status}))
            .collect();
        if !dropped.is_empty() {
            for p in &mut proposals {
                if dropped.contains(&p.id) {
                    p.notified = true;
                }
            }
            save(stores.state, &proposals)?;
        }
        return Ok((
            json!({"proposals": own, "dropped_proposals": dropped}),
            Effects::default(),
        ));
    }
    let view = Stores {
        calendar: path.as_deref().unwrap_or(stores.calendar),
        projects: stores.projects,
        settings: stores.settings,
        state: stores.state,
        caller: stores.caller,
        mail: stores.mail,
        reader_refusal: stores.reader_refusal,
        policy: stores.policy.clone(), access: stores.access.clone(), session: stores.session, deadline: stores.deadline,
    };
    let before = data_at(view.calendar)?;
    stores.check()?;
    let (mut value, mut effects) = root_mcp::call_tool(&view, name, args)?;
    if level != "off" {
        let after = data_at(view.calendar)?;
        let rows = capture(&before, &after, &effects.changes)?;
        if !rows.is_empty() {
            if rows.len() > security::MAX_ROWS {
                return Err(format!("Change touches {} rows, more than the {} one proposal may hold; split it", rows.len(), security::MAX_ROWS));
            }
            if rows.iter().any(|r|
                !stores.access.row(&r.kind, &r.post) || r.pre.as_ref().is_some_and(|pre| !stores.access.row(&r.kind, pre))) {
                return Err("Change touches rows outside this session's access grant".into());
            }
            stores.check()?;
            let calendars = calendar_context(&before, &after, &rows)?;
            let automatic = level == "destructive"
                && security::tool(name).is_some_and(|t| t.write && !t.destructive);
            let mut p = Proposal {
                id: root_mcp::mint_token().ok_or("No OS entropy")?,
                tab: tab.into(),
                tool: name.into(),
                args: args.clone(),
                created: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .to_string(),
                rows,
                calendars,
                tainted: reader,
                status: "pending".into(),
                undo: automatic,
                notified: false,
                extra: serde_json::from_value(json!({
                    "mcp_access": stores.access, "mcp_caller": stores.caller,
                    "mcp_session": stores.session.map(|s| &s.id),
                })).unwrap(),
            };
            effects.changes.clear();
            if automatic {
                // Applied first, logged once: a log that says `pending` for a
                // change that landed is the one state `list` cannot tell from
                // a real pending row without this ordering (and it re-checks
                // an `undo` row against the store for the crash in between).
                match calendar::apply_change_at(stores.calendar, &p.rows, &p.calendars) {
                    Ok(changes) => {
                        effects.changes = changes;
                        p.status = "applied".into();
                    }
                    Err(e) if e == CONFLICT => p.status = "conflicted".into(),
                    Err(e) => {
                        p.status = "failed".into();
                        p.extra.insert("error".into(), json!(e));
                    }
                }
            }
            proposals.push(p.clone());
            save(stores.state, &proposals)?;
            if p.status == "conflicted" {
                return Err(CONFLICT.into());
            }
            if p.status == "failed" {
                return Err(FAILED.into());
            }
            if !value.is_object() {
                value = json!({"result": value});
            }
            value["staged"] = json!(p.status == "pending");
            value["proposal"] = json!(p.id);
            value["proposal_status"] = json!(p.status);
        }
    }
    if !dropped.is_empty() {
        if !value.is_object() {
            value = json!({"result": value});
        }
        value["dropped_proposals"] = json!(dropped);
        for p in &mut proposals {
            if dropped.contains(&p.id) {
                p.notified = true;
            }
        }
        save(stores.state, &proposals)?;
    }
    Ok((value, effects))
}

fn check_proposal_access(p: &Proposal) -> Result<(), String> {
    let Some(value) = p.extra.get("mcp_access") else { return Ok(()) }; // pre-policy proposals
    let original = Access::from_stored(value).map_err(|_| "Invalid proposal grant")?;
    let caller: root_mcp::Caller = serde_json::from_value(p.extra.get("mcp_caller").cloned().unwrap_or(Value::Null))
        .map_err(|_| "Invalid proposal caller")?;
    let current = root_mcp::sessions().into_iter().find(|s| Some(s.id.as_str()) == p.extra.get("mcp_session").and_then(Value::as_str));
    for access in std::iter::once(&original).chain(current.as_ref().map(|s| &s.access)) {
        if !access.allows(caller, &p.tool) || p.rows.iter().any(|r|
            !access.row(&r.kind, &r.post) || r.pre.as_ref().is_some_and(|pre| !access.row(&r.kind, pre))) {
            return Err("Proposal is outside its session's access grant".into());
        }
    }
    Ok(())
}

pub fn decide(stores: &Stores, id: &str, seen: &str, action: &str) -> Result<Vec<Change>, String> {
    let _guard = lock();
    decide_locked(stores, id, seen, action)
}
fn decide_locked(
    stores: &Stores,
    id: &str,
    seen: &str,
    action: &str,
) -> Result<Vec<Change>, String> {
    let mut proposals = load(stores.state)?;
    let index = proposals
        .iter()
        .position(|p| p.id == id)
        .ok_or("Proposal no longer exists")?;
    let p = &mut proposals[index];
    if digest(p) != seen {
        return Err("Proposal changed; refresh the review".into());
    }
    let mut effects = Vec::new();
    match action {
        "reject" if matches!(p.status.as_str(), "pending" | "conflicted") => {
            p.status = "rejected".into()
        }
        "apply" if p.status == "pending" => {
            check_proposal_access(p)?;
            match calendar::apply_change_at(stores.calendar, &p.rows, &p.calendars) {
                Ok(changes) => {
                    effects = changes;
                    p.status = "applied".into();
                }
                Err(_) => p.status = "conflicted".into(),
            }
        }
        "undo" if p.status == "applied" && p.undo => {
            let rows: Vec<Row> = p
                .rows
                .iter()
                .rev()
                .map(|r| Row {
                    kind: r.kind.clone(),
                    op: if r.pre.is_none() { "delete" } else { "upsert" }.into(),
                    pre: if r.op == "delete" {
                        None
                    } else {
                        Some(r.post.clone())
                    },
                    post: r.pre.clone().unwrap_or_else(|| r.post.clone()),
                    local: r.local,
                })
                .collect();
            match calendar::apply_change_at(stores.calendar, &rows, &p.calendars) {
                Ok(changes) => {
                    effects = changes;
                    p.status = "undone".into();
                }
                Err(_) => p.status = "conflicted".into(),
            }
        }
        _ => return Err("Proposal cannot be decided in this state".into()),
    }
    let tab = p.tab.clone();
    save(stores.state, &proposals)?;
    // Closing a tab removes its sandbox; a later decision must not recreate it.
    if root_mcp::tab_active(&tab) {
        // Next tool call rebuilds using its own scope. Never write an
        // unrestricted review view into an agent's scoped sandbox.
        if let Some(dir) = sandbox(stores.state, &tab).parent() { let _ = std::fs::remove_dir_all(dir); }
    } else {
        // Replay in memory to invalidate dependent rows without a directory.
        let mut data = data_at(stores.calendar)?;
        for p in proposals
            .iter_mut()
            .filter(|p| p.tab == tab && p.status == "pending")
        {
            let mut next = data.clone();
            if apply_rows(&mut next, &p.rows, &p.calendars).is_ok() {
                data = next;
            } else {
                p.status = "conflicted".into();
            }
        }
    }
    save(stores.state, &proposals)?;
    Ok(effects)
}

#[derive(Deserialize)]
pub struct Approval {
    pub id: String,
    pub digest: String,
}
pub fn apply_all(stores: &Stores, approvals: &[Approval]) -> Result<Vec<Change>, String> {
    let _guard = lock();
    let proposals = load(stores.state)?;
    // Validate the entire displayed set before applying anything. Never pick
    // up proposals created after the user rendered the review.
    for a in approvals {
        let p = proposals
            .iter()
            .find(|p| p.id == a.id)
            .ok_or("Proposal no longer exists")?;
        check_proposal_access(p)?;
        if p.status != "pending" || digest(p) != a.digest {
            return Err("Proposal changed; refresh the review".into());
        }
    }
    let mut changes = Vec::new();
    for p in proposals
        .iter()
        .filter(|p| approvals.iter().any(|a| a.id == p.id))
    {
        // Earlier approval may have conflicted a dependent proposal.
        if load(stores.state)?
            .iter()
            .any(|v| v.id == p.id && v.status == "pending")
        {
            changes.extend(decide_locked(stores, &p.id, &digest(p), "apply")?);
        }
    }
    Ok(changes)
}

/// Remove every per-tab copy whose tab holds no token: at startup (nothing is
/// live yet, so every copy a crash left goes) and on a clean quit. Copies are
/// rebuilt from the log on the next call, so nothing is lost with them.
pub fn sweep_sandboxes(state: &Path) {
    let _guard = lock();
    let Ok(entries) = std::fs::read_dir(state.join("root_mcp/sandboxes")) else { return };
    let live: std::collections::HashSet<String> =
        root_mcp::sessions().into_iter().map(|s| hash(s.tab.as_bytes())).collect();
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(|name| live.contains(name)) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

pub fn cleanup_tab(state: &Path, tab: &str) {
    let _guard = lock();
    // A replacement spawn can already own this tab; never remove its view.
    if !root_mcp::tab_active(tab) {
        if let Some(dir) = sandbox(state, tab).parent() { let _ = std::fs::remove_dir_all(dir); }
    }
}
pub fn on_tab_gone(state: &Path, tab: &str) {
    // Every tab teardown lands here, MCP or not, and some callers are async
    // commands: a tab that held no token and left no view has no lock to wait for.
    let held = root_mcp::revoke_tab(tab);
    if held || sandbox(state, tab).parent().is_some_and(Path::exists) {
        cleanup_tab(state, tab);
    }
}

/// Invalidate the generation before waiting for queued review operations.
pub fn on_spawn_gone(state: &Path, token: &str) {
    if let Some(identity) = root_mcp::revoke_token(token) { cleanup_tab(state, &identity.tab); }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A store minus the revisions the write path stamps (#171), top level
    /// and per row — the content a proposal describes.
    fn strip_revs(mut data: Value) -> Value {
        if let Some(obj) = data.as_object_mut() {
            obj.remove("rev");
        }
        for key in ["calendars", "events", "tasks"] {
            if let Some(rows) = data[key].as_array_mut() {
                for row in rows {
                    if let Some(obj) = row.as_object_mut() {
                        obj.remove("rev");
                    }
                }
            }
        }
        data
    }
    struct Fixture {
        dir: tempfile::TempDir,
        calendar: PathBuf,
        projects: PathBuf,
        settings: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let calendar = dir.path().join("calendar.json");
            storage::write_json_atomic(
                &calendar,
                &crate::schema::calendar::CalendarData::default(),
            )
            .unwrap();
            std::fs::write(dir.path().join("settings.json"), "{}").unwrap();
            Self {
                projects: dir.path().join("projects.json"),
                settings: dir.path().join("settings.json"),
                calendar,
                dir,
            }
        }
        fn stores(&self) -> Stores<'_> {
            Stores {
                calendar: &self.calendar,
                projects: &self.projects,
                settings: &self.settings,
                state: self.dir.path(),
                caller: root_mcp::Caller::Agent,
                mail: None,
                reader_refusal: None,
                policy: security::Policy::load(&self.settings).unwrap(),
                access: Access::initial(root_mcp::Caller::Agent), session: None, deadline: None,
            }
        }
        fn call(&self, tab: &str, name: &str, args: Value) -> Value {
            call(&self.stores(), tab, name, &args).unwrap().0
        }
        fn proposals(&self) -> Vec<Proposal> {
            load(self.dir.path()).unwrap()
        }
        fn approve(&self, p: &Proposal) -> Vec<Change> {
            decide(&self.stores(), &p.id, &digest(p), "apply").unwrap()
        }
        fn mode(&self, mode: &str) {
            storage::write_json_atomic(&self.settings, &json!({"root_mcp_review": mode})).unwrap();
        }
        /// The store's content: what a proposal describes, minus the
        /// revisions the write path stamps (#171) — an undo is a further
        /// write, so the file is never byte-identical to before it.
        fn content(&self) -> Value {
            strip_revs(data_at(&self.calendar).unwrap())
        }
        fn write_real(&self, data: Value) {
            storage::write_json_atomic(&self.calendar, &data).unwrap();
        }
    }
    #[test]
    fn scoped_views_hide_rows_and_direct_ids_and_bind_approval() {
        let f = Fixture::new();
        f.mode("off");
        let secret = f.call("setup", "calendar_create", json!({"name":"Secret"}));
        let hidden = f.call("setup", "calendar_add_event", json!({"title":"SECRET", "calendar":secret["id"], "start":"2026-09-20T10:00"}));
        let visible = f.call("setup", "calendar_add_event", json!({"title":"Visible", "start":"2026-09-20T10:00"}));
        f.mode("all");
        let (_, session) = root_mcp::test_session(root_mcp::Caller::Agent);
        let mut access = session.access.clone();
        access.calendars = security::Scope { all:false, ids:vec![visible["calendar_id"].as_str().unwrap().into()] };
        root_mcp::set_access(&session.id, access.clone()).unwrap();
        // A fresh authentication sees the new grant; fixture session is used
        // only for ownership below and has been invalidated by the change.
        let mut stores = f.stores(); stores.access = access;
        let view = call(&stores, "scoped", "calendar_list", &json!({})).unwrap().0;
        assert!(!view.to_string().contains("SECRET"));
        let copy = std::fs::read_to_string(sandbox(f.dir.path(), "scoped")).unwrap();
        assert!(!copy.contains("SECRET"));
        assert!(call(&stores, "scoped", "calendar_delete_event", &json!({"id":hidden["id"]})).is_err());
        call(&stores, "scoped", "calendar_update_event", &json!({"id":visible["id"],"title":"Updated"})).unwrap();
        let mut p = f.proposals().pop().unwrap();
        p.extra.insert("mcp_session".into(), json!(session.id));
        save(f.dir.path(), &[p.clone()]).unwrap();
        let mut narrowed = stores.access.clone(); narrowed.write = false;
        root_mcp::set_access(&session.id, narrowed).unwrap();
        assert!(decide(&f.stores(), &p.id, &digest(&p), "apply").is_err());
        assert!(data_at(&f.calendar).unwrap().to_string().contains("SECRET"));
        root_mcp::revoke_tab(&session.identity.tab);
    }

    #[test]
    fn request_waiting_on_review_lock_observes_revocation() {
        let f = Fixture::new();
        let (_, session) = root_mcp::test_session(root_mcp::Caller::Agent);
        std::thread::scope(|scope| {
            let guard = lock();
            let worker = scope.spawn(|| {
                let stores = Stores { session: Some(&session), ..f.stores() };
                call(&stores, &session.identity.tab, "todo_add", &json!({"title":"Never applied"})).is_err()
            });
            root_mcp::revoke_tab(&session.identity.tab);
            drop(guard);
            assert!(worker.join().unwrap());
        });
        assert!(f.proposals().is_empty());
    }

    #[test]
    fn quota_and_revocation_do_not_mutate_live_data() {
        let f = Fixture::new();
        f.call("quota", "todo_add", json!({"title":"seed"}));
        let p = f.proposals().pop().unwrap();
        let rows: Vec<_> = (0..security::MAX_PENDING_PER_TAB).map(|i| { let mut p = p.clone(); p.id = i.to_string(); p }).collect();
        save(f.dir.path(), &rows).unwrap();
        let before = std::fs::read(&f.calendar).unwrap();
        assert!(call(&f.stores(), "quota", "todo_add", &json!({"title":"overflow"})).is_err());
        let (_, session) = root_mcp::test_session(root_mcp::Caller::Agent);
        let stores = Stores { session: Some(&session), ..f.stores() };
        root_mcp::revoke_tab(&session.identity.tab);
        assert!(call(&stores, &session.identity.tab, "todo_add", &json!({"title":"revoked"})).is_err());
        assert_eq!(std::fs::read(&f.calendar).unwrap(), before);
    }

    #[test]
    fn isolated_read_your_writes_and_tab_scoped_status() {
        let f = Fixture::new();
        let original = std::fs::read(&f.calendar).unwrap();
        let a = f.call("root:a", "todo_add", json!({"title":"A"}));
        assert_eq!(a["staged"], true);
        f.call(
            "root:a",
            "todo_move",
            json!({"id":a["id"], "column":"doing"}),
        );
        assert_eq!(f.proposals().len(), 2);
        assert_eq!(std::fs::read(&f.calendar).unwrap(), original);
        let b = f.call("root:b", "todo_list", json!({}));
        assert!(b["cards"].as_array().unwrap().is_empty());
        assert_eq!(
            f.call("root:b", "proposals_list", json!({}))["proposals"],
            json!([])
        );
        assert_eq!(
            f.call("root:a", "todo_list", json!({}))["cards"][0]["column"],
            "doing"
        );
        let expected = strip_revs(data_at(&sandbox(f.dir.path(), "root:a")).unwrap());
        for p in f.proposals() {
            f.approve(&p);
        }
        assert_eq!(f.content(), expected);
    }
    #[test]
    fn every_write_applies_exactly_the_tool_result_including_board_side_effects() {
        for mode in ["all", "destructive"] {
            let f = Fixture::new();
            f.mode(mode);
            let mut covered = std::collections::HashSet::new();
            let mut run = |name: &str, args: Value| {
                let before = std::fs::read(&f.calendar).unwrap();
                let before_content = f.content();
                let v = f.call("root:a", name, args);
                covered.insert(name.to_string());
                let automatic = mode == "destructive"
                    && security::tool(name).is_some_and(|t| t.write && !t.destructive);
                assert_eq!(v["staged"], !automatic, "{mode}: {name}");
                if !automatic {
                    assert_eq!(
                        std::fs::read(&f.calendar).unwrap(),
                        before,
                        "{name} escaped the sandbox"
                    );
                }
                let expected = strip_revs(data_at(&sandbox(f.dir.path(), "root:a")).unwrap());
                let p = f.proposals().last().unwrap().clone();
                assert_eq!(p.tool, name);
                if automatic {
                    assert_eq!(p.status, "applied");
                    assert!(p.undo);
                    decide(&f.stores(), &p.id, &digest(&p), "undo").unwrap();
                    assert_eq!(f.content(), before_content, "undo {name}");
                    // Reapply these same reviewed rows so subsequent operations use
                    // precisely the minted identities, without rerunning the tool.
                    calendar::apply_change_at(&f.calendar, &p.rows, &p.calendars).unwrap();
                } else {
                    f.approve(&p);
                }
                assert_eq!(
                    f.proposals().last().unwrap().status,
                    if automatic { "undone" } else { "applied" },
                    "{name}"
                );
                assert_eq!(f.content(), expected, "{name}");
                v
            };
            let cal = run("calendar_create", json!({"name":"Work"}));
            let event = run(
                "calendar_add_event",
                json!({"title":"Meet", "start":"2026-09-20T10:00"}),
            );
            run(
                "calendar_update_event",
                json!({"id":event["id"], "start":"2026-09-20T11:00"}),
            );
            run(
                "calendar_move_events",
                json!({"ids":[event["id"]], "to":cal["id"]}),
            );
            run("calendar_delete_event", json!({"id":event["id"]}));
            let card = run("todo_add", json!({"title":"Ship"}));
            run("todo_move", json!({"id":card["id"], "column":"doing"}));
            run("todo_update", json!({"id":card["id"], "title":"Ship soon"}));
            run(
                "todo_complete",
                json!({"id":card["id"], "completed":"2026-09-20T12:00"}),
            );
            run("todo_reopen", json!({"id":card["id"]}));
            run("todo_delete", json!({"id":card["id"]}));
            let writes: std::collections::HashSet<String> = root_mcp::tool_names()
                .into_iter()
                .filter(|n| root_mcp::tool_annotations(n)["readOnlyHint"] == false)
                // A mail draft touches no calendar row and never stages: the
                // draft is the proposal (`root_mcp_mail`).
                .filter(|n| !crate::services::root_mcp_mail::is_mail_tool(n))
                // Nor does a staged `.ics`: the window's importer writes it.
                .filter(|n| *n != crate::services::root_mcp_import::TOOL)
                .map(str::to_string)
                .collect();
            assert_eq!(covered, writes);
        }
    }
    #[test]
    fn rejection_conflicts_dependents_and_reports_them_on_next_call() {
        let f = Fixture::new();
        let add = f.call("root:a", "todo_add", json!({"title":"A"}));
        f.call(
            "root:a",
            "todo_move",
            json!({"id":add["id"], "column":"doing"}),
        );
        let proposals = f.proposals();
        decide(
            &f.stores(),
            &proposals[0].id,
            &digest(&proposals[0]),
            "reject",
        )
        .unwrap();
        assert_eq!(f.proposals()[1].status, "conflicted");
        let result = f.call("root:a", "todo_list", json!({}));
        assert_eq!(result["dropped_proposals"], json!([proposals[1].id]));
        assert!(result["cards"].as_array().unwrap().is_empty());
    }
    #[test]
    fn stale_digest_and_changed_create_update_delete_never_overwrite() {
        let f = Fixture::new();
        let a = f.call("root:a", "todo_add", json!({"title":"A"}));
        let p = f.proposals()[0].clone();
        assert!(decide(&f.stores(), &p.id, "old-digest", "apply").is_err());
        let mut data = data_at(&f.calendar).unwrap();
        data["tasks"] = json!([p.rows[0].post]);
        f.write_real(data);
        let original = std::fs::read(&f.calendar).unwrap();
        f.approve(&p);
        assert_eq!(f.proposals()[0].status, "conflicted");
        assert_eq!(std::fs::read(&f.calendar).unwrap(), original);
        f.call(
            "root:a",
            "todo_update",
            json!({"id":a["id"], "title":"Agent"}),
        );
        let p = f.proposals().last().unwrap().clone();
        let mut data = data_at(&f.calendar).unwrap();
        data["tasks"][0]["title"] = json!("Human");
        f.write_real(data);
        let original = std::fs::read(&f.calendar).unwrap();
        f.approve(&p);
        assert_eq!(std::fs::read(&f.calendar).unwrap(), original);
        assert_eq!(f.proposals().last().unwrap().status, "conflicted");
        f.call("root:a", "todo_delete", json!({"id":a["id"]}));
        let p = f.proposals().last().unwrap().clone();
        crate::commands::calendar::delete_task_at(&f.calendar, a["id"].as_str().unwrap()).unwrap();
        let original = std::fs::read(&f.calendar).unwrap();
        f.approve(&p);
        assert_eq!(std::fs::read(&f.calendar).unwrap(), original);
        assert_eq!(f.proposals().last().unwrap().status, "conflicted");
    }
    #[test]
    fn fresh_caldav_identity_is_ignored_for_compare_but_preserved_on_write() {
        assert_eq!(SYNC_FIELDS, &["caldav_etag", "caldav_href"]);
        let f = Fixture::new();
        f.mode("off");
        let a = f.call("root:a", "todo_add", json!({"title":"A"}));
        f.mode("all");
        f.call(
            "root:a",
            "todo_update",
            json!({"id":a["id"], "title":"New"}),
        );
        let p = f.proposals()[0].clone();
        calendar::set_caldav_identity_at(
            &f.calendar,
            "task",
            a["id"].as_str().unwrap(),
            "/new.ics",
            "new-etag",
        )
        .unwrap();
        let effects = f.approve(&p);
        assert_eq!(f.proposals()[0].status, "applied");
        assert_eq!(effects[0].row["caldav_etag"], "new-etag");
        let real = data_at(&f.calendar).unwrap();
        assert_eq!(real["tasks"][0]["caldav_href"], "/new.ics");
        assert_eq!(real["tasks"][0]["title"], "New");
    }
    #[test]
    fn a_stale_row_makes_an_entire_move_batch_atomic() {
        let f = Fixture::new();
        f.mode("off");
        let cal = f.call("root:a", "calendar_create", json!({"name":"Work"}));
        let a = f.call(
            "root:a",
            "calendar_add_event",
            json!({"title":"A", "start":"2026-09-20T10:00"}),
        );
        let b = f.call(
            "root:a",
            "calendar_add_event",
            json!({"title":"B", "start":"2026-09-20T11:00"}),
        );
        f.mode("all");
        f.call(
            "root:a",
            "calendar_move_events",
            json!({"ids":[a["id"],b["id"]], "to":cal["id"]}),
        );
        let p = f.proposals()[0].clone();
        let mut data = data_at(&f.calendar).unwrap();
        data["events"][1]["title"] = json!("Human");
        f.write_real(data);
        let original = std::fs::read(&f.calendar).unwrap();
        f.approve(&p);
        assert_eq!(std::fs::read(&f.calendar).unwrap(), original);
        assert_eq!(f.proposals()[0].status, "conflicted");
    }
    #[test]
    fn destructive_level_matches_annotations_and_undo_is_conditional() {
        let f = Fixture::new();
        f.mode("destructive");
        let before = f.content();
        f.call("root:a", "todo_add", json!({"title":"A"}));
        let p = f.proposals()[0].clone();
        assert_eq!(p.status, "applied");
        assert!(p.undo);
        decide(&f.stores(), &p.id, &digest(&p), "undo").unwrap();
        assert_eq!(f.content(), before);
        let a = f.call("root:a", "todo_add", json!({"title":"B"}));
        let p = f.proposals().last().unwrap().clone();
        let mut data = data_at(&f.calendar).unwrap();
        data["tasks"][0]["title"] = json!("Human");
        f.write_real(data);
        let before = std::fs::read(&f.calendar).unwrap();
        decide(&f.stores(), &p.id, &digest(&p), "undo").unwrap();
        assert_eq!(f.proposals().last().unwrap().status, "conflicted");
        assert_eq!(std::fs::read(&f.calendar).unwrap(), before);
        f.call("root:a", "todo_delete", json!({"id":a["id"]}));
        assert_eq!(f.proposals().last().unwrap().status, "pending");
    }
    #[test]
    fn log_roundtrips_unknown_status_and_caps_only_decided_entries() {
        let f = Fixture::new();
        f.call("root:a", "todo_add", json!({"title":"A"}));
        let mut proposals = f.proposals();
        let mut future = proposals[0].clone();
        future.status = "future-status".into();
        future
            .extra
            .insert("future-key".into(), json!({"keep":true}));
        proposals.push(future);
        for _ in 0..205 {
            let mut p = proposals[0].clone();
            p.status = "rejected".into();
            proposals.push(p);
        }
        save(f.dir.path(), &proposals).unwrap();
        let loaded = f.proposals();
        assert_eq!(loaded.len(), 202);
        assert_eq!(loaded[0].status, "pending");
        assert_eq!(loaded[1].status, "future-status");
        assert_eq!(loaded[1].extra["future-key"], json!({"keep":true}));
    }
    #[test]
    fn rebuild_detects_live_edits_and_failed_calls_do_not_consume_the_notice() {
        let f = Fixture::new();
        f.mode("off");
        let a = f.call("root:a", "todo_add", json!({"title":"A"}));
        f.mode("all");
        f.call(
            "root:a",
            "todo_update",
            json!({"id":a["id"], "title":"Agent"}),
        );
        let p = f.proposals()[0].clone();
        let mut real = data_at(&f.calendar).unwrap();
        real["tasks"][0]["title"] = json!("Human");
        f.write_real(real);
        assert!(call(
            &f.stores(),
            "root:a",
            "todo_update",
            &json!({"id":"missing"})
        )
        .is_err());
        let result = f.call("root:a", "todo_list", json!({}));
        assert_eq!(result["cards"][0]["title"], "Human");
        assert_eq!(result["dropped_proposals"], json!([p.id]));
        assert_eq!(f.proposals()[0].status, "conflicted");
        f.mode("future-unknown-level");
        assert_eq!(
            f.call("root:a", "todo_add", json!({"title":"Conservative"}))["staged"],
            true
        );
    }

    #[test]
    fn a_caldav_relocation_keeps_its_outbound_delete_then_create() {
        let f = Fixture::new();
        f.mode("off");
        let target = f.call("root:a", "calendar_create", json!({"name":"Target"}));
        let a = f.call(
            "root:a",
            "calendar_add_event",
            json!({"title":"A", "start":"2026-09-20T10:00"}),
        );
        calendar::set_caldav_identity_at(
            &f.calendar,
            "event",
            a["id"].as_str().unwrap(),
            "/original.ics",
            "etag",
        )
        .unwrap();
        // A resource address on the source row is enough to exercise the same
        // server-copy deletion the real CalDAV-backed tool emits.
        f.mode("all");
        f.call(
            "root:a",
            "calendar_move_events",
            json!({"ids":[a["id"]], "to":target["id"]}),
        );
        let p = f.proposals()[0].clone();
        let effects = f.approve(&p);
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[0].op, "delete");
        assert_eq!(effects[0].row["caldav_href"], "/original.ics");
        assert_eq!(effects[1].op, "upsert");
        assert!(effects[1].row.get("caldav_href").is_none());
        assert_eq!(
            data_at(&f.calendar).unwrap()["events"][0]["calendar_id"],
            target["id"]
        );
    }

    /// A reader's taint is its class: with review `off`, its additive write
    /// still stages, carries the mark, and leaves the real store untouched.
    #[test]
    fn a_readers_writes_always_stage_and_carry_the_mark() {
        let f = Fixture::new();
        storage::write_json_atomic(&f.settings, &json!({"root_mcp_review":"off"})).unwrap();
        let before = std::fs::read(&f.calendar).unwrap();
        let stores = Stores { caller: root_mcp::Caller::Reader, ..f.stores() };
        let (value, effects) = call(&stores, "vm:reader", "todo_add", &json!({"title":"From a mail"})).unwrap();
        assert_eq!(value["staged"], true);
        assert!(effects.changes.is_empty());
        assert_eq!(std::fs::read(&f.calendar).unwrap(), before, "the real store is byte-identical");
        let p = f.proposals();
        assert!(p[0].tainted && p[0].status == "pending");
        // The same call from a root tab, same setting, writes straight through.
        let (value, _) = call(&f.stores(), "root:a", "todo_add", &json!({"title":"Mine"})).unwrap();
        assert!(value.get("staged").is_none());
        assert!(!f.proposals().iter().any(|p| p.tab == "root:a"));
    }

    /// A local-model tab is tainted from its first mail read, not from spawn:
    /// with review `off` it writes straight through until it reads, and every
    /// write after stages with the mark.
    #[test]
    fn a_local_model_that_read_mail_stages_its_writes() {
        let f = Fixture::new();
        storage::write_json_atomic(&f.settings, &json!({"root_mcp_review":"off"})).unwrap();
        let (_, session) = root_mcp::test_session(root_mcp::Caller::LocalModel);
        let stores = Stores { caller: root_mcp::Caller::LocalModel, session: Some(&session), ..f.stores() };
        let (value, _) = call(&stores, &session.identity.tab, "todo_add", &json!({"title":"Before"})).unwrap();
        assert!(value.get("staged").is_none());
        session.mark_read_mail();
        let before = std::fs::read(&f.calendar).unwrap();
        let (value, effects) = call(&stores, &session.identity.tab, "todo_add", &json!({"title":"From a mail"})).unwrap();
        assert_eq!(value["staged"], true);
        assert!(effects.changes.is_empty());
        assert_eq!(std::fs::read(&f.calendar).unwrap(), before);
        let p = f.proposals();
        assert!(p.iter().any(|p| p.tab == session.identity.tab && p.tainted && p.status == "pending"));
        root_mcp::revoke_tab(&session.identity.tab);
    }

    /// The taint is the tab's, not the spawn's: a tab that read mail in one
    /// spawn starts its next spawn tainted, and its writes stage under `off`.
    #[test]
    fn a_tab_that_read_mail_stays_tainted_across_a_respawn() {
        let f = Fixture::new();
        f.mode("off");
        let tab = "root:resumed-local";
        let (_, first) = root_mcp::test_session_for_tab(root_mcp::Caller::LocalModel, tab, f.dir.path());
        assert!(!first.has_read_mail());
        let stores = Stores { caller: root_mcp::Caller::LocalModel, session: Some(&first), ..f.stores() };
        assert!(call(&stores, tab, "todo_add", &json!({"title":"Plain"})).unwrap().0.get("staged").is_none());
        // What the first mail read does: latch in memory and on disk.
        first.mark_read_mail();
        root_mcp::record_read_mail(f.dir.path(), tab);
        // A respawn of the same tab (a `--resume`): a fresh token, the old taint.
        let (_, second) = root_mcp::test_session_for_tab(root_mcp::Caller::LocalModel, tab, f.dir.path());
        assert!(first.check().is_err(), "the old spawn's token is gone");
        assert!(second.has_read_mail(), "seeded from the marker");
        let stores = Stores { caller: root_mcp::Caller::LocalModel, session: Some(&second), ..f.stores() };
        let (value, effects) = call(&stores, tab, "todo_add", &json!({"title":"From a mail"})).unwrap();
        assert_eq!(value["staged"], true);
        assert!(effects.changes.is_empty());
        let p = f.proposals();
        assert!(p.iter().any(|p| p.tab == tab && p.tainted && p.status == "pending"));
        // Another tab is untouched by it.
        let (_, other) = root_mcp::test_session_for_tab(root_mcp::Caller::LocalModel, "root:other", f.dir.path());
        assert!(!other.has_read_mail());
        root_mcp::revoke_tab(tab);
        root_mcp::revoke_tab("root:other");
    }

    /// The first move on a board that has never been dragged on seeds the
    /// columns, which files every unplaced card somewhere. That filing is the
    /// store's own derivation, not the agent's write: the proposal carries the
    /// moved card and the board row, whatever the board's size.
    #[test]
    fn a_first_move_on_a_big_unplaced_board_proposes_only_the_card_and_the_board() {
        let f = Fixture::new();
        f.mode("off");
        let mut first = None;
        for n in 0..(security::MAX_ROWS + 1) {
            let card = f.call("setup", "todo_add", json!({"title": format!("card {n}")}));
            first.get_or_insert(card["id"].as_str().unwrap().to_string());
        }
        let real = data_at(&f.calendar).unwrap();
        assert!(real["task_columns"].as_array().is_none_or(Vec::is_empty), "no board yet");
        assert_eq!(real["tasks"].as_array().unwrap().len(), security::MAX_ROWS + 1);
        f.mode("all");
        let id = first.unwrap();
        let (value, effects) = call(&f.stores(), "root:a", "todo_move", &json!({"id": id, "column": "doing"})).unwrap();
        assert_eq!(value["staged"], true, "{value}");
        assert!(effects.changes.is_empty());
        let p = f.proposals().pop().unwrap();
        let kinds: Vec<(&str, &str)> = p.rows.iter().map(|r| (r.kind.as_str(), r.post["id"].as_str().unwrap_or(""))).collect();
        assert_eq!(kinds, [("task", id.as_str()), ("board", "board")], "{kinds:?}");
        assert_eq!(p.rows[0].post["column"], "doing");
        f.approve(&p);
        assert_eq!(f.proposals().pop().unwrap().status, "applied");
        let real = data_at(&f.calendar).unwrap();
        assert!(!real["task_columns"].as_array().unwrap().is_empty());
        let moved = real["tasks"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap();
        assert_eq!(moved["column"], "doing");
        // A refusal for size names the size, one for scope names the scope.
        let mut scoped = f.stores();
        scoped.access.calendars = security::Scope { all: false, ids: vec!["nope".into()] };
        let err = call(&scoped, "root:b", "todo_add", &json!({"title":"x"})).unwrap_err();
        assert!(err.contains("access grant") && !err.contains("batch"), "{err}");
    }

    /// Under `destructive`, an additive write applies on its own — and when
    /// the store cannot be written for a reason that is not a stale row, the
    /// proposal is `failed`, with the error, never `conflicted`: the card must
    /// not tell the user the entry changed when it did not.
    #[cfg(unix)]
    #[test]
    fn an_automatic_write_that_cannot_be_stored_is_failed_not_conflicted() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        f.mode("destructive");
        // A first automatic write, so the log's directory exists and stays writable.
        let (value, _) = call(&f.stores(), "root:a", "todo_add", &json!({"title":"Lands"})).unwrap();
        assert_eq!((value["staged"].as_bool(), value["proposal_status"].as_str()), (Some(false), Some("applied")));
        let dir = f.dir.path();
        let writable = std::fs::metadata(dir).unwrap().permissions();
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let attempt = call(&f.stores(), "root:a", "todo_add", &json!({"title":"Cannot land"}));
        std::fs::set_permissions(dir, writable).unwrap();
        let Err(error) = attempt else { panic!("a read-only store must not apply") };
        assert_eq!(error, FAILED);
        assert_ne!(error, CONFLICT);
        let p = f.proposals().pop().unwrap();
        assert_eq!(p.status, "failed");
        assert!(p.extra.get("error").and_then(Value::as_str).is_some_and(|e| !e.is_empty()));
        assert!(!data_at(&f.calendar).unwrap().to_string().contains("Cannot land"));
        // Decided, so it counts against no quota and Approve is not offered.
        assert!(decide(&f.stores(), &p.id, &digest(&p), "apply").is_err());
    }

    /// An automatic write whose rows are already in the store is one whose
    /// `applied` never reached the log (a crash between the two): `list`
    /// reads it as applied rather than conflicting it against itself.
    #[test]
    fn a_landed_automatic_write_reads_as_applied() {
        let f = Fixture::new();
        f.mode("destructive");
        call(&f.stores(), "root:a", "todo_add", &json!({"title":"Landed"})).unwrap();
        let mut p = f.proposals().pop().unwrap();
        assert_eq!((p.status.as_str(), p.undo), ("applied", true));
        p.status = "pending".into();
        save(f.dir.path(), &[p.clone()]).unwrap();
        let listed = list(&f.stores()).unwrap();
        assert_eq!(listed[0].proposal.status, "applied");
        assert_eq!(f.proposals()[0].status, "applied", "and the log says so now");
        // A stored grant with a field this build never heard of still approves.
        let (value, _) = call(&f.stores(), "root:b", "todo_delete", &json!({"id": p.rows[0].post["id"]})).unwrap();
        assert_eq!(value["staged"], true);
        let mut q = f.proposals().pop().unwrap();
        q.extra.get_mut("mcp_access").unwrap()["future_field"] = json!(1);
        let mut all = f.proposals(); all.pop(); all.push(q.clone());
        save(f.dir.path(), &all).unwrap();
        f.approve(&f.proposals().pop().unwrap());
        assert_eq!(f.proposals().pop().unwrap().status, "applied");
    }

    #[test]
    fn no_approval_tool_and_closed_tab_proposals_survive() {
        for name in root_mcp::tool_names() {
            for forbidden in ["approve", "apply", "review", "confirm"] {
                assert!(!name.contains(forbidden));
            }
        }
        let f = Fixture::new();
        f.call("root:a", "todo_add", json!({"title":"A"}));
        on_tab_gone(f.dir.path(), "root:a");
        assert!(!sandbox(f.dir.path(), "root:a").exists());
        let p = f.proposals()[0].clone();
        f.approve(&p);
        assert_eq!(f.proposals()[0].status, "applied");
        assert!(!sandbox(f.dir.path(), "root:a").exists());
    }
    #[test]
    fn readonly_calendars_and_changed_routes_are_refused() {
        let f = Fixture::new();
        f.mode("off");
        let a = f.call(
            "root:a",
            "calendar_add_event",
            json!({"title":"A", "start":"2026-09-20T10:00"}),
        );
        f.mode("all");
        f.call(
            "root:a",
            "calendar_update_event",
            json!({"id":a["id"], "title":"Agent"}),
        );
        let p = f.proposals()[0].clone();
        let mut data = data_at(&f.calendar).unwrap();
        data["calendars"][0]["readonly"] = json!(true);
        f.write_real(data);
        let original = std::fs::read(&f.calendar).unwrap();
        f.approve(&p);
        assert_eq!(f.proposals()[0].status, "conflicted");
        assert_eq!(std::fs::read(&f.calendar).unwrap(), original);
        assert!(call(&f.stores(), "root:a", "todo_add", &json!({"title":"No"})).is_err());
        assert_eq!(f.proposals().len(), 1);
    }
    #[test]
    fn bulk_approval_binds_only_to_displayed_proposals() {
        let f = Fixture::new();
        f.call("root:a", "todo_add", json!({"title":"A"}));
        let p = f.proposals()[0].clone();
        f.call("root:b", "todo_add", json!({"title":"B"}));
        apply_all(
            &f.stores(),
            &[Approval {
                id: p.id.clone(),
                digest: digest(&p),
            }],
        )
        .unwrap();
        assert_eq!(f.proposals()[0].status, "applied");
        assert_eq!(f.proposals()[1].status, "pending");
        assert_eq!(
            data_at(&f.calendar).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
