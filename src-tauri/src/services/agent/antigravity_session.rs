//! Which Antigravity conversation is a tab's own: the hook that records it.
//!
//! Antigravity mints its conversation ids, and a restored tab used to come
//! back on `--continue`, the folder's newest conversation: two tabs of one
//! folder reopened the same chat. Antigravity runs user hooks from
//! `.gemini/config/hooks.json` (probed on 1.5.2–1.5.9,
//! `scripts/verify-cli/antigravity/hooks.py`), so each tab now records the
//! conversation it is in, as the other CLIs' hooks do:
//!
//! - **The hook.** One script of Tabtivity's in `<state_dir>/hooks/` (read-only
//!   in the fence, at its own path), registered under its own name for
//!   `PreInvocation` in every agent home's `hooks.json`. Antigravity runs it
//!   before each model call with the conversation's id on stdin; it writes
//!   that id to `live_sessions/<uid>`, the record the Resume menu writes too.
//!   `SessionStart` is no use: it fires only at a new conversation's first
//!   prompt, never on `--conversation`, `--continue` or an in-CLI `/resume`.
//!   Only the tab's own conversation moves the record (see the script).
//! - **The proof.** The script leaves [`PROOF`] in the record directory the
//!   first time it records there: hooks run in that scope.
//! - **The launch note.** At each spawn where the hook is registered, a
//!   host-only `<uid>.agy` in the shared live-sessions root says how that
//!   launch began. `google_chat::resolve` and the Reader read the note, the
//!   record and the proof (the resolve table in `docs/context/agent_sessions.md`).
//!
//! Registration merges into the home's file under its own name and leaves
//! every other hook alone; a file that is not plain JSON is left untouched
//! (Antigravity runs none of a file's hooks when it cannot parse it). It is
//! gated on a release the probes covered. AppHandle-free.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::services::agent_session::{is_uuid_shaped, live_sessions_dir, project_live_sessions_dir};
use crate::services::agent_versions::Seen;
use crate::services::home_io::HomeFile;
use crate::storage;

/// Antigravity's user hooks file in an agent home. 1.5.x moves an older
/// `.gemini/antigravity-cli/hooks.json` here once and leaves a link behind.
pub(crate) const HOOKS_FILE: &str = ".gemini/config/hooks.json";
/// Tabtivity's hook in that file: the one top-level name it owns.
const HOOK_NAME: &str = concat!(crate::app_slug!(), "-session");
/// Before each model call, with the conversation's id: fires on a resumed
/// conversation's turns too, unlike `SessionStart`.
const EVENT: &str = "PreInvocation";
#[cfg(not(windows))]
const SCRIPT_NAME: &str = concat!(crate::app_slug!(), "_agy_session.sh");
#[cfg(windows)]
const SCRIPT_NAME: &str = concat!(crate::app_slug!(), "_agy_session.ps1");
#[cfg_attr(windows, allow(dead_code))]
const POSIX_TEMPLATE: &str = include_str!("antigravity_session/hook.sh");
#[cfg_attr(not(windows), allow(dead_code))]
const POWERSHELL_TEMPLATE: &str = include_str!("antigravity_session/hook.ps1");
/// What the hook leaves in its record directory once it has recorded there.
pub const PROOF: &str = "agy-hook-ran";
/// Suffix of the host-only launch note beside the tab's record.
const LAUNCH_SUFFIX: &str = ".agy";
/// The oldest release the hooks probe ran against (1.5.2–1.5.9 took the file,
/// ran `PreInvocation` and set `ANTIGRAVITY_AGENT` for tool commands). An older
/// or unknown release gets no registration and keeps today's `--continue`.
pub const HOOKS_SINCE: &str = "1.5.2";

/// Whether the release a probe last read takes the hook: only a known one.
pub fn runs_hooks(seen: Option<&Seen>) -> bool {
    seen.and_then(|seen| seen.version.as_deref())
        .is_some_and(|v| crate::services::agent_versions::version_cmp(v, HOOKS_SINCE) != std::cmp::Ordering::Less)
}

/// [`runs_hooks`] for the host's `agy`, from the version store; a spawn
/// refreshes a missing or day-old entry in the background.
fn installed_runs_hooks(refresh: bool) -> bool {
    if refresh {
        use std::sync::atomic::AtomicBool;
        static PROBING: AtomicBool = AtomicBool::new(false);
        return crate::services::agent_registry::host_agent_version_says("antigravity", &PROBING, runs_hooks);
    }
    runs_hooks(crate::services::agent_versions::load().get("antigravity"))
}

