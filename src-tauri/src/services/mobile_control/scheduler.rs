//! The owner's scheduled-prompt runner (headless owner plan, H2).
//!
//! Scheduled prompts used to fire only from a window: `AgentScheduleHost`
//! ticks every 15 s, waits for the tab to fall idle and types the prompt into
//! its PTY. With no window open nothing fired; with two, both did. This is
//! the same loop run by the Mobile sidecar — the one Tabtivity process that
//! lives without a window — against the same files, with the tab reached
//! through its tmux session instead of a PTY the window owns.
//!
//! **Exactly once.** Two things make a schedule fire once whatever is up:
//! - the window lease (`services::timer_lease`): a window that holds it runs
//!   the timers; the sidecar fires only while **no** window does, and never
//!   takes the lease itself, so a window that opens takes the timers back
//!   (it can run the ones this loop cannot — auto-continue, the warm-up
//!   cron, CalDAV sync);
//! - the durable claim (`agent_tasks::claim_in`, now under the file's
//!   cross-process lock): whoever fires an occurrence claims it first, in one
//!   transaction against the file, so a lease handed over mid-tick still
//!   cannot double-fire, and a restart never re-fires what was claimed.
//!
//! **Idle.** The window reads the hooks' turn state and the bytes it paints.
//! This loop reads the same hook record (`live_sessions/<uid>.turn`: the
//! agent itself says when a turn starts, stops or waits on the user) and,
//! for the settle the bytes gave the window, the tmux server's own
//! last-output time of the session. An agent without hooks has no record and
//! is taken as idle only after a long quiet, as the window's hookless
//! fallback does. A record older than the live session is a previous run's.
//!
//! **A dead tab is restarted** through the H1b headless spawn
//! (`headless::launch_options` + the host's launch seam) the first time a
//! schedule of its is due, and the prompt goes in on a later tick, once the
//! CLI has come up and settled. Backed off, so a tab that dies at once is
//! not restarted every tick.
//!
//! **A phone prompt** held with no window (`PhoneHolds`, the window's
//! `phoneHolds.ts`) does not wait for the idle point: it is typed into the
//! CLI's own queue as soon as the pane takes keystrokes and is not on a
//! question, as a prompt typed then would go.
//!
//! Not here (recorded in `docs/headless_owner_handoff.md`): the window's
//! after-link chaining and prompt blame, both of which need its stores.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local};

use super::headless::{self, HeadlessLaunch};
use crate::schema::agent_prompts::{RecordedAgentPromptInput, SentAgentPromptInput};
use crate::schema::agent_tasks::{AgentScheduleResult, AgentScheduleRule, ScheduledAgentPrompt};
use crate::schema::project::TabEntry;
use crate::schema::session::TerminalSession;
use crate::services::agent_turn::TurnState;
use crate::services::{agent_prompts, agent_tasks, schedule_mcp, timer_lease, workspace};
use crate::storage;

/// How often the loop looks — the window's `AgentScheduleHost` cadence.
pub const TICK: Duration = Duration::from_secs(15);
/// An occurrence older than this is missed, never delivered late
/// (`SCHEDULE_CATCH_UP_MS`).
pub const CATCH_UP_SECS: i64 = 60 * 60;
/// A hook's `done` must stand this long before a prompt goes in
/// (`COMPLETION_STABLE_MS`).
pub const DONE_STABLE_SECS: u64 = 3;
/// And the session must have painted nothing for this long
/// (`OUTPUT_SETTLE_MS`, at tmux's one-second resolution).
pub const OUTPUT_SETTLE_SECS: u64 = 2;
/// A tab with no hook record is idle only after this much quiet — the
/// window's `HOOKLESS_DONE_QUIET_MS`, because a silent tool is the one thing
/// output cannot show.
pub const HOOKLESS_QUIET_SECS: u64 = 30;
/// A dead tab is restarted at most this often.
const RELAUNCH_BACKOFF: Duration = Duration::from_secs(60);
/// Between a prefix command and the next submission the pane gets time to act
/// (`settleBetweenSubmissions`): quiet for a second, or this long at most.
const PREFACE_SETTLE_MAX: Duration = Duration::from_secs(6);
const PREFACE_POLL: Duration = Duration::from_millis(100);
/// The buffer name the delivery loads a submission under; deleted on paste.
const PASTE_BUFFER: &str = concat!(crate::app_slug!(), "-schedule");

/// What the window's `scheduleVerdict` answers: an occurrence inside the
/// catch-up window that waits for an idle point, one past it that is only
/// recorded, or nothing to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Wait { key: String },
    Missed { key: String },
    None,
}

#[cfg(test)]
fn occurrence_key(at: &DateTime<Local>) -> String {
    at.format("%Y-%m-%dT%H:%M").to_string()
}

fn occurs_on(rule: &AgentScheduleRule, day: chrono::NaiveDate) -> Option<&str> {
    match rule {
        AgentScheduleRule::Daily { time } => Some(time),
        AgentScheduleRule::Weekdays { weekdays, time }
            if weekdays.contains(&(day.weekday().number_from_monday() as u8)) =>
        {
            Some(time)
        }
        _ => None,
    }
}

/// `latestScheduleOccurrence`: the newest occurrence at or before `now` — a
/// one-time rule's own instant, or the last of the past eight days a
/// recurring rule fell on (eight so a DST-gap day can be skipped).
pub fn latest_occurrence(rule: &AgentScheduleRule, now: DateTime<Local>) -> Option<(String, DateTime<Local>)> {
    if let AgentScheduleRule::Once { at } = rule {
        let wall = schedule_mcp::wall(at)?;
        return (wall <= now).then(|| (at.clone(), wall));
    }
    for offset in 0..=8 {
        let day = now.date_naive().checked_sub_signed(ChronoDuration::days(offset))?;
        let Some(time) = occurs_on(rule, day) else { continue };
        let key = format!("{day}T{time}");
        if let Some(at) = schedule_mcp::wall(&key) {
            if at <= now {
                return Some((key, at));
            }
        }
    }
    None
}

/// `scheduleVerdict`: latest-only catch-up, refusing an occurrence at or
/// before the last receipt (a clock moved backwards replays nothing) and a
/// one-time rule that has any result.
pub fn verdict(schedule: &ScheduledAgentPrompt, now: DateTime<Local>) -> Verdict {
    if !schedule.enabled {
        return Verdict::None;
    }
    let Some((key, at)) = latest_occurrence(&schedule.rule, now) else {
        return Verdict::None;
    };
    if schedule.last.as_ref().is_some_and(|last| last.occurrence >= key) {
        return Verdict::None;
    }
    if matches!(schedule.rule, AgentScheduleRule::Once { .. }) && schedule.last.is_some() {
        return Verdict::None;
    }
    if (now - at).num_seconds() <= CATCH_UP_SECS {
        Verdict::Wait { key }
    } else {
        Verdict::Missed { key }
    }
}

