//! Claude's own `/model` list for the assistant's chats.
//!
//! A chat runs with its slash commands off (`assistant::launch_line`), so the
//! Reader's model chip cannot open Claude's picker in it the way it does in
//! every other Claude tab. Instead a short-lived Claude in the assistant's own
//! home and fence is asked once: started in a detached tmux session with no
//! tools and no MCP servers, sent `/model`, its screen captured while the
//! picker shows, then `Esc` and the session is ended. Claude draws ten rows of
//! the picker at most whatever the pane's height (`… +3 models` under them),
//! so the highlight is walked down with the arrow key and each screen kept.
//! The renderer reads the rows off those screens with the reader the normal
//! model sheet uses (`readSelectPrompt`, `mergeSelectRows`), so a chat's sheet
//! lists what Claude itself offers. The screens are kept per Claude build
//! (`services::model_rows`): the probe runs again only after an update.
//!
//! Only `/model` and `Enter` at the prompt, then `Down` and `Esc` in the picker
//! are ever typed: a digit, a letter (`s` is "this session only") or an
//! `Enter` on a picker row commits that row. The probe types nothing at all
//! while the screen shows a numbered dialog of its own (a trust or onboarding
//! question), and gives up instead.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::services::assistant::{self, AssistantCli, AssistantLaunch};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::services::tmux_local;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::storage;

/// The probe's chat folder and tmux session derive from this uid: uuid-shaped,
/// because the assistant fence binds only a uuid-named folder below its work
/// folder, and fixed, so Claude's per-folder state in the home stays one entry.
/// Chats get random ids (`uuid_v4`), so none is ever this one.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const PROBE_UID: &str = "00000000-0000-4000-8000-000000000000";
/// The probe's PTY id, which the fence's per-tab bookkeeping is keyed by.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const PROBE_TAB_ID: &str = "assistant-model-probe";
/// Wide enough that each row's note stays on the row's own line, tall enough
/// for the picker's ten rows and its heading.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const COLS: u16 = 160;
#[cfg(any(target_os = "linux", target_os = "macos"))]
const ROWS: u16 = 50;
#[cfg(any(target_os = "linux", target_os = "macos"))]
const POLL: Duration = Duration::from_millis(250);
/// How long Claude may take to draw its prompt, and then its picker: with the
/// polls, inside the phone's wait (`DesktopRequest::AssistantModels`).
#[cfg(any(target_os = "linux", target_os = "macos"))]
const START_WAIT: Duration = Duration::from_secs(12);
#[cfg(any(target_os = "linux", target_os = "macos"))]
const PICKER_WAIT: Duration = Duration::from_secs(6);
/// The most `Down`s the walk presses (Claude 2.1.310 lists thirteen models),
/// each waited on for this many polls before the walk ends at the last row.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const MAX_WALK: usize = 16;
#[cfg(any(target_os = "linux", target_os = "macos"))]
const WALK_POLLS: u32 = 2;
/// A screen unchanged over this many polls has finished drawing.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const STEADY_POLLS: u32 = 4;
/// How long a read stays good when Claude's executable cannot be identified,
/// so it is kept in memory only. Otherwise it is kept on disk for that build
/// (`services::model_rows`) and read again only once Claude is updated.
const FRESH_FOR: Duration = Duration::from_secs(6 * 60 * 60);

/// One captured screen, a string per row.
type Screen = Vec<String>;

/// The last read, and when.
type Read = Option<(Instant, Vec<Screen>)>;

/// The last read kept in memory (see [`FRESH_FOR`]). Held across the probe
/// too, so two callers at once share one probe instead of starting two.
fn cache() -> &'static Mutex<Read> {
    static CACHE: std::sync::OnceLock<Mutex<Read>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// The screens Claude's `/model` picker drew as its highlight walked down,
/// read once per installed Claude build and kept on disk
/// (`services::model_rows`), so only the first list after an update waits on
/// the probe. Blocking (a probe takes several seconds); callers on the async
/// runtime wrap it in `spawn_blocking`.
pub fn claude_model_screens() -> Result<Vec<Screen>, String> {
    use crate::services::model_rows;
    let mut cached = cache().lock().unwrap_or_else(|e| e.into_inner());
    let source = crate::services::agent_registry::installed_source("claude").map(|(_, source)| source);
    let store = model_rows::store_path();
    if let Some(screens) = model_rows::screens_in(&store, "claude", source.as_ref()) {
        return Ok(screens);
    }
    if let Some((at, screens)) = cached.as_ref() {
        if source.is_none() && at.elapsed() < FRESH_FOR {
            return Ok(screens.clone());
        }
    }
    let screens = probe()?;
    if model_rows::remember_screens_in(&store, "claude", source.as_ref(), &screens).is_err() {
        *cached = Some((Instant::now(), screens.clone()));
    }
    Ok(screens)
}

