//! Tabtivity-owned agent homes: one persistent `$HOME` per scope.
//!
//! Every locally-run agent tab sees `<state_dir>/agent-homes/<scope>/` as its
//! home directory instead of the user's (bound over `$HOME` by the Linux
//! fence, `HOME=` on macOS and Windows). A scope is a project, a box
//! (`box:<id>`) or the root console (`root`); the Host session has its own
//! home, `host`, which no fence ever mounts. A scope's local-model tabs
//! (`ollama launch <agent>`, Mistral) get a home of their own beside it,
//! `<scope>.local`, so what an Ollama launch writes into an agent's config and
//! the sessions a local model runs never mix with the scope's own agents'.
//! Homes are per scope rather than
//! per CLI so that config written by an agent in one project (hooks, MCP
//! servers, skills) can only ever run in that project; what the user wants in
//! every project comes from the Tabtivity-wide layer (`services::agent_global`),
//! which no agent can write. Each home holds the
//! agent's own config, transcripts, session stores and trust answers; a
//! CLI's credential file is a copy the per-CLI store keeps in step
//! (`services::agent_auth`), so a login made anywhere sticks everywhere.
//! `~/.cache` of every home is a throwaway tmpfs on Linux.
//!
//! Everything written into a home here runs unfenced against a tree the
//! scope's agent may be rewriting, so it goes through directory handles
//! (`services::home_io`), never a checked path.
//!
//! Design and rationale: `docs/context/agent_authority.md`. AppHandle-free.

use std::io;
use std::path::{Path, PathBuf};

use crate::services::home_io::{HomeDir, HomeFile};
use crate::storage;

/// The directory under the state dir holding every scope's home.
pub const HOMES_DIR: &str = "agent-homes";
/// The scope key of the Host session's home. A project id is a UUID and a box
/// scope is `box:<id>`, so it collides with neither; `root` is the console's.
pub const HOST_SCOPE_KEY: &str = "host";
/// What a scope's local-model home appends to the scope's key. A key is made
/// of `[A-Za-z0-9_-]` only (`storage::project_key`), so no scope's own home
/// can carry it.
const LOCAL_MODEL_SUFFIX: &str = ".local";
/// Written once a home has been seeded, so the one-time imports (an existing
/// per-scope Codex store, the scope's Claude transcripts) never run twice.
/// Its mtime is also when the seeding ran: `services::token_stats` counts no
/// Claude record older than it, so seeded history is not counted per home.
pub(crate) const SEEDED_MARKER: &str = crate::brand::AGENT_HOME_MARKER;

/// `<state_dir>/agent-homes/`.
pub fn homes_root_in(state_dir: &Path) -> PathBuf {
    state_dir.join(HOMES_DIR)
}

pub fn homes_root() -> PathBuf {
    homes_root_in(&storage::state_dir())
}

/// The home of `scope_id` under `state_dir`, keyed by [`storage::project_key`]
/// like the scope's session dir and live-session slice.
pub fn scope_home_in(state_dir: &Path, scope_id: &str) -> PathBuf {
    homes_root_in(state_dir).join(storage::project_key(scope_id))
}

/// The home of a scope (`None` is the root console). A path only; see
/// [`prepare_scope_home`] for the directory itself.
pub fn scope_home(scope_id: Option<&str>) -> PathBuf {
    scope_home_in(&storage::state_dir(), scope_id.unwrap_or(storage::ROOT_SCOPE))
}

/// The home of `scope_id`'s local-model tabs under `state_dir`: the scope's
/// own home's key with [`LOCAL_MODEL_SUFFIX`].
pub fn local_model_home_in(state_dir: &Path, scope_id: &str) -> PathBuf {
    homes_root_in(state_dir).join(format!("{}{LOCAL_MODEL_SUFFIX}", storage::project_key(scope_id)))
}

/// Whether `home` is a scope's local-model home ([`local_model_home_in`]):
/// no scope's own key can end in [`LOCAL_MODEL_SUFFIX`].
pub fn is_local_model_home(home: &Path) -> bool {
    home.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(LOCAL_MODEL_SUFFIX))
}

