//! GitHub Copilot CLI's own conversation store, for the Reader (chat, Diffs,
//! Resume menu) and for the tab's resume.
//!
//! Copilot keeps one folder per session, `<home>/.copilot/session-state/<uuid>/`,
//! holding `events.jsonl` (one `{type, data, id, timestamp, parentId}` record
//! per event; written with the first prompt, not at start) and `workspace.yaml`
//! (`cwd`, `name`, `created_at`, …). Every tab's Copilot lives in its scope's
//! agent home (`services::agent_home`), so that is the only store read — never
//! the user's own. Read out of the 1.0.102 and 1.0.103 runtimes' event schema
//! (`schemas/session-events.schema.json`) and checked against live sessions of
//! both, and of 1.0.105, through a BYOK stub model
//! (`docs/third_party_update_checklist.md`).
//!
//! Resume: Copilot takes `--session-id <uuid>` as "create it, or resume it when
//! it exists", so a tab pins its own conversation by id ([`resolve`]) instead of
//! `--continue` (the folder's newest session, ambiguous for two tabs). A
//! `/new` or an in-CLI `/resume` rolls the session; Copilot's `sessionStart`
//! hook (`agent_hint`) records the new id under the tab's key, the same live
//! record the other CLIs use, and the next spawn pins that one.
//!
//! Turn state: a hook script of its own ([`write_turn_hook`],
//! `copilot_session/turn.sh`) on the events the probe saw fire
//! (`scripts/verify-cli/copilot/hooks.py`, 1.0.112) writes the tab's
//! `live_sessions/<uid>.turn`, which `services::agent_turn` relays as it does
//! for Claude and Codex. Registered by [`register_in_home`] in a hooks file of
//! its own beside the hint's.
//!
//! AppHandle-free.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::services::agent_session::live_sessions_dir;
use crate::services::agent_versions::Seen;
use crate::services::home_io::HomeFile;
use crate::services::{agent_session, home_io};
use crate::storage;
use crate::terminal::PtyOptions;

/// The session's event log inside its folder.
pub const EVENTS: &str = "events.jsonl";
const WORKSPACE: &str = "workspace.yaml";
/// The most of `workspace.yaml` read: a few short keys.
const WORKSPACE_CAP: u64 = 64 * 1024;

/// Where a scope's Copilot keeps its sessions: `<scope home>/.copilot/session-state`.
pub fn session_root(project_id: Option<&str>) -> PathBuf {
    crate::services::agent_home::scope_home(project_id).join(".copilot").join("session-state")
}

/// The folder of session `id` under `root`, when `id` is a uuid and the folder
/// is a real directory (the agent writes it: never a link).
fn session_dir_in(root: &Path, id: &str) -> Option<PathBuf> {
    if !agent_session::is_uuid_shaped(id) {
        return None;
    }
    let dir = root.join(id);
    std::fs::symlink_metadata(&dir).ok()?.is_dir().then_some(dir)
}

/// The event log of session `id` under `root`, when there is one.
fn events_in(root: &Path, id: &str) -> Option<PathBuf> {
    let file = session_dir_in(root, id)?.join(EVENTS);
    std::fs::symlink_metadata(&file).ok()?.is_file().then_some(file)
}

/// The event log of session `id` in the scope's store.
pub fn events_file(project_id: Option<&str>, id: &str) -> Option<PathBuf> {
    events_in(&session_root(project_id), id)
}

/// The session a tab keyed `launch_id` is in: the id the `sessionStart` hook
/// recorded (a `/new` or `/resume` moves it), else the launch id it was
/// pinned to.
pub fn live_id(project_id: Option<&str>, launch_id: &str) -> Option<String> {
    if !agent_session::is_uuid_shaped(launch_id) {
        return None;
    }
    let recorded = agent_session::read_live_session_for(project_id, launch_id).filter(|id| agent_session::is_uuid_shaped(id));
    Some(recorded.unwrap_or_else(|| launch_id.to_string()))
}

/// The event log behind the tab keyed `launch_id`.
pub fn tab_events(project_id: Option<&str>, launch_id: &str) -> Option<PathBuf> {
    events_file(project_id, &live_id(project_id, launch_id)?)
}

// ── Spawn ───────────────────────────────────────────────────────────────────

/// Flags that choose a session; the tab's own pin replaces them.
fn is_session_flag(arg: &str) -> bool {
    matches!(arg, "--continue" | "--resume" | "-r" | "--session-id")
        || arg.starts_with("--resume=")
        || arg.starts_with("--session-id=")
}

