//! Tabtivity-owned agent CLI installs.
//!
//! An agent CLI Tabtivity installs goes into `<state_dir>/agents/install/`, a
//! home of its own handed to the vendor's installer as `HOME` (with the npm,
//! bun and uv prefixes pointed there too), never into the user's home. Inside
//! every fence that tree is read-only and the CLI's own auto-updater is
//! switched off where the CLI has a switch, so an agent cannot replace the
//! binary it runs as; updates run outside the fence (Manage CLIs → install
//! again). A CLI the user installed on the host keeps being detected and keeps
//! its self-update path in the fence until it is reinstalled through Tabtivity.
//!
//! Verified per installer only where noted in `commands::agents`; an
//! installer that ignores these variables lands in the user's home as before.

use std::path::{Path, PathBuf};

use crate::storage;

/// The install home, relative to the state dir.
const INSTALL_DIR: &str = "agents/install";

pub fn install_root_in(state_dir: &Path) -> PathBuf {
    state_dir.join(INSTALL_DIR)
}

pub fn install_root() -> PathBuf {
    install_root_in(&storage::state_dir())
}

/// The environment an installer runs with on this OS: see [`install_env_for`].
pub fn install_env_in(state_dir: &Path) -> Vec<(String, String)> {
    install_env_for(cfg!(windows), state_dir)
}

/// The environment an installer runs with: its `HOME` and every prefix the
/// common installers honour, all under [`install_root_in`]. On Windows also
/// `USERPROFILE` (what PowerShell's `$HOME` and npm's `~` read there) and
/// `APPDATA` (npm's default global prefix, `%APPDATA%\npm`, and most
/// per-user tool configs) inside the install home. An installer that asks
/// the shell API for the profile folder instead of the environment still
/// lands in the user's profile; that is not reachable from here.
pub fn install_env_for(windows: bool, state_dir: &Path) -> Vec<(String, String)> {
    let root = install_root_in(state_dir);
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    let mut env: Vec<(String, String)> = vec![
        ("HOME".into(), s(root.clone())),
        ("NPM_CONFIG_PREFIX".into(), s(root.join("npm"))),
        ("BUN_INSTALL".into(), s(root.join(".bun"))),
        ("UV_TOOL_DIR".into(), s(root.join(".local").join("share").join("uv").join("tools"))),
        ("UV_TOOL_BIN_DIR".into(), s(root.join(".local").join("bin"))),
        // `pip install` without `--user` targets the system site-packages.
        ("PIP_USER".into(), "1".into()),
        ("PYTHONUSERBASE".into(), s(root.join(".local"))),
    ];
    if windows {
        env.push(("USERPROFILE".into(), s(root.clone())));
        env.push(("APPDATA".into(), s(root.join("AppData").join("Roaming"))));
    }
    env
}

pub fn install_env() -> Vec<(String, String)> {
    install_env_in(&storage::state_dir())
}

/// Where the installers put their launchers under the install home, on this
/// OS: see [`bin_dirs_for`].
pub fn bin_dirs_in(state_dir: &Path) -> Vec<PathBuf> {
    bin_dirs_for(cfg!(windows), state_dir)
}

/// Where the installers put their launchers under the install home. npm
/// writes its launchers into `<prefix>/bin` on Unix but into `<prefix>`
/// itself on Windows, so the prefix root joins the list there.
pub fn bin_dirs_for(windows: bool, state_dir: &Path) -> Vec<PathBuf> {
    let root = install_root_in(state_dir);
    let mut dirs: Vec<PathBuf> = [
        ".local/bin",
        "npm/bin",
        ".bun/bin",
        ".cargo/bin",
        ".opencode/bin",
        ".openclaw/bin",
        ".grok/bin",
        ".kilo/bin",
        ".kimi-code/bin",
        ".plandex-home-v2/bin",
    ]
    .iter()
    .map(|rel| rel.split('/').fold(root.clone(), |p, seg| p.join(seg)))
    .collect();
    if windows {
        dirs.insert(2, root.join("npm"));
    }
    dirs
}

/// The launcher dirs that exist, for PATH and detection.
pub fn bin_dirs() -> Vec<PathBuf> {
    bin_dirs_in(&storage::state_dir())
        .into_iter()
        .filter(|d| d.is_dir())
        .collect()
}

/// Whether `cmd`, as found on `search_dirs`, is a CLI Tabtivity installed. Pure
/// over the filesystem.
pub fn owns_command_in(state_dir: &Path, cmd: &str, search_dirs: &[PathBuf]) -> bool {
    let root = install_root_in(state_dir);
    let found = if cmd.contains('/') {
        Some(PathBuf::from(cmd))
    } else {
        search_dirs.iter().map(|d| d.join(cmd)).find(|c| c.is_file())
    };
    let Some(found) = found else {
        return false;
    };
    let real = found.canonicalize().unwrap_or(found.clone());
    let root_real = root.canonicalize().unwrap_or(root.clone());
    found.starts_with(&root) || real.starts_with(&root_real)
}

pub fn owns_command(cmd: &str, search_dirs: &[PathBuf]) -> bool {
    owns_command_in(&storage::state_dir(), cmd, search_dirs)
}

/// The install tree, read-only inside every fence (only when it exists: a
/// `--ro-bind-try` of a missing dir is a no-op, and nothing is created).
pub fn fence_read_only_paths() -> Vec<String> {
    let root = install_root();
    if root.is_dir() {
        vec![root.to_string_lossy().into_owned()]
    } else {
        Vec::new()
    }
}

