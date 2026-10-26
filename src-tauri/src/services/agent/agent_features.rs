//! What a live agent tab was handed, for the tab hover card's Features rows:
//! the sandbox it runs in, its agent home and an API key through the proxy —
//! noted once per spawn by `launch_prep`'s commit — and, read when the card
//! asks, the MCP servers and skills it holds: Tabtivity's own lanes from the
//! tab's live tokens (`root_mcp::servers_of_tab`) and the user's own from the
//! CLI config in that home. Display only: names, never a command, URL or env.
//!
//! Per process, like the tokens: a tab the Mobile host spawned is not known to
//! the window, and the card then shows no Features rows at all. AppHandle-free.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use app_core::sync::LockExt;

/// How a local agent tab runs on the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Sandbox {
    /// Inside the agent fence (bubblewrap, sandbox-exec).
    Fenced,
    /// The root console's Host session: unfenced by the user's choice.
    HostSession,
    /// No fence on this platform (Windows): the user's rights.
    Unfenced,
}

/// One spawn's record, noted at its commit.
#[derive(Debug, Clone, PartialEq)]
pub struct Spawn {
    /// The spawn's sequence number (`agent_fence::begin_spawn`).
    pub seq: u64,
    /// The agent CLI's file stem (`claude`, `codex`, …), taken before any wrap.
    pub cli: String,
    /// The folder the tab works in, which keys Claude's per-project servers.
    pub cwd: String,
    /// The Tabtivity-owned `$HOME` the agent runs with; `None` for a remote or
    /// container tab, whose home is not this machine's to read.
    pub home: Option<PathBuf>,
    pub sandbox: Option<Sandbox>,
    /// Providers whose key reaches the CLI through the proxy (`Provider::id`).
    pub api_keys: Vec<&'static str>,
}

fn spawns() -> &'static Mutex<HashMap<String, Spawn>> {
    static SPAWNS: OnceLock<Mutex<HashMap<String, Spawn>>> = OnceLock::new();
    SPAWNS.get_or_init(Default::default)
}

/// Note `tab`'s newest spawn, replacing the one before.
pub fn record(tab: &str, spawn: Spawn) {
    spawns().lock_ok().insert(tab.to_string(), spawn);
}

/// Spawn `seq` of `tab` is gone; a newer spawn's record stays.
pub fn forget(tab: &str, seq: u64) {
    let mut map = spawns().lock_ok();
    if map.get(tab).is_some_and(|s| s.seq == seq) {
        map.remove(tab);
    }
}

/// `tab` respawned as something without a record (a shell, a remote or
/// container agent): an earlier spawn's record goes.
pub fn forget_tab(tab: &str) {
    spawns().lock_ok().remove(tab);
}

/// The providers whose proxy base URL a spawn's final environment carries:
/// what is left after every drop (`drop_api_keys_for_old_tmux`), so a key the
/// CLI never receives is not claimed.
pub fn api_keys_in(env: &HashMap<String, String>) -> Vec<&'static str> {
    use crate::services::agent_api_keys::{Provider, ANTHROPIC_BASE_ENV, GEMINI_BASE_ENV, OPENAI_BASE_ENV};
    [(Provider::Anthropic, ANTHROPIC_BASE_ENV), (Provider::Gemini, GEMINI_BASE_ENV), (Provider::OpenAi, OPENAI_BASE_ENV)]
        .into_iter()
        .filter(|(p, var)| env.get(*var).is_some_and(|v| crate::services::api_proxy::is_proxy_base(v, *p)))
        .map(|(p, _)| p.id())
        .collect()
}

/// What the card shows. Empty lists are left for the card to skip.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub sandbox: Option<Sandbox>,
    /// Tabtivity's servers this tab holds a live token for.
    pub app_mcp: Vec<String>,
    /// The servers the user configured for this CLI in the tab's home.
    pub own_mcp: Vec<String>,
    pub skills: Vec<String>,
    pub api_keys: Vec<&'static str>,
}

/// `tab`'s features, or `None` when this process knows nothing of it.
pub fn features(tab: &str) -> Option<Features> {
    let spawn = spawns().lock_ok().get(tab).cloned();
    let app_mcp: Vec<String> = crate::services::root_mcp::servers_of_tab(tab).into_iter().map(str::to_string).collect();
    if spawn.is_none() && app_mcp.is_empty() {
        return None;
    }
    let mut out = Features { app_mcp, ..Default::default() };
    if let Some(spawn) = spawn {
        if let Some(home) = spawn.home.as_deref() {
            out.own_mcp = own_mcp_servers(&spawn.cli, home, &spawn.cwd)
                .into_iter()
                .filter(|name| !out.app_mcp.contains(name))
                .collect();
            out.skills = skills(&spawn.cli, home);
        }
        out.sandbox = spawn.sandbox;
        out.api_keys = spawn.api_keys;
    }
    Some(out)
}

/// A config file bigger than this is not parsed for the card.
const MAX_CONFIG_BYTES: u64 = 8 << 20;
/// At most this many names per list, each at most [`MAX_NAME_CHARS`].
const MAX_NAMES: usize = 40;
const MAX_NAME_CHARS: usize = 64;

/// The home is the agent's to write: a name is shown as text, cut short and
/// stripped of control and invisible characters, never used for anything.
fn clean_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = names
        .into_iter()
        .map(|n| crate::services::root_mcp_mail::strip_invisible(&n).chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect::<String>())
        .filter(|n| !n.trim().is_empty())
        .collect();
    out.sort();
    out.dedup();
    out.truncate(MAX_NAMES);
    out
}

