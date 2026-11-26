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
//! Two CLIs read no `AGENTS.md` by default, and the project scaffold no longer
//! carries `CLAUDE.md`/`GEMINI.md` pointer files, so the same register points
//! them at it from the home side: Gemini gets `AGENTS.md` added to
//! `context.fileName` in `.gemini/settings.json` (its own `GEMINI.md` stays),
//! Aider gets it in the `read:` list of `.aider.conf.yml`. Both are unions: a
//! user's entries stay, a file that is not what we expect is left alone.
//!
//! Where a CLI loads user skills from its home, a **skill** of the same name
//! as the command carries what one line cannot: piped output, `--clear`, the
//! limits and exit codes — and it is a slash command the user can type
//! (`/<slug>-send report.pdf` in Claude). The hint stays: a skill only loads
//! when the model matches its description, and the line is always there.
//! Not in the assistant's or the probe's home (`agent_home` decides).
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

/// The send line, as a literal: [`HINT`] and [`HOOK_HINT`] are built from it.
macro_rules! send_hint {
    () => {
        concat!("When the user asks you to send or show them a file, run `", crate::app_slug!(), "-send <file>` (local and container tabs): it goes to the screen they last typed from, the phone or the desktop. Do what its output says: for the desktop, name the path it prints in your reply, and the chat shows the pictures and PDFs a reply names. Add `--phone` or `--desktop` when the user names a screen.")
    };
}

/// What every CLI is told: Claude and Codex through their session hook.
macro_rules! links_hint {
    () => {
        concat!("In answers, link to app settings with Markdown, for example [Git access token](", crate::app_slug!(), "://settings/git/access-token) or [Mobile setup](", crate::app_slug!(), "://settings/mobile). Settings search offers Copy link for exact controls; use the help tools to read the settings-links topic for the complete destination catalog. Use only known setting, project and tab identifiers, never invent them or include secrets in links. Links navigate only when clicked.")
    };
}

pub const HINT: &str = concat!(send_hint!(), " ", links_hint!());

/// The `<slug>-mcp` line: Tabtivity's MCP tools for a CLI the lanes could not
/// name them to at launch (`agent_registry::McpWiring::None`).
macro_rules! tools_hint {
    () => {
        concat!(
            "This tab may also hold ", crate::app_name!(), " tools (print a PDF once the user approves it, push, PDF markup questions, ",
            "messages to the other agent tabs of the project, ", crate::app_name!(), " help). When they are not among your own tools, run `", crate::app_slug!(),
            "-mcp` to list the servers, `", crate::app_slug!(), "-mcp tools SERVER` for their tools and arguments, and `",
            crate::app_slug!(), "-mcp call SERVER TOOL JSON` to call one, with the arguments as one quoted JSON object."
        )
    };
}

/// What the CLIs past Claude and Codex are told, by hook or instructions
/// file: the send line and the `<slug>-mcp` line.
pub const HOOK_HINT: &str = concat!(send_hint!(), " ", tools_hint!(), " ", links_hint!());

/// The send skill's folder and `name`, which is also Claude's slash command.
pub const SKILL_NAME: &str = concat!(crate::app_slug!(), "-send");

/// The user-skill folders of the CLIs that load one from their home, checked
/// against the installed binaries on 2026-11-08: Claude 2.1.319 reads
/// `.claude/skills`, and so does OpenCode 2.2.6; Codex 0.167.0 reads
/// `$CODEX_HOME/skills` (`.codex` in a tab's home); Copilot 1.0.107 reads
/// `.copilot/skills`. Antigravity 1.5.16 reads `.gemini/config/skills` (its
/// migration target for legacy workflows; verified 2026-11-24 offline: `/skills`
/// lists a skill there and the request to the model carries its description).
/// OpenCode, Codex, Copilot and Antigravity also read the shared
/// `.agents/skills`, which is left out: each of them would list the skill
/// twice. A CLI not listed here gets only the hint.
pub(crate) const SKILL_DIRS: &[&str] =
    &[".claude/skills", ".codex/skills", ".copilot/skills", ".gemini/config/skills"];

