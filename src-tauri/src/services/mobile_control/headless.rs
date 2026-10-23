//! Answers for the phone with no desktop window open (headless owner plan,
//! H0).
//!
//! The persisted-state request kinds — the to-do board, a calendar month, a
//! tab's schedules, a project's collected prompts and an agent transcript —
//! are read straight from the state dir and shaped exactly as the desktop's
//! `MobileBridgeHost` shapes them, opaque ids included (same host key, same
//! domains), so a phone that read a board through the window and reads it
//! again through this module sees the same ids. `host.rs` reaches for these
//! only once the desktop's control socket reported the window closed.
//!
//! Read-only but for one write (H1b): a create goes through the workspace
//! service's owner-side primitive (`workspace::create_tab_in`, under the
//! session file's lock), and nothing here touches `calendar.json` or
//! `agent_tasks.json`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use serde_json::json;

use super::discovery::{key_id, ResolvedProject, ResolvedTab, ScopeKind};
use super::protocol::{
    AgentCatalogEntry, AgentTabPrompt, AgentTabPrompts, AgentTabSchedules, AgentTabStatus,
    AgentTabTiming, CreateTabKind, CreateTabRequest, MobileCalendarEvent, MobileCalendarInfo,
    MobileCalendarSnapshot, PromptMutation, ScheduleMutation, TodoBoardSnapshot, TodoCalendar,
    TodoCard, TodoColumn, TodoProject, TodoSubtask,
};
use crate::schema::agent_prompts::{ProjectAgentPrompt, ProjectAgentPromptInput, RecordedAgentPromptInput, SentAgentPromptInput};
use crate::schema::agent_tasks::{AgentScheduleRule, ScheduledAgentPrompt};
use crate::schema::calendar::{Calendar, CalendarData};
use crate::schema::project::TabEntry;
use crate::services::agent_session;
use crate::services::agent_transcript::{self, AgentTranscript, DEFAULT_LIMIT};
use crate::services::agent_turn::{parse_turn_record, TurnState, TURN_SUFFIX};
use crate::terminal::PtyOptions;
use crate::services::calendar_recurrence::{expand_events, month_window};
use crate::services::todo_board::{board_columns, column_of, fallback_column_id};
use crate::services::{agent_prompts, agent_tasks, schedule_mcp};
use crate::storage;

/// The desktop's cap on one month answer (`MOBILE_CALENDAR_EVENTS`).
const MOBILE_CALENDAR_EVENTS: usize = 400;

/// The category keys with a colour of their own (`calendarCategories.ts`).
const CATEGORY_KEYS: &[&str] = &["work", "personal", "meeting", "travel", "birthday", "holiday", "important"];

fn calendar_data(state_dir: &Path) -> Result<CalendarData, String> {
    crate::commands::calendar::read_data(&state_dir.join("calendar.json"))
}

/// `boundedText`: at most `max_bytes`, cut on a character boundary.
fn bounded(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn extra_string(extra: &std::collections::HashMap<String, serde_json::Value>, key: &str) -> bool {
    extra.get(key).and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())
}

/// `eventColor` over `calendarColor`: a known category's own swatch, else the
/// calendar's colour, else the accent.
fn event_color(category: &str, calendars: &[Calendar], calendar_id: &str) -> String {
    if CATEGORY_KEYS.contains(&category) {
        return format!("var(--cal-cat-{category})");
    }
    calendars
        .iter()
        .find(|c| c.id == calendar_id)
        .map(|c| c.color.clone())
        .unwrap_or_else(|| "var(--accent)".to_string())
}

// ── To-do board ─────────────────────────────────────────────────────────────

/// The board as `todoSnapshot` publishes it. `today` is the desktop-local
/// `"YYYY-MM-DD"` (or a full stamp) the date columns are read against.
pub fn todo_board(state_dir: &Path, host_key: &[u8], today: &str) -> Result<TodoBoardSnapshot, String> {
    let data = calendar_data(state_dir)?;
    let columns = board_columns(&data.task_columns);
    let intake = fallback_column_id(&columns);
    let id = |domain: &str, value: &str| key_id(host_key, domain, &[value]);
    Ok(TodoBoardSnapshot {
        columns: columns
            .iter()
            .map(|column| TodoColumn {
                id: column.id.clone(),
                name: column.name.clone(),
                position: column.position,
                done: column.done,
                archived: column.archived,
                intake: column.id == intake,
                overdue: column.overdue,
                due_today: column.due_today,
                color: (!column.color.is_empty()).then(|| column.color.clone()),
            })
            .collect(),
        tasks: data
            .tasks
            .iter()
            .map(|task| TodoCard {
                id: id("task", &task.id),
                title: task.title.clone(),
                column: column_of(task, &columns, today),
                done: task.percent >= 100,
                due: task.due.clone().filter(|d| !d.is_empty()),
                notes: Some(task.notes.clone()),
                priority: task.priority,
                percent: task.percent,
                rank: task.rank,
                calendar_id: id("calendar", &task.calendar_id),
                project_id: (!task.project_id.is_empty()).then(|| id("project", &task.project_id)),
                tags: task.tags.clone(),
                subtasks: task
                    .subtasks
                    .iter()
                    .map(|step| TodoSubtask { id: id("subtask", &step.id), title: step.title.clone(), done: step.done })
                    .collect(),
            })
            .collect(),
        calendars: data
            .calendars
            .iter()
            .map(|entry| TodoCalendar { id: id("calendar", &entry.id), name: entry.name.clone() })
            .collect(),
        projects: project_names(state_dir)
            .into_iter()
            .map(|(raw, name)| TodoProject { id: id("project", &raw), name })
            .collect(),
    })
}

/// Every registered project's `(id, name)`, in registry order — what the
/// board's project chips resolve against. Tolerant of any registry shape:
/// an entry without both strings is simply not offered.
pub(super) fn project_names(state_dir: &Path) -> Vec<(String, String)> {
    let Ok(bytes) = std::fs::read(state_dir.join("projects.json")) else {
        return Vec::new();
    };
    let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?;
            let name = row.get("name")?.as_str()?;
            Some((id.to_string(), name.to_string()))
        })
        .collect()
}

// ── Calendar month ──────────────────────────────────────────────────────────

/// A validated `YYYY-MM` as `(year, month)`.
fn parse_month(month: &str) -> Option<(i32, u32)> {
    if month.len() != 7 || !month.is_ascii() {
        return None;
    }
    let (year, mon) = month.split_once('-')?;
    let year: i32 = year.parse().ok()?;
    let mon: u32 = mon.parse().ok()?;
    ((1000..=9999).contains(&year) && (1..=12).contains(&mon)).then_some((year, mon))
}

/// The month as `calendarSnapshot` publishes it: the six-week grid's window,
/// visible calendars only, recurrence expanded, at most
/// [`MOBILE_CALENDAR_EVENTS`] occurrences.
pub fn calendar_month(state_dir: &Path, host_key: &[u8], month: &str) -> Result<MobileCalendarSnapshot, String> {
    let (year, mon) = parse_month(month).ok_or_else(|| "invalid_month".to_string())?;
    let data = calendar_data(state_dir)?;
    let week_start = calendar_week_start(state_dir);
    let (window_start, window_end) = month_window(year, mon, u32::from(week_start), 6);
    let visible: HashSet<String> = data.calendars.iter().filter(|c| c.visible).map(|c| c.id.clone()).collect();
    let mut occurrences = expand_events(&data.events, &window_start, &window_end, Some(&visible));
    // Cut day by day (`sortOccurrencesByDay`): `expand_events` puts every
    // all-day row of the window first, so a cap on it dropped later weeks'
    // timed events.
    occurrences.sort_by(|a, b| {
        a.start
            .get(..10)
            .cmp(&b.start.get(..10))
            .then_with(|| b.all_day.cmp(&a.all_day))
            .then_with(|| a.start.cmp(&b.start))
            .then_with(|| a.title.cmp(&b.title))
    });
    let shown = &occurrences[..occurrences.len().min(MOBILE_CALENDAR_EVENTS)];
    let id = |domain: &str, value: &str| key_id(host_key, domain, &[value]);
    let optional = |value: &str, max: usize| (!value.is_empty()).then(|| bounded(value, max));
    Ok(MobileCalendarSnapshot {
        month: month.to_string(),
        week_start,
        calendars: data
            .calendars
            .iter()
            .map(|entry| MobileCalendarInfo {
                id: id("calendar", &entry.id),
                name: bounded(&entry.name, 160),
                color: bounded(&entry.color, 64),
                visible: entry.visible,
                readonly: entry.readonly,
                // Only the fact: a feed URL routinely embeds a private token.
                subscribed: extra_string(&entry.extra, "source_url"),
                caldav: extra_string(&entry.extra, "caldav_account_id"),
            })
            .collect(),
        truncated: occurrences.len() > shown.len(),
        events: shown
            .iter()
            .map(|occurrence| {
                let color = bounded(&event_color(&occurrence.category, &data.calendars, &occurrence.calendar_id), 32);
                MobileCalendarEvent {
                    id: id("event", &occurrence.event_id),
                    calendar_id: id("calendar", &occurrence.calendar_id),
                    occurrence_start: bounded(&occurrence.occurrence_start, 32),
                    start: bounded(&occurrence.start, 32),
                    end: bounded(&occurrence.end, 32),
                    all_day: occurrence.all_day,
                    title: bounded(&occurrence.title, 240),
                    location: optional(&occurrence.location, 160),
                    notes: optional(&occurrence.notes, 16 * 1024),
                    conference: optional(&occurrence.conference, 2_000),
                    category: optional(&occurrence.category, 80),
                    color: if color.is_empty() { "#7c6cff".to_string() } else { color },
                    status: (occurrence.status == "cancelled").then(|| "cancelled".to_string()),
                    recurring: occurrence.recurring,
                }
            })
            .collect(),
    })
}

/// The desktop's week-start preference: 0 = Sunday, otherwise Monday.
fn calendar_week_start(state_dir: &Path) -> u8 {
    let settings: Option<crate::schema::Settings> = storage::read_json(&state_dir.join("settings.json")).ok();
    match settings.and_then(|s| s.calendar_week_start) {
        Some(0) => 0,
        _ => 1,
    }
}

// ── Schedules and prompts ───────────────────────────────────────────────────

/// One tab's schedules as the desktop answers `Schedules`.
#[derive(Debug, Clone)]
pub struct TabSchedules {
    pub schedules: Vec<ScheduledAgentPrompt>,
    pub time_zone: String,
    pub next_runs: BTreeMap<String, String>,
}

/// `schedulesFor` off the file: the rows filed under the tab's binding, with
/// each enabled rule's next desktop-local occurrence.
pub fn schedules(
    state_dir: &Path,
    project_id: &str,
    schedule_target_id: &str,
    now: DateTime<Local>,
) -> Result<TabSchedules, String> {
    let schedules = agent_tasks::list_at(state_dir, project_id, schedule_target_id)?;
    let next_runs = schedules
        .iter()
        .filter_map(|schedule| next_run_key(schedule, now).map(|key| (schedule.id.clone(), key)))
        .collect();
    Ok(TabSchedules { schedules, time_zone: local_time_zone(), next_runs })
}

/// `nextScheduleOccurrence`'s key: a disabled rule has none, a one-time rule
/// that already ran has none, otherwise the next `YYYY-MM-DDTHH:MM` at or
/// after `now`.
pub fn next_run_key(schedule: &ScheduledAgentPrompt, now: DateTime<Local>) -> Option<String> {
    if !schedule.enabled {
        return None;
    }
    if let AgentScheduleRule::Once { at } = &schedule.rule {
        if schedule.last.is_some() {
            return None;
        }
        let wall = schedule_mcp::next_occurrence(&schedule.rule, now)?;
        return (wall >= now).then(|| at.clone());
    }
    schedule_mcp::next_occurrence(&schedule.rule, now).map(|at| at.format("%Y-%m-%dT%H:%M").to_string())
}

/// `promptsFor` off the file.
pub fn prompts(state_dir: &Path, project_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    agent_prompts::list_at(state_dir, project_id)
}

// ── Transcript ──────────────────────────────────────────────────────────────

/// The agents whose transcript Tabtivity reads at all (`TRANSCRIPT_AGENTS`).
const TRANSCRIPT_AGENTS: &[&str] = &["claude", "codex", "opencode", "gemini", "agy"];

/// `agentTranscriptFor` off the tab record: the same two "not yet" answers
/// (`no_session` for a transcript family whose hook has not recorded a
/// session yet, `unsupported` for the rest), then the CLI's own transcript.
/// An OpenCode tab reads its folder's newest session — begun since the
/// launch a headless create stamped (`ResolvedTab::since`), so a new tab is
/// a new chat rather than the folder's last conversation — and needs no
/// session id, which a local-model OpenCode tab never has; that one is read
/// from the scope's local-model home.
pub fn transcript(
    project_id: &str,
    tab: &ResolvedTab,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: Option<usize>,
) -> AgentTranscript {
    if tab.local_model && tab.cmd == "opencode" {
        return agent_transcript::local_opencode_transcript(
            Some(project_id),
            Some(&tab.cwd),
            tab.since,
            subagent,
            version,
            limit.unwrap_or(DEFAULT_LIMIT),
        );
    }
    let session_id = tab.session_id.as_deref().filter(|id| !id.is_empty());
    let Some(session_id) = session_id.or(matches!(tab.cmd.as_str(), "opencode" | "gemini" | "agy").then_some("")) else {
        let reason = if TRANSCRIPT_AGENTS.contains(&tab.cmd.as_str()) { "no_session" } else { "unsupported" };
        return AgentTranscript::unavailable(reason);
    };
    agent_transcript::agent_session_transcript(
        &tab.cmd,
        Some(project_id),
        Some(&tab.cwd),
        tab.since,
        session_id,
        subagent,
        version,
        limit.unwrap_or(DEFAULT_LIMIT),
    )
}

// ── Catalog, activity, git dots and create (H1b) ────────────────────────────
//
// The rest of what the phone's project screen reads through the window, and
// the one write the owner can do on its own: `Create`. The catalog's agent
// list, the agent tabs' turn state, their schedule summaries and prompts and
// the project's git dot are read off the state dir and the tabs' own
// transcripts; a create is `workspace::create_tab_in` (the owner mints the
// id, the tmux name and an agent's schedule binding) followed by a detached
// spawn through the seam the host hands in — `launch_prep::prepare` plus
// `tmux_local::spawn_detached_with` in production, a recorder in tests.

/// A built-in agent the phone may start with no window: the registry's
/// label and binary under the opaque id the desktop mints for it
/// (`mobile_opaque_id("agent", cmd)`), so the phone's pick resolves on
/// either side.
#[derive(Debug, Clone)]
pub struct AgentChoice {
    pub public: AgentCatalogEntry,
    pub bin: &'static str,
}

/// The `disabled_agents` list of `settings.json` (registry ids; a binary
/// name is accepted too, as the desktop's own filter reads them).
fn disabled_agents(state_dir: &Path) -> HashSet<String> {
    std::fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|settings| {
            settings.get("disabled_agents").and_then(|list| {
                list.as_array()
                    .map(|rows| rows.iter().filter_map(|row| row.as_str().map(str::to_string)).collect())
            })
        })
        .unwrap_or_default()
}

