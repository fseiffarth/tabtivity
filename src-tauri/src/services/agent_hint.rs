//! The one-line `tabtivity-send` hint for the agent CLIs past Claude and Codex.
//!
//! Claude and Codex learn the command from Tabtivity's session hook
//! (`agent_session`), which prints it on `SessionStart`. The project scaffold's
//! `AGENTS.md` used to carry it for everyone else, but that file is the user's,
//! committed and never rewritten, so the text froze in every project and
//! reached collaborators' agents where the command doesn't exist. This module
//! delivers it from Tabtivity's own side instead, per CLI, in the one way each
//! one takes context at session start:
//!
//! - **A `SessionStart` hook** where the CLI has one that feeds the model:
//!   Gemini, Qwen, Auggie and CodeBuddy (Claude's `settings.json` shape and
//!   `hookSpecificOutput.additionalContext`), Droid (`.factory/hooks.json`,
//!   plain stdout), Cursor (`.cursor/hooks.json`, `additional_context`) and
//!   Copilot (a file of its own in `.copilot/hooks/`, `additionalContext`).
//!   All point at one script in `<state_dir>/hooks/`, read-only in the fence,
//!   which prints the hint in the shape asked for and stays silent outside an
//!   Tabtivity project tab.
//! - **Instructions** where it has no such hook. Mistral Vibe loads its
//!   user-level `.vibe/AGENTS.md` beside the project's, so Tabtivity keeps a
//!   marker-delimited block there; only the text between the markers is
//!   Tabtivity's. OpenCode gets a file of Tabtivity's in its `instructions` list
//!   (`.config/opencode/opencode.json`) instead: its user-level `AGENTS.md`
//!   would *replace* the `~/.claude/CLAUDE.md` it otherwise falls back to,
//!   which is where the user's global instructions reach it.
//!
//! Everything is written into Tabtivity's per-scope agent homes at each spawn,
//! after the global layer (`agent_global`) — never the user's own home — and
//! through directory handles (`home_io`), as `agent_session` registers its
//! hooks. AppHandle-free.

use crate::brand::{DISPLAY, UPPER};
use std::io;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::services::home_io::HomeFile;
use crate::storage;

/// What every CLI is told.
pub const HINT: &str =
    concat!("To put a file in front of the user on their phone, run `", crate::app_slug!(), "-send <file>` (local and container tabs).");

#[cfg(not(windows))]
const SCRIPT_NAME: &str = crate::brand::AGENT_HINT_SH;
#[cfg(windows)]
const SCRIPT_NAME: &str = crate::brand::AGENT_HINT_PS1;

/// How the script prints the hint — each CLI parses its hook's stdout its own way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// The bare line (Droid).
    Plain,
    /// `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`
    /// (Gemini, Qwen, Auggie, CodeBuddy).
    Context,
    /// `{"additionalContext":…}` (Copilot).
    Copilot,
    /// `{"additional_context":…}` (Cursor).
    Cursor,
}

impl Shape {
    const ALL: [Shape; 4] = [Shape::Plain, Shape::Context, Shape::Copilot, Shape::Cursor];

    fn arg(self) -> &'static str {
        match self {
            Shape::Plain => "plain",
            Shape::Context => "context",
            Shape::Copilot => "copilot",
            Shape::Cursor => "cursor",
        }
    }

    /// What the hook prints in a Tabtivity project tab.
    fn output(self) -> String {
        match self {
            Shape::Plain => HINT.to_string(),
            Shape::Context => json!({
                "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": HINT }
            })
            .to_string(),
            Shape::Copilot => json!({ "additionalContext": HINT }).to_string(),
            Shape::Cursor => json!({ "additional_context": HINT }).to_string(),
        }
    }

    /// What it prints anywhere else: nothing, or the empty object for a CLI
    /// that parses stdout as JSON.
    fn silent(self) -> &'static str {
        match self {
            Shape::Plain => "",
            _ => "{}",
        }
    }
}

/// Claude-shaped `settings.json` files (`{"hooks": {"SessionStart": [{"hooks":
/// [{type, command}]}]}}`) whose CLI adds `additionalContext` to the session.
pub(crate) const SETTINGS_HOOKS: &[&str] = &[
    ".gemini/settings.json",
    ".qwen/settings.json",
    ".augment/settings.json",
    ".codebuddy/settings.json",
];

