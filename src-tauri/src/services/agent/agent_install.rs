//! Tabtivity-owned agent CLI installs.
//!
//! An agent CLI Tabtivity installs goes into `<state_dir>/agents/install/`, a
//! home of its own handed to the vendor's installer as `HOME` (with the npm,
//! bun and uv prefixes pointed there too), never into the user's home. Inside
//! every fence that tree is read-only and the CLI's own auto-updater is
//! switched off where the CLI has a switch, so an agent cannot replace the
//! binary it runs as; updates run outside the fence (Manage CLIs → install
//! again). A CLI the user installed on the host keeps being detected, is just
//! as read-only in the fence, and is shadowed once reinstalled through
//! Tabtivity: this tree's launcher dirs come first on PATH.
//!
//! Verified per installer only where noted in `commands::agents`; an
//! installer that ignores these variables lands in the user's home as before.

use std::path::{Path, PathBuf};

use crate::storage;

/// The install home, relative to the state dir.
const INSTALL_DIR: &str = "agents/install";

/// The install home: `<state_dir>/agents/install/` on the desktop; on a
/// server the admin-owned, server-wide root (`<PREFIX>SERVER_CLI_ROOT`,
/// hosted plan §5.1) — read-only to every user, written only by the admin
/// helper's `cli-install` as the CLI account, so no user installs or updates
/// a CLI and no per-user copy exists.
pub fn install_root_in(state_dir: &Path) -> PathBuf {
    crate::services::server::cli_root().unwrap_or_else(|| state_dir.join(INSTALL_DIR))
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
    let found = if cmd.contains('/') {
        Some(PathBuf::from(cmd))
    } else {
        search_dirs.iter().map(|d| d.join(cmd)).find(|c| c.is_file())
    };
    found.is_some_and(|found| owns_path_in(state_dir, &found))
}

/// Whether `path` (as found, or after resolving links) lies in the install
/// home. Pure over the filesystem.
pub fn owns_path_in(state_dir: &Path, path: &Path) -> bool {
    let root = install_root_in(state_dir);
    let real = path.canonicalize().unwrap_or(path.to_path_buf());
    let root_real = root.canonicalize().unwrap_or(root.clone());
    path.starts_with(&root) || real.starts_with(&root_real)
}

pub fn owns_command(cmd: &str, search_dirs: &[PathBuf]) -> bool {
    owns_command_in(&storage::state_dir(), cmd, search_dirs)
}

pub fn owns_path(path: &Path) -> bool {
    owns_path_in(&storage::state_dir(), path)
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

/// The argv that updates a CLI in place, by registry `id`, for the CLI whose
/// installer cannot: Antigravity's `install.sh` and `install.ps1` stop at
/// "already installed" with exit 0, so running one again changes nothing and
/// reads as success. `agy update` replaces the binary it runs from, and exits
/// non-zero with the reason on stderr when it cannot (1.4.5, 2026-10-30).
const SELF_UPDATE_ARGV: &[(&str, &[&str])] = &[("antigravity", &["update"])];

/// See [`SELF_UPDATE_ARGV`]; `None` means the installer run again is the update.
pub fn self_update_argv(agent_id: &str) -> Option<&'static [&'static str]> {
    SELF_UPDATE_ARGV
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, argv)| *argv)
}

/// The oldest `uv` Mistral Vibe's `install.sh` works with: it installs and
/// upgrades `mistral-vibe` with `--python cpython-3.14+gil`, which an older
/// uv cannot fetch (0.5.9: "No download found for request:
/// cpython-3.14-linux-x86_64-gnu"). The script pins uv 0.11.26 (2026-11-07)
/// but installs it only when no `uv` is on PATH at all, so a stale one the
/// user keeps in `~/.local/bin` failed every Update.
const VIBE_MIN_UV: &str = "0.11";

/// A current `uv` into the install home's `~/.local/bin` (`HOME` is the
/// install home; that dir leads the installer's PATH), with Astral's
/// installer. `UV_UNMANAGED_INSTALL` writes no receipt and edits no shell
/// profile, so nothing of the user's uv setup changes.
const FRESH_UV: &str =
    "curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=\"$HOME/.local/bin\" sh 2>&1 && ";

/// A shell prefix for `agent_id`'s Unix installer line, or `""`. `probe_uv`
/// says what `uv` the installer would find first on its PATH: `None` none,
/// `Some(None)` one whose version could not be read. Only called for an
/// installer that needs it. A missing uv needs nothing: the installer brings
/// its own.
pub fn installer_prelude(
    agent_id: &str,
    probe_uv: impl FnOnce() -> Option<Option<String>>,
) -> &'static str {
    if agent_id != "vibe" {
        return "";
    }
    match probe_uv() {
        Some(Some(version))
            if crate::services::agent_versions::version_cmp(&version, VIBE_MIN_UV)
                != std::cmp::Ordering::Less =>
        {
            ""
        }
        Some(_) => FRESH_UV,
        None => "",
    }
}

/// CLIs, by registry id, whose installer takes any copy on its PATH for its
/// own and then upgrades in the install home, where there is none: Vibe's
/// `install.sh` finds the user's `~/.local/bin/vibe`, runs `uv tool upgrade
/// mistral-vibe` against the install home's `UV_TOOL_DIR` and fails
/// ("`mistral-vibe` is not installed; run `uv tool install`", 2026-11-10).
const INSTALLER_HIDES_HOST_COPY: &[&str] = &["vibe"];

