//! Muse's session hook: the script that records which session a Muse tab is
//! in and its turn state, and its registration in an agent home's
//! `.config/muse/settings.json`.
//!
//! Probed offline on 1.3.0, 1.4.15, 1.4.23, 1.4.24 and 1.4.25 (`scripts/verify-cli/muse/resume.py`,
//! `turns.py`): the settings take Claude-shaped `hooks` from 1.3.0 on, and
//! Muse exits at launch on a settings file it cannot read, so the file is
//! merged only when it is plain JSON with `schema_version` 1 (or new) and
//! written atomically. One command serves every event ([`EVENTS`]):
//!
//! - `UserPromptSubmit`, whose `session_id` is the session the prompt went
//!   into — never a subagent's (theirs fire `SubagentStart`), and a session
//!   that took no prompt fires nothing at all: the record, and `working`.
//! - `Stop` at a turn's end (before the reminder subagents' "Double checking",
//!   which takes queued input) and `Interrupt` at an Esc: `done`. `Interrupt`
//!   is 1.4.15's (1.3.0 warns of an unknown event at every launch), and Muse
//!   admits its handler only with `async: true`.
//! - `SessionEnd` (reason `other` for `/exit`, Ctrl+C and `/clear` alike): `idle`.
//! - `SessionStart`, which fires with a session's first prompt (not at launch):
//!   the send hint as `additionalContext`, which Muse puts in the session's
//!   context as a developer block.
//!
//! Not reachable offline, so not registered: `PermissionRequest`,
//! `Notification` and `StopFailure` (the echo provider makes no tool call and
//! never fails). Every other event (`PreToolUse`, `PostToolUse`, the LLM-call
//! and subagent events) would add nothing the record does not already say.
//!
//! Muse gives a hook an allow-listed environment (`HOME`, `PATH`,
//! `MUSE_SESSION_ID`, …), so the tab's variables do not reach it; the settings
//! have no way to pass one (an `env` field gets the handler skipped). The
//! script reads them from the Muse that fired it: the nearest ancestor that
//! carries them, through `/proc` on Linux and `ps -E` where there is no
//! `/proc` (macOS, not verified). Windows has neither for another process, so
//! nothing is registered there and a Muse tab resumes as it did before.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::brand::DISPLAY;
use crate::services::agent_versions::{version_cmp, Seen};
use crate::services::home_io::HomeFile;

/// Muse's user settings in an agent home (a tab sets no `XDG_CONFIG_HOME`).
pub(super) const SETTINGS: &str = ".config/muse/settings.json";
/// The settings schema Tabtivity writes and merges into; any other is left alone.
const SCHEMA_VERSION: u64 = 1;
/// The event whose handler is the session record: what "registered" means.
const RECORD_EVENT: &str = "UserPromptSubmit";
/// The script, in `<state_dir>/hooks/` (read-only in the fence, at its own path).
const SCRIPT_NAME: &str = concat!(crate::app_slug!(), "_muse_session.sh");
/// What the hook leaves in its record folder the first time it records there:
/// the proof that the hook can record in that scope (`resolve`'s fresh start).
pub(super) const PROOF: &str = "muse.hook";
/// The oldest Muse whose settings were probed to take `hooks`.
const FIRST_HOOKED: &str = "1.3.0";

/// One event the script is registered for.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Event {
    name: &'static str,
    /// Muse admits the handler only as a background one.
    background: bool,
    /// The oldest release the probes saw run it.
    since: &'static str,
}

/// The events the script runs on (see the module head).
pub(super) const EVENTS: &[Event] = &[
    Event { name: "UserPromptSubmit", background: false, since: FIRST_HOOKED },
    Event { name: "SessionStart", background: false, since: FIRST_HOOKED },
    Event { name: "Stop", background: false, since: FIRST_HOOKED },
    Event { name: "SessionEnd", background: false, since: FIRST_HOOKED },
    Event { name: "Interrupt", background: true, since: "1.4.15" },
];

fn script_path() -> PathBuf {
    crate::storage::state_dir().join("hooks").join(SCRIPT_NAME)
}

/// The settings `command`. Quoted: a state dir with a space must not split it.
fn command() -> String {
    format!("\"{}\"", script_path().to_string_lossy())
}