/// The local-model home of a scope (`None` is the root console). A path only;
/// see [`prepare_local_model_home`].
pub fn local_model_home(scope_id: Option<&str>) -> PathBuf {
    local_model_home_in(&storage::state_dir(), scope_id.unwrap_or(storage::ROOT_SCOPE))
}

/// The Host session's home.
pub fn host_home_in(state_dir: &Path) -> PathBuf {
    homes_root_in(state_dir).join(HOST_SCOPE_KEY)
}

pub fn host_home() -> PathBuf {
    host_home_in(&storage::state_dir())
}

/// The scope id of a local spawn: its project or box, else the root console.
pub fn scope_of(project_id: Option<&str>) -> String {
    project_id.unwrap_or(storage::ROOT_SCOPE).to_string()
}

/// Create `dir` private to the user (`0700` on unix); a no-op when present.
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// What a spawn needs to know about the home it got.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedHome {
    pub dir: PathBuf,
    /// The home was created by this call (its seeding just ran).
    pub fresh: bool,
}

/// Create (or reuse) the home of `scope_id` and bring it up to date: seeded
/// once ([`seed_home`]), the Tabtivity-wide config layer laid in
/// (`services::agent_global`), Tabtivity's session hooks registered, the shared logins
/// linked in, the `.cache` mount point present. `roots` are the scope's
/// writable roots, used only by the one-time transcript seeding. Called at
/// every local agent spawn.
pub fn prepare_scope_home(scope_id: &str, roots: &[PathBuf]) -> io::Result<PreparedHome> {
    let state_dir = storage::state_dir();
    let home = scope_home_in(&state_dir, scope_id);
    prepare_home_in(&state_dir, &home, scope_id, roots, Seed::Scope)
}

/// The home of the scope's local-model tabs: same preparation, seeded with
/// only Claude's identity and the scope's folder trust — the scope's Codex
/// and Copilot stores stay its own home's to adopt, and no transcript of the
/// user's is copied in for a model that never wrote one.
pub fn prepare_local_model_home(scope_id: &str, roots: &[PathBuf]) -> io::Result<PreparedHome> {
    let state_dir = storage::state_dir();
    let home = local_model_home_in(&state_dir, scope_id);
    prepare_home_in(&state_dir, &home, scope_id, roots, Seed::LocalModel)
}

/// The Host session's home: same preparation, but nothing is seeded from a
/// fenced scope's state and no transcripts are copied in.
pub fn prepare_host_home() -> io::Result<PreparedHome> {
    let state_dir = storage::state_dir();
    let home = host_home_in(&state_dir);
    prepare_home_in(&state_dir, &home, HOST_SCOPE_KEY, &[], Seed::Nothing)
}

/// What a new home's one-time seeding ([`seed_home`]) brings in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Seed {
    /// A scope's own home: everything.
    Scope,
    /// A scope's local-model home: Claude's identity and folder trust only.
    LocalModel,
    /// The Host session's: nothing of a fenced scope's.
    Nothing,
}

fn prepare_home_in(
    state_dir: &Path,
    home: &Path,
    scope_id: &str,
    roots: &[PathBuf],
    seed: Seed,
) -> io::Result<PreparedHome> {
    create_private_dir(&homes_root_in(state_dir))?;
    // A home an older build seeded carries its markers under the old name:
    // bring it to the current names first, or it would count as fresh and be
    // seeded a second time. The launch does this for every home; this covers
    // a home that appeared since. Not reached while the name is unchanged.
    crate::services::brand_migration::agent_homes::migrate_home_at_spawn(&crate::brand::PAIR, state_dir, home);
    let fresh = !home.join(SEEDED_MARKER).is_file();
    create_private_dir(home)?;
    if fresh {
        seed_home(state_dir, home, scope_id, roots, seed);
        std::fs::write(home.join(SEEDED_MARKER), b"")?;
    }
    // Before the logins are linked and the hooks registered: both write
    // where the old fence's leftovers sit.
    for adopted in [".codex", ".copilot"] {
        scrub_fence_leftovers(home, adopted);
    }
    // The tmpfs the Linux fence mounts over it needs a mount point on disk —
    // a directory, not whatever an agent left at the name.
    if HomeDir::open(home, ".cache").is_none() {
        if let Some(stray) = HomeFile::open(home, ".cache") {
            let _ = stray.remove();
        }
        let _ = HomeDir::open(home, ".cache");
    }
    // The user's Tabtivity-wide instructions, skills, hooks and MCP servers,
    // before Tabtivity's own hooks so a merge never displaces those.
    if let Err(e) = crate::services::agent_global::apply_to_home(state_dir, home) {
        eprintln!("agent_home: apply the global agent config to {}: {e}", home.display());
    }
    crate::services::agent_session::register_hooks_in_home(home);
    // Copilot signs in through a keyring the fence hides: its home gets the
    // plain-text token setting Tabtivity's keeper collects from (`copilot_auth`).
    // That is the scope's own home; Copilot drives no local model.
    #[cfg(target_os = "linux")]
    if seed != Seed::LocalModel {
        let _ = crate::services::copilot_auth::prepare_home(scope_id);
    }
    crate::services::agent_auth::link_into_home(state_dir, home);
    Ok(PreparedHome {
        dir: home.to_path_buf(),
        fresh,
    })
}