/// The skill's `SKILL.md`: the Agent Skills frontmatter (`name`,
/// `description` only — the two keys every reader takes, Codex's own skill
/// validator rejects any other, and an `allowed-tools` grant would be
/// Tabtivity choosing a permission) and the
/// command's whole contract, as `scripts/<slug>-send.sh` implements it.
pub fn skill_md() -> String {
    let cmd = SKILL_NAME;
    format!(
        "---
name: {cmd}
description: Send or show the user a file on their phone or in the desktop chat with `{cmd}`. Use when the user asks you to send, show or share a file, put one on their phone or screen, or wants to look at something you produced (a plot, a PDF, an image, a log). Local and container tabs only.
---

# Send a file to the user

`{cmd}` puts a file in front of the user on the screen they last typed from: their phone or this desktop chat.

```
{cmd} FILE...               # where they last typed; both screens when that is unknown
{cmd} --phone FILE...       # when the user names the phone
{cmd} --desktop FILE...     # when the user names the desktop
command | {cmd} -n NAME     # piped output, as a file called NAME; always the phone
{cmd} --clear               # empty the phone outbox
```

Invoked with arguments (`/{cmd} report.pdf`), send those files.

## Then do what each line it prints says

- `→ phone: <file> (<n> KB) — shown as an image / opens as a PDF / …`: it is on the phone. Tell the user it was sent.
- `→ desktop: name <path> in your reply …`: write that project-relative path in your reply. The desktop chat shows the pictures and PDFs a reply names.

## Limits

- Regular, non-empty files of at most 24 MiB each. Send a folder as an archive; a big file as an excerpt or a compressed copy.
- The desktop shows files inside the project only: copy a file from elsewhere into the project first, then send the copy.
- Never send secrets (`.env` files, keys, tokens, credentials) unless the user names that file.
- `--clear` only when the user asks, or after the outbox is full and the user agrees.
- Exit 2 is a usage error, 3 no project directory, 4 a file it cannot send, 5 busy (`another send … in progress`: retry once) or full (`The outbox is full`: ask before `--clear`).
- Not in a remote (SSH) tab: the command is missing there. Say so; do not copy the file somewhere by hand.
"
    )
}

/// Write the send skill into each of [`SKILL_DIRS`] in one agent home. Best
/// effort per file, logged; a linked config dir is skipped, as for the hooks.
/// A copy the agent edited in its scope's home is put back here.
pub fn write_skill_in_home(home: &std::path::Path) {
    let body = skill_md();
    for dir in SKILL_DIRS {
        let rel = format!("{dir}/{SKILL_NAME}/SKILL.md");
        match HomeFile::open(home, &rel) {
            Some(file) => {
                if let Err(e) = write_if_changed(&file, body.as_bytes()) {
                    eprintln!("agent_hint: {rel} in {}: {e}", home.display());
                }
            }
            None => eprintln!("agent_hint: {rel} in {} is not a plain path; skipped", home.display()),
        }
    }
}

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
            Shape::Plain => HOOK_HINT.to_string(),
            Shape::Context => json!({
                "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": HOOK_HINT }
            })
            .to_string(),
            Shape::Copilot => json!({ "additionalContext": HOOK_HINT }).to_string(),
            Shape::Cursor => json!({ "additional_context": HOOK_HINT }).to_string(),
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
/// Gemini's user settings; `context.fileName` names the instruction files it
/// loads (default `GEMINI.md` only, so `AGENTS.md` is not read).
pub(crate) const GEMINI_SETTINGS: &str = ".gemini/settings.json";
/// The names Gemini gets in `context.fileName`, `GEMINI.md` first: the first
/// name is where its `save_memory` writes.
const GEMINI_CONTEXT_FILES: &[&str] = &["GEMINI.md", "AGENTS.md"];
/// Aider's user config; its `read:` list holds read-only files, cwd-relative.
pub(crate) const AIDER_CONFIG: &str = ".aider.conf.yml";
/// The project's instruction file Aider is told to read.
const AIDER_READ_FILE: &str = "AGENTS.md";
/// A config over this is not read (an agent wrote it): left as it is.
const CONFIG_CAP: u64 = 1 << 20;
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
const HINT_ENV: &[&str] = &["TAB_UID", "TAB_AGENT", "PROJECT_DIR"];

