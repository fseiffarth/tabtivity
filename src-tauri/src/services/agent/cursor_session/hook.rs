//! Cursor's session hook: the script that records which chat a Cursor tab's
//! prompt went into, and its registration in an agent home's
//! `.cursor/hooks.json`.
//!
//! Probed on 2026.11.22 (`scripts/verify-cli/cursor/hooks.py`,
//! `docs/third_party_update_checklist.md`): the hooks file takes
//! `{"version": 1, "hooks": {"<event>": [{"command": …}]}}`, a hook inherits
//! the CLI's whole environment (the tab's variables included) and gets the
//! payload as one line of JSON on stdin whose first key is `conversation_id`
//! — the chat's directory name in the store. The hint hook (`agent_hint`)
//! already sits on `sessionStart`, which fires only for a fresh launch, never
//! on `--continue`, `--resume` or a `/clear`; this one sits on
//! `beforeSubmitPrompt`, which fires at every prompt with the chat it goes
//! into (the new chat's id after a `/clear`).
//!
//! It acts only for the tab's own Cursor: the tab agent names `cursor-agent`,
//! and no `CURSOR_CONVERSATION_ID` is set — Cursor puts that in the
//! environment of the commands its shell tool runs, so a `cursor-agent -p`
//! the agent starts there (which inherits the tab's keys) records nothing.
//! The chat id is read from the payload's first key only: the prompt, later
//! in the line, is the user's own text and may spell any key.
//!
//! The hooks file is plain JSON a user may have written to: it is merged only
//! when it parses as an object, atomically, and never when a `hooks` of
//! another shape is in the way. Windows has no script for it (the tab's
//! restore stays `--continue`).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::brand::DISPLAY;
use crate::services::agent_hint::{merge_json, slot, CURSOR_HOOKS};
use crate::services::home_io::HomeFile;

/// The event whose handler is the chat record: what "registered" means.
pub(super) const RECORD_EVENT: &str = "beforeSubmitPrompt";
/// The script, in `<state_dir>/hooks/` (read-only in the fence, at its own path).
const SCRIPT_NAME: &str = concat!(crate::app_slug!(), "_cursor_session.sh");
/// What the hook leaves in its record folder the first time it records there:
/// the proof that the hook can record in that scope (`resolve`'s fresh start).
pub(super) const PROOF: &str = "cursor.hook";

fn script_path() -> PathBuf {
    crate::storage::state_dir().join("hooks").join(SCRIPT_NAME)
}

/// The hooks `command`. Quoted: a state dir with a space must not split it.
fn command() -> String {
    format!("\"{}\"", script_path().to_string_lossy())
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
        let body = script_body(&crate::services::agent_session::live_sessions_dir().to_string_lossy());
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

/// Register the hook in one agent home. True when it is registered afterwards
/// (also when it already was). A hooks file that is not plain JSON, or has a
/// `hooks` of another shape, is left as it is.
pub fn register_in_home(home: &Path) -> bool {
    if cfg!(windows) {
        return false;
    }
    register_command_in(home, &command())
}

/// [`register_in_home`] for `cmd`.
pub(super) fn register_command_in(home: &Path, cmd: &str) -> bool {
    let Some(file) = HomeFile::open(home, CURSOR_HOOKS) else {
        eprintln!("cursor_session: {CURSOR_HOOKS} in {} is not a plain path; hook skipped", home.display());
        return false;
    };
    if let Err(e) = merge_json(&file, |root| add_hook(root, cmd)) {
        eprintln!("cursor_session: register the hook in {}: {e}", home.display());
    }
    file.read()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|root| lists(&root, cmd))
}

fn commands(root: &Value) -> impl Iterator<Item = &str> {
    root.get("hooks")
        .and_then(|hooks| hooks.get(RECORD_EVENT))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|handler| handler.get("command").and_then(Value::as_str))
}

fn lists(root: &Value, cmd: &str) -> bool {
    commands(root).any(|c| c == cmd)
}

/// Make `hooks.beforeSubmitPrompt` list `cmd` once and no other handler of
/// ours (one an earlier state dir wrote). False when nothing changes, which
/// is also the answer for a file not ours to touch.
fn add_hook(root: &mut Value, cmd: &str) -> bool {
    let Some(obj) = root.as_object() else { return false };
    if obj.get("hooks").is_some_and(|hooks| !hooks.is_object())
        || obj.get("hooks").and_then(|hooks| hooks.get(RECORD_EVENT)).is_some_and(|list| !list.is_array())
    {
        return false;
    }
    let mut changed = false;
    if root.get("version").is_none() {
        root["version"] = json!(1);
        changed = true;
    }
    let hooks = slot(root, "hooks", json!({}));
    let list = slot(hooks, RECORD_EVENT, json!([])).as_array_mut().expect("an array");
    let before = list.len();
    list.retain(|h| h.get("command").and_then(Value::as_str).is_none_or(|c| c == cmd || !c.contains(SCRIPT_NAME)));
    changed |= list.len() != before;
    if !list.iter().any(|h| h.get("command").and_then(Value::as_str) == Some(cmd)) {
        list.push(json!({ "command": cmd }));
        changed = true;
    }
    changed
}