/// One-time seeding of a new home:
///
/// - the scope's existing Tabtivity-kept Codex store (`codex-state/<key>`) and
///   Copilot home (`copilot-home/<key>`) move in as `.codex` / `.copilot`, so
///   sessions those tabs had keep resuming;
/// - the Claude transcripts of the scope's own roots are **copied** from the
///   user's `~/.claude/projects`, so every tab that was open before this home
///   existed still resumes; the user's own copy is left untouched;
/// - `.claude.json` gets its identity keys and the `projects` entries under
///   the scope's roots from the user's file, so the first tab is not a fresh
///   install and keeps the folder trust it already had.
///
/// Instructions, skills, hooks and MCP entries of the user's home are not
/// brought in here: they reach every home through the Tabtivity-wide layer
/// (`services::agent_global`) once the user imports them there. A
/// local-model home gets only the `.claude.json` seed ([`Seed`]).
fn seed_home(state_dir: &Path, home: &Path, scope_id: &str, roots: &[PathBuf], seed: Seed) {
    let user_home = crate::paths::home_dir();
    let root_strings = || roots.iter().map(|r| r.to_string_lossy().into_owned()).collect::<Vec<String>>();
    if seed == Seed::LocalModel {
        seed_claude_json(&user_home.join(".claude.json"), home, &root_strings());
    }
    if seed == Seed::Scope {
        let key = storage::project_key(scope_id);
        for (legacy, into) in [("codex-state", ".codex"), ("copilot-home", ".copilot")] {
            let src = state_dir.join(legacy).join(&key);
            let dst = home.join(into);
            if src.is_dir() && !dst.exists() {
                if let Err(e) = std::fs::rename(&src, &dst) {
                    eprintln!("agent_home: adopt {}: {e}", src.display());
                }
            }
        }
        let roots = root_strings();
        seed_claude_transcripts(&user_home.join(".claude").join("projects"), home, &roots);
        seed_claude_json(&user_home.join(".claude.json"), home, &roots);
    }
}

/// Where the old fence bound a scope's staged config copies (`--symlink`ed
/// from the store); gone with the per-scope homes.
const LEGACY_STAGE_MOUNT: &str = concat!("/run/", crate::legacy_slug!(), "-agent-config");

/// Drop what the old fence left in an adopted store. Until the per-scope
/// homes, the fence bind-mounted the user's own `~/.codex/<file>`s over the
/// scope's Codex store and `--symlink`ed its `config.toml` into the stage
/// mount; bubblewrap creates a missing file mount point as an empty read-only
/// file, and the link landed on disk because the store was mounted
/// read-write. As the home's `.codex` those are plain files Codex opens for
/// writing on its first start (`session_index.jsonl`, `version.json`,
/// `auth.json`, …) and dies on with `EACCES`, and the dangling link swallowed
/// the hook registration. No CLI writes an empty read-only file of its own;
/// Codex and the login link recreate what they need. Cheap: one directory
/// listing, run at every spawn since existing homes were seeded before this.
/// Through the directory handle: the names are only ever unlinked relative
/// to the `.codex` that was opened, never through a link planted at its path.
fn scrub_fence_leftovers(home: &Path, adopted: &str) {
    let Some(dir) = HomeDir::open_existing(home, adopted) else {
        return;
    };
    for name in dir.names() {
        let Some(file) = dir.file(&name) else { continue };
        let Some(meta) = file.metadata() else { continue };
        let stage_link = meta.is_symlink
            && file.read_link().is_some_and(|target| target.starts_with(LEGACY_STAGE_MOUNT));
        let mount_point = meta.is_file && meta.len == 0 && meta.mode & 0o222 == 0;
        if stage_link || mount_point {
            if let Err(e) = file.remove() {
                eprintln!("agent_home: drop the old fence's {}: {e}", file.path().display());
            }
        }
    }
}

