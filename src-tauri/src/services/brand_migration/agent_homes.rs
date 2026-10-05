//! The agent homes (`<state>/agent-homes/<scope>`) and the app-wide layer
//! (`<state>/agent-global`): rename the markers the app keeps in each home,
//! and re-point what the CLIs' own config files say about the app — the hook
//! commands, the MCP allow rules, the hint block.
//!
//! Why the config files are rewritten rather than left to the next spawn:
//! every registration there is "add my command unless it is present", keyed
//! on the exact command. The command holds the state dir and the script's
//! name, both of which change, so the next spawn would *add* a second hook
//! beside the old one and both would fire. Rewriting the old command in
//! place is what makes the registration find its own entry again.
//!
//! A home is agent-writable and an agent in a tmux session can outlive the
//! update, so files inside a home's sub-folders are read and written through
//! directory handles (`services::home_io`), as everywhere else. The markers
//! sit directly in the home, whose parent is the app's own; a `rename` of a
//! direct child never follows a link.

use std::path::Path;

use super::{Env, Outcome, StepResult};
use crate::brand::{Name, Pair};
use crate::services::home_io::HomeFile;

/// Files of the CLIs in a home (and in the app-wide layer) that can name the
/// app: hook registrations, allow rules, the hint block.
fn config_files() -> Vec<&'static str> {
    use crate::services::agent_hint as hint;
    let mut files = vec![
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude.json",
        ".codex/config.toml",
        ".vibe/hooks.toml",
        hint::VIBE_INSTRUCTIONS,
        hint::DROID_HOOKS,
        hint::CURSOR_HOOKS,
        hint::OPENCODE_CONFIG,
    ];
    files.extend_from_slice(hint::SETTINGS_HOOKS);
    files
}

/// The markers the app keeps directly in a home.
const MARKERS: [Name; 3] = [
    Name::AGENT_HOME_MARKER,
    Name::AGENT_GLOBAL_MANIFEST,
    Name::AGENT_GLOBAL_BACKUP_DIR,
];

/// The scripts in `<state>/hooks`.
const HOOK_SCRIPTS: [Name; 5] = [
    Name::SESSION_HOOK_SH,
    Name::SESSION_HOOK_PS1,
    Name::AGENT_HINT_SH,
    Name::AGENT_HINT_PS1,
    Name::AGENT_HINT_MD,
];

/// The MCP servers; a CLI stores an allow rule as `mcp__<server>__<tool>`.
const MCP_SERVERS: [Name; 4] = [
    Name::MCP_SERVER,
    Name::MCP_GIT_SERVER,
    Name::MCP_HELP_SERVER,
    Name::MCP_SCHEDULE_SERVER,
];

const HELP_TOOLS: [Name; 4] = [
    Name::HELP_TOOL_SEARCH,
    Name::HELP_TOOL_READ,
    Name::HELP_TOOL_TOPICS,
    Name::HELP_TOOL_STATUS,
];

/// What a config file's text is searched for, and what replaces it.
pub struct Rewrites {
    /// Whole-token replacements, tried in order.
    tokens: Vec<(String, String)>,
    /// Path prefixes: replaced only where a separator, a quote or the end
    /// follows, so `/x/old` never matches inside `/x/old-dev`.
    prefixes: Vec<(String, String)>,
}

/// A path as it appears inside a JSON string (backslashes doubled).
fn json_escaped(path: &str) -> String {
    path.replace('\\', "\\\\")
}