/// A schedule binding resolved to the tab that carries it.
#[derive(Debug, Clone)]
pub struct Target {
    pub project_id: String,
    pub target_id: String,
    pub tab: TabEntry,
    pub tmux: String,
}

impl Target {
    /// The tab's launch uid, which its hooks key their record by.
    fn uid(&self) -> Option<&str> {
        self.tab.session_id.as_deref().filter(|id| !id.is_empty())
    }

    fn kind(&self) -> &str {
        self.tab.extra.get("kind").and_then(serde_json::Value::as_str).unwrap_or("")
    }
}

/// Every bound agent tab of the state dir with an enabled rule: the
/// `agent_tasks.json` bindings joined to the scopes' session files by
/// `scheduleTargetId`. A binding whose tab is gone (or has no tmux name — a
/// tab this loop cannot reach) is skipped; the window's own sweep retires
/// it.
pub fn targets(state_dir: &Path) -> Vec<Target> {
    let Ok(bindings) = agent_tasks::bindings_at(state_dir) else {
        return Vec::new();
    };
    let mut sessions: HashMap<String, Vec<TabEntry>> = HashMap::new();
    let mut out = Vec::new();
    for binding in bindings {
        let tabs = sessions.entry(binding.project_id.clone()).or_insert_with(|| {
            // project-tree-read: ok — the state-dir session file, keyed by scope id.
            storage::read_json::<TerminalSession>(&headless::session_file(state_dir, &binding.project_id))
                .map(|session| session.tab_layout)
                .unwrap_or_default()
        });
        let Some(tab) = tabs.iter().find(|tab| {
            tab.extra.get("scheduleTargetId").and_then(serde_json::Value::as_str) == Some(binding.schedule_target_id.as_str())
                && matches!(tab.extra.get("kind").and_then(serde_json::Value::as_str), Some("agent") | Some("local_agent"))
        }) else {
            continue;
        };
        let Some(tmux) = workspace::tmux_of(tab) else { continue };
        out.push(Target {
            project_id: binding.project_id,
            target_id: binding.schedule_target_id,
            tab: tab.clone(),
            tmux: tmux.to_string(),
        });
    }
    out
}

/// What the tmux server says about a live session: when it was created and
/// when its window last painted, both epoch seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionProbe {
    pub created: u64,
    pub activity: u64,
}

/// Whether a prompt may go into the tab now. `record` is the hooks' turn
/// record (state, stamp); `probe` the live session.
pub fn ready(record: Option<(TurnState, Option<u64>)>, probe: SessionProbe, now: u64) -> bool {
    let quiet = |secs: u64| now.saturating_sub(probe.activity) >= secs;
    // A record stamped before the session existed belongs to the tab's
    // previous process (a `working` it died in, an `idle` from its exit).
    let record = record.filter(|(_, at)| at.is_none_or(|at| at >= probe.created));
    match record {
        Some((TurnState::Working, _)) | Some((TurnState::Decision, _)) => false,
        // A `SessionEnd`: the agent is gone and the tab is a shell — a prompt
        // typed there would run as a command. The window refuses this too.
        Some((TurnState::Idle, _)) => false,
        Some((TurnState::Done, Some(at))) => now.saturating_sub(at) >= DONE_STABLE_SECS && quiet(OUTPUT_SETTLE_SECS),
        Some((TurnState::Done, None)) | None => quiet(HOOKLESS_QUIET_SECS),
    }
}

/// Whether a phone prompt may go in while the agent works
/// (`queueableWhileBusy`): the CLI is up and the pane is not on a question,
/// whose choices a typed line would answer. A hook record after the session
/// started says the CLI is up; with none, the hookless quiet stands in.
pub fn queueable_while_busy(record: Option<(TurnState, Option<u64>)>, probe: SessionProbe, now: u64) -> bool {
    let record = record.filter(|(_, at)| at.is_none_or(|at| at >= probe.created));
    match record {
        Some((TurnState::Working, _)) | Some((TurnState::Done, Some(_))) => true,
        // A question, or a `SessionEnd` that left a shell behind.
        Some((TurnState::Decision, _)) | Some((TurnState::Idle, _)) => false,
        Some((TurnState::Done, None)) | None => ready(None, probe, now),
    }
}

/// The send-now rules that carry a prompt the phone sent while the agent
/// worked and the owner holds (no window was open to hold it), by rule id —
/// the window's `phoneHolds.ts`. Shared by the host, which marks them, and
/// the scheduler, which types them at once. In memory only: a rule whose
/// mark is lost with the sidecar is an ordinary send-now rule, delivered at
/// the agent's next idle point (the same holds for a window that opens).
#[derive(Default)]
pub struct PhoneHolds {
    ids: Mutex<HashSet<String>>,
    wake: tokio::sync::Notify,
}

impl PhoneHolds {
    /// Mark `schedule_id` for the CLI's queue and wake the scheduler for it.
    pub fn hold(&self, schedule_id: &str) {
        self.ids.lock().unwrap_or_else(PoisonError::into_inner).insert(schedule_id.to_string());
        self.wake.notify_one();
    }

    pub fn due(&self, schedule_id: &str) -> bool {
        self.ids.lock().unwrap_or_else(PoisonError::into_inner).contains(schedule_id)
    }

    pub fn forget(&self, schedule_id: &str) {
        self.ids.lock().unwrap_or_else(PoisonError::into_inner).remove(schedule_id);
    }
}

/// One thing typed into the tab and submitted: a prefix command or the
/// message. `bracketed` is whether it may ride inside the pane's bracketed
/// paste (never for Claude, which reads a paste as quoted content —
/// `bracketsAgentMessage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submission {
    pub text: String,
    pub bracketed: bool,
}

/// `agentInputWrites`' submissions for a schedule: each prefix command, then
/// the message; an entry that sanitizes to nothing is skipped rather than
/// submitted as a bare newline.
pub fn submissions(schedule: &ScheduledAgentPrompt, cmd: &str) -> Vec<Submission> {
    let bracketed = !cmd.to_ascii_lowercase().contains("claude");
    schedule
        .preface
        .iter()
        .chain(std::iter::once(&schedule.message))
        .map(|text| agent_tasks::sanitize_message(text))
        .filter(|text| !text.trim().is_empty())
        .map(|text| Submission { text, bracketed })
        .collect()
}

/// The loop's reach into the world — the tmux server and the tab's launch —
/// so the loop itself runs against a recorder in tests.
pub trait Runner: Send + Sync {
    /// The live session under `tmux`, or `None` when the server has none.
    fn probe(&self, tmux: &str) -> Option<SessionProbe>;
    /// Type and submit each submission into `tmux`, in order, giving the pane
    /// time to act between them. Blocking.
    fn deliver(&self, tmux: &str, submissions: &[Submission]) -> Result<(), String>;
    /// End the session under `tmux` and everything it ran (headless owner
    /// plan, H3: the phone's close with no window). A session already gone is
    /// the desired state, not an error. Blocking.
    fn kill(&self, _tmux: &str) -> Result<(), String> {
        Ok(())
    }
}