/// Dirs never left off an installer's PATH: without them it has no shell
/// tools at all. A host copy there still reaches the installer.
const SYSTEM_BIN_DIRS: &[&str] = &["/bin", "/sbin", "/usr/bin", "/usr/sbin"];

/// The PATH dirs `agent_id`'s installer runs with: `dirs` minus, for a CLI in
/// [`INSTALLER_HIDES_HOST_COPY`], every dir outside `root` (the install home)
/// that holds `bin`, so the installer installs fresh into the install home
/// instead of upgrading a copy it does not own. Pure over the filesystem.
pub fn installer_path_dirs(agent_id: &str, bin: &str, root: &Path, dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    if !INSTALLER_HIDES_HOST_COPY.contains(&agent_id) {
        return dirs;
    }
    dirs.into_iter()
        .filter(|d| {
            d.starts_with(root)
                || SYSTEM_BIN_DIRS.iter().any(|s| d == Path::new(s))
                || !d.join(bin).is_file()
        })
        .collect()
}

/// The auto-update switch of a CLI, by command basename. Only switches that
/// are documented; a CLI without one simply fails its update on the
/// read-only tree and carries on.
fn autoupdate_off(bin: &str) -> &'static [(&'static str, &'static str)] {
    match bin {
        "claude" => &[("DISABLE_AUTOUPDATER", "1")],
        // Skips both the update check and the V1 → V2 "upgrade major" offer
        // (1.19, 2.1): run in the fence, its installer writes into the agent
        // home, which a restart never runs ahead of the install home.
        "opencode" => &[("OPENCODE_DISABLE_AUTOUPDATE", "1")],
        // It downloads each release into `~/.cache/copilot/pkg`, which is a
        // tmpfs in the fence: "restart to update" then restarted on the old
        // version, every time.
        "copilot" => &[("COPILOT_AUTO_UPDATE", "false")],
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
    #[test]
    fn only_a_cli_whose_installer_cannot_update_has_a_self_update_argv() {
        assert_eq!(super::self_update_argv("antigravity"), Some(&["update"][..]));
        assert_eq!(super::self_update_argv("claude"), None);
    }

    #[test]
    fn vibe_gets_a_fresh_uv_only_when_the_one_on_path_is_stale() {
        let v = |s: &'static str| move || Some(Some(s.to_string()));
        // The reported failure: the user's uv 0.5.9 cannot fetch CPython 3.14.
        assert_eq!(super::installer_prelude("vibe", v("0.5.9")), super::FRESH_UV);
        assert_eq!(super::installer_prelude("vibe", v("0.10.4")), super::FRESH_UV);
        assert_eq!(super::installer_prelude("vibe", || Some(None)), super::FRESH_UV);
        assert_eq!(super::installer_prelude("vibe", v("0.11.0")), "");
        assert_eq!(super::installer_prelude("vibe", v("0.12.1")), "");
        // No uv at all: Vibe's installer brings its own pinned one.
        assert_eq!(super::installer_prelude("vibe", || None), "");
        // Any other CLI never probes.
        assert_eq!(super::installer_prelude("claude", || panic!("probed")), "");
        // The prefix writes only into the install home and chains on success.
        assert!(super::FRESH_UV.contains("UV_UNMANAGED_INSTALL=\"$HOME/.local/bin\""));
        assert!(super::FRESH_UV.trim_end().ends_with("&&"));
    }

    use super::*;

    #[test]
    fn vibe_installer_does_not_see_the_host_copy_on_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("install");
        let own = root.join(".local").join("bin");
        let host = tmp.path().join("home").join(".local").join("bin");
        let other = tmp.path().join("other");
        for d in [&own, &host, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(own.join("vibe"), "").unwrap();
        std::fs::write(host.join("vibe"), "").unwrap();
        std::fs::write(other.join("uv"), "").unwrap();
        let dirs = vec![own.clone(), host.clone(), other.clone(), PathBuf::from("/usr/bin")];
        // The reported failure: the host `~/.local/bin/vibe` made the installer
        // upgrade a tool the install home never had. Its own copy stays.
        assert_eq!(
            installer_path_dirs("vibe", "vibe", &root, dirs.clone()),
            vec![own.clone(), other.clone(), PathBuf::from("/usr/bin")]
        );
        // Every other CLI keeps the PATH as it is.
        assert_eq!(installer_path_dirs("claude", "vibe", &root, dirs.clone()), dirs);
    }

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
    fn a_fenced_spawn_switches_off_the_self_updaters_but_keeps_the_users_value() {
        let mut env = std::collections::HashMap::new();
        apply_fence_env("/s/agents/install/.opencode/bin/opencode", &mut env);
        assert_eq!(env.get("OPENCODE_DISABLE_AUTOUPDATE").map(String::as_str), Some("1"));
        let mut env = std::collections::HashMap::from([("DISABLE_AUTOUPDATER".to_string(), "0".to_string())]);
        apply_fence_env("claude.exe", &mut env);
        assert_eq!(env.get("DISABLE_AUTOUPDATER").map(String::as_str), Some("0"));
        let mut env = std::collections::HashMap::new();
        apply_fence_env("/s/agents/install/npm/bin/copilot", &mut env);
        assert_eq!(env.get("COPILOT_AUTO_UPDATE").map(String::as_str), Some("false"));
        let mut env = std::collections::HashMap::new();
        apply_fence_env("codex", &mut env);
        assert!(env.is_empty());
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
        // A resolved path (the npm uninstall picks its prefix by this).
        assert!(owns_path_in(state, &owned_bin.join("claude")));
        assert!(!owns_path_in(state, &host_bin.join("codex")));
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