/// POSIX body. Every printed string is a single-quoted literal, which is why
/// [`HOOK_HINT`] must never hold a `'` (a test pins that).
#[cfg_attr(windows, allow(dead_code))]
fn posix_script_body() -> String {
    posix_script_body_in(&crate::services::agent_session::live_sessions_dir().to_string_lossy())
}

/// [`posix_script_body`] recording Copilot's session under `live_dir`.
#[cfg_attr(windows, allow(dead_code))]
fn posix_script_body_in(live_dir: &str) -> String {
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
         {legacy_env}# Copilot's start also says which session the tab is in (a /new or an in-CLI\n\
         # /resume rolls it): record it under the tab's key, where the next spawn pins it\n\
         # (`copilot_session`). Only the CLI the tab runs may move the record; a nested one\n\
         # inherits {UPPER}_TAB_UID, and one its own shell tool started also inherits the\n\
         # COPILOT_AGENT_SESSION_ID Copilot sets for its tools' commands.\n\
         if [ \"$1\" = copilot ] && [ \"${UPPER}_TAB_AGENT\" = copilot ] && [ -n \"${UPPER}_TAB_UID\" ] && [ -z \"$COPILOT_AGENT_SESSION_ID\" ]; then\n\
         \x20 case \"${UPPER}_TAB_UID\" in *[!a-zA-Z0-9-]*) ;; *)\n\
         \x20   sid=$(cat | tr '\\n' ' ' | sed -n 's/.*\"sessionId\"[[:space:]]*:[[:space:]]*\"\\([0-9a-fA-F-]*\\)\".*/\\1/p')\n\
         \x20   if [ -n \"$sid\" ] && mkdir -p \"{live_dir}\" 2>/dev/null; then printf '%s' \"$sid\" > \"{live_dir}/${UPPER}_TAB_UID\"; fi ;;\n\
         \x20 esac\n\
         fi\n\
         if [ -z \"${UPPER}_TAB_UID\" ] || [ -z \"${UPPER}_PROJECT_DIR\" ]; then\n\
         \x20 case \"$1\" in\n{quiet}  esac\n\
         \x20 exit 0\n\
         fi\n\
         case \"$1\" in\n{cases}esac\n",
        legacy_env = crate::services::brand_migration::compat::script_preamble_sh(HINT_ENV),
        live_dir = live_dir,
    )
}

/// The Copilot hint as the hooks probe registers it: the script body recording
/// under `live_dir`, and the hooks file running it from `script`.
#[cfg(all(test, unix))]
pub(crate) fn copilot_hint_for_probe(live_dir: &str, script: &std::path::Path) -> (String, String) {
    let cmd = format!("{} {}", crate::quote::posix(&script.to_string_lossy()), Shape::Copilot.arg());
    (posix_script_body_in(live_dir), copilot_hooks(&cmd))
}

