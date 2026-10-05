//! Test fixtures for the migrator: an invented brand, a machine made of temp
//! dirs, a world that records instead of acting, and an install seeded the
//! way an older build left one.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::{Env, World};
use crate::brand::{Forms, Name, Pair, LEGACY};

/// An invented current brand over the real old one: the pair a build runs
/// with once the name has changed.
pub const RENAMED: Pair = Pair {
    cur: Forms { display: "Newname", slug: "newname", upper: "NEWNAME" },
    legacy: LEGACY,
};

/// A pair whose name did not change: what every build ran with before the
/// rename. The no-op guarantees are held against it — nothing is looked up
/// twice, nothing moves, nothing is written.
pub const UNCHANGED: Pair = Pair { cur: crate::brand::CURRENT, legacy: crate::brand::CURRENT };

/// Records what a step asked of the machine.
#[derive(Default)]
pub struct RecordingWorld {
    pub calls: RefCell<Vec<String>>,
    /// Whether an old phone host is installed (set by `seed_install`).
    pub legacy_host: std::cell::Cell<bool>,
}

impl World for RecordingWorld {
    fn retire_legacy_mobile_host(&self, _pair: &Pair, legacy_state_dir: &Path) -> Result<bool, String> {
        self.calls
            .borrow_mut()
            .push(format!("retire-mobile-host {}", legacy_state_dir.display()));
        Ok(self.legacy_host.get())
    }

    fn stop_host_in(&self, state_dir: &Path) {
        self.calls.borrow_mut().push(format!("stop-host {}", state_dir.display()));
    }
}