/// A regular file of the home, not a link the agent put there to point the
/// window at a file of the user's.
fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn json_keys(value: Option<&serde_json::Value>) -> Vec<String> {
    value.and_then(|v| v.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

/// The MCP servers the user set up for `cli` in `home`: Claude's user-scope
/// and this folder's local-scope servers (`.claude.json`), Codex's
/// `mcp_servers` tables (`.codex/config.toml`), Gemini's `mcpServers`
/// (`.gemini/settings.json`). A project's own `.mcp.json` is not read — it is
/// the project folder's, and Claude asks before it uses one.
pub fn own_mcp_servers(cli: &str, home: &Path, cwd: &str) -> Vec<String> {
    let names = match cli {
        "claude" => {
            let Some(doc) = read_small(&home.join(".claude.json")).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
                return Vec::new();
            };
            let mut names = json_keys(doc.get("mcpServers"));
            names.extend(json_keys(doc.get("projects").and_then(|p| p.get(cwd)).and_then(|p| p.get("mcpServers"))));
            names
        }
        "codex" => read_small(&home.join(".codex").join("config.toml"))
            .and_then(|t| t.parse::<toml_edit::DocumentMut>().ok())
            .and_then(|doc| doc.get("mcp_servers").and_then(|t| t.as_table_like()).map(|t| t.iter().map(|(k, _)| k.to_string()).collect()))
            .unwrap_or_default(),
        "gemini" => read_small(&home.join(".gemini").join("settings.json"))
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .map(|doc| json_keys(doc.get("mcpServers")))
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    clean_names(names)
}

/// The skills `cli` finds in `home`: a folder with a `SKILL.md` under
/// Claude's `.claude/skills` or Codex's `.codex/skills`.
pub fn skills(cli: &str, home: &Path) -> Vec<String> {
    let dir = match cli {
        "claude" => home.join(".claude").join("skills"),
        "codex" => home.join(".codex").join("skills"),
        _ => return Vec::new(),
    };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let names = entries
        .flatten()
        .filter(|e| e.path().join("SKILL.md").is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'));
    clean_names(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn claude_lists_user_and_this_folders_servers() {
        let h = home();
        let cwd = if cfg!(windows) { r"C:\p" } else { "/p" };
        let doc = serde_json::json!({
            "mcpServers": {"docs": {"command": "x"}},
            "projects": {cwd: {"mcpServers": {"db": {}}}, "/other": {"mcpServers": {"elsewhere": {}}}},
        });
        std::fs::write(h.path().join(".claude.json"), doc.to_string()).unwrap();
        assert_eq!(own_mcp_servers("claude", h.path(), cwd), vec!["db", "docs"]);
    }

    #[test]
    fn codex_and_gemini_servers_are_read_from_their_own_files() {
        let h = home();
        std::fs::create_dir_all(h.path().join(".codex")).unwrap();
        std::fs::write(h.path().join(".codex").join("config.toml"), "model = \"x\"\n[mcp_servers.docs]\ncommand = \"d\"\n").unwrap();
        std::fs::create_dir_all(h.path().join(".gemini")).unwrap();
        std::fs::write(h.path().join(".gemini").join("settings.json"), r#"{"mcpServers":{"g":{}}}"#).unwrap();
        assert_eq!(own_mcp_servers("codex", h.path(), "/p"), vec!["docs"]);
        assert_eq!(own_mcp_servers("gemini", h.path(), "/p"), vec!["g"]);
        assert!(own_mcp_servers("opencode", h.path(), "/p").is_empty());
    }

    #[test]
    fn names_are_cleaned_and_bounded() {
        let names = clean_names(["a\u{200b}b".to_string(), "x\ny".to_string(), " ".to_string(), "z".repeat(100)]);
        assert_eq!(names, vec!["ab".to_string(), "xy".to_string(), "z".repeat(MAX_NAME_CHARS)]);
        assert_eq!(clean_names((0..100).map(|i| format!("{i:03}"))).len(), MAX_NAMES);
    }

    #[test]
    fn skills_are_folders_with_a_skill_file() {
        let h = home();
        let skills_dir = h.path().join(".claude").join("skills");
        for (name, with_file) in [("review", true), ("empty", false), (".hidden", true)] {
            std::fs::create_dir_all(skills_dir.join(name)).unwrap();
            if with_file {
                std::fs::write(skills_dir.join(name).join("SKILL.md"), "x").unwrap();
            }
        }
        assert_eq!(skills("claude", h.path()), vec!["review"]);
        assert!(skills("codex", h.path()).is_empty());
    }

    #[test]
    fn a_stale_forget_keeps_the_newer_spawn() {
        let spawn = |seq| Spawn { seq, cli: "claude".into(), cwd: "/p".into(), home: None, sandbox: Some(Sandbox::Fenced), api_keys: Vec::new() };
        record("af-tab", spawn(1));
        record("af-tab", spawn(2));
        forget("af-tab", 1);
        assert_eq!(features("af-tab").and_then(|f| f.sandbox), Some(Sandbox::Fenced));
        forget("af-tab", 2);
        assert_eq!(features("af-tab"), None);
    }

    #[test]
    fn only_a_proxy_base_counts_as_a_key() {
        use crate::services::agent_api_keys::{ANTHROPIC_BASE_ENV, OPENAI_BASE_ENV};
        let env = HashMap::from([
            (ANTHROPIC_BASE_ENV.to_string(), "http://127.0.0.1:4100/anthropic".to_string()),
            (OPENAI_BASE_ENV.to_string(), "https://api.example.invalid/v1".to_string()),
        ]);
        assert_eq!(api_keys_in(&env), vec!["anthropic"]);
    }
}
