use std::{
    collections::{BTreeMap, HashSet},
    sync::{Mutex, OnceLock},
};

use crate::{
    schema::agent_tasks::{
        AgentPromptTarget, AgentScheduleLastRun, AgentScheduleResult, AgentScheduleRule,
        AgentScheduleTargetBinding, AgentTasksFile, ScheduledAgentPrompt,
    },
    storage,
};

const FILE_NAME: &str = "agent_tasks.json";
pub(crate) const MAX_SCHEDULES: usize = 32;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// A preface is a short list of the agent's own slash commands, not a second
/// message channel: each entry is one line, must be a command, and there are
/// only ever a handful. The caps are here rather than in the UI because the
/// mobile sidecar writes the same file.
pub const MAX_PREFACE_COMMANDS: usize = 6;
pub const MAX_PREFACE_BYTES: usize = 256;
const MAX_ID_BYTES: usize = 256;
const SCHEDULE_TARGET_KEY: &str = "scheduleTargetId";

static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// The transaction guard of the state dir's file: the in-process mutex the
/// window's commands always took, plus the file's `FileLock`, because the
/// Mobile sidecar is a second process on the same file (headless owner plan,
/// H2: it claims and completes occurrences with no window open, and a claim
/// is the only at-most-once check there is). Fields drop in order — the
/// file lock goes before the mutex.
struct Guard {
    _file: Option<storage::FileLock>,
    _mutex: std::sync::MutexGuard<'static, ()>,
}

fn lock() -> Guard {
    let mutex = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    Guard { _file: file_lock(&path()), _mutex: mutex }
}

/// The cross-process lock beside `path` (`agent_tasks.json.lock`). Best
/// effort, like every `FileLock`: a filesystem without advisory locks still
/// gets the occurrence checks inside the transaction.
fn file_lock(path: &std::path::Path) -> Option<storage::FileLock> {
    storage::FileLock::exclusive(path).ok()
}

/// `<state_dir>/agent_tasks.json`.
pub fn file_path(state_dir: &std::path::Path) -> std::path::PathBuf {
    state_dir.join(FILE_NAME)
}

fn path() -> std::path::PathBuf {
    file_path(&storage::state_dir())
}

fn read_at(path: &std::path::Path) -> Result<AgentTasksFile, String> {
    if !path.exists() {
        return Ok(AgentTasksFile::default());
    }
    storage::read_json(path).map_err(|e| format!("read {FILE_NAME}: {e}"))
}

fn read() -> Result<AgentTasksFile, String> {
    read_at(&path())
}

fn write_at(path: &std::path::Path, file: &AgentTasksFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create state directory: {e}"))?;
    }
    storage::write_json_atomic(path, file).map_err(|e| format!("write {FILE_NAME}: {e}"))
}

fn write(file: &AgentTasksFile) -> Result<(), String> {
    write_at(&path(), file)
}

pub(crate) fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn parse_date_time(value: &str) -> Option<(i32, u32, u32, u32, u32)> {
    if !value.is_ascii() { return None; }
    if value.len() != 16
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
    {
        return None;
    }
    let year = value[0..4].parse().ok()?;
    let month = value[5..7].parse().ok()?;
    let day = value[8..10].parse().ok()?;
    let hour = value[11..13].parse().ok()?;
    let minute = value[14..16].parse().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (day >= 1 && day <= days && hour <= 23 && minute <= 59)
        .then_some((year, month, day, hour, minute))
}

fn valid_time(value: &str) -> bool {
    value.is_ascii() && value.len() == 5
        && value.as_bytes().get(2) == Some(&b':')
        && value[0..2].parse::<u8>().is_ok_and(|v| v <= 23)
        && value[3..5].parse::<u8>().is_ok_and(|v| v <= 59)
}