impl Rewrites {
    /// The rewrites for `pair`. `state_dirs` is the state dir's old and
    /// current path when it moved.
    pub fn new(pair: &Pair, state_dirs: Option<(&Path, &Path)>) -> Self {
        let mut tokens = Vec::new();
        // The hook scripts, with the folder they sit in: `hooks/<script>`,
        // and the same with a backslash, plain and as JSON writes it.
        for script in HOOK_SCRIPTS {
            if let Some(old) = pair.legacy(script) {
                let new = pair.cur(script);
                for sep in ["/", "\\\\", "\\"] {
                    tokens.push((format!("hooks{sep}{old}"), format!("hooks{sep}{new}")));
                }
            }
        }
        // Allow rules. The server name ends at `__`, so the root server's
        // rule never matches inside another server's.
        for server in MCP_SERVERS {
            if let Some(old) = pair.legacy(server) {
                tokens.push((format!("mcp__{old}__"), format!("mcp__{}__", pair.cur(server))));
            }
        }
        for tool in HELP_TOOLS {
            if let Some(old) = pair.legacy(tool) {
                tokens.push((old, pair.cur(tool)));
            }
        }
        if let Some(old) = pair.legacy(Name::VIBE_SESSION_HOOK) {
            tokens.push((
                format!("name = \"{old}\""),
                format!("name = \"{}\"", pair.cur(Name::VIBE_SESSION_HOOK)),
            ));
        }
        for marker in [Name::AGENT_HINT_START, Name::AGENT_HINT_END] {
            if let Some(old) = pair.legacy(marker) {
                tokens.push((old, pair.cur(marker)));
            }
        }
        let mut prefixes = Vec::new();
        if let Some((old, new)) = state_dirs {
            let (old, new) = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
            if old != new {
                let (old_json, new_json) = (json_escaped(&old), json_escaped(&new));
                if old_json != old {
                    prefixes.push((old_json, new_json));
                }
                prefixes.push((old, new));
            }
        }
        Self { tokens, prefixes }
    }

    fn is_empty(&self) -> bool {
        self.tokens.is_empty() && self.prefixes.is_empty()
    }

    /// `text` with every rewrite applied, or `None` when nothing matched.
    pub fn apply(&self, text: &str) -> Option<String> {
        let mut out = text.to_string();
        for (old, new) in &self.tokens {
            if out.contains(old.as_str()) {
                out = out.replace(old.as_str(), new);
            }
        }
        for (old, new) in &self.prefixes {
            out = replace_path_prefix(&out, old, new);
        }
        (out != text).then_some(out)
    }
}