/// The events a Muse of `version` runs the hook on: none before the first
/// release probed to take hooks.
pub(super) fn events_for(version: &str) -> Vec<&'static Event> {
    EVENTS.iter().filter(|e| version_cmp(version, e.since) != std::cmp::Ordering::Less).collect()
}

/// [`events_for`] the Muse last probed (`agent_versions`). An unknown version
/// gets none: a settings file Muse rejects stops every launch.
pub(super) fn hook_events(seen: Option<&Seen>) -> Vec<&'static Event> {
    seen.and_then(|seen| seen.version.as_deref()).map(events_for).unwrap_or_default()
}

/// What the script prints at a session's start in a project tab: the send
/// hint as context for the model.
fn hint_output() -> String {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": crate::services::agent_hint::HOOK_HINT,
        }
    })
    .to_string()
}

/// Write the script. Idempotent; part of
/// `agent_session::install_session_start_hook`. Not on Windows (see the module).
pub fn write_script() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = script_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = script_body(&crate::services::agent_session::live_sessions_dir().to_string_lossy(), "/proc");
        if std::fs::read(&path).ok().as_deref() != Some(body.as_bytes()) {
            std::fs::write(&path, body)?;
        }
        let mut perm = std::fs::metadata(&path)?.permissions();
        if perm.mode() & 0o777 != 0o755 {
            perm.set_mode(0o755);
            std::fs::set_permissions(&path, perm)?;
        }
    }
    Ok(())
}

/// Register the hook in one agent home, on the events the Muse last probed
/// runs it on. True when it is registered afterwards (also when it already
/// was, whatever the version says now). A settings file that is not plain
/// JSON, has another `schema_version`, or a `hooks` of another shape is left
/// as it is.
pub fn register_in_home(home: &Path) -> bool {
    if cfg!(windows) {
        return false;
    }
    let events = hook_events(crate::services::agent_versions::load().get("muse"));
    register_command_in(home, &command(), &events)
}

/// [`register_in_home`] for `cmd` on `events`; none leaves the file alone.
pub(super) fn register_command_in(home: &Path, cmd: &str, events: &[&Event]) -> bool {
    let Some(file) = HomeFile::open(home, SETTINGS) else {
        eprintln!("muse_session: {SETTINGS} in {} is not a plain path; hook skipped", home.display());
        return false;
    };
    if !events.is_empty() {
        if let Err(e) = crate::services::agent_hint::merge_json(&file, |root| add_hook(root, cmd, events)) {
            eprintln!("muse_session: register the hook in {}: {e}", home.display());
        }
    }
    file.read()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|root| lists(&root, cmd))
}

fn handlers(group: &Value) -> impl Iterator<Item = &Value> {
    group.get("hooks").and_then(Value::as_array).into_iter().flatten()
}

fn lists(root: &Value, cmd: &str) -> bool {
    root.get("schema_version").and_then(Value::as_u64) == Some(SCHEMA_VERSION)
        && root.get("hooks").and_then(|h| h.get(RECORD_EVENT)).and_then(Value::as_array).is_some_and(|groups| {
            groups.iter().flat_map(handlers).any(|h| h.get("command").and_then(Value::as_str) == Some(cmd))
        })
}

/// A handler of Tabtivity's: `cmd`, or one an earlier state dir wrote.
fn ours(handler: &Value, cmd: &str) -> bool {
    handler.get("command").and_then(Value::as_str).is_some_and(|c| c == cmd || c.contains(SCRIPT_NAME))
}

/// The handler `event` gets: `cmd`, in the background where Muse wants it so.
fn handler(event: &Event, cmd: &str) -> Value {
    let mut handler = json!({ "type": "command", "command": cmd });
    if event.background {
        handler["async"] = json!(true);
    }
    handler
}