fn script_path() -> PathBuf {
    storage::state_dir().join("hooks").join(SCRIPT_NAME)
}

/// The command `hooks.json` runs. Antigravity hands it to the shell, so the
/// path is one quoted word.
fn hook_command() -> String {
    let path = script_path();
    #[cfg(windows)]
    {
        format!("powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"", path.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        crate::quote::posix(&path.to_string_lossy())
    }
}

fn fill(template: &str, live_dir: &str, quote: fn(&str) -> String) -> String {
    template
        .replace("@DISPLAY@", crate::brand::DISPLAY)
        .replace("@ENV@", concat!(crate::app_upper!(), "_"))
        .replace("@LIVE_DIR@", &quote(live_dir))
        .replace("@PROOF@", &quote(PROOF))
}

/// The POSIX script, recording under `live_dir`.
#[cfg_attr(windows, allow(dead_code))]
fn posix_script_in(live_dir: &str) -> String {
    fill(POSIX_TEMPLATE, live_dir, crate::quote::posix)
}

/// The PowerShell twin, for a Windows host.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_script_in(live_dir: &str) -> String {
    fill(POWERSHELL_TEMPLATE, live_dir, crate::quote::powershell).replace("\r\n", "\n").replace('\n', "\r\n")
}

/// Write the hook script beside the session hook. Idempotent; part of
/// `agent_session::install_session_start_hook`.
pub fn write_script() -> std::io::Result<()> {
    let path = script_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let live = live_sessions_dir().to_string_lossy().into_owned();
    #[cfg(windows)]
    let body = powershell_script_in(&live);
    #[cfg(not(windows))]
    let body = posix_script_in(&live);
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

/// Register the hook in one agent home, when the installed Antigravity takes
/// it (read from the version store, never waiting on a probe); take it out
/// otherwise. Part of `agent_session::register_hooks_in_home`.
pub fn register_in_home(home: &Path) -> bool {
    register_in_home_gated(home, installed_runs_hooks(false))
}

/// [`register_in_home`] at an Antigravity tab's spawn, which also refreshes a
/// stale version entry in the background. True when the hook is registered
/// afterwards.
pub fn register_for_spawn(home: &Path) -> bool {
    register_in_home_gated(home, installed_runs_hooks(true))
}

fn register_in_home_gated(home: &Path, runs: bool) -> bool {
    let Some(file) = HomeFile::open(home, HOOKS_FILE) else {
        eprintln!("antigravity_session: {HOOKS_FILE} in {} is not a plain path; skipped", home.display());
        return false;
    };
    let command = hook_command();
    let result = crate::services::agent_hint::merge_json(&file, |root| {
        if runs { add_hook(root, &command) } else { remove_hook(root) }
    });
    if let Err(e) = result {
        eprintln!("antigravity_session: register the hook in {}: {e}", home.display());
    }
    runs && file
        .read()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|root| root.get(HOOK_NAME) == Some(&hook_entry(&command)))
}

/// `{"<event>": [{"type": "command", "command": …}]}` — the shape 1.5.x
/// parses (Claude's `{"hooks": {…}}` does not).
fn hook_entry(command: &str) -> Value {
    json!({ EVENT: [{ "type": "command", "command": command }] })
}

/// Make Tabtivity's entry exactly [`hook_entry`]; every other name stays.
/// False when nothing changes.
fn add_hook(root: &mut Value, command: &str) -> bool {
    let entry = hook_entry(command);
    let Some(map) = root.as_object_mut() else { return false };
    if map.get(HOOK_NAME) == Some(&entry) {
        return false;
    }
    map.insert(HOOK_NAME.to_string(), entry);
    true
}

fn remove_hook(root: &mut Value) -> bool {
    root.as_object_mut().is_some_and(|map| map.remove(HOOK_NAME).is_some())
}

/// Whether the hook has recorded in the scope: its proof in the scope's own
/// slice (fenced and container tabs) or the shared root (an unfenced tab).
pub fn hook_proven(project_id: Option<&str>) -> bool {
    let slice = project_live_sessions_dir(project_id.unwrap_or(storage::ROOT_SCOPE));
    proven_in(&[slice, live_sessions_dir()])
}

fn proven_in(dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|dir| std::fs::symlink_metadata(dir.join(PROOF)).is_ok_and(|m| m.is_file()))
}

/// How a tab's last launch began, from its launch note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    /// Into the folder's newest conversation (`--continue`).
    Continued,
    /// Into a conversation named by id, or none yet, at this moment (epoch ms).
    Fresh(i64),
}