/// Pin a Copilot tab to its own session. The tab's key (`TABTIVITY_TAB_UID`,
/// the uuid the window minted for it) is the session id; a live record the
/// `sessionStart` hook wrote (after a `/new` or an in-CLI `/resume`) is
/// followed instead. `--session-id` creates the session on first use and
/// resumes it afterwards, so no existence check is needed and two tabs of one
/// folder never share a conversation. Other args stay; the folder's
/// `--continue` is dropped. Left alone: a remote tab (its store is on the far
/// host), a subcommand (`login`), a print-mode run (`-p`) and a `--connect`.
pub fn resolve(mut opts: PtyOptions) -> PtyOptions {
    let remote = !opts.local_only
        && opts.project_id.as_deref().is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    if remote || opts.cmd != "copilot" {
        return opts;
    }
    // Set unconditionally, as for Claude: the session hook records only for the CLI the tab runs.
    opts.env.insert(agent_session::TAB_AGENT_ENV.to_string(), "copilot".to_string());
    let Some(uid) = opts.env.get(crate::app_env!("TAB_UID")).cloned().filter(|uid| agent_session::is_uuid_shaped(uid)) else {
        return opts;
    };
    let own_run = opts.args.first().is_some_and(|arg| !arg.starts_with('-'))
        || opts.args.iter().any(|arg| matches!(arg.as_str(), "-p" | "--prompt" | "--connect") || arg.starts_with("--prompt="));
    if own_run {
        return opts;
    }
    let id = live_id(opts.project_id.as_deref(), &uid).unwrap_or(uid);
    let mut args = vec!["--session-id".to_string(), id];
    let mut rest = std::mem::take(&mut opts.args).into_iter().peekable();
    while let Some(arg) = rest.next() {
        if !is_session_flag(&arg) {
            args.push(arg);
        } else if matches!(arg.as_str(), "--resume" | "-r" | "--session-id") && rest.peek().is_some_and(|next| !next.starts_with('-')) {
            rest.next();
        }
    }
    opts.args = args;
    opts
}

// ── Turn state (the hook) ───────────────────────────────────────────────────

/// Tabtivity's turn hooks, relative to an agent home: a file of its own in the
/// user hooks folder (Copilot loads every `*.json` there), beside the hint's,
/// rewritten whole when it differs.
pub(crate) const TURN_HOOKS: &str = concat!(".copilot/hooks/", crate::app_slug!(), "-turn.json");
#[cfg(not(windows))]
const TURN_SCRIPT: &str = concat!(crate::app_slug!(), "_copilot_turn.sh");
#[cfg(windows)]
const TURN_SCRIPT: &str = concat!(crate::app_slug!(), "_copilot_turn.ps1");
#[cfg_attr(windows, allow(dead_code))]
const POSIX_TURN: &str = include_str!("copilot_session/turn.sh");
#[cfg_attr(not(windows), allow(dead_code))]
const POWERSHELL_TURN: &str = include_str!("copilot_session/turn.ps1");

/// The events the probe saw fire with the session's id and the script maps
/// to a word: a prompt and a finished tool (also how an approval ends) are
/// working, a shown dialog (`notification`) a decision, `agentStop` and a
/// failed model call done, the session's end idle. Left out: `sessionStart`
/// (the hint's, which also moves the session record), `permissionRequest`
/// (before the rules decide; the notification is the dialog), `preToolUse`,
/// `subagentStart`/`subagentStop` and `preCompact` (no UI for them yet).
pub(crate) const TURN_EVENTS: &[&str] = &[
    "userPromptSubmitted",
    "postToolUse",
    "postToolUseFailure",
    "notification",
    "agentStop",
    "errorOccurred",
    "sessionEnd",
];

/// The oldest release the hooks probe ran against. An older or unknown one
/// gets no turn hooks and keeps the terminal-output reading.
pub const TURN_HOOKS_SINCE: &str = "1.0.112";

/// Whether the release a probe last read takes the turn hooks.
pub fn runs_turn_hooks(seen: Option<&Seen>) -> bool {
    seen.and_then(|seen| seen.version.as_deref())
        .is_some_and(|v| crate::services::agent_versions::version_cmp(v, TURN_HOOKS_SINCE) != std::cmp::Ordering::Less)
}

fn turn_script_path() -> PathBuf {
    storage::state_dir().join("hooks").join(TURN_SCRIPT)
}

fn fill(template: &str, live_dir: &str, quote: fn(&str) -> String) -> String {
    template
        .replace("@DISPLAY@", crate::brand::DISPLAY)
        .replace("@ENV@", concat!(crate::app_upper!(), "_"))
        .replace("@LIVE_DIR@", &quote(live_dir))
        .replace("@TURN_FILE@", TURN_HOOKS.rsplit('/').next().unwrap_or(TURN_HOOKS))
}

