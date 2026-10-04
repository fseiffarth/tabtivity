//! Self-targeted schedule authorship. No PTY access and no root tool dispatch.
use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::schema::agent_tasks::{AgentPromptTarget, AgentScheduleResult, AgentScheduleRule, AgentTasksFile, ScheduleAuthor, ScheduleOrigin, ScheduledAgentPrompt};
use super::{agent_tasks, root_mcp::{Caller, Session}};

pub const SERVER_NAME: &str = crate::brand::MCP_SCHEDULE_SERVER;
pub const CONTRACT: &str = concat!("Schedules fire from an open ", crate::app_name!(), " window, or, with ", crate::app_name!(), " Mobile switched on, from its background service while no window is open (which restarts this tab's session if it has stopped), when the tab is next idle at/after the time. Occurrences over one hour late are missed. By default the user must approve proposals first. Recurring prompts always require approval. Times are desktop-local YYYY-MM-DDTHH:MM / HH:MM. Weekdays are numbered 1 = Monday … 7 = Sunday (the calendar tools' 0 = Sunday convention does not apply here). A one-time schedule needs five minutes' lead; a daily or weekday rule whose next occurrence is closer than that starts at the occurrence after it. Arguments are validated before anything else runs — a malformed call costs no budget. Prompts only: no commands or prefix commands.");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level { Off, Propose, Apply }

pub fn level(project: &str) -> Result<Level, String> {
    let state = crate::storage::state_dir();
    level_at(&state, project)
}

pub(crate) fn level_at(state: &std::path::Path, project: &str) -> Result<Level, String> {
    let settings: crate::schema::Settings = crate::storage::read_json(&state.join("settings.json")).map_err(|_| "schedule MCP settings unavailable")?;
    if settings.schedule_mcp != Some(true) { return Err("schedule MCP is switched off".into()); }
    let projects: crate::schema::projects::ProjectsList = crate::storage::read_json(&state.join("projects.json")).map_err(|_| "project policy unavailable")?;
    let project = projects.iter().find(|p| p.id == project).ok_or("project unavailable")?;
    let level = project.extra.get("schedule_mcp").cloned().unwrap_or(json!("propose"));
    let level: Level = serde_json::from_value(level).map_err(|_| "invalid schedule MCP policy")?;
    if level == Level::Off { return Err("schedule MCP is off for this project".into()); }
    Ok(level)
}