/// Copy every transcript dir of `user_projects` that belongs to one of `roots`
/// into `<home>/.claude/projects`. Dirs the home already has are left alone.
/// Seeding runs when the home has no seeded marker — which an agent can
/// delete — so the copy is written through directory handles like every
/// other write into a home.
pub(crate) fn seed_claude_transcripts(user_projects: &Path, home: &Path, roots: &[String]) {
    let Ok(entries) = std::fs::read_dir(user_projects) else {
        return;
    };
    let Some(dest_root) = HomeDir::open(home, ".claude/projects") else {
        return;
    };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() {
            continue;
        }
        let Some(name) = src.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !crate::services::sandbox::transcript_dir_belongs_to(&src, name, roots) {
            continue;
        }
        if dest_root.file(name).is_some_and(|f| f.exists()) {
            continue;
        }
        let Some(dst) = dest_root.subdir(name) else { continue };
        if let Err(e) = copy_tree(&src, &dst) {
            eprintln!("agent_home: seed transcripts {}: {e}", src.display());
        }
    }
}

/// Recursive copy of regular files and directories into an opened home
/// directory; symlinks are skipped (a transcript tree holds none of Claude's
/// own making).
fn copy_tree(src: &Path, dst: &HomeDir) -> io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if ty.is_dir() {
            let Some(sub) = dst.subdir(&name) else { continue };
            copy_tree(&entry.path(), &sub)?;
        } else if ty.is_file() {
            let Some(to) = dst.file(&name) else { continue };
            to.write(&std::fs::read(entry.path())?)?;
        }
    }
    Ok(())
}

/// Top-level `~/.claude.json` keys that make a home "not a fresh install":
/// who is signed in and that onboarding is done. Nothing that grants a tool.
pub(crate) const CLAUDE_JSON_IDENTITY_KEYS: &[&str] = &[
    "oauthAccount",
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "userID",
    "installMethod",
    "autoUpdates",
    "theme",
];

/// Seed `<home>/.claude.json` from the user's file: the identity keys and the
/// `projects` entries at or under `roots` (prompt history, folder trust). The
/// destination is written only when absent (a link there counts as present
/// and is never followed).
pub(crate) fn seed_claude_json(user_file: &Path, home: &Path, roots: &[String]) {
    let Some(dst) = HomeFile::open(home, ".claude.json") else {
        return;
    };
    if dst.exists() {
        return;
    }
    let Some(value) = std::fs::read(user_file)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    else {
        return;
    };
    let seeded = filtered_claude_json(&value, roots);
    if let Ok(body) = serde_json::to_vec_pretty(&seeded) {
        let _ = dst.write(&body);
    }
}

/// Pure: the identity keys plus the `projects` map filtered to `roots`.
pub(crate) fn filtered_claude_json(value: &serde_json::Value, roots: &[String]) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Some(obj) = value.as_object() {
        for key in CLAUDE_JSON_IDENTITY_KEYS {
            if let Some(v) = obj.get(*key) {
                out.insert((*key).to_string(), v.clone());
            }
        }
        if let Some(projects) = obj.get("projects").and_then(|p| p.as_object()) {
            let kept: serde_json::Map<String, serde_json::Value> = projects
                .iter()
                .filter(|(cwd, _)| roots.iter().any(|root| Path::new(cwd).starts_with(root)))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            out.insert("projects".into(), serde_json::Value::Object(kept));
        }
    }
    serde_json::Value::Object(out)
}