/// The POSIX turn script, recording under `live_dir`.
#[cfg_attr(windows, allow(dead_code))]
fn posix_turn_in(live_dir: &str) -> String {
    fill(POSIX_TURN, live_dir, crate::quote::posix)
}

/// The PowerShell twin, for a Windows host.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_turn_in(live_dir: &str) -> String {
    fill(POWERSHELL_TURN, live_dir, crate::quote::powershell).replace("\r\n", "\n").replace('\n', "\r\n")
}

/// Write the turn script beside the session hook. Idempotent; part of
/// `agent_session::install_session_start_hook`.
pub fn write_turn_hook() -> std::io::Result<()> {
    let path = turn_script_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let live = live_sessions_dir().to_string_lossy().into_owned();
    #[cfg(windows)]
    let body = powershell_turn_in(&live);
    #[cfg(not(windows))]
    let body = posix_turn_in(&live);
    if std::fs::read(&path).ok().as_deref() != Some(body.as_bytes()) {
        std::fs::write(&path, body)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(&path)?.permissions();
        if perm.mode() & 0o777 != 0o755 {
            perm.set_mode(0o755);
            std::fs::set_permissions(&path, perm)?;
        }
    }
    Ok(())
}

/// The command Copilot runs for `event`; the path is one quoted word.
fn turn_command(script: &Path, event: &str) -> String {
    #[cfg(windows)]
    {
        format!("powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\" {event}", script.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        format!("{} {event}", crate::quote::posix(&script.to_string_lossy()))
    }
}

/// The hooks file: every [`TURN_EVENTS`] entry runs the script with its name.
fn turn_hooks_json(script: &Path) -> String {
    let key = if cfg!(windows) { "powershell" } else { "bash" };
    let hooks: serde_json::Map<String, Value> = TURN_EVENTS
        .iter()
        .map(|event| {
            let mut hook = json!({ "type": "command", "timeoutSec": 10 });
            hook[key] = json!(turn_command(script, event));
            (event.to_string(), json!([hook]))
        })
        .collect();
    serde_json::to_string_pretty(&json!({ "version": 1, "hooks": hooks })).expect("plain JSON") + "\n"
}

/// Register the turn hooks in one agent home when the installed Copilot takes
/// them (read from the version store, never waiting on a probe), and take the
/// file out otherwise. Part of `agent_session::register_hooks_in_home`.
pub fn register_in_home(home: &Path) {
    let runs = runs_turn_hooks(crate::services::agent_versions::load().get("copilot"));
    register_in_home_gated(home, runs, &turn_script_path());
}

fn register_in_home_gated(home: &Path, runs: bool, script: &Path) {
    let Some(file) = HomeFile::open(home, TURN_HOOKS) else {
        eprintln!("copilot_session: {TURN_HOOKS} in {} is not a plain path; skipped", home.display());
        return;
    };
    let result = if runs {
        let body = turn_hooks_json(script);
        if file.read().as_deref() == Some(body.as_bytes()) { Ok(()) } else { file.write(body.as_bytes()) }
    } else if file.exists() {
        file.remove()
    } else {
        Ok(())
    };
    if let Err(e) = result {
        eprintln!("copilot_session: turn hooks in {}: {e}", home.display());
    }
}

// ── Folder sessions (the Resume menu) ───────────────────────────────────────

/// The `cwd` of the session folder `dir`, from its `workspace.yaml`.
fn workspace_cwd(dir: &Path) -> Option<String> {
    let text = home_io::read_record_capped(&dir.join(WORKSPACE), WORKSPACE_CAP)?;
    text.lines().find_map(|line| yaml_value(line, "cwd"))
}

/// `key: value` on one line, the value unquoted.
fn yaml_value(line: &str, key: &str) -> Option<String> {
    let value = line.strip_prefix(key)?.strip_prefix(':')?.trim();
    let value = match value.as_bytes() {
        [b'\'', .., b'\''] if value.len() >= 2 => value[1..value.len() - 1].replace("''", "'"),
        [b'"', .., b'"'] if value.len() >= 2 => serde_json::from_str::<String>(value).ok()?,
        _ => value.to_string(),
    };
    (!value.is_empty()).then_some(value)
}

/// A folder path as the CLIs record it: no trailing separator.
fn same_dir(a: &str, b: &str) -> bool {
    a.trim_end_matches(['/', '\\']) == b.trim_end_matches(['/', '\\'])
}

/// The session ids of folder `dir` under `root` with their logs' modification
/// times (epoch ms), newest first. A session no prompt went into has no log
/// and is not listed.
fn folder_sessions_in(root: &Path, dir: &str) -> Vec<(String, PathBuf, u64)> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut found: Vec<(String, PathBuf, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let events = events_in(root, &name)?;
            let meta = std::fs::symlink_metadata(&events).ok()?;
            let updated = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
            let cwd = workspace_cwd(&root.join(&name))?;
            same_dir(&cwd, dir).then_some((name, events, updated))
        })
        .collect();
    found.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
    found
}