/// The POSIX script. `live_dir` is baked in as a literal: the hook runs under
/// an environment the agent can shape.
#[cfg_attr(windows, allow(dead_code))]
pub(super) fn script_body(live_dir: &str) -> String {
    format!(
        r#"#!/bin/sh
# {DISPLAY} Cursor session hook (beforeSubmitPrompt): records which chat this tab's
# prompt went into, so the tab is restored into it (`--resume <id>`) instead of the
# folder's newest chat (`--continue`). Managed by {DISPLAY}; do not edit.
# The payload is read whole before anything else: a hook that exits with it unread
# leaves Cursor writing the prompt into a closed pipe.
input=$(cat | tr '\n' ' ')
[ "${agent_var}" = cursor-agent ] || exit 0
# A cursor-agent the tab's agent started through its shell tool.
[ -z "${{CURSOR_CONVERSATION_ID-}}" ] || exit 0
uid="${uid_var}"
case "$uid" in ""|*[!0-9a-fA-F-]*) exit 0 ;; esac
# The chat is the payload's first key; the prompt later in the line is the user's text.
sid=$(printf '%s' "$input" | sed -n 's/^[[:space:]]*{{[[:space:]]*"conversation_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p')
printf '%s\n' "$sid" | grep -Eqx '[0-9a-fA-F]{{8}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{12}}' || exit 0
dir="{live_dir}"
mkdir -p "$dir" 2>/dev/null || exit 0
[ -e "$dir/{PROOF}" ] || : > "$dir/{PROOF}"
if [ "$(cat "$dir/$uid" 2>/dev/null)" != "$sid" ]; then
  tmp="$dir/.$uid.$$"
  rm -f "$tmp"
  printf '%s' "$sid" > "$tmp" && mv -f "$tmp" "$dir/$uid"
fi
exit 0
"#,
        agent_var = crate::services::agent_session::TAB_AGENT_ENV,
        uid_var = crate::app_env!("TAB_UID"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "\"/state/hooks/x_cursor_session.sh\"";

    fn hooks_file(home: &Path) -> PathBuf {
        CURSOR_HOOKS.split('/').fold(home.to_path_buf(), |p, part| p.join(part))
    }

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn a_new_home_gets_the_hook_on_the_prompt_event() {
        let home = tempfile::tempdir().unwrap();
        assert!(register_command_in(home.path(), CMD));
        assert_eq!(read(&hooks_file(home.path())), json!({"version": 1, "hooks": {"beforeSubmitPrompt": [{"command": CMD}]}}));
    }

    #[test]
    fn the_hint_hook_and_the_users_hooks_are_kept_and_a_second_run_changes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let path = hooks_file(home.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mine = json!({
            "version": 1,
            "hooks": {
                "sessionStart": [{"command": "hint"}],
                "beforeSubmitPrompt": [{"command": "mine"}],
                "stop": [{"command": "mine-stop"}]
            }
        });
        std::fs::write(&path, serde_json::to_string(&mine).unwrap()).unwrap();
        assert!(register_command_in(home.path(), CMD));
        let got = read(&path);
        assert_eq!(got["hooks"]["sessionStart"], mine["hooks"]["sessionStart"]);
        assert_eq!(got["hooks"]["stop"], mine["hooks"]["stop"]);
        assert_eq!(got["hooks"]["beforeSubmitPrompt"], json!([{"command": "mine"}, {"command": CMD}]));
        let bytes = std::fs::read(&path).unwrap();
        assert!(register_command_in(home.path(), CMD));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn an_entry_an_earlier_state_dir_wrote_is_replaced() {
        let home = tempfile::tempdir().unwrap();
        let path = hooks_file(home.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let old = format!("\"/old/hooks/{SCRIPT_NAME}\"");
        std::fs::write(&path, json!({"version": 1, "hooks": {"beforeSubmitPrompt": [{"command": old}]}}).to_string()).unwrap();
        assert!(register_command_in(home.path(), CMD));
        assert_eq!(read(&path)["hooks"]["beforeSubmitPrompt"], json!([{"command": CMD}]));
    }

    #[test]
    fn a_hooks_file_not_ours_to_merge_is_left_byte_for_byte() {
        for text in [
            r#"{"version": 1, "hooks": []}"#,
            r#"{"version": 1, "hooks": {"beforeSubmitPrompt": {}}}"#,
            "{\"version\": 1, // a comment\n}",
            "[1, 2]",
        ] {
            let home = tempfile::tempdir().unwrap();
            let path = hooks_file(home.path());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            assert!(!register_command_in(home.path(), CMD), "{text}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[cfg(unix)]
    mod script {
        use super::*;
        use std::io::Write;

        const UID: &str = "0b9c6a52-5d55-4c3e-9f57-3f2b1a0c9d11";
        const CHAT: &str = "afb75573-5a88-4851-928a-5be05bdbef4b";
        const OTHER: &str = "b2d700b6-b740-4a49-adda-0729c12f05a1";

        struct Tree {
            _dir: tempfile::TempDir,
            live: PathBuf,
            script: PathBuf,
        }

        fn new_tree() -> Tree {
            let dir = tempfile::tempdir().unwrap();
            let live = dir.path().join("live");
            let script = dir.path().join("hook.sh");
            std::fs::write(&script, script_body(&live.to_string_lossy())).unwrap();
            Tree { _dir: dir, live, script }
        }

        fn env(agent: &str) -> Vec<(&'static str, String)> {
            vec![(crate::app_env!("TAB_UID"), UID.into()), (crate::services::agent_session::TAB_AGENT_ENV, agent.into())]
        }

        /// Fire a `beforeSubmitPrompt` of `chat` (the payload as Cursor writes it,
        /// the prompt spelling a key of its own) under `env`.
        fn fire(tree: &Tree, chat: &str, env: &[(&'static str, String)]) {
            fire_padded(tree, chat, env, 0);
        }

        /// [`fire`] with a prompt `pad` bytes long: a payload past the pipe's
        /// buffer, which the hook must read whole whatever it decides.
        fn fire_padded(tree: &Tree, chat: &str, env: &[(&'static str, String)], pad: usize) {
            let mut child = std::process::Command::new("sh")
                .arg(&tree.script)
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let filler = "x".repeat(pad);
            let input = format!(
                r#"{{"conversation_id": "{chat}", "generation_id": "{chat}", "model": "default", "prompt": "say \"conversation_id\": \"{OTHER}\"{filler}", "attachments": [], "session_id": "{chat}", "hook_event_name": "beforeSubmitPrompt", "transcript_path": null}}"#
            );
            child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            assert!(out.stdout.is_empty(), "the hook printed {:?}", String::from_utf8_lossy(&out.stdout));
        }

        fn record(tree: &Tree) -> Option<String> {
            std::fs::read_to_string(tree.live.join(UID)).ok()
        }

        #[test]
        fn the_tabs_own_cursor_records_the_chat_of_its_prompt_and_leaves_the_proof() {
            let tree = new_tree();
            fire(&tree, CHAT, &env("cursor-agent"));
            assert_eq!(record(&tree).as_deref(), Some(CHAT));
            assert!(tree.live.join(PROOF).is_file());
            // A /clear: the next prompt is another chat.
            fire(&tree, OTHER, &env("cursor-agent"));
            assert_eq!(record(&tree).as_deref(), Some(OTHER));
        }

        #[test]
        fn another_clis_tab_and_a_run_from_the_shell_tool_record_nothing() {
            let tree = new_tree();
            fire(&tree, CHAT, &env("claude"));
            let mut nested = env("cursor-agent");
            nested.push(("CURSOR_CONVERSATION_ID", CHAT.into()));
            fire(&tree, CHAT, &nested);
            fire(&tree, CHAT, &[]);
            let mut bad = env("cursor-agent");
            bad[0].1 = "../x".into();
            fire(&tree, CHAT, &bad);
            assert_eq!(record(&tree), None);
            assert!(!tree.live.join(PROOF).exists());
        }

        #[test]
        fn a_hook_that_acts_on_nothing_still_reads_the_whole_payload() {
            // A big prompt written to a hook that exits at its first guard: the
            // write must not hit a closed pipe (`fire_padded` unwraps it).
            let tree = new_tree();
            fire_padded(&tree, CHAT, &env("claude"), 1 << 20);
            fire_padded(&tree, CHAT, &[], 1 << 20);
            assert_eq!(record(&tree), None);
            fire_padded(&tree, CHAT, &env("cursor-agent"), 1 << 20);
            assert_eq!(record(&tree).as_deref(), Some(CHAT));
        }

        #[test]
        fn a_prompt_spelling_the_key_never_moves_the_record() {
            // The payload names `OTHER` in its prompt after the real key.
            let tree = new_tree();
            fire(&tree, CHAT, &env("cursor-agent"));
            assert_eq!(record(&tree).as_deref(), Some(CHAT));
        }
    }
}