/// `default_agent_cmd` of `settings.json` — a registry id or a binary, as
/// the desktop's readers take it — "claude" when unset.
fn default_agent(state_dir: &Path) -> String {
    std::fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|settings| settings.get("default_agent_cmd")?.as_str().map(|cmd| cmd.trim().to_string()))
        .filter(|cmd| !cmd.is_empty())
        .unwrap_or_else(|| "claude".to_string())
}

/// `agentChoices` with no window: the resumable built-ins that are installed
/// (`installed`, the registry probe in production) and not switched off in
/// the settings. Custom agents need the desktop's own probe and are not
/// offered here; `modes` is empty, as the desktop sends it.
pub fn agents(state_dir: &Path, host_key: &[u8], installed: &dyn Fn(&str) -> bool) -> Vec<AgentChoice> {
    let disabled = disabled_agents(state_dir);
    let default = default_agent(state_dir);
    super::discovery::resumable_builtins()
        .into_iter()
        .filter_map(|bin| {
            let label = crate::commands::agents::agent_label_for_bin(bin)?;
            let id = crate::commands::agents::agent_id_for_bin(bin)?;
            if disabled.contains(id) || disabled.contains(bin) || !installed(bin) {
                return None;
            }
            Some(AgentChoice {
                public: AgentCatalogEntry {
                    id: key_id(host_key, "agent", &[bin]),
                    label: label.to_string(),
                    modes: Vec::new(),
                    default: default == bin || default == id,
                },
                bin,
            })
        })
        .collect()
}

/// What the hooks' turn records and the tabs' transcripts say about a
/// project's agent tabs: the desktop's `statuses`, `timings` and `prompts`
/// rows of a `Catalog` answer, keyed by tmux name like those.
#[derive(Debug, Clone, Default)]
pub struct TurnReadings {
    pub statuses: Vec<AgentTabStatus>,
    pub timings: Vec<AgentTabTiming>,
    pub prompts: Vec<AgentTabPrompts>,
}

/// The newest turn record of a tab: the shared root's and, for a project
/// tab, the project's own slice (where a fenced agent's hook writes) — the
/// one with the later stamp wins. The record is `<state> <epoch seconds>`.
pub(super) fn turn_record(state_dir: &Path, project_id: &str, uid: &str) -> Option<(TurnState, Option<u64>)> {
    if uid.is_empty() || uid.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return None;
    }
    let name = format!("{uid}{TURN_SUFFIX}");
    let live = state_dir.join("live_sessions");
    [live.join(&name), live.join(storage::project_key(project_id)).join(&name)]
        .iter()
        .filter_map(|path| {
            let text = crate::services::home_io::read_record(path)?;
            let state = parse_turn_record(&text)?;
            let at = text.split_whitespace().nth(1).and_then(|s| s.parse::<u64>().ok());
            Some((state, at))
        })
        .max_by_key(|(_, at)| at.unwrap_or(0))
}

/// `Catalog`'s per-tab agent readings for `tabs` with no window: a turn in
/// flight is `working` (a decision pending, `question`), a finished one
/// `done`; an idle or unrecorded tab gets a timing row when its transcript
/// names a model or has subagents at work; every agent tab with a transcript
/// gets its newest prompts.
pub fn turn_readings(state_dir: &Path, project_id: &str, tabs: &[ResolvedTab]) -> TurnReadings {
    let mut readings = TurnReadings::default();
    for tab in tabs.iter().filter(|t| t.public.kind == "agent") {
        let Some(uid) = tab.session_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let model = agent_session::agent_session_model(&tab.cmd, Some(project_id), uid);
        let subagents = agent_transcript::running_subagents(&tab.cmd, Some(project_id), uid);
        let record = turn_record(state_dir, project_id, uid);
        let ms = |at: Option<u64>| at.map(|secs| secs.saturating_mul(1000));
        match record {
            Some((TurnState::Working, at)) | Some((TurnState::Decision, at)) => {
                let status = if matches!(record, Some((TurnState::Decision, _))) { "question" } else { "working" };
                readings.statuses.push(AgentTabStatus {
                    tmux_session: tab.tmux_name.clone(),
                    status: status.to_string(),
                    model: model.clone(),
                    plan: false,
                    goal: false,
                    working_at: ms(at),
                    done_at: None,
                    turn_started_at: None,
                    subagents,
                });
            }
            // A finished turn the phone already watched (`mark_seen`, H3) is a
            // read one: it keeps its timing and its model, not its status.
            Some((TurnState::Done, at)) if seen_at(state_dir, uid).is_some_and(|seen| at.unwrap_or(0) <= seen) => {
                readings.timings.push(AgentTabTiming {
                    tmux_session: tab.tmux_name.clone(),
                    model: model.clone(),
                    plan: false,
                    goal: false,
                    working_at: None,
                    done_at: ms(at),
                    turn_started_at: None,
                    subagents,
                });
            }
            Some((TurnState::Done, at)) => readings.statuses.push(AgentTabStatus {
                tmux_session: tab.tmux_name.clone(),
                status: "done".to_string(),
                model: model.clone(),
                plan: false,
                goal: false,
                working_at: None,
                done_at: ms(at),
                turn_started_at: None,
                subagents,
            }),
            _ => {
                if model.is_some() || subagents > 0 {
                    readings.timings.push(AgentTabTiming {
                        tmux_session: tab.tmux_name.clone(),
                        model: model.clone(),
                        plan: false,
                        goal: false,
                        working_at: None,
                        done_at: None,
                        turn_started_at: None,
                        subagents,
                    });
                }
            }
        }
        let prompts = agent_session::agent_session_recent_prompts(&tab.cmd, Some(project_id), uid);
        if !prompts.is_empty() {
            readings.prompts.push(AgentTabPrompts {
                tmux_session: tab.tmux_name.clone(),
                prompts: prompts
                    .into_iter()
                    .map(|prompt| AgentTabPrompt { text: prompt.text, at: Some(prompt.at) })
                    .collect(),
            });
        }
    }
    readings
}

/// `Catalog`'s per-tab schedule summaries for the tabs of `project_id` that
/// carry a binding: total and enabled counts, the soonest next run, and up
/// to three upcoming enabled rules — from the same `schedules` the tab's
/// own sheet reads with no window.
pub fn schedule_summaries(
    state_dir: &Path,
    project_id: &str,
    tabs: &[ResolvedTab],
    now: DateTime<Local>,
) -> Vec<AgentTabSchedules> {
    tabs.iter()
        .filter(|tab| tab.public.kind == "agent")
        .filter_map(|tab| {
            let target = tab.schedule_target_id.as_deref().filter(|id| !id.is_empty())?;
            let listed = schedules(state_dir, project_id, target, now).ok()?;
            if listed.schedules.is_empty() {
                return None;
            }
            let mut upcoming = listed
                .schedules
                .iter()
                .filter_map(|rule| {
                    let at = listed.next_runs.get(&rule.id)?;
                    Some(AgentTabPrompt { text: rule.message.clone(), at: Some(at.clone()) })
                })
                .collect::<Vec<_>>();
            upcoming.sort_by(|a, b| a.at.cmp(&b.at));
            upcoming.truncate(3);
            Some(AgentTabSchedules {
                tmux_session: tab.tmux_name.clone(),
                total: listed.schedules.len() as u32,
                enabled: listed.schedules.iter().filter(|rule| rule.enabled).count() as u32,
                next: listed.next_runs.values().min().cloned(),
                upcoming,
            })
        })
        .collect()
}

/// `Activity` with no window: the readings of every project's agent tabs.
pub fn activity(state_dir: &Path, catalog: &super::discovery::Catalog) -> TurnReadings {
    let mut all = TurnReadings::default();
    for project in &catalog.projects {
        let readings = turn_readings(state_dir, &project.raw_id, &project.tabs);
        all.statuses.extend(readings.statuses);
        all.timings.extend(readings.timings);
        all.prompts.extend(readings.prompts);
    }
    all
}

/// The project pill's git dot, probed here rather than read off the pills:
/// `gitDirtyState`'s ladder (untracked or unstaged ▸ staged ▸ unpushed),
/// none for a clean tree or no repo. Blocking — one hardened git spawn (a
/// clean branch with no upstream pays the namesake lookup too) — so the host
/// runs it off the async thread and caches it.
pub fn git_dot_for(dir: &Path) -> Option<&'static str> {
    let dir = dir.to_string_lossy().into_owned();
    let status = crate::commands::git::git_status_probe(dir.clone(), false).ok()?;
    if !status.is_repo {
        return None;
    }
    if status.untracked > 0 || status.unstaged > 0 {
        return Some("dirty");
    }
    if status.staged > 0 {
        return Some("staged");
    }
    (crate::commands::git::unpushed_count(&status, dir) > 0).then_some("unpushed")
}

/// How long a headless reading stands before it is taken again: the phone
/// polls the project list and screen every few seconds, and each git dot is
/// two git spawns, each turn reading a transcript walk per agent tab.
pub const READING_TTL: Duration = Duration::from_secs(10);

/// The host's cache of the headless readings, per raw project id.
#[derive(Debug, Default)]
pub struct ReadingCache {
    git: HashMap<String, (Instant, Option<&'static str>)>,
    readings: HashMap<String, (Instant, TurnReadings)>,
}

impl ReadingCache {
    /// The cached git dot of `raw_id` while it is fresh.
    pub fn git(&self, raw_id: &str, now: Instant) -> Option<Option<&'static str>> {
        self.git.get(raw_id).filter(|(at, _)| now.duration_since(*at) < READING_TTL).map(|(_, dot)| *dot)
    }

    pub fn set_git(&mut self, raw_id: &str, dot: Option<&'static str>, now: Instant) {
        self.git.insert(raw_id.to_string(), (now, dot));
    }

    /// The project's turn readings, taken now when the cached ones are stale.
    pub fn readings(&mut self, state_dir: &Path, project: &ResolvedProject, now: Instant) -> TurnReadings {
        if let Some((at, readings)) = self.readings.get(&project.raw_id) {
            if now.duration_since(*at) < READING_TTL {
                return readings.clone();
            }
        }
        let readings = turn_readings(state_dir, &project.raw_id, &project.tabs);
        self.readings.insert(project.raw_id.clone(), (now, readings.clone()));
        readings
    }
}

/// The owner's spawn of a tab with no window: `PtyOptions` in, the process
/// running (detached, under the tab's tmux name) or the reason it is not.
pub type HeadlessLaunch =
    Arc<dyn Fn(PtyOptions) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

/// Why a headless create was refused, as the phone's error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateRefusal {
    /// The request needs the window: a sign-in, a cloud session, a worktree,
    /// a local model, a mode, a sign-in like a tab, or the root console.
    DesktopUnavailable,
    UnknownAgent,
    /// The tab would run where no local tmux session carries it (a remote
    /// host, a container, a VM): the phone cannot attach to it.
    NotAttachable,
    /// The assistant service or the scope's gate refused the chat: a fixed
    /// category (`assistant::Refusal::code`, or `assistant_off`), never text a
    /// client sent.
    Assistant(&'static str),
    /// The tab was minted and then taken back out: the spawn failed.
    LaunchFailed(String),
    Persist(String),
}

impl CreateRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DesktopUnavailable => "desktop_unavailable",
            Self::UnknownAgent => "unknown_agent",
            Self::NotAttachable => "not_attachable",
            Self::Assistant(code) => code,
            Self::LaunchFailed(_) => "launch_failed",
            Self::Persist(_) => "persist_failed",
        }
    }
}

/// What a headless create answers: the tab's tmux name — the same answer the
/// desktop's `Created` carries — and whether the request had already been
/// answered (the phone retries a create until it sees the tab).
#[derive(Debug, Clone)]
pub struct HeadlessCreated {
    pub tmux_session: String,
    pub existed: bool,
}

/// A scope's session file under `state_dir`, as `terminal_service` keys it.
pub fn session_file(state_dir: &Path, raw_id: &str) -> std::path::PathBuf {
    state_dir.join("sessions").join(storage::project_key(raw_id)).join("terminals.json")
}

/// Start the tab the owner just minted, detached. A refused or failed launch
/// takes the record back out of the session file, so a tab that never ran is
/// not left for a window to restore.
async fn launch_minted(state_dir: &Path, path: &Path, raw_id: &str, tab: &TabEntry, launch: &HeadlessLaunch) -> Result<(), CreateRefusal> {
    let launched = match launch_options(state_dir, raw_id, tab) {
        Ok(options) => launch(options).await.map_err(CreateRefusal::LaunchFailed),
        Err(NotAttachable) => Err(CreateRefusal::NotAttachable),
    };
    if launched.is_err() {
        let id = crate::services::workspace::tab_id(tab).map(str::to_string);
        let _ = crate::services::workspace::edit_in(path, raw_id, |session| {
            // project-tree-read: ok — the state-dir session file the owner just wrote, keyed by scope id.
            session.tab_layout.retain(|tab| crate::services::workspace::tab_id(tab) != id.as_deref());
            Ok(())
        });
    }
    launched
}

/// The assistant arm of [`create_tab`]: resolve the opaque launch, build the
/// record with `assistant::new_chat_record` (one path for the desktop command
/// and this), append it under the session file's lock and start it detached.
async fn create_chat(
    state_dir: &Path,
    host_key: &[u8],
    project: &ResolvedProject,
    request: &CreateTabRequest,
    choices: &[super::assistant::Choice],
    launch: &HeadlessLaunch,
) -> Result<HeadlessCreated, CreateRefusal> {
    let (Some(handle), true, CreateTabKind::Agent) =
        (request.assistant.as_deref(), project.public.kind == ScopeKind::Assistant, &request.kind)
    else {
        return Err(CreateRefusal::UnknownAgent);
    };
    // The perimeter again, at the point of use: the catalog that listed the
    // scope may be a few seconds old.
    if !super::discovery::assistant_open(state_dir) {
        return Err(CreateRefusal::Assistant("assistant_off"));
    }
    let chosen = super::assistant::resolve(choices, handle).ok_or(CreateRefusal::UnknownAgent)?;
    let request_hash = key_id(host_key, "request", &[&request.idempotency_key]);
    let uid = crate::commands::projects::uuid_v4();
    let record = crate::services::assistant::new_chat_record(state_dir, &chosen, &uid, Some(&request_hash))
        .map_err(|refusal| CreateRefusal::Assistant(refusal.code()))?;
    let path = session_file(state_dir, &project.raw_id);
    let created = crate::services::workspace::create_tab_in(&path, &project.raw_id, record, Some(&request_hash))
        .map_err(CreateRefusal::Persist)?;
    let tmux_session = crate::services::workspace::tmux_of(&created.tab)
        .ok_or_else(|| CreateRefusal::Persist("the owner minted no tmux name".to_string()))?
        .to_string();
    if created.existed {
        return Ok(HeadlessCreated { tmux_session, existed: true });
    }
    launch_minted(state_dir, &path, &project.raw_id, &created.tab, launch).await?;
    Ok(HeadlessCreated { tmux_session, existed: false })
}