/// Folder `dir`'s sessions in the scope's store, newest first.
pub fn folder_sessions(project_id: Option<&str>, dir: &str) -> Vec<(String, PathBuf, u64)> {
    folder_sessions_in(&session_root(project_id), dir)
}

/// The event log of session `chat` when it is one of folder `dir`'s.
pub fn folder_chat_file(project_id: Option<&str>, dir: &str, chat: &str) -> Option<PathBuf> {
    let root = session_root(project_id);
    let events = events_in(&root, chat)?;
    let cwd = workspace_cwd(&root.join(chat))?;
    same_dir(&cwd, dir).then_some(events)
}

// ── Records ─────────────────────────────────────────────────────────────────

fn record_type(value: &Value) -> Option<&str> {
    value.get("type").and_then(Value::as_str)
}

/// A subagent's events ride in the session's log, tagged with the call that
/// started it; they are not the session's own conversation.
fn is_subagent_event(value: &Value) -> bool {
    value.pointer("/data/parentToolCallId").is_some_and(|id| !id.is_null())
}

/// The prompt a `user.message` holds. Not a skill's hidden injection
/// (`source: skill-…`), another agent's prompt (`agent-…`) or autopilot's
/// continuation: only what the user typed.
pub(crate) fn prompt_in_record(value: &Value) -> Option<String> {
    if record_type(value)? != "user.message" {
        return None;
    }
    let data = value.get("data")?;
    if data.get("isAutopilotContinuation").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let source = data.get("source").and_then(Value::as_str).unwrap_or_default();
    if source.starts_with("skill-") || source.starts_with("agent-") {
        return None;
    }
    data.get("content")?.as_str().map(str::to_string)
}