/// `path` with every link resolved, in the form the OS hands back for the
/// folder: on Windows `canonicalize` answers `\\?\C:\…`, which git refuses
/// to create a worktree under and which a link's target never spells, so the
/// plain drive form is kept (it names the same folder).
pub fn canonical(path: &Path) -> PathBuf {
    let path = path.canonicalize().expect("canonicalize");
    #[cfg(windows)]
    if let Some(plain) = path.to_str().and_then(|s| s.strip_prefix(r"\\?\")).filter(|s| !s.starts_with(r"UNC\")) {
        return PathBuf::from(plain);
    }
    path
}

/// `content` with the path `from` replaced by `to`, as written and as a JSON
/// or TOML string spells it (Windows' `\` escaped as `\\`).
pub fn replace_path(content: &str, from: &str, to: &str) -> String {
    let escaped = |p: &str| p.replace('\\', "\\\\");
    content.replace(&escaped(from), &escaped(to)).replace(from, to)
}

/// A machine in a temp dir: a home with the Linux layout on every OS (the
/// steps only ever see the paths they are given).
pub struct Machine {
    _tmp: Option<tempfile::TempDir>,
    pub home: PathBuf,
    pub world: RecordingWorld,
}

fn fixed_now() -> String {
    "2026-10-01T12:00:00+00:00".to_string()
}

impl Machine {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Canonical, so a path read back through a link compares equal (the
        // temp dir is itself behind a link on macOS).
        let home = canonical(tmp.path()).join("home");
        fs::create_dir_all(&home).expect("home");
        Self { _tmp: Some(tmp), home, world: RecordingWorld::default() }
    }

    /// A machine whose home is a folder that already exists and is kept
    /// afterwards: the copy of a real install (`copy_run`).
    pub fn at(home: PathBuf) -> Self {
        Self { _tmp: None, home, world: RecordingWorld::default() }
    }

    pub fn share(&self) -> PathBuf {
        self.home.join(".local").join("share")
    }

    /// The state dir as `forms` names it.
    pub fn state_dir(&self, forms: &Forms) -> PathBuf {
        self.share().join(forms.name(Name::STATE_DIR_NAME))
    }

    /// The `~/<name>` tree as `forms` names it.
    pub fn home_tree(&self, forms: &Forms) -> PathBuf {
        self.home.join(forms.name(Name::HOME_DIR_NAME))
    }

    /// The webview's data dir as `forms` names it.
    pub fn webview_data(&self, forms: &Forms) -> PathBuf {
        self.share().join(forms.name(Name::APP_IDENTIFIER))
    }

    /// The environment a launch of a build with `pair` would see here.
    pub fn env(&self, pair: Pair) -> Env<'_> {
        let home_tree = crate::paths::app_home_in(&pair, |_| None, &self.home);
        Env {
            pair,
            state_dir: self.state_dir(&pair.cur),
            legacy_state_dir: pair.legacy(Name::STATE_DIR_NAME).map(|old| self.share().join(old)),
            share_dir: None,
            webview_data: pair
                .legacy(Name::APP_IDENTIFIER)
                .map(|old| (self.share().join(old), self.webview_data(&pair.cur))),
            home_trees: vec![home_tree],
            machine_wide: true,
            world: &self.world,
            now: fixed_now,
            crash_at: None,
            fail_at: None,
        }
    }

    /// Seed the home the way a build named `forms` left it after real use.
    /// Returns the project folder.
    pub fn seed_install(&self, forms: &Forms) -> PathBuf {
        let state = self.state_dir(forms);
        let tree = self.home_tree(forms);
        self.world.legacy_host.set(true);
        let project = tree.join("projects").join("alpha");
        write(&project.join("README.md"), "alpha\n");

        let mirror = state.join("remote-projects").join("beta").join("mirror");
        write(&mirror.join("notes.txt"), "remote notes\n");
        write_json(
            &state.join("projects.json"),
            &serde_json::json!([
                { "id": "alpha", "name": "Alpha", "directory": project },
                { "id": "beta", "name": "Beta", "directory": mirror, "remote": { "host": "example.org" } }
            ]),
        );
        write_json(
            &state.join("settings.json"),
            &serde_json::json!({ "theme": "dark", forms.name(Name::MOBILE_HOST_KEY): { "enabled": true, "port": 8742 } }),
        );
        write_json(
            &state.join("boxes.json"),
            &serde_json::json!([{ "id": "b1", "name": "Box", forms.name(Name::MOBILE_ACCESS_KEY): true }]),
        );
        write_json(
            &state.join("time_summary.json"),
            &serde_json::json!({ "days": { "2026-09-30": { forms.name(Name::APP_TIMER_ID): 90.0, "alpha": 10.0 } } }),
        );
        write_json(
            &state.join("sessions").join("beta").join("tabs.json"),
            &serde_json::json!({ "tabs": [
                { "id": "t1", "cmd": "bash", "cwd": mirror },
                { "id": "t2", "cmd": format!("{}mail__", forms.name(Name::TAB_COMMAND_PREFIX)) },
                { "id": "t3", "cmd": "claude", "env": { forms.env_name("TAB_UID"): "uid-3" } }
            ] }),
        );
        write_json(
            &state.join("remote-projects").join("beta").join("sync.json"),
            &serde_json::json!({ "files": {}, "mirror": mirror }),
        );
        write_json(
            &tree.join("archive").join("gamma").join("entry.json"),
            &serde_json::json!({ "id": "gamma", "state": state.join("remote-projects").join("gamma") }),
        );
        write(
            &state.join("mobile-control").join("bin").join("1.0.0").join(forms.name(Name::MOBILE_HOST_BIN)),
            "#!host\n",
        );

        self.seed_agent_home(forms, "alpha");
        for script in [Name::SESSION_HOOK_SH, Name::AGENT_HINT_SH, Name::AGENT_HINT_MD] {
            write(&state.join("hooks").join(forms.name(script)), "#!/bin/sh\n");
        }
        // The app-wide layer: the user's own allow rules, imported.
        write_json(
            &state.join("agent-global").join(".claude").join("settings.json"),
            &serde_json::json!({ "permissions": { "allow": [
                format!("mcp__{}__git_push", forms.name(Name::MCP_GIT_SERVER))
            ] } }),
        );

        let webview = self.webview_data(forms);
        write(&webview.join("localstorage").join("app.localstorage"), "theme=dark");
        write(&webview.join("databases").join("indexeddb").join("db.sqlite"), "idb");
        project
    }
}

impl Machine {
    /// The session hook command a build named `forms` registers.
    pub fn hook_command(&self, forms: &Forms) -> String {
        self.state_dir(forms)
            .join("hooks")
            .join(forms.name(Name::SESSION_HOOK_SH))
            .to_string_lossy()
            .into_owned()
    }

    /// The hint command a build named `forms` registers for `shape`.
    pub fn hint_command(&self, forms: &Forms, shape: &str) -> String {
        format!(
            "\"{}\" {shape}",
            self.state_dir(forms).join("hooks").join(forms.name(Name::AGENT_HINT_SH)).display()
        )
    }