/// Droid's user hooks: the same groups with the events at the top level.
pub(crate) const DROID_HOOKS: &str = ".factory/hooks.json";
pub(crate) const CURSOR_HOOKS: &str = ".cursor/hooks.json";
/// Copilot loads every `*.json` in its user hooks directory, so this file is
/// Tabtivity's alone and simply rewritten.
const COPILOT_HOOKS: &str = crate::brand::COPILOT_HINT_HOOKS;
/// Vibe's user-level instructions, loaded beside the project's `AGENTS.md`.
pub(crate) const VIBE_INSTRUCTIONS: &str = ".vibe/AGENTS.md";
/// OpenCode's global config; its `instructions` files add to `AGENTS.md`.
pub(crate) const OPENCODE_CONFIG: &str = ".config/opencode/opencode.json";
/// The hint as an instructions file, beside the script: the hooks dir is
/// mounted read-only at its own path in the fence.
const INSTRUCTIONS_NAME: &str = crate::brand::AGENT_HINT_MD;

const BLOCK_START: &str = crate::brand::AGENT_HINT_START;
const BLOCK_END: &str = crate::brand::AGENT_HINT_END;

fn script_path() -> PathBuf {
    storage::state_dir().join("hooks").join(SCRIPT_NAME)
}

fn instructions_path() -> PathBuf {
    storage::state_dir().join("hooks").join(INSTRUCTIONS_NAME)
}

/// The command a CLI runs for `shape`. The path is quoted: a state dir with a
/// space in it must not split the command.
fn command(shape: Shape) -> String {
    let path = script_path();
    #[cfg(windows)]
    {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\" {}",
            path.to_string_lossy(),
            shape.arg()
        )
    }
    #[cfg(not(windows))]
    {
        format!("\"{}\" {}", path.to_string_lossy(), shape.arg())
    }
}

/// The app's variables the script reads; see `agent_session::HOOK_ENV`.
const HINT_ENV: &[&str] = &["TAB_UID", "PROJECT_DIR"];

/// POSIX body. Every printed string is a single-quoted literal, which is why
/// [`HINT`] must never hold a `'` (a test pins that).
#[cfg_attr(windows, allow(dead_code))]
fn posix_script_body() -> String {
    let mut cases = String::new();
    for shape in Shape::ALL {
        cases.push_str(&format!("  {}) printf '%s\\n' '{}' ;;\n", shape.arg(), shape.output()));
    }
    let mut quiet = String::new();
    for shape in Shape::ALL.into_iter().filter(|s| !s.silent().is_empty()) {
        quiet.push_str(&format!("  {}) printf '%s\\n' '{}' ;;\n", shape.arg(), shape.silent()));
    }
    format!(
        "#!/bin/sh\n\
         # {DISPLAY} agent hint (SessionStart): tells an agent in a {DISPLAY} project tab\n\
         # how to put a file on the user's phone, in the output shape its CLI reads\n\
         # ($1). Silent anywhere else. Managed by {DISPLAY}; do not edit.\n\
         {legacy_env}if [ -z \"${UPPER}_TAB_UID\" ] || [ -z \"${UPPER}_PROJECT_DIR\" ]; then\n\
         \x20 case \"$1\" in\n{quiet}  esac\n\
         \x20 exit 0\n\
         fi\n\
         case \"$1\" in\n{cases}esac\n",
        legacy_env = crate::services::brand_migration::compat::script_preamble_sh(HINT_ENV),
    )
}

/// PowerShell twin, for a Windows host.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_script_body() -> String {
    let mut cases = String::new();
    for shape in Shape::ALL {
        cases.push_str(&format!("  '{}' {{ Write-Output '{}' }}\r\n", shape.arg(), shape.output()));
    }
    let mut quiet = String::new();
    for shape in Shape::ALL.into_iter().filter(|s| !s.silent().is_empty()) {
        quiet.push_str(&format!("    '{}' {{ Write-Output '{}' }}\r\n", shape.arg(), shape.silent()));
    }
    format!(
        "param([string]$Shape = 'plain')\r\n\
         # {DISPLAY} agent hint (SessionStart) - see the POSIX twin. Managed by {DISPLAY}; do not edit.\r\n\
         {legacy_env}if (-not $env:{UPPER}_TAB_UID -or -not $env:{UPPER}_PROJECT_DIR) {{\r\n\
         \x20 switch ($Shape) {{\r\n{quiet}  }}\r\n\
         \x20 exit 0\r\n\
         }}\r\n\
         switch ($Shape) {{\r\n{cases}}}\r\n",
        legacy_env = crate::services::brand_migration::compat::script_preamble_ps1(HINT_ENV),
    )
}