/// Make the groups list `{"hooks": [handler]}` for each of `events` and no
/// other handler of ours anywhere: one of another state dir, of an event no
/// longer registered (a Muse downgraded), or of another shape goes, and so
/// does a group left empty by that. An entry an earlier spawn wrote (the
/// `UserPromptSubmit` one alone) is kept and the other events join it. False
/// when nothing changes, which is also the answer for a file not ours to touch.
fn add_hook(root: &mut Value, cmd: &str, events: &[&Event]) -> bool {
    let Some(obj) = root.as_object_mut() else { return false };
    let fresh = obj.is_empty();
    if !fresh && obj.get("schema_version").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return false;
    }
    if obj.get("hooks").is_some_and(|h| !h.is_object())
        || events.iter().any(|e| obj.get("hooks").and_then(|h| h.get(e.name)).is_some_and(|g| !g.is_array()))
    {
        return false;
    }
    let mut changed = fresh;
    if fresh {
        obj.insert("schema_version".into(), json!(SCHEMA_VERSION));
    }
    let hooks = obj.entry("hooks").or_insert_with(|| json!({})).as_object_mut().expect("checked above");
    let mut emptied = Vec::new();
    for (name, groups) in hooks.iter_mut() {
        let Some(groups) = groups.as_array_mut() else { continue };
        let want = events.iter().find(|e| e.name == name).map(|e| handler(e, cmd));
        let mut dropped = false;
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else { return true };
            let before = list.len();
            list.retain(|h| !ours(h, cmd) || want.as_ref() == Some(h));
            let removed = list.len() != before;
            dropped |= removed;
            // A group left empty by taking ours out was ours.
            !(removed && list.is_empty())
        });
        changed |= dropped;
        // So was an event left with no group: a release that does not know
        // it warns about the name at every launch.
        if dropped && groups.is_empty() && want.is_none() {
            emptied.push(name.clone());
        }
    }
    for name in emptied {
        hooks.remove(&name);
    }
    for event in events {
        let want = handler(event, cmd);
        let groups = hooks.entry(event.name).or_insert_with(|| json!([])).as_array_mut().expect("checked above");
        if !groups.iter().flat_map(handlers).any(|h| *h == want) {
            groups.push(json!({ "hooks": [want] }));
            changed = true;
        }
    }
    changed
}

/// The POSIX script. `proc_root` is baked in as a literal (`/proc`; a test's
/// own tree), never read from the environment: the hook runs under one the
/// agent can shape.
///
/// It acts only for the tab's own Muse: the tab agent names Muse (another
/// CLI's tab running `muse exec` is left out), the Muse that fired the hook
/// carries no `MUSE_SESSION_ID` (1.4.15 sets it for every process its tools
/// start, so a `muse exec` the tab's agent runs has it) and has no Muse of the
/// same name above it among the tab's processes (1.3.0 sets nothing; a nested
/// run sits under the tab's Muse). A launcher that execs the binary keeps one
/// process, so it adds no second. Of the tab's Muse, only its own session
/// counts: 1.4.15 names it to the hook (`MUSE_SESSION_ID`), and a subagent's
/// events carry the subagent's. `UserPromptSubmit` records the session; the
/// other turn events move the turn record only for the session recorded.
pub(super) fn script_body(live_dir: &str, proc_root: &str) -> String {
    format!(
        r#"#!/bin/sh
# {DISPLAY} Muse session hook: records which Muse session this tab is in (at a
# prompt), so the tab is restored into it (`resume <id>`) instead of the
# folder's newest, and the tab's turn state, which lights its working and
# finished marks: working at a prompt, done at Stop or an Esc (Interrupt),
# idle when the session ends. At a session's start it gives the model the send
# hint. Managed by {DISPLAY}; do not edit.
input=$(cat | tr '\n' ' ')
event=$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([a-zA-Z]*\)".*/\1/p')
case "$event" in SessionStart|UserPromptSubmit|Stop|Interrupt|SessionEnd) ;; *) exit 0 ;; esac
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p')
printf '%s\n' "$sid" | grep -Eqx '[0-9a-fA-F]{{8}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{12}}' || exit 0
# Muse names the session it runs (1.4.15): an event of another is a subagent's.
[ -z "${{MUSE_SESSION_ID-}}" ] || [ "$MUSE_SESSION_ID" = "$sid" ] || exit 0
# Muse hands a hook an allow-listed environment: the tab's variables are
# read from the Muse that fired it, the nearest ancestor that has them.
envof() {{ if [ -r "{proc_root}/$1/environ" ]; then tr '\0' '\n' < "{proc_root}/$1/environ"; else ps -E -ww -o command= -p "$1" 2>/dev/null | tr ' ' '\n'; fi; }}
up() {{ if [ -r "{proc_root}/$1/stat" ]; then sed 's/.*) [^ ]* \([0-9]*\).*/\1/' "{proc_root}/$1/stat"; else ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; fi; }}
name() {{ if [ -r "{proc_root}/$1/comm" ]; then cat "{proc_root}/$1/comm"; else ps -ww -o comm= -p "$1" 2>/dev/null; fi; }}
p=$PPID; hops=0; uid=; e=
while [ "$hops" -lt 4 ] && [ "$p" -gt 1 ] 2>/dev/null; do
  e=$(envof "$p")
  uid=$(printf '%s\n' "$e" | sed -n 's/^{uid_var}=//p' | head -n 1)
  [ -n "$uid" ] && break
  p=$(up "$p"); hops=$((hops + 1))