/// The tab record a headless create appends — `buildStaticTabSpec`'s shape:
/// a shell is the bare login shell; an agent is its binary with a fresh
/// session uuid as `sessionId`, `<UPPER>_TAB_UID` and, for the CLIs that take
/// one at launch (Claude, Gemini), `--session-id`. The owner mints the id,
/// the tmux name and the schedule binding (`workspace::create_tab_in`); the
/// key is re-minted by every window that loads it.
fn tab_record(kind: &CreateTabKind, agent: Option<&AgentChoice>, cwd: &Path, request_hash: &str) -> TabEntry {
    let mut extra: HashMap<String, serde_json::Value> = HashMap::new();
    let (label, cmd, session_id) = match (kind, agent) {
        (CreateTabKind::Agent, Some(agent)) => {
            let uuid = crate::commands::projects::uuid_v4();
            let args = if matches!(agent.bin, "claude" | "gemini") {
                vec!["--session-id".to_string(), uuid.clone()]
            } else {
                Vec::new()
            };
            extra.insert("kind".into(), json!("agent"));
            extra.insert("args".into(), json!(args));
            extra.insert("env".into(), json!({ crate::app_env!("TAB_UID"): uuid }));
            // The window's `launchedAt`: tells this tab's own OpenCode session
            // from the folder's older ones (`ResolvedTab::since`).
            extra.insert("launchedAt".into(), json!(crate::clock::now_ms() as i64));
            (agent.public.label.clone(), agent.bin.to_string(), Some(uuid))
        }
        _ => {
            extra.insert("kind".into(), json!("shell"));
            extra.insert("args".into(), json!([]));
            extra.insert("env".into(), json!({}));
            ("Shell".to_string(), String::new(), None)
        }
    };
    extra.insert("mobileRequestHash".into(), json!(request_hash));
    TabEntry {
        key: format!("headless-{}", crate::commands::projects::uuid_v4()),
        label,
        cmd,
        cwd: cwd.to_string_lossy().into_owned(),
        session_id,
        extra,
    }
}

/// The size a session started with no window gets. Nobody looks at it at that
/// size, but the phone adopts the window's geometry, and at tmux's default
/// 80×24 a long footer — Claude's status line, which carries the model — was
/// cut off, so the phone showed "Agent is working…" with no model. A window
/// that attaches later resizes it to its own (`tmux_local::window_size_policy`).
const HEADLESS_COLS: u16 = 200;
const HEADLESS_ROWS: u16 = 50;

/// What a headless launch's PTY id starts with: the tab is `headless:<tmux>`,
/// the identity its MCP tokens are registered under in the Mobile host
/// (`docs/headless_mcp_plan.md`), so they can be revoked by tmux name.
pub(super) const LAUNCH_ID_PREFIX: &str = "headless:";

/// The launch of a stored tab record, for the detached spawn: what the
/// window's `TerminalView` hands `pty_spawn`, at a fixed
/// [`HEADLESS_COLS`]×[`HEADLESS_ROWS`]. `project_id` is the raw scope id (a
/// project's or a box's).
///
/// It runs where the window would run the tab, read from the project's record
/// under `state_dir` and the tab's `kind`/`location` (`discovery::launch_place`,
/// the catalog's own table): a remote project's local tab is `local_only` in
/// the mirror (an agent defaults local), while a tab that belongs on the host,
/// in a container or in a VM is `Err(NotAttachable)` — no local tmux session
/// carries it, and spawning it here would put it somewhere the window never
/// would. Every other scope is unchanged.
///
/// The record is read raw, past the load sanitizer, so its `env` goes
/// through the same filter here (`terminal_service::strip_persisted_env`):
/// no loader or control variable from a stored layout reaches the spawn.
pub(super) fn launch_options(state_dir: &Path, project_id: &str, tab: &TabEntry) -> Result<PtyOptions, NotAttachable> {
    options_for(state_dir, project_id, tab, false)
}

/// [`launch_options`] for the restart of a bound agent whose session is gone
/// (the scheduler's): the same, except that a container project's tab is
/// launched as recorded. `launch_prep` re-derives its `sandbox` flag from the
/// project record and `docker exec`s it into the project's container, which is
/// where the window runs it too, so a restart there is right; refusing it (as a
/// phone's create is refused, there being nothing to attach to) would lose a
/// scheduled prompt the base delivered. A tab on a remote host or in a VM stays
/// refused: with no window there is no pool to reach it, and the spawn failed.
pub(super) fn restart_options(state_dir: &Path, project_id: &str, tab: &TabEntry) -> Result<PtyOptions, NotAttachable> {
    options_for(state_dir, project_id, tab, true)
}

fn options_for(state_dir: &Path, project_id: &str, tab: &TabEntry, restart: bool) -> Result<PtyOptions, NotAttachable> {
    // The chat assistant's scope trusts nothing of the record but the validated
    // launch block and the chat's uid: the CLI line, its env and its folder are
    // rebuilt by `launch_prep`'s assistant gate from `PtyOptions.assistant` and
    // `TAB_UID`. This seam serves a create, a reopen, an undo-clear relaunch and
    // the scheduler's relaunch alike, so none of them can feed it `args`/`env`.
    if super::discovery::is_assistant_scope_id(project_id) {
        return Ok(assistant_launch_options(tab));
    }
    let mut filtered = tab.clone();
    crate::services::terminal_service::strip_persisted_env(
        &mut filtered,
        &crate::services::terminal_service::custom_agent_specs(),
    );
    let tab = &filtered;
    let strings = |key: &str| -> Vec<String> {
        tab.extra
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|rows| rows.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let env = tab
        .extra
        .get("env")
        .and_then(serde_json::Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let tmux = crate::services::workspace::tmux_of(tab).unwrap_or_default().to_string();
    let kind = tab.extra.get("kind").and_then(serde_json::Value::as_str);
    // A record with no kind is read as a shell, the kind that defaults remote.
    let location = tab.extra.get("location").and_then(serde_json::Value::as_str);
    let (local_only, cwd) = match super::discovery::launch_place(state_dir, project_id, kind.unwrap_or("shell"), location) {
        super::discovery::LaunchPlace::AsRecorded => (false, tab.cwd.clone()),
        super::discovery::LaunchPlace::InContainer if restart => (false, tab.cwd.clone()),
        super::discovery::LaunchPlace::InContainer => return Err(NotAttachable),
        super::discovery::LaunchPlace::LocalMirror(mirror) => (true, mirror.to_string_lossy().into_owned()),
        super::discovery::LaunchPlace::NotAttachable => return Err(NotAttachable),
    };
    Ok(PtyOptions {
        login: None,
        assistant: None,
        id: format!("{LAUNCH_ID_PREFIX}{tmux}"),
        cmd: tab.cmd.clone(),
        args: strings("args"),
        env,
        cwd,
        cols: HEADLESS_COLS,
        rows: HEADLESS_ROWS,
        local_only,
        sandbox: false,
        agent: kind == Some("agent"),
        project_id: Some(project_id.to_string()),
        schedule_target_id: tab.extra.get("scheduleTargetId").and_then(serde_json::Value::as_str).map(str::to_string),
        remote_host_id: None,
        tmux_session: Some(tmux),
        tmux_attach: None,
        host_bound_uid: None,
        local_model: kind == Some("local_agent"),
        host_session: false,
        // The ＋ menu's login-or-key pick, as the window would pass it.
        api_key: tab.extra.get(crate::services::terminal_service::API_KEY_KEY).and_then(serde_json::Value::as_bool),
    })
}

/// [`launch_options`] found the tab belongs where the phone cannot attach to
/// it (`discovery::LaunchPlace::NotAttachable`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct NotAttachable;

impl std::fmt::Display for NotAttachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("not_attachable: the tab runs on a remote host, in a container or in a VM")
    }
}

/// [`launch_options`] for a chat of the assistant scope. A record without a
/// valid launch (`assistant::record_launch`: strict block, offered profile,
/// good model, matching `cmd`, uuid `sessionId`) gets `assistant: None`, which
/// the spawn gate refuses — a plain shell or agent never starts in this scope.
fn assistant_launch_options(tab: &TabEntry) -> PtyOptions {
    let launch = crate::services::assistant::record_launch(tab);
    let uid = launch.as_ref().and(tab.session_id.clone());
    let tmux = crate::services::workspace::tmux_of(tab).unwrap_or_default().to_string();
    PtyOptions {
        login: None,
        id: format!("{LAUNCH_ID_PREFIX}{tmux}"),
        // The gate rewrites these from the launch; they are only the record's
        // honest values, never `args`/`env` from the file.
        cmd: launch.as_ref().map(|l| l.cli.bin().to_string()).unwrap_or_default(),
        args: Vec::new(),
        env: uid.map(|uid| HashMap::from([(crate::app_env!("TAB_UID").to_string(), uid)])).unwrap_or_default(),
        cwd: tab.cwd.clone(),
        cols: HEADLESS_COLS,
        rows: HEADLESS_ROWS,
        local_only: false,
        sandbox: false,
        agent: true,
        project_id: Some(crate::storage::ASSISTANT_SCOPE.to_string()),
        schedule_target_id: None,
        remote_host_id: None,
        tmux_session: Some(tmux),
        tmux_attach: None,
        host_bound_uid: None,
        local_model: false,
        host_session: false,
        api_key: None,
        assistant: launch,
    }
}

/// `Create` with no window (headless owner plan, H1b): what the window's
/// bridge does for a shell or a plain agent tab, done by the owner — the
/// tab is minted into the scope's session file first (so a window opening
/// meanwhile merges it in rather than overwriting it), then started
/// detached through `launch`; a launch that fails takes the record back out.
/// Everything that needs the window — a sign-in, a cloud session, a
/// worktree, a local model, a mode, an API key, the root console — is refused with
/// `desktop_unavailable`, as before this existed. Idempotent on the
/// request's key, like the desktop's create.
pub async fn create_tab(
    state_dir: &Path,
    host_key: &[u8],
    project: &ResolvedProject,
    request: &CreateTabRequest,
    agents: &[AgentChoice],
    assistant: &[super::assistant::Choice],
    launch: &HeadlessLaunch,
) -> Result<HeadlessCreated, CreateRefusal> {
    // The chat assistant (decision 12): the one scope that may start with no
    // window besides a project or box. Its tab is a chat record built by the
    // assistant service from a launch the phone named by opaque id — the
    // request's `agent_id`, `mode`, `local` and the rest are not read, and
    // `launch_shape_ok` already refused a body that carries them. A plain
    // shell or agent in the scope is refused, and so is a chat anywhere else.
    if project.public.kind == ScopeKind::Assistant || request.assistant.is_some() {
        return create_chat(state_dir, host_key, project, request, assistant, launch).await;
    }
    if request.sign_in.is_some()
        || request.cloud.is_some()
        || request.worktree.is_some()
        || request.local.is_some()
        || request.like_tab.is_some()
        || request.mode.is_some()
        || request.api_key
        || project.public.kind == ScopeKind::Root
    {
        return Err(CreateRefusal::DesktopUnavailable);
    }
    let agent = match request.kind {
        CreateTabKind::Shell => None,
        CreateTabKind::Agent => Some(
            agents
                .iter()
                .find(|choice| request.agent_id.as_deref() == Some(choice.public.id.as_str()))
                .ok_or(CreateRefusal::UnknownAgent)?,
        ),
    };
    let request_hash = key_id(host_key, "request", &[&request.idempotency_key]);
    let mut record = tab_record(&request.kind, agent, &project.root, &request_hash);
    // A remote project's agent runs in the mirror (`project.root`), as the
    // window runs it; said on the record so a later change of the default
    // cannot move it (`discovery::tab_is_local`).
    if project.public.host == super::discovery::ProjectHost::Remote && agent.is_some() {
        record.extra.insert("location".into(), json!("local"));
    }
    let path = session_file(state_dir, &project.raw_id);
    let created = crate::services::workspace::create_tab_in(&path, &project.raw_id, record, Some(&request_hash))
        .map_err(CreateRefusal::Persist)?;
    let tmux_session = crate::services::workspace::tmux_of(&created.tab)
        .ok_or_else(|| CreateRefusal::Persist("the owner minted no tmux name".to_string()))?
        .to_string();
    if created.existed {
        return Ok(HeadlessCreated { tmux_session, existed: true });
    }
    launch_minted(state_dir, &path, &project.raw_id, &created.tab, launch).await?;
    Ok(HeadlessCreated { tmux_session, existed: false })
}

// ── The remaining tab requests (headless owner plan, H3) ────────────────────

/// The scope's owner-closed agent tabs as the catalog's `closed` rows: the
/// opaque id minted at close, the label, the agent and the close stamp.
pub fn closed_tabs(state_dir: &Path, raw_id: &str) -> Vec<super::protocol::ClosedAgentTab> {
    let path = session_file(state_dir, raw_id);
    // project-tree-read: ok — the state-dir session file, keyed by scope id.
    let Ok(session) = storage::read_json::<crate::schema::session::TerminalSession>(&path) else {
        return Vec::new();
    };
    crate::services::workspace::closed_tabs(&session)
        .into_iter()
        .map(|closed| super::protocol::ClosedAgentTab {
            id: closed.id,
            label: closed.tab.label,
            agent: closed.tab.cmd,
            closed_at: closed.closed_at,
        })
        .collect()
}

/// The launch args that bring a resumable agent tab's conversation back — the
/// registry's `Resume` (`commands::agents`, the frontend's `RESUMABLE_AGENTS`).
/// Claude's `--resume <launch id>` is upgraded to the live id by `launch_prep`
/// as at every restart; Codex resolves its own from `<UPPER>_TAB_UID`; the
/// rest continue their latest.
pub(super) fn resume_args(cmd: &str, session_id: &str) -> Vec<String> {
    crate::commands::agents::resume_args_for_bin(cmd, session_id).unwrap_or_default()
}

/// `ReopenTab` with no window: the closed record comes back as a new tab
/// (`workspace::reopen_tab_in` — fresh id and tmux name, same session id)
/// on the resume args a restart would give it, started detached through
/// `launch`; a launch that fails takes it back out, as the create does.
/// `Ok(None)` when the scope has nothing to reopen.
pub async fn reopen_tab(
    state_dir: &Path,
    project: &ResolvedProject,
    closed_id: Option<&str>,
    launch: &HeadlessLaunch,
) -> Result<Option<HeadlessCreated>, CreateRefusal> {
    if project.public.kind == ScopeKind::Root {
        return Err(CreateRefusal::DesktopUnavailable);
    }
    let path = session_file(state_dir, &project.raw_id);
    // Where the closed record would run, asked before the record moves: a tab
    // that belongs on a host, in a container or in a VM stays closed for the
    // window to reopen, rather than being taken out for good by a failed launch.
    // project-tree-read: ok — the state-dir session file, keyed by scope id.
    if let Ok(session) = storage::read_json::<crate::schema::session::TerminalSession>(&path) {
        let closed = crate::services::workspace::closed_tabs(&session);
        let wanted = match closed_id {
            Some(id) => closed.iter().find(|c| c.id == id),
            None => closed.first(),
        };
        if wanted.is_some_and(|c| launch_options(state_dir, &project.raw_id, &c.tab).is_err()) {
            return Err(CreateRefusal::NotAttachable);
        }
    }
    let Some(mut tab) = crate::services::workspace::reopen_tab_in(&path, &project.raw_id, closed_id).map_err(CreateRefusal::Persist)?
    else {
        return Ok(None);
    };
    if let Some(uid) = tab.session_id.as_deref().filter(|id| !id.is_empty()) {
        tab.extra.insert("args".into(), json!(resume_args(&tab.cmd, uid)));
    }
    let tmux_session = crate::services::workspace::tmux_of(&tab)
        .ok_or_else(|| CreateRefusal::Persist("the owner minted no tmux name".to_string()))?
        .to_string();
    launch_minted(state_dir, &path, &project.raw_id, &tab, launch).await?;
    Ok(Some(HeadlessCreated { tmux_session, existed: false }))
}