/// The production runner: the tmux server the window's and the sidecar's
/// spawns use (the default socket; `socket` names a private one in tests).
pub struct TmuxRunner {
    pub socket: Option<String>,
    /// Where a submission is staged for `load-buffer` — a 16 KiB message
    /// does not fit a tmux command line. The file is private to the state
    /// dir and overwritten per submission.
    pub paste_file: PathBuf,
}

impl TmuxRunner {
    pub fn new(state_dir: &Path, socket: Option<String>) -> Self {
        Self { socket, paste_file: state_dir.join("mobile-control").join("schedule-paste.txt") }
    }

    fn tmux(&self, args: &[&str]) -> Result<std::process::Output, String> {
        let mut cmd = crate::paths::command_no_window("tmux");
        if let Some(socket) = &self.socket {
            cmd.args(["-L", socket, "-f", "/dev/null"]);
        }
        cmd.args(args);
        cmd.stdin(std::process::Stdio::null());
        cmd.output().map_err(|e| format!("tmux: {e}"))
    }

    fn run(&self, args: &[&str]) -> Result<(), String> {
        let out = self.tmux(args)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("tmux {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()))
        }
    }

    /// Wait for the pane to stop painting after a prefix command, capped.
    fn settle(&self, tmux: &str) {
        let deadline = Instant::now() + PREFACE_SETTLE_MAX;
        std::thread::sleep(Duration::from_millis(350));
        while Instant::now() < deadline {
            let quiet = self
                .probe(tmux)
                .map(|probe| now_secs().saturating_sub(probe.activity) >= 1)
                .unwrap_or(true);
            if quiet {
                return;
            }
            std::thread::sleep(PREFACE_POLL);
        }
    }
}

/// `-t =<name>:` — the exact session, its current window.
fn target_of(tmux: &str) -> String {
    format!("={tmux}:")
}

impl Runner for TmuxRunner {
    fn probe(&self, tmux: &str) -> Option<SessionProbe> {
        if cfg!(windows) {
            return None;
        }
        let out = self
            .tmux(&["display-message", "-p", "-t", &target_of(tmux), "#{session_created}\t#{window_activity}"])
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut parts = text.trim().split('\t');
        let created = parts.next()?.parse().ok()?;
        let activity = parts.next()?.parse().ok()?;
        Some(SessionProbe { created, activity })
    }

    fn deliver(&self, tmux: &str, submissions: &[Submission]) -> Result<(), String> {
        let target = target_of(tmux);
        for (index, submission) in submissions.iter().enumerate() {
            // `AGENT_LINE_RESET`: to the start of the composer, drop its draft.
            self.run(&["send-keys", "-t", &target, "C-a", "C-k"])?;
            if submission.text.chars().count() == 1 {
                // A lone character is a key press, never a paste.
                self.run(&["send-keys", "-t", &target, "-l", "--", &submission.text])?;
            } else {
                if let Some(dir) = self.paste_file.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| format!("stage submission: {e}"))?;
                }
                write_private(&self.paste_file, submission.text.as_bytes()).map_err(|e| format!("stage submission: {e}"))?;
                let file = self.paste_file.to_string_lossy().into_owned();
                self.run(&["load-buffer", "-b", PASTE_BUFFER, &file])?;
                // `-r`: the newlines stay newlines (the default would turn
                // each into a submit); `-p`: the pane's bracketed paste, when
                // it asked for one and the agent reads pastes as typed text.
                let mut args = vec!["paste-buffer", "-r", "-d", "-b", PASTE_BUFFER, "-t", &target];
                if submission.bracketed {
                    args.insert(1, "-p");
                }
                self.run(&args)?;
                let _ = std::fs::remove_file(&self.paste_file);
            }
            self.run(&["send-keys", "-t", &target, "Enter"])?;
            if index + 1 < submissions.len() {
                self.settle(tmux);
            }
        }
        Ok(())
    }

    /// The window's close of a local tab, done by the owner: the pane's
    /// process subtree is walked **before** the session ends (once the leader
    /// dies its children reparent and the tree is unreachable —
    /// `terminal::reap_child_subtree`), then `kill-session`, then the
    /// launcher script the session may have been started from is dropped.
    fn kill(&self, tmux: &str) -> Result<(), String> {
        if cfg!(windows) {
            return Ok(());
        }
        let target = target_of(tmux);
        let pane_pid = self
            .tmux(&["display-message", "-p", "-t", &target, "#{pane_pid}"])
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok());
        if let Some(pid) = pane_pid {
            crate::terminal::reap_child_subtree(pid, crate::terminal::ReapMode::Graceful);
        }
        let out = self.tmux(&["kill-session", "-t", &format!("={tmux}")])?;
        crate::services::tmux_local::remove_launcher(tmux);
        if out.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if crate::services::tmux_local::kill_failure_is_already_gone(&detail) {
            return Ok(());
        }
        Err(format!("tmux kill-session: {detail}"))
    }
}

/// The staged submission, readable by this user alone: a scheduled prompt
/// is the user's text and lands in the state dir only for the length of one
/// `load-buffer`.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What one tick did, for the sidecar's journal and the tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A window holds the timers: nothing to do here.
    WindowHoldsLease(String),
    /// The tab's session was gone; it was started again (or the start failed).
    Relaunched { tmux: String, error: Option<String> },
    /// An occurrence past the catch-up window was recorded as missed.
    Missed { tmux: String, schedule_id: String, occurrence: String },
    /// A prompt went into the tab.
    Delivered { tmux: String, schedule_id: String, occurrence: String },
    /// A claimed delivery failed on the way in; recorded as failed.
    Failed { tmux: String, schedule_id: String, occurrence: String, error: String },
}

/// The loop's state: where the files are, how the world is reached, and
/// which tabs were restarted when.
pub struct Context {
    pub state_dir: PathBuf,
    pub runner: Arc<dyn Runner>,
    pub launch: HeadlessLaunch,
    pub holds: Arc<PhoneHolds>,
    relaunched: Mutex<HashMap<String, Instant>>,
}

impl Context {
    pub fn new(state_dir: PathBuf, runner: Arc<dyn Runner>, launch: HeadlessLaunch) -> Self {
        Self { state_dir, runner, launch, holds: Arc::default(), relaunched: Mutex::new(HashMap::new()) }
    }

    /// The host's holds, so a phone prompt it marks is typed from here.
    pub fn with_holds(mut self, holds: Arc<PhoneHolds>) -> Self {
        self.holds = holds;
        self
    }

    fn may_relaunch(&self, tmux: &str) -> bool {
        let mut map = self.relaunched.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        map.retain(|_, at| now.duration_since(*at) < RELAUNCH_BACKOFF);
        if map.contains_key(tmux) {
            return false;
        }
        map.insert(tmux.to_string(), now);
        true
    }
}

