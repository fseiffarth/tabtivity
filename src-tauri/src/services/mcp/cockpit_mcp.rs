//! Self-only workspace presentation tools on `/mcp/cockpit`.
//! The host binds a saved workspace identity before spawning the agent.
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use crate::services::{cockpit_meta as meta, cockpit_results as results, root_mcp::{Caller, Session}, root_mcp_security as security, workspace};

pub const SERVER_NAME: &str = concat!(crate::app_slug!(), "-cockpit");
pub const TOOL_RENAME: &str = "tab_rename";
pub const TOOL_INFO: &str = "tab_get_info";
pub const TOOL_ACTIVITY: &str = "tab_set_activity";
pub const TOOL_HANDOFF: &str = "tab_set_handoff";
pub const TOOL_RESULTS: &str = "tab_set_results";
pub const TOOL_PROGRESS: &str = "tab_set_progress";
pub const TOOL_BLOCKER: &str = "tab_set_blocker";
pub const TOOL_VERIFICATION: &str = "tab_set_verification";
pub const TOOL_ATTENTION: &str = "tab_request_attention";
pub const TOOL_MILESTONE: &str = "tab_add_milestone";
const TOOL_NAMES: [&str; 10] = [
    TOOL_RENAME, TOOL_INFO, TOOL_ACTIVITY, TOOL_HANDOFF, TOOL_RESULTS, TOOL_PROGRESS, TOOL_BLOCKER, TOOL_VERIFICATION,
    TOOL_ATTENTION, TOOL_MILESTONE,
];

/// Whether `name` is one of this lane's tools (security policy and audit).
pub fn is_tool(name: &str) -> bool { TOOL_NAMES.contains(&name) }
/// Whether `name` only reads.
pub fn is_read_only(name: &str) -> bool { name == TOOL_INFO }

/// What the agent hook (`agent_session`) adds beside the first prompt of a
/// new Claude conversation in a tab holding this lane: the server's
/// instructions alone sit far from the prompt, behind deferred tools, and were
/// skipped about half the time. Printed from a single-quoted shell and
/// PowerShell literal, so it never holds a `'`.
pub const NAME_HINT: &str = concat!(
    "Name this tab first: this prompt opens a new conversation in it. Before working on the task, call tab_get_info, ",
    "then tab_rename once with a compact title for the task (2 to 5 words, ideally under 32 characters) and the label ",
    "you read as expectedLabel (if the tools are deferred, load them with ToolSearch select:mcp__", crate::app_slug!(),
    "-cockpit__tab_get_info,mcp__", crate::app_slug!(), "-cockpit__tab_rename). Rename only when the label is the ",
    "CLI name or tab_get_info reports labelByAgent true (a title an earlier conversation gave); keep a name the user chose.",
);

#[derive(Debug, Clone)]
pub(crate) struct Binding {
    pub state: PathBuf,
    pub scope: String,
    pub id: String,
    /// This spawn's generation nonce (`cockpit_meta::mint_spawn`), minted at
    /// grant, stored with the activity it issues. Not derived from the token
    /// and not a secret.
    pub spawn: String,
}
impl Binding {
    pub(crate) fn path(&self) -> PathBuf {
        super::super::mobile_control::headless::session_file(&self.state, &self.scope)
    }
}

/// Bind only an existing, unambiguous agent tab in this host's session store.
/// No system randomness for the spawn nonce means no binding, like an unbound tab.
pub(crate) fn binding_for_spawn(state: &Path, opts: &crate::terminal::PtyOptions) -> Option<Binding> {
    binding_for_spawn_with(state, opts, meta::mint_spawn)
}