/// Remove a scope's homes for good — a project forgotten or deleted: its own
/// and its local-model tabs'.
pub fn delete_scope_home(scope_id: &str) -> io::Result<()> {
    let state_dir = storage::state_dir();
    for home in [scope_home_in(&state_dir, scope_id), local_model_home_in(&state_dir, scope_id)] {
        if home.exists() {
            std::fs::remove_dir_all(&home)?;
        }
    }
    Ok(())
}

/// Every scope key that has a home, for the login keeper's sweep.
pub(crate) fn existing_homes_in(state_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(homes_root_in(state_dir)) else {
        return Vec::new();
    };
    let mut homes: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    homes.sort();
    homes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scope_homes_are_keyed_like_session_dirs_and_host_is_apart() {
        let state = Path::new("/s");
        assert_eq!(scope_home_in(state, "root"), PathBuf::from("/s/agent-homes/root"));
        assert_eq!(scope_home_in(state, "box:b1"), PathBuf::from("/s/agent-homes/box_b1"));
        assert_eq!(host_home_in(state), PathBuf::from("/s/agent-homes/host"));
        assert_ne!(scope_home_in(state, "host"), host_home_in(state).join("x"));
        assert_eq!(local_model_home_in(state, "root"), PathBuf::from("/s/agent-homes/root.local"));
        assert_eq!(local_model_home_in(state, "box:b1"), PathBuf::from("/s/agent-homes/box_b1.local"));
        // No scope's own key can spell a local-model home.
        assert_ne!(scope_home_in(state, "root.local"), local_model_home_in(state, "root"));
    }

    #[test]
    fn claude_json_seed_keeps_identity_and_only_the_scopes_projects() {
        let value = json!({
            "oauthAccount": {"emailAddress": "a@b"},
            "hasCompletedOnboarding": true,
            "mcpServers": {"evil": {"command": "x"}},
            "projects": {
                "/work/p": {"hasTrustDialogAccepted": true, "allowedTools": ["Bash"]},
                "/work/p/sub": {"history": []},
                "/other": {"hasTrustDialogAccepted": true}
            }
        });
        let out = filtered_claude_json(&value, &["/work/p".into()]);
        assert_eq!(out["oauthAccount"]["emailAddress"], "a@b");
        assert_eq!(out["hasCompletedOnboarding"], true);
        assert!(out.get("mcpServers").is_none());
        let projects = out["projects"].as_object().unwrap();
        assert!(projects.contains_key("/work/p"));
        assert!(projects.contains_key("/work/p/sub"));
        assert!(!projects.contains_key("/other"));
    }

    #[test]
    fn transcript_seeding_copies_only_the_scopes_dirs_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user-projects");
        let home = tmp.path().join("home");
        let ours = user.join("-work-p");
        let theirs = user.join("-other");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(ours.join("s.jsonl"), "{\"cwd\":\"/work/p\"}\n").unwrap();
        std::fs::write(theirs.join("t.jsonl"), "{\"cwd\":\"/other\"}\n").unwrap();
        seed_claude_transcripts(&user, &home, &["/work/p".into()]);
        let dest = home.join(".claude/projects");
        assert!(dest.join("-work-p/s.jsonl").is_file());
        assert!(!dest.join("-other").exists());
        // The user's copy stays where it was.
        assert!(ours.join("s.jsonl").is_file());
        std::fs::write(dest.join("-work-p/s.jsonl"), "changed").unwrap();
        seed_claude_transcripts(&user, &home, &["/work/p".into()]);
        assert_eq!(std::fs::read_to_string(dest.join("-work-p/s.jsonl")).unwrap(), "changed");
    }

    /// A re-seed forced by a deleted marker meets a home the agent prepared:
    /// `.claude` linked out of the home, `.claude.json` linked at a host
    /// file. Nothing is written through either.
    #[cfg(unix)]
    #[test]
    fn seeding_never_writes_through_a_planted_link() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user-projects");
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(user.join("-work-p")).unwrap();
        std::fs::write(user.join("-work-p/s.jsonl"), "{\"cwd\":\"/work/p\"}\n").unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".claude")).unwrap();
        let victim = tmp.path().join("victim.json");
        std::fs::write(&victim, "{}").unwrap();
        std::os::unix::fs::symlink(&victim, home.join(".claude.json")).unwrap();
        let user_json = tmp.path().join("user.json");
        std::fs::write(&user_json, r#"{"oauthAccount":{"emailAddress":"a@b"}}"#).unwrap();

        seed_claude_transcripts(&user, &home, &["/work/p".into()]);
        seed_claude_json(&user_json, &home, &["/work/p".into()]);

        assert!(!outside.join("projects").exists());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "{}");
    }

    /// A local-model home leaves the scope's Codex store where it is, for the
    /// scope's own home to adopt.
    #[test]
    fn a_local_model_home_never_adopts_the_scopes_codex_store() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let legacy = state.join("codex-state").join(storage::project_key("p1"));
        std::fs::create_dir_all(&legacy).unwrap();
        let local = local_model_home_in(state, "p1");
        std::fs::create_dir_all(&local).unwrap();
        seed_home(state, &local, "p1", &[], Seed::LocalModel);
        assert!(legacy.is_dir());
        assert!(!local.join(".codex").exists());
        let own = scope_home_in(state, "p1");
        std::fs::create_dir_all(&own).unwrap();
        seed_home(state, &own, "p1", &[], Seed::Scope);
        assert!(own.join(".codex").is_dir());
    }

    /// The old fence's mount points (empty, read-only) and stage link go;
    /// Codex's own files — empty but writable, or read-only with content —
    /// stay, and the hook registration then lands in a plain `config.toml`.
    #[cfg(unix)]
    #[test]
    fn preparing_a_home_drops_the_old_fences_mount_points_and_stage_link() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let home = scope_home_in(state, "p1");
        let codex = home.join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        let read_only = |name: &str| {
            std::fs::set_permissions(codex.join(name), std::fs::Permissions::from_mode(0o444)).unwrap()
        };
        for name in ["version.json", "session_index.jsonl", "auth.json", ".sandbox_migration"] {
            std::fs::write(codex.join(name), b"").unwrap();
            read_only(name);
        }
        std::os::unix::fs::symlink(
            format!("{LEGACY_STAGE_MOUNT}/home_u_.codex_config.toml"),
            codex.join("config.toml"),
        )
        .unwrap();
        std::fs::write(codex.join("history.jsonl"), b"").unwrap();
        std::fs::write(codex.join("installation_id"), b"abc").unwrap();
        read_only("installation_id");

        prepare_home_in(state, &home, "p1", &[], Seed::Scope).unwrap();

        for name in ["version.json", "session_index.jsonl", "auth.json", ".sandbox_migration"] {
            assert!(!codex.join(name).exists(), "{name}");
        }
        assert!(codex.join("history.jsonl").is_file());
        assert_eq!(std::fs::read(codex.join("installation_id")).unwrap(), b"abc");
        let config = codex.join("config.toml");
        assert!(std::fs::symlink_metadata(&config).unwrap().is_file());
        assert!(std::fs::read_to_string(&config).unwrap().contains("[[hooks.SessionStart]]"));
        // Already seeded: the scrub still runs on the next spawn.
        std::fs::write(codex.join("models_cache.json"), b"").unwrap();
        read_only("models_cache.json");
        prepare_home_in(state, &home, "p1", &[], Seed::Scope).unwrap();
        assert!(!codex.join("models_cache.json").exists());
    }

    #[test]
    fn a_home_is_seeded_once_and_adopts_the_legacy_codex_store() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let legacy = state.join("codex-state").join("p1");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("state_5.sqlite"), "db").unwrap();
        let home = scope_home_in(state, "p1");
        let first = prepare_home_in(state, &home, "p1", &[], Seed::Scope).unwrap();
        assert!(first.fresh);
        assert!(home.join(".codex/state_5.sqlite").is_file());
        assert!(!legacy.exists());
        assert!(home.join(".cache").is_dir());
        assert!(home.join(SEEDED_MARKER).is_file());
        let again = prepare_home_in(state, &home, "p1", &[], Seed::Scope).unwrap();
        assert!(!again.fresh);
        assert!(existing_homes_in(state).contains(&home));
    }
}
