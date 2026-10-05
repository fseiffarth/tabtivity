//! The turn state an agent's **own hooks** report — working, blocked on a
//! decision, finished — carried from the hook script's record file to the
//! window as an `agent-turn` event keyed by PTY id.
//!
//! Why this exists: the working / decision / finished marks on a tab used to be
//! inferred from the bytes the agent painted, and every agent TUI defeats that
//! in its own way. Codex repaints a braille spinner and its terminal title on a
//! 100 ms timer whether it is working, blocked or idle, and while it works the
//! only *text* that changes is a once-a-second timer; Claude Code goes silent
//! when it stops but animates a spinner cell while it waits on a tool. Two
//! rounds of filtering (drop empty frames, drop braille cells) each fixed one
//! agent's habit and broke another's reading. The agents themselves know
//! exactly when a turn starts (`UserPromptSubmit`), pauses on the user
//! (`Notification` with `permission_prompt`), resumes (`PostToolUse`) and ends
//! (`Stop`), and both Claude Code and Codex run Tabtivity's hook script on those
//! events already (see `services::agent_session`). The script writes one small
//! record per tab, `<live_sessions>/<TABTIVITY_TAB_UID>.turn`, holding the state
//! word; this module watches that directory and hands the state to the
//! frontend's activity store, which treats it as the authority for the tab and
//! keeps the byte heuristic only for agents that fire no hooks (Gemini, Qwen,
//! a custom command, a Codex whose hooks are not yet trusted).
//!
//! The record is keyed by the tab's launch uid, which the frontend never sees;
//! `pty_spawn` registers the uid → PTY id pair here (and clears a record left
//! by a previous run, so a tab never restarts "working" off a stale file), and
//! the watcher resolves each record to the PTY id the activity store already
//! keys everything by. Inside the agent fence a project's own live-sessions
//! slice is mounted at the shared root's path, so on the host the file lands
//! in `<live_sessions>/<project>/`; the watch is recursive for that reason.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::services::agent_session::{
    live_sessions_dir, project_live_sessions_dir, read_live_source_in, LIVE_SOURCE_SUFFIX,
};

/// Suffix of the per-tab turn record beside the session record (`<uid>.turn`).
pub const TURN_SUFFIX: &str = ".turn";

/// The event the frontend listens for: `{ id: <pty id>, state: <word> }`.
pub const TURN_EVENT: &str = "agent-turn";

/// How the tab's session just (re)started, relayed from the hook's source
/// record: `{ id: <pty id>, source: "startup" | "resume" | "clear" | "compact" }`.
/// A `clear` is what offers the terminal's "Undo clear".
pub const ROLL_EVENT: &str = "agent-session-roll";

/// What the hook script may write. `Idle` (a `SessionEnd`) means the agent is
/// gone and the tab is back to whatever its bytes say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    Working,
    Decision,
    Done,
    Idle,
}

impl TurnState {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnState::Working => "working",
            TurnState::Decision => "decision",
            TurnState::Done => "done",
            TurnState::Idle => "idle",
        }
    }
}

/// Parse a turn record: the state word, optionally followed by the epoch
/// seconds the hook wrote it (kept for diagnosis; the window stamps receipt).
/// Anything else — an empty file mid-write, a word from a newer script — is
/// `None`, never a guess.
pub fn parse_turn_record(text: &str) -> Option<TurnState> {
    let word = text.split_whitespace().next()?;
    match word {
        "working" => Some(TurnState::Working),
        "decision" => Some(TurnState::Decision),
        "done" => Some(TurnState::Done),
        "idle" => Some(TurnState::Idle),
        _ => None,
    }
}

/// uid → PTY id, for every agent tab spawned this run.
fn bindings() -> &'static Mutex<HashMap<String, String>> {
    static B: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remember that the tab whose hooks key by `uid` is the PTY `pty_id`, and
/// forget any turn record an earlier run of that tab left behind — a resumable
/// tab keeps its uid across relaunches, and a `working` written before a crash
/// or quit would otherwise be the first thing the watcher reports for it.
///
/// Returns whether that record held a turn still in flight: the previous
/// process of this tab died mid-turn (a quit SIGKILLs agents, so no `Stop` or
/// `SessionEnd` ever overwrote it), and the tab starts out interrupted.
pub fn bind_tab(uid: &str, pty_id: &str, project_id: Option<&str>) -> bool {
    if uid.is_empty() || uid.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return false;
    }
    // One PTY, one uid: a respawn under a new uid must not leave the old key
    // pointing at this PTY, nor its turn state and job flag behind it.
    on_tab_gone(pty_id);
    bindings().lock().unwrap().insert(uid.to_string(), pty_id.to_string());
    states().lock().unwrap().remove(uid);
    jobs().lock().unwrap().remove(uid);
    settled().lock().unwrap().remove(uid);
    let cut_off = records_hold_turn_in_flight(&record_paths(uid, project_id));
    clear_record(uid, project_id);
    cut_off
}