pub(crate) fn validate_rule(rule: &AgentScheduleRule) -> Result<(), String> {
    match rule {
        AgentScheduleRule::Once { at } if parse_date_time(at).is_none() => {
            Err("invalid one-time date/time".into())
        }
        AgentScheduleRule::Daily { time } if !valid_time(time) => Err("invalid time".into()),
        AgentScheduleRule::Weekdays { weekdays, time } => {
            if !valid_time(time)
                || weekdays.is_empty()
                || weekdays.len() > 7
                || weekdays.iter().any(|day| !(1..=7).contains(day))
                || weekdays.iter().collect::<HashSet<_>>().len() != weekdays.len()
            {
                return Err("invalid weekday schedule".into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub(crate) fn sanitize_message(message: &str) -> String {
    let normalized = message.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .chars()
        .filter(|ch| *ch == '\n' || (!ch.is_control() && *ch != '\u{7f}'))
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// One preface entry, sanitized. A slash command occupies its whole line, so an
/// entry carrying a newline is a composition error rather than something to
/// silently join; requiring the leading `/` is what keeps the preface a list of
/// *commands* the agent interprets and not a back door for extra prompt text
/// submitted outside the message the user reviewed.
pub(crate) fn validate_preface_command(command: &str) -> Result<String, String> {
    let clean = sanitize_message(command);
    let clean = clean.trim().to_string();
    if clean.is_empty() {
        return Err("prefix command is empty".into());
    }
    if clean.contains('\n') {
        return Err("a prefix command must be a single line".into());
    }
    if !clean.starts_with('/') {
        return Err("a prefix command must start with \"/\"".into());
    }
    if clean.len() > MAX_PREFACE_BYTES {
        return Err(format!(
            "prefix command exceeds {MAX_PREFACE_BYTES} bytes"
        ));
    }
    Ok(clean)
}

pub(crate) fn validate_preface(preface: Vec<String>) -> Result<Vec<String>, String> {
    if preface.len() > MAX_PREFACE_COMMANDS {
        return Err(format!(
            "a prompt may carry at most {MAX_PREFACE_COMMANDS} prefix commands"
        ));
    }
    preface
        .iter()
        .map(|command| validate_preface_command(command))
        .collect()
}

fn validate_prompt(mut prompt: ScheduledAgentPrompt) -> Result<ScheduledAgentPrompt, String> {
    validate_id("schedule id", &prompt.id)?;
    if let Some(device) = &prompt.phone_device {
        validate_id("phone device", device)?;
    }
    validate_rule(&prompt.rule)?;
    prompt.preface = validate_preface(std::mem::take(&mut prompt.preface))?;
    prompt.message = sanitize_message(&prompt.message);
    if prompt.origin.is_some() {
        if !prompt.preface.is_empty() { return Err("agent schedules cannot carry prefix commands".into()); }
        prompt.message = super::schedule_mcp::sanitize_prompt(&prompt.message)?;
    }
    if prompt.message.trim().is_empty() {
        return Err("scheduled prompt is empty".into());
    }
    if prompt.message.len() > MAX_MESSAGE_BYTES {
        return Err(format!(
            "scheduled prompt exceeds {MAX_MESSAGE_BYTES} bytes"
        ));
    }
    if let Some(last) = &prompt.last {
        if parse_date_time(&last.occurrence).is_none() {
            return Err("invalid last occurrence".into());
        }
    }
    Ok(prompt)
}

fn target_mut<'a>(
    file: &'a mut AgentTasksFile,
    project_id: &str,
    target_id: &str,
) -> &'a mut AgentPromptTarget {
    file.projects
        .entry(project_id.to_string())
        .or_default()
        .entry(target_id.to_string())
        .or_default()
}

pub fn list(project_id: &str, target_id: &str) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    let _guard = lock();
    let mut file = read()?;
    if super::schedule_mcp::prune_proposals(&mut file, &chrono::Utc::now().to_rfc3339()) {
        write(&file)?;
    }
    Ok(schedules_of(&file, project_id, target_id))
}

/// [`list`] for a process that must not write this file — the Mobile sidecar
/// answering a phone with no window open reads `state_dir` and prunes expired
/// proposals in memory only.
pub fn list_at(
    state_dir: &std::path::Path,
    project_id: &str,
    target_id: &str,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    let mut file = read_at(&file_path(state_dir))?;
    super::schedule_mcp::prune_proposals(&mut file, &chrono::Utc::now().to_rfc3339());
    Ok(schedules_of(&file, project_id, target_id))
}

/// Every (project, target) of `state_dir`'s file that holds at least one
/// enabled rule — what the sidecar's scheduler walks with no window open
/// (headless owner plan, H2). A read, never a write.
pub fn bindings_at(state_dir: &std::path::Path) -> Result<Vec<AgentScheduleTargetBinding>, String> {
    let file = read_at(&file_path(state_dir))?;
    Ok(file
        .projects
        .iter()
        .flat_map(|(project_id, targets)| {
            targets
                .iter()
                .filter(|(_, target)| target.schedules.iter().any(|rule| rule.enabled))
                .map(move |(target_id, _)| AgentScheduleTargetBinding {
                    project_id: project_id.clone(),
                    schedule_target_id: target_id.clone(),
                })
        })
        .collect())
}

fn schedules_of(file: &AgentTasksFile, project_id: &str, target_id: &str) -> Vec<ScheduledAgentPrompt> {
    file.projects
        .get(project_id)
        .and_then(|project| project.get(target_id))
        .map(|target| target.schedules.clone())
        .unwrap_or_default()
}

/// Schedule MCP uses the same transaction lock for validation, quotas and writes.
pub(crate) fn mutate<T>(f: impl FnOnce(&mut AgentTasksFile) -> Result<T, String>) -> Result<T, String> {
    let _guard = lock();
    let mut file = read()?;
    let result = f(&mut file)?;
    write(&file)?;
    Ok(result)
}

pub(crate) fn drain_mutations() { drop(lock()); }

/// The refusal an edit of an existing rule gets when the rule it was drawn
/// from is no longer there to edit: the id is gone, or it is a one-time rule
/// that has already been delivered. Exact strings — the frontend matches them.
pub const SCHEDULE_GONE_ERROR: &str = "schedule_gone";
/// The refusal when a delivery of the rule is claimed and not yet complete.
pub const SCHEDULE_BUSY_ERROR: &str = "schedule_busy";

/// Whether `schedule_id` on `target_id` is still a rule an editor may move or
/// drop. An editor holds the rule as it was when it was drawn, and the
/// scheduler may have delivered and retired it since: re-creating it then
/// makes a fresh, unclaimed rule under the same id, and the prompt goes out a
/// second time. A recurring rule with a receipt is still live — only a
/// one-time rule is finished by its receipt — but no rule is while a claim on
/// it is outstanding, because `claim` is the only at-most-once check there is.
fn check_live(
    file: &AgentTasksFile,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
) -> Result<(), String> {
    let Some(target) = file
        .projects
        .get(project_id)
        .and_then(|project| project.get(target_id))
    else {
        return Err(SCHEDULE_GONE_ERROR.into());
    };
    let Some(rule) = target.schedules.iter().find(|item| item.id == schedule_id) else {
        return Err(SCHEDULE_GONE_ERROR.into());
    };
    if matches!(rule.rule, AgentScheduleRule::Once { .. }) && rule.last.is_some() {
        return Err(SCHEDULE_GONE_ERROR.into());
    }
    if target.claims.contains_key(schedule_id) {
        return Err(SCHEDULE_BUSY_ERROR.into());
    }
    Ok(())
}

/// Pure core of [`upsert`]. `expect_existing_on` names the target the edited
/// rule must still be live on ([`check_live`]); the write itself goes to
/// `target_id`, which differs from it when a rule moves to another tab.
pub(crate) fn apply_upsert(
    file: &mut AgentTasksFile,
    project_id: &str,
    target_id: &str,
    prompt: ScheduledAgentPrompt,
    expect_existing_on: Option<&str>,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    if let Some(source) = expect_existing_on {
        check_live(file, project_id, source, &prompt.id)?;
    }
    let target = target_mut(file, project_id, target_id);
    match target
        .schedules
        .iter()
        .position(|item| item.id == prompt.id)
    {
        Some(index) => {
            // Receipts are runner-owned; an editor may change the rule/message
            // but cannot erase at-most-once history by omitting `last`.
            let mut next = prompt;
            next.last = target.schedules[index].last.clone();
            next.origin = target.schedules[index].origin.clone();
            // The phone that made it stays unless the edit names one: a
            // phone's edit takes the rule over (revoking that phone cancels
            // it, #2348); a desktop or agent edit names none and never
            // disowns a phone's rule.
            if next.phone_device.is_none() {
                next.phone_device = target.schedules[index].phone_device.clone();
            }
            let next = validate_prompt(next)?;
            target.schedules[index] = next;
        }
        None => {
            if target.schedules.len() >= MAX_SCHEDULES {
                return Err(format!("a tab may have at most {MAX_SCHEDULES} schedules"));
            }
            target.schedules.push(prompt);
        }
    }
    Ok(target.schedules.clone())
}

/// Write a rule. With `expect_existing_on` set, an edit of an existing rule is
/// refused with [`SCHEDULE_GONE_ERROR`] or [`SCHEDULE_BUSY_ERROR`] instead of
/// re-creating a rule the scheduler already delivered or is delivering; the
/// phone and every plain create pass `None` and behave as before.
pub fn upsert(
    project_id: &str,
    target_id: &str,
    mut prompt: ScheduledAgentPrompt,
    expect_existing_on: Option<&str>,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    if let Some(source) = expect_existing_on {
        validate_id("schedule target id", source)?;
    }
    // Delivery receipts belong exclusively to claim/complete. Neither a new
    // schedule nor an editor request may manufacture one at the CRUD boundary.
    prompt.last = None;
    let prompt = validate_prompt(prompt)?;
    let _guard = lock();
    let mut file = read()?;
    let result = apply_upsert(&mut file, project_id, target_id, prompt, expect_existing_on)?;
    write(&file)?;
    Ok(result)
}

/// [`upsert`] on `path` by a process that shares the file — the Mobile
/// sidecar writing a phone's schedule with no window open (headless owner
/// plan, H3) — under the file's lock alone.
pub fn upsert_in(
    path: &std::path::Path,
    project_id: &str,
    target_id: &str,
    mut prompt: ScheduledAgentPrompt,
    expect_existing_on: Option<&str>,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    if let Some(source) = expect_existing_on {
        validate_id("schedule target id", source)?;
    }
    prompt.last = None;
    let prompt = validate_prompt(prompt)?;
    let _lock = file_lock(path);
    let mut file = read_at(path)?;
    let result = apply_upsert(&mut file, project_id, target_id, prompt, expect_existing_on)?;
    write_at(path, &file)?;
    Ok(result)
}

/// Pure core of [`delete`]; `expect_undelivered` refuses as [`check_live`] does.
pub(crate) fn apply_delete(
    file: &mut AgentTasksFile,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    expect_undelivered: bool,
) -> Result<(), String> {
    if expect_undelivered {
        check_live(file, project_id, target_id, schedule_id)?;
    }
    if let Some(target) = file
        .projects
        .get_mut(project_id)
        .and_then(|project| project.get_mut(target_id))
    {
        target.schedules.retain(|item| item.id != schedule_id);
        target.claims.remove(schedule_id);
    }
    prune_empty(file);
    Ok(())
}

pub fn delete(
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    expect_undelivered: bool,
) -> Result<(), String> {
    let _guard = lock();
    delete_locked(&path(), project_id, target_id, schedule_id, expect_undelivered)
}

/// [`delete`] on `path` by a process that shares the file (the sidecar's
/// retire of a fired one-time rule), under the file's lock alone.
pub fn delete_in(
    path: &std::path::Path,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    expect_undelivered: bool,
) -> Result<(), String> {
    let _lock = file_lock(path);
    delete_locked(path, project_id, target_id, schedule_id, expect_undelivered)
}

fn delete_locked(
    path: &std::path::Path,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    expect_undelivered: bool,
) -> Result<(), String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    validate_id("schedule id", schedule_id)?;
    let mut file = read_at(path)?;
    apply_delete(&mut file, project_id, target_id, schedule_id, expect_undelivered)?;
    write_at(path, &file)
}

pub fn delete_target(project_id: &str, target_id: &str) -> Result<(), String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    let _guard = lock();
    let mut file = read()?;
    if let Some(project) = file.projects.get_mut(project_id) {
        project.remove(target_id);
    }
    prune_empty(&mut file);
    write(&file)
}

/// What a claim came to. `Cancelled`: the rule was a phone's that no longer
/// reaches its scope (revoked, Lock down, or its access narrowed), and it was
/// taken out instead of claimed — the fire-time backstop of
/// `mobile_control::phone_origin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimOutcome {
    Claimed,
    Refused,
    Cancelled,
}