/// A numbered row (`❯ 1. Label`, `↓ 10. Label` at a windowed picker's edge):
/// the shape of every Claude select dialog.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn is_numbered_row(line: &str) -> bool {
    let rest = line.trim_start_matches(|c: char| c.is_whitespace() || "❯>│┃↑↓".contains(c));
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    (1..=2).contains(&digits) && rest[digits..].starts_with(". ")
}

/// Whether `screen` shows a select dialog: two numbered rows or more.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn shows_dialog(screen: &[String]) -> bool {
    screen.iter().filter(|line| is_numbered_row(line)).count() >= 2
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn probe() -> Result<Vec<Screen>, String> {
    if crate::services::ai_switch::is_off() {
        return Err(crate::services::ai_switch::AI_OFF.to_string());
    }
    if !tmux_local::tmux_available() {
        return Err("tmux_unavailable".to_string());
    }
    let state_dir = storage::state_dir();
    let dir = assistant::chat_dir(&state_dir, PROBE_UID).map_err(|r| r.to_string())?;
    // Like a chat's folder (`launch_prep::ensure_chat_dir`): writable from
    // inside the fence, so a link or a file in its place is refused.
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err("the model probe's folder is not a folder".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            crate::services::agent_home::create_private_dir(&dir).map_err(|e| format!("model probe folder: {e}"))?;
        }
        Err(e) => return Err(format!("model probe folder: {e}")),
    }
    let home = crate::services::agent_home::prepare_assistant_home(false, &dir).map_err(|e| format!("model probe home: {e}"))?;
    let session = assistant::tmux_session_for(PROBE_UID);
    // One a crashed run left behind.
    kill(&session);
    let mut opts = crate::terminal::PtyOptions {
        login: None,
        // Marks the pane as ending with its CLI (`tmux_local::local_tmux_argv`):
        // no login shell after it that keys could land in.
        assistant: Some(AssistantLaunch { cli: AssistantCli::Claude, model: None }),
        id: PROBE_TAB_ID.to_string(),
        cmd: "claude".to_string(),
        // No tools and no MCP servers: nothing is ever asked of this Claude.
        args: ["--tools", "", "--strict-mcp-config"].map(str::to_string).to_vec(),
        env: HashMap::new(),
        cwd: dir.to_string_lossy().into_owned(),
        cols: COLS,
        rows: ROWS,
        local_only: true,
        sandbox: false,
        agent: true,
        project_id: Some(storage::ASSISTANT_SCOPE.to_string()),
        remote_host_id: None,
        tmux_session: Some(session.clone()),
        tmux_attach: None,
        host_bound_uid: None,
        local_model: false,
        schedule_target_id: None,
        host_session: false,
        api_key: None,
    };
    #[cfg(target_os = "linux")]
    crate::services::agent_fence::wrap_pty_options_bwrap(&mut opts, &[], storage::ASSISTANT_SCOPE, &home.dir)?;
    #[cfg(target_os = "macos")]
    crate::services::agent_fence::wrap_pty_options_sandbox_exec(&mut opts, &[], storage::ASSISTANT_SCOPE, &home.dir)?;
    let read = tmux_local::spawn_detached_with(&opts, None).and_then(|()| drive(&session));
    kill(&session);
    crate::services::api_proxy::on_tab_gone(PROBE_TAB_ID);
    read
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn probe() -> Result<Vec<Screen>, String> {
    Err(crate::services::agent_fence::fence_unavailable_message())
}

/// Wait for Claude's prompt, open its picker and read it.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn drive(session: &str) -> Result<Vec<Screen>, String> {
    let ready = wait_steady(session, START_WAIT)?;
    if shows_dialog(&ready) {
        return Err("model_probe_dialog: Claude asked something before its prompt".to_string());
    }
    send(session, &["-l", "/model"])?;
    std::thread::sleep(Duration::from_millis(400));
    send(session, &["Enter"])?;
    let deadline = Instant::now() + PICKER_WAIT;
    let mut last: Option<Vec<String>> = None;
    loop {
        std::thread::sleep(POLL);
        let screen = capture(session)?;
        // Drawn twice alike: its notes are in.
        if shows_dialog(&screen) && last.as_ref() == Some(&screen) {
            let screens = walk(session, screen);
            let _ = send(session, &["Escape"]);
            return screens;
        }
        if Instant::now() > deadline {
            return Err("model_probe_timeout: Claude did not show its model list".to_string());
        }
        last = Some(screen);
    }
}

/// The number of the row the picker highlights (`❯ 4. Sonnet 5.5`).
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn highlighted(screen: &[String]) -> Option<u32> {
    screen.iter().find_map(|line| {
        let rest = line.trim_start().strip_prefix('❯')?.trim_start();
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if rest[digits.len()..].starts_with(". ") { digits.parse().ok() } else { None }
    })
}