/// The text of the session's own `assistant.message` (a tool-only message has none).
pub(crate) fn answer_in_record(value: &Value) -> Option<String> {
    if record_type(value)? != "assistant.message" || is_subagent_event(value) {
        return None;
    }
    let text = value.pointer("/data/content")?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The model a record names: an answer's, or a model switch's.
pub(crate) fn model_in_record(value: &Value) -> Option<&str> {
    match record_type(value)? {
        "assistant.message" if !is_subagent_event(value) => value.pointer("/data/model")?.as_str(),
        "session.model_change" => value.pointer("/data/newModel")?.as_str(),
        _ => None,
    }
}

/// The reasoning effort a model switch sets (`null` clears it).
pub(crate) fn effort_in_record(value: &Value) -> Option<&str> {
    if record_type(value)? != "session.model_change" {
        return None;
    }
    value.pointer("/data/reasoningEffort")?.as_str()
}

/// The context window in use, from `session.usage_info`.
pub(crate) fn tokens_in_record(value: &Value) -> Option<u64> {
    if record_type(value)? != "session.usage_info" {
        return None;
    }
    value.pointer("/data/currentTokens")?.as_u64()
}

/// The shell command a `bash` tool call starts: `(call id, command, description)`.
pub(crate) fn shell_in_record(value: &Value) -> Option<(String, String, Option<String>)> {
    if record_type(value)? != "tool.execution_start" || is_subagent_event(value) {
        return None;
    }
    let data = value.get("data")?;
    if data.get("toolName")?.as_str()? != "bash" {
        return None;
    }
    let args = data.get("arguments")?;
    Some((
        data.get("toolCallId")?.as_str()?.to_string(),
        args.get("command")?.as_str()?.to_string(),
        args.get("description").and_then(Value::as_str).map(str::to_string),
    ))
}

/// The subagent a `task` tool call starts: `(call id, task, agent type)`.
pub(crate) fn spawn_in_record(value: &Value) -> Option<(String, String, Option<String>)> {
    if record_type(value)? != "tool.execution_start" || is_subagent_event(value) {
        return None;
    }
    let data = value.get("data")?;
    if data.get("toolName")?.as_str()? != "task" {
        return None;
    }
    let args = data.get("arguments")?;
    let field = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    Some((
        data.get("toolCallId")?.as_str()?.to_string(),
        field("description").or_else(|| field("prompt")).unwrap_or_default().to_string(),
        field("agent_type").map(str::to_string),
    ))
}

/// The call a `tool.execution_complete` finishes.
pub(crate) fn finished_call(value: &Value) -> Option<&str> {
    if record_type(value)? != "tool.execution_complete" {
        return None;
    }
    value.pointer("/data/toolCallId")?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "11111111-2222-4333-8444-555555555555";
    const B: &str = "66666666-7777-4888-8999-000000000000";

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn opts(args: &[&str], uid: Option<&str>) -> PtyOptions {
        let mut opts = PtyOptions {
            login: None,
            assistant: None,
            id: "t".to_string(),
            cmd: "copilot".to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Default::default(),
            cwd: "/".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: true,
            project_id: None,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            local_model: false,
            schedule_target_id: None,
            host_session: false,
            api_key: None,
            mux_wrapped: false,
        };
        if let Some(uid) = uid {
            opts.env.insert(crate::app_env!("TAB_UID").to_string(), uid.to_string());
        }
        opts
    }

    #[test]
    fn a_tab_pins_its_own_session_in_place_of_the_folders_newest() {
        let pinned = resolve(opts(&["--continue"], Some(A)));
        assert_eq!(pinned.args, vec!["--session-id", A]);
        assert_eq!(pinned.env.get(agent_session::TAB_AGENT_ENV).map(String::as_str), Some("copilot"));
        // Other flags stay, and a stale pin or resume with its value goes.
        let kept = resolve(opts(&["--allow-all-tools", "--resume", "old", "--model", "x", "--session-id=old"], Some(A)));
        assert_eq!(kept.args, vec!["--session-id", A, "--allow-all-tools", "--model", "x"]);
        let fresh = resolve(opts(&[], Some(A)));
        assert_eq!(fresh.args, vec!["--session-id", A]);
    }

    #[test]
    fn runs_that_are_not_the_tabs_conversation_are_left_alone() {
        for args in [&["login", "--device-code"][..], &["-p", "hi"], &["--prompt=hi"], &["--connect"]] {
            let out = resolve(opts(args, Some(A)));
            assert_eq!(out.args, args.iter().map(|a| a.to_string()).collect::<Vec<_>>(), "{args:?}");
        }
        assert_eq!(resolve(opts(&["--continue"], None)).args, vec!["--continue"]);
        assert_eq!(resolve(opts(&["--continue"], Some("../x"))).args, vec!["--continue"]);
        let mut other = opts(&["--continue"], Some(A));
        other.cmd = "claude".into();
        assert_eq!(resolve(other).args, vec!["--continue"]);
    }

    /// Run the POSIX turn script for `event` with `payload` on stdin, as
    /// Copilot does, under the tab variables `vars`.
    #[cfg(unix)]
    fn fire(script: &Path, event: &str, payload: &str, vars: &[(&str, &str)]) {
        use std::io::Write;
        use std::process::Stdio;
        let mut cmd = std::process::Command::new("sh");
        cmd.arg(script).arg(event).env_clear().env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in vars {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        // A script that refuses early never reads its stdin.
        match child.stdin.take().unwrap().write_all(payload.as_bytes()) {
            Err(e) if e.kind() != std::io::ErrorKind::BrokenPipe => panic!("{e}"),
            _ => {}
        }
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success() && out.stdout.is_empty(), "{event}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[cfg(unix)]
    fn turn_word(live: &Path, uid: &str) -> Option<String> {
        let text = std::fs::read_to_string(live.join(format!("{uid}.turn"))).ok()?;
        assert!(crate::services::agent_turn::parse_turn_record(&text).is_some(), "{text}");
        text.split_whitespace().next().map(str::to_string)
    }

    /// The payloads Copilot 1.0.112 sent in the hooks probe
    /// (`scripts/verify-cli/copilot/hooks.py`), cut to the keys the script reads.
    #[cfg(unix)]
    fn payload(event: &str, session: &str) -> String {
        let extra = match event {
            "notification" => r#", "message": "Edit file: a.txt", "title": "Permission needed", "notification_type": "permission_prompt""#,
            "errorOccurred" => r#", "errorContext": "model_call", "recoverable": true, "error": {"message": "x"}"#,
            "postToolUse" => r#", "toolCallId": "c1", "toolName": "bash", "toolArgs": {"sessionId": "99999999-9999-4999-8999-999999999999"}, "toolResult": {"resultType": "success"}"#,
            "agentStop" => r#", "stopReason": "end_turn", "stop_hook_active": false"#,
            "sessionEnd" => r#", "reason": "user_exit""#,
            _ => "",
        };
        format!(r#"{{"sessionId": "{session}", "timestamp": 1794840029431, "cwd": "/w"{extra}}}"#)
    }

    #[cfg(unix)]
    #[test]
    fn the_turn_hook_writes_each_events_word_for_the_tabs_own_session() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        let script = dir.path().join("turn.sh");
        std::fs::write(&script, posix_turn_in(&live.to_string_lossy())).unwrap();
        let tab = [(crate::app_env!("TAB_UID"), A), (crate::app_env!("TAB_AGENT"), "copilot")];
        for (event, want) in [
            ("userPromptSubmitted", "working"),
            ("notification", "decision"),
            ("postToolUse", "working"),
            ("postToolUseFailure", "working"),
            ("agentStop", "done"),
            ("userPromptSubmitted", "working"),
            ("errorOccurred", "done"),
            ("sessionEnd", "idle"),
        ] {
            fire(&script, event, &payload(event, A), &tab);
            assert_eq!(turn_word(&live, A).as_deref(), Some(want), "{event}");
        }
        // An ask_user form is a decision too.
        let ask = format!(r#"{{"sessionId": "{A}", "message": "Information requested", "notification_type": "elicitation_dialog"}}"#);
        fire(&script, "notification", &ask, &tab);
        assert_eq!(turn_word(&live, A).as_deref(), Some("decision"));
        // Every registered event has a word in the script.
        let body = std::fs::read_to_string(&script).unwrap();
        for event in TURN_EVENTS {
            assert!(body.contains(event), "{event}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_turn_hook_refuses_everything_but_the_tabs_own_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        let script = dir.path().join("turn.sh");
        std::fs::write(&script, posix_turn_in(&live.to_string_lossy())).unwrap();
        let tab = [(crate::app_env!("TAB_UID"), A), (crate::app_env!("TAB_AGENT"), "copilot")];
        let start = payload("userPromptSubmitted", A);
        // A `copilot -p` the tab's agent ran from its shell tool (1.0.112 sets
        // COPILOT_AGENT_SESSION_ID for its tools' commands), a Copilot under
        // another CLI's tab, a bad key.
        let nested = [tab[0], tab[1], ("COPILOT_AGENT_SESSION_ID", A)];
        fire(&script, "userPromptSubmitted", &start, &nested);
        fire(&script, "userPromptSubmitted", &start, &[(crate::app_env!("TAB_UID"), A), (crate::app_env!("TAB_AGENT"), "claude")]);
        fire(&script, "userPromptSubmitted", &start, &[(crate::app_env!("TAB_UID"), "../x"), (crate::app_env!("TAB_AGENT"), "copilot")]);
        fire(&script, "userPromptSubmitted", &start, &[]);
        assert!(!live.exists());
        fire(&script, "agentStop", &payload("agentStop", A), &tab);
        assert_eq!(turn_word(&live, A).as_deref(), Some("done"));
        // A subagent's prompt and stop carry its own id; the nested run's too.
        fire(&script, "userPromptSubmitted", &payload("userPromptSubmitted", B), &tab);
        // Events the script maps to nothing, and the ones it reads a field of.
        for (event, body) in [
            ("permissionRequest", payload("userPromptSubmitted", A)),
            ("preToolUse", payload("userPromptSubmitted", A)),
            ("subagentStop", payload("agentStop", A)),
            ("preCompact", payload("userPromptSubmitted", A)),
            ("notification", payload("notification", A).replace("permission_prompt", "agent_completed")),
            ("errorOccurred", payload("errorOccurred", A).replace("model_call", "tool_execution")),
        ] {
            fire(&script, event, &body, &tab);
        }
        // No session id at all, and one only inside a tool's arguments.
        fire(&script, "userPromptSubmitted", r#"{"prompt": "hi"}"#, &tab);
        fire(&script, "postToolUse", &payload("postToolUse", B).replace(&format!(r#""sessionId": "{B}", "#), ""), &tab);
        assert_eq!(turn_word(&live, A).as_deref(), Some("done"));
    }

    #[cfg(unix)]
    #[test]
    fn the_turn_hook_follows_the_session_a_new_moved_the_record_to() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        let script = dir.path().join("turn.sh");
        std::fs::write(&script, posix_turn_in(&live.to_string_lossy())).unwrap();
        let tab = [(crate::app_env!("TAB_UID"), A), (crate::app_env!("TAB_AGENT"), "copilot")];
        // `/new`: the hint's sessionStart recorded B; the launch key's old
        // session ends in the background later (its sessionEnd comes after B's).
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join(A), B).unwrap();
        fire(&script, "userPromptSubmitted", &payload("userPromptSubmitted", A), &tab);
        assert_eq!(turn_word(&live, A), None);
        fire(&script, "userPromptSubmitted", &payload("userPromptSubmitted", B), &tab);
        assert_eq!(turn_word(&live, A).as_deref(), Some("working"));
        fire(&script, "sessionEnd", &payload("sessionEnd", B), &tab);
        fire(&script, "sessionEnd", &payload("sessionEnd", A), &tab);
        assert_eq!(turn_word(&live, A).as_deref(), Some("idle"));
        // A record that is not a session id falls back to the key.
        std::fs::write(live.join(A), "ses_x").unwrap();
        fire(&script, "agentStop", &payload("agentStop", A), &tab);
        assert_eq!(turn_word(&live, A).as_deref(), Some("done"));
        // So does a FIFO the agent planted there, without holding the hook.
        std::fs::remove_file(live.join(A)).unwrap();
        assert!(std::process::Command::new("mkfifo").arg(live.join(A)).status().unwrap().success());
        fire(&script, "userPromptSubmitted", &payload("userPromptSubmitted", A), &tab);
        assert_eq!(turn_word(&live, A).as_deref(), Some("working"));
    }

    #[test]
    fn the_powershell_twin_maps_the_same_events() {
        let body = powershell_turn_in(r"C:\state\live_sessions");
        for event in TURN_EVENTS {
            assert!(body.contains(&format!("'{event}'")), "{event}");
        }
        for needle in ["COPILOT_AGENT_SESSION_ID", "permission_prompt|elicitation_dialog", "model_call", crate::app_env!("TAB_AGENT")] {
            assert!(body.contains(needle), "{needle}");
        }
        assert!(!body.contains('@'), "an unfilled placeholder");
        assert!(!posix_turn_in("/state/live").contains('@'), "an unfilled placeholder");
    }

    #[test]
    fn turn_hooks_are_registered_once_for_a_release_that_takes_them_and_taken_out_otherwise() {
        let home = tempfile::tempdir().unwrap();
        let script = home.path().join("hooks dir").join("turn.sh");
        let file = home.path().join(".copilot").join("hooks").join(TURN_HOOKS.rsplit('/').next().unwrap());
        register_in_home_gated(home.path(), true, &script);
        let first = std::fs::read(&file).unwrap();
        register_in_home_gated(home.path(), true, &script);
        assert_eq!(std::fs::read(&file).unwrap(), first);
        let root: Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(root["version"], 1);
        let hooks = root["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), TURN_EVENTS.len());
        let key = if cfg!(windows) { "powershell" } else { "bash" };
        for event in TURN_EVENTS {
            let cmd = hooks[*event][0][key].as_str().unwrap();
            assert!(cmd.ends_with(&format!(" {event}")) && cmd.contains("hooks dir"), "{cmd}");
        }
        // The user's own hooks file beside it is never touched.
        let mine = file.with_file_name("mine.json");
        std::fs::write(&mine, "{not json").unwrap();
        register_in_home_gated(home.path(), false, &script);
        assert!(!file.exists());
        assert_eq!(std::fs::read_to_string(&mine).unwrap(), "{not json");
        register_in_home_gated(home.path(), false, &script);
        assert!(!file.exists());
    }

    #[test]
    fn only_a_release_the_probe_ran_takes_the_turn_hooks() {
        let seen = |v: &str| Seen { version: Some(v.to_string()), ..Default::default() };
        assert!(runs_turn_hooks(Some(&seen("1.0.112"))));
        assert!(runs_turn_hooks(Some(&seen("1.0.120"))));
        assert!(!runs_turn_hooks(Some(&seen("1.0.110"))));
        assert!(!runs_turn_hooks(Some(&Seen::default())));
        assert!(!runs_turn_hooks(None));
    }

    /// Writes the app's Copilot hooks — the turn script and the hint that
    /// records the session — into a scratch home for the hooks probe
    /// (`scripts/verify-cli/copilot/hooks.py turn`): `COPILOT_PROBE_HOME`,
    /// `COPILOT_PROBE_LIVE` (the record folder), `COPILOT_PROBE_HOOKS` (where
    /// the scripts go).
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn writes_the_copilot_hooks_for_a_probe() {
        use std::os::unix::fs::PermissionsExt;
        let var = |k: &str| PathBuf::from(std::env::var(k).unwrap_or_else(|_| panic!("{k}")));
        let (home, live, hooks) = (var("COPILOT_PROBE_HOME"), var("COPILOT_PROBE_LIVE"), var("COPILOT_PROBE_HOOKS"));
        std::fs::create_dir_all(&hooks).unwrap();
        let turn = hooks.join(TURN_SCRIPT);
        let hint = hooks.join("hint.sh");
        let (hint_body, hint_hooks) = crate::services::agent_hint::copilot_hint_for_probe(&live.to_string_lossy(), &hint);
        std::fs::write(&turn, posix_turn_in(&live.to_string_lossy())).unwrap();
        std::fs::write(&hint, hint_body).unwrap();
        for script in [&turn, &hint] {
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        register_in_home_gated(&home, true, &turn);
        let hint_file = home.join(".copilot").join("hooks").join("hint.json");
        std::fs::write(hint_file, hint_hooks).unwrap();
    }

    #[test]
    fn workspace_cwd_reads_plain_and_quoted_values() {
        assert_eq!(yaml_value("cwd: /a/b c", "cwd").as_deref(), Some("/a/b c"));
        assert_eq!(yaml_value("cwd: 'C:\\it''s'", "cwd").as_deref(), Some("C:\\it's"));
        assert_eq!(yaml_value("cwd: \"/a\\\"b\"", "cwd").as_deref(), Some("/a\"b"));
        assert_eq!(yaml_value("cwdx: /a", "cwd"), None);
        assert_eq!(yaml_value("cwd:", "cwd"), None);
    }

    #[test]
    fn a_folder_lists_its_prompted_sessions_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = if cfg!(windows) { r"C:\work\app" } else { "/work/app" };
        let other = if cfg!(windows) { r"C:\work\other" } else { "/work/other" };
        write(&root.join(A).join(WORKSPACE), &format!("id: {A}\ncwd: {dir}\n"));
        write(&root.join(A).join(EVENTS), "{}\n");
        write(&root.join(B).join(WORKSPACE), &format!("id: {B}\ncwd: {other}\n"));
        write(&root.join(B).join(EVENTS), "{}\n");
        // Never prompted: a folder with no log.
        let blank = "99999999-7777-4888-8999-000000000000";
        write(&root.join(blank).join(WORKSPACE), &format!("cwd: {dir}\n"));
        let listed: Vec<_> = folder_sessions_in(root, &format!("{dir}{}", std::path::MAIN_SEPARATOR)).into_iter().map(|s| s.0).collect();
        assert_eq!(listed, vec![A]);
        assert!(events_in(root, A).is_some());
        assert!(events_in(root, "not-a-uuid").is_none());
        assert!(events_in(root, blank).is_none());
    }

    #[test]
    fn records_give_prompts_answers_models_and_tools() {
        let user = json!({"type": "user.message", "data": {"content": "hello", "source": "terminal"}});
        assert_eq!(prompt_in_record(&user).as_deref(), Some("hello"));
        let skill = json!({"type": "user.message", "data": {"content": "x", "source": "skill-pdf"}});
        assert_eq!(prompt_in_record(&skill), None);
        let auto = json!({"type": "user.message", "data": {"content": "x", "isAutopilotContinuation": true}});
        assert_eq!(prompt_in_record(&auto), None);

        let answer = json!({"type": "assistant.message", "data": {"content": " Done. ", "model": "gpt-5.6-terra", "toolRequests": []}});
        assert_eq!(answer_in_record(&answer).as_deref(), Some("Done."));
        assert_eq!(model_in_record(&answer), Some("gpt-5.6-terra"));
        let tool_only = json!({"type": "assistant.message", "data": {"content": "", "toolRequests": [{}]}});
        assert_eq!(answer_in_record(&tool_only), None);
        let sub = json!({"type": "assistant.message", "data": {"content": "inner", "parentToolCallId": "c1"}});
        assert_eq!(answer_in_record(&sub), None);

        let change = json!({"type": "session.model_change", "data": {"newModel": "claude-sonnet-5", "reasoningEffort": "medium"}});
        assert_eq!(model_in_record(&change), Some("claude-sonnet-5"));
        assert_eq!(effort_in_record(&change), Some("medium"));
        assert_eq!(effort_in_record(&json!({"type": "session.model_change", "data": {"newModel": "m", "reasoningEffort": null}})), None);
        assert_eq!(tokens_in_record(&json!({"type": "session.usage_info", "data": {"currentTokens": 18664, "tokenLimit": 272000}})), Some(18664));

        let bash = json!({"type": "tool.execution_start", "data": {"toolCallId": "c1", "toolName": "bash", "arguments": {"command": "ls", "description": "List"}}});
        assert_eq!(shell_in_record(&bash), Some(("c1".into(), "ls".into(), Some("List".into()))));
        let task = json!({"type": "tool.execution_start", "data": {"toolCallId": "c2", "toolName": "task", "arguments": {"description": "Explore", "agent_type": "explore"}}});
        assert_eq!(spawn_in_record(&task), Some(("c2".into(), "Explore".into(), Some("explore".into()))));
        assert_eq!(finished_call(&json!({"type": "tool.execution_complete", "data": {"toolCallId": "c1"}})), Some("c1"));
    }
}