done
case "$uid" in ""|*[!0-9a-fA-F-]*) exit 0 ;; esac
[ "$(printf '%s\n' "$e" | sed -n 's/^{agent_var}=//p' | head -n 1)" = muse ] || exit 0
# A Muse the tab's agent started through its shell tool.
printf '%s\n' "$e" | grep -q '^MUSE_SESSION_ID=' && exit 0
self=$(name "$p"); q=$(up "$p"); n=0
while [ "$n" -lt 64 ] && [ "$q" -gt 1 ] 2>/dev/null && envof "$q" | grep -qx "{uid_var}=$uid"; do
  [ "$(name "$q")" = "$self" ] && exit 0
  q=$(up "$q"); n=$((n + 1))
done
if [ "$event" = SessionStart ]; then
  # Muse puts a start's additionalContext before the model; outside a
  # project tab there is no hint.
  [ -n "$(printf '%s\n' "$e" | sed -n 's/^{project_var}=//p' | head -n 1)" ] && printf '%s\n' '{hint}'
  exit 0
fi
dir="{live_dir}"
mkdir -p "$dir" 2>/dev/null || exit 0
if [ "$event" = UserPromptSubmit ]; then
  [ -e "$dir/{PROOF}" ] || : > "$dir/{PROOF}"
  if [ "$(cat "$dir/$uid" 2>/dev/null)" != "$sid" ]; then
    tmp="$dir/.$uid.$$"
    rm -f "$tmp"
    printf '%s' "$sid" > "$tmp" && mv -f "$tmp" "$dir/$uid"
  fi
  turn=working
else
  # A turn ends, and a session ends, in the session its prompts went to.
  [ "$(cat "$dir/$uid" 2>/dev/null)" = "$sid" ] || exit 0
  case "$event" in SessionEnd) turn=idle ;; *) turn=done ;; esac