/// The auto-update switch of a CLI, by command basename. Only switches that
/// are documented; a CLI without one simply fails its update on the
/// read-only tree and carries on.
fn autoupdate_off(bin: &str) -> &'static [(&'static str, &'static str)] {
    match bin {
        "claude" => &[("DISABLE_AUTOUPDATER", "1")],
        _ => &[],
    }
}

/// Switch off the self-updater of a CLI for a fenced spawn: its install is
/// read-only in every fence, whether Tabtivity or the host installed it (a
/// payload one scope's agent could rewrite would run in every other scope
/// and the user's own shell next). Updates go through Manage CLIs. A value
/// the user set wins.
pub fn apply_fence_env(cmd: &str, env: &mut std::collections::HashMap<String, String>) {
    let bin = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let bin = bin.strip_suffix(".exe").unwrap_or(bin);
    for (k, v) in autoupdate_off(bin) {
        env.entry((*k).to_string()).or_insert_with(|| (*v).to_string());
    }
}

/// Startup: adopt what an older Tabtivity kept for the Claude login — the
/// stable-inode mirror at `agent-creds/claude/.credentials.json` — into the
/// per-CLI store, once, so every tab stays signed in across the upgrade. The
/// old dir is removed afterwards.
pub fn migrate_legacy_stores() {
    migrate_legacy_stores_in(&storage::state_dir());
}

pub(crate) fn migrate_legacy_stores_in(state_dir: &Path) {
    let old = state_dir.join("agent-creds").join("claude").join(".credentials.json");
    if !old.is_file() {
        return;
    }
    let path = crate::services::agent_auth::file(".claude/.credentials.json");
    let store = crate::services::agent_auth::store_path_in(state_dir, "claude", &path);
    if !store.exists() {
        if let Some(parent) = store.parent() {
            let _ = crate::services::agent_home::create_private_dir(parent);
        }
        if std::fs::rename(&old, &store).is_err() && std::fs::copy(&old, &store).is_err() {
            return;
        }
    }
    let _ = std::fs::remove_dir_all(state_dir.join("agent-creds"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_env_points_every_prefix_into_the_install_home() {
        let env = install_env_in(Path::new("/s"));
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).unwrap();
        // Compared as paths: on Windows the joins mix `\` and `/`.
        assert_eq!(Path::new(&get("HOME")), Path::new("/s/agents/install"));
        assert_eq!(Path::new(&get("NPM_CONFIG_PREFIX")), Path::new("/s/agents/install/npm"));
        assert_eq!(Path::new(&get("UV_TOOL_BIN_DIR")), Path::new("/s/agents/install/.local/bin"));
        assert!(bin_dirs_in(Path::new("/s")).contains(&PathBuf::from("/s/agents/install/npm/bin")));
    }

    #[test]
    fn the_windows_installer_env_also_moves_the_profile_and_appdata() {
        let state = Path::new("/s");
        let root = install_root_in(state);
        let get = |env: &[(String, String)], k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| PathBuf::from(v));
        let unix = install_env_for(false, state);
        let win = install_env_for(true, state);
        assert_eq!(get(&unix, "USERPROFILE"), None);
        assert_eq!(get(&unix, "APPDATA"), None);
        assert_eq!(get(&win, "USERPROFILE"), Some(root.clone()));
        assert_eq!(get(&win, "APPDATA"), Some(root.join("AppData").join("Roaming")));
        // Everything Unix sets, Windows sets the same way.
        for (k, v) in &unix {
            assert_eq!(get(&win, k), Some(PathBuf::from(v)), "{k}");
        }
        // Every variable points into the install home (or is a switch).
        for (k, v) in &win {
            assert!(k == "PIP_USER" || Path::new(v).starts_with(&root), "{k}={v}");
        }
        // npm's Windows launchers sit in the prefix root; Unix has no such dir.
        assert!(bin_dirs_for(true, state).contains(&root.join("npm")));
        assert!(!bin_dirs_for(false, state).contains(&root.join("npm")));
        assert!(bin_dirs_for(true, state).contains(&root.join(".local").join("bin")));
    }

    #[test]
    fn a_command_is_owned_only_when_it_resolves_inside_the_install_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let owned_bin = install_root_in(state).join(".local").join("bin");
        let host_bin = tmp.path().join("host-bin");
        std::fs::create_dir_all(&owned_bin).unwrap();
        std::fs::create_dir_all(&host_bin).unwrap();
        std::fs::write(owned_bin.join("claude"), "").unwrap();
        std::fs::write(host_bin.join("codex"), "").unwrap();
        let dirs = vec![host_bin.clone(), owned_bin.clone()];
        assert!(owns_command_in(state, "claude", &dirs));
        assert!(!owns_command_in(state, "codex", &dirs));
        assert!(!owns_command_in(state, "missing", &dirs));
        assert!(owns_command_in(state, &owned_bin.join("claude").to_string_lossy(), &[]));
    }

    #[test]
    fn the_old_claude_mirror_moves_into_the_store_once() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let old_dir = state.join("agent-creds").join("claude");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join(".credentials.json"), "{\"claudeAiOauth\":{}}").unwrap();
        migrate_legacy_stores_in(state);
        let store = crate::services::agent_auth::store_path_in(
            state,
            "claude",
            &crate::services::agent_auth::file(".claude/.credentials.json"),
        );
        assert_eq!(std::fs::read_to_string(&store).unwrap(), "{\"claudeAiOauth\":{}}");
        assert!(!state.join("agent-creds").exists());
        migrate_legacy_stores_in(state);
        assert!(store.is_file());
    }
}