/// `Activate` of one chat of the assistant's scope with no window: a chat's
/// process (and tmux session) ends with its CLI, and a restored one has none
/// until asked for, so the owner starts the stored chat again, detached, from
/// the record's validated launch (`launch_options`, which `launch_prep`'s gate
/// turns into the pinned line; Claude resumes by its uid). The caller has
/// checked the chat is not running. Refused when the gate is closed, the tab
/// is not one of the scope's chats, or its record no longer validates.
pub async fn start_chat(
    state_dir: &Path,
    project: &ResolvedProject,
    tmux_session: &str,
    launch: &HeadlessLaunch,
) -> Result<(), CreateRefusal> {
    if project.public.kind != ScopeKind::Assistant {
        return Err(CreateRefusal::UnknownAgent);
    }
    if !super::discovery::assistant_open(state_dir) {
        return Err(CreateRefusal::Assistant("assistant_off"));
    }
    let path = session_file(state_dir, &project.raw_id);
    // project-tree-read: ok — the state-dir session file, keyed by scope id.
    let session: crate::schema::session::TerminalSession = storage::read_json(&path).map_err(|e| CreateRefusal::Persist(format!("read session: {e}")))?;
    let record = session
        .tab_layout
        .iter()
        .find(|tab| crate::services::workspace::tmux_of(tab) == Some(tmux_session))
        .ok_or(CreateRefusal::UnknownAgent)?;
    if crate::services::assistant::record_launch(record).is_none() {
        return Err(CreateRefusal::Assistant(crate::services::assistant::Refusal::Config.code()));
    }
    let options = launch_options(state_dir, &project.raw_id, record).map_err(|NotAttachable| CreateRefusal::NotAttachable)?;
    launch(options).await.map_err(CreateRefusal::LaunchFailed)
}

/// `Activate` with no window: the registry entry's `status` becomes
/// `active` under the file's lock (`storage::patch_json`), so the next
/// window restores the project open. Boxes and the root console have no
/// such status.
pub fn activate(state_dir: &Path, raw_id: &str) -> Result<(), String> {
    let path = state_dir.join("projects.json");
    storage::patch_json(&path, Vec::<serde_json::Value>::new(), |list| {
        let entry = list
            .iter_mut()
            .find(|row| row.get("id").and_then(serde_json::Value::as_str) == Some(raw_id))
            .ok_or_else(|| "project_not_found".to_string())?;
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("status".into(), json!("active"));
        }
        Ok(())
    })
    .map(|_| ())
}

/// `TabSeen` with no window: when the phone last had the tab on screen,
/// stamped per session uid at `<state_dir>/mobile-control/seen/<uid>` (epoch
/// seconds). A turn that finished at or before the stamp is not reported
/// `done` again by the headless readings — the desktop's `clearAttention`,
/// remembered on disk since the sidecar answers from files.
pub fn mark_seen(state_dir: &Path, uid: &str, now_secs: u64) {
    if uid.is_empty() || uid.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return;
    }
    let dir = state_dir.join("mobile-control").join("seen");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join(uid), now_secs.to_string());
}

/// `isSessionCommand` (`lib/agents/prompt/chart.ts`): a lone slash command,
/// or `/rename` / `/model` with arguments — the CLI's, not a prompt, and
/// never recorded as one.
pub fn is_session_command(prompt: &str) -> bool {
    let mut words = prompt.split_whitespace();
    let Some(head) = words.next() else {
        return false;
    };
    let head = head.to_ascii_lowercase();
    let shaped = head.len() > 1
        && head.starts_with('/')
        && head[1..].chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | ':' | '-'));
    if !shaped {
        return false;
    }
    words.next().is_none() || matches!(head.as_str(), "/rename" | "/model")
}

/// `TabPrompt` with no window: the phone's composer sent `message` to the
/// tab through the sidecar's own tmux client; the words are recorded on the
/// project's prompt history as delivered, the way the desktop records them
/// (`recordTabPrompt`). A session command is not a prompt and is not
/// recorded. `Ok(false)` when nothing was recorded.
/// `phone`: the paired device that sent it.
pub fn record_prompt(state_dir: &Path, project_id: &str, tab: &ResolvedTab, message: &str, phone: Option<&str>) -> Result<bool, String> {
    let text = message.trim();
    // The chat assistant's scope keeps no prompt history (`agent_prompts`).
    if text.is_empty() || is_session_command(text) || storage::is_assistant_scope(project_id) {
        return Ok(false);
    }
    agent_prompts::record_at(
        state_dir,
        project_id,
        RecordedAgentPromptInput {
            id: crate::commands::projects::uuid_v4(),
            message: text.to_string(),
            created_at: None,
            sent: SentAgentPromptInput {
                schedule_origin: None,
                tab_label: tab.public.label.clone(),
                session_id: tab.session_id.clone(),
                // A tab with no launch id is told apart by its binding
                // (`prompt/adopt.historyTabId`), as the window stamps it.
                tab_id: tab.session_id.is_none().then(|| tab.schedule_target_id.clone()).flatten(),
                preface: Vec::new(),
                agent: Some(tab.cmd.clone()),
                result: Some("delivered".to_string()),
                scheduled_for: None,
                sent_at: None,
                phone_device: phone.map(str::to_string),
                phone_name: None,
            },
        },
    )
    .map(|_| true)
}

/// What a headless undo answered (`undoAgentClear`'s results).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UndoOutcome {
    Undone,
    NothingToUndo,
    /// The tab's session is not there to type into.
    TabNotReady,
}