/// Whether any of a tab's turn records says `working` or `decision` — a turn
/// begun and never ended.
fn records_hold_turn_in_flight(paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| {
        std::fs::read_to_string(p)
            .ok()
            .and_then(|text| parse_turn_record(&text))
            .is_some_and(|state| matches!(state, TurnState::Working | TurnState::Decision))
    })
}

/// Drop the binding(s) of a PTY that is gone, and whatever was recorded about
/// its turn: a key reused by a later tab must start blank.
pub fn on_tab_gone(pty_id: &str) {
    let mut b = bindings().lock().unwrap();
    let gone: Vec<String> =
        b.iter().filter(|(_, v)| v.as_str() == pty_id).map(|(k, _)| k.clone()).collect();
    b.retain(|_, v| v != pty_id);
    drop(b);
    let mut states = states().lock().unwrap();
    let mut jobs = jobs().lock().unwrap();
    let mut settled = settled().lock().unwrap();
    for uid in gone {
        states.remove(&uid);
        jobs.remove(&uid);
        settled.remove(&uid);
    }
}

/// The PTY id bound to `uid`, if any.
pub fn pty_for(uid: &str) -> Option<String> {
    bindings().lock().unwrap().get(uid).cloned()
}

fn record_paths(uid: &str, project_id: Option<&str>) -> Vec<PathBuf> {
    let name = format!("{uid}{TURN_SUFFIX}");
    let mut paths = vec![live_sessions_dir().join(&name)];
    if let Some(pid) = project_id {
        paths.push(project_live_sessions_dir(pid).join(&name));
    }
    paths
}

/// Remove the turn record(s) for `uid`: the shared root's and, when the tab has
/// a project, the project's own slice (where a fenced or contained agent's
/// hook writes).
pub fn clear_record(uid: &str, project_id: Option<&str>) {
    for p in record_paths(uid, project_id) {
        let _ = std::fs::remove_file(p);
    }
}

/// The uid a record path stands for, or `None` for any other file.
fn uid_of(path: &Path) -> Option<String> {
    uid_with_suffix(path, TURN_SUFFIX)
}

/// The uid a `<uid><suffix>` record path stands for.
fn uid_with_suffix(path: &Path, suffix: &str) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let uid = name.strip_suffix(suffix)?;
    if uid.is_empty() || uid.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return None;
    }
    Some(uid.to_string())
}

/// What one filesystem event on `path` means for the window: the PTY it maps to
/// and the state now in the file. `None` when the path is not a record, is not
/// a tab of this run, or holds nothing readable (a removal, a half-written
/// file — the next write will say).
pub fn resolve_event(path: &Path) -> Option<(String, TurnState)> {
    let uid = uid_of(path)?;
    let pty = pty_for(&uid)?;
    let text = std::fs::read_to_string(path).ok()?;
    let state = parse_turn_record(&text)?;
    Some((pty, state))
}

/// What a write of a session's source record (`<uid>.src`, see
/// `agent_session::LIVE_SOURCE_SUFFIX`) means for the window: the PTY and how
/// the tab's session just (re)started. `None` for any other file, a tab of
/// another run, or a word the hook should not have written.
pub fn resolve_roll_event(path: &Path) -> Option<(String, String)> {
    let uid = uid_with_suffix(path, LIVE_SOURCE_SUFFIX)?;
    let pty = pty_for(&uid)?;
    let source = read_live_source_in(path.parent()?, &uid)?;
    Some((pty, source))
}

#[derive(serde::Serialize, Clone)]
struct RollPayload {
    id: String,
    source: String,
}

#[derive(serde::Serialize, Clone)]
struct TurnPayload {
    id: String,
    state: &'static str,
    /// Whether a shell this agent started was running at the last scan (see
    /// [`refresh_jobs`]). It rides every event rather than being folded into
    /// `state` because the two are independent: a turn that is over while a
    /// background job runs is not a finished tab, and a turn being worked with
    /// a command running alongside it is two things at once — which is what
    /// lets the window paint the agent's work and its commands apart.
    job: bool,
}