pub fn claim(
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
) -> Result<ClaimOutcome, String> {
    let _guard = lock();
    claim_locked(&path(), project_id, target_id, schedule_id, occurrence, chrono::Local::now())
}

/// [`claim`] on `path` by a process that shares the file — the Mobile
/// sidecar firing a schedule with no window open (headless owner plan, H2).
/// Under the file's lock alone: the check and the write are one transaction
/// against whatever a window wrote, so an occurrence is claimed by exactly
/// one of them, whichever asked first.
pub fn claim_in(
    path: &std::path::Path,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Result<bool, String> {
    let _lock = file_lock(path);
    claim_locked(path, project_id, target_id, schedule_id, occurrence, now).map(|outcome| outcome == ClaimOutcome::Claimed)
}

fn claim_locked(
    path: &std::path::Path,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Result<ClaimOutcome, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    validate_id("schedule id", schedule_id)?;
    if parse_date_time(occurrence).is_none() {
        return Err("invalid occurrence".into());
    }
    let mut file = read_at(path)?;
    let Some(target) = file
        .projects
        .get_mut(project_id)
        .and_then(|project| project.get_mut(target_id))
    else {
        return Ok(ClaimOutcome::Refused);
    };
    let Some(prompt) = target.schedules.iter().find(|item| item.id == schedule_id) else {
        return Ok(ClaimOutcome::Refused);
    };
    // A phone's rule goes in only while that phone still reaches the scope,
    // whichever owner fires it and whatever happened while it was down.
    if let Some(device) = prompt.phone_device.as_deref() {
        let state_dir = path.parent().unwrap_or(std::path::Path::new("."));
        match super::mobile_control::phone_origin::reaches(state_dir, device, project_id) {
            Ok(true) => {}
            Ok(false) => {
                let cancelled = CancelledRule {
                    project_id: project_id.to_string(),
                    target_id: target_id.to_string(),
                    schedule_id: schedule_id.to_string(),
                };
                apply_delete(&mut file, project_id, target_id, schedule_id, false)?;
                write_at(path, &file)?;
                super::mobile_control::phone_origin::log_cancelled(std::slice::from_ref(&cancelled), "at fire time");
                return Ok(ClaimOutcome::Cancelled);
            }
            Err(why) => {
                // Unknown is not "still allowed": not typed, and kept for a
                // check that can answer.
                eprintln!("{}: a phone's scheduled prompt '{schedule_id}' was held back: its phone's access could not be read: {why}", crate::app_slug!());
                return Ok(ClaimOutcome::Refused);
            }
        }
    }
    if !prompt.enabled
        || prompt
            .last
            .as_ref()
            .is_some_and(|last| last.occurrence.as_str() >= occurrence)
        || target
            .claims
            .get(schedule_id)
            .is_some_and(|value| value == occurrence)
    {
        return Ok(ClaimOutcome::Refused);
    }
    if !reserve_agent_delivery(target, schedule_id, occurrence, now) { return Ok(ClaimOutcome::Refused); }
    target
        .claims
        .insert(schedule_id.to_string(), occurrence.to_string());
    write_at(path, &file)?;
    Ok(ClaimOutcome::Claimed)
}

/// A phone's rule taken out because its phone no longer reaches its scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelledRule {
    pub project_id: String,
    pub target_id: String,
    pub schedule_id: String,
}