/// Write the hint script and instructions file beside the session hook.
/// Idempotent; part of `agent_session::install_session_start_hook`.
pub fn write_script() -> io::Result<()> {
    let path = script_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(instructions_path(), format!("{HINT}\n"))?;
    #[cfg(windows)]
    std::fs::write(&path, powershell_script_body())?;
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, posix_script_body())?;
        let mut perm = std::fs::metadata(&path)?.permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&path, perm)?;
    }
    Ok(())
}

/// Register the hint in one Tabtivity agent home. Best effort per file, logged; a
/// linked config dir is skipped, as for the session hooks.
pub fn register_in_home(home: &std::path::Path) {
    let report = |rel: &str, result: io::Result<()>| {
        if let Err(e) = result {
            eprintln!("agent_hint: {rel} in {}: {e}", home.display());
        }
    };
    let open = |rel: &str| {
        let file = HomeFile::open(home, rel);
        if file.is_none() {
            eprintln!("agent_hint: {rel} in {} is not a plain path; skipped", home.display());
        }
        file
    };
    for rel in SETTINGS_HOOKS {
        if let Some(file) = open(rel) {
            report(rel, merge_json(&file, |root| add_session_start_group(root, true, &command(Shape::Context))));
        }
    }
    if let Some(file) = open(DROID_HOOKS) {
        report(DROID_HOOKS, merge_json(&file, |root| add_session_start_group(root, false, &command(Shape::Plain))));
    }
    if let Some(file) = open(CURSOR_HOOKS) {
        report(CURSOR_HOOKS, merge_json(&file, |root| add_cursor_hook(root, &command(Shape::Cursor))));
    }
    if let Some(file) = open(COPILOT_HOOKS) {
        report(COPILOT_HOOKS, write_if_changed(&file, copilot_hooks(&command(Shape::Copilot)).as_bytes()));
    }
    if let Some(file) = open(VIBE_INSTRUCTIONS) {
        let current = file.read().map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        report(VIBE_INSTRUCTIONS, write_if_changed(&file, with_block(&current).as_bytes()));
    }
    if let Some(file) = open(OPENCODE_CONFIG) {
        let path = instructions_path().to_string_lossy().into_owned();
        report(OPENCODE_CONFIG, merge_json(&file, |root| add_instructions(root, &path)));
    }
}

/// Add `path` to OpenCode's `instructions` list. False when it is there.
fn add_instructions(root: &mut Value, path: &str) -> bool {
    let list = slot(root, "instructions", json!([])).as_array_mut().expect("an array");
    let present = list.iter().any(|p| p.as_str() == Some(path));
    if !present {
        list.push(json!(path));
    }
    !present
}

fn write_if_changed(file: &HomeFile, bytes: &[u8]) -> io::Result<()> {
    if file.read().as_deref() == Some(bytes) {
        return Ok(());
    }
    file.write(bytes)
}

/// Read a JSON config, let `edit` add Tabtivity's hook, write it back only when
/// that changed something. A file that is there but isn't plain JSON (some
/// CLIs accept comments) is left alone rather than replaced.
fn merge_json(file: &HomeFile, edit: impl FnOnce(&mut Value) -> bool) -> io::Result<()> {
    let mut root = match file.read() {
        None => json!({}),
        Some(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => json!({}),
        Some(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => v,
            _ => return Ok(()),
        },
    };
    if !edit(&mut root) {
        return Ok(());
    }
    let text = serde_json::to_string_pretty(&root).map_err(io::Error::other)?;
    file.write(text.as_bytes())
}

/// Make `object[key]` a JSON value of `default`'s kind, keeping one that already is.
fn slot<'a>(object: &'a mut Value, key: &str, default: Value) -> &'a mut Value {
    let map = object.as_object_mut().expect("callers pass objects");
    let entry = map.entry(key).or_insert_with(|| default.clone());
    if std::mem::discriminant(entry) != std::mem::discriminant(&default) {
        *entry = default;
    }
    entry
}

/// Add `{"hooks": [{"type": "command", "command": cmd}]}` to the `SessionStart`
/// groups — under `hooks` when `wrapped`, at the top level otherwise (Droid's
/// `hooks.json`). False when a group already runs `cmd`.
fn add_session_start_group(root: &mut Value, wrapped: bool, cmd: &str) -> bool {
    let events = if wrapped { slot(root, "hooks", json!({})) } else { root };
    let groups = slot(events, "SessionStart", json!([])).as_array_mut().expect("an array");
    let present = groups.iter().any(|g| {
        g.get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hs| hs.iter().any(|h| h.get("command").and_then(Value::as_str) == Some(cmd)))
    });
    if !present {
        groups.push(json!({ "hooks": [{ "type": "command", "command": cmd }] }));
    }
    !present
}