/// How often the tool-shell scan runs while agent tabs are bound. What it
/// answers ("is a command of this agent's still running?") only has to be fresh
/// to a couple of seconds, and the walk costs one `stat` read per process plus
/// an `environ` read per shell.
const JOB_POLL: Duration = Duration::from_secs(2);

/// How stale a scan may be before a hook record triggers a fresh one. Records
/// arrive in bursts — a `PostToolUse` per tool, several a second for quick ones
/// — and walking `/proc` for each of them would cost more than the flag is
/// worth; within this window the last scan's answer is reused.
const JOB_SCAN_MAX_AGE: Duration = Duration::from_millis(500);

/// How often the scan still runs when every tab it would ask about is
/// [`settled`]: a backstop for a job that starts without any hook saying so,
/// not the cadence anything relies on.
const JOB_POLL_SETTLED: Duration = Duration::from_secs(30);

/// uids whose last scan found nothing to report while their turn was over
/// (`done`) or paused on the user (`decision`). Such a tab cannot grow a job
/// until its agent acts again, and an agent acting is a hook record — which
/// [`note_state`] turns into an unsettle — so the idle 2 s walk of `/proc` is
/// skipped while every tab is settled (see [`job_poll_due`]). A fleet of agent
/// tabs sitting finished is the resting state of the app; this is what makes
/// it cost no process-table walks.
fn settled() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Whether the timer-driven scan has anything to find: some tab whose hooks
/// have spoken is not [`settled`], or the backstop interval is up.
fn job_poll_due() -> bool {
    let last = *last_scan().lock().unwrap();
    let bound: Vec<String> = bindings().lock().unwrap().keys().cloned().collect();
    let states = states().lock().unwrap();
    let settled = settled().lock().unwrap();
    poll_due(
        last,
        bound.iter().filter(|uid| states.contains_key(*uid)).map(|uid| settled.contains(uid)),
    )
}

/// The rule of [`job_poll_due`]: look when no scan is on record or the last
/// one is older than [`JOB_POLL_SETTLED`], or when any asked-about tab (one
/// `bool` each: is it settled) is not settled.
fn poll_due(last_scan: Option<Instant>, mut settled_flags: impl Iterator<Item = bool>) -> bool {
    last_scan.is_none_or(|at| at.elapsed() >= JOB_POLL_SETTLED) || settled_flags.any(|s| !s)
}

/// uid → whether a shell of that agent's was running at the last scan.
fn jobs() -> &'static Mutex<HashMap<String, bool>> {
    static J: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

/// uid → the state its hooks last reported, so a job that starts or ends can be
/// relayed on its own, without waiting for the agent to say anything next. The
/// state is also half of what makes a running shell a BACKGROUND job (see
/// [`is_background_job`]).
fn states() -> &'static Mutex<HashMap<String, TurnState>> {
    static S: OnceLock<Mutex<HashMap<String, TurnState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// When [`refresh_jobs`] last walked `/proc`.
fn last_scan() -> &'static Mutex<Option<Instant>> {
    static L: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

/// Record what the hooks just said about `uid`. `Idle` is the session's end:
/// its state and job flag go with it.
fn note_state(uid: &str, state: TurnState) {
    // Whatever the agent just did, the next timer tick must look again.
    settled().lock().unwrap().remove(uid);
    if state == TurnState::Idle {
        states().lock().unwrap().remove(uid);
        jobs().lock().unwrap().remove(uid);
        return;
    }
    states().lock().unwrap().insert(uid.to_string(), state);
}

/// Whether a shell of `uid`'s agent was running at the last scan.
fn job_flag(uid: &str) -> bool {
    jobs().lock().unwrap().get(uid).copied().unwrap_or(false)
}