/// PowerShell twin, for a Windows host.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_script_body() -> String {
    let live_dir = crate::quote::powershell(&crate::services::agent_session::live_sessions_dir().to_string_lossy());
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
         {legacy_env}# Copilot's start says which session the tab is in: record it (see the POSIX twin).\r\n\
         if (($Shape -eq 'copilot') -and ($env:{UPPER}_TAB_AGENT -eq 'copilot') -and ($env:{UPPER}_TAB_UID -match '^[A-Za-z0-9-]+$') -and (-not $env:COPILOT_AGENT_SESSION_ID)) {{\r\n\
         \x20 $payload = [Console]::In.ReadToEnd()\r\n\
         \x20 $m = [regex]::Match($payload, '\"sessionId\"\\s*:\\s*\"([0-9A-Fa-f-]+)\"')\r\n\
         \x20 if ($m.Success) {{\r\n\
         \x20   $dir = {live_dir}\r\n\
         \x20   [void](New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue)\r\n\
         \x20   [IO.File]::WriteAllText((Join-Path $dir $env:{UPPER}_TAB_UID), $m.Groups[1].Value)\r\n\
         \x20 }}\r\n\
         }}\r\n\
         if (-not $env:{UPPER}_TAB_UID -or -not $env:{UPPER}_PROJECT_DIR) {{\r\n\
         \x20 switch ($Shape) {{\r\n{quiet}  }}\r\n\
         \x20 exit 0\r\n\
         }}\r\n\
         switch ($Shape) {{\r\n{cases}}}\r\n",
        legacy_env = crate::services::brand_migration::compat::script_preamble_ps1(HINT_ENV),
        live_dir = live_dir,
    )
}