/// Replace `old` by `new` wherever `old` ends a path component: followed by a
/// separator, a quote, whitespace or the end of the text.
fn replace_path_prefix(text: &str, old: &str, new: &str) -> String {
    if old.is_empty() || !text.contains(old) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(old) {
        let after = &rest[at + old.len()..];
        let boundary = after
            .chars()
            .next()
            .is_none_or(|c| matches!(c, '/' | '\\' | '"' | '\'' | ' ' | '\t' | '\n' | '\r'));
        out.push_str(&rest[..at]);
        out.push_str(if boundary { new } else { old });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Rewrite one config file of a home in place. `Ok(true)` when it changed.
///
/// Skipped by design (`Ok(false)`, not a failure): a missing file or folder,
/// and anything at the name that is not a regular file — a link, a folder, a
/// FIFO. A home is agent-writable, and a planted link must neither be
/// followed nor keep the step pending for good. A regular file that cannot
/// be read, or a rewrite that cannot be written, is an `Err`: the old hook
/// command stays in it and the next spawn would register a second one.
fn rewrite_file(home: &Path, rel: &str, rewrites: &Rewrites) -> Result<bool, String> {
    let Some(file) = HomeFile::open_existing(home, rel).filter(HomeFile::is_file) else {
        return Ok(false);
    };
    let bytes = file.read().ok_or_else(|| format!("read {}", file.path().display()))?;
    let Ok(text) = String::from_utf8(bytes) else { return Ok(false) };
    match rewrites.apply(&text) {
        Some(new) => file
            .write(new.as_bytes())
            .map(|()| true)
            .map_err(|e| format!("write {}: {e}", file.path().display())),
        None => Ok(false),
    }
}

/// Give a direct child of `dir` its current name. The old one stays when the
/// current name is already taken (the current one is what is read first).
fn rename_child(dir: &Path, old: &str, new: &str) -> bool {
    let (from, to) = (dir.join(old), dir.join(new));
    std::fs::symlink_metadata(&from).is_ok()
        && std::fs::symlink_metadata(&to).is_err()
        && std::fs::rename(&from, &to).is_ok()
}

/// Copilot loads every file in its hooks folder, so the app's own file is
/// moved to its current name (with its command re-pointed) rather than left
/// to be joined by a second one. Skips and fails like [`rewrite_file`].
fn move_copilot_hint(pair: &Pair, home: &Path, rewrites: &Rewrites) -> Result<bool, String> {
    let Some(old_rel) = pair.legacy(Name::COPILOT_HINT_HOOKS) else {
        return Ok(false);
    };
    let Some(old) = HomeFile::open_existing(home, &old_rel).filter(HomeFile::is_file) else {
        return Ok(false);
    };
    let bytes = old.read().ok_or_else(|| format!("read {}", old.path().display()))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let text = rewrites.apply(&text).unwrap_or(text);
    let Some(new) = HomeFile::open(home, &pair.cur(Name::COPILOT_HINT_HOOKS)) else {
        // A link where the hooks folder belongs: not followed.
        return Ok(false);
    };
    if !new.exists() {
        new.write(text.as_bytes())
            .map_err(|e| format!("write {}: {e}", new.path().display()))?;
    }
    old.remove().map_err(|e| format!("remove {}: {e}", old.path().display()))?;
    Ok(true)
}

/// What [`migrate_home`] did to one home.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Migrated {
    /// Files rewritten or moved, markers renamed.
    pub changed: usize,
    /// The config files that still hold the old commands, with why.
    pub failed: Vec<String>,
}

/// Bring one home (or the app-wide layer) to the current names. Idempotent.
/// The seeded marker is renamed last: a home is "migrated" only once
/// everything else in it is — but the markers are renamed even when a config
/// file failed. Left under the old names, the home would count as fresh and
/// be seeded again while in use; the failure is reported instead, and the
/// next launch's pass re-points what still matches.
pub fn migrate_home(pair: &Pair, home: &Path, state_dirs: Option<(&Path, &Path)>) -> Migrated {
    let mut migrated = Migrated::default();
    if !pair.renamed() || !home.is_dir() {
        return migrated;
    }
    let rewrites = Rewrites::new(pair, state_dirs);
    let mut tally = |result: Result<bool, String>| match result {
        Ok(changed) => migrated.changed += usize::from(changed),
        Err(error) => migrated.failed.push(error),
    };
    if !rewrites.is_empty() {
        for rel in config_files() {
            tally(rewrite_file(home, rel, &rewrites));
        }
    }
    tally(move_copilot_hint(pair, home, &rewrites));
    for marker in MARKERS.iter().rev() {
        if let Some(old) = pair.legacy(*marker) {
            migrated.changed += usize::from(rename_child(home, &old, &pair.cur(*marker)));
        }
    }
    migrated
}

/// A home met when a tab is spawned in it that still carries a marker under
/// the old name (it appeared after the launch step ran): bring it over. A
/// config file that could not be re-pointed puts the launch step `agent-homes`
/// back to pending, so the next launch's full pass retries it. `state_dir` is
/// the running app's. Nothing happens while the name is unchanged.
pub fn migrate_home_at_spawn(pair: &Pair, state_dir: &Path, home: &Path) {
    if !has_legacy_marker(pair, home) {
        return;
    }
    crate::brand::legacy_hit("agent-home-marker");
    let migrated = migrate_home(pair, home, None);
    if !migrated.failed.is_empty() {
        let reason = failure_note(&migrated.failed);
        eprintln!("brand migration: agent home {}: {reason}", home.display());
        super::reopen_step(pair, state_dir, "agent-homes", &reason);
    }
}

/// The record's note for config files that could not be re-pointed.
fn failure_note(failed: &[String]) -> String {
    format!("{} config file(s) could not be re-pointed: {}", failed.len(), failed.join("; "))
}

/// Whether a home still carries a marker under its old name.
pub fn has_legacy_marker(pair: &Pair, home: &Path) -> bool {
    MARKERS
        .iter()
        .any(|marker| pair.legacy(*marker).is_some_and(|old| std::fs::symlink_metadata(home.join(old)).is_ok()))
}

/// Step `agent-homes`: every home under the state dir, the app-wide layer,
/// and the scripts in `<state>/hooks`.
pub fn migrate_agent_homes(env: &Env) -> StepResult {
    let state = env.live_state_dir();
    if env.legacy_state_dir.as_deref() == Some(state.as_path()) {
        // The commands in the homes name the state dir. Re-pointing them is
        // one pass, done once the folder is where it will stay; until then
        // each home is brought over when a tab is spawned in it.
        return Ok(Outcome::Pending("waits for the state dir to move".into()));
    }
    let moved = env
        .legacy_state_dir
        .as_deref()
        .filter(|old| *old != env.state_dir.as_path() && state == env.state_dir)
        .map(|old| (old, env.state_dir.as_path()));
    let mut changed = 0;
    let mut failed = Vec::new();
    let homes = crate::services::agent_home::existing_homes_in(&state);
    for home in &homes {
        env.checkpoint("homes:before-home")?;
        let migrated = migrate_home(&env.pair, home, moved);
        changed += migrated.changed;
        failed.extend(migrated.failed);
    }
    let layer = migrate_home(&env.pair, &crate::services::agent_global::global_dir_in(&state), moved);
    changed += layer.changed;
    failed.extend(layer.failed);
    // The scripts themselves: the launch writes them afresh under their
    // current names, but until it has, the re-pointed commands above must
    // find a script — so the old files take the current names now.
    let hooks = state.join("hooks");
    for script in HOOK_SCRIPTS {
        if let Some(old) = env.pair.legacy(script) {
            changed += usize::from(rename_child(&hooks, &old, &env.pair.cur(script)));
        }
    }
    // The step is idempotent: the next launch runs it over every home again
    // and re-points only what still names the old.
    if !failed.is_empty() {
        return Ok(Outcome::Pending(failure_note(&failed)));
    }
    if changed == 0 {
        Ok(Outcome::NothingToDo)
    } else {
        Ok(Outcome::Done(format!("{changed} file(s) renamed or re-pointed")))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;
    use crate::brand::LEGACY;

    #[test]
    fn a_path_prefix_is_replaced_only_at_a_component_boundary() {
        let text = "a /s/old/hooks/x b \"/s/old\" c /s/old-dev/y d /s/old";
        assert_eq!(
            replace_path_prefix(text, "/s/old", "/s/new"),
            "a /s/new/hooks/x b \"/s/new\" c /s/old-dev/y d /s/new"
        );
        assert_eq!(replace_path_prefix("nothing here", "/s/old", "/s/new"), "nothing here");
    }

    #[test]
    fn the_unchanged_pair_rewrites_nothing() {
        let rewrites = Rewrites::new(&UNCHANGED, None);
        assert!(rewrites.is_empty());
        let machine = Machine::new();
        let home = machine.home.join("h");
        write(&home.join(UNCHANGED.cur(Name::AGENT_HOME_MARKER)), "");
        write(&home.join(".claude").join("settings.json"), "{\"hooks\":{}}");
        let before = snapshot(&home);
        assert_eq!(migrate_home(&UNCHANGED, &home, None), Migrated::default());
        assert_eq!(snapshot(&home), before);
        assert!(!has_legacy_marker(&UNCHANGED, &home));
    }

    /// The groups of `event` in a Claude-shaped settings file that run `cmd`.
    fn groups_running(settings: &serde_json::Value, event: &str, cmd: &str) -> usize {
        settings["hooks"][event]
            .as_array()
            .map(|groups| {
                groups
                    .iter()
                    .filter(|group| group["hooks"][0]["command"].as_str() == Some(cmd))
                    .count()
            })
            .unwrap_or(0)
    }

    /// The row's two requirements at once: a home seeded before the rename is
    /// recognised as seeded (its markers carry the current names), and the
    /// registration that every spawn runs finds its own hook entries again —
    /// one per event, the old ones gone, the user's own hook kept.
    #[test]
    fn a_home_keeps_its_markers_and_its_hooks_are_replaced_not_duplicated() {
        let machine = Machine::new();
        machine.seed_install(&LEGACY);
        let env = machine.env(RENAMED);
        let report = super::super::run_startup(&env);
        assert!(report.pending.is_empty(), "{report:?}");

        let home = env.state_dir.join("agent-homes").join("alpha");
        for marker in MARKERS {
            assert!(home.join(RENAMED.cur(marker)).exists(), "{marker:?}");
            assert!(!home.join(LEGACY.name(marker)).exists(), "{marker:?}");
        }
        assert!(!has_legacy_marker(&RENAMED, &home));
        assert_eq!(
            std::fs::read_to_string(
                home.join(RENAMED.cur(Name::AGENT_GLOBAL_BACKUP_DIR)).join(".claude").join("CLAUDE.md")
            )
            .expect("backup"),
            "the scope's own instructions\n"
        );

        // What the current build registers at the next spawn.
        let new_hook = machine.hook_command(&RENAMED.cur);
        let old_hook = machine.hook_command(&LEGACY);
        let settings_file = HomeFile::open(&home, ".claude/settings.json").expect("settings");
        crate::services::agent_session::register_hook_in_settings_as(&settings_file, &new_hook).expect("register");
        let settings = read_json(&home.join(".claude").join("settings.json"));
        for event in crate::services::agent_session::HOOK_EVENTS {
            assert_eq!(groups_running(&settings, event, &new_hook), 1, "{event}");
            assert_eq!(groups_running(&settings, event, &old_hook), 0, "{event}");
        }
        assert_eq!(groups_running(&settings, "SessionStart", "/usr/local/bin/my-own-hook"), 1);
        assert_eq!(settings["model"], "opus");
        assert_eq!(
            settings["permissions"]["allow"],
            serde_json::json!(["mcp__newname-git__git_push", "mcp__newname-help__newname_help_search", "Bash(ls:*)"])
        );

        let codex_file = HomeFile::open(&home, ".codex/config.toml").expect("config");
        crate::services::agent_session::register_codex_hook_as(&codex_file, &new_hook).expect("register");
        let codex = std::fs::read_to_string(home.join(".codex").join("config.toml")).expect("read");
        assert_eq!(codex.matches(&format!("command = '{new_hook}'")).count(), 5);
        assert!(!codex.contains(&old_hook));
        assert!(codex.starts_with("model = \"gpt\""));

        let vibe = std::fs::read_to_string(home.join(".vibe").join("hooks.toml")).expect("read");
        assert_eq!(vibe.matches("name = \"newname-session\"").count(), 1);
        // A TOML string: Windows' `\` in the path is written escaped.
        let in_toml = |hook: &str| serde_json::to_string(hook).expect("json");
        assert!(vibe.contains("name = \"mine\"") && vibe.contains(&in_toml(&new_hook)) && !vibe.contains(&in_toml(&old_hook)));
        let notes = std::fs::read_to_string(home.join(".vibe").join("AGENTS.md")).expect("read");
        assert!(notes.starts_with("my notes\n"));
        assert!(notes.contains(&RENAMED.cur(Name::AGENT_HINT_START)) && notes.contains(&RENAMED.cur(Name::AGENT_HINT_END)));

        let gemini = read_json(&home.join(".gemini").join("settings.json"));
        assert_eq!(groups_running(&gemini, "SessionStart", &machine.hint_command(&RENAMED.cur, "context")), 1);
        // Copilot's file moved, with its command.
        assert!(!home.join(LEGACY.name(Name::COPILOT_HINT_HOOKS)).exists());
        let copilot = read_json(&home.join(RENAMED.cur(Name::COPILOT_HINT_HOOKS)));
        assert_eq!(copilot["hooks"]["sessionStart"][0]["bash"], machine.hint_command(&RENAMED.cur, "copilot"));
        let opencode = read_json(&home.join(".config").join("opencode").join("opencode.json"));
        assert_eq!(
            opencode["instructions"][0],
            serde_json::json!(env.state_dir.join("hooks").join(RENAMED.cur(Name::AGENT_HINT_MD)))
        );

        // The scripts the re-pointed commands name are there, and the layer's
        // allow rule followed its server.
        assert!(env.state_dir.join("hooks").join(RENAMED.cur(Name::SESSION_HOOK_SH)).is_file());
        assert!(!env.state_dir.join("hooks").join(LEGACY.name(Name::SESSION_HOOK_SH)).exists());
        let layer = read_json(&env.state_dir.join("agent-global").join(".claude").join("settings.json"));
        assert_eq!(layer["permissions"]["allow"], serde_json::json!(["mcp__newname-git__git_push"]));

        // Nothing in the home or the hooks dir spells the old name any more.
        assert_eq!(spellings(&snapshot(&home), LEGACY.slug), Vec::<String>::new());
        assert_eq!(spellings(&snapshot(&env.state_dir.join("hooks")), LEGACY.slug), Vec::<String>::new());
    }

    /// A home that turns up after the launch step ran (restored, or the step
    /// was pending) is brought over when a tab is spawned in it.
    #[test]
    fn a_home_met_at_spawn_is_brought_over() {
        let machine = Machine::new();
        let home = machine.seed_agent_home(&LEGACY, "late");
        assert!(has_legacy_marker(&RENAMED, &home));
        assert!(migrate_home(&RENAMED, &home, None).changed > 0);
        assert!(!has_legacy_marker(&RENAMED, &home));
        assert!(home.join(RENAMED.cur(Name::AGENT_HOME_MARKER)).is_file());
        // A second pass finds nothing to do.
        let before = snapshot(&home);
        assert_eq!(migrate_home(&RENAMED, &home, None), Migrated::default());
        assert_eq!(snapshot(&home), before);
    }

    /// Makes a folder read-only until dropped, so creating a file in it
    /// fails (an agent chmodded its config folder). `None` as root, where
    /// the mode would not stop the write.
    #[cfg(unix)]
    struct ReadOnly(std::path::PathBuf);

    #[cfg(unix)]
    impl ReadOnly {
        fn new(dir: std::path::PathBuf) -> Option<Self> {
            use std::os::unix::fs::PermissionsExt;
            if unsafe { libc::geteuid() } == 0 {
                return None;
            }
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).expect("chmod");
            Some(Self(dir))
        }
    }

    #[cfg(unix)]
    impl Drop for ReadOnly {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    /// A config file that cannot be rewritten keeps its old hook command, so
    /// the step is not done: it stays pending, the markers are renamed all
    /// the same (or the home would be seeded again), and the next launch
    /// re-points the file — after which the registration finds its entry.
    #[cfg(unix)]
    #[test]
    fn a_config_file_that_cannot_be_written_keeps_the_step_pending_until_a_launch_rewrites_it() {
        let machine = Machine::new();
        machine.seed_install(&LEGACY);
        let old_home = machine.state_dir(&LEGACY).join("agent-homes").join("alpha");
        // Reached through the old path's link once the folder has moved.
        let Some(read_only) = ReadOnly::new(old_home.join(".claude")) else { return };
        let env = machine.env(RENAMED);
        let report = super::super::run_startup(&env);
        let (_, note) = report.pending.iter().find(|(id, _)| *id == "agent-homes").expect("agent-homes pending");
        assert!(note.contains("could not be re-pointed") && note.contains("settings.json"), "{note}");
        assert_eq!(env.record().state_of("agent-homes"), Some(super::super::StepState::Pending));

        let home = env.state_dir.join("agent-homes").join("alpha");
        let old_hook = machine.hook_command(&LEGACY);
        let new_hook = machine.hook_command(&RENAMED.cur);
        assert!(home.join(RENAMED.cur(Name::AGENT_HOME_MARKER)).is_file());
        assert!(!has_legacy_marker(&RENAMED, &home));
        let settings = read_json(&home.join(".claude").join("settings.json"));
        assert_eq!(groups_running(&settings, "Stop", &old_hook), 1, "the unwritable file kept the old command");
        // The rest of the home was re-pointed.
        let codex = std::fs::read_to_string(home.join(".codex").join("config.toml")).expect("read");
        assert!(!codex.contains(&old_hook));

        drop(read_only);
        let report = super::super::run_startup(&env);
        assert!(report.pending.is_empty(), "{report:?}");
        assert_eq!(env.record().state_of("agent-homes"), Some(super::super::StepState::Done));
        let settings_file = HomeFile::open(&home, ".claude/settings.json").expect("settings");
        crate::services::agent_session::register_hook_in_settings_as(&settings_file, &new_hook).expect("register");
        let settings = read_json(&home.join(".claude").join("settings.json"));
        for event in crate::services::agent_session::HOOK_EVENTS {
            assert_eq!(groups_running(&settings, event, &new_hook), 1, "{event}");
            assert_eq!(groups_running(&settings, event, &old_hook), 0, "{event}");
        }
    }

    /// A home met at spawn whose config cannot be rewritten puts the launch
    /// step back to pending, so the next launch's full pass finishes it.
    #[cfg(unix)]
    #[test]
    fn a_home_met_at_spawn_that_cannot_be_rewritten_reopens_the_launch_step() {
        let machine = Machine::new();
        machine.seed_install(&LEGACY);
        let env = machine.env(RENAMED);
        super::super::run_startup(&env);
        assert_eq!(env.record().state_of("agent-homes"), Some(super::super::StepState::Done));

        // Restored from a backup after the launch: old markers, old commands.
        let home = machine.seed_agent_home(&LEGACY, "late");
        let home = env.state_dir.join("agent-homes").join(home.file_name().expect("name"));
        let Some(read_only) = ReadOnly::new(home.join(".claude")) else { return };
        migrate_home_at_spawn(&RENAMED, &env.state_dir, &home);
        assert!(!has_legacy_marker(&RENAMED, &home), "the markers moved all the same");
        let record = env.record();
        assert_eq!(record.state_of("agent-homes"), Some(super::super::StepState::Pending));
        assert!(record.steps["agent-homes"].note.contains("could not be re-pointed"));

        drop(read_only);
        let report = super::super::run_startup(&env);
        assert!(report.pending.is_empty(), "{report:?}");
        let settings = read_json(&home.join(".claude").join("settings.json"));
        assert_eq!(groups_running(&settings, "Stop", &machine.hook_command(&LEGACY)), 0);
        assert_eq!(groups_running(&settings, "Stop", &machine.hook_command(&RENAMED.cur)), 1);
    }

    /// A link planted where a config file belongs is neither followed nor a
    /// failure: it would otherwise keep the step pending for good.
    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_a_config_file_is_skipped_and_the_step_finishes() {
        let machine = Machine::new();
        machine.seed_install(&LEGACY);
        let old_home = machine.state_dir(&LEGACY).join("agent-homes").join("alpha");
        let outside = machine.home.join("outside.json");
        let planted = serde_json::json!({ "hooks": { "Stop": [{ "hooks": [{ "command": machine.hook_command(&LEGACY) }] }] } })
            .to_string();
        write(&outside, &planted);
        let settings = old_home.join(".claude").join("settings.json");
        std::fs::remove_file(&settings).expect("remove");
        std::os::unix::fs::symlink(&outside, &settings).expect("link");

        let env = machine.env(RENAMED);
        let report = super::super::run_startup(&env);
        assert!(report.pending.is_empty(), "{report:?}");
        assert_eq!(env.record().state_of("agent-homes"), Some(super::super::StepState::Done));
        assert_eq!(std::fs::read_to_string(&outside).expect("read"), planted, "the link was not followed");
        let moved = env.state_dir.join("agent-homes").join("alpha").join(".claude").join("settings.json");
        assert!(std::fs::symlink_metadata(&moved).expect("link").file_type().is_symlink());
    }

    #[test]
    fn an_old_hook_entry_in_the_users_own_config_is_recognised() {
        let machine = Machine::new();
        let _ = super::super::hits::taken();
        let hooks_dir = machine.state_dir(&RENAMED.cur).join("hooks").to_string_lossy().into_owned();
        let is_ours = |cmd: &str| crate::services::agent_global::is_app_hook_for(&RENAMED, cmd, &hooks_dir);
        assert!(is_ours(&machine.hook_command(&RENAMED.cur)));
        assert!(super::super::hits::taken().is_empty());
        assert!(is_ours(&machine.hook_command(&LEGACY)));
        assert_eq!(super::super::hits::taken(), ["hook-entry"]);
        assert!(!is_ours("/usr/local/bin/my-own-hook"));
    }

    #[test]
    fn allow_rules_follow_the_servers_and_the_root_rule_is_not_a_prefix_of_another() {
        let rewrites = Rewrites::new(&RENAMED, None);
        let git = LEGACY.name(Name::MCP_GIT_SERVER);
        let root = LEGACY.name(Name::MCP_SERVER);
        let help = LEGACY.name(Name::MCP_HELP_SERVER);
        let search = LEGACY.name(Name::HELP_TOOL_SEARCH);
        let text = format!(
            r#"{{"permissions":{{"allow":["mcp__{git}__git_push","mcp__{root}__calendar_list","mcp__{help}__{search}","mcp__other__x","Bash(ls)"]}}}}"#
        );
        assert_eq!(
            rewrites.apply(&text).expect("changed"),
            r#"{"permissions":{"allow":["mcp__newname-git__git_push","mcp__newname__calendar_list","mcp__newname-help__newname_help_search","mcp__other__x","Bash(ls)"]}}"#
        );
        assert_eq!(rewrites.apply(r#"{"permissions":{"allow":["Bash(ls)"]}}"#), None);
    }
}