fi
printf '%s %s' "$turn" "$(date +%s)" > "$dir/$uid.turn"
exit 0
"#,
        uid_var = crate::app_env!("TAB_UID"),
        agent_var = crate::services::agent_session::TAB_AGENT_ENV,
        project_var = crate::app_env!("PROJECT_DIR"),
        hint = hint_output(),
    )
}
#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "\"/state/hooks/x_muse_session.sh\"";

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn settings(home: &Path) -> PathBuf {
        SETTINGS.split('/').fold(home.to_path_buf(), |p, part| p.join(part))
    }

    /// Every event a 1.4.15 runs the hook on.
    fn all() -> Vec<&'static Event> {
        events_for("1.4.15")
    }

    /// The settings `hooks` the app writes for `events` into a new file.
    fn ours_for(events: &[&Event], cmd: &str) -> Value {
        Value::Object(events.iter().map(|e| (e.name.to_string(), json!([{ "hooks": [handler(e, cmd)] }]))).collect())
    }

    #[test]
    fn a_new_home_gets_settings_with_schema_version_one_and_the_hook() {
        let home = tempfile::tempdir().unwrap();
        assert!(register_command_in(home.path(), CMD, &all()));
        let got = read(&settings(home.path()));
        assert_eq!(got, json!({"schema_version": 1, "hooks": ours_for(&all(), CMD)}));
        assert_eq!(got["hooks"]["UserPromptSubmit"], json!([{"hooks": [{"type": "command", "command": CMD}]}]));
        assert_eq!(got["hooks"]["Interrupt"], json!([{"hooks": [{"type": "command", "command": CMD, "async": true}]}]));
    }

    #[test]
    fn which_events_a_release_gets() {
        let names = |v: &str| events_for(v).iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names("1.2.9"), Vec::<&str>::new());
        assert_eq!(names("1.3.0"), ["UserPromptSubmit", "SessionStart", "Stop", "SessionEnd"]);
        assert_eq!(names("1.4.14"), ["UserPromptSubmit", "SessionStart", "Stop", "SessionEnd"]);
        assert_eq!(names("1.4.15"), ["UserPromptSubmit", "SessionStart", "Stop", "SessionEnd", "Interrupt"]);
        assert_eq!(names("1.5.0"), names("1.4.15"));
    }

    #[test]
    fn the_users_settings_and_hooks_are_kept_and_a_second_run_changes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(home.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mine = json!({
            "schema_version": 1,
            "theme": "dark",
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "mine-stop"}]}],
                "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "mine"}]}],
                "PreToolUse": {"not": "a list"}
            }
        });
        std::fs::write(&path, serde_json::to_string(&mine).unwrap()).unwrap();
        assert!(register_command_in(home.path(), CMD, &all()));
        let got = read(&path);
        assert_eq!(got["theme"], "dark");
        assert_eq!(got["hooks"]["PreToolUse"], mine["hooks"]["PreToolUse"]);
        assert_eq!(got["hooks"]["Stop"][0], mine["hooks"]["Stop"][0]);
        assert_eq!(got["hooks"]["Stop"][1]["hooks"][0]["command"], CMD);
        assert_eq!(got["hooks"]["UserPromptSubmit"][0], mine["hooks"]["UserPromptSubmit"][0]);
        assert_eq!(got["hooks"]["UserPromptSubmit"][1]["hooks"][0]["command"], CMD);
        let bytes = std::fs::read(&path).unwrap();
        assert!(register_command_in(home.path(), CMD, &all()));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn a_settings_file_not_ours_to_merge_is_left_byte_for_byte() {
        for text in [
            r#"{"schema_version": 2, "hooks": {}}"#,
            r#"{"theme": "dark"}"#,
            r#"{"schema_version": 1, "hooks": []}"#,
            r#"{"schema_version": 1, "hooks": {"UserPromptSubmit": {}}}"#,
            r#"{"schema_version": 1, "hooks": {"Stop": "x"}}"#,
            r#"{"schema_version": 1, "hooks": {"Interrupt": 1}}"#,
            "{\"schema_version\": 1, // a comment\n}",
            "[1, 2]",
        ] {
            let home = tempfile::tempdir().unwrap();
            let path = settings(home.path());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            assert!(!register_command_in(home.path(), CMD, &all()), "{text}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[test]
    fn an_entry_an_earlier_state_dir_wrote_is_replaced() {
        let old = format!("\"/old/hooks/{SCRIPT_NAME}\"");
        let new = format!("\"/new/hooks/{SCRIPT_NAME}\"");
        let mut root = json!({"schema_version": 1, "hooks": {
            "UserPromptSubmit": [
                {"hooks": [{"type": "command", "command": "mine"}]},
                {"hooks": [{"type": "command", "command": old}]}
            ],
            "Stop": [{"hooks": [{"type": "command", "command": "mine"}, {"type": "command", "command": old}]}]
        }});
        assert!(add_hook(&mut root, &new, &all()));
        assert_eq!(root["hooks"]["UserPromptSubmit"], json!([
            {"hooks": [{"type": "command", "command": "mine"}]},
            {"hooks": [{"type": "command", "command": new}]}
        ]));
        assert_eq!(root["hooks"]["Stop"], json!([
            {"hooks": [{"type": "command", "command": "mine"}]},
            {"hooks": [{"type": "command", "command": new}]}
        ]));
        assert!(!add_hook(&mut root, &new, &all()));
    }

    #[test]
    fn the_entry_the_resume_work_wrote_gains_the_turn_events() {
        // What an earlier spawn registered: `UserPromptSubmit` alone.
        let mut root = json!({"schema_version": 1, "hooks": {
            "UserPromptSubmit": [{"hooks": [{"type": "command", "command": CMD}]}],
            "SessionStart": [{"hooks": [{"type": "command", "command": "mine"}]}]
        }});
        assert!(add_hook(&mut root, CMD, &all()));
        let mut want = ours_for(&all(), CMD);
        want["SessionStart"] = json!([
            {"hooks": [{"type": "command", "command": "mine"}]},
            {"hooks": [{"type": "command", "command": CMD}]}
        ]);
        assert_eq!(root["hooks"], want);
        assert!(!add_hook(&mut root, CMD, &all()));
        // A handler of ours of another shape (`Interrupt` without `async`,
        // which Muse would not admit) is put right.
        root["hooks"]["Interrupt"] = json!([{"hooks": [{"type": "command", "command": CMD}]}]);
        assert!(add_hook(&mut root, CMD, &all()));
        assert_eq!(root["hooks"], want);
        // A Muse back on 1.3.0: the event it does not know goes, with the
        // group and the name it leaves empty.
        assert!(add_hook(&mut root, CMD, &events_for("1.3.0")));
        assert!(root["hooks"].get("Interrupt").is_none(), "{}", root["hooks"]);
        assert_eq!(root["hooks"]["Stop"], want["Stop"]);
    }

    #[test]
    fn an_unprobed_or_older_muse_gets_no_hook_but_one_registered_earlier_counts() {
        let seen = |v: &str| Seen { version: Some(v.to_string()), ..Seen::default() };
        assert_eq!(hook_events(Some(&seen("1.3.0"))).len(), 4);
        assert_eq!(hook_events(Some(&seen("1.4.15"))).len(), 5);
        assert!(hook_events(Some(&seen("1.2.9"))).is_empty());
        assert!(hook_events(Some(&Seen::default())).is_empty());
        assert!(hook_events(None).is_empty());
        let home = tempfile::tempdir().unwrap();
        assert!(!register_command_in(home.path(), CMD, &[]));
        assert!(!settings(home.path()).exists());
        assert!(register_command_in(home.path(), CMD, &all()));
        assert!(register_command_in(home.path(), CMD, &[]));
    }

    #[test]
    fn the_hint_is_session_start_context_with_the_hook_hint() {
        let out: Value = serde_json::from_str(&hint_output()).unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(out["hookSpecificOutput"]["additionalContext"], crate::services::agent_hint::HOOK_HINT);
        assert!(!hint_output().contains('\''), "the script prints it single-quoted");
    }

    /// The script, run for real against a fake process tree under `proc`:
    /// `$PPID` of the `sh` running it is this test process.
    #[cfg(unix)]
    mod script {
        use super::super::*;

        const UID: &str = "0b9f6a52-3c1d-4e8a-9f00-1a2b3c4d5e6f";
        const SID: &str = "01a1e47c-fb54-7d83-ae22-28080626c9e6";

        struct Tree {
            _dir: tempfile::TempDir,
            proc_root: PathBuf,
            live: PathBuf,
            script: PathBuf,
        }

        /// One fake process: its pid, name, parent and environment.
        fn proc(tree: &Tree, pid: u32, comm: &str, ppid: u32, env: &[(&str, &str)]) {
            let dir = tree.proc_root.join(pid.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("comm"), format!("{comm}\n")).unwrap();
            std::fs::write(dir.join("stat"), format!("{pid} ({comm}) S {ppid} 1 1 0")).unwrap();
            let environ: Vec<u8> = env.iter().flat_map(|(k, v)| format!("{k}={v}\0").into_bytes()).collect();
            std::fs::write(dir.join("environ"), environ).unwrap();
        }

        fn new_tree() -> Tree {
            let dir = tempfile::tempdir().unwrap();
            let proc_root = dir.path().join("proc");
            let live = dir.path().join("live");
            let script = dir.path().join("hook.sh");
            std::fs::create_dir_all(&proc_root).unwrap();
            std::fs::write(&script, script_body(&live.to_string_lossy(), &proc_root.to_string_lossy())).unwrap();
            Tree { _dir: dir, proc_root, live, script }
        }

        fn tab_env(agent: &str) -> Vec<(&'static str, String)> {
            vec![("PATH", "/usr/bin".into()), (crate::app_env!("TAB_UID"), UID.into()), (crate::services::agent_session::TAB_AGENT_ENV, agent.into())]
        }

        fn as_ref<'a>(env: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
            env.iter().map(|(k, v)| (*k, v.as_str())).collect()
        }

        /// Fire `event` of session `sid` with the hook's own environment
        /// `hook_env` (Muse's allow-list: 1.4.15 puts `MUSE_SESSION_ID` there,
        /// 1.3.0 nothing); what the script printed.
        fn fire_with(tree: &Tree, event: &str, sid: &str, hook_env: &[(&str, &str)]) -> String {
            use std::io::Write;
            let mut child = std::process::Command::new("sh")
                .arg(&tree.script)
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .envs(hook_env.iter().copied())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let input = format!(
                r#"{{"cwd":"/w","hook_event_name":"{event}","model":"m","permission_mode":"default","prompt":"say \"session_id\":\"{UID}\"","session_id":"{sid}","transcript_path":null,"turn_id":"t"}}"#
            );
            child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap()
        }

        fn fire(tree: &Tree, event: &str, sid: &str) {
            let out = fire_with(tree, event, sid, &[]);
            assert!(out.is_empty(), "the hook printed {out:?}");
        }

        fn record(tree: &Tree) -> Option<String> {
            std::fs::read_to_string(tree.live.join(UID)).ok()
        }

        /// The turn record's word, as `agent_turn` parses it.
        fn turn(tree: &Tree) -> Option<crate::services::agent_turn::TurnState> {
            let text = std::fs::read_to_string(tree.live.join(format!("{UID}.turn"))).ok()?;
            crate::services::agent_turn::parse_turn_record(&text)
        }

        #[test]
        fn the_tabs_own_muse_records_its_prompted_session_and_leaves_the_proof() {
            let tree = new_tree();
            // The hook's parent is the tab's Muse; above it, a shell of the tab.
            proc(&tree, std::process::id(), "muse", 900, &as_ref(&tab_env("muse")));
            proc(&tree, 900, "sh", 1, &as_ref(&tab_env("muse")));
            fire(&tree, "SessionStart", SID);
            assert_eq!(record(&tree), None, "only a prompt records");
            fire(&tree, "UserPromptSubmit", SID);
            assert_eq!(record(&tree).as_deref(), Some(SID));
            assert!(tree.live.join(PROOF).exists());
        }

        #[test]
        fn a_hook_runner_between_muse_and_the_script_is_looked_past() {
            let tree = new_tree();
            proc(&tree, std::process::id(), "sh", 900, &[("PATH", "/usr/bin")]);
            proc(&tree, 900, "muse", 1, &as_ref(&tab_env("muse")));
            fire(&tree, "UserPromptSubmit", SID);
            assert_eq!(record(&tree).as_deref(), Some(SID));
        }

        #[test]
        fn a_foreign_tab_agent_a_junk_id_and_a_tab_less_muse_record_nothing() {
            let tree = new_tree();
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&tab_env("claude")));
            fire(&tree, "UserPromptSubmit", SID);
            assert_eq!(record(&tree), None);
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&tab_env("muse")));
            fire(&tree, "UserPromptSubmit", "../../etc");
            fire(&tree, "UserPromptSubmit", "01a1e47c");
            assert_eq!(record(&tree), None);
            proc(&tree, std::process::id(), "muse", 1, &[("PATH", "/usr/bin")]);
            fire(&tree, "UserPromptSubmit", SID);
            assert_eq!(record(&tree), None);
            assert!(!tree.live.join(PROOF).exists());
        }

        #[test]
        fn a_muse_the_tabs_agent_runs_through_its_shell_tool_records_nothing() {
            // 1.4.15: the nested run carries the session its tool ran under.
            let tree = new_tree();
            let mut nested = tab_env("muse");
            nested.push(("MUSE_SESSION_ID", "01a1e47c-0000-7000-8000-000000000000".into()));
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&nested));
            fire(&tree, "UserPromptSubmit", SID);
            assert_eq!(record(&tree), None);
            // 1.3.0: nothing set, but the tab's Muse is above it.
            let tree = new_tree();
            proc(&tree, std::process::id(), "muse", 900, &as_ref(&tab_env("muse")));
            proc(&tree, 900, "sh", 901, &as_ref(&tab_env("muse")));
            proc(&tree, 901, "muse", 902, &as_ref(&tab_env("muse")));
            proc(&tree, 902, "bash", 1, &as_ref(&tab_env("muse")));
            fire(&tree, "UserPromptSubmit", SID);
            assert_eq!(record(&tree), None);
            // A Muse of another tab above it is not the tab's.
            let tree = new_tree();
            let mut other = tab_env("muse");
            other[1].1 = "11111111-2222-4333-8444-555555555555".into();
            proc(&tree, std::process::id(), "muse", 900, &as_ref(&tab_env("muse")));
            proc(&tree, 900, "muse", 1, &as_ref(&other));
            fire(&tree, "UserPromptSubmit", SID);
            assert_eq!(record(&tree).as_deref(), Some(SID));
        }

        #[test]
        fn a_new_session_in_the_tab_moves_the_record() {
            // `/clear` starts one; its first prompt is the tab's own.
            let tree = new_tree();
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&tab_env("muse")));
            fire(&tree, "UserPromptSubmit", SID);
            let next = "01a1e47d-32eb-76a0-b445-eb7d4be82860";
            fire(&tree, "UserPromptSubmit", next);
            assert_eq!(record(&tree).as_deref(), Some(next));
        }

        #[test]
        fn each_event_writes_its_turn_word_for_the_tabs_own_session() {
            use crate::services::agent_turn::TurnState;
            let tree = new_tree();
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&tab_env("muse")));
            // 1.4.15 names the session to the hook; 1.3.0 does not.
            for own in [&[("MUSE_SESSION_ID", SID)][..], &[]] {
                assert!(fire_with(&tree, "UserPromptSubmit", SID, own).is_empty());
                assert_eq!(turn(&tree), Some(TurnState::Working));
                fire_with(&tree, "Stop", SID, own);
                assert_eq!(turn(&tree), Some(TurnState::Done));
                fire_with(&tree, "UserPromptSubmit", SID, own);
                fire_with(&tree, "Interrupt", SID, own);
                assert_eq!(turn(&tree), Some(TurnState::Done));
                // The events it is not registered for say nothing.
                fire_with(&tree, "UserPromptSubmit", SID, own);
                for event in ["PreToolUse", "PostToolUse", "PreLLMCall", "SubagentStop", "Notification", "StopFailure"] {
                    fire_with(&tree, event, SID, own);
                    assert_eq!(turn(&tree), Some(TurnState::Working), "{event}");
                }
                fire_with(&tree, "SessionEnd", SID, own);
                assert_eq!(turn(&tree), Some(TurnState::Idle));
            }
        }

        #[test]
        fn a_turn_event_of_another_session_moves_nothing() {
            use crate::services::agent_turn::TurnState;
            let tree = new_tree();
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&tab_env("muse")));
            fire(&tree, "UserPromptSubmit", SID);
            // A subagent's events carry its own session; 1.4.15 names the
            // main one to the hook.
            const CHILD: &str = "01a1e4d3-0000-7000-8000-00000000c536";
            for event in ["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"] {
                fire_with(&tree, event, CHILD, &[("MUSE_SESSION_ID", SID)]);
            }
            assert_eq!(record(&tree).as_deref(), Some(SID));
            assert_eq!(turn(&tree), Some(TurnState::Working));
            // A Stop or an end of a session the tab's prompts did not go to
            // (a launch that took none, ending) moves nothing either.
            fire(&tree, "Stop", CHILD);
            fire(&tree, "SessionEnd", CHILD);
            assert_eq!(turn(&tree), Some(TurnState::Working));
        }

        #[test]
        fn a_nested_muse_moves_no_turn_record() {
            let tree = new_tree();
            let mut nested = tab_env("muse");
            nested.push(("MUSE_SESSION_ID", "01a1e47c-0000-7000-8000-000000000000".into()));
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&nested));
            for event in ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"] {
                fire_with(&tree, event, SID, &[("MUSE_SESSION_ID", SID)]);
            }
            assert!(!tree.live.exists(), "the nested run wrote a record");
        }

        #[test]
        fn a_session_start_gives_the_hint_only_in_a_project_tab_and_records_nothing() {
            let tree = new_tree();
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&tab_env("muse")));
            assert_eq!(fire_with(&tree, "SessionStart", SID, &[("MUSE_SESSION_ID", SID)]), "");
            let mut project = tab_env("muse");
            project.push((crate::app_env!("PROJECT_DIR"), "/w".into()));
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&project));
            assert_eq!(fire_with(&tree, "SessionStart", SID, &[("MUSE_SESSION_ID", SID)]), format!("{}\n", hint_output()));
            assert!(!tree.live.exists(), "a start recorded something");
            // Not for a subagent's start, nor in another CLI's tab.
            assert_eq!(fire_with(&tree, "SessionStart", "01a1e4d3-0000-7000-8000-00000000c536", &[("MUSE_SESSION_ID", SID)]), "");
            project[2].1 = "claude".into();
            proc(&tree, std::process::id(), "muse", 1, &as_ref(&project));
            assert_eq!(fire_with(&tree, "SessionStart", SID, &[]), "");
        }
    }
}