/// One scan of the tool shells the bound tabs are running, and what the change
/// is worth telling the window: `(pty, last state, job)` for every tab whose
/// flag MOVED. `except` is the tab whose own verdict the caller is emitting in
/// the same breath — its flag is updated, its event left to the caller. A tab
/// whose hooks have said nothing yet is skipped: there is no state to carry the
/// flag on. A scan younger than [`JOB_SCAN_MAX_AGE`] is reused as it stands.
fn refresh_jobs(except: Option<&str>) -> Vec<(String, TurnState, bool)> {
    {
        let mut last = last_scan().lock().unwrap();
        if last.is_some_and(|at| at.elapsed() < JOB_SCAN_MAX_AGE) {
            return Vec::new();
        }
        *last = Some(Instant::now());
    }
    let bound: Vec<(String, String)> = bindings()
        .lock()
        .unwrap()
        .iter()
        .map(|(uid, pty)| (uid.clone(), pty.clone()))
        .collect();
    let states = states().lock().unwrap();
    // Only a tab whose hooks have spoken can be asked about: the state is what
    // tells a backgrounded shell from the tool call the agent is waiting on, and
    // a tab with no state has no event to carry a flag on either.
    let want: HashMap<&str, TurnState> = bound
        .iter()
        .filter_map(|(uid, _)| states.get(uid).map(|state| (uid.as_str(), *state)))
        .collect();
    let live = tool_shell_uids(&want);
    let mut jobs = jobs().lock().unwrap();
    let mut out = Vec::new();
    for (uid, pty) in &bound {
        let running = live.contains(uid.as_str());
        // A tab first seen without a job has nothing to announce: absent and
        // `false` are the same statement, and only a transition is news.
        let moved = jobs.insert(uid.clone(), running).unwrap_or(false) != running;
        if !moved || except == Some(uid.as_str()) {
            continue;
        }
        if let Some(state) = states.get(uid) {
            out.push((pty.clone(), *state, running));
        }
    }
    // A tab that is gone takes its flag with it (`on_tab_gone` does the same for
    // one closed between scans).
    jobs.retain(|uid, _| want.contains_key(uid.as_str()));
    // Settle every tab this scan cleared whose agent is not mid-turn. Taken
    // while `states` is still held, so a record noted after the walk (which
    // unsettles) cannot be overwritten by this scan's stale verdict.
    let mut settled = settled().lock().unwrap();
    settled.retain(|uid| want.contains_key(uid.as_str()));
    for (uid, state) in &want {
        if !live.contains(*uid) && matches!(state, TurnState::Done | TurnState::Decision) {
            settled.insert((*uid).to_string());
        } else {
            settled.remove(*uid);
        }
    }
    out
}

/// Shells a tool call runs in. A background job is one of these, never one of
/// the agent's other long-lived children (an MCP server, Codex's code-mode host).
#[cfg(any(target_os = "linux", test))]
const SHELL_COMMS: &[&str] = &["bash", "sh", "dash", "zsh", "fish", "ksh", "mksh"];

/// Whether a process is a shell the agent started for a tool call: a shell
/// running Claude Code's Bash-tool wrapper (it sources the CLI's shell
/// snapshot), or a shell whose parent is Codex (or its sandbox helper, whose
/// 15-byte `comm` still starts with `codex`). The tab's launcher shell
/// (`bash -c 'claude' …`, the fence's launch script) is neither.
#[cfg(any(target_os = "linux", test))]
fn is_agent_tool_shell(comm: &str, cmdline: &str, parent_comm: &str) -> bool {
    SHELL_COMMS.contains(&comm)
        && (cmdline.contains("/shell-snapshots/snapshot-") || parent_comm.starts_with("codex"))
}

/// How Claude Code's Bash tool spells "and don't wait for it": the backgrounded
/// command is the only one whose wrapper redirects stdin, so the eval'd string
/// is followed by `< /dev/null` before the wrapper's trailing `pwd -P`. A
/// foreground call has the two adjacent. Measured against a running tab
/// (2026-09-20), both jobs and tool calls, and matched as that whole seam so a
/// `< /dev/null` INSIDE the command (which lands before the closing quote)
/// cannot be mistaken for it.
#[cfg(any(target_os = "linux", test))]
const CLAUDE_BACKGROUND_SEAM: &str = "' < /dev/null && pwd -P >|";

/// Whether a tool shell that is running is one the agent put in the BACKGROUND
/// — the thing worth its own mark — rather than the tool call it is sitting and
/// waiting on. Two readings, and either is enough:
///
///  - the turn is over (`done`): whatever is still running outlived it, which is
///    the definition of a background job and the reading this started as. It is
///    also the net under the other one: no wrapper spelling can betray it.
///  - Claude's wrapper says so ([`CLAUDE_BACKGROUND_SEAM`]) — the only reading
///    that can tell the two apart WHILE a turn runs, which is what makes the
///    "agent and a command at once" mark possible.
///
/// Codex has no such seam, so a background exec of its own is only seen once its
/// turn ends. Better that than every `bash -lc` it waits on reading as a job.
#[cfg(any(target_os = "linux", test))]
fn is_background_job(cmdline: &str, state: TurnState) -> bool {
    state == TurnState::Done || cmdline.contains(CLAUDE_BACKGROUND_SEAM)
}

/// The tab uid a NUL-separated environment block belongs to, if it sets one.
#[cfg(any(target_os = "linux", test))]
fn environ_uid(environ: &[u8]) -> Option<String> {
    environ
        .split(|b| *b == 0)
        .find_map(|kv| kv.strip_prefix(concat!(crate::app_env!("TAB_UID"), "=").as_bytes()))
        .and_then(|v| std::str::from_utf8(v).ok())
        .map(str::to_string)
}