/// Cursor's `{"version": 1, "hooks": {"sessionStart": [{"command": cmd}]}}`.
fn add_cursor_hook(root: &mut Value, cmd: &str) -> bool {
    let mut changed = false;
    if root.get("version").is_none() {
        root["version"] = json!(1);
        changed = true;
    }
    let hooks = slot(root, "hooks", json!({}));
    let list = slot(hooks, "sessionStart", json!([])).as_array_mut().expect("an array");
    if !list.iter().any(|h| h.get("command").and_then(Value::as_str) == Some(cmd)) {
        list.push(json!({ "command": cmd }));
        changed = true;
    }
    changed
}

/// Copilot's hook file. It runs the `bash` command on Linux/macOS and the
/// `powershell` one on Windows; Tabtivity registers the host's own.
fn copilot_hooks(cmd: &str) -> String {
    let key = if cfg!(windows) { "powershell" } else { "bash" };
    let mut hook = json!({ "type": "command", "timeoutSec": 10 });
    hook[key] = json!(cmd);
    let file = json!({ "version": 1, "hooks": { "sessionStart": [hook] } });
    serde_json::to_string_pretty(&file).expect("plain JSON") + "\n"
}

/// `current` with Tabtivity's block in it: replaced in place when the markers are
/// there, appended otherwise. Nothing outside the markers changes.
fn with_block(current: &str) -> String {
    let block = format!("{BLOCK_START}\n{HINT}\n{BLOCK_END}\n");
    if let Some(start) = current.find(BLOCK_START) {
        if let Some(end) = current[start..].find(BLOCK_END).map(|i| start + i + BLOCK_END.len()) {
            let rest = current[end..].strip_prefix('\n').unwrap_or(&current[end..]);
            return format!("{}{block}{rest}", &current[..start]);
        }
    }
    let mut out = current.to_string();
    if !out.is_empty() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    out.push_str(&block);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_json(path: &std::path::Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn hint_never_breaks_the_single_quoted_script_literals() {
        for shape in Shape::ALL {
            assert!(!shape.output().contains('\''), "{shape:?}");
        }
    }

    #[test]
    fn json_shapes_print_valid_json_naming_the_command() {
        for shape in [Shape::Context, Shape::Copilot, Shape::Cursor] {
            let v: Value = serde_json::from_str(&shape.output()).unwrap();
            assert!(v.to_string().contains(concat!(crate::app_slug!(), "-send <file>")), "{shape:?}");
            let _: Value = serde_json::from_str(shape.silent()).unwrap();
        }
        let v: Value = serde_json::from_str(&Shape::Context.output()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(v["hookSpecificOutput"]["additionalContext"], HINT);
    }

    #[cfg(unix)]
    #[test]
    fn script_prints_each_shape_only_in_an_app_project_tab() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hint.sh");
        std::fs::write(&script, posix_script_body()).unwrap();
        let run = |shape: Shape, tab: bool, project: bool| {
            let mut cmd = std::process::Command::new("sh");
            cmd.arg(&script).arg(shape.arg()).env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap_or_default());
            if tab { cmd.env(crate::app_env!("TAB_UID"), "aaaa"); }
            if project { cmd.env(crate::app_env!("PROJECT_DIR"), dir.path()); }
            let out = cmd.output().unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap()
        };
        for shape in Shape::ALL {
            assert_eq!(run(shape, true, true), format!("{}\n", shape.output()), "{shape:?}");
            let quiet = if shape.silent().is_empty() { String::new() } else { format!("{}\n", shape.silent()) };
            assert_eq!(run(shape, false, true), quiet, "{shape:?} outside a tab");
            assert_eq!(run(shape, true, false), quiet, "{shape:?} without a project");
        }
    }

    #[test]
    fn powershell_twin_covers_every_shape() {
        let body = powershell_script_body();
        for shape in Shape::ALL {
            assert!(body.contains(&format!("'{}' {{ Write-Output '{}' }}", shape.arg(), shape.output())));
        }
    }

    #[test]
    fn registration_is_idempotent_and_keeps_what_was_there() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        std::fs::write(
            home.join(".gemini/settings.json"),
            r#"{"ui":{"theme":"x"},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"mine"}]}]}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.join(".factory")).unwrap();
        std::fs::write(home.join(".factory/hooks.json"), r#"{"PreToolUse":[]}"#).unwrap();
        std::fs::create_dir_all(home.join(".vibe")).unwrap();
        std::fs::write(home.join(".vibe/AGENTS.md"), "# Mine\n\nKeep this.\n").unwrap();
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::write(home.join(OPENCODE_CONFIG), r#"{"model":"m","instructions":["mine.md"]}"#).unwrap();

        register_in_home(home);
        let snapshot = |rel: &str| std::fs::read(home.join(rel)).unwrap();
        let first: Vec<_> = [".gemini/settings.json", ".factory/hooks.json", ".cursor/hooks.json", COPILOT_HOOKS, VIBE_INSTRUCTIONS, OPENCODE_CONFIG]
            .iter()
            .map(|rel| snapshot(rel))
            .collect();
        register_in_home(home);
        let second: Vec<_> = [".gemini/settings.json", ".factory/hooks.json", ".cursor/hooks.json", COPILOT_HOOKS, VIBE_INSTRUCTIONS, OPENCODE_CONFIG]
            .iter()
            .map(|rel| snapshot(rel))
            .collect();
        assert_eq!(first, second);

        let gemini = read_json(&home.join(".gemini/settings.json"));
        assert_eq!(gemini["ui"]["theme"], "x");
        let groups = gemini["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["hooks"][0]["command"], "mine");
        assert_eq!(groups[1]["hooks"][0]["command"], command(Shape::Context));
        for rel in [".qwen/settings.json", ".augment/settings.json", ".codebuddy/settings.json"] {
            assert_eq!(read_json(&home.join(rel))["hooks"]["SessionStart"][0]["hooks"][0]["command"], command(Shape::Context));
        }

        let droid = read_json(&home.join(".factory/hooks.json"));
        assert!(droid["PreToolUse"].is_array());
        assert!(droid.get("hooks").is_none(), "Droid's events sit at the top level");
        assert_eq!(droid["SessionStart"][0]["hooks"][0]["command"], command(Shape::Plain));

        let cursor = read_json(&home.join(".cursor/hooks.json"));
        assert_eq!(cursor["version"], 1);
        assert_eq!(cursor["hooks"]["sessionStart"][0]["command"], command(Shape::Cursor));

        let copilot = read_json(&home.join(COPILOT_HOOKS));
        let key = if cfg!(windows) { "powershell" } else { "bash" };
        assert_eq!(copilot["hooks"]["sessionStart"][0][key], command(Shape::Copilot));

        let vibe = std::fs::read_to_string(home.join(".vibe/AGENTS.md")).unwrap();
        assert!(vibe.starts_with("# Mine\n\nKeep this.\n"));
        assert_eq!(vibe.matches(BLOCK_START).count(), 1);
        let opencode = read_json(&home.join(OPENCODE_CONFIG));
        assert_eq!(opencode["model"], "m");
        assert_eq!(opencode["instructions"], json!(["mine.md", instructions_path().to_string_lossy()]));
        // Its user-level AGENTS.md would shadow the ~/.claude/CLAUDE.md fallback.
        assert!(!home.join(".config/opencode/AGENTS.md").exists());
    }

    #[test]
    fn a_config_that_is_not_plain_json_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".gemini")).unwrap();
        let jsonc = "{\n  // mine\n  \"ui\": {}\n}\n";
        std::fs::write(tmp.path().join(".gemini/settings.json"), jsonc).unwrap();
        register_in_home(tmp.path());
        assert_eq!(std::fs::read_to_string(tmp.path().join(".gemini/settings.json")).unwrap(), jsonc);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_config_dir_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".gemini")).unwrap();
        register_in_home(&home);
        assert!(!outside.join("settings.json").exists());
    }

    #[test]
    fn the_block_is_replaced_in_place_and_nothing_around_it_moves() {
        let once = with_block("before\n");
        assert_eq!(once, format!("before\n\n{BLOCK_START}\n{HINT}\n{BLOCK_END}\n"));
        let stale = format!("top\n{BLOCK_START}\nold text\n{BLOCK_END}\nbottom\n");
        assert_eq!(with_block(&stale), format!("top\n{BLOCK_START}\n{HINT}\n{BLOCK_END}\nbottom\n"));
        assert_eq!(with_block(&with_block("")), with_block(""));
        assert_eq!(with_block(""), format!("{BLOCK_START}\n{HINT}\n{BLOCK_END}\n"));
    }

    #[test]
    fn the_global_layer_import_recognises_the_hint_as_app_s() {
        let hooks_dir = storage::state_dir().join("hooks").to_string_lossy().into_owned();
        let mut settings = json!({});
        add_session_start_group(&mut settings, true, &command(Shape::Context));
        crate::services::agent_global::strip_app_json_hooks(&mut settings, &hooks_dir);
        assert_eq!(settings, json!({}));
    }
}