/// The picker's screens as `Down` moves its highlight, from `first` until the
/// highlight wraps back to the top (Claude 2.1.310's does) or stops moving,
/// or the picker is gone.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn walk(session: &str, first: Screen) -> Result<Vec<Screen>, String> {
    let mut screens = vec![first];
    for _ in 0..MAX_WALK {
        send(session, &["Down"])?;
        let last = screens.last().cloned().unwrap_or_default();
        let mut moved = None;
        for _ in 0..WALK_POLLS {
            std::thread::sleep(POLL);
            let screen = capture(session)?;
            if screen != last {
                moved = Some(screen);
                break;
            }
        }
        let Some(screen) = moved.filter(|screen| shows_dialog(screen)) else { break };
        let onward = matches!((highlighted(&last), highlighted(&screen)), (Some(was), Some(now)) if now > was);
        if !onward {
            break;
        }
        screens.push(screen);
    }
    Ok(screens)
}

/// The screen once it stopped changing and holds something.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn wait_steady(session: &str, wait: Duration) -> Result<Screen, String> {
    let deadline = Instant::now() + wait;
    let (mut last, mut steady) = (Vec::new(), 0);
    loop {
        std::thread::sleep(POLL);
        let screen = capture(session)?;
        let drawn = screen.iter().any(|line| !line.trim().is_empty());
        steady = if drawn && screen == last { steady + 1 } else { 0 };
        if steady >= STEADY_POLLS {
            return Ok(screen);
        }
        if Instant::now() > deadline {
            return Err("model_probe_timeout: Claude did not start".to_string());
        }
        last = screen;
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn capture(session: &str) -> Result<Screen, String> {
    let out = tmux_local::tmux_command()
        .args(tmux_local::local_tmux_screen_args(session))
        .output()
        .map_err(|e| format!("model probe: {e}"))?;
    if !out.status.success() {
        return Err("model_probe_exited: Claude ended before its model list".to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(|line| line.trim_end().to_string()).collect())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn send(session: &str, keys: &[&str]) -> Result<(), String> {
    let target = format!("={session}:");
    let out = tmux_local::tmux_command()
        .args(["send-keys", "-t", &target])
        .args(keys)
        .output()
        .map_err(|e| format!("model probe: {e}"))?;
    if out.status.success() { Ok(()) } else { Err("model_probe_exited: Claude ended before its model list".to_string()) }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn kill(session: &str) {
    let _ = tmux_local::tmux_command().args(tmux_local::local_tmux_kill_args(session)).output();
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    fn lines(rows: &[&str]) -> Vec<String> {
        rows.iter().map(|row| row.to_string()).collect()
    }

    #[test]
    fn the_probe_uid_names_a_chat_folder() {
        assert!(crate::services::agent_session::is_uuid_shaped(PROBE_UID));
        let state = std::path::Path::new("state");
        assert_eq!(
            assistant::chat_dir(state, PROBE_UID).expect("a chat folder"),
            assistant::work_root(state).join(PROBE_UID)
        );
    }

    #[test]
    fn a_picker_reads_as_a_dialog() {
        // Claude Code 2.1.310 in a 160x60 tmux pane, trimmed.
        let picker = lines(&[
            "   Select model",
            "   Switch between Claude models. Your pick becomes the default for new sessions.",
            "     1.  Default (recommended)  Sonnet 5.5 · Efficient for routine tasks",
            "     2.  Opus 5.5               For complex work and everyday tasks",
            "   ❯ 4.  Sonnet 5.5 ✔           Most efficient for simpler tasks",
            "   ↓ 10. Opus 4.8               Best for everyday, complex tasks",
            "      … +3 models",
        ]);
        assert!(shows_dialog(&picker));
        assert!(is_numbered_row("   ↓ 10. Opus 4.8               Best for everyday, complex tasks"));
        assert_eq!(highlighted(&picker), Some(4));
        assert_eq!(highlighted(&lines(&["   ❯ 13. Sonnet 4.6             Efficient for routine tasks"])), Some(13));
        assert_eq!(highlighted(&lines(&["❯ Try \"fix typecheck errors\""])), None);
    }

    #[test]
    fn a_prompt_and_a_numbered_answer_line_are_not_a_dialog() {
        let prompt = lines(&[
            "╭──────────────────────╮",
            "│ ✻ Welcome to Claude Code! │",
            "╰──────────────────────╯",
            "1. one thing the banner said",
            "────────────────────────",
            "❯ ",
            "  ? for shortcuts",
        ]);
        assert!(!shows_dialog(&prompt));
        assert!(!is_numbered_row("12345. not a row"));
        assert!(is_numbered_row("│ ❯ 1. Yes, I trust this folder"));
    }
}