/// Which of the tabs in `want` (uid → the state its hooks last reported) have a
/// BACKGROUND job of their agent's running right now — one walk of `/proc` for
/// the whole fleet, since a walk per tab is the same work repeated. What counts
/// as backgrounded, rather than a tool call the agent is waiting on, is
/// [`is_background_job`].
///
/// The PTY's process tree cannot answer this — an agent tab runs under tmux, so
/// the agent hangs off the tmux server, not the tab's PTY — but every process
/// under the tab inherits `TABTIVITY_TAB_UID`, fenced ones included (bubblewrap
/// moves the pid namespace, not the owner, so the host still reads their
/// environ). Linux reads `/proc`; elsewhere no tab ever reports a job. A
/// contained agent's shells belong to the container's user and a remote one's
/// live on its host, so those report none either.
#[cfg(target_os = "linux")]
fn tool_shell_uids(want: &HashMap<&str, TurnState>) -> std::collections::HashSet<String> {
    fn stat_of(pid: &str) -> Option<(String, String)> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let comm = stat.get(stat.find('(')? + 1..stat.rfind(')')?)?.to_string();
        let ppid = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.to_string();
        Some((comm, ppid))
    }
    let mut out = std::collections::HashSet::new();
    if want.is_empty() {
        return out;
    }
    let Ok(dir) = std::fs::read_dir("/proc") else { return out };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().filter(|n| n.bytes().all(|b| b.is_ascii_digit())) else {
            continue;
        };
        // `comm` first: a stat read is cheap, and only shells go on to have
        // their environment read.
        let Some((comm, ppid)) = stat_of(pid) else { continue };
        if !SHELL_COMMS.contains(&comm.as_str()) {
            continue;
        }
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else { continue };
        let Some(uid) = environ_uid(&environ) else { continue };
        let Some(state) = want.get(uid.as_str()) else { continue };
        if out.contains(&uid) {
            continue;
        }
        let cmdline = crate::sysstat::cmdline(pid.parse().unwrap_or(0)).unwrap_or_default();
        let parent_comm = stat_of(&ppid).map(|(c, _)| c).unwrap_or_default();
        if is_agent_tool_shell(&comm, &cmdline, &parent_comm) && is_background_job(&cmdline, *state) {
            out.insert(uid);
        }
    }
    out
}

#[cfg(not(target_os = "linux"))]
fn tool_shell_uids(_want: &HashMap<&str, TurnState>) -> std::collections::HashSet<String> {
    std::collections::HashSet::new()
}