/// [`binding_for_spawn`] with the nonce source as a parameter, so a test can fail it.
pub(crate) fn binding_for_spawn_with(
    state: &Path, opts: &crate::terminal::PtyOptions, mint: impl FnOnce() -> Option<String>,
) -> Option<Binding> {
    let scope = opts.project_id.as_deref().unwrap_or(crate::storage::ROOT_SCOPE);
    if crate::storage::is_reserved_scope(scope) && scope != crate::storage::ROOT_SCOPE { return None; }
    if opts.assistant.is_some() || opts.sandbox || opts.tmux_attach.is_some() { return None; }
    let tmux = opts.tmux_session.as_deref()?;
    let path = super::super::mobile_control::headless::session_file(state, scope);
    let saved: crate::schema::TerminalSession = crate::storage::read_json(&path).ok()?;
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    let mut matches = saved.tab_layout.iter().filter(|tab| {
        workspace::tmux_of(tab) == Some(tmux)
            && tab.extra.get("kind").and_then(Value::as_str).is_some_and(|k| matches!(k, "agent" | "local_agent"))
    });
    let tab = matches.next()?;
    if matches.next().is_some() { return None; }
    Some(Binding { state: state.into(), scope: scope.into(), id: workspace::tab_id(tab)?.into(), spawn: mint()? })
}

/// A new spawn's grant: activity and a blocker another spawn issued are not
/// this one's, so they go now, and its progress is marked ended (one write,
/// only when there is something). Best effort — unreadable state is left
/// alone, and the 30-minute freshness bound still hides it.
pub(crate) fn clear_foreign_activity(binding: &Binding) {
    let _ = meta::clear_other_spawns_in(&binding.path(), &binding.scope, &binding.id, &binding.spawn);
}