/// The window's `retire`: the history row of one run, and a one-time rule
/// taken out of the menu (with the collected prompt it carried) once the
/// row is written — the row first, so a failed write keeps the rule for the
/// next tick rather than losing the only account of the delivery.
fn retire(state_dir: &Path, target: &Target, schedule: &ScheduledAgentPrompt, occurrence: &str, result: AgentScheduleResult) {
    let once = matches!(schedule.rule, AgentScheduleRule::Once { .. });
    let id = if once { schedule.id.clone() } else { format!("{}@{occurrence}", schedule.id) };
    let result_word = match result {
        AgentScheduleResult::Delivered => "delivered",
        AgentScheduleResult::Missed => "missed",
        AgentScheduleResult::Failed => "failed",
    };
    let recorded = agent_prompts::record_at(
        state_dir,
        &target.project_id,
        RecordedAgentPromptInput {
            id,
            message: schedule.message.clone(),
            created_at: None,
            sent: SentAgentPromptInput {
                schedule_origin: schedule.origin.clone(),
                tab_label: target.tab.label.clone(),
                session_id: target.tab.session_id.clone(),
                // A tab with no launch id is told apart by its binding
                // (`prompt/adopt.historyTabId`), as the window stamps it.
                tab_id: target.uid().is_none().then(|| target.target_id.clone()),
                preface: schedule.preface.clone(),
                agent: Some(target.tab.cmd.clone()),
                result: Some(result_word.to_string()),
                scheduled_for: Some(occurrence.to_string()).filter(|s| !s.is_empty()),
                sent_at: None,
            },
        },
    );
    if let Err(error) = recorded {
        eprintln!("{}: scheduler: history row of '{}' not written: {error}", crate::brand::MOBILE_HOST_BIN, schedule.id);
        return;
    }
    if !once {
        return;
    }
    let _ = agent_tasks::delete_in(&agent_tasks::file_path(state_dir), &target.project_id, &target.target_id, &schedule.id, false);
    // `retireCollected`: the one prompt the rule carried — by id, else the
    // first with the same words.
    if let Ok(prompts) = agent_prompts::list_at(state_dir, &target.project_id) {
        let key = agent_tasks::sanitize_message(&schedule.message);
        let carried = prompts
            .iter()
            .find(|prompt| prompt.id == schedule.id)
            .or_else(|| (!key.is_empty()).then(|| prompts.iter().find(|prompt| agent_tasks::sanitize_message(&prompt.message) == key)).flatten());
        if let Some(prompt) = carried {
            let _ = agent_prompts::delete_at(state_dir, &target.project_id, &prompt.id);
        }
    }
}

/// One pass over every bound tab at `now`: nothing while a window holds the
/// timers; otherwise, per tab, missed occurrences are recorded and the first
/// due one goes in once the tab is up and idle — at most one delivery per
/// tab per tick, as in the window.
pub async fn tick(ctx: &Context, now: DateTime<Local>) -> Vec<Event> {
    let mut events = Vec::new();
    let secs = now.timestamp().max(0) as u64;
    if let Some(holder) = timer_lease::holder_in(&timer_lease::lease_file(&ctx.state_dir), secs) {
        events.push(Event::WindowHoldsLease(holder));
        return events;
    }
    let tasks = agent_tasks::file_path(&ctx.state_dir);
    for target in targets(&ctx.state_dir) {
        let Ok(mut schedules) = agent_tasks::list_at(&ctx.state_dir, &target.project_id, &target.target_id) else {
            continue;
        };
        // Soonest due first, as the window sorts.
        schedules.sort_by_key(|schedule| latest_occurrence(&schedule.rule, now).map(|(_, at)| at));
        for schedule in &schedules {
            let key = match verdict(schedule, now) {
                Verdict::None => continue,
                Verdict::Missed { key } => {
                    if agent_tasks::claim_in(&tasks, &target.project_id, &target.target_id, &schedule.id, &key, now) == Ok(true) {
                        let _ = agent_tasks::complete_in(&tasks, &target.project_id, &target.target_id, &schedule.id, &key, AgentScheduleResult::Missed);
                        retire(&ctx.state_dir, &target, schedule, &key, AgentScheduleResult::Missed);
                        events.push(Event::Missed { tmux: target.tmux.clone(), schedule_id: schedule.id.clone(), occurrence: key });
                    }
                    continue;
                }
                Verdict::Wait { key } => key,
            };
            let Some(probe) = ctx.runner.probe(&target.tmux) else {
                // The session is gone: start the tab again (H1b's detached
                // spawn) and deliver on a later tick, once it is up and idle.
                if target.kind() == "agent" && ctx.may_relaunch(&target.tmux) {
                    let error = (ctx.launch)(headless::launch_options(&target.project_id, &target.tab)).await.err();
                    if let Some(error) = &error {
                        eprintln!("{}: scheduler: could not restart '{}': {error}", crate::brand::MOBILE_HOST_BIN, target.tmux);
                    }
                    events.push(Event::Relaunched { tmux: target.tmux.clone(), error });
                }
                break;
            };
            let record = target.uid().and_then(|uid| headless::turn_record(&ctx.state_dir, &target.project_id, uid));
            if !ready(record, probe, secs) {
                // Only a phone prompt goes in meanwhile.
                if queueable_while_busy(record, probe, secs) {
                    let held = schedules.iter().find_map(|schedule| match verdict(schedule, now) {
                        Verdict::Wait { key } if ctx.holds.due(&schedule.id) => Some((schedule, key)),
                        _ => None,
                    });
                    if let Some((schedule, key)) = held {
                        ctx.holds.forget(&schedule.id);
                        if let Some(event) = deliver_claimed(ctx, &target, schedule, &key, now).await {
                            events.push(event);
                        }
                    }
                }
                break;
            }
            ctx.holds.forget(&schedule.id);
            if let Some(event) = deliver_claimed(ctx, &target, schedule, &key, now).await {
                events.push(event);
            }
            break;
        }
    }
    events
}

/// Claim `key` of `schedule`, type it into the tab and record the outcome.
/// `None` when another process claimed the occurrence first.
async fn deliver_claimed(ctx: &Context, target: &Target, schedule: &ScheduledAgentPrompt, key: &str, now: DateTime<Local>) -> Option<Event> {
    let tasks = agent_tasks::file_path(&ctx.state_dir);
    if agent_tasks::claim_in(&tasks, &target.project_id, &target.target_id, &schedule.id, key, now) != Ok(true) {
        return None;
    }
    let runner = ctx.runner.clone();
    let tmux = target.tmux.clone();
    let submissions = submissions(schedule, &target.tab.cmd);
    let delivered = if submissions.is_empty() {
        Err("scheduled prompt is empty".to_string())
    } else {
        tokio::task::spawn_blocking(move || runner.deliver(&tmux, &submissions))
            .await
            .unwrap_or_else(|e| Err(format!("delivery task: {e}")))
    };
    let (result, event) = match delivered {
        Ok(()) => (
            AgentScheduleResult::Delivered,
            Event::Delivered { tmux: target.tmux.clone(), schedule_id: schedule.id.clone(), occurrence: key.to_string() },
        ),
        Err(error) => (
            AgentScheduleResult::Failed,
            Event::Failed { tmux: target.tmux.clone(), schedule_id: schedule.id.clone(), occurrence: key.to_string(), error },
        ),
    };
    let _ = agent_tasks::complete_in(&tasks, &target.project_id, &target.target_id, &schedule.id, key, result);
    retire(&ctx.state_dir, target, schedule, key, result);
    Some(event)
}