/// Collapse lines before submission and refuse the union of CLI control prefixes.
pub fn sanitize_prompt(message: &str) -> Result<String, String> {
    let clean = super::root_mcp_mail::strip_invisible(message);
    let clean = agent_tasks::sanitize_message(&clean).split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() { return Err("empty_message".into()); }
    if clean.len() > agent_tasks::MAX_MESSAGE_BYTES { return Err("message_too_long".into()); }
    if clean.starts_with(['/', '!', '#', '$', '@']) { return Err("prompt_required: CLI command prefixes are refused".into()); }
    Ok(clean)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum When {
    Once { at: String }, Daily { time: String }, Weekdays { weekdays: Vec<u8>, time: String },
    In { minutes: u32 }, AfterUsageReset,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create { message: String, when: When }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel { id: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub(crate) fn wall(at: &str) -> Option<DateTime<Local>> {
    let naive = NaiveDateTime::parse_from_str(at, "%Y-%m-%dT%H:%M").ok()?;
    // Refuse DST gaps; choose the first occurrence of a repeated wall minute,
    // as the desktop Date constructor does.
    Local.from_local_datetime(&naive).earliest()
}

pub fn next_occurrence(rule: &AgentScheduleRule, now: DateTime<Local>) -> Option<DateTime<Local>> {
    if let AgentScheduleRule::Once { at } = rule { return wall(at); }
    for offset in 0..=370 {
        let day = now.date_naive().checked_add_signed(Duration::days(offset))?;
        let time = match rule {
            AgentScheduleRule::Daily { time } => time,
            AgentScheduleRule::Weekdays { weekdays, time } if weekdays.contains(&(day.weekday().number_from_monday() as u8)) => time,
            _ => continue,
        };
        if let Some(at) = wall(&format!("{day}T{time}")) {
            if at >= now { return Some(at); }
        }
    }
    None
}

fn resolve(when: When, now: DateTime<Local>, reset: Option<DateTime<Utc>>) -> Result<(AgentScheduleRule, DateTime<Local>), String> {
    let once = |at: DateTime<Local>| AgentScheduleRule::Once { at: at.format("%Y-%m-%dT%H:%M").to_string() };
    let rule = match when {
        When::Once { at } => AgentScheduleRule::Once { at },
        When::Daily { time } => AgentScheduleRule::Daily { time },
        When::Weekdays { weekdays, time } => AgentScheduleRule::Weekdays { weekdays, time },
        When::In { minutes } if (5..=525600).contains(&minutes) => {
            let at = now + Duration::minutes(i64::from(minutes));
            once(if at.second() != 0 || at.nanosecond() != 0 { at + Duration::minutes(1) } else { at })
        }
        When::In { .. } => return Err("lead_time: minutes must be between 5 and 525600".into()),
        When::AfterUsageReset => once((reset.ok_or("unsupported: no readable usage reset")? + Duration::minutes(1)).with_timezone(&Local)),
    };
    agent_tasks::validate_rule(&rule)?;
    // A recurring rule has a next occurrence past the lead by definition: the
    // one inside it is skipped, not a reason to refuse the whole rule.
    let from = if matches!(rule, AgentScheduleRule::Once { .. }) { now } else { now + Duration::minutes(5) };
    let at = next_occurrence(&rule, from).ok_or("invalid local time")?;
    if at < now + Duration::minutes(5) { return Err("lead_time: at least five minutes required".into()); }
    Ok((rule, at))
}

pub fn proposed(row: &ScheduledAgentPrompt) -> bool { row.origin.is_some() && !row.enabled && row.last.is_none() }

pub fn prune_proposals(file: &mut AgentTasksFile, now: &str) -> bool {
    let Ok(now) = DateTime::parse_from_rfc3339(now) else { return false };
    let mut changed = false;
    for targets in file.projects.values_mut() {
        for target in targets.values_mut() {
            target.schedules.retain(|row| {
                let expired = proposed(row) && !target.claims.contains_key(&row.id) && row.origin.as_ref()
                    .and_then(|o| DateTime::parse_from_rfc3339(&o.at).ok()).is_some_and(|at| now - at >= Duration::days(7));
                changed |= expired;
                !expired
            });
        }
    }
    changed
}

pub fn delivery_count(target: &AgentPromptTarget, day: &str) -> usize {
    target.agent_deliveries.iter().filter(|r| r.day == day && matches!(r.result, None | Some(AgentScheduleResult::Delivered))).count()
}

fn apply_create(file: &mut AgentTasksFile, session: &Session, args: Create, level: Level, now: DateTime<Local>, reset: Option<DateTime<Utc>>) -> Result<Value, String> {
    let project = session.identity.project.as_deref().ok_or("missing project")?;
    let binding = session.identity.schedule_target.as_ref().ok_or("missing target")?;
    let message = sanitize_prompt(&args.message)?;
    let (rule, fires_at) = resolve(args.when, now, reset)?;
    let recurring = !matches!(rule, AgentScheduleRule::Once { .. });
    if level == Level::Off { return Err("schedule MCP is off".into()); }
    prune_proposals(file, &now.to_rfc3339());
    let target = file.projects.entry(project.into()).or_default().entry(binding.target.clone()).or_default();
    if target.schedules.iter().filter(|s| s.origin.is_some() && !(matches!(s.rule, AgentScheduleRule::Once { .. }) && s.last.is_some())).count() >= 4 {
        return Err("pending_limit: at most four agent schedules per target".into());
    }
    if delivery_count(target, &now.format("%Y-%m-%d").to_string()) >= 6 { return Err("daily_limit: six agent deliveries per day".into()); }
    if recurring && target.schedules.iter().any(|s| s.origin.is_some() && !matches!(s.rule, AgentScheduleRule::Once { .. })) {
        return Err("recurring_limit: at most one agent recurring schedule".into());
    }
    let from_delivery = target.agent_deliveries.iter().rev().find(|d| d.result == Some(AgentScheduleResult::Delivered)).map(|d| d.id.clone());
    let id = format!("agent-{}", super::root_mcp::mint_token().ok_or("entropy unavailable")?);
    let enabled = level == Level::Apply && !recurring;
    let row = ScheduledAgentPrompt { id: id.clone(), enabled, message, rule, preface: vec![], last: None,
        origin: Some(ScheduleOrigin { by: ScheduleAuthor::Agent, session: session.id.clone(), at: now.to_rfc3339(), from_delivery }) };
    agent_tasks::apply_upsert(file, project, &binding.target, row, None)?;
    Ok(json!({"id":id, "state":if enabled {"scheduled"} else {"proposed"}, "fires_at":fires_at.to_rfc3339()}))
}

fn apply_cancel(file: &mut AgentTasksFile, project: &str, target: &str, id: &str) -> Result<Value, String> {
    let row = file.projects.get(project).and_then(|p| p.get(target)).and_then(|t| t.schedules.iter().find(|r| r.id == id)).ok_or("not_found")?;
    if row.origin.is_none() { return Err("not_yours".into()); }
    agent_tasks::apply_delete(file, project, target, id, true)?;
    Ok(json!({"cancelled":id}))
}

pub fn remove_proposals(session: &str) -> Result<(), String> {
    agent_tasks::mutate(|file| {
        for targets in file.projects.values_mut() {
            for target in targets.values_mut() {
                target.schedules.retain(|s| !(proposed(s) && !target.claims.contains_key(&s.id) && s.origin.as_ref().is_some_and(|o| o.session == session)));
            }
        }
        Ok(())
    })
}

/// One schedule as `list_my_schedules` shows it. An agent-authored row in
/// full; a user-authored one with only an 80-character preview of its text.
fn schedule_row(s: &ScheduledAgentPrompt, now: DateTime<Local>) -> Value {
    json!({"id":s.id,"rule":s.rule,"enabled":s.enabled,"origin":s.origin,"last":s.last,
        "message":if s.origin.is_some() { s.message.clone() } else { s.message.chars().take(80).collect() },
        "next_occurrence":if matches!(s.rule, AgentScheduleRule::Once { .. }) && s.last.is_some() { None } else { next_occurrence(&s.rule, now).map(|d| d.to_rfc3339()) }})
}

pub fn tool_names() -> &'static [&'static str] { &["schedule_prompt", "list_my_schedules", "cancel_schedule"] }
/// Audit only fixed refusal categories, never argument values or prompt text.
pub fn refusal_reason(reply: &Value) -> Option<&'static str> {
    if reply["result"]["isError"] != true && reply.get("error").is_none() { return None; }
    let text = reply["result"]["content"][0]["text"].as_str().unwrap_or_default();
    Some(["pending_limit", "daily_limit", "recurring_limit", "lead_time", "hourly_limit", "not_yours", "not_found", "prompt_required", "unsupported", "schedule_busy"]
        .into_iter().find(|reason| text.starts_with(reason)).unwrap_or("invalid_or_unavailable"))
}
pub fn tools() -> Value {
    let object = |properties: Value, required: Value| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    let time = |what: &str| json!({"type":"string","description":format!("{what}, desktop-local \"HH:MM\" (24-hour).")});
    let when = json!({"description":"When the prompt fires. Exactly one shape; `type` picks it.","oneOf":[
        object(json!({"type":{"const":"once","description":"One time, at `at`."},"at":{"type":"string","description":"Desktop-local \"YYYY-MM-DDTHH:MM\", at least five minutes ahead."}}),json!(["type","at"])),
        object(json!({"type":{"const":"daily","description":"Every day at `time`."},"time":time("The daily time")}),json!(["type","time"])),
        object(json!({"type":{"const":"weekdays","description":"On the listed weekdays at `time`."},"time":time("The time on each listed day"),"weekdays":{"type":"array","items":{"type":"integer","minimum":1,"maximum":7},"minItems":1,"maxItems":7,"description":"1 = Monday … 7 = Sunday, no repeats. Not the calendar tools' 0 = Sunday numbering."}}),json!(["type","time","weekdays"])),
        object(json!({"type":{"const":"in","description":"After `minutes`, rounded up to the next whole minute."},"minutes":{"type":"integer","minimum":5,"maximum":525600,"description":"Minutes from now: at least 5, at most a year."}}),json!(["type","minutes"])),
        object(json!({"type":{"const":"after_usage_reset","description":"One minute after this agent CLI's next usage-window reset, read from its own usage panel; refused as `unsupported` when that cannot be read."}}),json!(["type"]))
    ]});
    json!([
        {"name":"schedule_prompt","description":format!("Propose a prompt for this tab only. {CONTRACT}"),"inputSchema":object(json!({"message":{"type":"string","maxLength":16384,"description":"The prompt text this tab is to be given, as the user would type it. No slash, !, #, $ or @ prefix; line breaks are collapsed."},"when":when}),json!(["message","when"]))},
        {"name":"list_my_schedules","description":"List this tab's schedules, with only an 80-character preview of user-authored messages.","inputSchema":object(json!({}),json!([])),"annotations":{"readOnlyHint":true}},
        {"name":"cancel_schedule","description":"Cancel an agent-authored schedule in this tab. User-authored rows cannot be cancelled.","inputSchema":object(json!({"id":{"type":"string","maxLength":256,"description":"The schedule's id, as schedule_prompt or list_my_schedules returned it."}}),json!(["id"]))}
    ])
}

/// The checks that come before any work — the usage probe the command layer
/// runs for `after_usage_reset` included: the arguments must parse against the
/// tool's shape, and a `schedule_prompt` must be inside the hourly budget. A
/// refused call is refused here and costs nothing. `Ok` for every other
/// message (the RPC layer answers those itself).
pub fn admit(session: &Session, message: &Value) -> Result<(), String> {
    if message["method"] != "tools/call" { return Ok(()); }
    let name = message["params"]["name"].as_str().unwrap_or_default();
    let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "schedule_prompt" => {
            let create: Create = serde_json::from_value(args).map_err(|e| e.to_string())?;
            sanitize_prompt(&create.message)?;
            if !matches!(create.when, When::AfterUsageReset) { resolve(create.when, Local::now(), None)?; }
            if !session.admit_schedule_rate() { return Err("hourly_limit: twelve schedule calls per session per hour".into()); }
            Ok(())
        }
        "cancel_schedule" => serde_json::from_value::<Cancel>(args).map(|_| ()).map_err(|e| e.to_string()),
        "list_my_schedules" => serde_json::from_value::<Empty>(args).map(|_| ()).map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

/// Returns an RPC reply and whether schedule views must refresh.
pub fn handle_message(session: &Session, message: &Value, reset: Option<DateTime<Utc>>) -> (Option<Value>, bool) {
    let admission = admit(session, message);
    handle_admitted(session, message, reset, admission)
}

/// [`handle_message`] with the [`admit`] verdict already taken — the command
/// layer takes it first, before deciding whether to run the usage probe.
pub fn handle_admitted(session: &Session, message: &Value, reset: Option<DateTime<Utc>>, admission: Result<(), String>) -> (Option<Value>, bool) {
    let error = |id: Value, code, text: &str| Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}}));
    if message["jsonrpc"] != "2.0" || !message["method"].is_string()
        || message.get("id").is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        || message.get("params").is_some_and(|p| !p.is_object()) {
        return (error(Value::Null, -32600, "invalid request"), false);
    }
    let Some(id) = message.get("id").cloned() else { return (None, false) };
    let ok = |value: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":value}));
    if session.identity.caller != Caller::Scheduler || session.check().is_err() { return (error(id, -32000, "access refused"), false); }
    let Some(project) = session.identity.project.as_deref() else { return (error(id, -32000, "missing project"), false) };
    let Some(binding) = session.identity.schedule_target.as_ref() else { return (error(id, -32000, "missing target"), false) };
    let policy = match level(project) { Ok(l) => l, Err(e) => return (error(id, -32000, &e), false) };
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => (ok(json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")},"instructions":CONTRACT})), false),
        "ping" => (ok(json!({})), false),
        "tools/list" => (ok(json!({"tools":tools()})), false),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
            let result = (|| -> Result<Value, String> {
                admission?;
                agent_tasks::mutate(|file| {
                    session.check()?;
                    if level(project)? != policy { return Err("policy changed; retry".into()); }
                    let now = Local::now();
                    prune_proposals(file, &now.to_rfc3339());
                    match name {
                        "schedule_prompt" => apply_create(file, session, serde_json::from_value(args).map_err(|e| e.to_string())?, policy, now, reset),
                        "cancel_schedule" => {
                            let args: Cancel = serde_json::from_value(args).map_err(|e| e.to_string())?;
                            apply_cancel(file, project, &binding.target, &args.id)
                        }
                        "list_my_schedules" => {
                            let _: Empty = serde_json::from_value(args).map_err(|e| e.to_string())?;
                            let rows: Vec<Value> = file.projects.get(project).and_then(|p| p.get(&binding.target)).into_iter()
                                .flat_map(|t| &t.schedules).map(|s| schedule_row(s, now)).collect();
                            Ok(json!({"schedules":rows}))
                        }
                        _ => Err("unknown tool".into()),
                    }
                })
            })();
            let changed = result.is_ok() && name != "list_my_schedules";
            let value = match result {
                Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false}),
                Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
            };
            (ok(value), changed)
        }
        _ => (error(id, -32601, "method not found"), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::agent_tasks::AgentScheduleDelivery;
    fn now() -> DateTime<Local> { wall("2026-09-20T12:00").unwrap() }
    fn session() -> Session {
        let (_, mut s) = super::super::root_mcp::test_session(Caller::Scheduler);
        s.identity.project = Some("p".into());
        s.identity.schedule_target = Some(super::super::root_mcp::ScheduleBinding { target: "t".into(), agent: "claude".into() });
        s
    }
    fn create(when: Value) -> Create { serde_json::from_value(json!({"message":"continue the work","when":when})).unwrap() }
    fn add(file: &mut AgentTasksFile, s: &Session, level: Level) -> Result<Value, String> {
        apply_create(file, s, create(json!({"type":"in","minutes":10})), level, now(), None)
    }
    #[test]
    fn prefixes_invisible_controls_and_extra_scope_are_refused() {
        for text in ["/clear", "!ls", "#memory", "$skill", "  !ls", "\n/clear", "\u{200b}!ls", "@file"] {
            assert!(sanitize_prompt(text).is_err(), "{text:?}");
        }
        assert_eq!(sanitize_prompt("explain\n! this code").unwrap(), "explain ! this code");
        for key in ["project", "project_id", "tab", "target", "preface"] {
            let mut args = json!({"message":"go","when":{"type":"in","minutes":10}});
            args[key] = json!("other");
            assert!(serde_json::from_value::<Create>(args).is_err());
            let mut args = json!({"id":"a"}); args[key] = json!("other");
            assert!(serde_json::from_value::<Cancel>(args).is_err());
        }
        assert!(serde_json::from_value::<When>(json!({"type":"in","minutes":10,"target":"other"})).is_err());
        assert!(serde_json::from_value::<Empty>(json!({"target":"other"})).is_err());
    }
    #[test]
    fn creation_is_staged_and_self_targeted_and_never_carries_preface() {
        let s = session(); let mut file = AgentTasksFile::default();
        let result = add(&mut file, &s, Level::Propose).unwrap();
        assert_eq!(result["state"], "proposed");
        let row = &file.projects["p"]["t"].schedules[0];
        assert!(proposed(row));
        assert_eq!(row.origin.as_ref().unwrap().session, s.id);
        assert!(serde_json::to_value(row).unwrap().get("preface").is_none());
        let back: AgentTasksFile = serde_json::from_value(serde_json::to_value(&file).unwrap()).unwrap();
        assert_eq!(back.projects["p"]["t"].schedules, file.projects["p"]["t"].schedules);
        assert_eq!(add(&mut file, &s, Level::Apply).unwrap()["state"], "scheduled");
    }
    #[test]
    fn quotas_and_recurring_approval_are_enforced() {
        let s = session(); let mut file = AgentTasksFile::default();
        for _ in 0..4 { add(&mut file, &s, Level::Apply).unwrap(); }
        assert!(add(&mut file, &s, Level::Apply).unwrap_err().starts_with("pending_limit"));
        assert!(resolve(When::In { minutes: 4 }, now(), None).is_err());
        assert!(resolve(When::Once { at: "2026-09-20T12:04".into() }, now(), None).is_err());
        let mut file = AgentTasksFile::default();
        let daily = || create(json!({"type":"daily","time":"13:00"}));
        assert_eq!(apply_create(&mut file, &s, daily(), Level::Apply, now(), None).unwrap()["state"], "proposed");
        assert!(apply_create(&mut file, &s, daily(), Level::Apply, now(), None).unwrap_err().starts_with("recurring_limit"));
        let target = file.projects.get_mut("p").unwrap().get_mut("t").unwrap();
        target.agent_deliveries = (0..6).map(|i| AgentScheduleDelivery { id: i.to_string(), day: "2026-09-20".into(), at: now().to_rfc3339(), result: Some(AgentScheduleResult::Delivered) }).collect();
        // Retiring/cancelling every row and a full disk round-trip cannot reset the budget.
        target.schedules.clear();
        let mut file: AgentTasksFile = serde_json::from_value(serde_json::to_value(file).unwrap()).unwrap();
        assert!(add(&mut file, &s, Level::Apply).unwrap_err().starts_with("daily_limit"));
    }
    #[test]
    fn user_rows_and_outstanding_claims_cannot_be_cancelled() {
        let s = session(); let mut file = AgentTasksFile::default();
        let id = add(&mut file, &s, Level::Propose).unwrap()["id"].as_str().unwrap().to_string();
        let target = file.projects.get_mut("p").unwrap().get_mut("t").unwrap();
        let mut user = target.schedules[0].clone(); user.origin = None; user.id = "user".into();
        target.schedules.push(user);
        assert_eq!(apply_cancel(&mut file, "p", "t", "user").unwrap_err(), "not_yours");
        assert_eq!(apply_cancel(&mut file, "other", "t", &id).unwrap_err(), "not_found");
        file.projects.get_mut("p").unwrap().get_mut("t").unwrap().claims.insert(id.clone(), "2026-09-20T12:10".into());
        assert_eq!(apply_cancel(&mut file, "p", "t", &id).unwrap_err(), agent_tasks::SCHEDULE_BUSY_ERROR);
        file.projects.get_mut("p").unwrap().get_mut("t").unwrap().claims.clear();
        apply_cancel(&mut file, "p", "t", &id).unwrap();
        assert_eq!(file.projects["p"]["t"].schedules.len(), 1);
    }
    #[test]
    fn expiry_prunes_only_unapproved_proposals() {
        let s = session(); let mut file = AgentTasksFile::default();
        add(&mut file, &s, Level::Apply).unwrap(); add(&mut file, &s, Level::Propose).unwrap();
        assert!(!prune_proposals(&mut file, &(now() + Duration::days(6)).to_rfc3339()));
        assert!(prune_proposals(&mut file, &(now() + Duration::days(7)).to_rfc3339()));
        assert_eq!(file.projects["p"]["t"].schedules.len(), 1);
        assert!(file.projects["p"]["t"].schedules[0].enabled);
    }
    #[test]
    fn old_rows_round_trip_without_new_fields() {
        let raw = r#"{"version":1,"projects":{"p":{"t":{"schedules":[{"id":"old","enabled":true,"message":"hello","rule":{"type":"daily","time":"09:00"}}]}}}}"#;
        let file: AgentTasksFile = serde_json::from_str(raw).unwrap();
        assert_eq!(serde_json::to_string(&file).unwrap(), raw);
    }
    #[test]
    fn reset_sugar_and_hourly_limit() {
        let fractional = now() + Duration::milliseconds(500);
        assert!(resolve(When::In { minutes: 5 }, fractional, None).unwrap().1 >= fractional + Duration::minutes(5));
        assert!(resolve(When::AfterUsageReset, now(), None).unwrap_err().contains("unsupported"));
        let (_, at) = resolve(When::AfterUsageReset, now(), Some((now() + Duration::hours(1)).with_timezone(&Utc))).unwrap();
        assert_eq!(at, now() + Duration::minutes(61));
        let s = session();
        for _ in 0..12 { assert!(s.admit_schedule_rate()); }
        assert!(!s.admit_schedule_rate());
    }
    /// A daily or weekday rule whose next occurrence is inside the five-minute
    /// lead is not refused: it starts at the occurrence after. A one-time
    /// schedule inside the lead still is.
    #[test]
    fn recurring_rules_inside_the_lead_roll_to_the_next_occurrence() {
        let (_, at) = resolve(When::Daily { time: "12:03".into() }, now(), None).unwrap();
        assert_eq!(at, wall("2026-09-21T12:03").unwrap());
        let (_, at) = resolve(When::Daily { time: "12:05".into() }, now(), None).unwrap();
        assert_eq!(at, wall("2026-09-20T12:05").unwrap(), "exactly the lead is enough");
        // 2026-09-20 is a Sunday (7): the same day inside the lead rolls a week.
        let (_, at) = resolve(When::Weekdays { weekdays: vec![7], time: "12:02".into() }, now(), None).unwrap();
        assert_eq!(at, wall("2026-09-27T12:02").unwrap());
        assert!(resolve(When::Once { at: "2026-09-20T12:03".into() }, now(), None).unwrap_err().starts_with("lead_time"));
    }

    /// Bad arguments are refused before the budget is touched, so a hundred
    /// malformed calls leave the hourly allowance intact; a well-formed one
    /// takes a slot and the thirteenth is refused before any store is opened.
    #[test]
    fn admission_validates_before_it_spends_budget() {
        let s = session();
        let call = |args: Value| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"schedule_prompt","arguments":args}});
        for _ in 0..100 {
            assert!(admit(&s, &call(json!({"message":"go","when":{"type":"after_usage_reset"},"target":"other"}))).is_err());
            assert!(admit(&s, &call(json!({"message":"/clear","when":{"type":"after_usage_reset"}}))).is_err());
        }
        for _ in 0..12 { assert!(admit(&s, &call(json!({"message":"go","when":{"type":"after_usage_reset"}}))).is_ok()); }
        assert!(admit(&s, &call(json!({"message":"go","when":{"type":"after_usage_reset"}}))).unwrap_err().starts_with("hourly_limit"));
        assert!(admit(&s, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).is_ok());
        assert!(admit(&s, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cancel_schedule","arguments":{"id":"a","tab":"x"}}})).is_err());
    }

    /// The user's own rows are listed as an 80-character preview; an agent's
    /// own rows in full — the row builder `list_my_schedules` uses.
    #[test]
    fn user_rows_are_previewed_to_eighty_characters() {
        let s = session();
        let long: String = "ü".repeat(200);
        let mut file = AgentTasksFile::default();
        add(&mut file, &s, Level::Propose).unwrap();
        let target = file.projects.get_mut("p").unwrap().get_mut("t").unwrap();
        target.schedules[0].message = long.clone();
        let mut user = target.schedules[0].clone();
        user.origin = None; user.id = "user".into();
        let own = schedule_row(&target.schedules[0], now());
        let theirs = schedule_row(&user, now());
        assert_eq!(own["message"].as_str().unwrap().chars().count(), 200);
        assert_eq!(theirs["message"].as_str().unwrap().chars().count(), 80, "characters, not bytes");
        assert_eq!(theirs["id"], "user");
        assert!(theirs["next_occurrence"].is_string());
    }

    #[test]
    fn revoked_and_closed_tab_sessions_are_refused_before_policy_or_store() {
        let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_my_schedules","arguments":{}}});
        let refused = |s: &Session| {
            let (reply, changed) = handle_message(s, &call, None);
            assert!(!changed);
            assert_eq!(reply.unwrap()["error"]["message"], "access refused");
        };
        let s = session();
        super::super::root_mcp::revoke_session(&s.id).unwrap();
        refused(&s);
        let s = session();
        assert!(super::super::root_mcp::revoke_tab(&s.identity.tab));
        refused(&s);
        // A root-class token never reaches the schedule tools either.
        let (_, root) = super::super::root_mcp::test_session(Caller::Agent);
        refused(&root);
    }
    #[test]
    fn root_registry_never_serves_scheduler() {
        for name in super::super::root_mcp::tool_names() {
            assert!(!super::super::root_mcp_security::tool(name).unwrap().serves(Caller::Scheduler), "{name}");
        }
        for name in tool_names() { assert!(super::super::root_mcp_security::tool(name).is_none()); }
    }

    #[test]
    fn settings_are_off_by_default_and_project_policy_is_authoritative() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let projects = dir.path().join("projects.json");
        let row = json!({"id":"p","name":"P","status":"active","position":0,"local_file":"/untrusted/project.json"});
        std::fs::write(&projects, json!([row]).to_string()).unwrap();
        assert!(level_at(dir.path(), "p").is_err());
        std::fs::write(&settings, "{}").unwrap();
        assert!(level_at(dir.path(), "p").is_err());
        std::fs::write(&settings, r#"{"schedule_mcp":true}"#).unwrap();
        assert_eq!(level_at(dir.path(), "p").unwrap(), Level::Propose);
        for value in ["off", "unknown"] {
            let mut row = row.clone(); row["schedule_mcp"] = json!(value);
            std::fs::write(&projects, json!([row]).to_string()).unwrap();
            assert!(level_at(dir.path(), "p").is_err());
        }
        assert!(level_at(dir.path(), "other").is_err());
    }
}