/// Take out every phone-made rule `reaches(device, project_id)` says no to
/// (`Ok(false)`), with any claim on it. A rule with no phone, or one whose
/// answer is unknown (`Err`), stays. The window's half of `path`, under
/// the in-process lock too.
pub fn cancel_phone_rules(
    path: &std::path::Path,
    reaches: impl Fn(&str, &str) -> Result<bool, String>,
) -> Result<Vec<CancelledRule>, String> {
    // Mutex first, then the file — the order `lock()` takes them in. A
    // struct literal evaluates its fields as written, so naming the file lock
    // first inverted it: a claim holding the mutex and this holding the file
    // lock waited on each other for good.
    let mutex = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let _guard = Guard { _file: file_lock(path), _mutex: mutex };
    cancel_phone_rules_locked(path, reaches)
}

/// [`cancel_phone_rules`] on `path` by a process that shares the file — the
/// Mobile sidecar — under the file's lock alone.
pub fn cancel_phone_rules_in(
    path: &std::path::Path,
    reaches: impl Fn(&str, &str) -> Result<bool, String>,
) -> Result<Vec<CancelledRule>, String> {
    let _lock = file_lock(path);
    cancel_phone_rules_locked(path, reaches)
}

fn cancel_phone_rules_locked(
    path: &std::path::Path,
    reaches: impl Fn(&str, &str) -> Result<bool, String>,
) -> Result<Vec<CancelledRule>, String> {
    let mut file = read_at(path)?;
    let mut cancelled = Vec::new();
    for (project_id, project) in &mut file.projects {
        for (target_id, target) in project.iter_mut() {
            let lost: Vec<String> = target
                .schedules
                .iter()
                .filter(|rule| rule.phone_device.as_deref().is_some_and(|device| reaches(device, project_id) == Ok(false)))
                .map(|rule| rule.id.clone())
                .collect();
            for schedule_id in lost {
                target.schedules.retain(|rule| rule.id != schedule_id);
                target.claims.remove(&schedule_id);
                cancelled.push(CancelledRule {
                    project_id: project_id.clone(),
                    target_id: target_id.clone(),
                    schedule_id,
                });
            }
        }
    }
    if cancelled.is_empty() {
        return Ok(cancelled);
    }
    prune_empty(&mut file);
    write_at(path, &file)?;
    Ok(cancelled)
}