/// The sidecar's loop: a tick every [`TICK`] until `shutdown` says so.
/// Every firing is announced on stderr — the sidecar's journal is the one
/// place a schedule that fired with no window can be accounted for.
pub async fn run(
    state_dir: PathBuf,
    launch: HeadlessLaunch,
    holds: Arc<PhoneHolds>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    // What a phone revoked or narrowed while this host was down left behind
    // goes now (#2348); the claim's own check stops anything later.
    if let Err(error) = super::phone_origin::sweep_in(&state_dir, "when the host started") {
        eprintln!("{}: scheduler: phone prompts and schedules not checked: {error}", crate::brand::MOBILE_HOST_BIN);
    }
    let runner: Arc<dyn Runner> = Arc::new(TmuxRunner::new(&state_dir, None));
    let ctx = Context::new(state_dir, runner, launch).with_holds(holds.clone());
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            // A phone prompt goes in now, not on the next sweep.
            _ = async { tokio::select! { _ = interval.tick() => {}, _ = holds.wake.notified() => {} } } => {
                for event in tick(&ctx, Local::now()).await {
                    match event {
                        Event::WindowHoldsLease(_) => {}
                        Event::Relaunched { tmux, error: None } => eprintln!("{}: scheduler: restarted '{tmux}' for a due prompt", crate::brand::MOBILE_HOST_BIN),
                        Event::Relaunched { .. } => {}
                        Event::Missed { tmux, schedule_id, occurrence } => eprintln!("{}: scheduler: '{schedule_id}' on '{tmux}' missed {occurrence}", crate::brand::MOBILE_HOST_BIN),
                        Event::Delivered { tmux, schedule_id, occurrence } => eprintln!("{}: scheduler: '{schedule_id}' delivered into '{tmux}' for {occurrence}", crate::brand::MOBILE_HOST_BIN),
                        Event::Failed { tmux, schedule_id, occurrence, error } => eprintln!("{}: scheduler: '{schedule_id}' into '{tmux}' for {occurrence} failed: {error}", crate::brand::MOBILE_HOST_BIN),
                    }
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::agent_tasks::{AgentScheduleLastRun, AgentTasksFile};
    use chrono::TimeZone;
    use serde_json::json;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().expect("wall clock")
    }

    fn rule_once(at: &str) -> ScheduledAgentPrompt {
        ScheduledAgentPrompt {
            id: "s-once".into(),
            enabled: true,
            message: "run the tests".into(),
            rule: AgentScheduleRule::Once { at: at.into() },
            preface: vec![],
            last: None,
            origin: None,
            phone_device: None,
        }
    }

    fn rule_daily(time: &str) -> ScheduledAgentPrompt {
        ScheduledAgentPrompt { id: "s-daily".into(), rule: AgentScheduleRule::Daily { time: time.into() }, ..rule_once("x") }
    }

    /// The verdict twin agrees with `scheduleVerdict`: a future once is
    /// nothing, one inside the hour waits, one past it is missed, a receipt
    /// at or after the occurrence blocks it, a finished once never fires
    /// again, and a recurring rule takes only its latest past occurrence.
    #[test]
    fn verdicts_match_the_windows() {
        // 2026-09-30 is a Wednesday.
        let now = at(2026, 9, 30, 10, 0);
        assert_eq!(verdict(&rule_once("2026-09-30T10:30"), now), Verdict::None);
        assert_eq!(verdict(&rule_once("2026-09-30T09:30"), now), Verdict::Wait { key: "2026-09-30T09:30".into() });
        assert_eq!(verdict(&rule_once("2026-09-30T09:00"), now), Verdict::Wait { key: "2026-09-30T09:00".into() });
        assert_eq!(verdict(&rule_once("2026-09-30T08:59"), now), Verdict::Missed { key: "2026-09-30T08:59".into() });
        let mut done = rule_once("2026-09-30T09:30");
        done.last = Some(AgentScheduleLastRun { occurrence: "2026-09-30T09:30".into(), result: AgentScheduleResult::Delivered, at: "x".into() });
        assert_eq!(verdict(&done, now), Verdict::None);
        let mut off = rule_once("2026-09-30T09:30");
        off.enabled = false;
        assert_eq!(verdict(&off, now), Verdict::None);

        assert_eq!(verdict(&rule_daily("09:45"), now), Verdict::Wait { key: "2026-09-30T09:45".into() });
        assert_eq!(verdict(&rule_daily("10:00"), now), Verdict::Wait { key: "2026-09-30T10:00".into() });
        assert_eq!(verdict(&rule_daily("10:01"), now), Verdict::Missed { key: "2026-09-29T10:01".into() });
        let mut ran = rule_daily("09:45");
        ran.last = Some(AgentScheduleLastRun { occurrence: "2026-09-30T09:45".into(), result: AgentScheduleResult::Delivered, at: "x".into() });
        assert_eq!(verdict(&ran, now), Verdict::None);
        ran.last.as_mut().unwrap().occurrence = "2026-09-29T09:45".into();
        assert_eq!(verdict(&ran, now), Verdict::Wait { key: "2026-09-30T09:45".into() });

        // Monday + Friday at 09:30 on a Wednesday: Monday's is the latest.
        let weekdays = ScheduledAgentPrompt {
            rule: AgentScheduleRule::Weekdays { weekdays: vec![1, 5], time: "09:30".into() },
            ..rule_once("x")
        };
        assert_eq!(verdict(&weekdays, now), Verdict::Missed { key: "2026-09-28T09:30".into() });
    }

    fn probe(created: u64, activity: u64) -> SessionProbe {
        SessionProbe { created, activity }
    }

    /// Idle is the hooks' word first — working or a decision never delivers,
    /// `done` after it has stood and the pane settled — and long quiet for a
    /// tab with no record; a record older than the session is ignored; a
    /// `SessionEnd` shuts the gate.
    #[test]
    fn readiness_follows_the_hooks_then_the_pane() {
        let now = 1_000;
        assert!(!ready(Some((TurnState::Working, Some(990))), probe(100, 900), now));
        assert!(!ready(Some((TurnState::Decision, Some(990))), probe(100, 900), now));
        assert!(ready(Some((TurnState::Done, Some(990))), probe(100, 995), now));
        assert!(!ready(Some((TurnState::Done, Some(998))), probe(100, 900), now), "done must stand 3 s");
        assert!(!ready(Some((TurnState::Done, Some(990))), probe(100, 999), now), "the pane must settle");
        assert!(!ready(Some((TurnState::Idle, Some(990))), probe(100, 900), now));
        assert!(!ready(None, probe(100, 980), now), "no record: 30 s of quiet");
        assert!(ready(None, probe(100, 960), now));
        assert!(ready(Some((TurnState::Working, Some(50))), probe(100, 960), now), "a record from before the session is the previous run's");
        assert!(!ready(Some((TurnState::Done, None)), probe(100, 980), now), "a stampless done needs the long quiet");
    }

    #[test]
    fn submissions_are_the_prefix_commands_then_the_message() {
        let mut schedule = rule_once("x");
        schedule.preface = vec!["/clear".into(), "  ".into(), "/model opus".into()];
        schedule.message = "line one\nline two".into();
        let claude = submissions(&schedule, "claude");
        assert_eq!(claude.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), ["/clear", "/model opus", "line one\nline two"]);
        assert!(claude.iter().all(|s| !s.bracketed), "Claude reads a paste as quoted content");
        assert!(submissions(&schedule, "codex").iter().all(|s| s.bracketed));
    }

    // ── A state dir with one bound tab ──────────────────────────────────

    struct Fixture {
        dir: tempfile::TempDir,
    }

    const PROJECT: &str = "proj-1";
    const TARGET: &str = "target-1";
    const TMUX: &str = concat!(crate::app_slug!(), "-proj-1--agent-abc");
    const UID: &str = "11111111-2222-4333-8444-555555555555";

    impl Fixture {
        fn new(schedules: Vec<ScheduledAgentPrompt>) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let mut file = AgentTasksFile::default();
            file.projects.entry(PROJECT.into()).or_default().entry(TARGET.into()).or_default().schedules = schedules;
            storage::write_json_atomic(&agent_tasks::file_path(dir.path()), &file).unwrap();
            let session = json!({
                "tabLayout": [
                    { "key": "k1", "label": "Claude", "cmd": "claude", "cwd": dir.path().to_string_lossy(),
                      "kind": "agent", "sessionId": UID, "scheduleTargetId": TARGET, "tmuxSession": TMUX,
                      "args": ["--session-id", UID], "env": { crate::app_env!("TAB_UID"): UID } },
                    { "key": "k2", "label": "Shell", "cmd": "", "cwd": dir.path().to_string_lossy(),
                      "kind": "shell", "tmuxSession": concat!(crate::app_slug!(), "-proj-1--shell-def") }
                ]
            });
            let path = headless::session_file(dir.path(), PROJECT);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            storage::write_json_atomic(&path, &session).unwrap();
            Self { dir }
        }

        fn state_dir(&self) -> &Path {
            self.dir.path()
        }

        fn tasks(&self) -> AgentTasksFile {
            storage::read_json(&agent_tasks::file_path(self.state_dir())).unwrap()
        }

        fn turn(&self, text: &str) {
            let live = self.state_dir().join("live_sessions");
            std::fs::create_dir_all(&live).unwrap();
            std::fs::write(live.join(format!("{UID}.turn")), text).unwrap();
        }
    }

    #[test]
    fn bindings_resolve_to_the_tab_that_carries_them() {
        let fixture = Fixture::new(vec![rule_daily("09:00")]);
        let targets = targets(fixture.state_dir());
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].tmux, TMUX);
        assert_eq!(targets[0].target_id, TARGET);
        assert_eq!(targets[0].uid(), Some(UID));
        let mut off = rule_daily("09:00");
        off.enabled = false;
        assert!(super::targets(Fixture::new(vec![off]).state_dir()).is_empty(), "a target with no enabled rule is not walked");
    }

    /// A runner the tests script: what the probe answers, what was typed,
    /// what was launched.
    #[derive(Default)]
    struct Recorder {
        probe: Mutex<Option<SessionProbe>>,
        delivered: Mutex<Vec<(String, Vec<Submission>)>>,
        fail: Mutex<bool>,
    }

    impl Runner for Recorder {
        fn probe(&self, _tmux: &str) -> Option<SessionProbe> {
            *self.probe.lock().unwrap()
        }
        fn deliver(&self, tmux: &str, submissions: &[Submission]) -> Result<(), String> {
            if *self.fail.lock().unwrap() {
                return Err("pane went away".into());
            }
            self.delivered.lock().unwrap().push((tmux.to_string(), submissions.to_vec()));
            Ok(())
        }
    }

    fn context(fixture: &Fixture, recorder: &Arc<Recorder>) -> (Context, Arc<Mutex<Vec<crate::terminal::PtyOptions>>>) {
        let launched: Arc<Mutex<Vec<crate::terminal::PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = launched.clone();
        let launch: HeadlessLaunch = Arc::new(move |opts| {
            seen.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        });
        let runner: Arc<dyn Runner> = recorder.clone();
        (Context::new(fixture.state_dir().to_path_buf(), runner, launch), launched)
    }

    /// H2 exit, headless half: with no window, a due prompt restarts a dead
    /// tab, then goes in once the tab is idle — claimed, completed, on the
    /// history, a one-time rule retired — and never goes in twice.
    #[tokio::test]
    async fn a_due_prompt_fires_once_with_no_window_and_restarts_a_dead_tab() {
        let now = Local::now();
        let key = occurrence_key(&(now - ChronoDuration::minutes(5)));
        let mut schedule = rule_once(&key);
        schedule.preface = vec!["/clear".into()];
        let fixture = Fixture::new(vec![schedule]);
        let recorder = Arc::new(Recorder::default());
        let (ctx, launched) = context(&fixture, &recorder);
        let secs = now.timestamp() as u64;

        // Tick 1: no session → the tab is started, nothing typed.
        let events = tick(&ctx, now).await;
        assert!(matches!(events.as_slice(), [Event::Relaunched { tmux, error: None }] if tmux == TMUX), "{events:?}");
        {
            let launches = launched.lock().unwrap();
            assert_eq!(launches.len(), 1);
            assert_eq!(launches[0].tmux_session.as_deref(), Some(TMUX));
            assert_eq!(launches[0].project_id.as_deref(), Some(PROJECT));
            assert!(launches[0].agent);
        }
        assert!(recorder.delivered.lock().unwrap().is_empty());
        assert!(fixture.tasks().projects[PROJECT][TARGET].claims.is_empty(), "nothing claimed before delivery");

        // Tick 2, at once: the session is up but not restarted again (backoff),
        // and a stale `working` from the previous run does not hold it.
        fixture.turn(&format!("working {}", secs - 600));
        let events = tick(&ctx, now).await;
        assert!(events.is_empty(), "{events:?}");

        // The CLI is up and has been quiet: the prompt goes in.
        *recorder.probe.lock().unwrap() = Some(SessionProbe { created: secs - 120, activity: secs - 60 });
        let events = tick(&ctx, now).await;
        assert!(matches!(events.as_slice(), [Event::Delivered { schedule_id, occurrence, .. }] if schedule_id == "s-once" && occurrence == &key), "{events:?}");
        let delivered = recorder.delivered.lock().unwrap().clone();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].0, TMUX);
        assert_eq!(delivered[0].1.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), ["/clear", "run the tests"]);

        // Durable: the once rule is retired, the claim released, the history
        // row written under the rule's id with the tab's facts.
        let tasks = fixture.tasks();
        assert!(tasks.projects.get(PROJECT).and_then(|p| p.get(TARGET)).is_none_or(|t| t.schedules.is_empty() && t.claims.is_empty()));
        let history: serde_json::Value = storage::read_json(&agent_prompts::file_path(fixture.state_dir())).unwrap();
        let row = &history["history"][PROJECT][0];
        assert_eq!(row["id"], "s-once");
        assert_eq!(row["result"], "delivered");
        assert_eq!(row["scheduled_for"], key);
        assert_eq!(row["tab_label"], "Claude");
        assert_eq!(row["agent"], "claude");
        assert_eq!(row["preface"], json!(["/clear"]));

        // Never twice.
        let events = tick(&ctx, now).await;
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(recorder.delivered.lock().unwrap().len(), 1);
    }

    /// A phone prompt the owner holds goes into the CLI's queue while the
    /// agent works — not while the pane is on a question — and an unheld
    /// send-now rule beside it still waits for the idle point.
    #[tokio::test]
    async fn a_held_phone_prompt_goes_in_mid_turn_but_never_onto_a_question() {
        let now = Local::now();
        let key = occurrence_key(&now);
        let held = ScheduledAgentPrompt { id: "s-held".into(), message: "also fix the docs".into(), ..rule_once(&key) };
        let plain = rule_once(&key);
        let fixture = Fixture::new(vec![plain, held]);
        let recorder = Arc::new(Recorder::default());
        let (ctx, _launched) = context(&fixture, &recorder);
        let secs = now.timestamp() as u64;
        *recorder.probe.lock().unwrap() = Some(SessionProbe { created: secs - 600, activity: secs });

        // Working, nothing held: everything waits.
        fixture.turn(&format!("working {}", secs - 30));
        assert!(tick(&ctx, now).await.is_empty());

        // On a question, held: a typed line would answer it — still waits.
        ctx.holds.hold("s-held");
        fixture.turn(&format!("decision {}", secs - 5));
        assert!(tick(&ctx, now).await.is_empty());
        assert!(recorder.delivered.lock().unwrap().is_empty());

        // Back at work: the held one goes in, the other keeps waiting.
        fixture.turn(&format!("working {}", secs - 2));
        let events = tick(&ctx, now).await;
        assert!(matches!(events.as_slice(), [Event::Delivered { schedule_id, .. }] if schedule_id == "s-held"), "{events:?}");
        assert_eq!(recorder.delivered.lock().unwrap()[0].1[0].text, "also fix the docs");
        assert!(!ctx.holds.due("s-held"), "a delivered hold is forgotten");
        let rules = fixture.tasks().projects[PROJECT][TARGET].schedules.clone();
        assert_eq!(rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["s-once"]);
        assert!(tick(&ctx, now).await.is_empty(), "the unheld rule waits for idle");
    }

    /// A recurring rule keeps its receipt and stays; a hook's `working`
    /// holds delivery; a delivery that fails is recorded as failed and not
    /// retried; an occurrence past the hour is only recorded.
    #[tokio::test]
    async fn receipts_holds_and_failures_are_recorded_the_windows_way() {
        let now = Local::now();
        let due = occurrence_key(&(now - ChronoDuration::minutes(3)));
        let daily = ScheduledAgentPrompt { rule: AgentScheduleRule::Daily { time: due[11..].to_string() }, ..rule_daily("x") };
        let missed = ScheduledAgentPrompt { id: "s-missed".into(), ..rule_once(&occurrence_key(&(now - ChronoDuration::hours(3)))) };
        let fixture = Fixture::new(vec![daily, missed]);
        let recorder = Arc::new(Recorder::default());
        let (ctx, _launched) = context(&fixture, &recorder);
        let secs = now.timestamp() as u64;
        *recorder.probe.lock().unwrap() = Some(SessionProbe { created: secs - 600, activity: secs - 60 });

        // Working: the missed one is recorded, the due one waits.
        fixture.turn(&format!("working {}", secs - 30));
        let events = tick(&ctx, now).await;
        assert!(matches!(events.as_slice(), [Event::Missed { schedule_id, .. }] if schedule_id == "s-missed"), "{events:?}");
        let tasks = fixture.tasks();
        assert!(!tasks.projects[PROJECT][TARGET].schedules.iter().any(|s| s.id == "s-missed"), "a missed once is retired");
        assert!(recorder.delivered.lock().unwrap().is_empty());

        // Done and settled, but the pane goes away mid-delivery: failed, once.
        fixture.turn(&format!("done {}", secs - 10));
        *recorder.fail.lock().unwrap() = true;
        let events = tick(&ctx, now).await;
        assert!(matches!(events.as_slice(), [Event::Failed { schedule_id, .. }] if schedule_id == "s-daily"), "{events:?}");
        let rule = fixture.tasks().projects[PROJECT][TARGET].schedules.iter().find(|s| s.id == "s-daily").cloned().expect("a recurring rule stays");
        let last = rule.last.expect("receipt");
        assert_eq!(last.occurrence, due);
        assert_eq!(last.result, AgentScheduleResult::Failed);
        *recorder.fail.lock().unwrap() = false;
        assert!(tick(&ctx, now).await.is_empty(), "the receipt blocks a retry");
        let history: serde_json::Value = storage::read_json(&agent_prompts::file_path(fixture.state_dir())).unwrap();
        let rows = history["history"][PROJECT].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r["id"] == format!("s-daily@{due}") && r["result"] == "failed"));
        assert!(rows.iter().any(|r| r["id"] == "s-missed" && r["result"] == "missed"));
    }

    /// H2 exit, the exactly-once half: two windows and the sidecar on one
    /// state dir, all ticking at once, deliver a due occurrence exactly
    /// once — the lease keeps one window and the sidecar out, the claim
    /// under the file lock settles whatever the lease left open — and with
    /// no window at all the sidecar is the one that fires.
    #[test]
    fn two_windows_and_the_sidecar_fire_a_schedule_exactly_once() {
        let now = Local::now();
        let key = occurrence_key(&(now - ChronoDuration::minutes(5)));
        let fixture = Fixture::new(vec![rule_once(&key)]);
        let state_dir = fixture.state_dir().to_path_buf();
        let tasks = agent_tasks::file_path(&state_dir);
        let lease = timer_lease::lease_file(&state_dir);
        let secs = now.timestamp() as u64;

        // A window's tick: hold the lease, then claim. The sidecar's: claim
        // only while no window holds it.
        let window = |name: &'static str| {
            let (tasks, lease, key) = (tasks.clone(), lease.clone(), key.clone());
            std::thread::spawn(move || {
                let mut fired = 0;
                for round in 0..5u64 {
                    let held = timer_lease::acquire_in(&lease, name, secs + round, 30).unwrap().held;
                    if held && agent_tasks::claim_in(&tasks, PROJECT, TARGET, "s-once", &key, now) == Ok(true) {
                        fired += 1;
                    }
                }
                fired
            })
        };
        let sidecar = {
            let (tasks, lease, key) = (tasks.clone(), lease.clone(), key.clone());
            std::thread::spawn(move || {
                let mut fired = 0;
                for round in 0..5u64 {
                    if timer_lease::holder_in(&lease, secs + round).is_none()
                        && agent_tasks::claim_in(&tasks, PROJECT, TARGET, "s-once", &key, now) == Ok(true)
                    {
                        fired += 1;
                    }
                }
                fired
            })
        };
        let a = window("window-a");
        let b = window("window-b");
        let total = a.join().unwrap() + b.join().unwrap() + sidecar.join().unwrap();
        assert_eq!(total, 1, "one claim across two windows and the sidecar");

        // No window: the sidecar alone fires, once.
        let fixture = Fixture::new(vec![rule_once(&key)]);
        let tasks = agent_tasks::file_path(fixture.state_dir());
        let lease = timer_lease::lease_file(fixture.state_dir());
        let claims: Vec<bool> = (0..3)
            .map(|_| {
                timer_lease::holder_in(&lease, secs).is_none()
                    && agent_tasks::claim_in(&tasks, PROJECT, TARGET, "s-once", &key, now) == Ok(true)
            })
            .collect();
        assert_eq!(claims, [true, false, false]);
    }

    /// Eight claimants of one occurrence through the file lock alone (no
    /// in-process mutex on this path): one wins.
    #[test]
    fn concurrent_claims_through_the_file_lock_admit_one() {
        let now = Local::now();
        let key = occurrence_key(&(now - ChronoDuration::minutes(5)));
        let fixture = Fixture::new(vec![rule_once(&key)]);
        let tasks = agent_tasks::file_path(fixture.state_dir());
        let won: usize = (0..8)
            .map(|_| {
                let (tasks, key) = (tasks.clone(), key.clone());
                std::thread::spawn(move || agent_tasks::claim_in(&tasks, PROJECT, TARGET, "s-once", &key, now) == Ok(true))
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| usize::from(t.join().unwrap()))
            .sum();
        assert_eq!(won, 1);
    }

    #[tokio::test]
    async fn the_sidecar_stands_down_while_a_window_holds_the_timers() {
        let now = Local::now();
        let key = occurrence_key(&(now - ChronoDuration::minutes(5)));
        let fixture = Fixture::new(vec![rule_once(&key)]);
        let recorder = Arc::new(Recorder::default());
        let secs = now.timestamp() as u64;
        *recorder.probe.lock().unwrap() = Some(SessionProbe { created: secs - 600, activity: secs - 60 });
        let (ctx, _launched) = context(&fixture, &recorder);
        timer_lease::acquire_in(&timer_lease::lease_file(fixture.state_dir()), "window-a", secs, 30).unwrap();
        assert_eq!(tick(&ctx, now).await, vec![Event::WindowHoldsLease("window-a".into())]);
        assert!(recorder.delivered.lock().unwrap().is_empty());
        // The window is gone (its lease ran out): the sidecar takes over.
        let later = now + ChronoDuration::seconds(31);
        assert!(matches!(tick(&ctx, later).await.as_slice(), [Event::Delivered { .. }]));
    }

    /// The keys reach the pane: on a private tmux server a session running
    /// `cat` receives the prefix command, the two-line message and the
    /// submits, in order (the line discipline turns each Enter into `\n`).
    #[cfg(unix)]
    #[test]
    fn keys_reach_the_pane_on_a_private_socket() {
        if !crate::services::tmux_local::tmux_available() {
            return;
        }
        let socket = format!(concat!(crate::app_slug!(), "-test-h2-{}"), std::process::id());
        let session = concat!(crate::app_slug!(), "-p--agent-h2");
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("typed.txt");
        let tmux = |args: &[&str]| {
            std::process::Command::new("tmux")
                .args(["-L", &socket, "-f", "/dev/null"])
                .args(args)
                .output()
                .unwrap()
        };
        let started = tmux(&["new-session", "-d", "-x", "80", "-y", "24", "-s", session, &format!("cat > '{}'", out.display())]);
        assert!(started.status.success(), "{}", String::from_utf8_lossy(&started.stderr));
        let runner = TmuxRunner::new(dir.path(), Some(socket.clone()));
        let probe = runner.probe(session);
        let mut schedule = rule_once("x");
        schedule.preface = vec!["/model opus".into()];
        schedule.message = "hello\nworld".into();
        let delivered = runner.deliver(session, &submissions(&schedule, "claude"));
        let mut typed = String::new();
        for _ in 0..50 {
            typed = std::fs::read_to_string(&out).unwrap_or_default();
            if typed.contains("world\n") {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = tmux(&["kill-server"]);
        delivered.unwrap();
        assert!(probe.is_some_and(|p| p.created > 0), "the probe reads the live session");
        assert!(runner.probe(concat!(crate::app_slug!(), "-p--agent-none")).is_none());
        let model = typed.find("/model opus\n").expect("the prefix command, submitted");
        let message = typed.find("hello\nworld\n").expect("the message with its newline, submitted");
        assert!(model < message, "prefix first: {typed:?}");
        assert!(!runner.paste_file.exists(), "the staged submission is removed");
    }

    /// H3: the owner's close ends the tab's session on the server and the
    /// process it ran; a second kill of a session already gone is fine.
    #[cfg(unix)]
    #[test]
    fn a_kill_ends_the_session_and_its_process_on_a_private_socket() {
        if !crate::services::tmux_local::tmux_available() {
            return;
        }
        let socket = format!(concat!(crate::app_slug!(), "-test-h3-{}"), std::process::id());
        let session = concat!(crate::app_slug!(), "-p--shell-h3");
        let dir = tempfile::tempdir().unwrap();
        let tmux = |args: &[&str]| {
            std::process::Command::new("tmux")
                .args(["-L", &socket, "-f", "/dev/null"])
                .args(args)
                .output()
                .unwrap()
        };
        let started = tmux(&["new-session", "-d", "-x", "80", "-y", "24", "-s", session, "sleep 300"]);
        assert!(started.status.success(), "{}", String::from_utf8_lossy(&started.stderr));
        let pid = tmux(&["display-message", "-p", "-t", &format!("={session}:"), "#{pane_pid}"]);
        let pid: u32 = String::from_utf8_lossy(&pid.stdout).trim().parse().expect("pane pid");
        let runner = TmuxRunner::new(dir.path(), Some(socket.clone()));
        assert!(runner.probe(session).is_some());
        let killed = runner.kill(session);
        let again = runner.kill(session);
        let mut alive = true;
        for _ in 0..50 {
            alive = std::path::Path::new(&format!("/proc/{pid}")).exists()
                && std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| !s.contains(") Z "));
            if !alive {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = tmux(&["kill-server"]);
        killed.unwrap();
        again.unwrap();
        assert!(runner.probe(session).is_none(), "the session is gone");
        assert!(!alive, "the pane's process was reaped");
    }
}