fn launch_note(dir: &Path, uid: &str) -> PathBuf {
    dir.join(format!("{uid}{LAUNCH_SUFFIX}"))
}

/// The tab `uid`'s launch note in `dir` (the shared root, host-only).
pub fn read_launch_in(dir: &Path, uid: &str) -> Option<Launch> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let raw = crate::services::home_io::read_record(&launch_note(dir, uid))?;
    match raw.trim().split_once(' ')? {
        ("continue", _) => Some(Launch::Continued),
        ("fresh", at) => at.parse().ok().map(Launch::Fresh),
        _ => None,
    }
}

pub fn read_launch(uid: &str) -> Option<Launch> {
    read_launch_in(&live_sessions_dir(), uid)
}

pub fn write_launch_in(dir: &Path, uid: &str, launch: Launch) -> std::io::Result<()> {
    if !is_uuid_shaped(uid) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a tab key"));
    }
    std::fs::create_dir_all(dir)?;
    let text = match launch {
        Launch::Continued => format!("continue {}", crate::clock::now_ms()),
        Launch::Fresh(at) => format!("fresh {at}"),
    };
    std::fs::write(launch_note(dir, uid), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "0b9f6a52-3c1d-4e8a-9f00-1a2b3c4d5e6f";
    const CONV: &str = "34677561-c045-4e36-b9e9-1c368eda897d";

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn only_a_probed_release_takes_the_hook() {
        let seen = |v: Option<&str>| Seen { version: v.map(str::to_string), ..Seen::default() };
        assert!(runs_hooks(Some(&seen(Some("1.5.2")))));
        assert!(runs_hooks(Some(&seen(Some("1.5.9")))));
        assert!(runs_hooks(Some(&seen(Some("1.6.0")))));
        assert!(!runs_hooks(Some(&seen(Some("1.4.12")))));
        assert!(!runs_hooks(Some(&seen(None))));
        assert!(!runs_hooks(None));
    }

    #[test]
    fn registration_keeps_the_users_hooks_and_is_idempotent() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join(".gemini").join("config").join("hooks.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mine = json!({"mine": {"Stop": [{"type": "command", "command": "notify"}]}});
        std::fs::write(&file, mine.to_string()).unwrap();
        assert!(register_in_home_gated(home.path(), true));
        let root = read_json(&file);
        assert_eq!(root["mine"], mine["mine"]);
        assert_eq!(root[HOOK_NAME], hook_entry(&hook_command()));
        let before = std::fs::metadata(&file).unwrap().modified().unwrap();
        assert!(register_in_home_gated(home.path(), true));
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), before, "unchanged file rewritten");
        // An entry of ours someone edited is put back as it was.
        let mut edited = read_json(&file);
        edited[HOOK_NAME] = json!({"Stop": []});
        std::fs::write(&file, edited.to_string()).unwrap();
        assert!(register_in_home_gated(home.path(), true));
        assert_eq!(read_json(&file)[HOOK_NAME], hook_entry(&hook_command()));
        // A release the probes did not cover: taken out, the user's stays.
        assert!(!register_in_home_gated(home.path(), false));
        assert_eq!(read_json(&file), mine);
    }

    #[test]
    fn a_file_antigravity_could_not_parse_is_left_untouched() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join(".gemini").join("config").join("hooks.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for text in ["{\"mine\": {\"Stop\": [] // a comment\n}}", "[1, 2]", "not json"] {
            std::fs::write(&file, text).unwrap();
            assert!(!register_in_home_gated(home.path(), true), "{text}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        }
        // A missing file is created with the hook alone.
        std::fs::remove_file(&file).unwrap();
        assert!(register_in_home_gated(home.path(), true));
        assert_eq!(read_json(&file), json!({ HOOK_NAME: hook_entry(&hook_command()) }));
    }

    #[test]
    fn the_scripts_name_the_apps_variables_and_quote_the_live_dir() {
        let sh = posix_script_in("/state/live o'dir");
        assert!(sh.starts_with("#!/bin/sh\n"));
        assert!(sh.contains(&format!("\"${{{}-}}\" = agy", crate::app_env!("TAB_AGENT"))));
        assert!(sh.contains(&format!("uid=${{{}-}}", crate::app_env!("TAB_UID"))));
        assert!(sh.contains("dir='/state/live o'\\''dir'"));
        assert!(!sh.contains('@'), "a placeholder left: {sh}");
        let ps = powershell_script_in("C:\\state\\live");
        assert!(ps.contains(&format!("$env:{} -ne 'agy'", crate::app_env!("TAB_AGENT"))));
        assert!(ps.contains("$dir = 'C:\\state\\live'"));
        assert!(!ps.contains('@') && !ps.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn launch_notes_round_trip_and_refuse_a_bad_key() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_launch_in(dir.path(), UID), None);
        write_launch_in(dir.path(), UID, Launch::Fresh(42)).unwrap();
        assert_eq!(read_launch_in(dir.path(), UID), Some(Launch::Fresh(42)));
        write_launch_in(dir.path(), UID, Launch::Continued).unwrap();
        assert_eq!(read_launch_in(dir.path(), UID), Some(Launch::Continued));
        assert!(write_launch_in(dir.path(), "../x", Launch::Continued).is_err());
    }

    #[test]
    fn the_proof_counts_only_as_a_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = [dir.path().to_path_buf()];
        assert!(!proven_in(&dirs));
        std::fs::create_dir(dir.path().join(PROOF)).unwrap();
        assert!(!proven_in(&dirs));
        std::fs::remove_dir(dir.path().join(PROOF)).unwrap();
        std::fs::write(dir.path().join(PROOF), "").unwrap();
        assert!(proven_in(&dirs));
    }

    /// Runs the POSIX script for real: what it records, and what it refuses.
    #[cfg(unix)]
    #[test]
    fn the_hook_records_only_the_tabs_own_conversation() {
        use std::io::Write;
        use std::process::Stdio;
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        let script = dir.path().join("hook.sh");
        std::fs::write(&script, posix_script_in(&live.to_string_lossy())).unwrap();
        let call = |id: &str, extra: &str| {
            format!(r#"{{"conversationId":"{id}","cwd":"/w","hookEventName":"PreInvocation","initialNumSteps":1,{extra}"modelName":"m"}}"#)
        };
        let run = |payload: &str, env: &[(&str, &str)]| {
            let mut cmd = std::process::Command::new("sh");
            cmd.arg(&script).env_clear().env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            for (k, v) in env {
                cmd.env(k, v);
            }
            let mut child = cmd.spawn().unwrap();
            match child.stdin.take().unwrap().write_all(payload.as_bytes()) {
                Err(e) if e.kind() != std::io::ErrorKind::BrokenPipe => panic!("{e}"),
                _ => {}
            }
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            assert!(out.stdout.is_empty(), "the hook printed {:?}", String::from_utf8_lossy(&out.stdout));
        };
        let tab = [(crate::app_env!("TAB_UID"), UID), (crate::app_env!("TAB_AGENT"), "agy")];
        let record = || std::fs::read_to_string(live.join(UID)).ok();
        let prompt = r#""lastUserInput":"fix \"conversationId\":\"aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb\"\nplease","#;
        // Not the tab's Antigravity: another CLI's tab, no tab, a bad key.
        run(&call(CONV, prompt), &[(crate::app_env!("TAB_UID"), UID), (crate::app_env!("TAB_AGENT"), "claude")]);
        run(&call(CONV, prompt), &[]);
        run(&call(CONV, prompt), &[(crate::app_env!("TAB_UID"), "../x"), (crate::app_env!("TAB_AGENT"), "agy")]);
        // An `agy -p` the tab's agent ran from its shell tool.
        run(&call(CONV, prompt), &[tab[0], tab[1], ("ANTIGRAVITY_AGENT", "1")]);
        // A subagent's call: no prompt of its own, or a parent named.
        run(&call(CONV, r#""lastUserInput":"","#), &tab);
        run(&call(CONV, &format!(r#""lastUserInput":"x","parentConversationId":"{CONV}","#)), &tab);
        // A conversation id that is no uuid.
        run(&call("../../etc", prompt), &tab);
        assert!(!live.exists(), "something was recorded");
        // The tab's own: recorded, the proof left, no temporary behind.
        run(&call(CONV, prompt), &tab);
        assert_eq!(record().as_deref(), Some(CONV));
        assert!(live.join(PROOF).is_file());
        // A main conversation without a lastUserInput key (a later release
        // dropping it) still records; an empty parent is no parent.
        const NEXT: &str = "26babe4f-3f07-4331-8d79-a1ae76515d08";
        run(&call(NEXT, r#""parentConversationId":"","#), &tab);
        assert_eq!(record().as_deref(), Some(NEXT));
        let names: Vec<_> = std::fs::read_dir(&live).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }
}