pub fn complete(
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
    result: AgentScheduleResult,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    let _guard = lock();
    complete_locked(&path(), project_id, target_id, schedule_id, occurrence, result)
}

/// [`complete`] on `path`, the sidecar's half of [`claim_in`].
pub fn complete_in(
    path: &std::path::Path,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
    result: AgentScheduleResult,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    let _lock = file_lock(path);
    complete_locked(path, project_id, target_id, schedule_id, occurrence, result)
}

fn complete_locked(
    path: &std::path::Path,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
    result: AgentScheduleResult,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    validate_id("schedule id", schedule_id)?;
    if parse_date_time(occurrence).is_none() {
        return Err("invalid occurrence".into());
    }
    let mut file = read_at(path)?;
    let target = file
        .projects
        .get_mut(project_id)
        .and_then(|project| project.get_mut(target_id))
        .ok_or_else(|| "scheduled prompt target no longer exists".to_string())?;
    if target.claims.get(schedule_id).map(String::as_str) != Some(occurrence) {
        return Err("scheduled occurrence was not claimed".into());
    }
    let prompt = target
        .schedules
        .iter_mut()
        .find(|item| item.id == schedule_id)
        .ok_or_else(|| "scheduled prompt no longer exists".to_string())?;
    prompt.last = Some(AgentScheduleLastRun {
        occurrence: occurrence.to_string(),
        result,
        at: storage::iso_now(),
    });
    let record_id = delivery_id(prompt, occurrence);
    if let Some(delivery) = target.agent_deliveries.iter_mut().find(|r| r.id == record_id) {
        delivery.result = Some(result);
    }
    target.claims.remove(schedule_id);
    let schedules = target.schedules.clone();
    write_at(path, &file)?;
    Ok(schedules)
}