/// `UndoClear` with no window, given the plan `agent_session::undo_clear_plan`
/// made: Claude's `/resume <id>` is typed into the running session through
/// the tmux runner (the composer reset, the paste, Enter — one submission,
/// never bracketed); a relaunch ends the session and starts the tab again
/// on its resume args, which its record now resolves to the cleared
/// conversation. Blocking on the runner; the caller runs it off-thread.
pub async fn apply_undo_plan(
    state_dir: &Path,
    project: &ResolvedProject,
    tab: &ResolvedTab,
    plan: Option<agent_session::UndoClearPlan>,
    runner: Arc<dyn super::scheduler::Runner>,
    launch: &HeadlessLaunch,
) -> Result<UndoOutcome, String> {
    let Some(plan) = plan else {
        return Ok(UndoOutcome::NothingToUndo);
    };
    let tmux = tab.tmux_name.clone();
    match plan {
        agent_session::UndoClearPlan::Type { command } => {
            let typed = tokio::task::spawn_blocking(move || {
                if runner.probe(&tmux).is_none() {
                    return Ok(false);
                }
                runner.deliver(&tmux, &[super::scheduler::Submission { text: command, bracketed: false }]).map(|()| true)
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(if typed { UndoOutcome::Undone } else { UndoOutcome::TabNotReady })
        }
        agent_session::UndoClearPlan::Relaunch => {
            let path = session_file(state_dir, &project.raw_id);
            // project-tree-read: ok — the state-dir session file, keyed by scope id.
            let session: crate::schema::session::TerminalSession =
                storage::read_json(&path).map_err(|e| format!("read session: {e}"))?;
            let Some(record) = session.tab_layout.iter().find(|t| crate::services::workspace::tmux_of(t) == Some(tab.tmux_name.as_str())).cloned()
            else {
                return Ok(UndoOutcome::TabNotReady);
            };
            let mut record = record;
            if let Some(uid) = record.session_id.as_deref().filter(|id| !id.is_empty()) {
                record.extra.insert("args".into(), json!(resume_args(&record.cmd, uid)));
            }
            // Before the old session is ended: a tab the phone may not launch
            // keeps running.
            let options = launch_options(state_dir, &project.raw_id, &record).map_err(|e| e.to_string())?;
            let ended = tokio::task::spawn_blocking(move || runner.kill(&tmux)).await.map_err(|e| e.to_string())?;
            ended?;
            launch(options).await?;
            Ok(UndoOutcome::Undone)
        }
    }
}

// ── Desktop images with no window ───────────────────────────────────────────

/// `DesktopImages` with no window: the same folders the desktop lists,
/// minus the clipboard (reading it needs a display connection the sidecar
/// has not).
pub fn desktop_images(state_dir: &Path) -> Vec<crate::services::desktop_images::DesktopImage> {
    let folders = crate::services::desktop_images::default_folders(state_dir);
    crate::services::desktop_images::list(&folders, std::time::SystemTime::now())
}

/// `AttachDesktopImage` with no window: copy the listed file into the
/// project's inbox. The `Err` is the wire code the phone maps to a
/// sentence; the clipboard's image needs the window.
pub fn attach_desktop_image(state_dir: &Path, root: &Path, image_id: &str) -> Result<super::protocol::MobileInboxAttachment, String> {
    use crate::services::desktop_images;
    if !desktop_images::valid_id(image_id) {
        return Err("image_not_found".into());
    }
    if image_id == desktop_images::CLIPBOARD_ID {
        return Err("desktop_unavailable".into());
    }
    let path = desktop_images::resolve(&desktop_images::default_folders(state_dir), image_id).ok_or_else(|| "image_not_found".to_string())?;
    let bytes = std::fs::read(&path).map_err(|_| "image_not_found".to_string())?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    super::inbox::store(root, &name, &bytes)
        .map(|stored| super::protocol::MobileInboxAttachment { name: stored.name, reference: stored.reference, size: stored.size })
        .map_err(|error| error.code().to_string())
}

// ── Schedules and prompts with no window ────────────────────────────────────

/// `ScheduleMutate` with no window: the rule lands in `agent_tasks.json`
/// under the file's lock (`upsert_in` / `delete_in`), as the desktop bridge
/// writes it — a create gets a fresh id, an update keeps the stored prefix
/// commands the phone never sees, a delete is plain. Answers the tab's rows
/// as `schedules` does. `Err("schedule_not_found")` for an update of a rule
/// that is gone. `phone` is the paired device asking: a rule it creates or
/// edits carries it (`phone_origin`) — an edit takes a desktop or agent rule
/// over, so revoking that phone cancels it (#2348).
pub fn schedule_mutate(
    state_dir: &Path,
    project_id: &str,
    schedule_target_id: &str,
    action: ScheduleMutation,
    phone: Option<&str>,
    now: DateTime<Local>,
) -> Result<TabSchedules, String> {
    let path = agent_tasks::file_path(state_dir);
    match action {
        ScheduleMutation::Delete { schedule_id } => {
            agent_tasks::delete_in(&path, project_id, schedule_target_id, &schedule_id, false)?;
        }
        ScheduleMutation::Create { schedule } => {
            let prompt = ScheduledAgentPrompt {
                id: crate::commands::projects::uuid_v4(),
                enabled: schedule.enabled,
                message: schedule.message,
                rule: schedule.rule,
                preface: Vec::new(),
                last: None,
                origin: None,
                phone_device: phone.map(str::to_string),
                extra: Default::default(),
            };
            agent_tasks::upsert_in(&path, project_id, schedule_target_id, prompt, None)?;
        }
        ScheduleMutation::Update { schedule_id, schedule } => {
            let existing = agent_tasks::list_at(state_dir, project_id, schedule_target_id)?
                .into_iter()
                .find(|row| row.id == schedule_id)
                .ok_or_else(|| "schedule_not_found".to_string())?;
            let prompt = ScheduledAgentPrompt {
                id: schedule_id,
                enabled: schedule.enabled,
                message: schedule.message,
                rule: schedule.rule,
                preface: existing.preface,
                last: None,
                origin: None,
                phone_device: phone.map(str::to_string),
                extra: Default::default(),
            };
            agent_tasks::upsert_in(&path, project_id, schedule_target_id, prompt, None)?;
        }
    }
    schedules(state_dir, project_id, schedule_target_id, now)
}

/// The agent tab a headless send aims at: its binding and the facts the
/// history row carries.
pub struct SendTarget {
    pub schedule_target_id: String,
    pub label: String,
    pub session_id: Option<String>,
    pub agent: String,
}

/// `PromptMutate` with no window: a collected prompt is created, edited or
/// removed in `agent_prompts.json` under its lock; a send is the desktop's
/// send-now — a one-time rule at this machine's current minute under the
/// prompt's id (finished one-time rules pruned first at the tab's cap, the
/// id re-minted when a recurring rule holds it), then the prompt retired to
/// the history — and the sidecar's own scheduler delivers it at the next
/// idle point. Answers the project's remaining prompts. `phone` is the
/// paired device asking: a prompt it creates or edits carries it, and a
/// send's rule carries the sending phone, else the phone that wrote the
/// prompt (`phone_origin`, #2348).
pub fn prompt_mutate(
    state_dir: &Path,
    project_id: &str,
    action: PromptMutation,
    target: Option<SendTarget>,
    phone: Option<&str>,
    now: DateTime<Local>,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    match action {
        PromptMutation::Delete { prompt_id } => agent_prompts::delete_at(state_dir, project_id, &prompt_id),
        PromptMutation::Create { prompt } => agent_prompts::upsert_at(
            state_dir,
            project_id,
            ProjectAgentPromptInput {
                id: crate::commands::projects::uuid_v4(),
                message: prompt.message,
                tags: None,
                target: None,
                phone_device: phone.map(str::to_string),
            },
        ),
        PromptMutation::Update { prompt_id, prompt } => agent_prompts::upsert_at(
            state_dir,
            project_id,
            ProjectAgentPromptInput { id: prompt_id, message: prompt.message, tags: None, target: None, phone_device: phone.map(str::to_string) },
        ),
        PromptMutation::Send { prompt_id, .. } => {
            let target = target.ok_or_else(|| "tab_not_found".to_string())?;
            let prompt = agent_prompts::list_at(state_dir, project_id)?
                .into_iter()
                .find(|row| row.id == prompt_id)
                .ok_or_else(|| "prompt_not_found".to_string())?;
            let phone = phone.or(prompt.phone_device.as_deref());
            queue_prompt(state_dir, project_id, &target.schedule_target_id, &prompt.message, Some(&prompt.id), phone, now)?;
            agent_prompts::archive_at(
                state_dir,
                project_id,
                &prompt.id,
                SentAgentPromptInput {
                    schedule_origin: None,
                    tab_label: target.label,
                    tab_id: target.session_id.is_none().then(|| target.schedule_target_id.clone()),
                    session_id: target.session_id,
                    preface: Vec::new(),
                    agent: Some(target.agent),
                    result: None,
                    scheduled_for: None,
                    sent_at: None,
                    phone_device: phone.map(str::to_string),
                    phone_name: None,
                },
            )
        }
    }
}

/// `queuePromptForTab`: a one-time rule at this machine's current minute —
/// finished one-time rules pruned first at the tab's cap, `id` re-minted
/// when a recurring rule holds it (or none was given). Returns the rule's id.
/// `phone`: the paired device the prompt came from.
fn queue_prompt(
    state_dir: &Path,
    project_id: &str,
    target_id: &str,
    message: &str,
    id: Option<&str>,
    phone: Option<&str>,
    now: DateTime<Local>,
) -> Result<String, String> {
    let path = agent_tasks::file_path(state_dir);
    let existing = agent_tasks::list_at(state_dir, project_id, target_id)?;
    for pruned in schedules_to_prune_for_send(&existing) {
        agent_tasks::delete_in(&path, project_id, target_id, &pruned, false)?;
    }
    let id = id
        .filter(|id| {
            !existing
                .iter()
                .any(|rule| rule.id == *id && !matches!(rule.rule, AgentScheduleRule::Once { .. }))
        })
        .map_or_else(random_rule_id, |id| Ok(id.to_string()))?;
    let rule = ScheduledAgentPrompt {
        id: id.clone(),
        enabled: true,
        message: message.to_string(),
        rule: AgentScheduleRule::Once { at: now.format("%Y-%m-%dT%H:%M").to_string() },
        preface: Vec::new(),
        last: None,
        origin: None,
        phone_device: phone.map(str::to_string),
        extra: Default::default(),
    };
    agent_tasks::upsert_in(&path, project_id, target_id, rule, None)?;
    Ok(id)
}

/// A rule id the way the window mints one (`crypto.randomUUID`): a random
/// v4 UUID, which the phone's held-prompt route accepts back.
fn random_rule_id() -> Result<String, String> {
    let mut b = super::auth::random_bytes::<16>()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = crate::digest::hex(&b);
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

/// The words of a held prompt, or `invalid_prompt`: a command is the CLI's
/// own and never waits — the phone types those.
fn held_words(message: &str) -> Result<&str, String> {
    let text = message.trim();
    if text.is_empty() || is_session_command(text) {
        return Err("invalid_prompt".into());
    }
    Ok(text)
}

/// `HoldPrompt` with no window (`holdTabPrompt`): the phone sent `message`
/// while the agent worked; it is queued as a send-now rule on the tab's
/// binding, which the caller marks as a phone hold so the scheduler types it
/// at once. Returns the rule's id, which the phone edits it by. The rule
/// carries `phone`, the paired device that held it (`phone_origin`).
pub fn hold_prompt(state_dir: &Path, project_id: &str, tab: &ResolvedTab, message: &str, phone: Option<&str>, now: DateTime<Local>) -> Result<String, String> {
    let target = tab.schedule_target_id.as_deref().filter(|id| !id.is_empty()).ok_or_else(|| "tab_not_found".to_string())?;
    let text = held_words(message)?;
    queue_prompt(state_dir, project_id, target, text, None, phone, now)
}

/// `EditHeldPrompt` with no window (`editHeldTabPrompt`): new words for a
/// held prompt, kept only while its rule still waits. `held_gone` once it is
/// delivered (or is not a waiting one-time rule of this tab), `held_busy`
/// while it is being typed — never re-created, which would send it twice.
/// `phone`, the paired device editing, takes the rule over (#2348): a held
/// prompt the desktop queued then carries that phone, as one it held does.
pub fn edit_held_prompt(
    state_dir: &Path,
    project_id: &str,
    tab: &ResolvedTab,
    held_id: &str,
    message: &str,
    phone: Option<&str>,
) -> Result<(), String> {
    let target = tab.schedule_target_id.as_deref().filter(|id| !id.is_empty()).ok_or_else(|| "tab_not_found".to_string())?;
    let text = held_words(message)?;
    let held = agent_tasks::list_at(state_dir, project_id, target)?
        .into_iter()
        .find(|rule| rule.id == held_id)
        .filter(|rule| matches!(rule.rule, AgentScheduleRule::Once { .. }) && rule.last.is_none())
        .ok_or_else(|| "held_gone".to_string())?;
    let phone_device = phone.map(str::to_string).or(held.phone_device.clone());
    let rule = ScheduledAgentPrompt { message: text.to_string(), phone_device, ..held };
    match agent_tasks::upsert_in(&agent_tasks::file_path(state_dir), project_id, target, rule, Some(target)) {
        Ok(_) => Ok(()),
        Err(code) if code == agent_tasks::SCHEDULE_BUSY_ERROR => Err("held_busy".into()),
        Err(code) if code == agent_tasks::SCHEDULE_GONE_ERROR => Err("held_gone".into()),
        Err(error) => Err(error),
    }
}

/// `schedulesToPruneForSend` (`lib/agents/prompt/send.ts`): at the tab's
/// cap, the oldest finished one-time rules that make room for one more.
fn schedules_to_prune_for_send(schedules: &[ScheduledAgentPrompt]) -> Vec<String> {
    let room = agent_tasks::MAX_SCHEDULES as i64 - schedules.len() as i64;
    if room > 0 {
        return Vec::new();
    }
    let mut finished: Vec<&ScheduledAgentPrompt> = schedules
        .iter()
        .filter(|rule| matches!(rule.rule, AgentScheduleRule::Once { .. }) && rule.last.is_some())
        .collect();
    finished.sort_by(|a, b| {
        let at = |rule: &ScheduledAgentPrompt| rule.last.as_ref().map(|last| last.at.clone()).unwrap_or_default();
        at(a).cmp(&at(b))
    });
    finished.into_iter().take((1 - room) as usize).map(|rule| rule.id.clone()).collect()
}

// ── Agent status with no window ─────────────────────────────────────────────

/// `AgentStatus` with no window: the state off the hooks' turn record (the
/// catalog's reading for the tab), today's tally off `usage_stats.json`
/// (the same UTC day the desktop recap calls today), and no usage panel —
/// reading one runs the agent's CLI, which needs the window's agent home.
pub fn agent_status(state_dir: &Path, project: &ResolvedProject, tab: &ResolvedTab) -> super::protocol::MobileAgentStatus {
    let readings = turn_readings(state_dir, &project.raw_id, std::slice::from_ref(tab));
    let state = readings
        .statuses
        .into_iter()
        .find(|row| row.tmux_session == tab.tmux_name)
        .map(|row| row.status)
        .unwrap_or_else(|| "idle".to_string());
    let stats: crate::schema::usage_stats::UsageStats = storage::read_json(&state_dir.join(crate::schema::usage_stats::STATS_FILE)).unwrap_or_default();
    let day = stats
        .daily_for(&project.raw_id)
        .remove(&chrono::Utc::now().format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    let count = |key: &str| day.get(key).copied().unwrap_or(0);
    super::protocol::MobileAgentStatus {
        state,
        label: tab.public.label.clone(),
        agent: tab.public.agent_label.clone(),
        project: project.public.label.clone(),
        today: super::protocol::MobileAgentTally {
            prompts: count(&format!("agent.prompt.{}", tab.cmd)),
            worked_s: count("agent.worked_s"),
            decisions: count("agent.decision"),
            done: count("agent.done"),
        },
        usage: super::protocol::MobileAgentUsage {
            label: tab.public.agent_label.clone().unwrap_or_else(|| tab.cmd.clone()),
            supported: false,
            raw: None,
            error: Some("desktop_unavailable".to_string()),
            cached: false,
        },
    }
}

fn seen_at(state_dir: &Path, uid: &str) -> Option<u64> {
    if uid.is_empty() || uid.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return None;
    }
    std::fs::read_to_string(state_dir.join("mobile-control").join("seen").join(uid))
        .ok()?
        .trim()
        .parse()
        .ok()
}

// ── Time zone ───────────────────────────────────────────────────────────────

/// `desktopTimeZone` for a process with no `Intl`: the IANA name from `TZ`,
/// `/etc/timezone`, or the `/etc/localtime` link, else `"local"` — the
/// frontend's own fallback.
pub fn local_time_zone() -> String {
    if let Some(zone) = std::env::var("TZ").ok().and_then(|tz| zone_name(&tz)) {
        return zone;
    }
    #[cfg(unix)]
    {
        if let Some(zone) = std::fs::read_to_string("/etc/timezone").ok().and_then(|text| zone_name(text.trim())) {
            return zone;
        }
        if let Some(zone) = std::fs::read_link("/etc/localtime").ok().and_then(|target| zone_from_localtime_target(&target)) {
            return zone;
        }
    }
    "local".to_string()
}

/// An IANA `Area/City` name, or nothing: a POSIX rule string (`CET-1CEST`)
/// or a `:`-prefixed path is not one the phone can show.
fn zone_name(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches(':');
    let ok = !value.is_empty()
        && value.contains('/')
        && !value.starts_with('/')
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+'));
    ok.then(|| value.to_string())
}

/// `…/zoneinfo/Europe/Berlin` → `Europe/Berlin`.
#[cfg(any(unix, test))]
fn zone_from_localtime_target(target: &Path) -> Option<String> {
    let text = target.to_string_lossy();
    let (_, zone) = text.rsplit_once("zoneinfo/")?;
    zone_name(zone)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The phone's turn read is the same agent-written `.turn` record the
    /// watcher reads: a FIFO there reads as nothing, without blocking (gap 29).
    #[cfg(unix)]
    #[test]
    fn a_fifo_turn_record_reads_as_nothing_without_blocking() {
        let state = tempfile::tempdir().unwrap();
        let live = state.path().join("live_sessions");
        std::fs::create_dir_all(&live).unwrap();
        let uid = "turn-fifo-uid";
        std::fs::write(live.join(format!("{uid}{TURN_SUFFIX}")), "working 5").unwrap();
        assert_eq!(turn_record(state.path(), "p", uid), Some((TurnState::Working, Some(5))));
        std::fs::remove_file(live.join(format!("{uid}{TURN_SUFFIX}"))).unwrap();
        crate::services::home_io::mkfifo(&live.join(format!("{uid}{TURN_SUFFIX}")));
        let at = state.path().to_path_buf();
        assert_eq!(crate::services::home_io::within_deadline(move || turn_record(&at, "p", uid)), None);
    }
    use crate::commands::calendar::{create_event_at, create_task_at};
    use crate::schema::calendar::{CalendarEvent, CalendarTask, Freq, Rrule};

    const KEY: [u8; 32] = [7u8; 32];

    fn state_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("state dir")
    }

    #[test]
    fn the_board_is_published_from_the_file_with_the_desktops_ids() {
        let dir = state_dir();
        std::fs::write(
            dir.path().join("projects.json"),
            r#"[{"id":"p1","name":"Thesis","status":"active","position":0,"local_file":"x"},{"id":"broken"}]"#,
        )
        .unwrap();
        let calendar = dir.path().join("calendar.json");
        let late = create_task_at(
            &calendar,
            CalendarTask {
                title: "late".into(),
                due: Some("2026-07-01".into()),
                project_id: "p1".into(),
                subtasks: vec![crate::schema::calendar::Subtask { id: "s1".into(), title: "step".into(), ..Default::default() }],
                ..Default::default()
            },
        )
        .unwrap();
        let done = create_task_at(&calendar, CalendarTask { title: "done".into(), percent: 100, ..Default::default() }).unwrap();

        let board = todo_board(dir.path(), &KEY, "2026-07-08").unwrap();
        let ids: Vec<&str> = board.columns.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["overdue", "today", "doing", "backlog", "done", "archived"], "a fresh file shows the default board");
        assert!(board.columns.iter().find(|c| c.id == "backlog").unwrap().intake);
        assert_eq!(board.projects.len(), 1, "an entry without both strings is not offered");
        assert_eq!(board.projects[0].id, key_id(&KEY, "project", &["p1"]));
        assert_eq!(board.projects[0].name, "Thesis");
        let card = board.tasks.iter().find(|t| t.title == "late").unwrap();
        assert_eq!(card.id, key_id(&KEY, "task", &[&late.id]), "the same opaque id the desktop mints");
        assert_eq!(card.column, "overdue", "routed by today's date");
        assert_eq!(card.project_id.as_deref(), Some(key_id(&KEY, "project", &["p1"]).as_str()));
        assert_eq!(card.subtasks[0].id, key_id(&KEY, "subtask", &["s1"]));
        assert!(!card.id.contains(&late.id), "raw ids never cross");
        let finished = board.tasks.iter().find(|t| t.title == "done").unwrap();
        assert!(finished.done);
        assert_eq!(finished.column, "done");
        assert_eq!(finished.id, key_id(&KEY, "task", &[&done.id]));
        assert_eq!(board.calendars.len(), 1);
    }

    #[test]
    fn a_missing_calendar_file_is_an_empty_board_not_an_error() {
        let dir = state_dir();
        let board = todo_board(dir.path(), &KEY, "2026-07-08").unwrap();
        assert!(board.tasks.is_empty());
        assert_eq!(board.columns.len(), 6);
        assert!(board.projects.is_empty());
    }

    #[test]
    fn the_month_is_expanded_over_visible_calendars_only() {
        let dir = state_dir();
        std::fs::write(dir.path().join("settings.json"), r#"{"calendar_week_start":0}"#).unwrap();
        let calendar = dir.path().join("calendar.json");
        let standup = create_event_at(
            &calendar,
            CalendarEvent {
                title: "standup".into(),
                start: "2026-07-06T09:00".into(),
                end: "2026-07-06T09:15".into(),
                category: "work".into(),
                rrule: Some(Rrule { freq: Freq::Weekly, interval: 1, ..Default::default() }),
                ..Default::default()
            },
        )
        .unwrap();
        let hidden = crate::commands::calendar::create_calendar_at(
            &calendar,
            Calendar { id: String::new(), name: "Hidden".into(), color: "#000".into(), visible: false, readonly: false, rev: 0, extra: Default::default() },
        )
        .unwrap();
        create_event_at(
            &calendar,
            CalendarEvent { title: "secret".into(), calendar_id: hidden.id.clone(), start: "2026-07-10".into(), end: "2026-07-11".into(), all_day: true, ..Default::default() },
        )
        .unwrap();

        let month = calendar_month(dir.path(), &KEY, "2026-07").unwrap();
        assert_eq!(month.week_start, 0, "the desktop's preference");
        assert_eq!(month.month, "2026-07");
        assert!(!month.truncated);
        let titles: Vec<&str> = month.events.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.iter().all(|t| *t == "standup"), "{titles:?}");
        // A Sunday-start six-week grid for July 2026 runs Jun 28 – Aug 8; the
        // series begins Jul 6, so five Mondays fall in it.
        assert_eq!(month.events.len(), 5);
        assert_eq!(month.events[0].start, "2026-07-06T09:00");
        assert_eq!(month.events[0].id, key_id(&KEY, "event", &[&standup.id]));
        assert_eq!(month.events[0].color, "var(--cal-cat-work)");
        assert!(month.events[0].recurring);
        let hidden_row = month.calendars.iter().find(|c| c.name == "Hidden").unwrap();
        assert!(!hidden_row.visible);
        assert_eq!(hidden_row.id, key_id(&KEY, "calendar", &[&hidden.id]));
        assert_eq!(calendar_month(dir.path(), &KEY, "2026-13").unwrap_err(), "invalid_month");
    }

    #[test]
    fn a_capped_month_drops_its_last_days_not_its_timed_events() {
        let dir = state_dir();
        let calendar = dir.path().join("calendar.json");
        // Ten daily all-day series fill more than the cap over six weeks.
        for n in 0..10 {
            create_event_at(
                &calendar,
                CalendarEvent {
                    title: format!("daily {n}"),
                    start: "2026-09-01".into(),
                    end: "2026-09-02".into(),
                    all_day: true,
                    rrule: Some(Rrule { freq: Freq::Daily, interval: 1, ..Default::default() }),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        create_event_at(
            &calendar,
            CalendarEvent { title: "dentist".into(), start: "2026-10-16T08:00".into(), end: "2026-10-16T09:00".into(), ..Default::default() },
        )
        .unwrap();

        let month = calendar_month(dir.path(), &KEY, "2026-10").unwrap();
        assert!(month.truncated);
        assert_eq!(month.events.len(), MOBILE_CALENDAR_EVENTS);
        assert!(month.events.iter().any(|e| e.title == "dentist"), "a mid-month timed event survives the cap");
        let days: Vec<&str> = month.events.iter().map(|e| &e.start[..10]).collect();
        assert!(days.windows(2).all(|w| w[0] <= w[1]), "day by day");
    }

    #[test]
    fn schedules_and_prompts_come_off_their_files_with_next_runs() {
        let dir = state_dir();
        std::fs::write(
            dir.path().join("agent_tasks.json"),
            r#"{"version":1,"projects":{"p1":{"tgt":{"schedules":[
                {"id":"daily","enabled":true,"message":"tick","rule":{"type":"daily","time":"09:00"}},
                {"id":"off","enabled":false,"message":"never","rule":{"type":"daily","time":"09:00"}},
                {"id":"done","enabled":true,"message":"ran","rule":{"type":"once","at":"2026-07-01T09:00"},"last":{"occurrence":"2026-07-01T09:00","result":"delivered","at":"2026-07-01T09:00:00Z"}}
            ]}}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("agent_prompts.json"),
            r#"{"version":1,"projects":{"p1":[{"id":"pr1","message":"write the intro","created_at":"2026-07-01T09:00:00Z","updated_at":"2026-07-01T09:00:00Z"}]}}"#,
        )
        .unwrap();
        let now = Local.with_ymd_and_hms(2026, 7, 8, 10, 0, 0).unwrap();
        let listed = schedules(dir.path(), "p1", "tgt", now).unwrap();
        assert_eq!(listed.schedules.len(), 3);
        assert_eq!(listed.next_runs.get("daily").map(String::as_str), Some("2026-07-09T09:00"));
        assert!(!listed.next_runs.contains_key("off"), "a disabled rule has no next run");
        assert!(!listed.next_runs.contains_key("done"), "a one-time rule that ran has none");
        assert!(!listed.time_zone.is_empty());
        assert!(schedules(dir.path(), "p1", "other", now).unwrap().schedules.is_empty());
        assert_eq!(prompts(dir.path(), "p1").unwrap()[0].message, "write the intro");
        assert!(prompts(dir.path(), "p2").unwrap().is_empty());
        // Nothing was written back.
        assert!(std::fs::read_to_string(dir.path().join("agent_tasks.json")).unwrap().contains("\"never\""));
    }

    #[test]
    fn a_phone_prompt_to_a_tab_without_a_launch_id_is_stamped_with_its_binding() {
        let dir = tempfile::tempdir().unwrap();
        let mut gemini = tab("gemini", None);
        gemini.schedule_target_id = Some("target-gemini".into());
        assert!(record_prompt(dir.path(), "p1", &gemini, "look at the logs", None).unwrap());
        let mut claude = tab("claude", Some("launch-1"));
        claude.schedule_target_id = Some("target-claude".into());
        assert!(record_prompt(dir.path(), "p1", &claude, "run the tests", None).unwrap());
        let file: serde_json::Value = crate::storage::read_json(&agent_prompts::file_path(dir.path())).unwrap();
        let rows = file["history"]["p1"].as_array().unwrap();
        let row = |message: &str| rows.iter().find(|row| row["message"] == message).unwrap().clone();
        // The window's `historyTabId`: the launch id, else the binding.
        assert_eq!(row("look at the logs")["tab_id"], "target-gemini");
        assert_ne!(row("run the tests")["tab_id"], "target-claude");
    }

    /// A phone's prompt names the phone, and the phone's name as it was then:
    /// renaming or unpairing it later leaves the row saying which phone it was.
    #[test]
    fn a_phone_prompt_names_the_phone_that_sent_it() {
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("mobile-control");
        std::fs::create_dir_all(&control).unwrap();
        let devices = control.join("devices.json");
        let phone = |name: &str| serde_json::json!({ "schema": 1, "devices": [
            { "id": "phone-a", "name": name, "public_key": "k", "created_at": 1, "last_seen_at": null }
        ] });
        std::fs::write(&devices, serde_json::to_vec(&phone("Pixel\n 9 ")).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&devices, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let mut claude = tab("claude", Some("launch-1"));
        claude.schedule_target_id = Some("target-claude".into());
        assert!(record_prompt(dir.path(), "p1", &claude, "from the phone", Some("phone-a")).unwrap());
        assert!(record_prompt(dir.path(), "p1", &claude, "from a revoked phone", Some("phone-gone")).unwrap());
        assert!(record_prompt(dir.path(), "p1", &claude, "from the desktop", None).unwrap());
        let file: serde_json::Value = crate::storage::read_json(&agent_prompts::file_path(dir.path())).unwrap();
        let rows = file["history"]["p1"].as_array().unwrap();
        let row = |message: &str| rows.iter().find(|row| row["message"] == message).unwrap().clone();
        assert_eq!(row("from the phone")["phone_device"], "phone-a");
        assert_eq!(row("from the phone")["phone_name"], "Pixel 9", "folded to one line");
        assert_eq!(row("from a revoked phone")["phone_device"], "phone-gone");
        assert!(row("from a revoked phone").get("phone_name").is_none());
        assert!(row("from the desktop").get("phone_device").is_none());
        assert!(row("from the desktop").get("phone_name").is_none());
    }

    #[test]
    fn a_held_phone_prompt_is_a_send_now_rule_edited_only_while_it_waits() {
        let dir = tempfile::tempdir().unwrap();
        let mut gemini = tab("gemini", None);
        assert_eq!(hold_prompt(dir.path(), "p1", &gemini, "go on", None, Local::now()).unwrap_err(), "tab_not_found", "an unbound tab");
        gemini.schedule_target_id = Some("target-gemini".into());
        assert_eq!(hold_prompt(dir.path(), "p1", &gemini, "/clear", None, Local::now()).unwrap_err(), "invalid_prompt");
        assert_eq!(hold_prompt(dir.path(), "p1", &gemini, "   ", None, Local::now()).unwrap_err(), "invalid_prompt");

        let id = hold_prompt(dir.path(), "p1", &gemini, " then the docs ", None, Local::now()).unwrap();
        assert_eq!(id.len(), 36, "a UUID the phone can name back: {id}");
        let rules = agent_tasks::list_at(dir.path(), "p1", "target-gemini").unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, id);
        assert_eq!(rules[0].message, "then the docs");
        assert!(matches!(rules[0].rule, AgentScheduleRule::Once { .. }));

        edit_held_prompt(dir.path(), "p1", &gemini, &id, "then the tests", None).unwrap();
        assert_eq!(agent_tasks::list_at(dir.path(), "p1", "target-gemini").unwrap()[0].message, "then the tests");
        assert_eq!(edit_held_prompt(dir.path(), "p1", &gemini, "nope", "x", None).unwrap_err(), "held_gone");

        // Being typed: busy; delivered: gone — never re-created.
        let path = agent_tasks::file_path(dir.path());
        let key = match &agent_tasks::list_at(dir.path(), "p1", "target-gemini").unwrap()[0].rule {
            AgentScheduleRule::Once { at } => at.clone(),
            _ => unreachable!(),
        };
        assert_eq!(agent_tasks::claim_in(&path, "p1", "target-gemini", &id, &key, Local::now()), Ok(true));
        assert_eq!(edit_held_prompt(dir.path(), "p1", &gemini, &id, "x", None).unwrap_err(), "held_busy");
        agent_tasks::complete_in(&path, "p1", "target-gemini", &id, &key, crate::schema::agent_tasks::AgentScheduleResult::Delivered).unwrap();
        assert_eq!(edit_held_prompt(dir.path(), "p1", &gemini, &id, "x", None).unwrap_err(), "held_gone");
        assert_eq!(agent_tasks::list_at(dir.path(), "p1", "target-gemini").unwrap()[0].message, "then the tests");
    }

    /// Every rule a phone makes with no window names that phone — a held
    /// prompt, a created schedule, a sent collected prompt — and a phone's
    /// edit or update takes a rule over (#2348: what a revoke or narrowing
    /// cancels). An edit that names no phone keeps the stored one.
    #[test]
    fn a_rule_a_phone_makes_with_no_window_names_the_phone() {
        let dir = tempfile::tempdir().unwrap();
        let mut gemini = tab("gemini", None);
        gemini.schedule_target_id = Some("target-gemini".into());
        let phone = Some("phone-1");
        let device = |id: &str| {
            agent_tasks::list_at(dir.path(), "p1", "target-gemini")
                .unwrap()
                .into_iter()
                .find(|rule| rule.id == id)
                .and_then(|rule| rule.phone_device)
        };

        let held = hold_prompt(dir.path(), "p1", &gemini, "then the docs", phone, Local::now()).unwrap();
        assert_eq!(device(&held).as_deref(), phone);
        edit_held_prompt(dir.path(), "p1", &gemini, &held, "then the tests", phone).unwrap();
        assert_eq!(device(&held).as_deref(), phone);
        edit_held_prompt(dir.path(), "p1", &gemini, &held, "then the docs", None).unwrap();
        assert_eq!(device(&held).as_deref(), phone, "an edit naming no phone keeps it");
        // A held prompt the desktop queued, which a phone then rewrites.
        let desk_held = hold_prompt(dir.path(), "p1", &gemini, "desk words", None, Local::now()).unwrap();
        assert_eq!(device(&desk_held), None);
        edit_held_prompt(dir.path(), "p1", &gemini, &desk_held, "phone words", Some("phone-2")).unwrap();
        assert_eq!(device(&desk_held).as_deref(), Some("phone-2"));

        let input = |message: &str| super::super::protocol::MobileScheduleInput {
            enabled: true,
            message: message.into(),
            rule: AgentScheduleRule::Daily { time: "09:00".into() },
        };
        let listed = schedule_mutate(dir.path(), "p1", "target-gemini", ScheduleMutation::Create { schedule: input("daily") }, phone, Local::now()).unwrap();
        let daily = listed.schedules.iter().find(|rule| rule.message == "daily").unwrap().id.clone();
        assert_eq!(device(&daily).as_deref(), phone);
        schedule_mutate(dir.path(), "p1", "target-gemini", ScheduleMutation::Update { schedule_id: daily.clone(), schedule: input("daily, later") }, Some("phone-2"), Local::now()).unwrap();
        assert_eq!(device(&daily).as_deref(), Some("phone-2"), "the editing phone takes it over");
        // A desktop rule a phone updates names that phone too.
        let desk = ScheduledAgentPrompt {
            id: "desk-rule".into(),
            enabled: true,
            message: "nightly".into(),
            rule: AgentScheduleRule::Daily { time: "23:00".into() },
            preface: vec!["/clear".into()],
            last: None,
            origin: None,
            phone_device: None,
            extra: Default::default(),
        };
        agent_tasks::upsert_in(&agent_tasks::file_path(dir.path()), "p1", "target-gemini", desk, None).unwrap();
        schedule_mutate(dir.path(), "p1", "target-gemini", ScheduleMutation::Update { schedule_id: "desk-rule".into(), schedule: input("nightly, phone words") }, phone, Local::now()).unwrap();
        assert_eq!(device("desk-rule").as_deref(), phone);

        agent_prompts::upsert_at(dir.path(), "p1", ProjectAgentPromptInput { id: "collected".into(), message: "sweep the logs".into(), tags: None, target: None, phone_device: None }).unwrap();
        let target = || SendTarget { schedule_target_id: "target-gemini".into(), label: "Gemini".into(), session_id: None, agent: "gemini".into() };
        prompt_mutate(dir.path(), "p1", PromptMutation::Send { prompt_id: "collected".into(), tmux_session: "s".into() }, Some(target()), phone, Local::now()).unwrap();
        assert_eq!(device("collected").as_deref(), phone);

        // A desktop prompt a phone edits, then sent with no phone asking (the
        // sidecar's own send path stands in for the desktop's): the rule
        // names the phone that wrote the words.
        agent_prompts::upsert_at(dir.path(), "p1", ProjectAgentPromptInput { id: "desk-prompt".into(), message: "desk".into(), tags: None, target: None, phone_device: None }).unwrap();
        let edit = super::super::protocol::MobilePromptInput { message: "phone words".into() };
        let listed = prompt_mutate(dir.path(), "p1", PromptMutation::Update { prompt_id: "desk-prompt".into(), prompt: edit }, None, phone, Local::now()).unwrap();
        assert_eq!(listed.iter().find(|row| row.id == "desk-prompt").unwrap().phone_device.as_deref(), phone);
        prompt_mutate(dir.path(), "p1", PromptMutation::Send { prompt_id: "desk-prompt".into(), tmux_session: "s".into() }, Some(target()), None, Local::now()).unwrap();
        assert_eq!(device("desk-prompt").as_deref(), phone);
    }

    use chrono::TimeZone;

    fn tab(cmd: &str, session_id: Option<&str>) -> ResolvedTab {
        ResolvedTab {
            public: super::super::discovery::PublicTab {
                id: "t".into(),
                label: "tab".into(),
                kind: "agent".into(),
                agent_label: None,
                agent_status: None,
                agent_model: None,
                agent_plan: false,
                agent_goal: false,
                agent_subagents: 0,
                working_at: None,
                done_at: None,
                turn_started_at: None,
                schedules: None,
                prompts: Vec::new(),
                available: false,
                viewer_busy: false,
                last_activity: None,
                color: None,
                sign_in: false,
                cloud: false,
                local_model: false,
                worktree: None,
                subagent_worktrees: Vec::new(),
                assistant_launch: None,
                worktree_movable: false,
            },
            tmux_name: concat!(crate::app_slug!(), "-x").into(),
            session_id: session_id.map(str::to_string),
            schedule_target_id: None,
            cmd: cmd.into(),
            // Absolute on each OS: OpenCode's reader takes no relative folder.
            cwd: if cfg!(windows) { r"C:\nowhere" } else { "/nowhere" }.into(),
            since: None,
            local_model: false,
        }
    }

    /// The phone's Mark up starts the agent `default_agent_cmd` names — an id
    /// or a binary, Claude when unset — so exactly that one row is flagged.
    #[test]
    fn the_default_agent_is_flagged() {
        let dir = state_dir();
        let flagged = |dir: &Path| {
            agents(dir, b"k", &|_| true)
                .into_iter()
                .filter(|choice| choice.public.default)
                .map(|choice| choice.bin)
                .collect::<Vec<_>>()
        };
        assert_eq!(flagged(dir.path()), vec!["claude"]);
        std::fs::write(dir.path().join("settings.json"), r#"{"default_agent_cmd":"antigravity"}"#).unwrap();
        assert_eq!(flagged(dir.path()), vec!["agy"]);
        std::fs::write(dir.path().join("settings.json"), r#"{"default_agent_cmd":"codex"}"#).unwrap();
        assert_eq!(flagged(dir.path()), vec!["codex"]);
        std::fs::write(dir.path().join("settings.json"), r#"{"default_agent_cmd":"codex","disabled_agents":["codex"]}"#).unwrap();
        assert!(flagged(dir.path()).is_empty());
    }

    /// A created agent tab carries its launch moment, so its OpenCode reads
    /// a new chat rather than the folder's last session; a shell has none.
    #[test]
    fn a_created_agent_tab_is_stamped_with_its_launch() {
        let agent = AgentChoice {
            public: AgentCatalogEntry { id: "a".into(), label: "OpenCode".into(), modes: Vec::new(), default: false },
            bin: "opencode",
        };
        let before = crate::clock::now_ms() as i64;
        let record = tab_record(&CreateTabKind::Agent, Some(&agent), Path::new("/p"), "h");
        let stamped = record.extra.get("launchedAt").and_then(serde_json::Value::as_i64).expect("stamped");
        assert!(stamped >= before && stamped <= crate::clock::now_ms() as i64);
        let shell = tab_record(&CreateTabKind::Shell, None, Path::new("/p"), "h");
        assert!(!shell.extra.contains_key("launchedAt"));
    }

    /// A local-model tab started with no window gets the scope's local-model
    /// home, as the window's spawn does; any other tab the scope's own.
    #[test]
    fn a_local_model_record_launches_into_the_local_model_home() {
        let state = state_dir();
        let mut record = tab_record(&CreateTabKind::Shell, None, Path::new("/p"), "h");
        assert!(!launch_options(state.path(), "p1", &record).unwrap().local_model);
        record.extra.insert("kind".into(), serde_json::json!("local_agent"));
        let opts = launch_options(state.path(), "p1", &record).unwrap();
        assert!(opts.local_model);
        assert!(!opts.agent, "the fence knows a local-model driver by its command");
    }

    /// The owner reads a stored record raw, past the load sanitizer: a
    /// loader or control variable in its `env` never reaches the spawn
    /// (gap 17), while the tab's own `TAB_UID` and `VIBE_HOME` do.
    #[test]
    fn a_stored_records_env_is_filtered_before_launch() {
        let state = state_dir();
        let mut record = tab_record(&CreateTabKind::Shell, None, Path::new("/p"), "h");
        let mut env = serde_json::Map::new();
        for (k, v) in [
            ("PATH", "/tmp/evil"),
            ("LD_PRELOAD", "/tmp/x.so"),
            ("BASH_ENV", "/tmp/rc"),
            (crate::app_env!("HOST_SESSION"), "1"),
            (crate::app_env!("AGENT_FENCE"), "1"),
            (crate::app_env!("TAB_UID"), "uid-1"),
            ("VIBE_HOME", "/home/u/.vibe-local"),
        ] {
            env.insert(k.into(), serde_json::json!(v));
        }
        record.extra.insert("env".into(), serde_json::Value::Object(env));
        let opts = launch_options(state.path(), "p1", &record).unwrap();
        let mut keys: Vec<&str> = opts.env.keys().map(String::as_str).collect();
        keys.sort();
        let mut want = [crate::app_env!("TAB_UID"), "VIBE_HOME"];
        want.sort();
        assert_eq!(keys, want);
        // The stored record itself is not rewritten.
        assert!(record.extra["env"].get("PATH").is_some());
    }

    const CHAT: &str = "0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10";

    fn chat_record(state: &Path, launch: &crate::services::assistant::AssistantLaunch) -> TabEntry {
        let mut record = crate::services::assistant::new_chat_record(state, launch, CHAT, Some("h")).expect("chat record");
        record.extra.insert("tmuxSession".into(), serde_json::json!(format!("{}assistant--agent-1", crate::brand::TMUX_PREFIX)));
        record
    }

    /// `launch_options` is the one seam a create, a reopen, an undo-clear
    /// relaunch and the scheduler's relaunch share. For the assistant's scope
    /// it takes the validated launch block and the chat's uid from the record
    /// and nothing else: a hand-edited `args`, `env`, `scheduleTargetId`,
    /// `sandbox` or `localLaunch` never reaches the spawn, and a record that is
    /// not a chat comes out with no launch, which the spawn gate refuses.
    #[test]
    fn an_assistant_record_is_launched_from_its_block_and_uid_alone() {
        use crate::services::assistant::{AssistantCli, AssistantLaunch};
        let state = tempfile::tempdir().expect("state");
        let launch = AssistantLaunch { cli: AssistantCli::OpenCodeLocal, model: Some("qwen3:8b".into()) };
        let mut record = chat_record(state.path(), &launch);
        record.extra.insert("args".into(), serde_json::json!(["--dangerously-skip-permissions", "--session-id", "other"]));
        record.extra.insert("env".into(), serde_json::json!({ "LD_PRELOAD": "/tmp/x.so", "PATH": "/tmp/evil", crate::app_env!("TAB_UID"): "other" }));
        record.extra.insert("scheduleTargetId".into(), serde_json::json!("target-1"));
        record.extra.insert("sandbox".into(), serde_json::json!(true));
        record.extra.insert("localLaunch".into(), serde_json::json!({ "driver": "claude", "model": "m", "args": [] }));
        record.extra.insert("loginTab".into(), serde_json::json!(true));
        let tmux = format!("{}assistant--agent-1", crate::brand::TMUX_PREFIX);
        // Every spelling of the scope id is the scope.
        for scope in ["assistant", "Assistant", " assistant"] {
            let opts = launch_options(state.path(), scope, &record).unwrap();
            assert_eq!(opts.assistant.as_ref(), Some(&launch), "{scope}");
            assert_eq!(opts.project_id.as_deref(), Some("assistant"), "{scope}");
            assert_eq!(opts.cmd, "opencode");
            assert!(opts.args.is_empty());
            assert_eq!(opts.env, HashMap::from([(crate::app_env!("TAB_UID").to_string(), CHAT.to_string())]));
            assert!(opts.agent && !opts.local_model && !opts.sandbox && !opts.host_session);
            assert!(opts.schedule_target_id.is_none() && opts.login.is_none() && opts.tmux_attach.is_none() && opts.host_bound_uid.is_none());
            assert_eq!(opts.tmux_session.as_deref(), Some(tmux.as_str()));
        }
        // Not a chat: a bad block, another cmd, a session id that is no uuid.
        let launched = |edit: &dyn Fn(&mut TabEntry)| {
            let mut bad = chat_record(state.path(), &launch);
            edit(&mut bad);
            launch_options(state.path(), "assistant", &bad).unwrap()
        };
        assert!(launched(&|t| { t.extra.insert("assistant".into(), serde_json::json!({ "cli": "claude", "args": ["-x"] })); }).assistant.is_none());
        assert!(launched(&|t| { t.extra.insert("assistant".into(), serde_json::json!({ "cli": "opencode_local", "model": "--evil" })); }).assistant.is_none());
        assert!(launched(&|t| t.cmd = "bash".into()).assistant.is_none());
        assert!(launched(&|t| t.session_id = Some("../../x".into())).assistant.is_none());
        assert!(launched(&|t| { t.extra.remove("assistant"); }).assistant.is_none());
        let opts = launched(&|t| { t.extra.remove("assistant"); t.extra.insert("args".into(), serde_json::json!(["--x"])); });
        assert!(opts.assistant.is_none() && opts.args.is_empty() && opts.env.is_empty());
        // Any other scope still reads its record as before.
        assert!(launch_options(state.path(), "p1", &record).unwrap().assistant.is_none());
        assert_eq!(launch_options(state.path(), "p1", &record).unwrap().args, vec!["--dangerously-skip-permissions", "--session-id", "other"]);
    }

    /// A closed chat comes back through the same seam: the owner puts resume
    /// args on a reopened record (`resume_args`), and the spawn never sees them.
    #[tokio::test]
    async fn a_reopened_chat_is_launched_without_the_resume_args() {
        use crate::services::assistant::{AssistantCli, AssistantLaunch};
        let state = tempfile::tempdir().expect("state");
        let launch = AssistantLaunch { cli: AssistantCli::Claude, model: None };
        let path = session_file(state.path(), "assistant");
        let created = crate::services::workspace::create_tab_in(&path, "assistant", chat_record(state.path(), &launch), Some("h")).expect("create");
        let tmux = crate::services::workspace::tmux_of(&created.tab).expect("tmux").to_string();
        crate::services::workspace::close_tab_in(&path, "assistant", &tmux, 1).expect("close");
        let chat_folder = crate::services::assistant::chat_dir(state.path(), CHAT).expect("folder");
        std::fs::create_dir_all(&chat_folder).expect("chat folder");
        let project = ResolvedProject {
            public: super::super::discovery::PublicProject {
                id: "a".into(),
                label: "Tabby".into(),
                status: "active".into(),
                kind: ScopeKind::Assistant,
                host: super::super::discovery::ProjectHost::Local,
                live_sessions: 0,
                last_activity: None,
                pending_reviews: None,
                git: None,
                agents: None,
            },
            raw_id: "assistant".into(),
            root: state.path().to_path_buf(),
            roots: vec![state.path().to_path_buf()],
            tabs: Vec::new(),
            devices: None,
            host: super::super::discovery::ProjectHost::Local,
            folder: false,
            create: super::super::discovery::CreateVerdict::All,
        };
        let seen: Arc<std::sync::Mutex<Vec<PtyOptions>>> = Arc::default();
        let sink = seen.clone();
        let launcher: HeadlessLaunch = Arc::new(move |opts| {
            sink.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        });
        let reopened = reopen_tab(state.path(), &project, None, &launcher).await.expect("reopen").expect("a closed tab");
        assert!(!reopened.existed);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].assistant.as_ref(), Some(&launch));
        assert!(seen[0].args.is_empty(), "{:?}", seen[0].args);
        assert_eq!(seen[0].env.get(crate::app_env!("TAB_UID")).map(String::as_str), Some(CHAT));
    }

    // ── Where a phone's launch runs (plan step 3) ───────────────────────

    use super::super::discovery::{CreateVerdict, ProjectHost};

    /// A `projects.json` with one project of each host type: `local1`, `remote1`
    /// (default mirror), `remote2` (a chosen mirror), `box1` (a container whose
    /// spec scope is `all`), `box2` (scope `agents`), `vm1`.
    fn write_projects(state: &Path) -> std::path::PathBuf {
        let chosen = state.join("chosen-mirror");
        let rows = json!([
            { "id": "local1", "name": "L", "status": "active", "directory": state.join("local1") },
            { "id": "remote1", "name": "R", "status": "active", "directory": state.join("remote-projects").join("remote1"),
              "remote": { "host": "example.invalid" } },
            { "id": "remote2", "name": "R2", "status": "active", "directory": state.join("remote-projects").join("remote2"),
              "remote": { "host": "example.invalid" }, "mirror": chosen },
            { "id": "box1", "name": "C", "status": "active", "directory": state.join("box1"),
              "sandbox": { "enabled": true, "scope": "all" } },
            { "id": "box2", "name": "C2", "status": "active", "directory": state.join("box2"),
              "sandbox": { "enabled": true, "scope": "agents" } },
            { "id": "vm1", "name": "V", "status": "active", "directory": state.join("vm1"),
              "remote": { "host": "example.invalid" }, "vm": { "enabled": true } },
        ]);
        std::fs::write(state.join("projects.json"), rows.to_string()).unwrap();
        chosen
    }

    /// A stored tab as the window saves it: `kind`, an optional `location`.
    fn stored(kind: &str, location: Option<&str>, cwd: &Path) -> TabEntry {
        let mut record = tab_record(&CreateTabKind::Shell, None, cwd, "h");
        record.cmd = if kind == "shell" { String::new() } else { "claude".to_string() };
        record.extra.insert("kind".into(), json!(kind));
        if let Some(location) = location {
            record.extra.insert("location".into(), json!(location));
        }
        record.extra.insert("tmuxSession".into(), json!(format!("{}p--t", crate::brand::TMUX_PREFIX)));
        record
    }

    fn placed(state: &Path, scope: &str, kind: &str, location: Option<&str>, cwd: &Path) -> Result<PtyOptions, NotAttachable> {
        launch_options(state, scope, &stored(kind, location, cwd))
    }

    /// A phone launch runs where the window would run the tab. A remote
    /// project's agent defaults local: `local_only`, cwd the mirror (the
    /// default one, or the record's chosen `mirror`) even for a tab the window
    /// saved with the state-dir `directory`; a stored `remote` / `host:<id>`
    /// agent and a shell with no location are not started; a shell the user put
    /// on this machine is.
    #[test]
    fn a_remote_projects_local_tab_launches_local_only_in_the_mirror() {
        let state = state_dir();
        let chosen = write_projects(state.path());
        let directory = state.path().join("remote-projects").join("remote1");
        let default_mirror = crate::services::remote_sync::default_mirror_dir_in(state.path(), "remote1");
        for location in [None, Some("local")] {
            let opts = placed(state.path(), "remote1", "agent", location, &directory).unwrap();
            assert!(opts.local_only, "{location:?}");
            assert_eq!(Path::new(&opts.cwd), default_mirror, "{location:?}");
            assert_eq!(opts.project_id.as_deref(), Some("remote1"));
            assert!(opts.agent);
        }
        let opts = placed(state.path(), "remote2", "agent", None, &directory).unwrap();
        assert!(opts.local_only);
        assert_eq!(Path::new(&opts.cwd), chosen);
        // A local-model agent is local whatever the record says.
        assert!(placed(state.path(), "remote1", "local_agent", Some("remote"), &directory).unwrap().local_only);
        assert!(placed(state.path(), "remote1", "shell", Some("local"), &directory).unwrap().local_only);
        for (kind, location) in [("agent", Some("remote")), ("agent", Some("host:w1")), ("agent", Some("bogus")), ("shell", None), ("shell", Some("remote"))] {
            assert_eq!(placed(state.path(), "remote1", kind, location, &directory).unwrap_err(), NotAttachable, "{kind} {location:?}");
        }
    }

    /// A container project's agent runs in the container, and so does its shell
    /// while the spec's scope is `all`; with scope `agents` the shell is on the
    /// host and launches as it does today. A VM project's tabs never run on the
    /// host. A local project, a box and an unknown scope are untouched.
    #[test]
    fn container_and_vm_tabs_are_refused_and_other_scopes_are_unchanged() {
        let state = state_dir();
        write_projects(state.path());
        let cwd = state.path().join("box1");
        assert!(placed(state.path(), "box1", "agent", None, &cwd).is_err());
        assert!(placed(state.path(), "box2", "agent", Some("local"), &cwd).is_err());
        assert!(placed(state.path(), "box1", "shell", None, &cwd).is_err());
        let host_shell = placed(state.path(), "box2", "shell", None, &cwd).unwrap();
        assert!(!host_shell.local_only && host_shell.cwd == cwd.to_string_lossy());
        for (kind, location) in [("agent", None), ("agent", Some("local")), ("shell", None), ("local_agent", None)] {
            assert!(placed(state.path(), "vm1", kind, location, &cwd).is_err(), "{kind} {location:?}");
        }
        // A restart (the scheduler's) differs only for a container: launched as
        // recorded, `launch_prep` puts it in the container as it always did. A
        // remote host's and a VM's tabs stay refused.
        for (scope, kind, location) in [("box1", "agent", None), ("box2", "agent", Some("local")), ("box1", "shell", None)] {
            let record = stored(kind, location, &cwd);
            let opts = restart_options(state.path(), scope, &record).unwrap();
            assert!(!opts.local_only && !opts.sandbox, "{scope} {kind}");
            assert_eq!(opts.cwd, record.cwd, "{scope} {kind}");
            assert_eq!(opts.project_id.as_deref(), Some(scope));
        }
        assert!(restart_options(state.path(), "vm1", &stored("agent", None, &cwd)).is_err());
        assert!(restart_options(state.path(), "vm1", &stored("local_agent", None, &cwd)).is_err());
        let directory = state.path().join("remote-projects").join("remote1");
        assert!(restart_options(state.path(), "remote1", &stored("agent", Some("host:w1"), &directory)).is_err());
        assert!(restart_options(state.path(), "remote1", &stored("agent", None, &directory)).unwrap().local_only);
        // Local, box, root, an id nobody knows and no projects.json at all.
        let none = state_dir();
        for (dir, scope) in [(state.path(), "local1"), (state.path(), "box:b1"), (state.path(), "root"), (state.path(), "nobody"), (none.path(), "local1")] {
            let record = stored("agent", Some("remote"), &cwd);
            let opts = launch_options(dir, scope, &record).unwrap();
            assert!(!opts.local_only && !opts.sandbox, "{scope}");
            assert_eq!(opts.cwd, record.cwd, "{scope}");
            assert_eq!(opts.project_id.as_deref(), Some(scope));
        }
        // A projects.json that cannot be read is not guessed at.
        std::fs::write(state.path().join("projects.json"), "{").unwrap();
        assert!(placed(state.path(), "local1", "agent", None, &cwd).is_err());
        // ... but the root console and a box are no project record: a file the
        // catalog cannot read does not stop their restart, as before.
        for scope in ["root", "box:b1"] {
            let opts = restart_options(state.path(), scope, &stored("agent", None, &cwd)).unwrap();
            assert!(!opts.local_only && opts.cwd == cwd.to_string_lossy(), "{scope}");
        }
    }

    fn scope_of(host: ProjectHost, raw_id: &str, root: &Path, create: CreateVerdict) -> ResolvedProject {
        ResolvedProject {
            public: super::super::discovery::PublicProject {
                id: "pub".into(),
                label: "P".into(),
                status: "active".into(),
                kind: ScopeKind::Project,
                host,
                live_sessions: 0,
                last_activity: None,
                pending_reviews: None,
                git: None,
                agents: None,
            },
            raw_id: raw_id.into(),
            root: root.to_path_buf(),
            roots: vec![root.to_path_buf()],
            tabs: Vec::new(),
            devices: None,
            host,
            folder: true,
            create,
        }
    }

    fn recording_launcher() -> (HeadlessLaunch, Arc<std::sync::Mutex<Vec<PtyOptions>>>) {
        let seen: Arc<std::sync::Mutex<Vec<PtyOptions>>> = Arc::default();
        let sink = seen.clone();
        let launcher: HeadlessLaunch = Arc::new(move |opts| {
            sink.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        });
        (launcher, seen)
    }

    fn claude_choice() -> AgentChoice {
        AgentChoice { public: AgentCatalogEntry { id: "claude".into(), label: "Claude".into(), modes: Vec::new(), default: false }, bin: "claude" }
    }

    fn agent_request(scope: &str) -> CreateTabRequest {
        serde_json::from_value(json!({ "project_id": scope, "kind": "agent", "agent_id": "claude", "idempotency_key": "0123456789abcdef" }))
            .expect("create request")
    }

    /// A phone-made agent of a remote project is saved with `location: "local"`
    /// and its cwd the mirror, and launched `local_only` there — not sent to the
    /// host, as `local_only: false` did.
    #[tokio::test]
    async fn a_phone_made_agent_of_a_remote_project_launches_in_the_mirror() {
        let state = state_dir();
        write_projects(state.path());
        let mirror = crate::services::remote_sync::default_mirror_dir_in(state.path(), "remote1");
        let project = scope_of(ProjectHost::Remote, "remote1", &mirror, CreateVerdict::Agents);
        let (launcher, seen) = recording_launcher();
        let created = create_tab(state.path(), b"k", &project, &agent_request("remote1"), &[claude_choice()], &[], &launcher).await.expect("create");
        assert!(!created.existed);
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert!(seen[0].local_only && seen[0].agent);
            assert_eq!(Path::new(&seen[0].cwd), mirror);
            assert_eq!(seen[0].project_id.as_deref(), Some("remote1"));
        }
        let session: crate::schema::session::TerminalSession = storage::read_json(&session_file(state.path(), "remote1")).unwrap();
        // project-tree-read: ok — the state-dir session file a test just wrote, keyed by scope id.
        assert_eq!(session.tab_layout.len(), 1);
        // project-tree-read: ok — the state-dir session file a test just wrote, keyed by scope id.
        assert_eq!(session.tab_layout[0].extra.get("location"), Some(&json!("local")));
        // project-tree-read: ok — the state-dir session file a test just wrote, keyed by scope id.
        assert_eq!(Path::new(&session.tab_layout[0].cwd), mirror);
        // A local project's agent is stamped with nothing and launches as before.
        let root = state.path().join("local1");
        let local = scope_of(ProjectHost::Local, "local1", &root, CreateVerdict::All);
        let request = agent_request("local1");
        create_tab(state.path(), b"k", &local, &request, &[claude_choice()], &[], &launcher).await.expect("create");
        let seen = seen.lock().unwrap();
        assert!(!seen[1].local_only);
        assert_eq!(Path::new(&seen[1].cwd), root);
        let session: crate::schema::session::TerminalSession = storage::read_json(&session_file(state.path(), "local1")).unwrap();
        // project-tree-read: ok — the state-dir session file a test just wrote, keyed by scope id.
        assert!(!session.tab_layout[0].extra.contains_key("location"));
    }

    /// A create the launch seam refuses is taken back out of the session file.
    #[tokio::test]
    async fn a_create_in_a_container_project_is_refused_and_leaves_no_tab() {
        let state = state_dir();
        write_projects(state.path());
        let project = scope_of(ProjectHost::Container, "box1", &state.path().join("box1"), CreateVerdict::None);
        let (launcher, seen) = recording_launcher();
        let refused = create_tab(state.path(), b"k", &project, &agent_request("box1"), &[claude_choice()], &[], &launcher).await.unwrap_err();
        assert_eq!(refused, CreateRefusal::NotAttachable);
        assert_eq!(refused.code(), "not_attachable");
        assert!(seen.lock().unwrap().is_empty(), "nothing was spawned");
        let session: crate::schema::session::TerminalSession = storage::read_json(&session_file(state.path(), "box1")).unwrap();
        // project-tree-read: ok — the state-dir session file a test just wrote, keyed by scope id.
        assert!(session.tab_layout.is_empty());
    }

    /// A reopen is checked before the closed record moves: a host-side agent
    /// stays closed (for the window to reopen), a local one comes back in the
    /// mirror.
    #[tokio::test]
    async fn a_reopen_follows_the_same_locality_and_leaves_a_refused_record_closed() {
        let state = state_dir();
        write_projects(state.path());
        let mirror = crate::services::remote_sync::default_mirror_dir_in(state.path(), "remote1");
        let project = scope_of(ProjectHost::Remote, "remote1", &mirror, CreateVerdict::Agents);
        let path = session_file(state.path(), "remote1");
        let directory = state.path().join("remote-projects").join("remote1");
        let close = |location: &str, tmux: &str| {
            let mut record = stored("agent", Some(location), &directory);
            record.extra.insert("tmuxSession".into(), json!(tmux));
            let created = crate::services::workspace::create_tab_in(&path, "remote1", record, Some(tmux)).expect("create");
            let tmux = crate::services::workspace::tmux_of(&created.tab).expect("tmux").to_string();
            crate::services::workspace::close_tab_in(&path, "remote1", &tmux, 1).expect("close");
        };
        close("local", "t-local");
        close("host:w1", "t-host");
        let (launcher, seen) = recording_launcher();
        // Newest first: the host-side one is refused and stays closed.
        assert_eq!(reopen_tab(state.path(), &project, None, &launcher).await.unwrap_err(), CreateRefusal::NotAttachable);
        assert!(seen.lock().unwrap().is_empty());
        let session: crate::schema::session::TerminalSession = storage::read_json(&path).unwrap();
        // project-tree-read: ok — the state-dir session file a test just wrote, keyed by scope id.
        assert!(session.tab_layout.is_empty());
        assert_eq!(crate::services::workspace::closed_tabs(&session).len(), 2);
        let local_id = crate::services::workspace::closed_tabs(&session).into_iter().find(|c| c.tab.extra.get("location") == Some(&json!("local"))).unwrap().id;
        reopen_tab(state.path(), &project, Some(&local_id), &launcher).await.expect("reopen").expect("a closed tab");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].local_only);
        assert_eq!(Path::new(&seen[0].cwd), mirror);
    }

    struct CountingRunner(std::sync::atomic::AtomicUsize);

    impl super::super::scheduler::Runner for CountingRunner {
        fn probe(&self, _tmux: &str) -> Option<super::super::scheduler::SessionProbe> {
            None
        }
        fn deliver(&self, _tmux: &str, _submissions: &[super::super::scheduler::Submission]) -> Result<(), String> {
            Ok(())
        }
        fn kill(&self, _tmux: &str) -> Result<(), String> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    /// An undo-clear relaunch of a tab the phone may not launch ends nothing:
    /// the running session is not killed first.
    #[tokio::test]
    async fn an_undo_relaunch_of_a_host_side_tab_kills_nothing() {
        let state = state_dir();
        write_projects(state.path());
        let mirror = crate::services::remote_sync::default_mirror_dir_in(state.path(), "remote1");
        let project = scope_of(ProjectHost::Remote, "remote1", &mirror, CreateVerdict::Agents);
        let path = session_file(state.path(), "remote1");
        let mut record = stored("agent", Some("host:w1"), &mirror);
        record.session_id = Some("11111111-2222-4333-8444-555555555555".into());
        let created = crate::services::workspace::create_tab_in(&path, "remote1", record, Some("h")).expect("create");
        let tmux = crate::services::workspace::tmux_of(&created.tab).unwrap().to_string();
        let mut resolved = tab("claude", record_session(&created.tab));
        resolved.tmux_name = tmux;
        let runner = Arc::new(CountingRunner(std::sync::atomic::AtomicUsize::new(0)));
        let (launcher, seen) = recording_launcher();
        let plan = Some(agent_session::UndoClearPlan::Relaunch);
        let refused = apply_undo_plan(state.path(), &project, &resolved, plan, runner.clone(), &launcher).await.unwrap_err();
        assert!(refused.starts_with("not_attachable"), "{refused}");
        assert_eq!(runner.0.load(std::sync::atomic::Ordering::SeqCst), 0, "the running session is left alone");
        assert!(seen.lock().unwrap().is_empty());
        // The same tab on this machine is killed and started again, in the mirror.
        crate::services::workspace::edit_in(&path, "remote1", |session| {
            // project-tree-read: ok — the state-dir session file a test just wrote, keyed by scope id.
            session.tab_layout[0].extra.insert("location".into(), json!("local"));
            Ok(())
        })
        .unwrap();
        let plan = Some(agent_session::UndoClearPlan::Relaunch);
        assert_eq!(apply_undo_plan(state.path(), &project, &resolved, plan, runner.clone(), &launcher).await.unwrap(), UndoOutcome::Undone);
        assert_eq!(runner.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        let seen = seen.lock().unwrap();
        assert!(seen[0].local_only);
        assert_eq!(Path::new(&seen[0].cwd), mirror);
    }

    fn record_session(tab: &TabEntry) -> Option<&str> {
        tab.session_id.as_deref()
    }

    #[test]
    fn a_transcript_answers_the_same_not_yet_reasons_as_the_window() {
        assert_eq!(transcript("p1", &tab("claude", None), None, None, None).reason.as_deref(), Some("no_session"));
        assert_eq!(transcript("p1", &tab("bash", None), None, None, None).reason.as_deref(), Some("unsupported"));
        // OpenCode is read by folder, so a tab without a session id (a
        // local-model one) still reaches the reader instead of waiting on one.
        assert_ne!(transcript("p1", &tab("opencode", None), None, None, None).reason.as_deref(), Some("no_session"));
        for cmd in ["gemini", "agy"] {
            let read = transcript("p1", &tab(cmd, None), None, None, None);
            assert_ne!(read.reason.as_deref(), Some("no_session"));
            assert_ne!(read.reason.as_deref(), Some("unsupported"));
        }
        let mut local = tab("opencode", None);
        local.local_model = true;
        assert_ne!(transcript("p1", &local, None, None, None).reason.as_deref(), Some("no_session"));
        let unread = transcript("p1", &tab("claude", Some("no-such-session")), None, None, Some(5));
        assert!(!unread.available);
        assert!(unread.reason.is_some());
    }

    #[test]
    fn time_zone_names_are_iana_or_local() {
        assert_eq!(zone_name("Europe/Berlin").as_deref(), Some("Europe/Berlin"));
        assert_eq!(zone_name(":America/New_York").as_deref(), Some("America/New_York"));
        assert_eq!(zone_name("CET-1CEST,M3.5.0,M10.5.0/3"), None, "a POSIX rule is not a name");
        assert_eq!(zone_name("/etc/x"), None);
        assert_eq!(zone_from_localtime_target(Path::new("/usr/share/zoneinfo/Europe/Berlin")).as_deref(), Some("Europe/Berlin"));
        assert_eq!(zone_from_localtime_target(Path::new("../usr/share/zoneinfo/Etc/UTC")).as_deref(), Some("Etc/UTC"));
        assert_eq!(zone_from_localtime_target(Path::new("/etc/localtime.bak")), None);
        assert!(!local_time_zone().is_empty());
    }
}