/// Watch the live-sessions tree for turn records and relay each write as an
/// `agent-turn` event. Runs for the app's lifetime on its own thread; a watcher
/// that cannot be created only costs the hook path (the activity store falls
/// back to its byte heuristic), so failures are logged and swallowed.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        use notify::{RecursiveMode, Watcher};
        use std::sync::mpsc::RecvTimeoutError;
        let root = live_sessions_dir();
        if let Err(e) = std::fs::create_dir_all(&root) {
            eprintln!("agent_turn: create {}: {e}", root.display());
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if !(ev.kind.is_create() || ev.kind.is_modify()) {
                return;
            }
            for p in ev.paths {
                if p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(TURN_SUFFIX) || n.ends_with(LIVE_SOURCE_SUFFIX))
                {
                    let _ = tx.send(p);
                }
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("agent_turn: watcher: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!("agent_turn: watch {}: {e}", root.display());
            return;
        }
        let emit = |id: String, state: TurnState, job: bool| {
            let _ = app.emit(TURN_EVENT, TurnPayload { id, state: state.as_str(), job });
        };
        // Keep the watcher alive for as long as events flow; the loop ends only
        // when the sender side is dropped, i.e. never before the app exits. The
        // timeout is the tool-shell poll, which costs nothing while no tab is
        // bound.
        loop {
            match rx.recv_timeout(JOB_POLL) {
                Ok(path) => {
                    // A source record says how the session rolled (a `/clear`,
                    // a `/resume`); it carries no turn state.
                    if let Some((id, source)) = resolve_roll_event(&path) {
                        let _ = app.emit(ROLL_EVENT, RollPayload { id, source });
                        continue;
                    }
                    if let (Some((id, state)), Some(uid)) = (resolve_event(&path), uid_of(&path)) {
                        note_state(&uid, state);
                        // The flag beside a brand-new verdict is this moment's,
                        // not the last poll's: a `done` lands the instant the
                        // agent's last tool finished, and a job that ended with
                        // it must not be reported as still running.
                        for (pty, st, job) in refresh_jobs(Some(&uid)) {
                            emit(pty, st, job);
                        }
                        emit(id, state, job_flag(&uid));
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !job_poll_due() {
                        continue;
                    }
                    for (pty, st, job) in refresh_jobs(None) {
                        emit(pty, st, job);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(watcher);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_state_word_and_refuses_the_rest() {
        assert_eq!(parse_turn_record("working 1758000000"), Some(TurnState::Working));
        assert_eq!(parse_turn_record("decision"), Some(TurnState::Decision));
        assert_eq!(parse_turn_record("done 1\n"), Some(TurnState::Done));
        assert_eq!(parse_turn_record("idle"), Some(TurnState::Idle));
        assert_eq!(parse_turn_record(""), None);
        assert_eq!(parse_turn_record("thinking"), None);
    }

    #[test]
    fn record_paths_are_keyed_by_uid_and_only_uid_shaped_names_resolve() {
        assert_eq!(
            uid_of(Path::new("/x/live/1111-aaaa.turn")).as_deref(),
            Some("1111-aaaa")
        );
        assert_eq!(uid_of(Path::new("/x/live/1111-aaaa")), None);
        assert_eq!(uid_of(Path::new("/x/live/1111-aaaa.mode")), None);
        assert_eq!(uid_of(Path::new("/x/live/a.b.turn")), None);
        assert_eq!(uid_of(Path::new("/x/live/.turn")), None);
    }

    #[test]
    fn binding_maps_a_record_to_its_pty_and_a_gone_pty_unbinds() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-turn-{}-{}"), std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let uid = "turn-test-uid-1";
        let pty = "proj-a:agent-turn-1";
        // No binding: a record is nobody's.
        let rec = dir.join(format!("{uid}{TURN_SUFFIX}"));
        std::fs::write(&rec, "working 1").unwrap();
        assert_eq!(resolve_event(&rec), None);
        // A record path with a bad uid never resolves, bound or not.
        bindings().lock().unwrap().insert(uid.to_string(), pty.to_string());
        assert_eq!(resolve_event(&rec), Some((pty.to_string(), TurnState::Working)));
        std::fs::write(&rec, "decision 2").unwrap();
        assert_eq!(resolve_event(&rec), Some((pty.to_string(), TurnState::Decision)));
        std::fs::write(&rec, "").unwrap();
        assert_eq!(resolve_event(&rec), None);
        on_tab_gone(pty);
        assert_eq!(pty_for(uid), None);
        std::fs::write(&rec, "done").unwrap();
        assert_eq!(resolve_event(&rec), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_leftover_record_mid_turn_reads_as_cut_off() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-turn-{}-{}"), std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.join("a.turn");
        let slice = dir.join("b.turn");
        assert!(!records_hold_turn_in_flight(&[root.clone(), slice.clone()]));
        for (word, cut) in [("working 1", true), ("decision 2", true), ("done 3", false), ("idle 4", false), ("", false)] {
            std::fs::write(&slice, word).unwrap();
            assert_eq!(records_hold_turn_in_flight(&[root.clone(), slice.clone()]), cut, "{word:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebinding_a_pty_forgets_its_previous_uid_and_refuses_a_bad_one() {
        let pty = "proj-b:agent-turn-2";
        bind_tab("old-uid-2", pty, None);
        bind_tab("new-uid-2", pty, None);
        assert_eq!(pty_for("old-uid-2"), None);
        assert_eq!(pty_for("new-uid-2").as_deref(), Some(pty));
        assert!(!bind_tab("../escape", pty, None));
        assert_eq!(pty_for("../escape"), None);
        assert_eq!(pty_for("new-uid-2").as_deref(), Some(pty));
        on_tab_gone(pty);
        assert_eq!(pty_for("new-uid-2"), None);
    }

    #[test]
    fn only_the_agents_own_tool_shells_count_as_background_jobs() {
        let claude_tool = "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh 2>/dev/null || true && eval 'npm test'";
        assert!(is_agent_tool_shell("bash", claude_tool, "claude"));
        assert!(is_agent_tool_shell("bash", "/bin/bash -lc cargo build", "codex"));
        assert!(is_agent_tool_shell("bash", "bash -lc sleep 60", "codex-linux-san"));
        // The tab's launcher, a Codex helper, an MCP server: none is a job.
        assert!(!is_agent_tool_shell("bash", "bash -c claude --resume x; exec bash -l", "tmux: server"));
        assert!(!is_agent_tool_shell("codex-code-mod", "codex-code-mode-host", "codex"));
        assert!(!is_agent_tool_shell("node", "node mcp-server.js", "claude"));
        // The snapshot path marks a shell, not whatever the shell runs.
        assert!(!is_agent_tool_shell("npm", claude_tool, "bash"));
    }

    #[test]
    fn only_a_backgrounded_command_is_a_job_while_the_turn_runs() {
        // Both lines are Claude's Bash-tool wrapper as a running tab writes it
        // (measured 2026-09-20); the `< /dev/null` seam is the whole difference.
        let fg = "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh 2>/dev/null || true && eval 'npm test' && pwd -P >| /tmp/claude-e9e6-cwd";
        let bg = "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh 2>/dev/null || true && eval 'sleep 300; echo done' < /dev/null && pwd -P >| /tmp/claude-89e8-cwd";
        assert!(!is_background_job(fg, TurnState::Working));
        assert!(is_background_job(bg, TurnState::Working));
        // A `< /dev/null` the USER wrote lands inside the eval'd string, before
        // its closing quote, so it is not the seam.
        let inner = "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh 2>/dev/null || true && eval 'npm test < /dev/null' && pwd -P >| /tmp/claude-1111-cwd";
        assert!(!is_background_job(inner, TurnState::Working));
        // Once the turn is over, anything still running outlived it — the
        // reading that needs no wrapper spelling, and Codex's only one.
        assert!(is_background_job(fg, TurnState::Done));
        assert!(is_background_job("bash -lc cargo build", TurnState::Done));
        assert!(!is_background_job("bash -lc cargo build", TurnState::Decision));
    }

    #[test]
    fn environ_match_is_exact_on_the_uid() {
        let env = concat!("HOME=/h\0", crate::app_env!("TAB_UID"), "=aaaa-1\0PATH=/bin\0").as_bytes();
        assert_eq!(environ_uid(env).as_deref(), Some("aaaa-1"));
        assert_eq!(environ_uid(concat!("X_", crate::app_env!("TAB_UID"), "=aaaa-1\0").as_bytes()), None);
        assert_eq!(environ_uid(b"HOME=/h\0"), None);
    }

    /// Force the next `refresh_jobs` to walk `/proc` rather than reuse the last
    /// scan (which a sibling test may have taken a moment ago).
    fn rescan() {
        *last_scan().lock().unwrap() = None;
    }

    /// A scan reports every bound tab's change, so two tests scanning at once
    /// would take each other's events. They run one at a time.
    fn scan_lock() -> &'static Mutex<()> {
        static S: OnceLock<Mutex<()>> = OnceLock::new();
        S.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn a_tab_with_no_job_reports_none_and_says_so_only_once() {
        let _guard = scan_lock().lock().unwrap_or_else(|e| e.into_inner());
        let uid = format!("job-none-{}", std::process::id());
        let pty = "proj-j:agent-none";
        bind_tab(&uid, pty, None);
        note_state(&uid, TurnState::Working);
        rescan();
        // Nothing carries this uid: the flag starts false and stays false, so
        // the first scan settles it and no later one has anything to report.
        assert!(refresh_jobs(None).iter().all(|(p, _, _)| p != pty));
        assert!(!job_flag(&uid));
        rescan();
        assert!(refresh_jobs(None).iter().all(|(p, _, _)| p != pty));
        on_tab_gone(pty);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_live_backgrounded_shell_is_a_job_and_a_live_tool_call_is_not() {
        let _guard = scan_lock().lock().unwrap_or_else(|e| e.into_inner());
        let bg_uid = format!("job-bg-{}", std::process::id());
        let fg_uid = format!("job-fg-{}", std::process::id());
        let bg_pty = "proj-j:agent-bg";
        let fg_pty = "proj-j:agent-fg";
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-job-{}"), std::process::id()));
        let snap = tmp.join("shell-snapshots");
        std::fs::create_dir_all(&snap).unwrap();
        let snapshot = snap.join("snapshot-bash-test.sh");
        std::fs::write(&snapshot, "").unwrap();
        bind_tab(&bg_uid, bg_pty, None);
        bind_tab(&fg_uid, fg_pty, None);
        // Both agents are mid-turn: one backgrounded a command, the other is
        // waiting on the tool call in front of it.
        note_state(&bg_uid, TurnState::Working);
        note_state(&fg_uid, TurnState::Working);
        // Claude's wrapper, both spellings (the trailing `&& pwd -P` is what
        // keeps bash from exec-ing into `sleep`, exactly as the real one does).
        let cwd_file = tmp.join("cwd");
        let spawn = |uid: &str, redirect: &str| {
            std::process::Command::new("bash")
                .arg("-c")
                .arg(format!(
                    "source {} 2>/dev/null || true && eval 'sleep 30'{redirect} && pwd -P >| {}",
                    snapshot.display(),
                    cwd_file.display(),
                ))
                .env(crate::app_env!("TAB_UID"), uid)
                .spawn()
                .unwrap()
        };
        let mut backgrounded = spawn(&bg_uid, " < /dev/null");
        let mut foreground = spawn(&fg_uid, "");
        // The scan that raises the flag after the fact carries the state the
        // hooks last reported, so the window can paint it without the agent
        // having to say anything more.
        let mut announced = false;
        let raised = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            rescan();
            announced |=
                refresh_jobs(None).contains(&(bg_pty.to_string(), TurnState::Working, true));
            job_flag(&bg_uid)
        });
        assert!(raised, "the scan never found the backgrounded shell");
        assert!(announced, "the flag went up without an event");
        // The tool call the other agent is waiting on is not a job: it is what
        // "working" already says.
        assert!(!job_flag(&fg_uid), "a foreground tool call was read as a job");
        // A flag that has not moved is not re-announced.
        rescan();
        assert!(refresh_jobs(None).iter().all(|(p, _, _)| p != bg_pty));
        // Its turn ends while it still runs: now it HAS outlived the turn, and
        // that reading needs no wrapper spelling (it is Codex's only one).
        note_state(&fg_uid, TurnState::Done);
        rescan();
        assert!(refresh_jobs(None).contains(&(fg_pty.to_string(), TurnState::Done, true)));
        // The tab whose verdict the caller is emitting is left to the caller,
        // flag updated all the same.
        let _ = backgrounded.kill();
        let _ = backgrounded.wait();
        let _ = foreground.kill();
        let _ = foreground.wait();
        rescan();
        assert!(refresh_jobs(Some(&bg_uid)).iter().all(|(p, _, _)| p != bg_pty));
        assert!(!job_flag(&bg_uid));
        on_tab_gone(bg_pty);
        on_tab_gone(fg_pty);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_idle_scan_runs_only_while_some_tab_is_unsettled_or_the_backstop_is_up() {
        let now = Some(Instant::now());
        assert!(!poll_due(now, [true, true].into_iter()));
        assert!(!poll_due(now, std::iter::empty()));
        assert!(poll_due(now, [true, false].into_iter()));
        assert!(poll_due(None, [true].into_iter()));
        let stale = Instant::now().checked_sub(JOB_POLL_SETTLED + Duration::from_secs(1));
        if stale.is_some() {
            assert!(poll_due(stale, [true].into_iter()));
        }
    }

    #[test]
    fn a_finished_tab_with_no_job_settles_until_its_agent_speaks_again() {
        let _guard = scan_lock().lock().unwrap_or_else(|e| e.into_inner());
        let uid = format!("job-settle-{}", std::process::id());
        let pty = "proj-j:agent-settle";
        let is_settled = |uid: &str| settled().lock().unwrap().contains(uid);
        bind_tab(&uid, pty, None);
        // Mid-turn the tab is never settled: a job can start at any moment.
        note_state(&uid, TurnState::Working);
        rescan();
        refresh_jobs(None);
        assert!(!is_settled(&uid));
        // Its turn over and nothing of its own running: settled.
        note_state(&uid, TurnState::Done);
        rescan();
        refresh_jobs(None);
        assert!(is_settled(&uid));
        // Any hook record — the agent acting again — unsettles at once, before
        // any scan has run.
        note_state(&uid, TurnState::Working);
        assert!(!is_settled(&uid));
        note_state(&uid, TurnState::Decision);
        rescan();
        refresh_jobs(None);
        assert!(is_settled(&uid));
        // A gone tab takes its mark with it.
        on_tab_gone(pty);
        assert!(!is_settled(&uid));
    }

    #[test]
    fn a_session_end_forgets_the_tabs_state_and_flag() {
        let uid = format!("job-idle-{}", std::process::id());
        let pty = "proj-j:agent-idle";
        bind_tab(&uid, pty, None);
        note_state(&uid, TurnState::Working);
        jobs().lock().unwrap().insert(uid.clone(), true);
        note_state(&uid, TurnState::Idle);
        assert!(!states().lock().unwrap().contains_key(&uid));
        assert!(!job_flag(&uid));
        on_tab_gone(pty);
    }
}