pub fn tools() -> Value {
    let text_field = |max: usize| json!({"type":"string","maxLength":max});
    let revision = json!({"type":"integer","minimum":0,
        "description":"The revision tab_get_info returned. A mismatch means the metadata changed since; read it again."});
    json!([
        {"name":TOOL_RENAME,
        "description":concat!("Rename your own ", crate::app_name!(), " tab's display label. Supply only a short, descriptive label. This preserves the session and focus. expectedLabel optionally prevents overwriting a label changed since you last saw it."),
        "inputSchema":{"type":"object","required":["label"],"additionalProperties":false,
            "properties":{"label":{"type":"string","minLength":1,"maxLength":120},
                "expectedLabel":{"type":"string","maxLength":120}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_INFO,
        "description":"Read your own tab's display label, the notes you published (activity, handoff, results, progress, blocker, verification, a question you asked the user while it is open, and your milestones; a blocker only while it is current) and the metadata revision to pass as expectedRevision to the tab_set_* tools. Nothing else: no terminal content, no other tabs, no files.",
        "inputSchema":{"type":"object","additionalProperties":false,"properties":{}},
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_ACTIVITY,
        "description":concat!("Publish one short line about what you are doing now; the user sees it under your tab in the ", crate::app_name!(), " cockpit, marked as written by you. Update it at meaningful transitions only, never per step, per token or as a heartbeat. It expires after 30 minutes and when you are restarted. text null clears it. Plain text, one line, 160 characters."),
        "inputSchema":{"type":"object","required":["expectedRevision","text"],"additionalProperties":false,
            "properties":{"expectedRevision":revision,
                "text":{"type":["string","null"],"maxLength":ACTIVITY_MAX}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_HANDOFF,
        "description":concat!("Leave a handoff note for the user about your work so far: what was done, what was checked and what remains. Shown in the ", crate::app_name!(), " cockpit's detail pane, marked as written by you, and kept across restarts. Replaces the previous note; handoff null clears it. Plain text, up to 1000 characters per field and 3000 in all. The note cannot approve, verify or confirm anything."),
        "inputSchema":{"type":"object","required":["expectedRevision","handoff"],"additionalProperties":false,
            "properties":{"expectedRevision":revision,
                "handoff":{"type":["object","null"],"required":["summary"],"additionalProperties":false,
                    "properties":{"summary":text_field(meta::HANDOFF_FIELD_MAX_CHARS),
                        "checks":text_field(meta::HANDOFF_FIELD_MAX_CHARS),
                        "remaining":text_field(meta::HANDOFF_FIELD_MAX_CHARS)}}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_RESULTS,
        "description":concat!("Point the user at files you produced, as a list of {label, relativePath} references shown in the ", crate::app_name!(), " cockpit's detail pane, marked as listed by you and kept across restarts. relativePath is relative to this project's folder, uses forward slashes and names a file inside the project (no absolute path, no .., no URL, no folder). Listing a path reads nothing, previews nothing and sends nothing; the user opens a file only by clicking it, and a missing file shows as unavailable. Replaces the previous list; an empty list clears it. Up to 8 entries, labels up to 120 characters, paths up to 512. Only projects whose files are on this computer have results; others answer unavailable."),
        "inputSchema":{"type":"object","required":["expectedRevision","results"],"additionalProperties":false,
            "properties":{"expectedRevision":revision,
                "results":{"type":"array","maxItems":meta::RESULTS_MAX_ITEMS,
                    "items":{"type":"object","required":["label","relativePath"],"additionalProperties":false,
                        "properties":{"label":text_field(meta::RESULT_LABEL_MAX_CHARS),
                            "relativePath":text_field(meta::RESULT_PATH_MAX_CHARS)}}}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_PROGRESS,
        "description":concat!("Report your plan's steps and where you are in them, shown in the ", crate::app_name!(), " cockpit's detail pane, marked as written by you. Each step is {id, label, state}: id 1 to 40 characters of a-z, 0-9, _ or -, unique; label up to 120 characters on one line; state pending, active or done, with at most one active. Up to 8 steps. Update it at meaningful transitions only, never per token or as a heartbeat. It counts as running only while it is under 30 minutes old and you have not been restarted; after that it is shown as a past report. An empty list clears it. It confirms nothing."),
        "inputSchema":{"type":"object","required":["expectedRevision","steps"],"additionalProperties":false,
            "properties":{"expectedRevision":revision,
                "steps":{"type":"array","maxItems":meta::PROGRESS_MAX_STEPS,
                    "items":{"type":"object","required":["id","label","state"],"additionalProperties":false,
                        "properties":{"id":{"type":"string","minLength":1,"maxLength":meta::PROGRESS_ID_MAX_CHARS,"pattern":"^[a-z0-9_-]+$"},
                            "label":text_field(meta::PROGRESS_LABEL_MAX_CHARS),
                            "state":{"type":"string","enum":["pending","active","done"]}}}}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_BLOCKER,
        "description":concat!("Say what is in your way when you cannot continue without the user, in one line; the ", crate::app_name!(), " cockpit shows it under your tab in place of your activity line, marked as reported by you. It does not ask or answer anything and changes no state the app detects. It expires after 30 minutes and when you are restarted. text null clears it: clear it as soon as you are unblocked. Plain text, one line, 300 characters."),
        "inputSchema":{"type":"object","required":["expectedRevision","text"],"additionalProperties":false,
            "properties":{"expectedRevision":revision,
                "text":{"type":["string","null"],"maxLength":meta::BLOCKER_MAX_CHARS}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_VERIFICATION,
        "description":concat!("List the checks you ran or still owe, as {label, outcome, note?} entries shown in the ", crate::app_name!(), " cockpit's detail pane as reported by you and kept across restarts. outcome is passed, failed, pending or not_run. label up to 120 characters on one line, note up to 300 characters and may span lines. Up to 8 entries. These are your statements: the app does not run or verify them and shows when you reported them, not when anything ran. Replaces the previous list; an empty list clears it."),
        "inputSchema":{"type":"object","required":["expectedRevision","entries"],"additionalProperties":false,
            "properties":{"expectedRevision":revision,
                "entries":{"type":"array","maxItems":meta::VERIFICATION_MAX_ENTRIES,
                    "items":{"type":"object","required":["label","outcome"],"additionalProperties":false,
                        "properties":{"label":text_field(meta::VERIFICATION_LABEL_MAX_CHARS),
                            "outcome":{"type":"string","enum":["passed","failed","pending","not_run"]},
                            "note":text_field(meta::VERIFICATION_NOTE_MAX_CHARS)}}}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_ATTENTION,
        "description":concat!("Tell the user, in the ", crate::app_name!(), " cockpit's Needs-you list, that you cannot continue without them, with one question of up to 500 characters (it may span lines). It is a notice marked as written by you: it opens your tab's conversation and nothing else. It cannot carry options, an answer or an approval, and the user answers in your normal conversation. A changed question is a new item; the same question again does nothing, even after the user dismissed it. It stays for 24 hours or until you are restarted, the user dismisses it, or you clear it. question null clears it: clear it as soon as you are unblocked. Use it sparingly, never as a heartbeat."),
        "inputSchema":{"type":"object","required":["expectedRevision","question"],"additionalProperties":false,
            "properties":{"expectedRevision":revision,
                "question":{"type":["string","null"],"maxLength":meta::ATTENTION_MAX_CHARS}}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":TOOL_MILESTONE,
        "description":concat!("Record one finished milestone in one line (up to 200 characters), for the user's recap of what happened while they were away, marked as reported by you in the ", crate::app_name!(), " cockpit. requestId (1 to 64 characters of a-z, A-Z, 0-9, _ or -) makes a retry safe: an id already recorded changes nothing. The app stamps the time; only the last 20 are kept. It takes no expectedRevision but does move the metadata revision, so read tab_get_info again before your next tab_set_* call. At real milestones only, never per step or as a heartbeat."),
        "inputSchema":{"type":"object","required":["requestId","text"],"additionalProperties":false,
            "properties":{"requestId":{"type":"string","minLength":1,"maxLength":meta::MILESTONE_ID_MAX_CHARS,"pattern":"^[A-Za-z0-9_-]+$"},
                "text":text_field(meta::MILESTONE_MAX_CHARS)}},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}}
    ])
}
const ACTIVITY_MAX: usize = meta::ACTIVITY_MAX_CHARS;

fn refused(category: &'static str) -> Value { json!({"status":"refused","category":category}) }

/// The category a storage-layer error string is told as: fixed words only,
/// never a path or a message.
fn refusal_of(error: &str) -> Value {
    refused(match error {
        workspace::TAB_NOT_FOUND => "tab_not_found",
        meta::CONFLICT => "conflict",
        "unavailable" => "unavailable",
        meta::TOO_LARGE => "too_large",
        _ => "storage_error",
    })
}

/// The caller's own binding while the switch is on. The switch is read again
/// for every call.
fn bound(session: &Session) -> Result<&Binding, Value> {
    let Some(binding) = session.cockpit.as_ref() else { return Err(refused("unavailable")) };
    if !switch_on(binding) { return Err(refused("unavailable")); }
    Ok(binding)
}

/// The settings switch, read now: off or unreadable settings mean off.
fn switch_on(binding: &Binding) -> bool {
    crate::storage::read_json::<crate::schema::Settings>(&binding.state.join("settings.json")).is_ok_and(|s| s.cockpit_mcp())
}

/// What every read and write runs inside the workspace lock, after the early
/// check in [`bound`]: the session's revocation (a replaced, exited or closed
/// spawn) and the switch again, so neither can change between the early check
/// and the commit.
pub(crate) fn guard<'a>(session: &'a Session, binding: &'a Binding) -> impl FnOnce() -> Result<(), String> + 'a {
    move || {
        session.check().map_err(|_| "unavailable".to_string())?;
        if switch_on(binding) { Ok(()) } else { Err("unavailable".to_string()) }
    }
}

fn rename(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let schema = &tools()[0]["inputSchema"];
    if security::validate(schema, args).is_err() { return refused("invalid_label"); }
    let Some(label) = args["label"].as_str().and_then(workspace::clean_tab_label) else { return refused("invalid_label") };
    let expected = args.get("expectedLabel").and_then(Value::as_str);
    match workspace::rename_tab_id_in(&binding.path(), &binding.scope, &binding.id, &label, expected,
        guard(session, binding), |tab| meta::stamp_agent_label(tab, &label)) {
        Ok((changed, _)) => json!({"status":if changed { "renamed" } else { "unchanged" },"label":label}),
        Err(e) => refusal_of(&e),
    }
}

/// Strict argument shape for the setters: an object holding exactly the
/// allowed keys (all required) and a numeric `expectedRevision`. Done by hand
/// because the shared validator counts bytes against `maxLength`, which would
/// refuse ordinary non-Latin text well inside the character bound.
fn setter_args<'a>(args: &'a Value, field: &str) -> Option<(u64, &'a Value)> {
    let object = args.as_object()?;
    if object.len() != 2 { return None; }
    Some((object.get("expectedRevision")?.as_u64()?, object.get(field)?))
}

fn changed_reply(outcome: &meta::Outcome, field: &'static str, value: Value) -> Value {
    json!({"status":if outcome.changed { "updated" } else { "unchanged" },"revision":outcome.meta.revision,field:value})
}

fn activity_json(a: &meta::Activity) -> Value { json!({"text":a.text,"setAt":a.set_at}) }
fn handoff_json(h: &meta::Handoff) -> Value {
    json!({"summary":h.summary,"checks":h.checks,"remaining":h.remaining,"setAt":h.set_at})
}

fn set_activity(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some((expected, text)) = setter_args(args, "text") else { return refused("invalid_request") };
    let text = match text {
        Value::Null => None,
        Value::String(raw) => match meta::clean_activity(raw) { Some(t) => Some(t), None => return refused("invalid_request") },
        _ => return refused("invalid_request"),
    };
    let change = meta::Change::Activity { text, spawn: binding.spawn.clone() };
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, expected, crate::clock::now_ms(), &change,
        guard(session, binding)) {
        Ok(out) => changed_reply(&out, "activity", out.meta.activity.as_ref().map_or(Value::Null, activity_json)),
        Err(e) => refusal_of(&e),
    }
}

fn set_handoff(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some((expected, note)) = setter_args(args, "handoff") else { return refused("invalid_request") };
    let text = match note {
        Value::Null => None,
        Value::Object(fields) => {
            let field = |name: &str| match fields.get(name) {
                None => Some(""), Some(v) => v.as_str(),
            };
            let known = fields.keys().all(|k| matches!(k.as_str(), "summary" | "checks" | "remaining"));
            let parsed = known.then(|| meta::clean_handoff(fields.get("summary")?.as_str()?, field("checks")?, field("remaining")?)).flatten();
            match parsed { Some(h) => Some(h), None => return refused("invalid_request") }
        }
        _ => return refused("invalid_request"),
    };
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, expected, crate::clock::now_ms(), &meta::Change::Handoff(text),
        guard(session, binding)) {
        Ok(out) => changed_reply(&out, "handoff", out.meta.handoff.as_ref().map_or(Value::Null, handoff_json)),
        Err(e) => refusal_of(&e),
    }
}

fn results_json(r: &meta::Results) -> Value {
    json!({"items":r.items.iter().map(|i| json!({"label":i.label,"relativePath":i.relative_path})).collect::<Vec<_>>(),"setAt":r.set_at})
}

fn set_results(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some((expected, list)) = setter_args(args, "results") else { return refused("invalid_request") };
    let Some(list) = list.as_array() else { return refused("invalid_request") };
    // Only a registered project whose files are on this machine carries
    // results: the root scope, boxes, remote, worker-hosted and VM projects
    // answer `unavailable` whatever they send.
    let Some(root) = results::project_root(&binding.state, &binding.scope) else { return refused("unavailable") };
    let Some(items) = results::clean_items(list) else { return refused("invalid_request") };
    // Containment by resolution alone (never a content read): a target that
    // resolves outside the project, or sits behind a link that leads there,
    // is refused; a missing one is accepted and shows as unavailable later.
    if items.iter().any(|i| results::reach(&root, &i.relative_path) == results::Reach::Outside) {
        return refused("invalid_request");
    }
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, expected, crate::clock::now_ms(), &meta::Change::Results(items),
        guard(session, binding)) {
        Ok(out) => changed_reply(&out, "results", out.meta.results.as_ref().map_or(Value::Null, results_json)),
        Err(e) => refusal_of(&e),
    }
}

fn progress_json(p: &meta::Progress) -> Value {
    json!({"steps":p.steps.iter().map(|s| json!({"id":s.id,"label":s.label,"state":s.state.as_str()})).collect::<Vec<_>>(),"setAt":p.set_at})
}
fn blocker_json(b: &meta::Blocker) -> Value { json!({"text":b.text,"setAt":b.set_at}) }
fn verification_json(v: &meta::Verification) -> Value {
    json!({"entries":v.entries.iter().map(|e| {
        let mut entry = json!({"label":e.label,"outcome":e.outcome.as_str()});
        if let Some(note) = &e.note { entry["note"] = json!(note); }
        entry
    }).collect::<Vec<_>>(),"setAt":v.set_at})
}

fn attention_json(a: &meta::Attention) -> Value {
    json!({"id":a.id,"question":a.question,"setAt":a.set_at,"dismissed":a.dismissed})
}
fn milestone_json(m: &meta::Milestone) -> Value { json!({"requestId":m.request_id,"text":m.text,"at":m.at}) }

fn set_attention(session: &Session, args: &Value) -> Value { set_attention_with(session, args, meta::mint_attention_id) }

/// [`set_attention`] with the id source as a parameter, so a test can fail it.
pub(crate) fn set_attention_with(session: &Session, args: &Value, mint: impl FnOnce() -> Option<String>) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some((expected, question)) = setter_args(args, "question") else { return refused("invalid_request") };
    let question = match question {
        Value::Null => None,
        Value::String(raw) => match meta::clean_attention(raw) { Some(q) => Some(q), None => return refused("invalid_request") },
        _ => return refused("invalid_request"),
    };
    // The id is minted here, once per call; the change uses it only when the
    // question is new (an identical open or dismissed one is a no-op). With no
    // randomness a question is refused before anything is written (a zero id
    // would defeat the dismissal compare-and-swap); a clear needs no id.
    let id = match (&question, mint()) {
        (None, _) => String::new(),
        (Some(_), Some(id)) => id,
        (Some(_), None) => return refused("storage_error"),
    };
    let change = meta::Change::Attention { question, id, spawn: binding.spawn.clone() };
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, expected, crate::clock::now_ms(), &change,
        guard(session, binding)) {
        Ok(out) => changed_reply(&out, "attention", out.meta.attention.as_ref().map_or(Value::Null, attention_json)),
        Err(e) => refusal_of(&e),
    }
}

fn add_milestone(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some(object) = args.as_object().filter(|o| o.len() == 2) else { return refused("invalid_request") };
    let request_id = object.get("requestId").and_then(Value::as_str).filter(|id| meta::valid_request_id(id));
    let text = object.get("text").and_then(Value::as_str).and_then(meta::clean_milestone);
    let (Some(request_id), Some(text)) = (request_id, text) else { return refused("invalid_request") };
    let change = meta::Change::Milestone { request_id: request_id.to_string(), text };
    // Append-only: no revision to compare (update_in skips it for a milestone).
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, 0, crate::clock::now_ms(), &change,
        guard(session, binding)) {
        Ok(out) => {
            let kept = out.meta.milestones.iter().find(|m| m.request_id == request_id).map_or(Value::Null, milestone_json);
            changed_reply(&out, "milestone", kept)
        }
        Err(e) => refusal_of(&e),
    }
}

fn set_progress(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some((expected, list)) = setter_args(args, "steps") else { return refused("invalid_request") };
    let Some(steps) = list.as_array().and_then(|l| meta::clean_progress(l)) else { return refused("invalid_request") };
    let change = meta::Change::Progress { steps, spawn: binding.spawn.clone() };
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, expected, crate::clock::now_ms(), &change,
        guard(session, binding)) {
        Ok(out) => changed_reply(&out, "progress", out.meta.progress.as_ref().map_or(Value::Null, progress_json)),
        Err(e) => refusal_of(&e),
    }
}

fn set_blocker(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some((expected, text)) = setter_args(args, "text") else { return refused("invalid_request") };
    let text = match text {
        Value::Null => None,
        Value::String(raw) => match meta::clean_blocker(raw) { Some(t) => Some(t), None => return refused("invalid_request") },
        _ => return refused("invalid_request"),
    };
    let change = meta::Change::Blocker { text, spawn: binding.spawn.clone() };
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, expected, crate::clock::now_ms(), &change,
        guard(session, binding)) {
        Ok(out) => changed_reply(&out, "blocker", out.meta.blocker.as_ref().map_or(Value::Null, blocker_json)),
        Err(e) => refusal_of(&e),
    }
}

fn set_verification(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    let Some((expected, list)) = setter_args(args, "entries") else { return refused("invalid_request") };
    let Some(entries) = list.as_array().and_then(|l| meta::clean_verification(l)) else { return refused("invalid_request") };
    match meta::update_in(&binding.path(), &binding.scope, &binding.id, expected, crate::clock::now_ms(), &meta::Change::Verification(entries),
        guard(session, binding)) {
        Ok(out) => changed_reply(&out, "verification", out.meta.verification.as_ref().map_or(Value::Null, verification_json)),
        Err(e) => refusal_of(&e),
    }
}

fn get_info(session: &Session, args: &Value) -> Value {
    let binding = match bound(session) { Ok(b) => b, Err(refusal) => return refusal };
    if !args.as_object().is_some_and(|o| o.is_empty()) { return refused("invalid_request"); }
    let now = crate::clock::now_ms();
    match meta::read_in(&binding.path(), &binding.id, guard(session, binding)) {
        Ok(out) => {
            let m = &out.meta;
            // Only this spawn's own line, and only while fresh; an expired
            // one is reported as such so the agent can publish it again.
            let own = m.activity.as_ref().filter(|a| a.spawn == binding.spawn);
            let activity = own.filter(|a| meta::is_fresh(a.set_at, now))
                .map(|a| json!({"text":a.text,"setAt":a.set_at,"ageSeconds":now.saturating_sub(a.set_at) / 1000}));
            let handoff = m.handoff.as_ref().map(|h| {
                let mut value = handoff_json(h);
                value["ageSeconds"] = json!(now.saturating_sub(h.set_at) / 1000);
                value
            });
            let results = m.results.as_ref().map(|r| {
                let mut value = results_json(r);
                value["ageSeconds"] = json!(now.saturating_sub(r.set_at) / 1000);
                value
            });
            // The blocker is transient like the activity: this spawn's own, and
            // only while fresh.
            let own_blocker = m.blocker.as_ref().filter(|b| b.spawn == binding.spawn);
            let blocker = own_blocker.filter(|b| meta::is_fresh(b.set_at, now))
                .map(|b| {
                    let mut value = blocker_json(b);
                    value["ageSeconds"] = json!(now.saturating_sub(b.set_at) / 1000);
                    value
                });
            // Progress is history: always returned, with whether it still
            // counts as running (this spawn's, fresh, not ended).
            let progress = m.progress.as_ref().map(|p| {
                let mut value = progress_json(p);
                value["ageSeconds"] = json!(now.saturating_sub(p.set_at) / 1000);
                value["current"] = json!(p.spawn == binding.spawn && !p.ended && meta::is_fresh(p.set_at, now));
                value
            });
            let verification = m.verification.as_ref().map(|v| {
                let mut value = verification_json(v);
                value["ageSeconds"] = json!(now.saturating_sub(v.set_at) / 1000);
                value
            });
            // The question is this spawn's own, and only while it is open (under
            // 24 hours); the agent is told whether the user dismissed it.
            let own_attention = m.attention.as_ref().filter(|a| a.spawn == binding.spawn);
            let attention = own_attention.filter(|a| meta::attention_is_live(a.set_at, now))
                .map(|a| {
                    let mut value = attention_json(a);
                    value["ageSeconds"] = json!(now.saturating_sub(a.set_at) / 1000);
                    value
                });
            let milestones = m.milestones.iter().map(milestone_json).collect::<Vec<_>>();
            // Whether the label is the title this tab's agent gave it, which a
            // new conversation in the tab may replace (false: the CLI's own name
            // or one the user chose).
            json!({"status":"ok","label":out.label,"labelByAgent":meta::label_is_agents(m, &out.label),"revision":m.revision,"activity":activity,
                "activityExpired":own.is_some() && activity.is_none(),"handoff":handoff,"results":results,
                "progress":progress,"blocker":blocker,"blockerExpired":own_blocker.is_some() && blocker.is_none(),
                "verification":verification,"attention":attention,
                "attentionExpired":own_attention.is_some() && attention.is_none(),"milestones":milestones,
                "activityTtlSeconds":meta::ACTIVITY_TTL_MS / 1000})
        }
        Err(e) => refusal_of(&e),
    }
}

/// Refresh is a best-effort hint after commit; never expose persistence paths.
pub(crate) fn refresh_patch(session: &Session, reply: &Value) -> Option<(String, u64)> {
    // Any committed change (a rename or a metadata update) tells the views.
    if !matches!(reply["result"]["structuredContent"]["status"].as_str(), Some("renamed" | "updated")) { return None; }
    let binding = session.cockpit.as_ref()?;
    let saved: crate::schema::TerminalSession = crate::storage::read_json(&binding.path()).ok()?;
    Some((binding.scope.clone(), workspace::version_of(&saved)))
}

/// Return only fixed refusal categories for the bounded, text-free audit.
pub fn refusal_reason(reply: &Value) -> Option<&'static str> {
    match reply["result"]["structuredContent"]["category"].as_str()? {
        "rate_limited" => Some("rate_limited"), "invalid_label" => Some("invalid_label"),
        "invalid_request" => Some("invalid_request"), "too_large" => Some("too_large"),
        "unavailable" => Some("unavailable"), "tab_not_found" => Some("tab_not_found"),
        "conflict" => Some("conflict"), "storage_error" => Some("storage_error"), _ => None,
    }
}

/// One bounded JSON-RPC message. No user-controlled target is accepted.
pub fn handle_message(session: &Session, message: &Value) -> Option<Value> {
    let error = |id: Value, code, text| Some(crate::services::root_mcp::rpc_error(id, code, text));
    if message["jsonrpc"] != "2.0" || !message["method"].is_string()
        || message.get("id").is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        || message.get("params").is_some_and(|p| !p.is_object()) {
        return error(Value::Null, -32600, "invalid request");
    }
    let id = message.get("id").cloned()?;
    if session.identity.caller != Caller::Cockpit || session.cockpit.is_none() || session.check().is_err() {
        return error(id, -32000, "access refused");
    }
    let ok = |value| Some(json!({"jsonrpc":"2.0","id":id,"result":value}));
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => ok(json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},
            "serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")},
            "instructions":"Workspace conveniences for your own tab only. On the first task prompt of a new conversation (a new tab or after /clear), use tab_get_info then tab_rename once for a compact task title (2 to 5 words, ideally under 32 characters), before starting on the task. Only replace a generic CLI label, an automatic title derived from that prompt, or a title an earlier conversation gave (tab_get_info labelByAgent true); preserve custom user labels and resumed conversation names. Pass the label you read as expectedLabel; if it changed, leave it alone. After that, rename only when the user requests it. Call tab_get_info for the revision, then tab_set_activity (one line, at meaningful transitions only, never as a heartbeat), tab_set_handoff (what was done, checked and remains) or tab_set_results (project-relative paths of files you produced), tab_set_progress (plan steps and the one you are on), tab_set_blocker (one line, only while you cannot continue without the user; clear it when unblocked) or tab_set_verification (the checks you ran or owe), tab_request_attention (one question, only when you cannot continue without the user; clear it when unblocked) or tab_add_milestone (one finished milestone, with a requestId). Your notes are shown to the user as written by you; they confirm nothing."})),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools":tools()})),
        "tools/call" => {
            let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
            let name = message["params"]["name"].as_str().unwrap_or_default();
            // One shared budget: every call is charged first, a malformed or
            // unknown-target one and `tab_get_info` included.
            let admitted = session.admit_cockpit_rate();
            if !is_tool(name) {
                return ok(json!({"content":[{"type":"text","text":"unknown tool"}],"isError":true}));
            }
            let value = if !admitted {
                refused("rate_limited")
            } else {
                match name {
                    TOOL_RENAME => rename(session, &args),
                    TOOL_INFO => get_info(session, &args),
                    TOOL_ACTIVITY => set_activity(session, &args),
                    TOOL_RESULTS => set_results(session, &args),
                    TOOL_PROGRESS => set_progress(session, &args),
                    TOOL_BLOCKER => set_blocker(session, &args),
                    TOOL_VERIFICATION => set_verification(session, &args),
                    TOOL_ATTENTION => set_attention(session, &args),
                    TOOL_MILESTONE => add_milestone(session, &args),
                    _ => set_handoff(session, &args),
                }
            };
            ok(json!({"content":[{"type":"text","text":value.to_string()}],
                "isError":value["status"] == "refused","structuredContent":value}))
        }
        _ => error(id, -32601, "method not found"),
    }
}