    /// An agent home as a build named `forms` leaves it after a few spawns:
    /// seeded, the hooks of every CLI registered, the app-wide layer applied,
    /// and a few allow rules the user granted. Returns the home.
    pub fn seed_agent_home(&self, forms: &Forms, scope: &str) -> PathBuf {
        let home = self.state_dir(forms).join("agent-homes").join(scope);
        let hook = self.hook_command(forms);
        write(&home.join(forms.name(Name::AGENT_HOME_MARKER)), "");
        write_json(
            &home.join(forms.name(Name::AGENT_GLOBAL_MANIFEST)),
            &serde_json::json!({ "files": [".claude/CLAUDE.md"], "merged": {} }),
        );
        write(
            &home.join(forms.name(Name::AGENT_GLOBAL_BACKUP_DIR)).join(".claude").join("CLAUDE.md"),
            "the scope's own instructions\n",
        );
        let group = |cmd: &str| serde_json::json!({ "hooks": [{ "type": "command", "command": cmd }] });
        write_json(
            &home.join(".claude").join("settings.json"),
            &serde_json::json!({
                "model": "opus",
                "permissions": { "allow": [
                    format!("mcp__{}__git_push", forms.name(Name::MCP_GIT_SERVER)),
                    format!("mcp__{}__{}", forms.name(Name::MCP_HELP_SERVER), forms.name(Name::HELP_TOOL_SEARCH)),
                    "Bash(ls:*)"
                ] },
                "hooks": {
                    "SessionStart": [group(&hook), group("/usr/local/bin/my-own-hook")],
                    "Stop": [group(&hook)],
                    "UserPromptSubmit": [group(&hook)],
                    "PostToolUse": [group(&hook)],
                    "Notification": [group(&hook)],
                    "SessionEnd": [group(&hook)]
                }
            }),
        );
        let mut codex = String::from("model = \"gpt\"\n\n# managed\n");
        for event in crate::services::agent_session::CODEX_HOOK_EVENTS {
            codex.push_str(&format!(
                "[[hooks.{event}]]\n\n[[hooks.{event}.hooks]]\ntype = \"command\"\ncommand = '{hook}'\ntimeout = 10\n\n"
            ));
        }
        write(&home.join(".codex").join("config.toml"), &codex);
        write(
            &home.join(".vibe").join("hooks.toml"),
            &format!(
                "[[hooks]]\nname = \"mine\"\ntype = \"post_agent\"\ncommand = \"true\"\n\n[[hooks]]\nname = \"{}\"\ntype = \"post_agent\"\ncommand = {}\ntimeout = 10.0\n",
                forms.name(Name::VIBE_SESSION_HOOK),
                serde_json::to_string(&hook).expect("json")
            ),
        );
        write(
            &home.join(".vibe").join("AGENTS.md"),
            &format!(
                "my notes\n\n{}\nhint\n{}\n",
                forms.name(Name::AGENT_HINT_START),
                forms.name(Name::AGENT_HINT_END)
            ),
        );
        write_json(
            &home.join(".gemini").join("settings.json"),
            &serde_json::json!({ "hooks": { "SessionStart": [group(&self.hint_command(forms, "context"))] } }),
        );
        write_json(
            &home.join(forms.name(Name::COPILOT_HINT_HOOKS)),
            &serde_json::json!({ "version": 1, "hooks": { "sessionStart": [
                { "type": "command", "bash": self.hint_command(forms, "copilot") }
            ] } }),
        );
        write_json(
            &home.join(".config").join("opencode").join("opencode.json"),
            &serde_json::json!({ "instructions": [
                self.state_dir(forms).join("hooks").join(forms.name(Name::AGENT_HINT_MD))
            ] }),
        );
        home
    }
}

pub fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(path, content).expect("write");
}

pub fn write_json(path: &Path, value: &serde_json::Value) {
    write(path, &serde_json::to_string_pretty(value).expect("json"));
}

pub fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display())))
        .expect("json")
}

/// Every entry under `root`, by path relative to it: a file's content, a
/// link's target, or `<dir>`. Two equal snapshots mean nothing moved and
/// nothing was written.
pub fn snapshot(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("read_dir").flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .expect("under root")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let kind = entry.file_type().expect("file type");
            if kind.is_symlink() {
                out.insert(rel, format!("<link {}>", fs::read_link(&path).expect("read_link").display()));
            } else if kind.is_dir() {
                out.insert(rel, "<dir>".to_string());
                stack.push(path);
            } else {
                out.insert(rel, String::from_utf8_lossy(&fs::read(&path).expect("read")).into_owned());
            }
        }
    }
    out
}

/// The entries of a snapshot (paths and contents) that spell `word`,
/// ignoring case.
pub fn spellings(snapshot: &BTreeMap<String, String>, word: &str) -> Vec<String> {
    let word = word.to_lowercase();
    snapshot
        .iter()
        .filter(|(path, content)| path.to_lowercase().contains(&word) || content.to_lowercase().contains(&word))
        .map(|(path, _)| path.clone())
        .collect()
}