fn prune_empty(file: &mut AgentTasksFile) {
    for project in file.projects.values_mut() {
        project.retain(|_, target| !target.schedules.is_empty() || !target.claims.is_empty() || !target.agent_deliveries.is_empty());
    }
    file.projects.retain(|_, project| !project.is_empty());
}

fn delivery_id(prompt: &ScheduledAgentPrompt, occurrence: &str) -> String {
    if matches!(prompt.rule, AgentScheduleRule::Once { .. }) { prompt.id.clone() }
    else { format!("{}@{occurrence}", prompt.id) }
}

fn reserve_agent_delivery(target: &mut AgentPromptTarget, schedule_id: &str, occurrence: &str, now: chrono::DateTime<chrono::Local>) -> bool {
    let Some(prompt) = target.schedules.iter().find(|s| s.id == schedule_id) else { return false };
    if prompt.origin.is_none() { return true; }
    let day = now.format("%Y-%m-%d").to_string();
    if super::schedule_mcp::delivery_count(target, &day) >= 6 { return false; }
    let id = delivery_id(prompt, occurrence);
    let cutoff = (now - chrono::Duration::days(7)).format("%Y-%m-%d").to_string();
    target.agent_deliveries.retain(|r| r.day >= cutoff);
    target.agent_deliveries.push(crate::schema::agent_tasks::AgentScheduleDelivery {
        id, day, at: now.to_rfc3339(), result: None,
    });
    true
}

fn saved_bindings(file: &AgentTasksFile) -> HashSet<(String, String)> {
    let mut result = HashSet::new();
    for project_id in file.projects.keys() {
        let session = crate::services::terminal_service::load_terminal_session(project_id);
        // project-tree-read: ok — this loader is keyed by project id and reads
        // only the authoritative state-dir session copy, never the project export.
        for tab in session.tab_layout {
            let Some(target_id) = tab
                .extra
                .get(SCHEDULE_TARGET_KEY)
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let kind = tab.extra.get("kind").and_then(serde_json::Value::as_str);
            let resumable = tab.session_id.is_some()
                || tab
                    .extra
                    .get("resumeArgs")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|args| !args.is_empty());
            if matches!(kind, Some("agent") | Some("local_agent")) && resumable {
                result.insert((project_id.clone(), target_id.to_string()));
            }
        }
    }
    result
}