/// Write the hint script and instructions file beside the session hook.
/// Idempotent; part of `agent_session::install_session_start_hook`.
pub fn write_script() -> io::Result<()> {
    let path = script_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(instructions_path(), format!("{HOOK_HINT}\n"))?;
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
    // After the hooks above and after `agent_global::apply_to_home` (the caller's
    // order): ours is the last word on the names.
    if let Some(file) = open(GEMINI_SETTINGS) {
        report(GEMINI_SETTINGS, merge_json(&file, |root| add_context_file_names(root, GEMINI_CONTEXT_FILES)));
    }
    if let Some(file) = open(AIDER_CONFIG) {
        report(AIDER_CONFIG, merge_aider_read(&file, AIDER_READ_FILE));
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

/// Make `names` part of Gemini's `context.fileName`, which is a string or a
/// list. A user's entries all stay and keep their order; the missing names are
/// appended, so the list starts with `names` only when there was none. False
/// when nothing changed, or when `context` / `fileName` is not the shape
/// Gemini documents (left for the user to sort out, never replaced).
fn add_context_file_names(root: &mut Value, names: &[&str]) -> bool {
    let Some(map) = root.as_object_mut() else { return false };
    let Some(context) = map.entry("context").or_insert_with(|| json!({})).as_object_mut() else { return false };
    let before = context.get("fileName").cloned().unwrap_or(Value::Null);
    let mut list = match &before {
        Value::Null => Vec::new(),
        Value::String(s) if s.trim().is_empty() => Vec::new(),
        Value::String(_) => vec![before.clone()],
        Value::Array(a) => a.clone(),
        _ => return false,
    };
    for name in names {
        if !list.iter().any(|v| v.as_str() == Some(name)) {
            list.push(json!(name));
        }
    }
    let after = Value::Array(list);
    if after == before {
        return false;
    }
    context.insert("fileName".into(), after);
    true
}

/// Make `name` (relative, like `AGENTS.md`) part of the `read:` list in an
/// Aider config (a YAML mapping; `read` is a string or a list). Entries stay
/// in order. A file that is not a mapping, whose `read` is neither a string
/// nor a list, that is not UTF-8 or is over [`CONFIG_CAP`] is left alone. The
/// file is rewritten only when the list changed; YAML comments in a mapping
/// do not survive that (it sits in Tabtivity's own agent home).
fn merge_aider_read(file: &HomeFile, name: &str) -> io::Result<()> {
    use serde_norway::Value as Y;
    let bytes = match file.read_capped(CONFIG_CAP) {
        Some(bytes) => Some(bytes),
        None if file.is_file() => return Ok(()),
        None => None,
    };
    let text = match bytes.map(String::from_utf8) {
        None => String::new(),
        Some(Ok(text)) => text,
        Some(Err(_)) => return Ok(()),
    };
    let is_there = |y: &Y| y.as_str().is_some_and(|s| s == name || s.strip_prefix("./") == Some(name));
    let Ok(doc) = serde_norway::from_str::<Y>(&text) else { return Ok(()) };
    let mut map = match doc {
        Y::Mapping(map) => map,
        // Empty, or comments only: keep the text and add the key under it.
        Y::Null => {
            // A document that is the scalar `null` / `~` is not "empty":
            // a mapping appended under it would not parse. Left alone.
            if text.lines().any(|l| !matches!(l.trim(), "" | "---") && !l.trim_start().starts_with('#')) {
                return Ok(());
            }
            let mut out = text;
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!("read:\n  - {name}\n"));
            return file.write(out.as_bytes());
        }
        _ => return Ok(()),
    };
    let key = Y::from("read");
    let list = match map.get(&key) {
        None | Some(Y::Null) => vec![Y::from(name)],
        Some(current @ Y::String(_)) => {
            if is_there(current) {
                return Ok(());
            }
            vec![current.clone(), Y::from(name)]
        }
        Some(Y::Sequence(list)) => {
            if list.iter().any(is_there) {
                return Ok(());
            }
            let mut list = list.clone();
            list.push(Y::from(name));
            list
        }
        Some(_) => return Ok(()),
    };
    map.insert(key, Y::Sequence(list));
    let out = serde_norway::to_string(&Y::Mapping(map)).map_err(io::Error::other)?;
    file.write(out.as_bytes())
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
pub(crate) fn merge_json(file: &HomeFile, edit: impl FnOnce(&mut Value) -> bool) -> io::Result<()> {
    let bytes = match file.read_capped(CONFIG_CAP) {
        Some(bytes) => Some(bytes),
        // Over the cap: not ours to replace.
        None if file.is_file() => return Ok(()),
        None => None,
    };
    let mut root = match bytes {
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
pub(crate) fn slot<'a>(object: &'a mut Value, key: &str, default: Value) -> &'a mut Value {
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
    let block = format!("{BLOCK_START}\n{HOOK_HINT}\n{BLOCK_END}\n");
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
        assert_eq!(v["hookSpecificOutput"]["additionalContext"], HOOK_HINT);
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

    #[cfg(unix)]
    #[test]
    fn copilot_start_records_the_session_for_the_tabs_own_copilot_only() {
        use std::io::Write;
        use std::process::Stdio;
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        let script = dir.path().join("hint.sh");
        std::fs::write(&script, posix_script_body_in(&live.to_string_lossy())).unwrap();
        const UID: &str = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
        const SID: &str = "0123abcd-0000-4000-8000-00000000cafe";
        let payload = format!(r#"{{"sessionId":"{SID}","timestamp":1,"cwd":"/w","source":"new","initialPrompt":"a \"sessionId\":\"deadbeef\" b"}}"#);
        let run_in = |shape: &str, agent: Option<&str>, uid: &str, nested: bool| {
            let mut cmd = std::process::Command::new("sh");
            cmd.arg(&script).arg(shape).env_clear().env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .env(crate::app_env!("TAB_UID"), uid).env(crate::app_env!("PROJECT_DIR"), dir.path())
                .stdin(Stdio::piped()).stdout(Stdio::piped());
            if let Some(agent) = agent { cmd.env(crate::app_env!("TAB_AGENT"), agent); }
            // Copilot 1.0.112 sets it for the commands its tools run, so a
            // `copilot -p` the tab's agent started carries it.
            if nested { cmd.env("COPILOT_AGENT_SESSION_ID", UID); }
            let mut child = cmd.spawn().unwrap();
            // A script that records nothing never reads its stdin, and may be gone
            // before the payload is written.
            match child.stdin.take().unwrap().write_all(payload.as_bytes()) {
                Err(e) if e.kind() != std::io::ErrorKind::BrokenPipe => panic!("{e}"),
                _ => {}
            }
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap()
        };
        let run = |shape: &str, agent: Option<&str>, uid: &str| run_in(shape, agent, uid, false);
        // Not the tab's Copilot (a Claude tab running a nested one, a `copilot -p`
        // from the tab's own shell tool), another CLI's shape, a bad key: nothing.
        run("copilot", Some("claude"), UID);
        run_in("copilot", Some("copilot"), UID, true);
        run("context", Some("copilot"), UID);
        run("copilot", Some("copilot"), "../x");
        assert!(!live.exists());
        // The hint still prints, and the session is recorded under the tab's key.
        assert_eq!(run("copilot", Some("copilot"), UID), format!("{}\n", Shape::Copilot.output()));
        assert_eq!(std::fs::read_to_string(live.join(UID)).unwrap(), SID);
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

    fn gemini_names(home: &std::path::Path) -> Value {
        read_json(&home.join(GEMINI_SETTINGS))["context"]["fileName"].clone()
    }

    fn put(home: &std::path::Path, rel: &str, text: &str) {
        let path = home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn gemini_reads_agents_md_next_to_its_own_file_and_nothing_else_moves() {
        let tmp = tempfile::tempdir().unwrap();
        // A fresh home gets both names, GEMINI.md first (where save_memory writes).
        register_in_home(tmp.path());
        assert_eq!(gemini_names(tmp.path()), json!(["GEMINI.md", "AGENTS.md"]));
        let once = std::fs::read(tmp.path().join(GEMINI_SETTINGS)).unwrap();
        register_in_home(tmp.path());
        assert_eq!(std::fs::read(tmp.path().join(GEMINI_SETTINGS)).unwrap(), once);

        // The user's own list keeps its order; only what is missing is appended.
        let own = tempfile::tempdir().unwrap();
        put(own.path(), GEMINI_SETTINGS, r#"{"ui":{"theme":"x"},"context":{"fileName":["MINE.md","AGENTS.md"],"other":1}}"#);
        register_in_home(own.path());
        assert_eq!(gemini_names(own.path()), json!(["MINE.md", "AGENTS.md", "GEMINI.md"]));
        let settings = read_json(&own.path().join(GEMINI_SETTINGS));
        assert_eq!(settings["ui"]["theme"], "x");
        assert_eq!(settings["context"]["other"], 1);
        register_in_home(own.path());
        assert_eq!(gemini_names(own.path()), json!(["MINE.md", "AGENTS.md", "GEMINI.md"]));

        // A string becomes a list that starts with it.
        let single = tempfile::tempdir().unwrap();
        put(single.path(), GEMINI_SETTINGS, r#"{"context":{"fileName":"MINE.md"}}"#);
        register_in_home(single.path());
        assert_eq!(gemini_names(single.path()), json!(["MINE.md", "GEMINI.md", "AGENTS.md"]));
    }

    #[test]
    fn gemini_settings_of_an_unexpected_shape_are_not_replaced() {
        for text in [
            r#"{"context":"nope"}"#,
            r#"{"context":{"fileName":7}}"#,
            r#"{"context":{"fileName":{"a":1}}}"#,
            "[1,2]",
            "{\n  // mine\n  \"context\": {}\n}\n",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            put(tmp.path(), GEMINI_SETTINGS, text);
            register_in_home(tmp.path());
            let now = std::fs::read_to_string(tmp.path().join(GEMINI_SETTINGS)).unwrap();
            // The hook merge may add its group to valid JSON objects; the context never changes.
            if serde_json::from_str::<Value>(text).is_ok_and(|v| v.is_object()) {
                assert_eq!(serde_json::from_str::<Value>(&now).unwrap()["context"], serde_json::from_str::<Value>(text).unwrap()["context"], "{text}");
            } else {
                assert_eq!(now, text);
            }
        }
    }

    #[test]
    fn gemini_names_survive_the_global_layer_applied_before_ours() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        put(&crate::services::agent_global::global_dir_in(&state), GEMINI_SETTINGS, r#"{"context":{"fileName":"LAYER.md"}}"#);
        for _ in 0..2 {
            crate::services::agent_global::apply_to_home(&state, &home).unwrap();
            register_in_home(&home);
            assert_eq!(gemini_names(&home), json!(["LAYER.md", "GEMINI.md", "AGENTS.md"]));
        }
    }

    fn aider(home: &std::path::Path) -> serde_norway::Value {
        serde_norway::from_str(&std::fs::read_to_string(home.join(AIDER_CONFIG)).unwrap()).unwrap()
    }

    #[test]
    fn aider_reads_agents_md_and_keeps_what_the_user_listed() {
        let yaml = |s: &str| -> serde_norway::Value { serde_norway::from_str(s).unwrap() };
        // No file: created, idempotent.
        let fresh = tempfile::tempdir().unwrap();
        register_in_home(fresh.path());
        assert_eq!(aider(fresh.path()), yaml("read: [AGENTS.md]"));
        let once = std::fs::read(fresh.path().join(AIDER_CONFIG)).unwrap();
        register_in_home(fresh.path());
        assert_eq!(std::fs::read(fresh.path().join(AIDER_CONFIG)).unwrap(), once);

        // A list keeps its order and the other keys; a string becomes a list.
        let list = tempfile::tempdir().unwrap();
        put(list.path(), AIDER_CONFIG, "model: sonnet\nread:\n  - CONVENTIONS.md\n  - docs/style.md\n");
        register_in_home(list.path());
        assert_eq!(aider(list.path()), yaml("model: sonnet\nread: [CONVENTIONS.md, docs/style.md, AGENTS.md]"));
        register_in_home(list.path());
        assert_eq!(aider(list.path()), yaml("model: sonnet\nread: [CONVENTIONS.md, docs/style.md, AGENTS.md]"));
        let string = tempfile::tempdir().unwrap();
        put(string.path(), AIDER_CONFIG, "read: CONVENTIONS.md\n");
        register_in_home(string.path());
        assert_eq!(aider(string.path()), yaml("read: [CONVENTIONS.md, AGENTS.md]"));

        // Already listed (either spelling): not touched, comments included.
        for text in ["# mine\nread: AGENTS.md\n", "# mine\nread: [x.md, ./AGENTS.md]\n"] {
            let there = tempfile::tempdir().unwrap();
            put(there.path(), AIDER_CONFIG, text);
            register_in_home(there.path());
            assert_eq!(std::fs::read_to_string(there.path().join(AIDER_CONFIG)).unwrap(), text);
        }

        // Comments only: kept, the key added under them.
        let comments = tempfile::tempdir().unwrap();
        put(comments.path(), AIDER_CONFIG, "# mine\n");
        register_in_home(comments.path());
        assert_eq!(std::fs::read_to_string(comments.path().join(AIDER_CONFIG)).unwrap(), "# mine\nread:\n  - AGENTS.md\n");
    }

    #[test]
    fn an_aider_config_that_is_not_what_we_expect_is_left_alone() {
        let big = format!("# {}\nmodel: x\n", "a".repeat(2 << 20));
        for text in ["- just\n- a list\n", "read: {a: 1}\n", "read: 5\n", "a: [unclosed\n", "a: 1\na: 2\n", "plain scalar", "null\n", "# mine\n~\n", big.as_str()] {
            let tmp = tempfile::tempdir().unwrap();
            put(tmp.path(), AIDER_CONFIG, text);
            register_in_home(tmp.path());
            assert_eq!(std::fs::read_to_string(tmp.path().join(AIDER_CONFIG)).unwrap(), text);
        }
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(AIDER_CONFIG), [0xff, 0xfe, b'x']).unwrap();
        register_in_home(tmp.path());
        assert_eq!(std::fs::read(tmp.path().join(AIDER_CONFIG)).unwrap(), [0xff, 0xfe, b'x']);
    }

    /// A config an agent made huge is never read whole nor replaced: JSON over
    /// the cap (any caller of `merge_json`) and a YAML alias bomb under it.
    #[test]
    fn an_over_cap_or_bomb_config_is_left_exactly_as_it_is() {
        let pad = "a".repeat(2 << 20);
        let big_json = format!(r#"{{"context":{{"fileName":"MINE.md"}},"pad":"{pad}"}}"#);
        let mut bomb = String::from("a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n");
        for i in 1..14 {
            bomb.push_str(&format!("a{i}: &a{i} [{}]\n", vec![format!("*a{}", i - 1); 10].join(", ")));
        }
        let tmp = tempfile::tempdir().unwrap();
        put(tmp.path(), GEMINI_SETTINGS, &big_json);
        put(tmp.path(), OPENCODE_CONFIG, &big_json);
        put(tmp.path(), AIDER_CONFIG, &bomb);
        // No wall-clock bound (a loaded machine is slow): a bomb that were
        // expanded would exhaust memory or hang, not merely run late.
        register_in_home(tmp.path());
        for (rel, text) in [(GEMINI_SETTINGS, &big_json), (OPENCODE_CONFIG, &big_json), (AIDER_CONFIG, &bomb)] {
            assert_eq!(&std::fs::read_to_string(tmp.path().join(rel)).unwrap(), text, "{rel}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_aider_config_that_is_a_link_is_replaced_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.yml");
        std::fs::write(&outside, "model: theirs\n").unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(AIDER_CONFIG)).unwrap();
        register_in_home(&home);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "model: theirs\n");
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
        assert_eq!(once, format!("before\n\n{BLOCK_START}\n{HOOK_HINT}\n{BLOCK_END}\n"));
        let stale = format!("top\n{BLOCK_START}\nold text\n{BLOCK_END}\nbottom\n");
        assert_eq!(with_block(&stale), format!("top\n{BLOCK_START}\n{HOOK_HINT}\n{BLOCK_END}\nbottom\n"));
        assert_eq!(with_block(&with_block("")), with_block(""));
        assert_eq!(with_block(""), format!("{BLOCK_START}\n{HOOK_HINT}\n{BLOCK_END}\n"));
    }

    #[test]
    fn the_skill_has_only_name_and_description_and_names_every_option() {
        let md = skill_md();
        let front = md.strip_prefix("---\n").unwrap().split("\n---\n").next().unwrap();
        let keys: Vec<&str> = front.lines().map(|l| l.split(':').next().unwrap()).collect();
        assert_eq!(keys, ["name", "description"]);
        assert!(front.contains(&format!("name: {SKILL_NAME}\n")));
        // The Agent Skills limits: a lowercase-hyphen name ≤ 64, a description ≤ 1024.
        assert!(SKILL_NAME.len() <= 64 && SKILL_NAME.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
        let description = front.lines().nth(1).unwrap().strip_prefix("description: ").unwrap();
        assert!(description.len() <= 1024);
        for option in ["--phone", "--desktop", "-n NAME", "--clear"] {
            assert!(md.contains(&format!("{SKILL_NAME} {option}")), "{option}");
        }
    }

    #[test]
    fn the_skill_lands_in_every_skill_dir_and_an_edited_copy_is_put_back() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill_in_home(tmp.path());
        let at = |dir: &str| tmp.path().join(dir).join(SKILL_NAME).join("SKILL.md");
        for dir in SKILL_DIRS {
            assert_eq!(std::fs::read_to_string(at(dir)).unwrap(), skill_md(), "{dir}");
        }
        std::fs::write(at(SKILL_DIRS[0]), "an agent's edit").unwrap();
        write_skill_in_home(tmp.path());
        assert_eq!(std::fs::read_to_string(at(SKILL_DIRS[0])).unwrap(), skill_md());
        // Not the shared folder four of the CLIs also read: they would list it twice.
        assert!(!tmp.path().join(".agents").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_skill_skips_a_linked_config_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".claude")).unwrap();
        write_skill_in_home(&home);
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        assert!(home.join(".codex/skills").join(SKILL_NAME).join("SKILL.md").is_file());
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
