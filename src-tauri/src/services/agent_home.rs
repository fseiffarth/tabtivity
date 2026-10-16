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

/// The assistant scope's home (`agent-homes/assistant`, or `assistant.local`
/// for a local-model chat), brought up to date for a chat working in
/// `chat_dir`. Nothing is seeded (no transcript, no identity or trust of the
/// user's), and **the `agent_global` layer is never applied**: the user's
/// everywhere-layer carries MCP servers, skills and hooks, and the assistant
/// may have none of them (plan decision 4). Kept from an ordinary home:
/// Tabtivity's session hooks (turn state needs them) and the shared logins.
/// Left out: the Copilot token setting. Written: Claude's and Codex's folder
/// trust for `chat_dir`, and Claude's onboarding flag, so a fresh home starts
/// without those dialogs.
///
/// `chat_dir` must be a folder below the assistant's `work` folder
/// (`assistant::work_root`), or the call refuses. It is **not created here**
/// (the spawn path decides whether a chat's folder already existed from it).
/// Called at every assistant spawn.
pub fn prepare_assistant_home(local: bool, chat_dir: &Path) -> io::Result<PreparedHome> {
    prepare_assistant_home_in(&storage::state_dir(), local, chat_dir)
}

/// [`prepare_assistant_home`] against an explicit state dir.
fn prepare_assistant_home_in(state_dir: &Path, local: bool, chat_dir: &Path) -> io::Result<PreparedHome> {
    let work = crate::services::assistant::work_root(state_dir);
    let plain = chat_dir.components().all(|c| !matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir));
    if !plain || chat_dir == work || !chat_dir.starts_with(&work) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the chat folder is not below the assistant's work folder"));
    }
    let home = if local {
        local_model_home_in(state_dir, storage::ASSISTANT_SCOPE)
    } else {
        scope_home_in(state_dir, storage::ASSISTANT_SCOPE)
    };
    prepare_home_with(state_dir, &home, storage::ASSISTANT_SCOPE, &[], Seed::Assistant, Some(chat_dir))
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
    /// The assistant scope's: nothing seeded, and unlike every other home
    /// neither the `agent_global` layer nor the Copilot setting reaches it
    /// ([`prepare_assistant_home`]).
    Assistant,
}

fn prepare_home_in(
    state_dir: &Path,
    home: &Path,
    scope_id: &str,
    roots: &[PathBuf],
    seed: Seed,
) -> io::Result<PreparedHome> {
    prepare_home_with(state_dir, home, scope_id, roots, seed, None)
}