pub fn cleanup_orphans(live: &[AgentScheduleTargetBinding]) -> Result<usize, String> {
    let _guard = lock();
    let mut file = read()?;
    let mut keep = saved_bindings(&file);
    keep.extend(
        live.iter()
            .map(|item| (item.project_id.clone(), item.schedule_target_id.clone())),
    );
    let before: usize = file.projects.values().map(BTreeMap::len).sum();
    for (project_id, project) in &mut file.projects {
        project.retain(|target_id, _| keep.contains(&(project_id.clone(), target_id.clone())));
    }
    prune_empty(&mut file);
    let after: usize = file.projects.values().map(BTreeMap::len).sum();
    if after != before {
        write(&file)?;
    }
    Ok(before - after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_budget_survives_retirement_reload_and_preserves_user_delivery() {
        use crate::schema::agent_tasks::{ScheduleOrigin, ScheduleAuthor};
        let now = chrono::Local::now();
        let mut target = AgentPromptTarget::default();
        for i in 0..6 {
            let mut row = once(&format!("agent-{i}"));
            row.origin = Some(ScheduleOrigin { by: ScheduleAuthor::Agent, session: "s".into(), at: now.to_rfc3339(), from_delivery: None });
            target.schedules.push(row.clone());
            assert!(reserve_agent_delivery(&mut target, &row.id, "2026-09-20T12:00", now));
            target.schedules.clear();
        }
        let mut target: AgentPromptTarget = serde_json::from_value(serde_json::to_value(target).unwrap()).unwrap();
        let mut row = once("next");
        row.origin = Some(ScheduleOrigin { by: ScheduleAuthor::Agent, session: "new-spawn".into(), at: now.to_rfc3339(), from_delivery: None });
        target.schedules.push(row);
        target.schedules.push(once("user"));
        assert!(!reserve_agent_delivery(&mut target, "next", "2026-09-20T12:00", now));
        assert!(reserve_agent_delivery(&mut target, "user", "2026-09-20T12:00", now));
        assert!(reserve_agent_delivery(&mut target, "next", "2026-09-21T12:00", now + chrono::Duration::days(1)));
    }

    #[test]
    fn sanitizer_preserves_newlines_and_drops_terminal_controls() {
        assert_eq!(
            sanitize_message("one\r\ntwo\u{1b}[31m\u{7f}"),
            "one\ntwo[31m"
        );
    }

    #[test]
    fn strict_rules_reject_duplicate_or_out_of_range_weekdays() {
        assert!(validate_rule(&AgentScheduleRule::Weekdays {
            weekdays: vec![1, 1],
            time: "09:00".into(),
        })
        .is_err());
        assert!(validate_rule(&AgentScheduleRule::Weekdays {
            weekdays: vec![1, 7],
            time: "23:59".into(),
        })
        .is_ok());
    }

    #[test]
    fn preface_entries_must_be_single_line_slash_commands() {
        assert_eq!(validate_preface_command("  /clear  ").unwrap(), "/clear");
        assert_eq!(
            validate_preface_command("/model opus\u{1b}[31m").unwrap(),
            "/model opus[31m"
        );
        assert!(validate_preface_command("clear").is_err());
        assert!(validate_preface_command("/clear\nrm -rf /").is_err());
        assert!(validate_preface_command("   ").is_err());
        assert!(validate_preface_command(&format!("/{}", "x".repeat(MAX_PREFACE_BYTES))).is_err());
        assert!(validate_preface(vec!["/clear".into(); MAX_PREFACE_COMMANDS + 1]).is_err());
    }

    fn rule(id: &str, rule: AgentScheduleRule) -> ScheduledAgentPrompt {
        ScheduledAgentPrompt {
            id: id.into(),
            enabled: true,
            message: "go".into(),
            rule,
            preface: Vec::new(),
            last: None,
            origin: None,
            phone_device: None,
        }
    }

    fn once(id: &str) -> ScheduledAgentPrompt {
        rule(id, AgentScheduleRule::Once { at: "2026-09-04T13:00".into() })
    }

    fn daily(id: &str) -> ScheduledAgentPrompt {
        rule(id, AgentScheduleRule::Daily { time: "08:00".into() })
    }

    fn receipt() -> Option<AgentScheduleLastRun> {
        Some(AgentScheduleLastRun {
            occurrence: "2026-09-04T08:00".into(),
            result: AgentScheduleResult::Delivered,
            at: "2026-09-04T08:00:03+00:00".into(),
        })
    }

    /// One tab holding a live one-time rule, a delivered one, a recurring rule
    /// that has run before, and a one-time rule whose delivery is claimed.
    fn seeded() -> AgentTasksFile {
        let mut file = AgentTasksFile::default();
        let target = target_mut(&mut file, "p", "t1");
        target.schedules.push(once("live"));
        target.schedules.push(ScheduledAgentPrompt { last: receipt(), ..once("done") });
        target.schedules.push(ScheduledAgentPrompt { last: receipt(), ..daily("daily") });
        target.schedules.push(once("claimed"));
        target
            .claims
            .insert("claimed".into(), "2026-09-04T13:00".into());
        file
    }

    fn snapshot(file: &AgentTasksFile) -> String {
        serde_json::to_string(file).unwrap()
    }

    /// The window's phone sweep takes the in-process mutex before the file
    /// lock, as `lock()` (every claim) does: waiting on the mutex, it must
    /// not already hold the file — or a claim holding the mutex deadlocks
    /// waiting for it.
    #[test]
    fn the_phone_sweep_waits_for_the_mutex_before_taking_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_path(dir.path());
        write_at(&path, &AgentTasksFile::default()).unwrap();
        let held = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let sweeping = {
            let path = path.clone();
            std::thread::spawn(move || cancel_phone_rules(&path, |_, _| Ok(true)).map(|cancelled| cancelled.len()))
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        let lock_file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path.with_file_name(format!("{FILE_NAME}.lock")))
            .unwrap();
        let free = lock_file.try_lock().is_ok();
        let _ = lock_file.unlock();
        drop(held);
        assert_eq!(sweeping.join().unwrap(), Ok(0));
        assert!(free, "the sweep held the file lock while waiting for the mutex");
    }

    #[test]
    fn an_unguarded_write_behaves_as_before() {
        let mut file = seeded();
        // An editor cannot erase a receipt by omitting it…
        let stored = apply_upsert(&mut file, "p", "t1", once("done"), None).unwrap();
        assert_eq!(stored.iter().find(|item| item.id == "done").unwrap().last, receipt());
        // …a missing id is simply created, and a delete drops the claim too.
        let stored = apply_upsert(&mut file, "p", "t1", once("new"), None).unwrap();
        assert!(stored.iter().any(|item| item.id == "new"));
        apply_delete(&mut file, "p", "t1", "claimed", false).unwrap();
        assert!(!file.projects["p"]["t1"].claims.contains_key("claimed"));
        assert!(apply_delete(&mut file, "p", "t9", "nothing", false).is_ok());
    }

    #[test]
    fn a_guarded_edit_refuses_a_rule_that_was_delivered_or_is_being_delivered() {
        let mut file = seeded();
        let before = snapshot(&file);
        for (id, error) in [
            ("gone", SCHEDULE_GONE_ERROR),
            ("done", SCHEDULE_GONE_ERROR),
            ("claimed", SCHEDULE_BUSY_ERROR),
        ] {
            assert_eq!(
                apply_upsert(&mut file, "p", "t1", once(id), Some("t1")),
                Err(error.to_string()),
                "upsert {id}",
            );
            assert_eq!(
                apply_delete(&mut file, "p", "t1", id, true),
                Err(error.to_string()),
                "delete {id}",
            );
        }
        // A target that does not hold the id at all is gone too, even when
        // another tab does.
        assert_eq!(
            apply_upsert(&mut file, "p", "t1", once("live"), Some("t2")),
            Err(SCHEDULE_GONE_ERROR.to_string()),
        );
        assert_eq!(snapshot(&file), before, "a refusal writes nothing");
    }

    #[test]
    fn a_guarded_edit_still_moves_a_live_rule() {
        let mut file = seeded();
        let retimed = rule("live", AgentScheduleRule::Once { at: "2026-09-04T14:00".into() });
        let stored = apply_upsert(&mut file, "p", "t1", retimed, Some("t1")).unwrap();
        assert_eq!(
            stored.iter().find(|item| item.id == "live").unwrap().rule,
            AgentScheduleRule::Once { at: "2026-09-04T14:00".into() },
        );
        // A recurring rule that has run before is still a plan, and keeps its receipt.
        let stored = apply_upsert(&mut file, "p", "t1", daily("daily"), Some("t1")).unwrap();
        assert_eq!(stored.iter().find(|item| item.id == "daily").unwrap().last, receipt());
        // A move to another tab names the tab the rule came from.
        let stored = apply_upsert(&mut file, "p", "t2", once("live"), Some("t1")).unwrap();
        assert_eq!(stored.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["live"]);
        apply_delete(&mut file, "p", "t1", "live", true).unwrap();
        assert!(!file.projects["p"]["t1"].schedules.iter().any(|item| item.id == "live"));
    }

    #[test]
    fn civil_date_validation_handles_leap_years() {
        assert!(parse_date_time("2028-02-29T12:00").is_some());
        assert!(parse_date_time("2027-02-29T12:00").is_none());
    }
}