/// [`prepare_home_in`] plus, for the assistant home, the chat folder the CLIs
/// are told to trust. Written inside the home's preparation lock: two chats
/// starting at once must not lose each other's trust entry in the shared
/// `.claude.json` / `config.toml`.
fn prepare_home_with(
    state_dir: &Path,
    home: &Path,
    scope_id: &str,
    roots: &[PathBuf],
    seed: Seed,
    trust: Option<&Path>,
) -> io::Result<PreparedHome> {
    create_private_dir(&homes_root_in(state_dir))?;
    // One preparation of a home at a time, across processes too: the window
    // and its desktop sidecar share the state dir, and two spawns of one
    // scope must not interleave the seeding, the global layer's merge, the
    // hook registration or the login placement (final review B4). Outside
    // the homes root, so no fence ever sees the lock file.
    let home_key = home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let _one_at_a_time = storage::FileLock::exclusive(&crate::services::process_lease::path_in(state_dir, &format!("home-{home_key}")))?;
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
    // before Tabtivity's own hooks so a merge never displaces those. Never
    // into the assistant's home (plan decision 4).
    if seed != Seed::Assistant {
        if let Err(e) = crate::services::agent_global::apply_to_home(state_dir, home) {
            eprintln!("agent_home: apply the global agent config to {}: {e}", home.display());
        }
    }
    // Folder trust for the chat, before the hooks are registered: the
    // assistant's CLIs must not stop at a dialog, and a trust that cannot be
    // written refuses the spawn (nothing is started half-prepared).
    if let Some(dir) = trust {
        trust_chat_folder(home, dir)?;
    }
    crate::services::agent_session::register_hooks_in_home(home);
    // Copilot signs in through a keyring the fence hides: its home gets the
    // plain-text token setting Tabtivity's keeper collects from (`copilot_auth`).
    // That is the scope's own home; Copilot drives no local model.
    #[cfg(target_os = "linux")]
    if !matches!(seed, Seed::LocalModel | Seed::Assistant) {
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
    // `Seed::Nothing` and `Seed::Assistant` bring in nothing.
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

/// The spellings of `dir` the CLIs may key their folder trust by: the path as
/// the spawn gives it (the fence binds it at the same absolute path, so it is
/// the CLI's cwd), plus its resolved form when a link in the state dir's path
/// makes the two differ. Only existing parents resolve; the folder itself may
/// not exist yet.
fn trust_spellings(dir: &Path) -> Vec<String> {
    let mut out = vec![dir.to_string_lossy().into_owned()];
    let resolved = dir.canonicalize().ok().or_else(|| {
        let (parent, name) = (dir.parent()?, dir.file_name()?);
        Some(parent.canonicalize().ok()?.join(name))
    });
    if let Some(resolved) = resolved.map(|p| p.to_string_lossy().into_owned()) {
        if !out.contains(&resolved) {
            out.push(resolved);
        }
    }
    out
}

/// Write Claude's and Codex's folder-trust entries for the assistant's chat
/// folder into `home`, through directory handles. A config the CLI (or an
/// agent) left unparsable is moved aside and started over: the home holds
/// nothing of the user's.
fn trust_chat_folder(home: &Path, chat_dir: &Path) -> io::Result<()> {
    let dirs = trust_spellings(chat_dir);
    let not_plain = |rel: &str| io::Error::other(format!("{rel} in {} is not a plain path", home.display()));
    let claude = HomeFile::open(home, ".claude.json").ok_or_else(|| not_plain(".claude.json"))?;
    trust_claude_json(&claude, &dirs)?;
    let codex = HomeFile::open(home, ".codex/config.toml").ok_or_else(|| not_plain(".codex/config.toml"))?;
    trust_codex_config(&codex, &dirs)
}

/// `.claude.json`: `projects.<dir>.hasTrustDialogAccepted = true` for each of
/// `dirs`, and `hasCompletedOnboarding = true` unless the file says otherwise
/// (the login keeper puts the user's own value in when it knows one). Every
/// other key stays.
fn trust_claude_json(file: &HomeFile, dirs: &[String]) -> io::Result<()> {
    use serde_json::{json, Value};
    let existing = file.read();
    let mut value = match existing.as_deref().map(serde_json::from_slice::<Value>) {
        Some(Ok(v)) if v.is_object() => v,
        Some(_) => {
            file.rename_aside(".unreadable")?;
            json!({})
        }
        // Present but unreadable (not merely missing): never overwrite blind.
        None if file.exists() => return Err(io::Error::other(".claude.json cannot be read")),
        None => json!({}),
    };
    let Some(root) = value.as_object_mut() else { return Ok(()) };
    root.entry("hasCompletedOnboarding").or_insert(Value::Bool(true));
    if !root.get("projects").is_some_and(Value::is_object) {
        root.insert("projects".into(), json!({}));
    }
    let Some(projects) = root.get_mut("projects").and_then(Value::as_object_mut) else { return Ok(()) };
    for dir in dirs {
        if !projects.get(dir).is_some_and(Value::is_object) {
            projects.insert(dir.clone(), json!({}));
        }
        if let Some(entry) = projects.get_mut(dir).and_then(Value::as_object_mut) {
            entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
        }
    }
    let body = serde_json::to_vec_pretty(&value).map_err(io::Error::other)?;
    if existing.as_deref() == Some(body.as_slice()) {
        return Ok(());
    }
    file.write(&body)
}

/// Codex's `config.toml`: `[projects."<dir>"] trust_level = "trusted"` for
/// each of `dirs`, edited in place so the hook blocks and any other table keep
/// their text and order (Codex keys a hook's trust by its position).
fn trust_codex_config(file: &HomeFile, dirs: &[String]) -> io::Result<()> {
    let text = match file.read() {
        Some(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        None if file.exists() => return Err(io::Error::other("config.toml cannot be read")),
        None => None,
    };
    let edited = text.as_deref().and_then(|t| with_codex_trust(t, dirs));
    let out = match (text.as_deref(), edited) {
        (_, Some(out)) => out,
        // Unparsable or an unexpected shape: start over from nothing.
        (Some(_), None) => {
            file.rename_aside(".unreadable")?;
            with_codex_trust("", dirs).ok_or_else(|| io::Error::other("config.toml cannot be written"))?
        }
        (None, None) => with_codex_trust("", dirs).ok_or_else(|| io::Error::other("config.toml cannot be written"))?,
    };
    if text.as_deref() == Some(out.as_str()) {
        return Ok(());
    }
    file.write(out.as_bytes())
}

/// Pure: `text` with every dir of `dirs` trusted; `None` when `text` is not
/// TOML or `projects` is not a table.
fn with_codex_trust(text: &str, dirs: &[String]) -> Option<String> {
    use toml_edit::{value, DocumentMut, Item, Table};
    let mut doc: DocumentMut = text.parse().ok()?;
    if doc.get("projects").is_none() {
        let mut projects = Table::new();
        projects.set_implicit(true);
        doc.insert("projects", Item::Table(projects));
    }
    let projects = doc.get_mut("projects")?.as_table_like_mut()?;
    for dir in dirs {
        if projects.get(dir).is_none() {
            projects.insert(dir, Item::Table(Table::new()));
        }
        projects.get_mut(dir)?.as_table_like_mut()?.insert("trust_level", value("trusted"));
    }
    Some(doc.to_string())
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
    existing_homes_under(&homes_root_in(state_dir))
}

/// [`existing_homes_in`] for a known homes folder (`<state>/agent-homes`).
pub(crate) fn existing_homes_under(homes_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(homes_root) else {
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

    const CHAT: &str = "0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10";

    fn write_file(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// The Tabtivity-wide layer never reaches the assistant's home, not even
    /// when the layer is non-empty and the same state dir just laid it into a
    /// sibling scope's home; the sibling shows the layer was really there.
    #[test]
    fn the_global_layer_never_reaches_an_assistant_home() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let layer = crate::services::agent_global::global_dir_in(state);
        write_file(&layer.join(".claude/CLAUDE.md"), "from the layer");
        write_file(&layer.join(".claude/skills/s/SKILL.md"), "a skill");
        write_file(&layer.join(".claude/settings.json"), r#"{"mcpServers":{"evil":{"command":"x"}},"env":{"LAYER":"1"}}"#);
        write_file(&layer.join(".codex/config.toml"), "[mcp_servers.evil]\ncommand = \"x\"\n");
        let sibling = scope_home_in(state, "p1");
        std::fs::create_dir_all(&sibling).unwrap();
        crate::services::agent_global::apply_to_home(state, &sibling).unwrap();
        assert!(sibling.join(".claude/CLAUDE.md").is_file(), "the layer is live for a sibling");

        let chat = crate::services::assistant::chat_dir(state, CHAT).unwrap();
        for local in [false, true] {
            let prepared = prepare_assistant_home_in(state, local, &chat).unwrap();
            let home = prepared.dir;
            assert_eq!(home, if local { local_model_home_in(state, "assistant") } else { scope_home_in(state, "assistant") });
            for rel in [".claude/CLAUDE.md", ".claude/skills", ".claude/skills/s/SKILL.md"] {
                assert!(!home.join(rel).exists(), "{rel} in {}", home.display());
            }
            // Nothing the layer merges, and no layer manifest either.
            let settings = std::fs::read_to_string(home.join(".claude/settings.json")).unwrap();
            assert!(!settings.contains("evil") && !settings.contains("LAYER"), "{settings}");
            let claude_json = std::fs::read_to_string(home.join(".claude.json")).unwrap();
            assert!(!claude_json.contains("evil"), "{claude_json}");
            let codex = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
            assert!(!codex.contains("mcp_servers") && !codex.contains("evil"), "{codex}");
            assert!(!home.join(crate::brand::AGENT_GLOBAL_MANIFEST).exists());
            // Tabtivity's own session hooks are kept.
            assert!(settings.contains("hooks"), "{settings}");
            assert!(codex.contains("[[hooks.SessionStart]]"), "{codex}");
        }
    }

    #[test]
    fn an_assistant_home_trusts_its_chat_folder_for_claude_and_codex() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let chat = crate::services::assistant::chat_dir(state, CHAT).unwrap();
        let other = crate::services::assistant::chat_dir(state, "1c9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a11").unwrap();
        let first = prepare_assistant_home_in(state, false, &chat).unwrap();
        assert!(first.fresh);
        assert!(!chat.exists(), "the chat folder is the spawn path's to create");
        let home = &first.dir;
        let key = chat.to_string_lossy().into_owned();
        let claude: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(claude["hasCompletedOnboarding"], true);
        assert_eq!(claude["projects"][&key]["hasTrustDialogAccepted"], true);
        let codex = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
        let doc: toml_edit::DocumentMut = codex.parse().unwrap();
        assert_eq!(doc["projects"][&key]["trust_level"].as_str(), Some("trusted"));
        assert!(codex.contains("[[hooks.SessionStart]]"));

        // A second chat adds its own entry and keeps the first's.
        let again = prepare_assistant_home_in(state, false, &other).unwrap();
        assert!(!again.fresh);
        let claude: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(claude["projects"][&key]["hasTrustDialogAccepted"], true);
        assert_eq!(claude["projects"][other.to_string_lossy().as_ref()]["hasTrustDialogAccepted"], true);
        let doc: toml_edit::DocumentMut = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap().parse().unwrap();
        assert_eq!(doc["projects"][other.to_string_lossy().as_ref()]["trust_level"].as_str(), Some("trusted"));
        assert_eq!(doc["projects"][&key]["trust_level"].as_str(), Some("trusted"));
        // Idempotent: Codex's hook blocks are written once.
        let text = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
        prepare_assistant_home_in(state, false, &other).unwrap();
        assert_eq!(std::fs::read_to_string(home.join(".codex/config.toml")).unwrap(), text);
        assert_eq!(text.matches("[[hooks.SessionStart]]").count(), 1);
    }

    /// Existing keys stay (a signed-in identity, an onboarding flag the user
    /// answered otherwise, Codex's other tables); a config left unparsable is
    /// moved aside rather than trusted blind or left to break the spawn.
    #[test]
    fn trust_keeps_other_keys_and_replaces_only_what_cannot_be_parsed() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let dirs = ["/s/assistant/work/c1".to_string()];
        write_file(
            &home.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"a@b"},"hasCompletedOnboarding":false,"projects":{"/x":{"history":[1]},"/s/assistant/work/c1":{"allowedTools":["t"]}}}"#,
        );
        write_file(&home.join(".codex/config.toml"), "model = \"gpt-5\"\n\n[projects.\"/x\"]\ntrust_level = \"untrusted\"\n\n[projects.\"/s/assistant/work/c1\"]\ntrust_level = \"untrusted\"\n");
        trust_chat_folder(&home, Path::new(&dirs[0])).unwrap();
        let claude: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(claude["oauthAccount"]["emailAddress"], "a@b");
        assert_eq!(claude["hasCompletedOnboarding"], false);
        assert_eq!(claude["projects"]["/x"]["history"][0], 1);
        assert_eq!(claude["projects"]["/s/assistant/work/c1"]["allowedTools"][0], "t");
        assert_eq!(claude["projects"]["/s/assistant/work/c1"]["hasTrustDialogAccepted"], true);
        let doc: toml_edit::DocumentMut = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap().parse().unwrap();
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        assert_eq!(doc["projects"]["/x"]["trust_level"].as_str(), Some("untrusted"));
        assert_eq!(doc["projects"]["/s/assistant/work/c1"]["trust_level"].as_str(), Some("trusted"));

        std::fs::write(home.join(".claude.json"), "{not json").unwrap();
        std::fs::write(home.join(".codex/config.toml"), "projects = 3\n[[").unwrap();
        trust_chat_folder(&home, Path::new(&dirs[0])).unwrap();
        let claude: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(claude["projects"]["/s/assistant/work/c1"]["hasTrustDialogAccepted"], true);
        assert_eq!(std::fs::read_to_string(home.join(".claude.json.unreadable")).unwrap(), "{not json");
        let doc: toml_edit::DocumentMut = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap().parse().unwrap();
        assert_eq!(doc["projects"]["/s/assistant/work/c1"]["trust_level"].as_str(), Some("trusted"));
        assert!(home.join(".codex/config.toml.unreadable").is_file());
        // A well-formed file whose `projects` is not a table goes the same way.
        write_file(&home.join(".codex/config.toml"), "projects = 3\n");
        trust_chat_folder(&home, Path::new(&dirs[0])).unwrap();
        assert!(std::fs::read_to_string(home.join(".codex/config.toml")).unwrap().contains("trust_level"));
    }

    #[test]
    fn an_assistant_home_refuses_a_chat_folder_outside_the_work_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let work = crate::services::assistant::work_root(state);
        for bad in [
            work.clone(),
            state.join("assistant"),
            state.join("elsewhere").join(CHAT),
            work.join("..").join("x"),
            PathBuf::new(),
        ] {
            let err = prepare_assistant_home_in(state, false, &bad).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{}", bad.display());
        }
        assert!(!homes_root_in(state).join("assistant").exists(), "a refusal creates no home");
    }

    /// A link planted at a trust file by an agent in the home is replaced, not
    /// written through.
    #[cfg(unix)]
    #[test]
    fn trust_never_writes_through_a_planted_link() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let victim = tmp.path().join("victim.json");
        std::fs::write(&victim, "{}").unwrap();
        std::os::unix::fs::symlink(&victim, home.join(".claude.json")).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".codex")).unwrap();
        // `.codex` is a link: not a plain path, so the preparation refuses.
        assert!(trust_chat_folder(&home, Path::new("/s/c")).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "{}");
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }
}
